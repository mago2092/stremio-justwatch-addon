"use strict";

const { L1Cache, L2Cache } = require("./cache");

// TMDb's per-country release calendar. It is the only source here that says
// whether a film actually played in cinemas in a given country, which
// JustWatch does not know.
//
// TMDb release types: 1 Premiere, 2 Theatrical (limited), 3 Theatrical,
// 4 Digital, 5 Physical, 6 TV. Festival premieres (1) do not count as a
// cinema release.
const TMDB_BASE = "https://api.themoviedb.org/3";
const THEATRICAL_TYPES = new Set([2, 3]);
const DIGITAL_TYPE = 4;

// Release calendars change slowly; a day is plenty and keeps a snapshot
// refresh from re-asking TMDb about the same few hundred films every 4h.
const RELEASES_TTL_S = 24 * 3600;
const CONCURRENCY = 8;

function isConfigured() {
  return Boolean(process.env.TMDB_API_KEY);
}

async function fetchReleaseDates(tmdbId) {
  const url = new URL(`${TMDB_BASE}/movie/${encodeURIComponent(tmdbId)}/release_dates`);
  url.searchParams.set("api_key", process.env.TMDB_API_KEY);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) return { results: [] };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reduce TMDb's release_dates payload to the two dates this catalogue needs
 * for one country. Pure, so it is tested directly.
 */
function summarizeReleases(payload, country = "IT") {
  const entry = (payload?.results || []).find((r) => r?.iso_3166_1 === country);
  const dates = entry?.release_dates || [];
  const earliest = (types) => {
    const times = dates
      .filter((d) => types.has(d?.type))
      .map((d) => Date.parse(d.release_date))
      .filter(Number.isFinite);
    return times.length ? Math.min(...times) : null;
  };
  return {
    theatrical: earliest(THEATRICAL_TYPES),
    digital: earliest(new Set([DIGITAL_TYPE])),
  };
}

async function getItalianReleases(tmdbId) {
  const key = `tmdbReleases:IT:${tmdbId}`;
  const memory = await L1Cache.get(key);
  if (memory) return memory;
  const persisted = await L2Cache.get(key);
  if (persisted) {
    await L1Cache.set(key, persisted, RELEASES_TTL_S);
    return persisted;
  }
  const summary = summarizeReleases(await fetchReleaseDates(tmdbId), "IT");
  await L1Cache.set(key, summary, RELEASES_TTL_S);
  await L2Cache.set(key, summary, RELEASES_TTL_S);
  return summary;
}

/**
 * Look up Italian release dates for many TMDb ids with bounded concurrency.
 * A lookup that fails maps to null (unknown), never to "not in cinemas" —
 * the caller decides; it is not cached, so the next refresh retries it.
 */
async function getItalianReleasesMany(tmdbIds) {
  const unique = [...new Set(tmdbIds.filter(Boolean).map(String))];
  const results = new Map();
  let next = 0;
  let failures = 0;
  async function worker() {
    while (next < unique.length) {
      const id = unique[next++];
      try {
        results.set(id, await getItalianReleases(id));
      } catch (err) {
        failures++;
        results.set(id, null);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  // If TMDb is broadly failing, a snapshot built now would be mostly empty.
  // Refuse it so the previous valid snapshot keeps being served.
  if (unique.length && failures / unique.length > 0.5) {
    throw new Error(`TMDb release lookups failing (${failures}/${unique.length})`);
  }
  return results;
}

module.exports = {
  isConfigured,
  summarizeReleases,
  getItalianReleasesMany,
};
