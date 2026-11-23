// Task 1294 — reconciler step 0b4, the controller-link pump (U9, SPEC §9.1): TEST-PLAN §2.9 R1 and R3.
//
// R1 runs the REAL compiled tick (dist/src/reconciler/cli.js --once), which runs the REAL step 0b3
// (dist/src/tracker/cli.js report-pump --once) and the REAL step 0b4
// (dist/src/controller-link/cli.js pump --once), and reads what the tick wrote to reconciler.log.
// Hermetic: a temp package root per test (AIGENTRY_SHIM_SCRIPT_DIR = <root>/bin, so the store and
// the peer list default under <root>/state), HOME inside it, a registry that lists nothing, the
// platform lib answering "awake / lid open / no shims", every other helper absent and TELEPTY a path
// that does not exist — so the tick ends at step 2's "abort sweep — bad telepty list", which is the
// evidence that the steps after 0b4 still ran. The store is empty, so the pump sends nothing.
// R1 needs bash (platform lib) and a shebang registry stub, so it is registered off win32 only; on
// native Windows no service runs the reconciler (SPEC §9.1: `pump --loop 60` by hand there).
//
// R3 runs the REAL compiled comms auditor (dist/src/comms-auditor/cli.js), the program step 0c
// runs, over a fixture peer-inject log. Registered on every platform.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ControllerLinkStore } from "../../src/controller-link/store.js";

const DIST_SRC = path.resolve(import.meta.dirname, "..", "..", "src");
const RECONCILER = path.join(DIST_SRC, "reconciler", "cli.js");
const AUDITOR = path.join(DIST_SRC, "comms-auditor", "cli.js");
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const WIN = process.platform === "win32";
const NOW = "2026-11-22T12:00:00Z";

interface Pkg {
  root: string;
  storeRoot: string;
  peersFile: string;
  env: NodeJS.ProcessEnv;
}

/** A temp package root the tick treats as its own (REPO_DIR = <root>). */
function pkg(t: TestContext): Pkg {
  const root = fs.mkdtempSync(path.join(tmpdir(), "reconciler-controller-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(bin, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  // The registry lists nothing: step 0 processes zero dispatches, 0b3 reads zero report rows.
  fs.writeFileSync(path.join(bin, "dispatch-registry.py"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "lib", "platform.sh"),
    "platform::host_power_state() { echo awake; }\nplatform::lid_closed() { return 1; }\n" +
    "platform::session_pid() { echo ''; }\nplatform::node_options_shim_refs() { :; }\n");
  fs.writeFileSync(path.join(bin, "lib", "telepty-listing.sh"),
    "telepty_listing_trusted() { return 0; }\ntelepty_sid_live() { return 0; }\n");
  const none = path.join(root, "absent-helper");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "home"),
    AIGENTRY_SHIM_SCRIPT_DIR: bin,
    DISPATCH_STATE_DIR: path.join(root, "state", "dispatch"),
    HITL_STATE_DIR: path.join(root, "state", "hitl"),
    AIGENTRY_SESSIONS_ROOT: path.join(root, "sessions"),
    AIGENTRY_ROLE_SANDBOX_DIR: path.join(root, "role-sandbox"),
    AIGENTRY_WORKSPACE_HOST: "headless",
    AIGENTRY_BUS_BRIDGE: "0",
    DISPATCH_REGISTRY_PY: path.join(bin, "dispatch-registry.py"),
    SESSION_PROBE_PY: none, POLICY_PY: none,
    HITL_SH: none, TRACKER_SH: none, SCHEDULER_SH: none, COMMS_AUDITOR_SH: none,
    BRIDGE_AUDITOR_SH: none, BUS_BRIDGE_SH: none, CLEANUP_SH: none, DISPATCH_SH: none,
    TELEPTY: path.join(root, "absent-telepty"),
    RECONCILER_NOW: NOW,
    TRACKER_NOW: NOW,
  };
  return {
    root,
    storeRoot: path.join(root, "state", "controller-link"),
    peersFile: path.join(root, "state", "controller-peers.json"),
    env,
  };
}

const VALID_PEERS = JSON.stringify({ v: 1, self: { label: "mac", controller_sid: "orchestrator" },
  peers: { linux: { target: "orchestrator@linux-box", link: "v1" } } });

/** An empty, well-formed store (root 0700 + marker 0600), created by the U2 store itself. */
async function makeStore(root: string): Promise<void> {
  await new ControllerLinkStore({ root, clock: { nowMs: () => Date.parse(NOW) } }).withLock(async () => undefined);
}

/** Every path under `dir` with its bytes (directories as ""), for "nothing changed" checks. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    let es: fs.Dirent[];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out.set(`${p}/`, ""); walk(p); } else out.set(p, fs.readFileSync(p).toString("hex"));
    }
  };
  walk(dir);
  return out;
}

interface Tick { status: number | null; lines: string[]; stderr: string }

function tick(p: Pkg, args: string[] = ["--once"], extra: NodeJS.ProcessEnv = {}): Tick {
  const r = spawnSync(process.execPath, [RECONCILER, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...p.env, ...extra }, timeout: 120_000,
  });
  let log = "";
  try { log = fs.readFileSync(path.join(p.root, "state", "dispatch", "reconciler.log"), "utf8"); } catch { log = ""; }
  return { status: r.status, lines: log.split("\n").filter(Boolean), stderr: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const at = (lines: string[], re: RegExp): number => lines.findIndex((l) => re.test(l));
const ABORT_SWEEP = /abort sweep — bad telepty list$/;
const LINK_SUMMARY = /controller-link pump: records=0 sends=0 notices=0 /;

/** Nothing from or about step 0b4 reached the log or the tick's own output. */
function assertNoStep0b4(k: Tick): void {
  assert.equal(at(k.lines, /controller-link/), -1, `no controller-link line expected:\n${k.lines.join("\n")}`);
  assert.doesNotMatch(k.stderr, /controller-link/);
}

if (!WIN) {
  test("R1 step 0b4 runs the pump once per tick, after step 0b3, and the tick goes on to the steps after it", async (t) => {
    const p = pkg(t);
    fs.writeFileSync(p.peersFile, VALID_PEERS);
    await makeStore(p.storeRoot);
    const k = tick(p);
    assert.equal(k.status, 0, k.stderr);
    const reportPump = at(k.lines, /report-pump: rows=0 /);
    const link = at(k.lines, LINK_SUMMARY);
    assert.ok(reportPump >= 0, `step 0b3 ran:\n${k.lines.join("\n")}`);
    assert.ok(link > reportPump, `step 0b4 ran after step 0b3:\n${k.lines.join("\n")}`);
    assert.equal(k.lines.filter((l) => LINK_SUMMARY.test(l)).length, 1, "exactly one pump pass per tick");
    assert.ok(at(k.lines, ABORT_SWEEP) > link, "the steps after 0b4 still ran");
    assert.equal(at(k.lines, /ERR controller-link/), -1);
  });

  test("R1 AIGENTRY_CONTROLLER_LINK_PUMP=0: no pump process, no output, the store untouched; =1 runs it", async (t) => {
    const p = pkg(t);
    fs.writeFileSync(p.peersFile, VALID_PEERS);
    await makeStore(p.storeRoot);
    const before = snapshot(p.storeRoot);
    const off = tick(p, ["--once"], { AIGENTRY_CONTROLLER_LINK_PUMP: "0" });
    assert.equal(off.status, 0, off.stderr);
    // A spawned pump would print its own "disabled (AIGENTRY_CONTROLLER_LINK_PUMP=0)" line.
    assertNoStep0b4(off);
    assert.ok(at(off.lines, /report-pump: rows=0 /) >= 0, "the tick reached step 0b3 (control)");
    assert.ok(at(off.lines, ABORT_SWEEP) >= 0, "the tick reached step 2 (control)");
    assert.deepEqual(snapshot(p.storeRoot), before);
    const on = tick(p, ["--once"], { AIGENTRY_CONTROLLER_LINK_PUMP: "1" });
    assert.ok(at(on.lines, LINK_SUMMARY) >= 0, "causality control: the same tick with the switch on runs the pump");
  });

  test("R1 --dry-run: step 0b4 is skipped", async (t) => {
    const p = pkg(t);
    fs.writeFileSync(p.peersFile, VALID_PEERS);
    await makeStore(p.storeRoot);
    const before = snapshot(p.storeRoot);
    const k = tick(p, ["--once", "--dry-run"]);
    assert.equal(k.status, 0, k.stderr);
    assert.ok(at(k.lines, /registry tick: processed=0 act=1 dry_run=1$/) >= 0, `dry run in force:\n${k.lines.join("\n")}`);
    assert.ok(at(k.lines, ABORT_SWEEP) >= 0, "the tick reached step 2 (control)");
    assertNoStep0b4(k);
    assert.deepEqual(snapshot(p.storeRoot), before);
  });

  test("R1 HITL pause (a pending destructive gate): step 0b4 is skipped", async (t) => {
    const p = pkg(t);
    fs.writeFileSync(p.peersFile, VALID_PEERS);
    await makeStore(p.storeRoot);
    fs.mkdirSync(path.join(p.root, "state", "hitl", "pending"), { recursive: true });
    fs.writeFileSync(path.join(p.root, "state", "hitl", "pending", "g1.json"), JSON.stringify({ id: "g1", kind: "destructive" }));
    const before = snapshot(p.storeRoot);
    const k = tick(p);
    assert.equal(k.status, 0, k.stderr);
    assert.ok(at(k.lines, /HITL_PAUSE gate=g1 /) >= 0, `pause in force:\n${k.lines.join("\n")}`);
    assert.ok(at(k.lines, ABORT_SWEEP) >= 0, "the tick reached step 2 (control)");
    assertNoStep0b4(k);
    assert.deepEqual(snapshot(p.storeRoot), before);
  });

  test("R1 no store directory: no process, no file, no output; once the store exists the pump runs", async (t) => {
    const p = pkg(t);
    fs.writeFileSync(p.peersFile, VALID_PEERS);
    const stateBefore = snapshot(path.join(p.root, "state"));
    const k = tick(p);
    assert.equal(k.status, 0, k.stderr);
    assert.ok(at(k.lines, /report-pump: rows=0 /) >= 0, "the tick reached step 0b3 (control)");
    assert.ok(at(k.lines, ABORT_SWEEP) >= 0, "the tick reached step 2 (control)");
    assertNoStep0b4(k);
    assert.equal(fs.existsSync(p.storeRoot), false, "the tick did not create the store");
    // Outside the reconciler's own state/dispatch and state/hitl, nothing under state/ changed.
    const own = (k2: string): boolean => !k2.startsWith(path.join(p.root, "state", "dispatch")) &&
      !k2.startsWith(path.join(p.root, "state", "hitl"));
    const filt = (m: Map<string, string>): Array<[string, string]> => [...m].filter(([k2]) => own(k2)).sort();
    assert.deepEqual(filt(snapshot(path.join(p.root, "state"))), filt(stateBefore));
    await makeStore(p.storeRoot);
    assert.ok(at(tick(p).lines, LINK_SUMMARY) >= 0, "causality control: the same tick with a store runs the pump");
  });

  test("R1 AIGENTRY_CONTROLLER_LINK_DIR names the store: an absent override is skipped even if the default exists", async (t) => {
    const p = pkg(t);
    fs.writeFileSync(p.peersFile, VALID_PEERS);
    await makeStore(p.storeRoot); // the default location exists ...
    const override = path.join(p.root, "elsewhere", "controller-link"); // ... the configured one does not
    const k = tick(p, ["--once"], { AIGENTRY_CONTROLLER_LINK_DIR: override });
    assert.equal(k.status, 0, k.stderr);
    assertNoStep0b4(k);
    assert.equal(fs.existsSync(path.join(p.root, "elsewhere")), false);
    // The store creates only its own root (U2 privateDirectory: non-recursive mkdir), never a parent.
    fs.mkdirSync(path.dirname(override), { mode: 0o700 });
    await makeStore(override);
    const k2 = tick(p, ["--once"], { AIGENTRY_CONTROLLER_LINK_DIR: override });
    assert.ok(at(k2.lines, LINK_SUMMARY) >= 0, "the existing override store is pumped");
  });

  test("R1 a failing pump never fails the tick: its error is logged and the steps after it run", async (t) => {
    const p = pkg(t);
    await makeStore(p.storeRoot); // store present, peer list missing → the pump exits 9 PEER_CONFIG_INVALID
    const k = tick(p);
    assert.equal(k.status, 0, k.stderr);
    const child = at(k.lines, / controller-link: PEER_CONFIG_INVALID: /);
    const err = at(k.lines, /ERR controller-link pump non-zero \(continuing\)$/);
    assert.ok(child >= 0, `the pump's own error line is logged:\n${k.lines.join("\n")}`);
    assert.ok(err > child, "then the step's ERR line");
    assert.ok(at(k.lines, ABORT_SWEEP) > err, "and the tick went on to the steps after 0b4");
  });

  test("R1 an unusable AIGENTRY_CONTROLLER_LINK_DIR: no pump process, one ERR line, the tick goes on", (t) => {
    const p = pkg(t);
    fs.writeFileSync(p.peersFile, VALID_PEERS);
    const k = tick(p, ["--once"], { AIGENTRY_CONTROLLER_LINK_DIR: "relative/controller-link" });
    assert.equal(k.status, 0, k.stderr);
    const err = at(k.lines, /ERR controller-link pump: STORE_UNAVAILABLE: AIGENTRY_CONTROLLER_LINK_DIR .* \(continuing\)$/);
    assert.ok(err >= 0, `one ERR line:\n${k.lines.join("\n")}`);
    assert.equal(k.lines.filter((l) => /controller-link/.test(l)).length, 1, "nothing from a pump process");
    assert.ok(at(k.lines, ABORT_SWEEP) > err, "the tick went on");
  });
}

test("R1 step 0b4 is bounded like step 0b3: a 300 s kill on the pump child (source pin)", (t) => {
  // Behavioural timing of a 300 s kill is not measurable in a unit run; this pins the bound.
  const src = path.join(REPO_ROOT, "src", "reconciler", "cli.ts");
  if (!fs.existsSync(src)) { t.diagnostic("source tree not present next to dist; pin not applicable"); return; }
  const text = fs.readFileSync(src, "utf8");
  const start = text.indexOf("// --- step 0b4:");
  const end = text.indexOf("// --- step 0c:");
  assert.ok(start > 0 && end > start, "step 0b4 sits between step 0b3 and step 0c");
  assert.ok(text.indexOf("// --- step 0b3:") < start);
  const block = text.slice(start, end);
  assert.match(block, /"\.\.\/controller-link\/cli\.js", import\.meta\.url\)\), "pump", "--once"\]/);
  assert.match(block, /timeout: 300_000/);
  assert.match(block, /DRY_RUN === 0 && \(env\.AIGENTRY_CONTROLLER_LINK_PUMP \|\| "1"\) !== "0"/);
});

// ── R3 ──────────────────────────────────────────────────────────────────────────────────────────

interface Audit { status: number | null; stderr: string; tele: string; cursor: string; logSize: number }

function audit(t: TestContext, rows: Array<Record<string, unknown>>): Audit {
  const root = fs.mkdtempSync(path.join(tmpdir(), "reconciler-controller-link-r3-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(root, "peer-injects.jsonl");
  fs.writeFileSync(log, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  const comms = path.join(root, "session-comms");
  const env: NodeJS.ProcessEnv = { ...process.env, AIGENTRY_SHIM_SCRIPT_DIR: bin, SESSION_COMMS_DIR: comms,
    AIGENTRY_PEER_INJECT_LOG: log, AUDITOR_NOW: NOW, TELEPTY: path.join(root, "absent-telepty") };
  delete env.AIGENTRY_ORCHESTRATOR_SIDS; // the default controller sids: "orchestrator aigentry-orchestrator-claude"
  delete env.PEER_ROUND_CAP;
  const r = spawnSync(process.execPath, [AUDITOR], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 60_000 });
  const read = (f: string): string => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  return { status: r.status, stderr: `${r.stdout ?? ""}${r.stderr ?? ""}`, tele: read(path.join(comms, "telemetry.jsonl")),
    cursor: read(path.join(comms, ".audit-cursor")), logSize: fs.statSync(log).size };
}

const NOTICE = "⟦controller-link notice⟧ STALLED request_id=8a1b2c3d-1111-4222-8333-444455556666 role=sender peer=linux " +
  "state=stalled sender_task=1291 receiver_task=- n=1 — no answer\nnext: bin/controller-link.sh status --request 8a1b2c3d-1111-4222-8333-444455556666";

test("R3 the comms auditor does not flag controller-link → orchestrator (pump notices)", (t) => {
  const a = audit(t, [
    { ts: NOW, from: "controller-link", to: "orchestrator", body: NOTICE },
    { ts: NOW, from: "controller-link", to: "aigentry-orchestrator-claude", body: NOTICE },
  ]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.cursor, String(a.logSize), "the pass read both rows (cursor at end of log)");
  assert.doesNotMatch(a.tele, /controller-link/, `no telemetry for the controller lane:\n${a.tele}`);
  assert.doesNotMatch(a.stderr, /HOLD/);
});

test("R3 control: the same auditor DOES flag controller-link → a non-controller sid", (t) => {
  const a = audit(t, [{ ts: NOW, from: "controller-link", to: "coder-b", body: NOTICE }]);
  assert.match(a.tele, /"reason": ?"peer_inject_out_of_policy"/);
  assert.match(a.tele, /"from": ?"controller-link"/);
  // TELEPTY does not exist, so the HOLD it tried to raise is reported undelivered (exit 5).
  assert.equal(a.status, 5, a.stderr);
  assert.match(a.stderr, /HOLD UNDELIVERED .*from=controller-link to=coder-b/);
});
