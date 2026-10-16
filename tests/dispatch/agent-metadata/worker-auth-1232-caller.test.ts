// #1232 — confined Claude worker authentication on the ACTUAL compiled dispatch caller path
// (dist/src/dispatch/cli.js --spawn-and-dispatch). Without AIGENTRY_CLAUDE_OAUTH_TOKEN the spawn arm refuses
// SANDBOX_AUTH_WORKER_TOKEN_REQUIRED (exit 78) before boot-prepare, the git guard or the terminal; with a FAKE
// opt-in it reaches prepareWorkerSandbox and seals the handoff marker, never a host credential copy.
// Hermetic: fake CLIs/HOME/open-session/telepty from model-router-fixtures (whose fake host HOME still holds a
// synthetic .credentials.json, so "never copied" is observable). No real CLI, terminal, daemon, provider or
// network; the token is fabricated and never valid anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fixture } from "../model-router-fixtures.js";

const posix = process.platform === "darwin" || process.platform === "linux";
const posixTest = posix ? test : (() => undefined) as unknown as typeof test;
// #1232 F8: obviously fake and prefix-free (no real token prefix), so it cannot look like a credential to a scanner.
const FAKE_TOKEN = "FAKE-1232-caller-worker-token-NOT-A-SECRET";
const REFUSAL = "dispatch.sh: SANDBOX_AUTH_WORKER_TOKEN_REQUIRED: confined Claude workers authenticate only with an " +
  "approved automation token (claude setup-token) supplied as AIGENTRY_CLAUDE_OAUTH_TOKEN in the dispatcher " +
  "environment; the host login is never copied; see docs/setup/dispatch-capacity.md; nothing was spawned (exit 78)";

// Host PATH minus every directory holding a claude/codex: the resolver must only ever see the fakes.
function cleanHostPath(): string {
  return (process.env.PATH ?? "").split(delimiter).filter((d) => d && !["claude", "codex"].some((c) => {
    try { accessSync(join(d, c), constants.X_OK); return true; } catch { return false; }
  })).join(delimiter);
}

function files(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

const spawnClaude = (f: ReturnType<typeof fixture>, extra: NodeJS.ProcessEnv = {}) =>
  f.dispatch([...f.spawnArgs, "--cli", "claude", "--role", "coder"],
    { PATH: [f.bin, cleanHostPath()].join(delimiter), AIGENTRY_CLAUDE_MODEL: "claude-opus-5-5", ...extra });

// `undefined` is dropped by spawnSync, so "unset" stays unset even if the fixture env ever gains an opt-in.
for (const [label, extra] of [["unset", { AIGENTRY_CLAUDE_OAUTH_TOKEN: undefined }],
  ["empty", { AIGENTRY_CLAUDE_OAUTH_TOKEN: "" }]] as const) {
  posixTest(`#1232 caller: ${label} opt-in refuses exit 78 before boot-prepare, guard, staging or terminal`, () => {
    const f = fixture();
    try {
      // #1232 F5: the fixture's actual seeded task queue and registry bytes, read before the dispatch.
      const seeded = [f.queue, join(f.root, "state", "active.json")].map((p) => [p, readFileSync(p, "utf8")] as const);
      const r = spawnClaude(f, extra);
      assert.equal(r.status, 78, r.stderr);
      assert.ok(r.stderr.split("\n").includes(REFUSAL), r.stderr);
      assert.doesNotMatch(r.stderr, /boot-prepare|SANDBOX_BOOT|git guard/);
      for (const effect of [f.env.OPEN_LOG!, `${f.env.OPEN_LOG}.calls`, f.env.PARENT_MODEL_LOG!, f.env.CMUX_CAPS_LOG!,
        f.env.TELEMETRY_LOG!, join(f.aig, "sessions", "router-fixture"), join(f.aig, "role-sandbox"), f.env.AIGENTRY_GIT_HOOKS_DIR!]) {
        assert.equal(existsSync(effect), false, `effect before the refusal: ${effect}`);
      }
      for (const [file, bytes] of seeded) assert.equal(readFileSync(file, "utf8"), bytes, `no task-ledger/registry write: ${file}`);
      assert.deepEqual(readdirSync(join(f.root, "tmp")).filter((n) => n.startsWith("agw-")), [], "no staged sandbox temp dir");
      assert.ok(!(r.stdout + r.stderr).includes("fixture-access-token-not-a-real-credential"), "no host credential byte echoed");
      assert.equal(existsSync(f.env.WORK_LOG!), false, "no model/work execution");
    } finally { f.cleanup(); }
  });
}

posixTest("#1232 caller: a FAKE opt-in reaches prepareWorkerSandbox; sealed handoff marker, no host credential copy, no leak", () => {
  const f = fixture();
  try {
    const r = spawnClaude(f, { AIGENTRY_CLAUDE_OAUTH_TOKEN: FAKE_TOKEN });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /SANDBOX_AUTH_WORKER_TOKEN_REQUIRED/);
    const current = JSON.parse(readFileSync(join(f.aig, "sessions/router-fixture/sandbox-current.json"), "utf8"));
    const raw = readFileSync(current.manifest, "utf8");
    assert.equal(createHash("sha256").update(raw).digest("hex"), current.hash);
    const m = JSON.parse(raw) as Record<string, any>;
    assert.equal(m.cli, "claude");
    const handoff = join(dirname(current.manifest), "claude-oauth", "token");
    assert.equal(m.claudeOAuthHandoff, handoff);
    assert.equal(statSync(handoff).mode & 0o777, 0o600);
    assert.equal(readFileSync(handoff, "utf8").trim() === FAKE_TOKEN, true, "the handoff carries the opted-in token");
    assert.equal(existsSync(join(m.env.CLAUDE_CONFIG_DIR, ".credentials.json")), false, "the host login is never copied");
    assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in m.env), "the token never enters the sealed env");
    assert.equal(readFileSync(`${f.env.OPEN_LOG}.calls`, "utf8"), "open\n", "one (fake) terminal open");
    const leaks = files(f.root).filter((p) => p !== handoff && readFileSync(p, "utf8").includes(FAKE_TOKEN));
    assert.deepEqual(leaks, [], "the token appears only in its private handoff");
    assert.ok(!(r.stdout + r.stderr).includes(FAKE_TOKEN));
    assert.equal(existsSync(f.env.WORK_LOG!), false, "no model/work execution");
  } finally { f.cleanup(); }
});

// win32 has no OS sandbox: the platform refusal stays first, so the decision is named and nothing is staged.
if (!posix) test("#1232 caller (win32): the platform refusal precedes the token refusal", () => {
  const f = fixture();
  try {
    const d = f.refused(spawnClaude(f));
    assert.equal(d.cli, "claude");
  } finally { f.cleanup(); }
});
