// #1162 — controller boot record (display-only) + D1 wizard provenance (CONTRACT-r2 §1-3).
//
// Every fixture lives under a fresh mkdtemp directory this file creates and removes; the real
// ~/.aigentry is never touched (every call passes an explicit root). All ids, models and the
// "secret" strings below are fabricated. Subprocesses: `mkfifo` for the fifo fixture, and the
// COMPILED cli.js under `node` with every effect seam (ps/kill/curl/telepty) pointed at a
// recorder, a tripwire PATH for real binaries, and a fake HOME/AIGENTRY_HOME/TMPDIR. The shim is
// never run, nothing is exec'd, and the module under test never gets a real host, token or network.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { normalizeLaunch } from "../../src/session/boot-adapter/launch-config.js";
import {
  type BootRecordInput,
  type BootRecordPlatform,
  type ControllerBootRecord,
  type WriteResult,
  buildControllerBootRecord,
  controllerRecordRoot,
  nodePlatform,
  paneFromEnv,
  parseControllerBootRecord,
  readControllerBootRecord,
  recordPath,
  recordedLaunch,
  targetRelation,
  writeControllerBootRecord,
} from "../../src/orchestrator-boot/boot-record.js";

const require = createRequire(import.meta.url);

const POSIX = typeof process.getuid === "function" && typeof fs.constants.O_NOFOLLOW === "number";
const POSIX_ONLY: string | false = POSIX ? false : "POSIX-only fixture (modes/symlinks/uid); win32 is covered by the explicit skipped:platform tests";
const IS_ROOT = POSIX && process.getuid?.() === 0;

const WS = "0a1b2c3d-1111-4222-8333-444455556666";
const SURF = "0a1b2c3d-7777-4888-9999-aaaabbbbcccc";
const LIFE = "0a1b2c3d-dddd-4eee-afff-000011112222";
const SECRETS = ["fake-token-DO-NOT-LEAK", "/fake/cwd/DO-NOT-LEAK", "bypassPermissions-DO-NOT-LEAK"];
const OUTCOME_LINE = /^(written|skipped:(sid|platform|cli|unsafe-path|prior-invalid|raced|error)) relation=(first|same-recorded-target|different-recorded-target|target-unknown|none)$/;

const bases: string[] = [];
after(() => {
  for (const b of bases) {
    // Undo any fixture-restricted mode so the removal can proceed; only our own tempdirs.
    try {
      fs.chmodSync(b, 0o700);
    } catch {
      // already gone
    }
    fs.rmSync(b, { recursive: true, force: true });
  }
});

/** A fresh `<base>/home` ROOT with `sessions/`, both 0700, plus an `outside/` sibling. */
function fixture(): { base: string; root: string; sessions: string; outside: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aigentry-boot-record-"));
  bases.push(base);
  const root = path.join(base, "home");
  const sessions = path.join(root, "sessions");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(sessions, { mode: 0o700 });
  fs.mkdirSync(outside, { mode: 0o700 });
  return { base, root, sessions, outside };
}

function input(over: Partial<BootRecordInput> = {}): BootRecordInput {
  return {
    sid: "orch-1162",
    planSource: "env-plan",
    cli: "claude",
    model: { kind: "explicit", id: "claude-opus-5-5" },
    effort: { kind: "enum", flag: "--effort", value: "high" },
    env: {
      CMUX_WORKSPACE_ID: WS,
      CMUX_SURFACE_ID: SURF,
      CMUX_TERMINAL_LIFECYCLE_ID: LIFE,
      TELEPTY_TOKEN: SECRETS[0],
      PWD: SECRETS[1],
      AIGENTRY_BOOT_PERMISSION: SECRETS[2],
    },
    ...over,
  };
}

function targetOf(root: string, sid = "orch-1162"): string {
  const p = recordPath(root, sid);
  assert.ok(p !== null);
  return p;
}

function assertLine(r: WriteResult): void {
  assert.match(`${r.outcome} relation=${r.relation}`, OUTCOME_LINE);
}

function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p));
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

// ── D1: wizard provenance in the shared LaunchConfig normalizer ─────────────
test("D1: normalizeLaunch accepts {valid id, wizard} and keeps every existing source", () => {
  const n = (model: unknown, effort: unknown) => normalizeLaunch("claude", { v: 2, cli: "claude", model, effort });
  assert.deepEqual(n({ value: "claude-opus-5-5", source: "wizard" }, { value: "high", source: "wizard" }), {
    v: 2, cli: "claude",
    model: { value: "claude-opus-5-5", source: "wizard" },
    effort: { value: "high", source: "wizard" },
  });
  const unknown = { value: "unknown", source: "unknown" };
  assert.deepEqual(n({ value: "bad value!", source: "wizard" }, { value: "HIGH", source: "wizard" }).model, unknown);
  assert.deepEqual(n({ value: "bad value!", source: "wizard" }, { value: "HIGH", source: "wizard" }).effort, unknown);
  for (const source of ["Wizard", "wizard ", " wizard", "env:FOO", "WIZARD"]) {
    assert.deepEqual(n({ value: "claude-opus-5-5", source }, { value: "high", source }).model, unknown, source);
  }
  // Unchanged pre-existing behaviour.
  assert.deepEqual(n({ value: "m-1", source: "env:AIGENTRY_MODEL" }, { value: "low", source: "default" }), {
    v: 2, cli: "claude", model: { value: "m-1", source: "env:AIGENTRY_MODEL" }, effort: { value: "low", source: "default" },
  });
  assert.deepEqual(n({ value: "unknown", source: "cli-default" }, { value: "x", source: "cli-default" }), {
    v: 2, cli: "claude", model: { value: "unknown", source: "cli-default" }, effort: unknown,
  });
  assert.deepEqual(n({ value: "m-1", source: "unknown" }, { value: "low", source: "env:foo" }), {
    v: 2, cli: "claude", model: unknown, effort: unknown,
  });
});

test("D1: agent-metadata configured() still maps a wizard source to unknown (fail-closed)", () => {
  // configured() is module-private and agent-metadata.ts is not part of this change, so its
  // exact declaration is taken by AST position and evaluated alone (same technique as
  // worker-auth-seed.test.ts). The compiled test sits at dist/tests/session.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const file = path.join(repoRoot, "src", "session", "agent-metadata.ts");
  assert.ok(fs.existsSync(file), `agent-metadata.ts not found at ${file}`);
  const ts = require("typescript");
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const decl = sf.statements.find((s: any) => ts.isFunctionDeclaration(s) && s.name?.text === "configured");
  assert.ok(decl, "configured() declaration not found");
  const js: string = ts.transpileModule(src.slice(decl.getStart(sf), decl.end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const ctx = vm.createContext({});
  vm.runInContext(js, ctx);
  const configured = ctx.configured as (v: { value: string; source: string }) => [string, string];
  // The tuple is built in the vm realm, whose Array.prototype is not this realm's, so a strict
  // deep-equal on the raw result fails on the prototype alone. Copy the (string) values into a
  // local array and compare those: the expected values are unchanged.
  assert.deepEqual([...configured({ value: "claude-opus-5-5", source: "wizard" })], ["unknown", "unknown"]);
  assert.deepEqual([...configured({ value: "m", source: "env:AIGENTRY_MODEL" })], ["m", "configured"]);
});

// ── provenance ──────────────────────────────────────────────────────────────
test("provenance: env-plan explicit → env:AIGENTRY_BOOT_*; provider-default → cli-default", () => {
  assert.deepEqual(
    recordedLaunch("claude", "env-plan", { kind: "explicit", id: "claude-opus-5-5" }, { kind: "enum", flag: "--effort", value: "high" }),
    { v: 2, cli: "claude", model: { value: "claude-opus-5-5", source: "env:AIGENTRY_BOOT_MODEL" }, effort: { value: "high", source: "env:AIGENTRY_BOOT_EFFORT" } },
  );
  assert.deepEqual(
    recordedLaunch("claude", "env-plan", { kind: "provider-default" }, { kind: "provider-default" }),
    { v: 2, cli: "claude", model: { value: "unknown", source: "cli-default" }, effort: { value: "unknown", source: "cli-default" } },
  );
  // grok literal effort: put on argv, not accepted by the provider — still just configured.
  assert.deepEqual(
    recordedLaunch("grok", "env-plan", { kind: "provider-default" }, { kind: "unverified", flag: "--effort", value: "max" }).effort,
    { value: "max", source: "env:AIGENTRY_BOOT_EFFORT" },
  );
});

test("provenance: explicit wizard values → wizard; codex gap / gemini unsupported effort → cli-default", () => {
  assert.deepEqual(
    recordedLaunch("claude", "wizard", { kind: "explicit", id: "claude-sonnet-5" }, { kind: "enum", flag: "--effort", value: "medium" }),
    { v: 2, cli: "claude", model: { value: "claude-sonnet-5", source: "wizard" }, effort: { value: "medium", source: "wizard" } },
  );
  for (const cli of ["codex", "gemini"] as const) {
    assert.deepEqual(recordedLaunch(cli, "wizard", { kind: "explicit", id: "m-1" }, { kind: "provider-default" }).effort, {
      value: "unknown", source: "cli-default",
    });
  }
});

test("provenance: opus[1m], a+b and HIGH are recorded unknown (known gap), and the boot still writes", { skip: POSIX_ONLY }, () => {
  const unknown = { value: "unknown", source: "unknown" };
  for (const id of ["opus[1m]", "a+b"]) {
    assert.deepEqual(recordedLaunch("claude", "env-plan", { kind: "explicit", id }, { kind: "provider-default" }).model, unknown, id);
  }
  assert.deepEqual(
    recordedLaunch("grok", "wizard", { kind: "provider-default" }, { kind: "unverified", flag: "--effort", value: "HIGH" }).effort,
    unknown,
  );
  const { root } = fixture();
  const r = writeControllerBootRecord(root, input({ model: { kind: "explicit", id: "opus[1m]" } }));
  assert.equal(r.outcome, "written");
  const read = readControllerBootRecord(root, "orch-1162");
  assert.equal(read.status, "ok");
  if (read.status === "ok") assert.deepEqual(read.record.launch.model, unknown);
});

// ── pane hints ──────────────────────────────────────────────────────────────
test("pane: host cmux iff a workspace UUID; lowercased; otherwise null", () => {
  assert.deepEqual(paneFromEnv({ CMUX_WORKSPACE_ID: WS.toUpperCase(), CMUX_SURFACE_ID: SURF, CMUX_TERMINAL_LIFECYCLE_ID: "nope" }), {
    host: "cmux", workspace_id: WS, surface_id: SURF, terminal_lifecycle_id: null,
  });
  const none = { host: "none", workspace_id: null, surface_id: null, terminal_lifecycle_id: null };
  assert.deepEqual(paneFromEnv({ CMUX_SURFACE_ID: SURF, CMUX_TERMINAL_LIFECYCLE_ID: LIFE }), none);
  assert.deepEqual(paneFromEnv({ CMUX_WORKSPACE_ID: `${WS} ` }), none);
  assert.deepEqual(paneFromEnv({}), none);
});

// ── schema / no leak ────────────────────────────────────────────────────────
test("schema: exact keys, canonical values, no sensitive field or value", { skip: POSIX_ONLY }, () => {
  const { root } = fixture();
  const r = writeControllerBootRecord(root, input());
  assert.deepEqual(r, { outcome: "written", relation: "first" });
  assertLine(r);
  const text = fs.readFileSync(targetOf(root), "utf8");
  const rec = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(rec).sort(), ["boot_id", "kind", "launch", "pane", "plan_source", "sid", "v"]);
  assert.equal(rec.v, 1);
  assert.equal(rec.kind, "aigentry-controller-boot");
  assert.equal(rec.sid, "orch-1162");
  assert.equal(rec.plan_source, "env-plan");
  assert.match(String(rec.boot_id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(rec.launch, {
    v: 2, cli: "claude",
    model: { value: "claude-opus-5-5", source: "env:AIGENTRY_BOOT_MODEL" },
    effort: { value: "high", source: "env:AIGENTRY_BOOT_EFFORT" },
  });
  assert.deepEqual(rec.pane, { host: "cmux", workspace_id: WS, surface_id: SURF, terminal_lifecycle_id: LIFE });
  assert.ok(Buffer.byteLength(text) <= 4096);
  for (const s of [...SECRETS, "token", "argv", "\"env\"", "cwd", "pid", "permission", "history", "selector", "time", process.cwd()]) {
    assert.ok(!text.includes(s), `record leaks ${s}`);
  }
});

test("schema: key order alone is not corruption; a reordered valid record reads ok", { skip: POSIX_ONLY }, () => {
  const { root } = fixture();
  writeControllerBootRecord(root, input());
  const target = targetOf(root);
  const rec = JSON.parse(fs.readFileSync(target, "utf8")) as ControllerBootRecord;
  const reordered = {
    pane: { terminal_lifecycle_id: rec.pane.terminal_lifecycle_id, surface_id: rec.pane.surface_id, workspace_id: rec.pane.workspace_id, host: rec.pane.host },
    launch: { effort: rec.launch.effort, model: { source: rec.launch.model.source, value: rec.launch.model.value }, cli: rec.launch.cli, v: 2 },
    plan_source: rec.plan_source, boot_id: rec.boot_id, sid: rec.sid, kind: rec.kind, v: 1,
  };
  fs.writeFileSync(target, JSON.stringify(reordered));
  const read = readControllerBootRecord(root, "orch-1162");
  assert.equal(read.status, "ok");
  if (read.status === "ok") assert.deepEqual(read.record, rec);
  assert.equal(parseControllerBootRecord(reordered, "orch-1162")?.boot_id, rec.boot_id);
});

// ── absent / valid prior ────────────────────────────────────────────────────
test("absent prior: creates <sid>/controller 0700 and a 0600 nlink-1 record, no temp left", { skip: POSIX_ONLY }, () => {
  const { root, sessions } = fixture();
  assert.equal(readControllerBootRecord(root, "orch-1162").status, "absent");
  assert.deepEqual(listTree(sessions), [], "the reader created nothing");
  const r = writeControllerBootRecord(root, input());
  assert.deepEqual(r, { outcome: "written", relation: "first" });
  const target = targetOf(root);
  const st = fs.lstatSync(target);
  assert.ok(st.isFile());
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(st.nlink, 1);
  assert.equal(fs.lstatSync(path.join(sessions, "orch-1162")).mode & 0o077, 0);
  assert.equal(fs.lstatSync(path.dirname(target)).mode & 0o077, 0);
  assert.deepEqual(listTree(sessions), ["orch-1162", "orch-1162/controller", "orch-1162/controller/boot-record.json"]);
});

test("valid prior: replaced atomically (new inode, new boot_id) and relation described", { skip: POSIX_ONLY }, () => {
  const { root } = fixture();
  writeControllerBootRecord(root, input());
  const target = targetOf(root);
  const before = fs.lstatSync(target);
  const prior = readControllerBootRecord(root, "orch-1162");
  assert.equal(prior.status, "ok");
  const r = writeControllerBootRecord(root, input({ planSource: "wizard" }));
  assert.deepEqual(r, { outcome: "written", relation: "same-recorded-target" });
  const now = readControllerBootRecord(root, "orch-1162");
  assert.equal(now.status, "ok");
  if (prior.status === "ok" && now.status === "ok") {
    assert.notEqual(now.record.boot_id, prior.record.boot_id);
    assert.equal(now.record.plan_source, "wizard");
    assert.equal(now.record.launch.model.source, "wizard");
  }
  assert.notEqual(fs.lstatSync(target).ino, before.ino);
  const r2 = writeControllerBootRecord(root, input({ env: { CMUX_WORKSPACE_ID: WS } }));
  assert.deepEqual(r2, { outcome: "written", relation: "target-unknown" });
  assert.deepEqual(listTree(path.dirname(target)), ["boot-record.json"]);
});

// ── relation ────────────────────────────────────────────────────────────────
test("relation: first / same / different / target-unknown, from recorded values only", () => {
  const rec = (env: Record<string, string>): ControllerBootRecord => {
    const r = buildControllerBootRecord(input({ env }), "0a1b2c3d-0000-4000-8000-000000000000");
    assert.ok(r !== null);
    return r;
  };
  const full = { CMUX_WORKSPACE_ID: WS, CMUX_SURFACE_ID: SURF, CMUX_TERMINAL_LIFECYCLE_ID: LIFE };
  const other = "0a1b2c3d-9999-4999-9999-999999999999";
  assert.equal(targetRelation(null, rec(full)), "first");
  assert.equal(targetRelation(rec(full), rec(full)), "same-recorded-target");
  assert.equal(targetRelation(rec(full), rec({ ...full, CMUX_WORKSPACE_ID: other })), "different-recorded-target");
  assert.equal(targetRelation(rec(full), rec({ ...full, CMUX_SURFACE_ID: other })), "different-recorded-target");
  assert.equal(targetRelation(rec(full), rec({ ...full, CMUX_TERMINAL_LIFECYCLE_ID: other })), "different-recorded-target");
  const partial = { CMUX_WORKSPACE_ID: WS, CMUX_SURFACE_ID: SURF };
  assert.equal(targetRelation(rec(partial), rec(partial)), "target-unknown", "null never equals null");
  assert.equal(targetRelation(rec(full), rec(partial)), "target-unknown");
  assert.equal(targetRelation(rec({}), rec({})), "target-unknown");
});

test("relation gates nothing in cli.ts: one writer call, relation only interpolated into the log", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const file = path.join(repoRoot, "src", "orchestrator-boot", "cli.ts");
  assert.ok(fs.existsSync(file), `cli.ts not found at ${file}`);
  const src = fs.readFileSync(file, "utf8");
  assert.equal(src.split("writeControllerBootRecord(").length - 1, 1);
  assert.ok(!src.includes("readControllerBootRecord"));
  assert.ok(!src.includes("targetRelation"));
  for (const lit of ["same-recorded-target", "different-recorded-target", "target-unknown"]) assert.ok(!src.includes(lit), lit);
  const main = src.slice(src.indexOf("async function main()"), src.indexOf("function help()"));
  const at = (s: string) => main.indexOf(s);
  assert.ok(at("orchestratorSingletonGuard(") >= 0 && at("orchestratorSingletonGuard(") < at("writeControllerBootRecord("));
  assert.ok(at("writeControllerBootRecord(") < at("emitExecArgv("));
});

// ── sid / cli / platform ────────────────────────────────────────────────────
test("sid: unsafe sids are skipped:sid and nothing is created", { skip: POSIX_ONLY }, () => {
  const { root, sessions } = fixture();
  for (const sid of ["a/../b", "", ".hidden", "-x", "_x", "a b", "a\nb", "x".repeat(129), "../orch", "a/b"]) {
    const r = writeControllerBootRecord(root, input({ sid }));
    assert.deepEqual(r, { outcome: "skipped:sid", relation: "none" }, JSON.stringify(sid));
    assertLine(r);
    assert.deepEqual(readControllerBootRecord(root, sid), { status: "skipped", reason: "sid" });
    assert.equal(recordPath(root, sid), null);
  }
  assert.equal(writeControllerBootRecord(root, input({ sid: "x".repeat(128) })).outcome, "written");
  assert.deepEqual(listTree(sessions).filter((p) => !p.startsWith("x".repeat(128))), []);
});

test("cli: a non-CliKind provider is skipped:cli and nothing is created", { skip: POSIX_ONLY }, () => {
  const { root, sessions } = fixture();
  assert.deepEqual(writeControllerBootRecord(root, input({ cli: "bash" })), { outcome: "skipped:cli", relation: "none" });
  assert.deepEqual(listTree(sessions), []);
});

test("platform: missing getuid / O_NOFOLLOW / O_NONBLOCK is explicit skipped:platform (not a fake success)", () => {
  // Runs on every OS: this is the Windows shape (no process.getuid, no O_NOFOLLOW) made explicit.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aigentry-boot-record-"));
  bases.push(base);
  const real = nodePlatform();
  const variants: BootRecordPlatform[] = [
    { ...real, getuid: undefined },
    { ...real, noFollow: undefined },
    { ...real, nonBlock: undefined },
  ];
  for (const p of variants) {
    assert.deepEqual(writeControllerBootRecord(base, input(), p), { outcome: "skipped:platform", relation: "none" });
    assert.deepEqual(readControllerBootRecord(base, "orch-1162", p), { status: "skipped", reason: "platform" });
  }
  assert.deepEqual(fs.readdirSync(base), []);
});

test("platform: on win32 the real platform is skipped:platform", { skip: process.platform === "win32" ? false : "win32-only assertion; the seam test above covers the same branch here" }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aigentry-boot-record-"));
  bases.push(base);
  assert.equal(writeControllerBootRecord(base, input()).outcome, "skipped:platform");
});

test("root: AIGENTRY_HOME when non-empty, else <homedir>/.aigentry (computed only, nothing touched)", () => {
  assert.equal(controllerRecordRoot({ AIGENTRY_HOME: "/fake/aigentry-home" }), "/fake/aigentry-home");
  assert.equal(controllerRecordRoot({ AIGENTRY_HOME: "" }), path.join(os.homedir(), ".aigentry"));
  assert.equal(controllerRecordRoot({}), path.join(os.homedir(), ".aigentry"));
});

// ── the safe chain ──────────────────────────────────────────────────────────
test("chain: symlinked/unsafe/missing ancestors are skipped:unsafe-path and nothing lands outside", { skip: POSIX_ONLY }, () => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => string]> = [
    ["ROOT is a symlink", (f) => {
      const link = path.join(f.base, "root-link");
      fs.renameSync(f.root, path.join(f.outside, "home"));
      fs.symlinkSync(path.join(f.outside, "home"), link);
      return link;
    }],
    ["sessions is a symlink", (f) => {
      fs.rmdirSync(f.sessions);
      fs.symlinkSync(f.outside, f.sessions);
      return f.root;
    }],
    ["sessions/<sid> is a symlink", (f) => {
      fs.symlinkSync(f.outside, path.join(f.sessions, "orch-1162"));
      return f.root;
    }],
    ["controller is a symlink", (f) => {
      fs.mkdirSync(path.join(f.sessions, "orch-1162"), { mode: 0o700 });
      fs.symlinkSync(f.outside, path.join(f.sessions, "orch-1162", "controller"));
      return f.root;
    }],
    ["controller is a regular file", (f) => {
      fs.mkdirSync(path.join(f.sessions, "orch-1162"), { mode: 0o700 });
      fs.writeFileSync(path.join(f.sessions, "orch-1162", "controller"), "x", { mode: 0o600 });
      return f.root;
    }],
    ["sessions is group-writable", (f) => {
      fs.chmodSync(f.sessions, 0o770);
      return f.root;
    }],
    ["ROOT is other-writable", (f) => {
      fs.chmodSync(f.root, 0o702);
      return f.root;
    }],
    ["ROOT is missing", (f) => path.join(f.base, "no-such-root")],
    ["sessions is missing", (f) => {
      fs.rmdirSync(f.sessions);
      return f.root;
    }],
  ];
  for (const [name, setup] of cases) {
    const f = fixture();
    const root = setup(f);
    const outsideBefore = listTree(f.outside);
    const r = writeControllerBootRecord(root, input());
    assert.deepEqual(r, { outcome: "skipped:unsafe-path", relation: "none" }, name);
    assertLine(r);
    assert.deepEqual(listTree(f.outside), outsideBefore, `${name}: wrote outside the tree`);
    const read = readControllerBootRecord(root, "orch-1162");
    assert.ok(read.status === "absent" || (read.status === "skipped" && read.reason === "unsafe-path"), name);
    if (name.endsWith("missing")) {
      assert.equal(read.status, "absent", name);
      assert.ok(!fs.existsSync(path.join(root, "sessions", "orch-1162")), `${name}: created a directory`);
    }
  }
});

// ── invalid priors are preserved ────────────────────────────────────────────
type Snapshot = { mode: number; ino: number; size: number; mtimeMs: number; link: string | null; bytes: string | null };

function snapshot(p: string, readBytes: boolean): Snapshot {
  const st = fs.lstatSync(p);
  return {
    mode: st.mode, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs,
    link: st.isSymbolicLink() ? fs.readlinkSync(p) : null,
    bytes: readBytes && st.isFile() ? fs.readFileSync(p).toString("base64") : null,
  };
}

test("prior invalid: every bad prior is invalid, skipped:prior-invalid, and left byte/mode-identical", { skip: POSIX_ONLY }, () => {
  const good = (): Record<string, unknown> => {
    const r = buildControllerBootRecord(input(), "0a1b2c3d-0000-4000-8000-000000000000");
    return JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
  };
  const json = (o: unknown) => JSON.stringify(o);
  const mutate = (fn: (o: Record<string, any>) => void) => {
    const o = good();
    fn(o);
    return json(o);
  };
  type Case = { name: string; read: boolean; make: (target: string, f: ReturnType<typeof fixture>) => boolean };
  const file = (text: string, mode = 0o600) => (t: string) => {
    fs.writeFileSync(t, text, { mode });
    fs.chmodSync(t, mode);
    return true;
  };
  const cases: Case[] = [
    { name: "symlink target", read: true, make: (t, f) => {
      const real = path.join(f.outside, "real.json");
      fs.writeFileSync(real, json(good()), { mode: 0o600 });
      fs.symlinkSync(real, t);
      return true;
    } },
    { name: "fifo", read: false, make: (t) => spawnSync("mkfifo", ["-m", "600", t]).status === 0 },
    { name: "mode 0644", read: true, make: file(json(good()), 0o644) },
    { name: "nlink 2", read: true, make: (t, f) => {
      file(json(good()))(t);
      fs.linkSync(t, path.join(f.outside, "hardlink.json"));
      return true;
    } },
    { name: "4097 bytes", read: true, make: file(json(good()).padEnd(4097, " ")) },
    { name: "10 MB sparse", read: false, make: (t) => {
      file("")(t);
      fs.truncateSync(t, 10 * 1024 * 1024);
      return true;
    } },
    { name: "directory at target", read: false, make: (t) => {
      fs.mkdirSync(t, { mode: 0o700 });
      return true;
    } },
    { name: "malformed json", read: true, make: file("{\"v\":1,") },
    { name: "extra key", read: true, make: file(mutate((o) => { o.extra = 1; })) },
    { name: "wrong sid", read: true, make: file(mutate((o) => { o.sid = "someone-else"; })) },
    { name: "wrong v", read: true, make: file(mutate((o) => { o.v = 2; })) },
    { name: "wrong kind", read: true, make: file(mutate((o) => { o.kind = "aigentry-worker-boot"; })) },
    { name: "boot_id not v4", read: true, make: file(mutate((o) => { o.boot_id = "0a1b2c3d-0000-1000-8000-000000000000"; })) },
    { name: "plan_source unknown", read: true, make: file(mutate((o) => { o.plan_source = "default"; })) },
    { name: "non-canonical launch value", read: true, make: file(mutate((o) => { o.launch.model.value = "HIGH!"; })) },
    { name: "non-canonical unknown", read: true, make: file(mutate((o) => { o.launch.model = { value: "x", source: "unknown" }; })) },
    { name: "source not from this plan", read: true, make: file(mutate((o) => { o.launch.model.source = "wizard"; })) },
    { name: "aigentry default source", read: true, make: file(mutate((o) => { o.launch.effort.source = "default"; })) },
    { name: "launch extra key", read: true, make: file(mutate((o) => { o.launch.extra = 1; })) },
    { name: "launch cli mismatch", read: true, make: file(mutate((o) => { o.launch.cli = "bash"; })) },
    { name: "pane cmux without workspace", read: true, make: file(mutate((o) => { o.pane.workspace_id = null; })) },
    { name: "pane none with an id", read: true, make: file(mutate((o) => { o.pane.host = "none"; o.pane.workspace_id = null; o.pane.terminal_lifecycle_id = null; })) },
    { name: "pane uppercase uuid", read: true, make: file(mutate((o) => { o.pane.surface_id = SURF.toUpperCase(); })) },
    { name: "array", read: true, make: file("[]") },
  ];
  for (const c of cases) {
    const f = fixture();
    const target = targetOf(f.root);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!c.make(target, f)) {
      assert.fail(`${c.name}: fixture could not be created (mkfifo unavailable?)`);
    }
    const before = snapshot(target, c.read);
    const outsideBefore = c.name === "symlink target" ? fs.readFileSync(path.join(f.outside, "real.json"), "utf8") : null;
    assert.equal(readControllerBootRecord(f.root, "orch-1162").status, "invalid", c.name);
    const r = writeControllerBootRecord(f.root, input());
    assert.deepEqual(r, { outcome: "skipped:prior-invalid", relation: "none" }, c.name);
    assertLine(r);
    assert.deepEqual(snapshot(target, c.read), before, `${c.name}: prior changed`);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ["boot-record.json"], `${c.name}: temp left behind`);
    if (outsideBefore !== null) assert.equal(fs.readFileSync(path.join(f.outside, "real.json"), "utf8"), outsideBefore);
  }
});

// ── error containment ───────────────────────────────────────────────────────
test("errors: a throwing prerequisite is skipped:error, never a throw", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aigentry-boot-record-"));
  bases.push(base);
  // Host-independent: a complete explicit platform, so supported() reaches getuid on every host
  // (nodePlatform() lacks noFollow/nonBlock on win32 and would stop at skipped:platform). The
  // numeric flags are inert placeholders and never authorise an open: getuid throws first.
  let getuidCalls = 0;
  const p: BootRecordPlatform = {
    getuid: () => {
      getuidCalls += 1;
      throw new Error("boom");
    },
    noFollow: 0,
    nonBlock: 0,
  };
  assert.deepEqual(writeControllerBootRecord(base, input(), p), { outcome: "skipped:error", relation: "none" });
  assert.equal(getuidCalls, 1);
  assert.equal(readControllerBootRecord(base, "orch-1162", p).status, "invalid");
  assert.equal(getuidCalls, 2);
  assert.deepEqual(fs.readdirSync(base), []);
});

test("errors: an unwritable controller dir is skipped:error with no temp and no target left", { skip: POSIX_ONLY || (IS_ROOT ? "root bypasses directory permissions" : false) }, () => {
  const f = fixture();
  const target = targetOf(f.root);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(target), 0o500);
  try {
    const r = writeControllerBootRecord(f.root, input());
    assert.deepEqual(r, { outcome: "skipped:error", relation: "none" });
    assertLine(r);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), []);
  } finally {
    fs.chmodSync(path.dirname(target), 0o700);
  }
});

// ── builtin fs instrumentation (drift / cleanup regressions) ────────────────
// boot-record.ts imports node:fs as a namespace; replacing a function on the builtin module
// object and calling syncBuiltinESMExports() makes the namespace see it. Every patch is undone
// in `finally`, so a failing assertion can never leave fs instrumented for a later test.
const fsModule = require("node:fs") as Record<string, unknown>;
type Wrap = (orig: (...a: any[]) => any) => (...a: any[]) => any;

function withFsPatched<T>(patches: Record<string, Wrap>, fn: () => T): T {
  const saved = new Map<string, unknown>();
  try {
    for (const [name, wrap] of Object.entries(patches)) {
      const orig = fsModule[name] as (...a: any[]) => any;
      saved.set(name, orig);
      fsModule[name] = wrap(orig);
    }
    syncBuiltinESMExports();
    return fn();
  } finally {
    for (const [name, orig] of saved) fsModule[name] = orig;
    syncBuiltinESMExports();
  }
}

function afterRename(act: (renameSync: (...a: any[]) => any) => void): Record<string, Wrap> {
  return {
    renameSync: (orig) => function (this: unknown, ...a: any[]) {
      const out = orig.apply(this, a);
      if (String(a[1]).endsWith("boot-record.json")) act(orig);
      return out;
    },
  };
}

test("drift: controller dir replaced right after the rename → skipped:raced, never written", { skip: POSIX_ONLY }, () => {
  const f = fixture();
  const dir = path.dirname(targetOf(f.root));
  const r = withFsPatched(afterRename((rename) => {
    rename(dir, `${dir}.moved`);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "boot-record.json"), "{}", { mode: 0o600 });
  }), () => writeControllerBootRecord(f.root, input()));
  assert.deepEqual(r, { outcome: "skipped:raced", relation: "none" });
});

test("drift: an ancestor turned into a symlink after the rename → skipped:raced", { skip: POSIX_ONLY }, () => {
  const f = fixture();
  const sidDir = path.join(f.sessions, "orch-1162");
  const r = withFsPatched(afterRename((rename) => {
    rename(sidDir, `${sidDir}.real`);
    fs.symlinkSync(`${sidDir}.real`, sidDir);
  }), () => writeControllerBootRecord(f.root, input()));
  assert.deepEqual(r, { outcome: "skipped:raced", relation: "none" });
  // Only OBSERVED drift is detected (§3.5). A swap that is undone before the re-check (ABA) is
  // not, and nothing here claims otherwise.
});

test("cleanup: a rename failure is skipped:error, our temp is removed, a valid prior is untouched", { skip: POSIX_ONLY }, () => {
  const f = fixture();
  assert.equal(writeControllerBootRecord(f.root, input()).outcome, "written");
  const target = targetOf(f.root);
  const before = snapshot(target, true);
  const r = withFsPatched({
    renameSync: () => () => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    },
  }, () => writeControllerBootRecord(f.root, input()));
  assert.deepEqual(r, { outcome: "skipped:error", relation: "none" });
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["boot-record.json"]);
  assert.deepEqual(snapshot(target, true), before);
});

test("cleanup: a write failure after the temp exists unlinks exactly our temp and nothing else", { skip: POSIX_ONLY }, () => {
  const f = fixture();
  const unlinked: string[] = [];
  const r = withFsPatched({
    writeSync: () => () => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    },
    unlinkSync: (orig) => function (this: unknown, ...a: any[]) {
      unlinked.push(String(a[0]));
      return orig.apply(this, a);
    },
  }, () => writeControllerBootRecord(f.root, input()));
  assert.deepEqual(r, { outcome: "skipped:error", relation: "none" });
  assert.deepEqual(fs.readdirSync(path.dirname(targetOf(f.root))), []);
  assert.equal(unlinked.length, 1);
  assert.match(path.basename(unlinked[0] ?? ""), /^\.boot-record\.json\.[0-9a-f-]{36}$/);
});

test("nested exact keys: an extra key in pane or in a launch value is invalid, and such a prior is preserved", { skip: POSIX_ONLY }, () => {
  const good = JSON.parse(JSON.stringify(buildControllerBootRecord(input(), "0a1b2c3d-0000-4000-8000-000000000000"))) as Record<string, any>;
  assert.ok(parseControllerBootRecord(good, "orch-1162"));
  assert.equal(parseControllerBootRecord({ ...good, pane: { ...good.pane, owner: "me" } }, "orch-1162"), null);
  assert.equal(parseControllerBootRecord({ ...good, launch: { ...good.launch, model: { ...good.launch.model, extra: 1 } } }, "orch-1162"), null);
  assert.equal(parseControllerBootRecord({ ...good, launch: { ...good.launch, effort: { ...good.launch.effort, extra: 1 } } }, "orch-1162"), null);
  const f = fixture();
  const target = targetOf(f.root);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, JSON.stringify({ ...good, pane: { ...good.pane, owner: "me" } }), { mode: 0o600 });
  const before = snapshot(target, true);
  assert.deepEqual(writeControllerBootRecord(f.root, input()), { outcome: "skipped:prior-invalid", relation: "none" });
  assert.deepEqual(snapshot(target, true), before);
});

// ── the compiled CLI with stubbed effects ───────────────────────────────────
// cli.js is run directly (never the shim, so nothing can be exec'd). ps/kill/curl/telepty are
// recorder scripts; real binaries that must never run sit first on PATH as tripwires; the auth
// door is a synthetic bash function. The compiled test sits at dist/tests/session.
const CLI_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "orchestrator-boot", "cli.js");
const RECORD_LINE_PREFIX = "[orchestrator-boot] boot record: ";
const PLAN_ARGV = ["telepty", "allow", "--id", "orch-1162", "--auto-restart", "claude", "--permission-mode", "manual"];
// An --import preload that logs every sync fs call on a `/sessions` path: "no read and no
// write" is then a measurement. Inline (data: URL) so it needs no extra file.
const TRACE_SRC = [
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const log = process.env.FS_TRACE_LOG; const add = fs.appendFileSync.bind(fs);",
  'for (const n of ["openSync","lstatSync","statSync","mkdirSync","renameSync","unlinkSync","readFileSync","writeFileSync","existsSync","readdirSync","chmodSync","chownSync","rmSync","rmdirSync","symlinkSync","linkSync","realpathSync","accessSync"]) {',
  '  const o = fs[n]; if (typeof o !== "function") continue;',
  '  fs[n] = function (p, ...r) { if (typeof p === "string" && p.includes("/sessions")) add(log, n + " " + p + "\\n"); return o.call(this, p, ...r); };',
  "}",
  "syncBuiltinESMExports();",
].join("\n");
const TRACE_IMPORT = `data:text/javascript,${encodeURIComponent(TRACE_SRC)}`;

function cliFixture() {
  const f = fixture();
  const stub = path.join(f.base, "stub");
  const trip = path.join(f.base, "trip");
  const shimLib = path.join(f.base, "shim", "bin", "lib");
  const fakeHome = path.join(f.base, "fake-home");
  const tmp = path.join(f.base, "tmp");
  for (const d of [stub, trip, shimLib, fakeHome, tmp]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const effects = path.join(f.base, "effects.log");
  const tripLog = path.join(f.base, "tripwire.log");
  const trace = path.join(f.base, "trace.log");
  for (const p of [effects, tripLog, trace]) fs.writeFileSync(p, "");
  const script = (p: string, body: string) => fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  script(path.join(stub, "ps"), `printf 'ps %s\\n' "$*" >> '${effects}'`);
  script(path.join(stub, "kill"), `printf 'kill %s\\n' "$*" >> '${effects}'`);
  script(path.join(stub, "curl"), `printf 'curl %s\\n' "$*" >> '${effects}'; printf '200'`);
  script(path.join(stub, "telepty"), `printf 'telepty %s\\n' "$*" >> '${effects}'; printf '[]'`);
  for (const b of ["cmux", "curl", "telepty", "claude", "codex", "gemini", "grok", "kill", "pkill", "killall", "osascript", "open", "launchctl"]) {
    script(path.join(trip, b), `printf '${b} %s\\n' "$*" >> '${tripLog}'; exit 97`);
  }
  fs.writeFileSync(path.join(shimLib, "telepty-auth.sh"), 'telepty_auth_token() { printf "fixture-token-1162"; }\n');
  const run = (args: string[], over: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ["--import", TRACE_IMPORT, CLI_JS, ...args], {
      cwd: f.base,
      encoding: "utf8",
      input: "",
      timeout: 30_000,
      env: {
        PATH: `${trip}:/usr/bin:/bin:${path.dirname(process.execPath)}`,
        HOME: fakeHome, TMPDIR: tmp, AIGENTRY_HOME: f.root,
        AIGENTRY_SHIM_SCRIPT_DIR: path.join(f.base, "shim", "bin"),
        SINGLETON_PS_CMD: path.join(stub, "ps"), KILL_CMD: path.join(stub, "kill"),
        CURL: path.join(stub, "curl"), TELEPTY: path.join(stub, "telepty"),
        SINGLETON_SELF_PID: "9999", TELEPTY_PORT: "3848",
        AIGENTRY_BOOT_PLAN: "1", AIGENTRY_BOOT_PERMISSION: "approval=manual", AIGENTRY_BOOT_HISTORY: "new",
        ORCHESTRATOR_CLI: "claude", ORCHESTRATOR_SID: "orch-1162",
        TELEPTY_TOKEN: SECRETS[0], FS_TRACE_LOG: trace,
        ...over,
      },
    });
    const traced = fs.readFileSync(trace, "utf8");
    fs.writeFileSync(trace, "");
    return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, traced };
  };
  return { ...f, run, tripLog, effects };
}

const recordLines = (stderr: string) => stderr.split("\n").filter((l) => l.startsWith(RECORD_LINE_PREFIX));
const withoutRecordLine = (stderr: string) => stderr.split("\n").filter((l) => !l.startsWith(RECORD_LINE_PREFIX)).join("\n");

test("cli boot: stdout argv and exit are independent of the record outcome; one fixed stderr line after the guards", { skip: POSIX_ONLY }, () => {
  const c = cliFixture();
  const expectedStdout = `${PLAN_ARGV.join("\n")}\n`;
  const runs: Array<[string, ReturnType<typeof c.run>]> = [];

  runs.push(["written relation=first", c.run([])]);
  const target = targetOf(c.root);
  const st = fs.lstatSync(target);
  assert.ok(st.isFile() && (st.mode & 0o777) === 0o600 && st.nlink === 1);
  const text = fs.readFileSync(target, "utf8");
  for (const s of [...SECRETS, "fixture-token-1162", "permission", "approval", "argv", "cwd"]) assert.ok(!text.includes(s), `record leaks ${s}`);
  assert.ok(runs[0]![1].traced.length > 0, "positive control: the trace sees the boot path's record access");

  runs.push(["written relation=target-unknown", c.run([])]);
  fs.writeFileSync(target, "{}", { mode: 0o600 });
  runs.push(["skipped:prior-invalid relation=none", c.run([])]);
  assert.equal(fs.readFileSync(target, "utf8"), "{}", "invalid prior preserved");
  runs.push(["skipped:sid relation=none", c.run([], { ORCHESTRATOR_SID: "a/../b" })]);
  fs.rmSync(c.sessions, { recursive: true, force: true });
  runs.push(["skipped:unsafe-path relation=none", c.run([])]);
  assert.ok(!fs.existsSync(c.sessions), "the writer never creates sessions/");

  const baseStderr = withoutRecordLine(runs[0]![1].stderr);
  for (const [want, r] of runs) {
    assert.equal(r.status, 0, `${want}: exit`);
    const sidArgv = want.startsWith("skipped:sid") ? expectedStdout.replace("orch-1162", "a/../b") : expectedStdout;
    assert.equal(r.stdout, sidArgv, `${want}: stdout is exactly the exec argv`);
    const lines = recordLines(r.stderr);
    assert.deepEqual(lines, [`${RECORD_LINE_PREFIX}${want}`], `${want}: exactly one fixed line`);
    assert.match(lines[0]!.slice(RECORD_LINE_PREFIX.length), OUTCOME_LINE);
    if (!want.startsWith("skipped:sid")) assert.equal(withoutRecordLine(r.stderr), baseStderr, `${want}: other stderr unchanged`);
    const all = r.stderr.split("\n");
    const at = (p: string) => all.findIndex((l) => l.includes(p));
    assert.ok(at("singleton guard done") >= 0 && at("singleton guard done") < at(RECORD_LINE_PREFIX), `${want}: record after the guard`);
    assert.ok(at(RECORD_LINE_PREFIX) < at("[orchestrator-boot] exec "), `${want}: record before the argv`);
    for (const s of [...SECRETS, "fixture-token-1162"]) assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s), `${want}: leaks ${s}`);
  }
  assert.ok(fs.readFileSync(c.effects, "utf8").includes("ps "), "the guard ran through the ps recorder");
  assert.equal(fs.readFileSync(c.tripLog, "utf8"), "", "no real binary was reached");
});

test("cli no-exec modes: help/dry-run/probe/wizard-plan/unknown/refusals do NO record read and NO write", { skip: POSIX_ONLY }, () => {
  const c = cliFixture();
  assert.equal(c.run([]).status, 0);
  const target = targetOf(c.root);
  const before = snapshot(target, true);
  const cases: Array<[string[], Record<string, string>, number]> = [
    [["--help"], {}, 0],
    [["-h"], {}, 0],
    [["--dry-run"], {}, 0],
    [["__probe", "singleton-guard"], {}, 0],
    [["__probe", "registry-reconcile"], {}, 0],
    [["__probe", "exec-argv"], {}, 0],
    [["--wizard-plan"], {}, 2],
    [["--bogus"], {}, 2],
    [[], { AIGENTRY_BOOT_PLAN: "" }, 2],
    [[], { ORCHESTRATOR_SID: "orch\t1162" }, 2],
  ];
  for (const [args, over, code] of cases) {
    const name = `${args.join(" ") || "boot"} ${JSON.stringify(over)}`;
    const r = c.run(args, over);
    assert.equal(r.status, code, `${name}: exit`);
    assert.equal(r.traced, "", `${name}: touched sessions/: ${r.traced}`);
    assert.deepEqual(recordLines(r.stderr), [], `${name}: record line`);
    assert.ok(!r.stdout.includes(RECORD_LINE_PREFIX), `${name}: record line on stdout`);
    assert.deepEqual(snapshot(target, true), before, `${name}: record changed`);
  }
  assert.deepEqual(listTree(c.sessions), ["orch-1162", "orch-1162/controller", "orch-1162/controller/boot-record.json"]);
  assert.equal(fs.readFileSync(c.tripLog, "utf8"), "", "no real binary was reached");
});
