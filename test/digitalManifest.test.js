"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildManifest } = require("../src/domain/manifest");

test("manifest exposes the fixed Italian digital movie snapshot", () => {
  const manifest = buildManifest(
    { country: "IT", language: "it", packages: [], sorts: [] },
    "config",
    {},
    "https://addon.example",
  );
  assert.deepEqual(manifest.catalogs[0], {
    type: "movie",
    id: "jw_digital_it",
    name: "Novità in digitale 4k dal cinema",
    extra: [{ name: "skip", isRequired: false }],
  });
});
