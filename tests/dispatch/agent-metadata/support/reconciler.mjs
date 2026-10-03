// Hermetic runner for the REAL compiled reconciler (dist/src/reconciler/cli.js) with
// every subprocess seam pointed at support/g3-fakes.mjs recorders. Frozen clock via
// RECONCILER_NOW (the existing harness's seam). No live telepty/cmux/registry.
// `prepare(run, sessionsRoot)` shapes the REAL filesystem under the sessions root
// before the tick (stage-inspection cases).
import * as fs from "node:fs";
import * as path from "node:path";

import { DIST, HERE, hermeticEnv, makeRun, sealedFixture, sh } from "./harness.mjs";

export const NOW = "2026-09-28T12:00:00Z";
export const NOW_EPOCH = Date.parse(NOW) / 1000;
const FAKES = path.join(HERE, "g3-fakes.mjs");

/**
 * scenario: { sessions:[telepty rows], live:[{sid,state}], probe:{sid:json},
 *             capsRc, setRc:{sid:rc|[rc…]}, sealed:[sid] }
 */
export function runReconciler(label, scenario, { args = ["--once"], prepare } = {}) {
  const run = makeRun(label);
  const bin = path.join(run.dir, "bin");
  fs.mkdirSync(path.join(bin, "lib"), { recursive: true });
  for (const name of ["wh-cli.sh", "dispatch-registry.py", "session-probe.py", "policy.py", "telepty"]) {
    fs.symlinkSync(FAKES, path.join(bin, name));
  }
  fs.writeFileSync(path.join(bin, "lib", "platform.sh"),
    "platform::host_power_state() { echo awake; }\nplatform::lid_closed() { return 1; }\nplatform::session_pid() { echo ''; }\n");
  fs.writeFileSync(path.join(bin, "lib", "telepty-listing.sh"),
    "telepty_listing_trusted() { return 0; }\ntelepty_sid_live() { return 0; }\n");
  const sessionsRoot = path.join(run.dir, "sessions");
  fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  const fixtures = {};
  for (const sid of scenario.sealed ?? []) {
    fixtures[sid] = sealedFixture(run, { sid, stage: path.join(sessionsRoot, sid) });
  }
  if (prepare) prepare(run, sessionsRoot);
  const scen = path.join(run.dir, "g3-scenario.json");
  fs.writeFileSync(scen, JSON.stringify(scenario));
  const log = path.join(run.logs, "g3.jsonl");
  fs.writeFileSync(log, "");
  const none = path.join(run.dir, "absent-helper");
  const env = hermeticEnv(run, {
    AIGENTRY_SHIM_SCRIPT_DIR: bin,
    DISPATCH_STATE_DIR: path.join(run.dir, "state"),
    HITL_STATE_DIR: path.join(run.dir, "hitl"),
    AIGENTRY_SESSIONS_ROOT: sessionsRoot,
    AIGENTRY_ROLE_SANDBOX_DIR: path.join(run.dir, "role-sandbox"),
    DISPATCH_REGISTRY_PY: path.join(bin, "dispatch-registry.py"),
    SESSION_PROBE_PY: path.join(bin, "session-probe.py"),
    POLICY_PY: path.join(bin, "policy.py"),
    TELEPTY: path.join(bin, "telepty"),
    HITL_SH: none, TRACKER_SH: none, SCHEDULER_SH: none, COMMS_AUDITOR_SH: none,
    BRIDGE_AUDITOR_SH: none, BUS_BRIDGE_SH: none, CLEANUP_SH: none, DISPATCH_SH: none,
    RECONCILER_NOW: NOW,
    G3_SCENARIO: scen,
    G3_LOG: log,
  });
  const r = sh(process.execPath, [path.join(DIST, "src/reconciler/cli.js"), ...args], { env, timeout: 60000 });
  // restore permissions so the run dir stays removable
  try { for (const e of fs.readdirSync(sessionsRoot)) fs.chmodSync(path.join(sessionsRoot, e), 0o700); } catch { /* best effort */ }
  const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { run, r, calls, fixtures, sessionsRoot, tripwire: run.tripwireHits() };
}

export const whCalls = (calls, verb) => calls.filter((c) => c.role === "wh-cli.sh" && (!verb || c.argv[0] === verb));
