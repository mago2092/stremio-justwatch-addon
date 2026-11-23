"use strict";

const { L1Cache, L2Cache } = require("./cache");
const { fetchNewPlatformMovies } = require("./justwatch");
const { nodeToMeta } = require("../domain/meta");
const { TTL_S } = require("../ttl");
const { hasItalianAudio, hasEnoughVotes, applyCinemetaPosters } = require("./digitalCatalog");

// "Novità dalle piattaforme streaming" (Italy): movies of any year that were
// just added to a subscription platform, newest addition first. Built from
// JustWatch's day-by-day "Novità" list, so it is independent of release year.

// Bump when the inclusion rules change, so an old snapshot is never served.
const SNAPSHOT_KEY = "platform-catalog:IT:movies:v1";
const DAY_KEY_PREFIX = "platform-catalog:IT:day:v1:";
const PAGE_SIZE = 50;
const DAY_MS = 24 * 3600 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
// Past days hardly change once over; keep them a week so a 4-hourly rebuild
// only re-asks JustWatch about today and yesterday.
const PAST_DAY_TTL_S = 7 * 24 * 3600;

function windowDays() {
  const configured = Number.parseInt(process.env.PLATFORM_CATALOG_DAYS, 10);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 1), 90) : 30;
}

/**
 * Italian audio rule for this catalogue. Netflix, NOW and HBO Max do not
 * publish audio languages to JustWatch, so an added offer with no audio data
 * counts when the same film has Italian audio on another Italian offer (it
 * has been dubbed). An offer whose audio is listed but lacks Italian never
 * counts. Pure, so it is tested directly.
 */
function qualifies(entry, minimumVotes) {
  const { newOffer, node } = entry || {};
  if (newOffer?.monetizationType !== "FLATRATE") return false;
  if (!node?.content?.externalIds?.imdbId) return false;
  if (!hasEnoughVotes(node, minimumVotes)) return false;
  const listed = newOffer.audioLanguages || [];
  if (listed.length) return hasItalianAudio(newOffer);
  return (node.offers || []).some(hasItalianAudio);
}

function isoDay(time) {
  return new Date(time).toISOString().slice(0, 10);
}

// Keep only what nodeToMeta needs, so a day stays small in Redis.
function slim(entry) {
  const { node, newOffer } = entry;
  return {
    platform: newOffer?.package?.clearName || null,
    node: {
      objectType: node.objectType,
      content: {
        title: node.content.title,
        shortDescription: node.content.shortDescription,
        genres: node.content.genres,
        externalIds: { imdbId: node.content.externalIds.imdbId },
        posterUrl: node.content.posterUrl,
      },
    },
  };
}

async function getDay(day, { today }) {
  const key = `${DAY_KEY_PREFIX}${day}`;
  const isRecent = day >= isoDay(Date.parse(today) - DAY_MS);
  if (!isRecent) {
    const cached = await L2Cache.get(key);
    if (cached) return cached;
  }
  const entries = (await fetchNewPlatformMovies(day)).filter((e) => qualifies(e)).map(slim);
  if (!isRecent) await L2Cache.set(key, entries, PAST_DAY_TTL_S);
  return entries;
}

/**
 * Merge days (newest first) into one list. A film added to two platforms
 * keeps only its most recent addition. Within a day JustWatch's own order
 * (its popularity ranking) is kept. Pure, so it is tested directly.
 */
function mergeDays(days) {
  const seen = new Set();
  const merged = [];
  for (const { entries } of days) {
    for (const entry of entries) {
      const id = entry.node.content.externalIds.imdbId;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(entry);
    }
  }
  return merged;
}

async function refreshPlatformCatalog({ now = Date.now() } = {}) {
  if (!L2Cache.isConfigured()) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for the platform catalogue snapshot");
  }
  const today = isoDay(now);
  const days = [];
  for (let back = 0; back < windowDays(); back++) {
    const day = isoDay(now - back * DAY_MS);
    days.push({ day, entries: await getDay(day, { today }) });
  }
  const metas = mergeDays(days)
    .map((entry) => nodeToMeta(entry.node, "it", { country: "IT", language: "it" }))
    .filter((meta) => meta?.id);
  if (!metas.length) throw new Error("JustWatch returned no qualifying platform additions");
  await applyCinemetaPosters(metas);

  const snapshot = { version: 1, generatedAt: new Date(now).toISOString(), metas };
  const stored = await L2Cache.set(SNAPSHOT_KEY, snapshot);
  if (!stored) throw new Error("Could not persist platform catalogue snapshot to Redis");
  await L1Cache.set(SNAPSHOT_KEY, snapshot, 300);
  return snapshot;
}

async function getSnapshot() {
  const memory = await L1Cache.get(SNAPSHOT_KEY);
  if (memory) return memory;
  const persisted = await L2Cache.get(SNAPSHOT_KEY);
  if (persisted) {
    await L1Cache.set(SNAPSHOT_KEY, persisted, 300);
    return persisted;
  }
  return null;
}

function snapshotIsFresh(snapshot, now = Date.now()) {
  const generatedAt = Date.parse(snapshot?.generatedAt);
  return Number.isFinite(generatedAt) && generatedAt + TTL_S * 1000 > now;
}

let inFlight = null;
let lastFailureAt = 0;

function startRefresh() {
  if (inFlight) return inFlight;
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return null;
  inFlight = refreshPlatformCatalog()
    .catch((err) => {
      lastFailureAt = Date.now();
      console.error("[platformCatalog] refresh failed; keeping previous snapshot:", err.message);
      return null;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

// Same lazy, background-refresh behaviour as the digital catalogue.
async function servePlatformCatalog(offset) {
  let snapshot = await getSnapshot();
  if (!snapshotIsFresh(snapshot)) {
    const refresh = startRefresh();
    if (!snapshot && refresh) snapshot = await refresh;
  }
  if (!snapshot?.metas) return { ok: false, metas: [] };
  return { ok: true, metas: snapshot.metas.slice(offset, offset + PAGE_SIZE) };
}

module.exports = {
  SNAPSHOT_KEY,
  qualifies,
  mergeDays,
  refreshPlatformCatalog,
  servePlatformCatalog,
};
