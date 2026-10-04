// #1162 — nodeSpawner().run stdin pipe behaviour (EPIPE / peer-closed / delivery).
// Every scenario runs the REAL nodeSpawner inside an isolated driver subprocess
// (_spawner-stdin-driver.js), so a regression that crashes on an unhandled stdin
// 'error' fails the test instead of killing the runner. Hermetic: children are
// fixture /bin/sh shims (PATH = fixture bin dir only, shell builtins only) or
// process.execPath + fixture scripts; fake HOME; every child pid is checked dead.
//
// Honest labelling: "delivered" below means the OS pipe accepted the bytes. Only the
// echo/drain scenarios prove the child application actually read them.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DRIVER = join(import.meta.dirname, "_spawner-stdin-driver.js");
const PEER_CLOSED = ["EPIPE", "ECONNRESET"];
const MULTI = "héllo-世界-\u{1F600}\n";

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
// #1167 win32 only: extensionless /bin/sh shims cannot be spawned there (ENOENT), so each
// SH fixture gets a process.execPath twin with the same pid/mark/go protocol and exit code.
// Unverified reasoning (not established from pinned source): stdlib may be unable to close
// an inherited stdin handle early on win32, so twins never close it while alive; the read end
// is expected to close at termination, which the driver gate waits for. LIMIT: weaker than the
// POSIX "closed while alive" gate; needs an actual Windows experiment before adoption.
// No twin ever touches process.stdin.
const WIN_JS: Record<string, string> = {
  "close-stdin-exit5.cjs": `${PID}require("node:fs").writeFileSync(process.env.MARK, ""); process.exitCode = 5;\n`,
  "close-stdin-exit0.cjs": `${PID}process.exitCode = 0;\n`,
  "exit6.cjs": `${PID}process.exitCode = 6;\n`,
  "exit0.cjs": `${PID}process.exitCode = 0;\n`,
  "wait-go-exit0.cjs": `${PID}const cell = new Int32Array(new SharedArrayBuffer(4));\nwhile (!require("node:fs").existsSync(process.env.GO)) Atomics.wait(cell, 0, 0, 2);\nprocess.exitCode = 0;\n`,
};
const WIN = process.platform === "win32";

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
    for (const [n, body] of Object.entries(SH)) writeFileSync(join(root, "bin", n), `#!/bin/sh\n${body}`, { mode: 0o755 });
    for (const [n, body] of Object.entries(JS)) writeFileSync(join(root, n), body);
    if (WIN) for (const [n, body] of Object.entries(WIN_JS)) writeFileSync(join(root, n), body);
    const env: Record<string, string> = { PATH: join(root, "bin"), HOME: join(root, "home"), TMPDIR: tmpdir() };
    if (WIN) Object.assign(env, { USERPROFILE: join(root, "home"), TEMP: tmpdir(), TMP: tmpdir() });
    const r = spawnSync(process.execPath, [DRIVER, scenario, root], {
      env,
      encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    const leftover = readdirSync(join(root, "pids")).map(Number).filter(isAlive);
    for (const pid of leftover) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
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
    rmSync(root, { recursive: true, force: true });
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
  const e = rejected(drive(t, "small-peer-closed"), PEER_CLOSED);
  assert.notEqual(e.code, "ENOENT");
});

test("SS4 8 MiB stdin > pipe buffer, child closes stdin unread and exits 0: rejects, never false success", (t) => {
  rejected(drive(t, "large-read-end-closed"), PEER_CLOSED);
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
  resolved(drive(t, "os-accepted-not-read"), 0);
});
