// #1167 — isolated driver for spawner-lifecycle.test.ts. Runs ONE scenario against the
// real nodeSpawner() in its own process and prints one JSON line.
//
// Ownership is proven by the parent handle, never by pid scanning: ChildProcess.prototype
// .spawn is wrapped (instrumentation only, behaviour unchanged) so every child the
// spawner creates is recorded with its pid and its 'exit' event as observed by this,
// its real parent. No pid is ever signalled. Liveness is bounded by the fixture: every
// child self-exits after LIFETIME_MS (> 5 s product bound, < 8 s outer watchdog). Only
// if a child outlives the driver's hard deadline is it killed, through its own handle,
// and that is recorded as harness_kill (a test failure).
//
// argv: <scenario> <fixtureDir> <hardDeadlineMs> [noinstr]. "noinstr" disables the spawn
// spy so the test can prove the spy forwards spawn unchanged (LV0).
import { ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { nodeSpawner } from "../../../src/session/boot-adapter/spawner.js";

const [scenario = "", dir = "", deadlineArg = "7500", mode = ""] = process.argv.slice(2);
const HARD_DEADLINE = Number(deadlineArg);

// HARNESS INSTRUMENTATION (not product behaviour): records the spawned child handle and
// its exit; forwards the original spawn call and return value unchanged.
interface Handle { pid: number | undefined; spawned_at: number; exit: { code: number | null; signal: string | null; at: number } | null; harness_kill: boolean }
const handles: Array<{ h: Handle; c: ChildProcess }> = [];
const proto = ChildProcess.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const origSpawn = proto["spawn"]!;
if (mode !== "noinstr") proto["spawn"] = function (this: ChildProcess, ...a: unknown[]) {
  const r = origSpawn.apply(this, a);
  const h: Handle = { pid: this.pid, spawned_at: Date.now(), exit: null, harness_kill: false };
  this.once("exit", (code, signal) => { h.exit = { code, signal, at: Date.now() }; });
  handles.push({ h, c: this });
  return r;
};

const sum = (s: string) => ({ len: s.length, sha256: createHash("sha256").update(s).digest("hex"), head: s.slice(0, 200) });
const ser = (e: NodeJS.ErrnoException) => ({ isError: e instanceof Error, code: e?.code, errno: e?.errno,
  syscall: e?.syscall, message: String(e?.message).slice(0, 200) });

// Raw node:child_process observation of the same executable, for errno comparison.
// spawn() reports EACCES/EAGAIN/EMFILE/ENFILE/ENOENT via 'error' and THROWS every other
// OS error synchronously (win32 non-PE image: "spawn UNKNOWN"); both are a failed raw spawn.
function rawSpawn(exe: string): Promise<Record<string, unknown>> {
  return new Promise((res) => {
    let c: ChildProcess;
    try { c = spawn(exe, [], { shell: false }); } catch (e) { return res({ spawned: false, thrown: true, error: ser(e as NodeJS.ErrnoException) }); }
    c.on("error", (e) => res({ spawned: false, error: ser(e) }));
    c.on("spawn", () => { c.kill("SIGKILL"); res({ spawned: true }); });
  });
}

const bin = (n: string) => join(dir, "bin", n);
const cmd = (argv: string[]) => ({ argv, env: {}, cwd: dir, prompt_file: "", expected_digest: "" });
const nodeChild = (script: string) => cmd([process.execPath, join(dir, script)]);
const echoCmd = () => ({ ...cmd([process.execPath, join(dir, "echo-args.cjs"), "a b", "--x=1"]), env: { SPY_MARKER: "m-1167" } });

const sp = nodeSpawner();
const withRaw = async (exe: string) => {
  const raw = await rawSpawn(exe);
  try { return { raw, value: await sp.run(cmd([exe])) }; }
  catch (e) { throw Object.assign(e as object, { raw }); }
};
const scenarios: Record<string, () => Promise<{ value: unknown; raw?: unknown }>> = {
  "probe-hang": async () => ({ value: await sp.probeVersion(bin("hang")) }),
  "probe-semver": async () => ({ value: await sp.probeVersion(bin("semver")) }),
  "probe-nonzero": async () => ({ value: await sp.probeVersion(bin("version-exit2")) }),
  "probe-missing": async () => ({ value: await sp.probeVersion(bin("aigentry-missing-exe-1167")) }),
  "probe-nonexec": async () => ({ value: await sp.probeVersion(bin("nonexec")) }),
  "probe-flood-over": async () => ({ value: await sp.probeVersion(bin("flood-over")) }),
  "probe-flood-under": async () => ({ value: await sp.probeVersion(bin("flood-under")) }),
  "probe-exact-1mib": async () => ({ value: await sp.probeVersion(bin("exact")) }),
  "probe-1mib-plus1": async () => ({ value: await sp.probeVersion(bin("exact-plus1")) }),
  "probe-multibyte": async () => ({ value: await sp.probeVersion(bin("multibyte")) }),
  "probe-sigterm-ignored": async () => ({ value: await sp.probeVersion(bin("sigterm")) }),
  "probe-alternate-hang": async () => ({ value: await sp.probeVersion(bin("alternate-hang")) }),
  "run-echo": async () => ({ value: await sp.run(echoCmd()) }),
  "run-nonexec": () => withRaw(bin("nonexec")),
  "run-missing": () => withRaw(bin("aigentry-missing-exe-1167")),
  "run-nonzero": async () => ({ value: await sp.run(nodeChild("out-exit4.cjs")) }),
  "run-flood": async () => ({ value: await sp.run(nodeChild("flood-run.cjs")) }),
};

const make = scenarios[scenario];
if (!make) { console.log(JSON.stringify({ scenario, outcome: "unknown-scenario" })); process.exitCode = 2; }
else {
  const t0 = Date.now();
  let settled: Record<string, unknown> | undefined;
  const settle = (o: Record<string, unknown>) => { if (!settled) settled = { ...o, settled_at: Date.now(), elapsed_ms: Date.now() - t0 }; };
  make().then(
    (r) => {
      const v = r.value as Record<string, unknown> | string;
      settle({ outcome: "resolved", raw: r.raw, value: typeof v === "string" ? sum(v)
        : { exit_code: v["exit_code"], stdout: sum(String(v["stdout"])), stderr: sum(String(v["stderr"])) } });
    },
    (e: NodeJS.ErrnoException & { raw?: unknown }) => settle({ outcome: "rejected", error: ser(e), raw: e?.raw }),
  );
  const live = () => handles.filter(({ h }) => h.pid !== undefined && h.exit === null);
  let killedAt = 0;
  // Wait for settlement AND every child's exit as seen by its handle (the test judges
  // how long after settlement that was). Children self-exit, so this normally ends well
  // before the hard deadline even when the product hangs.
  const poll = setInterval(() => {
    const now = Date.now();
    if (settled && live().length === 0) return emit(false);
    if (now - t0 < HARD_DEADLINE) return;
    // Hard deadline: report pending if unsettled; kill any surviving child via its own handle.
    if (!killedAt) { killedAt = now; for (const { h, c } of live()) { h.harness_kill = true; c.kill("SIGKILL"); } }
    if (live().length === 0 || now - killedAt > 300) emit(!settled);
  }, 20);
  function emit(pending: boolean): void {
    clearInterval(poll);
    console.log(JSON.stringify({ scenario, driver_pid: process.pid, t0,
      ...(pending ? { outcome: "pending", elapsed_ms: Date.now() - t0 } : settled),
      handles: handles.map(({ h }) => h) }));
    if (pending) process.exit(0); // product promise still pending; all handles already exited/killed
  }
}
