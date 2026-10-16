// #1232 — confined Claude worker authentication on the ACTUAL compiled dispatch caller path
// (dist/src/dispatch/cli.js --spawn-and-dispatch). Initially missing/invalid env/store authentication
// refuses before boot/guard/terminal. Late store invalidation refuses after boot/guard, before sandbox
// staging or terminal. Valid FAKE authentication seals a handoff, never a host credential copy.
// Hermetic: fake CLIs/HOME/open-session/telepty from model-router-fixtures (whose fake host HOME still holds a
// synthetic .credentials.json, so "never copied" is observable). No real CLI, terminal, daemon, provider or
// network; the token is fabricated and never valid anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fixture } from "../model-router-fixtures.js";

const posix = process.platform === "darwin" || process.platform === "linux";
const posixTest = posix ? test : (() => undefined) as unknown as typeof test;
// #1232 F8: obviously fake and prefix-free (no real token prefix), so it cannot look like a credential to a scanner.
const FAKE_TOKEN = "FAKE-1232-caller-worker-token-NOT-A-SECRET";
const REFUSAL = "dispatch.sh: SANDBOX_AUTH_WORKER_TOKEN_REQUIRED: confined Claude workers authenticate only with an " +
  "approved automation token (claude setup-token) supplied as AIGENTRY_CLAUDE_OAUTH_TOKEN or in " +
  "~/.aigentry/credentials/claude-worker/token; the host login is never copied; see docs/setup/dispatch-capacity.md; nothing was spawned (exit 78)";

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


function provision(f: ReturnType<typeof fixture>, raw = FAKE_TOKEN + "\n"): string {
  const dir = join(f.env.HOME!, ".aigentry/credentials/claude-worker");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "token");
  writeFileSync(file, raw, { mode: 0o600 });
  return file;
}

posixTest("#1232 caller: private store reaches handoff without exposing source path or token", () => {
  const f = fixture();
  try {
    const source = provision(f);
    const r = spawnClaude(f, { AIGENTRY_CLAUDE_OAUTH_TOKEN: undefined });
    assert.equal(r.status, 0, r.stderr);
    const current = JSON.parse(readFileSync(join(f.aig, "sessions/router-fixture/sandbox-current.json"), "utf8"));
    const raw = readFileSync(current.manifest, "utf8"), m = JSON.parse(raw);
    assert.equal(readFileSync(m.claudeOAuthHandoff, "utf8") === FAKE_TOKEN + "\n", true);
    assert.equal(raw.includes(source), false);
    assert.equal(raw.includes(FAKE_TOKEN), false);
    assert.deepEqual(files(f.root).filter(p => p !== source && p !== m.claudeOAuthHandoff &&
      readFileSync(p, "utf8").includes(FAKE_TOKEN)), []);
    assert.equal((r.stdout + r.stderr).includes(FAKE_TOKEN), false);
    assert.equal(existsSync(f.env.WORK_LOG!), false);
  } finally { f.cleanup(); }
});

for (const kind of ["malformed file", "unsafe file", "invalid env"] as const) {
  posixTest("#1232 caller: " + kind + " refuses before spawn without disclosure", () => {
    const f = fixture();
    try {
      const file = provision(f, kind === "malformed file" ? FAKE_TOKEN : FAKE_TOKEN + "\n");
      if (kind === "unsafe file") chmodSync(file, 0o644);
      const r = spawnClaude(f, { AIGENTRY_CLAUDE_OAUTH_TOKEN: kind === "invalid env" ? FAKE_TOKEN + " invalid" : undefined });
      assert.equal(r.status, 78, r.stderr);
      assert.match(r.stderr, /SANDBOX_AUTH_WORKER_TOKEN_INVALID/);
      assert.equal((r.stdout + r.stderr).includes(FAKE_TOKEN), false);
      for (const effect of [f.env.OPEN_LOG!, join(f.aig, "sessions"), join(f.aig, "role-sandbox"), f.env.AIGENTRY_GIT_HOOKS_DIR!]) {
        assert.equal(existsSync(effect), false);
      }
    } finally { f.cleanup(); }
  });
}

posixTest("#1232 caller: explicit Codex ignores malformed Claude store and explicit token", () => {
  const f = fixture();
  try {
    provision(f, "FAKE INVALID STORE");
    const r = f.dispatch([...f.spawnArgs, "--cli", "codex", "--role", "coder"],
      { PATH: [f.bin, cleanHostPath()].join(delimiter), AIGENTRY_CLAUDE_OAUTH_TOKEN: "FAKE INVALID ENV" });
    assert.equal(r.status, 0, r.stderr);
    const m = f.manifest();
    assert.equal(m.cli, "codex");
    assert.equal(m.claudeOAuthHandoff, undefined);
  } finally { f.cleanup(); }
});


// #1232 routing RED/GREEN uses the actual predicate source with an explicitly
// simulated Linux platform. No native Linux confinement claim.
import { runInNewContext as routingContext } from "node:vm";
import * as routingTs from "typescript";

test("#1232 routing: Linux store selection and missing/invalid sources never silently fall back", () => {
  const source = readFileSync(join(process.cwd(), "src/dispatch/cli.ts"), "utf8");
  const start = source.indexOf("function credentialPresent(");
  const end = source.indexOf("\n/**", start);
  const predicate = routingTs.transpileModule(source.slice(start, end), {
    compilerOptions: { target: routingTs.ScriptTarget.ES2022 },
  }).outputText;
  for (const state of ["valid", "missing", "invalid"] as const) {
    let selected = 0, stats = 0;
    const context = {
      env: {}, process: { platform: "linux" }, CLAUDE_OAUTH_OPT_IN: "AIGENTRY_CLAUDE_OAUTH_TOKEN",
      path: { join }, os: { homedir: () => "/synthetic-controller" },
      fs: { statSync: () => { stats++; throw new Error("NO_HOST_CREDENTIAL"); } },
      selectedClaudeOAuthToken: () => { selected++; if (state === "invalid") throw new Error("CLAUDE_OAUTH_STORE_INVALID");
        return state === "valid" ? "FAKE-1232-ROUTING" : undefined; },
      die: (message: string, code: number) => { throw Object.assign(new Error(message), { code }); },
    };
    const run = () => routingContext(predicate + ";credentialPresent('claude')", context);
    if (state === "valid") assert.equal(run(), true, "Linux store must remain routable");
    else assert.throws(run, (e: any) => e.code === 78 &&
      e.message.includes(state === "missing" ? "SANDBOX_AUTH_WORKER_TOKEN_REQUIRED" : "SANDBOX_AUTH_WORKER_TOKEN_INVALID"));
    assert.equal(selected, 1);
    assert.equal(stats, 0, "no host credential inspection for Claude");
  }
});

posixTest("#1232 caller: automatic Claude routing uses only the private store", () => {
  const f = fixture();
  try {
    provision(f);
    unlinkSync(join(f.env.HOME!, ".claude/.credentials.json"));
    writeFileSync(join(f.aig, "instructions/roles/architect.md"), "# Fixture architect\n");
    const r = f.dispatch([...f.spawnArgs, "--role", "architect"],
      { PATH: [f.bin, cleanHostPath()].join(delimiter), AIGENTRY_CLAUDE_OAUTH_TOKEN: undefined });
    assert.equal(r.status, 0, r.stderr);
    const current = JSON.parse(readFileSync(join(f.aig, "sessions/router-fixture/sandbox-current.json"), "utf8"));
    const m = JSON.parse(readFileSync(current.manifest, "utf8"));
    assert.equal(m.cli, "claude");
    assert.equal(readFileSync(m.claudeOAuthHandoff, "utf8") === FAKE_TOKEN + "\n", true);
    assert.doesNotMatch(r.stderr, /has no credential| -> /);
  } finally { f.cleanup(); }
});

const INVALID_REFUSAL = "dispatch.sh: SANDBOX_AUTH_WORKER_TOKEN_INVALID: invalid automation token or unsafe private token store; " +
  "see docs/setup/dispatch-capacity.md; nothing was spawned (exit 78)";

// The fixture owns this node shim. Mutate only after actual boot succeeds: dispatch's initial
// auth precheck has passed, while prepareWorkerSandbox has not yet reread the store.
for (const kind of ["missing", "malformed", "unsafe", "unrelated executable change"] as const) {
  posixTest(`#1232 caller: late preparation ${kind} preserves its error boundary`, () => {
    const f = fixture();
    try {
      const source = provision(f);
      const seeded = [f.queue, join(f.root, "state/active.json")].map(p => [p, readFileSync(p, "utf8")] as const);
      f.script("node", `
const fs = require('node:fs'), path = require('node:path');
const r = require('node:child_process').spawnSync(process.execPath, process.argv.slice(2), { stdio: 'inherit' });
if (r.status === 0 && path.basename(process.argv[2] || '') === 'boot-prepare.mjs') {
  const source = path.join(process.env.HOME, '.aigentry/credentials/claude-worker/token');
  const kind = ${JSON.stringify(kind)};
  if (kind === 'missing') fs.unlinkSync(source);
  else if (kind === 'malformed') {
    fs.writeFileSync(source + '.replacement', 'FAKE-LATE-INVALID-DETAIL no-newline', { mode: 0o600 });
    fs.renameSync(source + '.replacement', source);
  } else if (kind === 'unsafe') fs.chmodSync(source, 0o644);
  else fs.appendFileSync(path.join(__dirname, 'claude'), '\\n// fixture identity change\\n');
  fs.writeFileSync(path.join(process.env.HOME, 'after-boot'), 'boot returned successfully');
}
process.exit(r.status ?? 99);
`);
      const r = spawnClaude(f, { AIGENTRY_CLAUDE_OAUTH_TOKEN: undefined });
      // Assert the actual boundary even on RED, before the expected diagnostic assertion fails.
      assert.equal(readFileSync(join(f.env.HOME!, "after-boot"), "utf8"), "boot returned successfully");
      assert.ok(existsSync(join(f.env.AIGENTRY_GIT_HOOKS_DIR!, "pre-push")), "guard already installed");
      assert.deepEqual(readdirSync(join(f.aig, "sessions/router-fixture")), ["boot"], "only boot staging survives");
      assert.ok(files(join(f.aig, "sessions/router-fixture/boot")).length > 0, "actual boot staged files");
      assert.deepEqual(readdirSync(join(f.root, "tmp")).filter(n => n.startsWith("agw-")), []);
      for (const p of [f.env.OPEN_LOG!, `${f.env.OPEN_LOG}.calls`, f.env.WORK_LOG!, f.env.PARENT_MODEL_LOG!]) {
        assert.equal(existsSync(p), false, "no terminal/worker/delivery");
      }
      for (const [p, bytes] of seeded) assert.equal(readFileSync(p, "utf8"), bytes);
      const output = r.stdout + r.stderr;
      for (const secret of [FAKE_TOKEN, "FAKE-LATE-INVALID-DETAIL", source, "fixture-access-token-not-a-real-credential"]) {
        assert.equal(output.includes(secret), false, "no token/source/parser detail disclosure");
      }
      if (kind === "unrelated executable change") {
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stderr, /SANDBOX_EXECUTABLE_CHANGED/);
        assert.doesNotMatch(r.stderr, /SANDBOX_AUTH_WORKER_TOKEN_(REQUIRED|INVALID)/);
      } else {
        assert.equal(r.status, 78, r.stderr);
        assert.equal(r.stderr.trim(), kind === "missing" ? REFUSAL : INVALID_REFUSAL);
      }
    } finally { f.cleanup(); }
  });
}

// Characterization: Codex bypass applies to explicit/eligible primary selection, not Claude fallback scanning.
for (const atCap of [false, true]) {
  for (const kind of ["missing", "invalid"] as const) {
    posixTest(`#1232 caller characterization: automatic Codex ${atCap ? "at cap" : "eligible"}, Claude auth ${kind}`, () => {
      const f = fixture();
      try {
        if (kind === "invalid") provision(f, "FAKE-INVALID-CLAUDE-STORE");
        const r = f.dispatch([...f.spawnArgs, "--role", "coder"], {
          PATH: [f.bin, cleanHostPath()].join(delimiter), AIGENTRY_CLAUDE_OAUTH_TOKEN: undefined,
          AIGENTRY_CLI_CAP_CODEX: atCap ? "0" : "10", AIGENTRY_CLI_CAP_CLAUDE: "10",
        });
        if (atCap) {
          assert.equal(r.status, 78, r.stderr);
          assert.equal(r.stderr.trim(), kind === "missing" ? REFUSAL : INVALID_REFUSAL);
          for (const p of [f.env.OPEN_LOG!, join(f.aig, "sessions"), join(f.aig, "role-sandbox"), f.env.AIGENTRY_GIT_HOOKS_DIR!]) {
            assert.equal(existsSync(p), false, "fallback selection refuses before boot");
          }
        } else {
          assert.equal(r.status, 0, r.stderr);
          assert.equal(f.manifest().cli, "codex");
          assert.equal(f.manifest().claudeOAuthHandoff, undefined);
        }
        assert.equal((r.stdout + r.stderr).includes("FAKE-INVALID-CLAUDE-STORE"), false);
        assert.equal(existsSync(f.env.WORK_LOG!), false);
      } finally { f.cleanup(); }
    });
  }
}
