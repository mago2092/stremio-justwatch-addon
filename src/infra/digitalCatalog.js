"use strict";

const { L1Cache, L2Cache } = require("./cache");
const { fetchDigitalMovieCandidates } = require("./justwatch");
const { nodeToMetaWithFallback } = require("../domain/meta");
const { TTL_S } = require("../ttl");
const tmdbReleases = require("./tmdbReleases");

// Bump the version whenever the inclusion rules change, so a snapshot built
// under the old rules is never served (v2: paid only + Italian audio;
// v3: also requires an Italian cinema release on TMDb).
const SNAPSHOT_KEY = "digital-catalog:IT:movies:v3";
const DAY_MS = 24 * 3600 * 1000;
// After a failed refresh, wait before trying again instead of retrying on
// every single catalogue request while JustWatch/TMDb are unhappy.
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const PAGE_SIZE = 50;
// Only subscription (FLATRATE) and paid (RENT, BUY) offers. Free and
// ad-supported offers are deliberately excluded from this catalogue.
const DIGITAL_TYPES = new Set(["FLATRATE", "RENT", "BUY"]);

function maxPages() {
  const configured = Number.parseInt(process.env.DIGITAL_CATALOG_SCAN_PAGES, 10);
  // This is deliberately bounded: an accidental environment value must not
  // turn the nightly job into an unbounded scrape of JustWatch.
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 1), 50) : 10;
}

// The offer must carry Italian audio. Italian subtitles alone do not count,
// and an offer with no audio data is treated as not Italian.
function hasItalianAudio(offer) {
  return (offer?.audioLanguages || []).some(
    (lang) => typeof lang === "string" && /^it(-|$)/i.test(lang),
  );
}

function isActiveOffer(offer, now) {
  if (!DIGITAL_TYPES.has(offer?.monetizationType)) return false;
  if (!hasItalianAudio(offer)) return false;
  const starts = Date.parse(offer.availableFromTime);
  if (!Number.isFinite(starts) || starts > now) return false;
  const ends = offer.availableToTime ? Date.parse(offer.availableToTime) : NaN;
  return !Number.isFinite(ends) || ends > now;
}

/**
 * JustWatch's Offer.availableFromTime is an offer-level digital availability
 * timestamp.  It is intentionally the *only* date considered here: the
 * title's originalReleaseDate is its theatrical/original release and must
 * never be used as a fallback for this catalogue.
 */
function firstDigitalAvailability(node, now = Date.now()) {
  const dates = (node?.offers || [])
    .filter((offer) => isActiveOffer(offer, now))
    .map((offer) => Date.parse(offer.availableFromTime))
    .filter(Number.isFinite);
  return dates.length ? Math.min(...dates) : null;
}

async function getSnapshot() {
  const memory = await L1Cache.get(SNAPSHOT_KEY);
  if (memory) return memory;
  const persisted = await L2Cache.get(SNAPSHOT_KEY);
  if (persisted) {
    // The durable copy has no expiry. Keep a short in-process copy only to
    // avoid an HTTP call to Redis for every Stremio page request.
    await L1Cache.set(SNAPSHOT_KEY, persisted, 300);
    return persisted;
  }
  return null;
}

async function persistSnapshot(snapshot) {
  // Redis is the durability boundary. Do not report success merely because a
  // process-local cache was updated: that would lose the catalogue on restart.
  if (!L2Cache.isConfigured()) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for the digital catalogue snapshot");
  }
  const stored = await L2Cache.set(SNAPSHOT_KEY, snapshot);
  if (!stored) throw new Error("Could not persist digital catalogue snapshot to Redis");
  await L1Cache.set(SNAPSHOT_KEY, snapshot, 300);
}

/**
 * Decide whether a candidate belongs in the catalogue and, if so, the date it
 * arrived in digital in Italy. Pure, so it is tested directly.
 *
 * - It must have played in Italian cinemas (TMDb theatrical release in IT).
 * - The digital date is TMDb's Italian digital date when known, otherwise the
 *   earliest qualifying JustWatch offer (paid/subscription, Italian audio).
 * - A digital date before the cinema release (a pre-order listing, or a
 *   mismatched record) is not trusted and the film is left out.
 */
function digitalArrival({ jwDigital, releases, now = Date.now() }) {
  if (jwDigital === null || !releases) return null;
  const { theatrical, digital } = releases;
  if (!Number.isFinite(theatrical) || theatrical > now) return null;
  const arrival = Number.isFinite(digital) && digital <= now ? Math.max(digital, jwDigital) : jwDigital;
  if (arrival < theatrical - DAY_MS) return null;
  return arrival;
}

async function refreshDigitalCatalog({ now = Date.now() } = {}) {
  if (!tmdbReleases.isConfigured()) {
    throw new Error("TMDB_API_KEY is required to tell cinema releases apart from streaming-only films");
  }
  const nodes = await fetchDigitalMovieCandidates({ pages: maxPages() });
  const withOffers = nodes
    .map((node) => ({
      node,
      jwDigital: firstDigitalAvailability(node, now),
      tmdbId: node?.content?.externalIds?.tmdbId || null,
    }))
    .filter((entry) => entry.jwDigital !== null && entry.tmdbId);

  const releases = await tmdbReleases.getItalianReleasesMany(withOffers.map((e) => e.tmdbId));
  const dated = withOffers
    .map((entry) => ({
      ...entry,
      availableAt: digitalArrival({
        jwDigital: entry.jwDigital,
        releases: releases.get(String(entry.tmdbId)),
        now,
      }),
    }))
    .filter((entry) => entry.availableAt !== null)
    .sort((a, b) => b.availableAt - a.availableAt);

  const seen = new Set();
  const metas = [];
  for (const entry of dated) {
    const result = await nodeToMetaWithFallback(entry.node, "it", { country: "IT", language: "it" });
    if (!result?.meta?.id || seen.has(result.meta.id)) continue;
    seen.add(result.meta.id);
    metas.push(result.meta);
  }
  if (!metas.length) throw new Error("No Italian cinema releases with a qualifying digital offer");

  const snapshot = {
    version: 3,
    generatedAt: new Date(now).toISOString(),
    metas,
  };
  await persistSnapshot(snapshot);
  return snapshot;
}

function snapshotIsFresh(snapshot, now = Date.now()) {
  const generatedAt = Date.parse(snapshot?.generatedAt);
  return Number.isFinite(generatedAt) && generatedAt + TTL_S * 1000 > now;
}

// One refresh at a time per process: concurrent catalogue requests share it.
let inFlight = null;
let lastFailureAt = 0;

function startRefresh() {
  if (inFlight) return inFlight;
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return null;
  inFlight = refreshDigitalCatalog()
    .catch((err) => {
      lastFailureAt = Date.now();
      console.error("[digitalCatalog] refresh failed; keeping previous snapshot:", err.message);
      return null;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

async function serveDigitalCatalog(offset) {
  let snapshot = await getSnapshot();
  // Lazy, like the rest of the addon: no timer. With a stale snapshot on
  // hand, serve it right away and rebuild in the background, so no Nuvio
  // request waits on JustWatch/TMDb. Only a cold start (no snapshot at all)
  // waits for the first build.
  if (!snapshotIsFresh(snapshot)) {
    const refresh = startRefresh();
    if (!snapshot && refresh) snapshot = await refresh;
  }
  if (!snapshot?.metas) return { ok: false, metas: [] };
  return { ok: true, metas: snapshot.metas.slice(offset, offset + PAGE_SIZE) };
}

function _resetRefreshStateForTests() {
  inFlight = null;
  lastFailureAt = 0;
}

module.exports = {
  digitalArrival,
  _resetRefreshStateForTests,
  hasItalianAudio,
  SNAPSHOT_KEY,
  firstDigitalAvailability,
  snapshotIsFresh,
  getSnapshot,
  refreshDigitalCatalog,
  serveDigitalCatalog,
};
