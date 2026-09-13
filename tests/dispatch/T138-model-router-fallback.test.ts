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

// #1084: dispatch's cap fallback order comes from the router (the only profile parser), on request only.
test("T138: --candidates 1 lists the role table pick then profile order; default shape unchanged", () => {
  const f = fixture();
  try {
    const labels = (r: ReturnType<typeof f.router>) => JSON.parse(r.stdout).candidates.map((c: { label: string }) => c.label);
    const r = f.router(["--candidates", "1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(labels(r), ["gpt-6-astra", "opus-5", "grok-4.6", "gemini"]);
    assert.deepEqual(JSON.parse(r.stdout).candidates[1], { cli: "claude", model: "claude-opus-5[1m]", label: "opus-5" });
    assert.deepEqual(labels(f.router(["--role", "nobody", "--candidates", "1"])), ["opus-5", "gpt-6-astra", "grok-4.6", "gemini"]);
    assert.equal("candidates" in JSON.parse(f.router().stdout), false);
    assert.equal(f.calls(), 0);
  } finally { f.cleanup(); }
});
