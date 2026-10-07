// C3-a — automatic routing picks among the CLIs the confined spawn admits (claude, codex) only.
// spawnWorkspace refuses every other CLI with SANDBOX_CLI_UNSUPPORTED (exit 78, pinned by T141), so a
// `--cli auto` route to grok or gemini was a dispatch that could only fail. An explicit `--cli grok|gemini`
// keeps that refusal (T141); the label router without `--confined` keeps its four-CLI answers (T138/T139).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, fixture } from "./model-router-fixtures.js";

const CONFINABLE = ["claude", "codex"];
const ROLES = ["architect", "analyst", "researcher", "coder", "tester", "builder", "logger", "unknown"];

test("C3-a: router --confined 1 never returns or offers a non-confinable CLI, whatever the classifier or role table says", () => {
  const f = fixture();
  try {
    // The fixture profile's table sends researcher -> gemini and logger -> grok-4.6.
    for (const label of ["opus-5", "gpt-6-astra", "grok-4.6", "gemini"]) for (const role of ROLES) for (const withRef of [true, false]) {
      const r = f.router(["--role", role, "--candidates", "1", "--confined", "1", ...(withRef ? ["--ref", f.ref] : [])],
        { CLASSIFIER_REPLY: JSON.stringify({ label, reason: "fixture", confidence: 0.8 }) });
      assert.equal(r.status, 0, r.stderr);
      const route = JSON.parse(r.stdout);
      const at = `classifier ${label}, role ${role}, ref ${withRef}`;
      assert.ok(CONFINABLE.includes(route.cli), `${at}: routed to ${route.cli}`);
      assert.deepEqual(route.candidates.filter((c: { cli: string }) => !CONFINABLE.includes(c.cli)), [], `${at}: candidates`);
      // A confinable classifier pick is kept as-is; only a non-confinable one falls to the table.
      if (withRef && ["opus-5", "gpt-6-astra"].includes(label)) assert.deepEqual([route.label, route.decided_by], [label, "llm"], at);
    }
  } finally { f.cleanup(); }
});

test("C3-a: the REAL profile's role table names a confinable CLI for every role", () => {
  const f = fixture();
  try {
    const real = join(REPO, "docs/model-profiles/model-routing-profile.md");
    for (const role of ROLES) {
      const r = f.router(["--role", role, "--profile", real]);
      assert.equal(r.status, 0, r.stderr);
      const route = JSON.parse(r.stdout);
      assert.deepEqual([route.decided_by, route.reason], ["table", "no task ref; role default"], role);
      assert.ok(CONFINABLE.includes(route.cli), `${role} -> ${route.label} (${route.cli})`);
    }
    assert.equal(f.calls(), 0);
  } finally { f.cleanup(); }
});

for (const role of ["researcher", "logger"]) test(`C3-a: dispatch --cli auto --role ${role} with a grok-choosing classifier spawns a confinable CLI, not exit 78`, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.aig, `instructions/roles/${role}.md`), `# ${role.toUpperCase()}\nFIXTURE-ROLE\n`);
    const r = f.dispatch([...f.spawnArgs, "--cli", "auto", "--role", role],
      { CLASSIFIER_REPLY: '{"label":"grok-4.6","reason":"research","confidence":0.9}' });
    assert.doesNotMatch(r.stderr, /SANDBOX_CLI_UNSUPPORTED/);
    assert.equal(f.calls(), 1);
    if (process.platform === "win32") {
      const d = f.refused(r);
      assert.deepEqual([d.cli, d.model, d.decided_by], ["claude", "claude-opus-5[1m]", "table"]);
      return;
    }
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.manifest().cli, "claude");
    assert.ok(f.manifest().command.includes("claude-opus-5[1m]"));
  } finally { f.cleanup(); }
});
