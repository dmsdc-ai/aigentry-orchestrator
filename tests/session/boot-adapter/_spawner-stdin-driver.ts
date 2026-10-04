// #1162 — isolated driver for spawner-stdin.test.ts. Runs ONE scenario against the
// real nodeSpawner() in its own process, so an unhandled stdin 'error' (the BP4
// EPIPE crash) kills this driver, never the test runner. Prints one JSON line and
// then lets the event loop drain naturally (no process.exit): any post-settlement
// pipe error therefore surfaces as a non-zero driver exit before the driver ends.
//
// argv: <scenario> <fixtureDir>. Children are fixture scripts only: /bin/sh shims
// resolved through PATH=<fixtureDir>/bin, or process.execPath + <fixtureDir>/*.cjs.
import net from "node:net";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeSpawner } from "../../../src/session/boot-adapter/spawner.js";

const [scenario = "", dir = ""] = process.argv.slice(2);
const BIG = 8 * 1024 * 1024; // far above any default pipe/socket buffer (mac 16-64 KiB, linux 64 KiB-1 MiB)
const WIN = process.platform === "win32";

// #1167 win32: the fixture twins do not close stdin while alive (see WIN_JS in the test), so
// the gate waits until every recorded child has terminated. This is weaker than the POSIX
// gate: it does not prove an independently closed read end in a live child, and it is
// unverified on Windows that termination observed here implies the pipe handle is closed.
function recordedChildrenGone(): boolean {
  const pids = readdirSync(join(dir, "pids")).map(Number);
  return pids.length > 0 && pids.every((pid) => {
    try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
  });
}

// Ordering gate (test instrumentation, not a product stub): the first write()/end()
// on a non-stdio socket blocks synchronously until <file> exists, then calls the
// real Node method unchanged. This makes "child already closed its read end before
// the parent writes" deterministic instead of a scheduling race.
function gateUntil(file: string): void {
  const proto = net.Socket.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const ow = proto["write"]!, oe = proto["end"]!;
  let armed = true;
  const wait = (self: unknown): void => {
    if (!armed || self === process.stdout || self === process.stderr) return;
    armed = false;
    const cell = new Int32Array(new SharedArrayBuffer(4));
    const until = Date.now() + 5_000;
    while (!existsSync(file) || (WIN && !recordedChildrenGone())) {
      if (Date.now() > until) throw Object.assign(new Error("GATE_TIMEOUT"), { code: "GATE_TIMEOUT" });
      Atomics.wait(cell, 0, 0, 2);
    }
  };
  proto["write"] = function (this: unknown, ...a: unknown[]) { wait(this); return ow.apply(this, a); };
  proto["end"] = function (this: unknown, ...a: unknown[]) { wait(this); return oe.apply(this, a); };
}

// After the first non-stdio socket write has been handed to the OS (writableLength 0
// = nothing left in Node's buffer), create <file>. Used to prove "OS accepted" only.
function signalAfterAccepted(file: string): void {
  const proto = net.Socket.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const ow = proto["write"]!;
  let armed = true;
  proto["write"] = function (this: net.Socket, ...a: unknown[]) {
    if (WIN && armed && this !== process.stdout && this !== process.stderr) {
      // #1167 win32 only (unverified assumption: a small pipe write may complete
      // asynchronously there, and 'drain' never fires below the high-water mark).
      // Signal once: when the OS has accepted synchronously (writableLength 0), or else
      // when the write's own callback reports success. An error never signals. The
      // original callback is invoked exactly once with its original arguments.
      armed = false;
      let signalled = false;
      const done = () => { if (!signalled) { signalled = true; writeFileSync(file, ""); } };
      const i = a.findIndex((x) => typeof x === "function");
      if (i >= 0) {
        const cb = a[i] as (...args: unknown[]) => unknown;
        a[i] = (...args: unknown[]) => { if (!args[0]) done(); return cb(...args); };
      }
      const r = ow.apply(this, a);
      if (this.writableLength === 0) done();
      return r;
    }
    const r = ow.apply(this, a);
    if (armed && this !== process.stdout && this !== process.stderr) {
      armed = false;
      const done = () => writeFileSync(file, "");
      if (this.writableLength === 0) done(); else this.once("drain", done);
    }
    return r;
  };
}

const sh = (name: string) => ({ argv: [name], env: { PATH: join(dir, "bin"), PIDDIR: join(dir, "pids"),
  MARK: join(dir, "mark"), GO: join(dir, "go") }, cwd: dir, prompt_file: "", expected_digest: "" });
const nodeChild = (script: string) => ({ ...sh(process.execPath), argv: [process.execPath, join(dir, script)] });
// #1167: on win32 the existing sh fixtures run as their process.execPath twins (same name + .cjs).
const shim = (name: string) => (WIN ? nodeChild(`${name}.cjs`) : sh(name));

const multi = "héllo-世界-\u{1F600}\n";
const scenarios: Record<string, () => { cmd: ReturnType<typeof sh>; stdin: string | undefined; timeout?: number; extra?: Record<string, unknown> }> = {
  "empty-eof-peer-closed": () => { gateUntil(join(dir, "mark")); return { cmd: shim("close-stdin-exit5"), stdin: "" }; },
  "empty-eof-natural": () => ({ cmd: shim("exit6"), stdin: "" }),
  "small-peer-closed": () => { gateUntil(join(dir, "mark")); return { cmd: shim("close-stdin-exit5"), stdin: "hello" }; },
  "large-read-end-closed": () => ({ cmd: shim("close-stdin-exit0"), stdin: "x".repeat(BIG) }),
  "echo-small": () => ({ cmd: nodeChild("echo.cjs"), stdin: multi }),
  "drain-large": () => {
    const payload = multi.repeat(Math.ceil(BIG / Buffer.byteLength(multi)));
    return { cmd: nodeChild("digest.cjs"), stdin: payload, extra: { bytes: Buffer.byteLength(payload) } };
  },
  "nonzero-exit": () => ({ cmd: nodeChild("digest-exit3.cjs"), stdin: "abc" }),
  "stdin-undefined": () => ({ cmd: shim("exit0"), stdin: undefined }),
  "stdin-undefined-not-ended": () => ({ cmd: nodeChild("wait-eof.cjs"), stdin: undefined, timeout: 1_000 }),
  "missing-exe-payload": () => ({ cmd: sh("aigentry-missing-exe-1162"), stdin: "payload" }),
  "missing-exe-empty": () => ({ cmd: sh("aigentry-missing-exe-1162"), stdin: "" }),
  "missing-exe-undefined": () => ({ cmd: sh("aigentry-missing-exe-1162"), stdin: undefined }),
  "timeout-pending-payload": () => ({ cmd: nodeChild("hang-noread.cjs"), stdin: "y".repeat(BIG), timeout: 1_000 }),
  "os-accepted-not-read": () => { signalAfterAccepted(join(dir, "go")); return { cmd: shim("wait-go-exit0"), stdin: "abc" }; },
};

const make = scenarios[scenario];
if (!make) { console.log(JSON.stringify({ scenario, outcome: "unknown-scenario" })); process.exitCode = 2; }
else {
  const { cmd, stdin, timeout, extra } = make();
  nodeSpawner().run(cmd, stdin, timeout ?? 5_000).then(
    (r) => console.log(JSON.stringify({ scenario, outcome: "resolved", result: r, extra })),
    (e: NodeJS.ErrnoException) => console.log(JSON.stringify({ scenario, outcome: "rejected", extra,
      error: { isError: e instanceof Error, code: e?.code, syscall: e?.syscall, errno: e?.errno, message: e?.message } })),
  );
}
