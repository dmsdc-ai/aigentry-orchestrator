// Task 1201 — the frozen W↔B interface `resolveHandoff` (SPEC §10), the first-turn line (§6.2),
// the private write of state/handoff/latest.{md,json} (§6.4) and its failure arms (§9.3).
//
// In-process, under `withHermeticEnv`: every store root is the fixture HOME whether the engine
// reads the `env` it is handed or `os.homedir()`.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { winPrivateStorage } from "../../src/session/private-storage.js";
import {
  type Box,
  MAX_FIRST_TURN_BYTES,
  type ResolveHandoffResult,
  at,
  boundViolations,
  bytes,
  dropBox,
  engineWs,
  findResolveHandoff,
  hasControlOtherThanNewline,
  makeBox,
  plant,
  plantClaude,
  sha256File,
  withHermeticEnv,
} from "./harness.js";

const POSIX = process.platform !== "win32";
const ROOT = POSIX && typeof process.getuid === "function" && process.getuid() === 0;

async function resolve(b: Box, o: { write: boolean; deadlineMs?: number; bootId?: string }): Promise<ResolveHandoffResult> {
  const { fn } = await findResolveHandoff();
  return withHermeticEnv(b, () =>
    fn({
      workspace: b.ws,
      env: { HOME: b.home, USERPROFILE: b.home },
      now: new Date(),
      bootId: o.bootId ?? randomUUID(),
      write: o.write,
      // An absolute deadline far enough out; 0 is "already expired" under either reading.
      deadlineMs: o.deadlineMs ?? Date.now() + 30_000,
    }),
  );
}

const latest = (b: Box, f: "md" | "json"): string => path.join(b.ws, "state", "handoff", `latest.${f}`);
const RECORD_KEYS = ["boot_id", "delivery", "handoff", "outcome", "source", "v", "warning", "written_at"];

function assertSkipped(r: ResolveHandoffResult, label: string): void {
  assert.equal(r.ref, null, `${label}: ref must be null so the argv is today's`);
  assert.match(String(r.record.outcome), /^skipped:/, `${label}: outcome ${String(r.record.outcome)}`);
  assert.match(r.stderrLine, /^\[orchestrator-boot\] handoff: skipped:/, `${label}: ${r.stderrLine}`);
}

test("write:false — a ref, the first-turn line, the markdown; nothing written (SPEC §6.2, §6.3)", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const p = plant("codex", b, { last: at(10) });
  const bootId = randomUUID();
  const r = await resolve(b, { write: false, bootId });
  assert.ok(r.ref !== null, `a source exists: ${JSON.stringify(r.record)}`);
  assert.equal(r.ref.file, path.join(engineWs(b.ws), "state", "handoff", "latest.md"), "absolute <ws>/state/handoff/latest.md");
  assert.equal(r.ref.source.cli, "codex");
  assert.equal(r.ref.source.sessionId, p.session);
  assert.equal(r.ref.source.path, p.file);
  assert.equal(r.ref.source.lastActivity, at(10).toISOString());

  // The first-turn line: ≤ 400 B, one line, no control character, no leading '-' — i.e. it
  // passes plan.ts baseFieldError's rules and survives the newline-delimited argv channel.
  const line = r.ref.line;
  assert.ok(bytes(line) <= MAX_FIRST_TURN_BYTES, `${bytes(line)} B`);
  assert.ok(!hasControlOtherThanNewline(line) && !line.includes("\n"), "no control character");
  assert.ok(!line.startsWith("-"), "no leading '-'");
  assert.ok(line.startsWith(`aigentry handoff: continuing from codex session ${p.session.slice(0, 8)}, last activity ${at(10).toISOString()}.`), line);
  assert.ok(line.includes(`Load ${r.ref.file} in full before anything else`), line);
  assert.doesNotMatch(line, /CH-CODEX/, "the pointer line carries no handoff content (SPEC F4: argv is visible to ps)");

  assert.ok(r.markdown !== null);
  assert.deepEqual(boundViolations(r.markdown), []);
  assert.ok(r.markdown.includes("CH-CODEX-REQ-LAST"));
  assert.deepEqual(Object.keys(r.record).sort(), RECORD_KEYS, "closed record keys (SPEC §6.4)");
  assert.equal(r.record.boot_id, bootId, "the boot record's boot_id is shared");
  assert.match(r.stderrLine, /^\[orchestrator-boot\] handoff: \S+ source=codex:\S{8} last=\S+ bytes=\d+/);
  assert.ok(!r.stderrLine.includes("\n") || r.stderrLine.indexOf("\n") === r.stderrLine.length - 1, "one line");
  assert.doesNotMatch(r.stderrLine, /CH-CODEX/, "no handoff content in the log line");
  assert.deepEqual(fs.readdirSync(path.join(b.ws, "state")), [], "write:false writes nothing");
});

test("write:true — 0700 dir, 0600 files, sha256/bytes/lines of latest.md, shared boot_id (SPEC §6.4)", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const p = plantClaude(b, { last: at(10) });
  const bootId = randomUUID();
  const r = await resolve(b, { write: true, bootId });
  assert.ok(r.ref !== null);
  assert.equal(r.record.outcome, "written");
  const md = fs.readFileSync(latest(b, "md"), "utf8");
  assert.equal(md, r.markdown, "latest.md is the returned markdown");
  const onDisk = JSON.parse(fs.readFileSync(latest(b, "json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(onDisk).sort(), RECORD_KEYS);
  assert.equal(onDisk.v, 1);
  assert.equal(onDisk.boot_id, bootId);
  assert.equal(onDisk.outcome, "written");
  const ho = onDisk.handoff as { sha256: string; bytes: number; lines: number };
  assert.equal(ho.sha256, sha256File(latest(b, "md")), "handoff.sha256 is the sha256 of latest.md's bytes");
  assert.equal(ho.bytes, fs.statSync(latest(b, "md")).size);
  assert.equal(ho.lines, md.replace(/\n$/, "").split("\n").length);
  const src = onDisk.source as Record<string, unknown>;
  assert.equal(src.cli, "claude");
  assert.equal(src.session_id, p.session);
  assert.equal(src.sha256, sha256File(p.file));
  assert.deepEqual(fs.readdirSync(path.join(b.ws, "state", "handoff")).sort(), ["latest.json", "latest.md"], "no temp file left behind");
  if (POSIX) {
    assert.equal(fs.statSync(path.join(b.ws, "state", "handoff")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(latest(b, "md")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(latest(b, "json")).mode & 0o777, 0o600);
  }
  // A second boot replaces both files (rename), keeping the modes.
  const again = await resolve(b, { write: true });
  assert.equal(again.record.outcome, "written");
  if (POSIX) assert.equal(fs.statSync(latest(b, "md")).mode & 0o777, 0o600);
});

test("<ws>/state missing → skipped:no-state-dir, nothing created (SPEC §6.1)", async (t) => {
  const b = makeBox({ state: false });
  t.after(() => dropBox(b));
  plant("gemini", b, { last: at(10) });
  const r = await resolve(b, { write: true });
  assertSkipped(r, "no-state-dir");
  assert.equal(r.record.outcome, "skipped:no-state-dir");
  assert.ok(!fs.existsSync(path.join(b.ws, "state")));
});

test("an expired deadline → skipped:timeout, nothing written (SPEC §6.1)", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plant("grok", b, { last: at(10) });
  const r = await resolve(b, { write: true, deadlineMs: 0 });
  assertSkipped(r, "timeout");
  assert.equal(r.record.outcome, "skipped:timeout");
  assert.deepEqual(fs.readdirSync(path.join(b.ws, "state")), []);
});

test("no source anywhere → ref null, skipped:*, never throws", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  assertSkipped(await resolve(b, { write: true }), "empty stores");
  // Garbage where a transcript should be.
  const p = plantClaude(b, { last: at(10) });
  fs.writeFileSync(p.file, Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x0a, 0x5b, 0x5d, 0x0a]));
  assertSkipped(await resolve(b, { write: true }), "garbage transcript");
});

if (POSIX) test("a state/ that is a symlink → skipped:*, nothing written through it (SPEC §9.3)", async (t) => {
  const b = makeBox({ state: false });
  t.after(() => dropBox(b));
  const elsewhere = path.join(b.base, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(b.ws, "state"));
  plant("codex", b, { last: at(10) });
  assertSkipped(await resolve(b, { write: true }), "state symlink");
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

if (POSIX) test("a state/handoff that is a symlink → skipped:*, nothing written through it (SPEC §6.4)", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const elsewhere = path.join(b.base, "elsewhere");
  fs.mkdirSync(elsewhere, { mode: 0o700 });
  fs.symlinkSync(elsewhere, path.join(b.ws, "state", "handoff"));
  plant("codex", b, { last: at(10) });
  assertSkipped(await resolve(b, { write: true }), "handoff symlink");
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

if (POSIX) test("a group/other-writable state/handoff is refused (SPEC §6.4 lstat checks)", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const dir = path.join(b.ws, "state", "handoff");
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o777);
  plant("codex", b, { last: at(10) });
  assertSkipped(await resolve(b, { write: true }), "0777 handoff dir");
  assert.deepEqual(fs.readdirSync(dir), []);
});

if (POSIX) test("a transcript that is a symlink is not followed (SPEC §3: O_NOFOLLOW reads)", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const p = plantClaude(b, { last: at(10) });
  const real = path.join(b.base, "real-transcript.jsonl");
  fs.renameSync(p.file, real);
  fs.symlinkSync(real, p.file);
  assertSkipped(await resolve(b, { write: true }), "symlinked transcript");
});

if (POSIX && !ROOT) test("an unreadable store is skipped, never thrown; a readable one still wins", async (t) => {
  const b = makeBox();
  const projects = path.join(b.home, ".claude", "projects");
  t.after(() => {
    fs.chmodSync(projects, 0o700);
    dropBox(b);
  });
  plantClaude(b, { last: at(50) });
  fs.chmodSync(projects, 0o000);
  assertSkipped(await resolve(b, { write: true }), "unreadable claude store only");
  const c = plant("codex", b, { last: at(10) });
  const r = await resolve(b, { write: true });
  assert.equal(r.ref?.source.sessionId, c.session, "the readable store is still used");
});

if (!POSIX) {
  const junction = (target: string, link: string): void => fs.symlinkSync(target, link, "junction");
  const icacls = (args: string[]): void => {
    const tool = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
    const r = spawnSync(tool, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.equal(r.status, 0, `icacls ${args.join(" ")}: ${r.error?.message ?? r.stderr}`);
  };

  test("win32: a state/ junction is refused without writing through it", async (t) => {
    const b = makeBox({ state: false });
    t.after(() => dropBox(b));
    const elsewhere = path.join(b.base, "elsewhere");
    fs.mkdirSync(elsewhere);
    junction(elsewhere, path.join(b.ws, "state"));
    plant("codex", b, { last: at(10) });
    const r = await resolve(b, { write: true });
    assertSkipped(r, "state junction");
    assert.equal(r.record.outcome, "skipped:unsafe-path");
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  test("win32: a state/handoff junction is refused without writing through it", async (t) => {
    const b = makeBox();
    t.after(() => dropBox(b));
    const elsewhere = path.join(b.base, "elsewhere");
    fs.mkdirSync(elsewhere);
    junction(elsewhere, path.join(b.ws, "state", "handoff"));
    plant("codex", b, { last: at(10) });
    const r = await resolve(b, { write: true });
    assertSkipped(r, "handoff junction");
    assert.equal(r.record.outcome, "skipped:unsafe-path");
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  test("win32: a pre-existing handoff directory with an Everyone ACE is refused", async (t) => {
    const b = makeBox();
    t.after(() => dropBox(b));
    const dir = path.join(b.ws, "state", "handoff");
    fs.mkdirSync(dir);
    assert.ok(winPrivateStorage, "Windows private-storage primitive is required");
    assert.deepEqual(winPrivateStorage.setPrivate(dir, "directory"), { status: "ok" });
    icacls([dir, "/grant", "*S-1-1-0:(R)", "/q"]);
    plant("codex", b, { last: at(10) });
    const r = await resolve(b, { write: true });
    assertSkipped(r, "unsafe Windows ACL");
    assert.equal(r.record.outcome, "skipped:unsafe-path");
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test("win32: a junction in a transcript store is not followed", async (t) => {
    const b = makeBox();
    t.after(() => dropBox(b));
    const p = plantClaude(b, { last: at(10) });
    const projects = path.dirname(path.dirname(p.file));
    const elsewhere = path.join(b.base, "elsewhere-projects");
    fs.renameSync(projects, elsewhere);
    junction(elsewhere, projects);
    assertSkipped(await resolve(b, { write: true }), "transcript store junction");
    assert.deepEqual(fs.readdirSync(path.join(b.ws, "state")), []);
  });

  test("win32: an exclusively shared transcript is skipped while a readable store still wins", async (t) => {
    const b = makeBox();
    let holder: ChildProcessWithoutNullStreams | undefined;
    let closed: Promise<void> | undefined;
    let closeObserved = false;
    let transcript: string | undefined;
    let identity: { dev: number; ino: number } | undefined;
    let failure: unknown;
    let failed = false;
    try {
      const p = plantClaude(b, { last: at(50) });
      const file = fs.realpathSync(p.file);
      const relative = path.relative(b.base, file);
      assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "transcript must belong to the owned fixture");
      const before = fs.lstatSync(file);
      assert.ok(before.isFile(), "transcript must be a regular file");
      transcript = file;
      identity = { dev: before.dev, ino: before.ino };
      const readable = path.join(b.base, "readable-control.jsonl");
      fs.copyFileSync(file, readable);
      assert.deepEqual(fs.readFileSync(readable), fs.readFileSync(file), "positive control has the same bytes");

      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$encoded = [Console]::In.ReadLine()",
        "$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))",
        "$stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)",
        "try {",
        "  [Console]::Out.WriteLine('READY')",
        "  [Console]::Out.Flush()",
        "  [void][Console]::In.ReadLine()",
        "} finally { $stream.Dispose() }",
      ].join("\n");
      const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      holder = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const child = holder;
      let stdinFailure: Error | undefined;
      closed = new Promise<void>((resolveClosed) => child.once("close", () => { closeObserved = true; resolveClosed(); }));
      const ready = new Promise<void>((resolveReady, rejectReady) => {
        let output = "";
        let timeout: NodeJS.Timeout;
        const finish = (error?: Error): void => {
          clearTimeout(timeout);
          child.off("error", onError);
          child.off("close", onClose);
          child.stdout.off("data", onData);
          if (error) rejectReady(error);
          else resolveReady();
        };
        const onError = (error: Error): void => finish(error);
        const onClose = (code: number | null): void => finish(new Error(`exclusive-sharing holder exited before readiness: ${code}`));
        const onData = (chunk: Buffer): void => {
          output += chunk.toString("utf8");
          if (output.length > 1024) finish(new Error("exclusive-sharing holder produced excess output"));
          else if (output.includes("\n")) {
            if (output.trim() === "READY") finish();
            else finish(new Error(`exclusive-sharing holder did not signal readiness: ${output.slice(0, 120)}`));
          }
        };
        timeout = setTimeout(() => finish(new Error("exclusive-sharing holder readiness timed out")), 15_000);
        child.once("error", onError);
        child.once("close", onClose);
        child.stdout.on("data", onData);
      });
      child.stdin.on("error", (error: Error) => { stdinFailure = error; });
      assert.ok(child.pid, "exclusive-sharing holder must have a process id");
      child.stdin.write(Buffer.from(file, "utf8").toString("base64") + "\n");
      await ready;
      assert.equal(stdinFailure, undefined, `exclusive-sharing holder input failed: ${String(stdinFailure)}`);
      assert.equal(child.exitCode, null, "exclusive-sharing holder exited before resolver checks");
      assert.equal(child.signalCode, null, "exclusive-sharing holder was terminated before resolver checks");
      let readError: NodeJS.ErrnoException | null = null;
      try {
        const fd = fs.openSync(file, fs.constants.O_RDONLY);
        try {
          fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        readError = error as NodeJS.ErrnoException;
      }
      assert.ok(readError, "exclusive-sharing fixture setup failed: O_RDONLY transcript open/read succeeded");
      assert.equal(readError.code, "EBUSY", `expected sharing violation from transcript open/read, got ${readError.code ?? "unknown"}`);
      const positiveFd = fs.openSync(readable, fs.constants.O_RDONLY);
      try {
        assert.equal(fs.readSync(positiveFd, Buffer.alloc(1), 0, 1, 0), 1, "same-byte positive control is readable");
      } finally {
        fs.closeSync(positiveFd);
      }
      assertSkipped(await resolve(b, { write: true }), "unreadable Claude store");
      const c = plant("codex", b, { last: at(10) });
      const r = await resolve(b, { write: true });
      assert.equal(r.ref?.source.sessionId, c.session, "the readable store is still used");
      assert.equal(child.exitCode, null, "exclusive-sharing holder must remain live through resolver checks");
      assert.equal(child.signalCode, null, "exclusive-sharing holder must remain live through resolver checks");
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (holder && closed) {
        try {
          const child = holder;
          const closedPromise = closed;
          const waitClosed = async (ms: number): Promise<boolean> => {
            let timer: NodeJS.Timeout | undefined;
            try {
              return await Promise.race([closedPromise.then(() => true), new Promise<false>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), ms); })]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          };
          if (!closeObserved) child.stdin.end();
          const exited = await waitClosed(10_000);
          if (!exited) {
            child.kill();
            const reaped = await waitClosed(5_000);
            assert.ok(reaped, "exclusive-sharing holder did not exit after bounded cleanup");
            throw new Error("exclusive-sharing holder required forced cleanup");
          }
          assert.equal(child.exitCode, 0, "exclusive-sharing holder did not exit cleanly");
        } catch (cleanupError) {
          if (failed) t.diagnostic(`holder cleanup also failed: ${String(cleanupError)}`);
          else { failed = true; failure = cleanupError; }
        }
      }
      if (transcript && identity && closeObserved) {
        try {
          const after = fs.lstatSync(transcript);
          assert.ok(after.isFile(), "released transcript remains a regular file");
          assert.deepEqual({ dev: after.dev, ino: after.ino }, identity, "released transcript is the same file");
          const fd = fs.openSync(transcript, fs.constants.O_RDONLY);
          try { assert.equal(fs.readSync(fd, Buffer.alloc(1), 0, 1, 0), 1, "released transcript is readable"); }
          finally { fs.closeSync(fd); }
        } catch (cleanupError) {
          if (failed) t.diagnostic(`post-release verification also failed: ${String(cleanupError)}`);
          else { failed = true; failure = cleanupError; }
        }
      }
      try { dropBox(b); } catch (cleanupError) {
        if (failed) t.diagnostic(`fixture cleanup also failed: ${String(cleanupError)}`);
        else { failed = true; failure = cleanupError; }
      }
    }
    if (failed) throw failure;
  });
}

test("a workspace that does not exist → skipped:*, never throws", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const { fn } = await findResolveHandoff();
  const r = withHermeticEnv(b, () =>
    fn({ workspace: path.join(os.tmpdir(), `does-not-exist-${randomUUID()}`), env: { HOME: b.home }, now: new Date(), bootId: randomUUID(), write: true, deadlineMs: Date.now() + 30_000 }),
  );
  assertSkipped(r, "missing workspace");
});
