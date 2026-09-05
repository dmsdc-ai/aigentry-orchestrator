import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./model-router-fixtures.js";

for (const [name, overrides] of [
  ["label outside allowlist", { CLASSIFIER_REPLY: '{"label":"invented-model","reason":"x","confidence":1}' }],
  ["unparsable output", { CLASSIFIER_REPLY: "not json" }],
  ["nonzero exit", { CLASSIFIER_EXIT: "2" }],
  ["invalid confidence", { CLASSIFIER_REPLY: '{"label":"gpt-6-astra","reason":"x","confidence":2}' }],
  ["15-second timeout", { CLASSIFIER_HANG: "1" }],
] as const) test(`T138: ${name} falls back to the role table`, () => {
  const f = fixture();
  try {
    const r = f.router(["--ref", f.ref], overrides);
    assert.equal(r.status, 0, r.stderr);
    const route = JSON.parse(r.stdout);
    assert.deepEqual([route.decided_by, route.cli, route.model, route.label], ["table", "codex", "gpt-6-astra", "gpt-6-astra"]);
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    assert.equal(f.calls(), 1);
  } finally { f.cleanup(); }
});
