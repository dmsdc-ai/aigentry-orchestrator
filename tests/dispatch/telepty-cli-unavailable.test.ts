// #1293 (review R5) — a telepty that cannot be RUN is refused by name, at once, with the exit code
// the documentation promises.
//
// WHAT WAS WRONG. `aigentry-orchestrator init` tells the operator that until a sufficient telepty is
// in use "dispatch refuses by name with exit 78". That was true only of the bound-delivery door.
// An ORDINARY dispatch to a host with no telepty at all took a different path: cliOf() ran
// `telepty list --json`, could not start the command, and returned the same empty string it returns
// for "no such session yet" — so waitForRegistration slept out the whole registration budget
// (180000 ms for a --spawn-and-dispatch), printed "session '<sid>' never registered in telepty list
// after <N>ms — raise AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS", and exited 6. Three things were
// wrong at once: the wait could not possibly succeed, the advice named a knob that cannot help, and
// the documented contract said 78.
//
// WHAT IS MEASURED HERE: the compiled product CLI as a subprocess, through the shared fixture, with
// `TELEPTY` naming a file that does not exist — the exact state an upgrade from 0.2.5-0.2.7 leaves
// when the override pointed into this package's own node_modules. No real telepty, daemon, session
// or network exists, nothing is injected or submitted, and the control case below proves the fix is
// narrow: a telepty that RUNS and simply does not list the session still belongs to the
// registration wait and still exits 6, with the knob's advice intact.
//
// Platform-neutral: the fixture resolves fake CLIs through `.cmd` shims on win32, so both cases run
// on every OS with no skips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fixture } from "./model-router-fixtures.js";

const SID = "router-fixture";
const FROM = "E-dg1293-orchestrator";
/** The pre-fix line: a knob that cannot help a host with no telepty. */
const KNOB_ADVICE = /raise AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS/;
const INSTALL = "npm i -g @dmsdc-ai/aigentry-telepty@latest";
const WIN = process.platform === "win32";
/** Every file name the normal lookup of `telepty` can resolve, on either platform. */
const TELEPTY_NAMES = ["telepty", "telepty.cmd", "telepty.exe", "telepty.bat", "telepty.com"];

/**
 * r3: the fixture PATH with NO telepty in it. The fixture's own bin/telepty is removed (these cases
 * name or need no working telepty), and any other PATH directory holding one is dropped, so a
 * contributor's own telepty cannot decide the case. On CI no ambient directory holds one.
 */
function pathWithoutTelepty(f: ReturnType<typeof fixture>): string {
  for (const name of TELEPTY_NAMES) rmSync(join(f.bin, name), { force: true });
  return (f.env.PATH ?? "").split(delimiter)
    .filter((dir) => !TELEPTY_NAMES.some((name) => existsSync(join(dir, name)))).join(delimiter);
}

/** r3: a PATH directory holding a telepty the normal lookup finds on this platform; returns [PATH, file]. */
function pathWithTelepty(f: ReturnType<typeof fixture>): [string, string] {
  const dir = join(f.root, "path-telepty");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, WIN ? "telepty.cmd" : "telepty");
  writeFileSync(file, WIN ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return [[dir, f.env.PATH ?? ""].join(delimiter), file];
}

/**
 * "Nothing was recorded": no dispatch row in the registry, and the task queue byte-identical. The
 * row count is parsed rather than byte-compared because a registry transaction may legitimately
 * bump its own generation counter; a ROW is what a refusal before the wait must never leave.
 */
function recorded(root: string, queue: string): { rows: number; queue: string } {
  const active = JSON.parse(readFileSync(join(root, "state/active.json"), "utf8")) as { dispatches?: unknown[] };
  return { rows: (active.dispatches ?? []).length, queue: readFileSync(queue, "utf8") };
}

test("1293: a telepty that cannot be run refuses with exit 78 TELEPTY_CLI_UNAVAILABLE, before any wait", () => {
  const f = fixture();
  try {
    f.prepareTarget();
    const before = recorded(f.root, f.queue);
    const missing = join(f.root, "no-such-telepty");
    // r3 (review R3-2): a telepty the normal lookup finds is on PATH, so the stale override is the
    // whole problem. This FAILS on r2, which advised the global reinstall here.
    const [withTelepty, found] = pathWithTelepty(f);
    // A registration budget far longer than this process may take. The point of the refusal is
    // that it does not spend it: the first listing already proved the command cannot run.
    const started = Date.now();
    const r = f.dispatch(["--target", SID, "--from", FROM],
      { TELEPTY: missing, PATH: withTelepty, AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS: "60000" });
    const elapsed = Date.now() - started;
    assert.equal(r.status, 78, `expected exit 78, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.stderr.includes(`dispatch.sh: TELEPTY_CLI_UNAVAILABLE for ${SID} — the TELEPTY override names ${missing}, which does not exist (ENOENT)`),
      `the refusal does not name the override and what its file is:\n${r.stderr}`);
    // The one instruction is about the override; the fact about PATH is stated, and no reinstall is advised.
    assert.match(r.stderr, /Correct TELEPTY or unset it; the normal PATH lookup finds telepty at /, r.stderr);
    assert.ok(r.stderr.includes(found), `the telepty the normal lookup finds is not named:\n${r.stderr}`);
    assert.ok(!r.stderr.includes(INSTALL), `a stale override was answered with a reinstall:\n${r.stderr}`);
    assert.match(r.stderr, /Nothing was transported/, r.stderr);
    // The advice that could not help is gone from this path.
    assert.doesNotMatch(r.stderr, KNOB_ADVICE, "a host with no telepty was still told to raise the registration timeout");
    // It refused instead of waiting: well under the 60s budget it was given.
    assert.ok(elapsed < 20_000, `the refusal spent ${elapsed}ms of a 60000ms budget it cannot use`);
    // Nothing was delivered, recorded or ledgered.
    assert.doesNotMatch(r.stdout, /OK dispatched|ACCEPTED_PENDING/, "nothing may be reported as dispatched");
    assert.deepEqual(recorded(f.root, f.queue), before, "a refusal before the wait must write no ledger or queue row");
  } finally {
    f.cleanup();
  }
});

test("1293: a telepty that RUNS and does not list the session keeps the registration wait and exit 6", () => {
  // The control. This is the condition the knob exists for, and the fix must not touch it: the
  // fixture telepty runs fine and reports an empty session list, so the dispatch is a genuine
  // "not registered yet", exits 6 and still names the knob.
  const f = fixture();
  try {
    f.prepareTarget();
    const r = f.dispatch(["--target", SID, "--from", FROM], { LIVE_SESSIONS: "[]" });
    assert.equal(r.status, 6, `expected the unchanged exit 6, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, new RegExp(`session '${SID}' never registered in telepty list`), r.stderr);
    assert.match(r.stderr, KNOB_ADVICE, "the registration advice must survive for the case it fits");
    assert.doesNotMatch(r.stderr, /TELEPTY_CLI_UNAVAILABLE/, "a telepty that ran must not be reported as unavailable");
  } finally {
    f.cleanup();
  }
});

test("1293 r2: a telepty that STARTS but overflows the listing buffer keeps the registration wait and exit 6", () => {
  // review F6: r1 treated ANY child error of the listing as "the CLI could not run", so a healthy
  // telepty whose `list --json` exceeded the 1 MiB child buffer (ENOBUFS) was refused with 78 and
  // install advice. Only ENOENT/EACCES — a command that cannot be STARTED — is that condition now.
  // This FAILS on r1 (exit 78).
  const f = fixture();
  try {
    f.prepareTarget();
    const overflow = join(f.root, "telepty-overflow");
    writeFileSync(overflow, (process.platform === "win32" ? "#!/usr/bin/env node\n" : `#!${process.execPath}\n`) +
      "if (process.argv[2] === 'list') process.stdout.write('[' + ' '.repeat(2 * 1024 * 1024) + ']');\n" +
      "else process.exit(99);\n", { mode: 0o755 });
    const r = f.dispatch(["--target", SID, "--from", FROM], { TELEPTY: overflow });
    assert.equal(r.status, 6, `expected the registration wait's exit 6, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, new RegExp(`session '${SID}' never registered in telepty list`), r.stderr);
    assert.doesNotMatch(r.stderr, /TELEPTY_CLI_UNAVAILABLE/, "a telepty that started must not be reported as unavailable");
  } finally {
    f.cleanup();
  }
});

// ── r3 (review R3-2): install advice only when the normal lookup finds no telepty either ─────────
test("1293 r3: a stale override with no telepty on PATH either names the override first and the install command as a fact", () => {
  const f = fixture();
  try {
    f.prepareTarget();
    const missing = join(f.root, "no-such-telepty");
    const r = f.dispatch(["--target", SID, "--from", FROM], { TELEPTY: missing, PATH: pathWithoutTelepty(f) });
    assert.equal(r.status, 78, `expected exit 78, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.stderr.includes(`the TELEPTY override names ${missing}, which does not exist (ENOENT)`), r.stderr);
    assert.match(r.stderr, /Correct TELEPTY or unset it; the normal PATH lookup finds no executable telepty either: @dmsdc-ai\/aigentry-telepty 0\.11\.1 or later installs with /, r.stderr);
    assert.equal(r.stderr.split(INSTALL).length - 1, 1, `the install command must appear once:\n${r.stderr}`);
  } finally {
    f.cleanup();
  }
});

test("1293 r3: no override and no telepty on PATH is the one case that advises installing telepty", () => {
  const f = fixture();
  try {
    f.prepareTarget();
    // TELEPTY empty is the default lookup of the bare word `telepty` (src/dispatch/cli.ts: env.TELEPTY || "telepty").
    const r = f.dispatch(["--target", SID, "--from", FROM], { TELEPTY: "", PATH: pathWithoutTelepty(f) });
    assert.equal(r.status, 78, `expected exit 78, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.stderr.includes(`dispatch.sh: TELEPTY_CLI_UNAVAILABLE for ${SID} — no telepty is on PATH (ENOENT)`), r.stderr);
    assert.match(r.stderr, /install @dmsdc-ai\/aigentry-telepty 0\.11\.1 or later yourself with 'npm i -g @dmsdc-ai\/aigentry-telepty@latest'/, r.stderr);
    assert.doesNotMatch(r.stderr, /TELEPTY override/, r.stderr);
    assert.doesNotMatch(r.stderr, KNOB_ADVICE, r.stderr);
  } finally {
    f.cleanup();
  }
});

test("1293 r3: an override that is not executable is named as such, with no reinstall advice, per platform", () => {
  const f = fixture();
  try {
    f.prepareTarget();
    const [withTelepty] = pathWithTelepty(f);
    // POSIX: a regular file without an execute bit cannot be started (EACCES). win32 has no execute
    // bit: a directory is the override that cannot be a program there.
    const target = join(f.root, WIN ? "telepty-dir" : "telepty-not-executable");
    if (WIN) mkdirSync(target);
    else writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const r = f.dispatch(["--target", SID, "--from", FROM], { TELEPTY: target, PATH: withTelepty });
    assert.ok(!r.stderr.includes(INSTALL), `a broken override was answered with a reinstall:\n${r.stderr}`);
    if (WIN) {
      // Whatever the shell reports for a directory, it is never install advice, and a refusal names the override.
      if (r.status === 78) assert.match(r.stderr, /the TELEPTY override names .*Correct TELEPTY or unset it/, r.stderr);
    } else {
      assert.equal(r.status, 78, `expected exit 78, got ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.ok(r.stderr.includes(`the TELEPTY override names ${target}, which is not an executable file (EACCES)`), r.stderr);
      assert.match(r.stderr, /Correct TELEPTY or unset it/, r.stderr);
    }
  } finally {
    f.cleanup();
  }
});

test("1293 r3: a telepty on PATH that cannot be started is named, with no install advice, per platform", () => {
  const f = fixture();
  try {
    f.prepareTarget();
    const dir = join(f.root, "path-broken-telepty");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, WIN ? "telepty.cmd" : "telepty");
    // POSIX: an executable whose interpreter does not exist cannot be started (ENOENT), yet the
    // lookup finds it. win32's shim door starts cmd.exe, which then fails: a listing, not a start.
    writeFileSync(file, WIN ? "@echo off\r\nexit /b 1\r\n" : `#!${join(f.root, "no-such-interpreter")}\n`, { mode: 0o755 });
    const r = f.dispatch(["--target", SID, "--from", FROM], { TELEPTY: "", PATH: [dir, pathWithoutTelepty(f)].join(delimiter) });
    assert.ok(!r.stderr.includes(INSTALL), `a telepty on PATH was answered with an install:\n${r.stderr}`);
    if (WIN) {
      assert.equal(r.status, 6, `a shim that starts and fails is the registration wait's: ${r.status}\n${r.stderr}`);
    } else {
      assert.equal(r.status, 78, `expected exit 78, got ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.ok(r.stderr.includes(`the telepty on PATH (${file}) could not be started (ENOENT)`), r.stderr);
      assert.match(r.stderr, /Check that file's permissions and, for a script, its interpreter/, r.stderr);
    }
  } finally {
    f.cleanup();
  }
});
