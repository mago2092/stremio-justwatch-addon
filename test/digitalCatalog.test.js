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
} = require("../src/infra/digitalCatalog");

describe("digital catalogue", () => {
  beforeEach(() => { snapshot = null; });

  test("uses the earliest active digital offer date, never the theatrical date", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    const node = {
      content: { originalReleaseDate: "1999-01-01" },
      offers: [
        { monetizationType: "CINEMA", availableFromTime: "2026-10-01T00:00:00Z" },
        { monetizationType: "RENT", availableFromTime: "2026-10-29T09:00:00Z" },
        { monetizationType: "FLATRATE", availableFromTime: "2026-10-28T00:00:00Z" },
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
