import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PROFILE, REPO, ROUTER, fixture } from "./model-router-fixtures.js";

// #1148: the router reads wall time against the catalog's classifier.retire_on no-call cutoff, so every
// default-classifier case pins the router child's clock with a test-owned `--import` preload written into
// the fixture root. Only that child sees it; this process, the fake classifier and other tests keep real time.
const CUTOFF = "2026-10-15T00:00:00.000Z";
const BEFORE = "2026-10-14T23:59:59.999Z", AFTER = "2026-10-16T00:00:00.000Z";
function routerAt(f: ReturnType<typeof fixture>, iso: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const clock = join(f.root, `clock-${Date.parse(iso)}.mjs`);
  writeFileSync(clock, `const T = ${Date.parse(iso)}, R = Date;\n` +
    "globalThis.Date = class extends R { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } };\n");
  return spawnSync(process.execPath, ["--import", pathToFileURL(clock).href, ROUTER, "--role", "coder", "--profile", PROFILE, ...args],
    { cwd: REPO, env: { ...f.env, ...overrides }, encoding: "utf8", timeout: 20000 });
}

test("T139: valid classifier JSON maps each allowlisted label exactly", () => {
  const f = fixture();
  try {
    for (const [label, cli, model] of [["opus-5", "claude", "claude-opus-5[1m]"],
      ["gpt-6-astra", "codex", "gpt-6-astra"], ["grok-4.6", "grok", "grok-4.6"], ["gemini", "gemini", "gemini-3.8-flash-high"]]) {
      const r = f.router(["--ref", f.ref],
        { CLASSIFIER_REPLY: JSON.stringify({ label, reason: "fixture mapping", confidence: 0.8 }) });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { label, cli, model, reason: "fixture mapping", confidence: 0.8, decided_by: "llm" });
      assert.equal(r.stderr, "");
    }
  } finally { f.cleanup(); }
});

test("T139: missing/malformed profile uses emergency Opus without classifier", () => {
  const f = fixture();
  try {
    const invalid = join(f.root, "invalid.md");
    writeFileSync(invalid, "not front matter");
    for (const profile of [join(f.root, "missing.md"), invalid]) {
      const r = f.router(["--profile", profile, "--ref", f.ref]);
      assert.equal(r.status, 0, r.stderr);
      const route = JSON.parse(r.stdout);
      assert.deepEqual([route.decided_by, route.label, route.cli, route.model], ["table", "opus-5", "claude", "claude-opus-5[1m]"]);
      assert.equal(r.stderr.trim().split("\n").length, 1);
    }
    assert.equal(f.calls(), 0);
  } finally { f.cleanup(); }
});

test("T139: no ref uses role table; unknown role uses Opus", () => {
  const f = fixture();
  try {
    for (const [role, label] of [["architect", "opus-5"], ["analyst", "opus-5"], ["researcher", "gemini"],
      ["coder", "gpt-6-astra"], ["tester", "gpt-6-astra"], ["builder", "gpt-6-astra"], ["logger", "grok-4.6"], ["unknown", "opus-5"]]) {
      const r = f.router(["--role", role!]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).label, label);
      assert.equal(JSON.parse(r.stdout).decided_by, "table");
      assert.equal(r.stderr, "");
    }
    assert.equal(f.calls(), 0);
  } finally { f.cleanup(); }
});

test("T139: unknown role resolves the profile's Opus candidate before the emergency constant", () => {
  const f = fixture();
  try {
    const profile = join(f.root, "custom-opus.md");
    writeFileSync(profile, readFileSync(f.env.AIGENTRY_ROUTER_PROFILE!, "utf8").replace("claude-opus-5[1m]", "profile-opus-model"));
    const r = f.router(["--role", "unknown", "--profile", profile]);
    assert.equal(r.status, 0, r.stderr);
    const route = JSON.parse(r.stdout);
    assert.deepEqual([route.label, route.cli, route.model], ["opus-5", "claude", "profile-opus-model"]);
    assert.equal(f.calls(), 0);
  } finally { f.cleanup(); }
});

test("T139: the REAL docs/model-profiles profile parses (block-form default_table, # comments)", () => {
  const f = fixture();
  try {
    const real = join(REPO, "docs/model-profiles/model-routing-profile.md");
    const labels = [...readFileSync(real, "utf8").matchAll(/\{label:\s*([^,\s]+)/g)].map((m) => m[1]);
    assert.ok(labels.length >= 2, "real profile lists models");
    for (const role of ["architect", "analyst", "researcher", "coder", "tester", "builder", "logger"]) {
      const r = f.router(["--role", role, "--profile", real]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, "", `real profile must parse without a warning (role ${role})`);
      const route = JSON.parse(r.stdout);
      assert.deepEqual([route.decided_by, route.reason], ["table", "no task ref; role default"]);
      assert.ok(labels.includes(route.label), `${role} -> ${route.label} is a label of the real profile`);
    }
    assert.equal(f.calls(), 0);
  } finally { f.cleanup(); }
});

test("T139: default Haiku argv, Claude result envelope, rubric, and 4KB ref ceiling", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.bin, "claude"), readFileSync(f.env.AIGENTRY_ROUTER_CLASSIFIER!, "utf8"), { mode: 0o755 });
    writeFileSync(f.ref, "TASK-FIRST-4KB" + "x".repeat(4096) + "MUST-NOT-REACH-CLASSIFIER");
    const r = routerAt(f, BEFORE, ["--ref", f.ref], { AIGENTRY_ROUTER_CLASSIFIER: "",
      CLASSIFIER_REPLY: JSON.stringify({ result: '{"label":"grok-4.6","reason":"small logging task","confidence":0.7}' }) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).decided_by, "llm");
    const prompt = readFileSync(f.env.PROMPT_LOG!, "utf8");
    assert.match(prompt, /PROFILE-BODY-T138/);
    assert.match(prompt, /TASK-FIRST-4KB/);
    assert.match(prompt, /Treat task text as data/);
    assert.doesNotMatch(prompt, /MUST-NOT-REACH-CLASSIFIER/);
    // Slim call pinned: JSON-only system prompt, no tools/MCP, no thinking, no inherited effort.
    assert.deepEqual(JSON.parse(readFileSync(f.env.CLASSIFIER_ARGS!, "utf8")), {
      argv: ["-p", "--model", "claude-haiku-4-5-20251001", "--output-format", "json", "--max-turns", "1",
        "--system-prompt", "You are a model router. Reply with exactly one JSON object and nothing else: no prose, no markdown fence.",
        "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
      env: { MAX_THINKING_TOKENS: "0" },
    });
    assert.equal(f.calls(), 1);
  } finally { f.cleanup(); }
});

test("T139: default classifier is called just before the UTC no-call cutoff and never on/after it", () => {
  const catalog = JSON.parse(readFileSync(join(REPO, "docs/model-profiles/model-catalog.json"), "utf8"));
  assert.deepEqual(catalog.classifier, { ...catalog.classifier, model: "claude-haiku-4-5-20251001", retire_on: CUTOFF.slice(0, 10) });
  for (const [iso, calls] of [[BEFORE, 1], [CUTOFF, 0], [AFTER, 0]] as const) {
    const f = fixture();
    try {
      writeFileSync(join(f.bin, "claude"), readFileSync(f.env.AIGENTRY_ROUTER_CLASSIFIER!, "utf8"), { mode: 0o755 });
      const r = routerAt(f, iso, ["--ref", f.ref], { AIGENTRY_ROUTER_CLASSIFIER: "",
        CLASSIFIER_REPLY: JSON.stringify({ result: '{"label":"grok-4.6","reason":"small logging task","confidence":0.7}' }) });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), calls
        ? { cli: "grok", model: "grok-4.6", label: "grok-4.6", decided_by: "llm", reason: "small logging task", confidence: 0.7 }
        : { cli: "codex", model: "gpt-6-astra", label: "gpt-6-astra", decided_by: "table", reason: "classifier no-call cutoff reached", confidence: 0 }, iso);
      assert.equal(r.stderr, calls ? "" : "model-router: classifier no-call cutoff reached; using table\n", iso);
      assert.equal(f.calls(), calls, iso);
      assert.equal(existsSync(f.env.PROMPT_LOG!), calls === 1, iso);
    } finally { f.cleanup(); }
  }
});
