"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const { qualifies, mergeDays } = require("../src/infra/platformCatalog");

function entry({ id = "tt1", votes = 5000, newAudio = ["it"], otherAudio = [], type = "FLATRATE" } = {}) {
  return {
    newOffer: { monetizationType: type, audioLanguages: newAudio, package: { clearName: "Netflix" } },
    node: {
      objectType: "MOVIE",
      content: { title: id, externalIds: { imdbId: id }, scoring: { imdbVotes: votes } },
      offers: otherAudio.map((audio) => ({ monetizationType: "RENT", audioLanguages: audio })),
    },
  };
}

describe("platform additions catalogue", () => {
  test("keeps subscription additions with Italian audio and enough votes", () => {
    assert.equal(qualifies(entry(), 1000), true);
    assert.equal(qualifies(entry({ votes: 999 }), 1000), false);
    assert.equal(qualifies(entry({ type: "RENT" }), 1000), false);
    assert.equal(qualifies(entry({ id: null }), 1000), false);
  });

  test("an added offer that lists audio without Italian never counts", () => {
    assert.equal(qualifies(entry({ newAudio: ["en"], otherAudio: [["it"]] }), 1000), false);
  });

  test("no audio data (Netflix, NOW, HBO Max) counts only if the film is dubbed elsewhere in Italy", () => {
    assert.equal(qualifies(entry({ newAudio: [], otherAudio: [["en", "it"]] }), 1000), true);
    assert.equal(qualifies(entry({ newAudio: [], otherAudio: [["en"]] }), 1000), false);
    assert.equal(qualifies(entry({ newAudio: [], otherAudio: [] }), 1000), false);
  });

  test("merges days newest first and keeps only a film's latest addition", () => {
    const slim = (id) => ({ node: { content: { externalIds: { imdbId: id } } } });
    const merged = mergeDays([
      { day: "2026-11-23", entries: [slim("tt2"), slim("tt1")] },
      { day: "2026-11-22", entries: [slim("tt3"), slim("tt2")] },
    ]);
    assert.deepEqual(merged.map((e) => e.node.content.externalIds.imdbId), ["tt2", "tt1", "tt3"]);
  });
});
