// Task 1201 — the frozen W↔B interface `resolveHandoff` (SPEC §10), the first-turn line (§6.2),
// the private write of state/handoff/latest.{md,json} (§6.4) and its failure arms (§9.3).
//
// In-process, under `withHermeticEnv`: every store root is the fixture HOME whether the engine
// reads the `env` it is handed or `os.homedir()`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type Box,
  MAX_FIRST_TURN_BYTES,
  type ResolveHandoffResult,
  at,
  boundViolations,
  bytes,
  dropBox,
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
  assert.equal(r.ref.file, path.join(b.ws, "state", "handoff", "latest.md"), "absolute <ws>/state/handoff/latest.md");
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

test("a state/ that is a symlink → skipped:*, nothing written through it (SPEC §9.3)", { skip: !POSIX && "NOTRUN on win32: creating a symlink needs a privilege the test job does not hold" }, async (t) => {
  const b = makeBox({ state: false });
  t.after(() => dropBox(b));
  const elsewhere = path.join(b.base, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(b.ws, "state"));
  plant("codex", b, { last: at(10) });
  assertSkipped(await resolve(b, { write: true }), "state symlink");
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("a state/handoff that is a symlink → skipped:*, nothing written through it (SPEC §6.4)", { skip: !POSIX && "NOTRUN on win32: symlink privilege" }, async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const elsewhere = path.join(b.base, "elsewhere");
  fs.mkdirSync(elsewhere, { mode: 0o700 });
  fs.symlinkSync(elsewhere, path.join(b.ws, "state", "handoff"));
  plant("codex", b, { last: at(10) });
  assertSkipped(await resolve(b, { write: true }), "handoff symlink");
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("a group/other-writable state/handoff is refused (SPEC §6.4 lstat checks)", { skip: !POSIX && "NOTRUN on win32: POSIX mode bits" }, async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const dir = path.join(b.ws, "state", "handoff");
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o777);
  plant("codex", b, { last: at(10) });
  assertSkipped(await resolve(b, { write: true }), "0777 handoff dir");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a transcript that is a symlink is not followed (SPEC §3: O_NOFOLLOW reads)", { skip: !POSIX && "NOTRUN on win32: symlink privilege; O_NOFOLLOW is POSIX-only" }, async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const p = plantClaude(b, { last: at(10) });
  const real = path.join(b.base, "real-transcript.jsonl");
  fs.renameSync(p.file, real);
  fs.symlinkSync(real, p.file);
  assertSkipped(await resolve(b, { write: true }), "symlinked transcript");
});

test("an unreadable store is skipped, never thrown; a readable one still wins", { skip: (!POSIX || ROOT) && "NOTRUN: needs POSIX permissions and a non-root user" }, async (t) => {
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

test("a workspace that does not exist → skipped:*, never throws", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const { fn } = await findResolveHandoff();
  const r = withHermeticEnv(b, () =>
    fn({ workspace: path.join(os.tmpdir(), `does-not-exist-${randomUUID()}`), env: { HOME: b.home }, now: new Date(), bootId: randomUUID(), write: true, deadlineMs: Date.now() + 30_000 }),
  );
  assertSkipped(r, "missing workspace");
});
