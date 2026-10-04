// #1166 tester fixture: fake P6 startup roles for p6-startup-diagnostic.test.mjs (test-only).
// No addon, no lock. Mirrors fixtures/child.mjs "hold-spawn"/"grandchild" launch mechanics:
// same process.execPath, argv shape (<script> <role> <json>), default cwd/env and
// stdio:"inherit" for the grandchild. Variations are selected only from the fixed enums below.
// Every process writes a boot record to P6DIAG_TRACE_DIR/boot-<pid>.jsonl BEFORE parsing argv,
// so a parse failure still leaves evidence. All writes are synchronous appends to files: the
// diagnostic never depends on console output surviving a parent's exit.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TRACE_DIR = process.env.P6DIAG_TRACE_DIR;
const [role, rawArgs] = process.argv.slice(2);

function boot(obj) {
  if (!TRACE_DIR) return;
  appendFileSync(join(TRACE_DIR, `boot-${process.pid}.jsonl`), `${JSON.stringify({ ...obj, pid: process.pid, t: Date.now() })}\n`);
}

boot({ type: "boot", role, rawArgs, ppid: process.ppid, cwd: process.cwd(), argvLen: process.argv.length });

let args;
try {
  args = JSON.parse(rawArgs ?? "{}");
} catch (err) {
  boot({ type: "parse-error", message: String(err?.message ?? err) });
  process.exit(65);
}
boot({ type: "parsed", nonce: args.nonce });

const selfLimitMs = args.selfLimitMs ?? 15_000;

function emit(obj) {
  writeSync(1, `${JSON.stringify({ ...obj, pid: process.pid })}\n`);
}

// Fixed enums only: nothing from args is executed or used as a path except trace/channel files.
const PARENT_MODES = new Set(["exit-immediately", "wait-ready"]);
const STDIO = { inherit: "inherit", ignore: "ignore" };
const SCRIPTS = {
  self: () => fileURLToPath(import.meta.url),
  missing: () => join(fileURLToPath(new URL(".", import.meta.url)), "p6-diag-missing-does-not-exist.mjs"),
  "bad-syntax": () => join(TRACE_DIR, "p6-diag-bad-syntax.mjs"),
};
const GRAND_MODES = new Set(["normal", "no-ready", "early-exit", "throw", "vanish"]);
// Test-owned counterfactual only: absent (original, no detached key) or exactly true.
const DETACHED = { absent: undefined, true: true };

const roles = {
  // P6 parent shape: spawn the grandchild exactly like child.mjs "hold-spawn" (minus addon/lock),
  // await "spawn", emit "spawned", then either exit at once (original) or, in the labelled
  // "wait-ready" control, stay alive until the grandchild reports ready, exits, or waitMs passes.
  async "hold-spawn"() {
    const trace = (obj) => appendFileSync(args.parentTrace, `${JSON.stringify({ ...obj, nonce: args.nonce, pid: process.pid, t: Date.now() })}\n`);
    if (!PARENT_MODES.has(args.parentMode) || !STDIO[args.stdio] || !SCRIPTS[args.script] || !GRAND_MODES.has(args.grandMode)
      || (args.detached !== DETACHED.absent && args.detached !== DETACHED.true)) {
      trace({ type: "bad-config" });
      process.exit(64);
    }
    const grandJson = args.argvForm === "malformed"
      ? "{not json"
      : JSON.stringify({
        nonce: args.nonce, channel: args.channel, carrier: args.carrier, control: args.grandMode, selfLimitMs: args.grandLimitMs,
      });
    // Original cases keep the exact original options object (no detached key). Effective options are
    // traced verbatim; detached also changes console/process group, so it is a confound, not job proof.
    const spawnOptions = args.detached === DETACHED.true ? { stdio: STDIO[args.stdio], detached: true } : { stdio: STDIO[args.stdio] };
    trace({ type: "before-spawn", script: args.script, stdio: args.stdio, parentMode: args.parentMode, spawnOptions, detachedKeyPresent: "detached" in spawnOptions });
    const g = spawn(process.execPath, [SCRIPTS[args.script](), "grandchild", grandJson], spawnOptions);
    let gExit = null;
    g.once("exit", (code, signal) => {
      gExit = { code, signal };
      trace({ type: "gc-exit", code, signal });
    });
    g.once("error", (err) => trace({ type: "gc-error", code: err?.code, message: String(err?.message ?? err) }));
    await new Promise((resolve, reject) => {
      g.once("spawn", resolve);
      g.once("error", reject);
    });
    trace({ type: "after-spawn-event", gpid: g.pid });
    emit({ type: "spawned", gpid: g.pid, nonce: args.nonce });
    if (args.parentMode === "wait-ready") {
      const until = Date.now() + args.waitMs;
      const readySeen = () => {
        try {
          return readFileSync(args.channel, "utf8").split("\n").some((l) => l.includes('"type":"ready"') && l.includes(args.nonce));
        } catch {
          return false;
        }
      };
      while (!gExit && !readySeen() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      // Let an exit that races the ready line be observed through the owned handle.
      await new Promise((r) => setTimeout(r, 100));
      trace({ type: "wait-ended", readySeen: readySeen(), gExit });
    }
    trace({ type: "before-exit" });
    process.exit(0);
  },

  // Fake P6 grandchild: same channel protocol as child.mjs "grandchild" (ready, 50ms beats,
  // stop/teardown files holding the nonce) plus lifecycle records. Controls: "no-ready" never
  // reports ready, "early-exit" exits 3 before ready, "throw" throws before ready, "vanish"
  // ends itself abruptly (own pid only, no exit handler runs) right after ready, before any beat.
  async grandchild() {
    const note = (obj) => appendFileSync(args.channel, `${JSON.stringify({ ...obj, nonce: args.nonce, pid: process.pid, t: Date.now() })}\n`);
    process.on("exit", (code) => {
      try {
        note({ type: "process-exit", code });
      } catch {
        /* evidence only */
      }
    });
    note({ type: "main-start", ppid: process.ppid });
    try {
      if (args.control === "early-exit") process.exit(3);
      if (args.control === "throw") throw new Error("p6diag: deliberate throw before ready");
      if (args.control !== "no-ready") note({ type: "ready" });
      if (args.control === "vanish") process.kill(process.pid, "SIGKILL");
      let seq = 0;
      const how = await new Promise((resolve) => {
        const requested = (suffix) => {
          try {
            return readFileSync(`${args.channel}${suffix}`, "utf8") === args.nonce;
          } catch {
            return false;
          }
        };
        const beat = setInterval(() => {
          try {
            note({ type: "beat", seq: ++seq });
          } catch {
            /* a missed beat never counts as liveness */
          }
          if (requested(".stop")) {
            clearInterval(beat);
            resolve("exit");
          } else if (requested(".teardown")) {
            clearInterval(beat);
            resolve("teardown-exit");
          }
        }, 50);
      });
      note({ type: how, seq });
    } catch (err) {
      note({ type: "main-error", message: String(err?.message ?? err) });
      throw err;
    }
  },
};

const limitTimer = setTimeout(() => {
  boot({ type: "self-limit", role });
  if (role === "grandchild" && args.channel) {
    try {
      appendFileSync(args.channel, `${JSON.stringify({ type: "self-limit", nonce: args.nonce, pid: process.pid, t: Date.now() })}\n`);
    } catch {
      /* evidence only */
    }
  }
  process.exit(70);
}, selfLimitMs);

const fn = roles[role];
if (!fn) {
  boot({ type: "unknown-role" });
  process.exit(64);
}
boot({ type: "main-enter" });
try {
  await fn();
} catch (err) {
  boot({ type: "role-error", message: String(err?.message ?? err) });
  process.exitCode = 1;
}
clearTimeout(limitTimer);
