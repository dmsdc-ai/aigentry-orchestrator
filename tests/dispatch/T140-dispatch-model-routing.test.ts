import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./model-router-fixtures.js";

function audit(f: ReturnType<typeof fixture>) {
  const events = readFileSync(f.env.TELEMETRY_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  const event = events.find((e) => e[e.indexOf("--subtype") + 1] === "dispatch_start")!;
  return { payload: JSON.parse(event[event.indexOf("--payload-json") + 1]!),
    note: JSON.parse(readFileSync(f.queue, "utf8")).tasks[0].note as string };
}

for (const flags of [[], ["--cli", "auto"]]) test(`T140: ${flags.length ? "explicit auto" : "omitted CLI"} routes once and audits applied child model`, () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--role", "coder", ...flags], { AIGENTRY_CODEX_MODEL: "parent-model" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls(), 1);
    assert.doesNotMatch(r.stderr, /boot-prepare.mjs failed|legacy path active/);
    const { payload, note } = audit(f);
    assert.equal(payload.cli, "codex");
    assert.deepEqual(payload.route, { label: "gpt-6-astra", decided_by: "llm", reason: "implementation" });
    assert.match(note, /seed \| dispatched .* sid=router-fixture ref=ref.md track=router cli=codex\/gpt-6-astra by=llm/);
    assert.equal(JSON.parse(readFileSync(f.env.OPEN_LOG!, "utf8")).model, "gpt-6-astra");
    assert.match(readFileSync(join(f.aig, "sessions/router-fixture/guard/worker-launcher.sh"), "utf8"), /export AIGENTRY_CODEX_MODEL=gpt-6-astra/);
    assert.match(readFileSync(join(f.aig, "sessions/router-fixture/boot/launcher.sh"), "utf8"), /-m gpt-6-astra/);
    // inject/telemetry inherit the parent environment, never the selected model.
    assert.equal(readFileSync(f.env.PARENT_MODEL_LOG!, "utf8"), "parent-model");
  } finally { f.cleanup(); }
});

test("T140: explicit CLI bypasses classifier and profile and records by=explicit", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--cli", "claude"], { AIGENTRY_ROUTER_PROFILE: "/missing/profile.md", AIGENTRY_CLAUDE_MODEL: "chosen-by-operator" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls(), 0);
    assert.doesNotMatch(r.stderr, /model-router/);
    const { payload, note } = audit(f);
    assert.equal(payload.route.decided_by, "explicit");
    assert.match(note, /cli=claude\/chosen-by-operator by=explicit/);
  } finally { f.cleanup(); }
});

test("T140: classifier failure still spawns and audits role-table fallback", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { CLASSIFIER_REPLY: "broken" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls(), 1);
    const { payload, note } = audit(f);
    assert.equal(payload.route.decided_by, "table");
    assert.match(note, /cli=codex\/gpt-6-astra by=table/);
  } finally { f.cleanup(); }
});

test("T140: --target never classifies; audit identifies observed worker and unknown model", () => {
  const f = fixture();
  try {
    const r = f.dispatch(["--target", "router-fixture"], { OBSERVED_CLI: "grok" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls(), 0);
    const { payload, note } = audit(f);
    assert.equal(payload.cli, "grok");
    assert.equal(payload.route.decided_by, "existing");
    assert.match(note, /cli=grok\/unknown by=existing/);
  } finally { f.cleanup(); }
});

test("T140: deduplicated fresh dispatch does not classify or spawn again", () => {
  const f = fixture();
  try {
    assert.equal(f.dispatch(f.spawnArgs).status, 0);
    const r = f.dispatch(f.spawnArgs);
    assert.equal(r.status, 8, r.stderr);
    assert.equal(f.calls(), 1);
  } finally { f.cleanup(); }
});
