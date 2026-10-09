// #1162 — nodeSpawner().run stdin pipe behaviour (EPIPE / peer-closed / delivery).
// Every scenario runs the REAL nodeSpawner inside an isolated driver subprocess
// (_spawner-stdin-driver.js), so a regression that crashes on an unhandled stdin
// 'error' fails the test instead of killing the runner. Hermetic: children are
// fixture /bin/sh shims (PATH = fixture bin dir only, shell builtins only; win32: see CJS) or
// process.execPath + fixture scripts; fake HOME; every child pid is checked dead.
//
// Honest labelling: "delivered" below means the OS pipe accepted the bytes. Only the
// echo/drain scenarios prove the child application actually read them.
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contractBytes } from "./_win-launch-fixture.js";

const DRIVER = join(import.meta.dirname, "_spawner-stdin-driver.js");
const WIN = process.platform === "win32";
const PEER_CLOSED = ["EPIPE", "ECONNRESET"];
// win32 (measured): a write to a gone reader can also fail with EOF (-4095); accepted only from write().
const PEER_CLOSED_WIN = [...PEER_CLOSED, "EOF"];
const MULTI = "héllo-世界-\u{1F600}\n";
// #1195 win32 (measured): unlinking bin/node.exe right after its child exited failed EBUSY; the image lock can
// outlive the process, so fixture removal gets rmSync's bounded EBUSY/EPERM retry (linear 100 ms, 10 tries).
const RM = { recursive: true, force: true, ...(WIN ? { maxRetries: 10, retryDelay: 100 } : {}) } as const;

const SH: Record<string, string> = {
  "close-stdin-exit5": `: > "$PIDDIR/$$"\nexec 0<&-\n: > "$MARK"\nexit 5\n`,
  "close-stdin-exit0": `: > "$PIDDIR/$$"\nexec 0<&-\nexit 0\n`,
  "exit6": `: > "$PIDDIR/$$"\nexit 6\n`,
  "exit0": `: > "$PIDDIR/$$"\nexit 0\n`,
  "wait-go-exit0": `: > "$PIDDIR/$$"\nwhile [ ! -e "$GO" ]; do :; done\nexit 0\n`,
};
const PID = `require("node:fs").writeFileSync(require("node:path").join(process.env.PIDDIR, String(process.pid)), "");\n`;
const READ_ALL = `const chunks = []; process.stdin.on("data", (c) => chunks.push(c)); process.stdin.on("end", () => { const b = Buffer.concat(chunks);\n`;
const JS: Record<string, string> = {
  "echo.cjs": `${PID}${READ_ALL} process.stdout.write(b); });\n`,
  "digest.cjs": `${PID}${READ_ALL} process.stdout.write(JSON.stringify({ len: b.length, sha256: require("node:crypto").createHash("sha256").update(b).digest("hex") })); });\n`,
  "digest-exit3.cjs": `${PID}${READ_ALL} process.stdout.write(JSON.stringify({ len: b.length })); process.stderr.write("err3"); process.exitCode = 3; });\n`,
  "wait-eof.cjs": `${PID}process.stdin.on("end", () => process.exit(7)); process.stdin.resume();\n`,
  "hang-noread.cjs": `${PID}setInterval(() => {}, 1000);\n`,
};
// #1167 P5 (win32): no /bin/sh. Each SH scenario is the same pid-file / MARK / GO / close / exit behaviour in
// Node (`bin/<name>.cjs`) behind a real npm-style V-A `bin/<name>.cmd` (P=node), which the spawner launches as
// a direct `node.exe <name>.cjs` child. The driver pins PATH to bin, so that node is the shim's `dp0\node.exe`.
const CJS: Record<string, string> = {
  "close-stdin-exit5": `${PID}process.stdin.destroy();\nrequire("node:fs").writeFileSync(process.env.MARK, "");\nprocess.exit(5);\n`,
  "close-stdin-exit0": `${PID}process.stdin.destroy();\nprocess.exit(0);\n`,
  "exit6": `${PID}process.exit(6);\n`,
  "exit0": `${PID}process.exit(0);\n`,
  "wait-go-exit0": `${PID}const cell = new Int32Array(new SharedArrayBuffer(4)), until = Date.now() + 15_000;\n` +
    `while (!require("node:fs").existsSync(process.env.GO)) { if (Date.now() > until) process.exit(98); Atomics.wait(cell, 0, 0, 2); }\nprocess.exit(0);\n`,
};

// win32: one copy of this node.exe per test file; each fixture bin gets a hard link to it (a copy if linking fails).
let nodeCopy: string | undefined;
function stageNode(to: string): void {
  if (nodeCopy === undefined) {
    nodeCopy = join(mkdtempSync(join(tmpdir(), "ss-1167-node-")), "node.exe");
    copyFileSync(process.execPath, nodeCopy);
  }
  try { linkSync(nodeCopy, to); } catch { copyFileSync(process.execPath, to); }
}
after(() => { if (nodeCopy !== undefined) rmSync(dirname(nodeCopy), RM); });

interface DriverOut {
  scenario: string; outcome: "resolved" | "rejected" | "unknown-scenario";
  result?: { stdout: string; stderr: string; exit_code: number; duration_ms: number };
  error?: { isError: boolean; code?: string; syscall?: string; message?: string };
  extra?: Record<string, unknown>;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function drive(t: TestContext, scenario: string): DriverOut {
  const root = mkdtempSync(join(tmpdir(), "ss-1162-"));
  try {
    for (const d of ["bin", "pids", "home"]) mkdirSync(join(root, d));
    if (WIN) {
      stageNode(join(root, "bin", "node.exe"));
      for (const [n, body] of Object.entries(CJS)) {
        writeFileSync(join(root, "bin", `${n}.cjs`), body);
        writeFileSync(join(root, "bin", `${n}.cmd`), contractBytes("V-A", `${n}.cjs`, "node", ""), "latin1");
      }
    } else for (const [n, body] of Object.entries(SH)) writeFileSync(join(root, "bin", n), `#!/bin/sh\n${body}`, { mode: 0o755 });
    for (const [n, body] of Object.entries(JS)) writeFileSync(join(root, n), body);
    const r = spawnSync(process.execPath, [DRIVER, scenario, root], {
      env: { PATH: join(root, "bin"), HOME: join(root, "home"), TMPDIR: tmpdir() },
      encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    const leftover = readdirSync(join(root, "pids")).map(Number).filter(isAlive);
    for (const pid of leftover) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    // #1195: wait (bounded, no throw) for what was just killed, so the leftover assertion below is not masked by an
    // EBUSY from removing a still-running image in finally.
    const tick = new Int32Array(new SharedArrayBuffer(4)), until = Date.now() + 15_000;
    while (leftover.some(isAlive) && Date.now() < until) Atomics.wait(tick, 0, 0, 50);
    assert.equal(r.error, undefined, `driver did not finish (hang?): ${String(r.error)}`);
    assert.equal(r.signal, null, `driver killed by ${r.signal}`);
    assert.equal(r.status, 0, `driver (parent of the child) crashed: exit ${r.status} stderr=${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Unhandled 'error' event/);
    assert.deepEqual(leftover, [], "fixture children still alive after run() settled");
    const out = JSON.parse(r.stdout.trim()) as DriverOut;
    assert.equal(out.scenario, scenario);
    t.diagnostic(`driver: ${JSON.stringify(out.error ?? out.result)}`);
    return out;
  } finally {
    rmSync(root, RM);
  }
}

function resolved(o: DriverOut, exit_code: number): NonNullable<DriverOut["result"]> {
  assert.equal(o.outcome, "resolved", `expected resolve, got ${JSON.stringify(o.error)}`);
  assert.equal(o.result!.exit_code, exit_code);
  assert.equal(typeof o.result!.duration_ms, "number");
  return o.result!;
}

function rejected(o: DriverOut, codes: readonly string[]): NonNullable<DriverOut["error"]> {
  assert.equal(o.outcome, "rejected", `false success: ${JSON.stringify(o.result)}`);
  assert.equal(o.error!.isError, true);
  assert.ok(codes.includes(o.error!.code ?? ""), `code ${o.error!.code} not in ${codes.join("/")}`);
  return o.error!;
}

test("SS1 empty stdin, child closed its read end first (gated): EOF-only, resolves real exit 5", (t) => {
  const r = resolved(drive(t, "empty-eof-peer-closed"), 5);
  assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
});

test("SS2 empty stdin, child exits immediately (natural race, BP4 shape): resolves real exit 6", (t) => {
  resolved(drive(t, "empty-eof-natural"), 6);
});

test("SS3 non-empty stdin, child closed its read end first (gated): rejects with the actual peer-closed error", (t) => {
  const o = drive(t, "small-peer-closed");
  // win32 (SS3 decision): the deterministic rejection does not exist there (a 5-byte write to a gone reader was
  // accepted in 14 of 1000 measured runs), so either real outcome passes; drive() already proved no crash and
  // no leftover child.
  if (WIN && o.outcome === "resolved") {
    const r = resolved(o, 5);
    assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
    return;
  }
  const e = rejected(o, WIN ? PEER_CLOSED_WIN : PEER_CLOSED);
  if (WIN) assert.equal(e.syscall, "write");
  assert.notEqual(e.code, "ENOENT");
});

test("SS4 8 MiB stdin > pipe buffer, child closes stdin unread and exits 0: rejects, never false success", (t) => {
  const e = rejected(drive(t, "large-read-end-closed"), WIN ? PEER_CLOSED_WIN : PEER_CLOSED);
  if (WIN) assert.equal(e.syscall, "write");
});

test("SS5 echo child: bytes (multi-byte UTF-8) read back unchanged", (t) => {
  const r = resolved(drive(t, "echo-small"), 0);
  assert.equal(r.stdout, MULTI); assert.equal(r.stderr, "");
});

test("SS6 8 MiB drain: child application read every byte (length + sha256)", (t) => {
  const o = drive(t, "drain-large");
  const r = resolved(o, 0);
  const bytes = o.extra!["bytes"] as number;
  const payload = MULTI.repeat(Math.ceil(8 * 1024 * 1024 / Buffer.byteLength(MULTI)));
  assert.equal(Buffer.byteLength(payload), bytes);
  assert.deepEqual(JSON.parse(r.stdout), { len: bytes, sha256: createHash("sha256").update(payload).digest("hex") });
});

test("SS7 non-zero exit after reading stdin: resolves exit 3 with stdout/stderr", (t) => {
  const r = resolved(drive(t, "nonzero-exit"), 3);
  assert.deepEqual(JSON.parse(r.stdout), { len: 3 }); assert.equal(r.stderr, "err3");
});

test("SS8 stdin undefined: nothing written, resolves", (t) => {
  resolved(drive(t, "stdin-undefined"), 0);
});

test("SS9 stdin undefined: pipe is not ended (child waiting for EOF times out, is killed)", (t) => {
  const e = rejected(drive(t, "stdin-undefined-not-ended"), ["ETIMEDOUT"]);
  assert.equal(e.message, "BOOT_TIMEOUT");
});

for (const [n, s] of [["10a", "missing-exe-payload"], ["10b", "missing-exe-empty"], ["10c", "missing-exe-undefined"]] as const) {
  test(`SS${n} missing executable (${s}): rejects ENOENT, parent survives`, (t) => {
    rejected(drive(t, s), ["ENOENT"]);
  });
}

test("SS11 timeout with 8 MiB pending: rejects ETIMEDOUT, child killed, later pipe error does not crash", (t) => {
  const e = rejected(drive(t, "timeout-pending-payload"), ["ETIMEDOUT"]);
  assert.equal(e.message, "BOOT_TIMEOUT");
});

test("SS12 LIMIT (labelled): OS accepted small payload but child never read it -> resolves (undetectable)", (t) => {
  const o = drive(t, "os-accepted-not-read");
  t.diagnostic(`go: ${String(o.extra?.["go"])}`);
  resolved(o, 0);
  // The child was released only by a successful write: synchronous (POSIX pipes) or its completion callback (win32).
  assert.ok(o.extra?.["go"] === "sync" || o.extra?.["go"] === "write-cb", `go signal ${String(o.extra?.["go"])}`);
});
