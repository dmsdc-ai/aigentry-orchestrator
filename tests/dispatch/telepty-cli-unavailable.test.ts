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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./model-router-fixtures.js";

const SID = "router-fixture";
const FROM = "E-dg1293-orchestrator";
/** The pre-fix line: a knob that cannot help a host with no telepty. */
const KNOB_ADVICE = /raise AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS/;

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
    // A registration budget far longer than this process may take. The point of the refusal is
    // that it does not spend it: the first listing already proved the command cannot run.
    const started = Date.now();
    const r = f.dispatch(["--target", SID, "--from", FROM],
      { TELEPTY: missing, AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS: "60000" });
    const elapsed = Date.now() - started;
    assert.equal(r.status, 78, `expected exit 78, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.stderr.includes(`dispatch.sh: TELEPTY_CLI_UNAVAILABLE for ${SID} — the telepty CLI ${missing} could not be run (ENOENT)`),
      `the refusal does not name the condition and the resolved command:\n${r.stderr}`);
    // The requirement, with the version floor and the one command the OPERATOR runs. Nothing in
    // this package installs, upgrades, starts, stops or restarts telepty.
    assert.match(r.stderr, /declares no dependency on @dmsdc-ai\/aigentry-telepty and drives the telepty on PATH/, r.stderr);
    assert.match(r.stderr, /install @dmsdc-ai\/aigentry-telepty 0\.11\.1 or later yourself with 'npm i -g @dmsdc-ai\/aigentry-telepty@latest'/, r.stderr);
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
