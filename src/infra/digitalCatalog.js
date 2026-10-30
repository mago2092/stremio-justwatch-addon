"use strict";

const { L1Cache, L2Cache } = require("./cache");
const { fetchDigitalMovieCandidates } = require("./justwatch");
const { nodeToMetaWithFallback } = require("../domain/meta");
const { TTL_S } = require("../ttl");

const SNAPSHOT_KEY = "digital-catalog:IT:movies:v1";
const PAGE_SIZE = 50;
const DIGITAL_TYPES = new Set(["FLATRATE", "RENT", "BUY", "FREE", "ADS"]);

function maxPages() {
  const configured = Number.parseInt(process.env.DIGITAL_CATALOG_SCAN_PAGES, 10);
  // This is deliberately bounded: an accidental environment value must not
  // turn the nightly job into an unbounded scrape of JustWatch.
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 1), 50) : 10;
}

function isActiveOffer(offer, now) {
  if (!DIGITAL_TYPES.has(offer?.monetizationType)) return false;
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

async function refreshDigitalCatalog({ now = Date.now() } = {}) {
  const nodes = await fetchDigitalMovieCandidates({ pages: maxPages() });
  const dated = nodes
    .map((node) => ({ node, availableAt: firstDigitalAvailability(node, now) }))
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
  if (!metas.length) throw new Error("JustWatch returned no dated active digital movie offers");

  const snapshot = {
    version: 1,
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

async function serveDigitalCatalog(offset) {
  let snapshot = await getSnapshot();
  // Match the addon's existing lazy cache cadence: no timer or cron runs in
  // the background. The first catalog request after four hours refreshes it.
  if (!snapshotIsFresh(snapshot)) {
    try {
      snapshot = await refreshDigitalCatalog();
    } catch (err) {
      // A stale but valid snapshot is better than an empty catalogue; this is
      // the dedicated catalogue's last-known-good guarantee.
      console.error("[digitalCatalog] lazy refresh failed; serving previous snapshot:", err.message);
    }
  }
  if (!snapshot?.metas) return { ok: false, metas: [] };
  return { ok: true, metas: snapshot.metas.slice(offset, offset + PAGE_SIZE) };
}

module.exports = {
  SNAPSHOT_KEY,
  firstDigitalAvailability,
  snapshotIsFresh,
  getSnapshot,
  refreshDigitalCatalog,
  serveDigitalCatalog,
};
