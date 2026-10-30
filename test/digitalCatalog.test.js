"use strict";

const assert = require("node:assert/strict");
const { test, describe, beforeEach } = require("node:test");

const cachePath = require.resolve("../src/infra/cache");
const jwPath = require.resolve("../src/infra/justwatch");

let snapshot = null;
require.cache[cachePath] = {
  id: cachePath,
  filename: cachePath,
  loaded: true,
  exports: {
    L1Cache: {
      get: async () => snapshot,
      set: async (_key, value) => { snapshot = value; },
    },
    L2Cache: {
      get: async () => snapshot,
      set: async (_key, value) => { snapshot = value; return true; },
      isConfigured: () => true,
    },
  },
};
require.cache[jwPath] = {
  id: jwPath,
  filename: jwPath,
  loaded: true,
  exports: { fetchDigitalMovieCandidates: async () => [] },
};

const {
  firstDigitalAvailability,
  snapshotIsFresh,
  serveDigitalCatalog,
  digitalArrival,
  _resetRefreshStateForTests,
} = require("../src/infra/digitalCatalog");
const { summarizeReleases } = require("../src/infra/tmdbReleases");

describe("digital catalogue", () => {
  beforeEach(() => { snapshot = null; _resetRefreshStateForTests(); });

  test("uses the earliest active digital offer date, never the theatrical date", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    const node = {
      content: { originalReleaseDate: "1999-01-01" },
      offers: [
        { monetizationType: "CINEMA", availableFromTime: "2026-10-01T00:00:00Z" },
        { monetizationType: "RENT", availableFromTime: "2026-10-29T09:00:00Z", audioLanguages: ["it"] },
        { monetizationType: "FLATRATE", availableFromTime: "2026-10-28T00:00:00Z", audioLanguages: ["en", "it"] },
      ],
    };
    assert.equal(firstDigitalAvailability(node, now), Date.parse("2026-10-28T00:00:00Z"));
  });

  test("rejects missing, future, expired, and non-digital offers", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    const node = {
      offers: [
        { monetizationType: "BUY", availableFromTime: null },
        { monetizationType: "FREE", availableFromTime: "2026-11-01T00:00:00Z" },
        { monetizationType: "ADS", availableFromTime: "2026-10-01T00:00:00Z", availableToTime: "2026-10-02T00:00:00Z" },
        { monetizationType: "CINEMA", availableFromTime: "2026-10-01T00:00:00Z" },
      ],
    };
    assert.equal(firstDigitalAvailability(node, now), null);
  });

  test("ignores free and ad-supported offers, even when active", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    const freeOnly = {
      offers: [
        { monetizationType: "FREE", availableFromTime: "2026-10-29T00:00:00Z", audioLanguages: ["it"] },
        { monetizationType: "ADS", availableFromTime: "2026-10-29T00:00:00Z", audioLanguages: ["it"] },
      ],
    };
    assert.equal(firstDigitalAvailability(freeOnly, now), null);
    const mixed = {
      offers: [
        { monetizationType: "ADS", availableFromTime: "2026-10-29T00:00:00Z", audioLanguages: ["it"] },
        { monetizationType: "BUY", availableFromTime: "2026-10-20T00:00:00Z", audioLanguages: ["it"] },
      ],
    };
    assert.equal(firstDigitalAvailability(mixed, now), Date.parse("2026-10-20T00:00:00Z"));
  });

  test("counts only offers with Italian audio, not Italian subtitles", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    const subsOnly = {
      offers: [
        { monetizationType: "FLATRATE", availableFromTime: "2026-10-05T00:00:00Z", audioLanguages: ["en"], subtitleLanguages: ["it"] },
        { monetizationType: "RENT", availableFromTime: "2026-10-05T00:00:00Z", audioLanguages: [] },
        { monetizationType: "BUY", availableFromTime: "2026-10-05T00:00:00Z" },
      ],
    };
    assert.equal(firstDigitalAvailability(subsOnly, now), null);
    const dubbedLater = {
      offers: [
        { monetizationType: "RENT", availableFromTime: "2026-09-01T00:00:00Z", audioLanguages: ["en"] },
        { monetizationType: "FLATRATE", availableFromTime: "2026-10-15T00:00:00Z", audioLanguages: ["en", "it"] },
      ],
    };
    assert.equal(firstDigitalAvailability(dubbedLater, now), Date.parse("2026-10-15T00:00:00Z"));
  });

  test("reads Italian cinema and digital dates from TMDb, ignoring premieres and other countries", () => {
    const payload = {
      results: [
        { iso_3166_1: "US", release_dates: [{ type: 3, release_date: "2026-01-01T00:00:00.000Z" }] },
        {
          iso_3166_1: "IT",
          release_dates: [
            { type: 1, release_date: "2025-09-01T00:00:00.000Z" },
            { type: 3, release_date: "2026-03-05T00:00:00.000Z" },
            { type: 2, release_date: "2026-03-01T00:00:00.000Z" },
            { type: 4, release_date: "2026-06-10T00:00:00.000Z" },
          ],
        },
      ],
    };
    assert.deepEqual(summarizeReleases(payload, "IT"), {
      theatrical: Date.parse("2026-03-01T00:00:00.000Z"),
      digital: Date.parse("2026-06-10T00:00:00.000Z"),
    });
    assert.deepEqual(summarizeReleases({ results: [] }, "IT"), { theatrical: null, digital: null });
  });

  test("keeps only films that played in Italian cinemas", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    const jwDigital = Date.parse("2026-10-01T00:00:00Z");
    // Streaming-only: no Italian cinema release on TMDb.
    assert.equal(digitalArrival({ jwDigital, releases: { theatrical: null, digital: null }, now }), null);
    // Unknown (TMDb lookup failed): left out rather than guessed.
    assert.equal(digitalArrival({ jwDigital, releases: null, now }), null);
    // Cinema release in the future: not yet a cinema-to-digital film.
    assert.equal(digitalArrival({ jwDigital, releases: { theatrical: Date.parse("2026-12-01T00:00:00Z"), digital: null }, now }), null);
    // Played in cinemas, then arrived in digital.
    assert.equal(
      digitalArrival({ jwDigital, releases: { theatrical: Date.parse("2026-08-01T00:00:00Z"), digital: null }, now }),
      jwDigital,
    );
  });

  test("prefers TMDb's Italian digital date and distrusts digital dates before the cinema release", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    const theatrical = Date.parse("2026-04-01T00:00:00Z");
    // JustWatch listed it on the cinema date (pre-order); TMDb knows the real digital date.
    assert.equal(
      digitalArrival({ jwDigital: theatrical, releases: { theatrical, digital: Date.parse("2026-05-20T00:00:00Z") }, now }),
      Date.parse("2026-05-20T00:00:00Z"),
    );
    // A digital offer weeks before the cinema release is not trusted.
    assert.equal(
      digitalArrival({ jwDigital: Date.parse("2026-02-01T00:00:00Z"), releases: { theatrical, digital: null }, now }),
      null,
    );
  });

  test("uses the original four-hour lazy refresh window", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    assert.equal(snapshotIsFresh({ generatedAt: "2026-10-30T08:01:00Z" }, now), true);
    assert.equal(snapshotIsFresh({ generatedAt: "2026-10-30T08:00:00Z" }, now), false);
  });

  test("serves only the stored snapshot, with normal Stremio paging", async () => {
    snapshot = { metas: Array.from({ length: 60 }, (_, n) => ({ id: `tt${n}` })) };
    const page = await serveDigitalCatalog(50);
    assert.equal(page.ok, true);
    assert.deepEqual(page.metas.map((m) => m.id), ["tt50", "tt51", "tt52", "tt53", "tt54", "tt55", "tt56", "tt57", "tt58", "tt59"]);
  });
});
