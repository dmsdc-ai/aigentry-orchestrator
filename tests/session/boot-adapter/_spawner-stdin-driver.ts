// #1162 — isolated driver for spawner-stdin.test.ts. Runs ONE scenario against the
// real nodeSpawner() in its own process, so an unhandled stdin 'error' (the BP4
// EPIPE crash) kills this driver, never the test runner. Prints one JSON line and
// then lets the event loop drain naturally (no process.exit): any post-settlement
// pipe error therefore surfaces as a non-zero driver exit before the driver ends.
//
// argv: <scenario> <fixtureDir>. Children are fixture scripts only: /bin/sh shims
// resolved through PATH=<fixtureDir>/bin, or process.execPath + <fixtureDir>/*.cjs.
import net from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeSpawner } from "../../../src/session/boot-adapter/spawner.js";

const [scenario = "", dir = ""] = process.argv.slice(2);
const BIG = 8 * 1024 * 1024; // far above any default pipe/socket buffer (mac 16-64 KiB, linux 64 KiB-1 MiB)

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
    while (!existsSync(file)) {
      if (Date.now() > until) throw Object.assign(new Error("GATE_TIMEOUT"), { code: "GATE_TIMEOUT" });
      Atomics.wait(cell, 0, 0, 2);
    }
  };
  proto["write"] = function (this: unknown, ...a: unknown[]) { wait(this); return ow.apply(this, a); };
  proto["end"] = function (this: unknown, ...a: unknown[]) { wait(this); return oe.apply(this, a); };
}

// After the first non-stdio socket write has been handed to the OS (writableLength 0
// = nothing left in Node's buffer), create <file>. Used to prove "OS accepted" only.
// win32 pipe writes complete asynchronously and a small write never emits 'drain', so
// there the signal is that write's own completion callback; note.go records which path ran.
function signalAfterAccepted(file: string, note: Record<string, unknown>): void {
  const proto = net.Socket.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const ow = proto["write"]!;
  let armed = true;
  proto["write"] = function (this: net.Socket, ...a: unknown[]) {
    if (!armed || this === process.stdout || this === process.stderr) return ow.apply(this, a);
    armed = false;
    let signalled = false;
    const done = (how: string) => { if (signalled) return; signalled = true; note["go"] = how; writeFileSync(file, ""); };
    const cb = typeof a[a.length - 1] === "function" ? a.pop() as (e?: Error | null) => void : undefined;
    a.push((e?: Error | null) => {
      done(e ? `write-cb-error:${(e as NodeJS.ErrnoException).code}` : "write-cb");
      cb?.(e);
    });
    const r = ow.apply(this, a);
    if (this.writableLength === 0) done("sync");
    return r;
  };
}

const sh = (name: string) => ({ argv: [name], env: { PATH: join(dir, "bin"), PIDDIR: join(dir, "pids"),
  MARK: join(dir, "mark"), GO: join(dir, "go") }, cwd: dir, prompt_file: "", expected_digest: "" });
const nodeChild = (script: string) => ({ ...sh(process.execPath), argv: [process.execPath, join(dir, script)] });

const multi = "héllo-世界-\u{1F600}\n";
const scenarios: Record<string, () => { cmd: ReturnType<typeof sh>; stdin: string | undefined; timeout?: number; extra?: Record<string, unknown> }> = {
  "empty-eof-peer-closed": () => { gateUntil(join(dir, "mark")); return { cmd: sh("close-stdin-exit5"), stdin: "" }; },
  "empty-eof-natural": () => ({ cmd: sh("exit6"), stdin: "" }),
  "small-peer-closed": () => { gateUntil(join(dir, "mark")); return { cmd: sh("close-stdin-exit5"), stdin: "hello" }; },
  "large-read-end-closed": () => ({ cmd: sh("close-stdin-exit0"), stdin: "x".repeat(BIG) }),
  "echo-small": () => ({ cmd: nodeChild("echo.cjs"), stdin: multi }),
  "drain-large": () => {
    const payload = multi.repeat(Math.ceil(BIG / Buffer.byteLength(multi)));
    return { cmd: nodeChild("digest.cjs"), stdin: payload, extra: { bytes: Buffer.byteLength(payload) } };
  },
  "nonzero-exit": () => ({ cmd: nodeChild("digest-exit3.cjs"), stdin: "abc" }),
  "stdin-undefined": () => ({ cmd: sh("exit0"), stdin: undefined }),
  "stdin-undefined-not-ended": () => ({ cmd: nodeChild("wait-eof.cjs"), stdin: undefined, timeout: 1_000 }),
  "missing-exe-payload": () => ({ cmd: sh("aigentry-missing-exe-1162"), stdin: "payload" }),
  "missing-exe-empty": () => ({ cmd: sh("aigentry-missing-exe-1162"), stdin: "" }),
  "missing-exe-undefined": () => ({ cmd: sh("aigentry-missing-exe-1162"), stdin: undefined }),
  "timeout-pending-payload": () => ({ cmd: nodeChild("hang-noread.cjs"), stdin: "y".repeat(BIG), timeout: 1_000 }),
  "os-accepted-not-read": () => {
    const note: Record<string, unknown> = {};
    signalAfterAccepted(join(dir, "go"), note);
    return { cmd: sh("wait-go-exit0"), stdin: "abc", extra: note };
  },
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
