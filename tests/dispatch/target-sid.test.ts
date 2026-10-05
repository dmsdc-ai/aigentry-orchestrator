// #1171 WU-1 (Snyk #24/#25) — the dispatch CLI's two unvalidated sid paths now stop at
// assertConfinedTarget's identity guard, through the compiled production CLI.
//   (d) `--target <traversal>` with a self-consistent running chain planted where the sid
//       resolves exits 78 SANDBOX_TARGET_UNVERIFIED (SANDBOX_TARGET_SID), with no registry
//       write, no telemetry, no inject and no ref staged in the planted HOME.
//   (e) `--spawn-and-dispatch --track .. --name x --retry-unknown <r>` (plus name forms that
//       really leave the sessions root) on a held unknown row, registered and ready, exits 78
//       SANDBOX_REF_REFUSED (SANDBOX_TARGET_SID) and creates nothing outside the sessions root.
// POSIX and win32 separator forms run on every OS; each chain is planted with the fixture's
// prepareTarget at path.join(sessions, sid), i.e. where this OS would resolve the sid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fixture, REPO } from "./model-router-fixtures.js";

const REGISTRY = join(REPO, "bin/dispatch-registry.py");
const REASON = "reviewed: #1171 traversal sid regression";
type F = ReturnType<typeof fixture>;

/** Seeds a held delivery_state_unknown row for `sid` through the registry itself (the only writer). */
function seedUnknown(f: F, sid: string): void {
  const hash = createHash("sha256").update(readFileSync(f.ref)).digest("hex");
  const run = (args: string[]) => spawnSync("python3", [REGISTRY, ...args], { env: f.env, encoding: "utf8" });
  const begin = run(["begin-delivery", "--sid", sid, "--ref-hash", hash, "--ref-path", f.ref]);
  assert.equal(begin.status, 0, begin.stdout + begin.stderr);
  const set = run(["set-transport-result", "--sid", sid, "--result", "unknown"]);
  assert.equal(set.status, 0, set.stdout + set.stderr);
}

/** Every path under `dir` (recursive, sorted), skipping `except`. */
function tree(dir: string, except = ""): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).map((p) => join(dir, p))
    .filter((p) => !except || (p !== except && !p.startsWith(except + sep))).sort();
}

const shared = (f: F, sid: string) => join(f.env.AIGENTRY_SESSIONS_ROOT!, sid, "fixture-home", ".telepty", "shared");
const telemetry = (f: F) => existsSync(f.env.TELEMETRY_LOG!) ? readFileSync(f.env.TELEMETRY_LOG!, "utf8") : "";

for (const sid of ["../evil", "..\\evil"]) {
  test(`(d) dispatch --target ${JSON.stringify(sid)} exits 78 SANDBOX_TARGET_UNVERIFIED before any read or effect`, () => {
    const f = fixture();
    try {
      f.prepareTarget(sid);
      const registry = readFileSync(join(f.root, "state/active.json"), "utf8");
      const r = f.dispatch(["--target", sid]);
      assert.equal(r.status, 78, r.stderr);
      assert.ok(r.stderr.split("\n").includes(
        "dispatch.sh: SANDBOX_TARGET_UNVERIFIED: Error: SANDBOX_TARGET_SID; preserve artifacts and respawn"), r.stderr);
      assert.equal(existsSync(f.env.PARENT_MODEL_LOG!), false, "no inject");
      assert.equal(telemetry(f), "", "refused before dispatch_start");
      assert.equal(readFileSync(join(f.root, "state/active.json"), "utf8"), registry, "no registry write");
      assert.deepEqual(readdirSync(shared(f, sid)), [], "no ref staged in the planted HOME");
      // Control: the same fixture chain under a valid sid passes the target check and dispatches.
      f.prepareTarget();
      const ok = f.dispatch(["--target", "router-fixture"]);
      assert.equal(ok.status, 0, ok.stderr);
    } finally { f.cleanup(); }
  });
}

// [track, name]: the literal triage form, then names whose sid leaves the sessions root on POSIX / win32.
for (const [track, name] of [["..", "x"], ["x", "/../../evil"], ["x", "\\..\\..\\evil"]] as const) {
  const sid = `${track}-${name}`;
  test(`(e) --spawn-and-dispatch --track ${JSON.stringify(track)} --name ${JSON.stringify(name)} --retry-unknown exits 78 and creates nothing outside the sessions root`, () => {
    const f = fixture();
    try {
      seedUnknown(f, sid);
      f.prepareTarget(sid);
      const sessions = f.env.AIGENTRY_SESSIONS_ROOT!;
      const outside = tree(f.aig, sessions), planted = tree(join(sessions, sid));
      const registry = readFileSync(join(f.root, "state/active.json"), "utf8");
      const r = f.dispatch(["--spawn-and-dispatch", "--track", track, "--name", name, "--cwd", join(f.root, "project"),
        "--retry-unknown", REASON], { LIVE_SESSIONS: JSON.stringify([{ id: sid, command: "codex" }]) });
      assert.equal(r.status, 78, r.stderr);
      assert.ok(r.stderr.split("\n").includes("dispatch.sh: SANDBOX_REF_REFUSED: Error: SANDBOX_TARGET_SID"), r.stderr);
      assert.equal(existsSync(f.env.OPEN_LOG!), false, "a retry never opens a workspace");
      assert.equal(existsSync(f.env.PARENT_MODEL_LOG!), false, "no inject");
      assert.equal(readFileSync(join(f.root, "state/active.json"), "utf8"), registry, "no begin-delivery write");
      assert.deepEqual(readdirSync(shared(f, sid)), [], "no ref staged in the planted HOME");
      assert.deepEqual(tree(join(sessions, sid)), planted, "the planted chain is unchanged");
      assert.deepEqual(tree(f.aig, sessions), outside, "nothing created outside the sessions root");
    } finally { f.cleanup(); }
  });
}
