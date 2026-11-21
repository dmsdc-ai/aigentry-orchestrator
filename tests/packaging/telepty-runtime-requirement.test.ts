// #1293 — the runtime telepty requirement: ONE precise message, no self-repair.
//
// Since this package declares no dependency on @dmsdc-ai/aigentry-telepty (see
// tests/packaging/telepty-dependency.test.ts), the requirement has to be explicit where it
// is CHECKED at runtime. The first door is `aigentry-orchestrator init`, step 1: it probes
// the telepty on PATH with the same sealed capability document the two later doors read
// (`telepty boot-capabilities` — src/orchestrator-boot/cli.ts:497-524 requires
// allow-create-v1 and nondeleting-v1 viewer detach, src/dispatch/cli.ts:1245-1254 requires
// inject-bound-v1), and says what is required, which published version carries it and which
// command installs it.
//
// WHAT IS MEASURED HERE, and nothing else:
//   * the real bin/init/cli.mjs of this checkout, as a subprocess, in a fresh HOME and a
//     fresh workspace, with `--dry-run` so nothing is written anywhere;
//   * a FAKE telepty on PATH — missing, an older CLI that answers the unknown verb with its
//     help text and exit 0, a sealed document missing one verb, a wrong viewer_detach, a
//     non-zero exit, and a sufficient one;
//   * that init runs the capability probe and NOT a version comparison (the stub records its
//     argv, and `--version` is never asked for);
//   * that init installs, upgrades, starts, stops and restarts nothing: `npm`, `npx`,
//     `telepty-install`, `launchctl`, `systemctl` and `kill` are tripwires on the fixture
//     PATH and must never be invoked.
// No real telepty, daemon, session, registry or network exists in this file.
//
// The subprocess cases are POSIX; init's win32 door probes jq.exe/python.exe and resolves
// Git for Windows bash before it reaches the telepty check, and that door is measured by
// tests/packaging/init-platform.test.mjs. They are skipped BY NAME on win32, never passed.
// The source-contract case below is pure file reading and runs on every OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../..");
const INIT_CLI = join(REPO, "bin/init/cli.mjs");
const MIN_VERSION = "0.11.1";
const INSTALL_COMMAND = "npm i -g @dmsdc-ai/aigentry-telepty@latest";
/** Anything named here would mean init tried to change the host. */
const TRIPWIRES = ["npm", "npx", "telepty-install", "launchctl", "systemctl", "kill", "brew", "apt-get"];
const WIN = process.platform === "win32";
const SKIP_WIN = WIN && "POSIX fixture: init's win32 door resolves jq.exe/python.exe/Git bash before the " +
  "telepty check; tests/packaging/init-platform.test.mjs measures that door";

/** The sealed one-line document a sufficient telepty prints. */
const SEALED = { schema: "telepty-boot-capabilities-v1", verbs: ["allow-create-v1", "inject-bound-v1"],
  viewer_detach: "nondeleting-v1" };
/** The help text an older telepty prints for an unknown verb, before exiting 0. */
const OLD_HELP = "telepty — session multiplexer\nUsage: telepty <command> [options]\n  inject, send-key, list, read-screen, session\n";

function insideGit(dir: string): boolean {
  for (let cur = dir; ; cur = dirname(cur)) {
    if (existsSync(join(cur, ".git"))) return true;
    if (cur === dirname(cur)) return false;
  }
}

interface Fixture {
  root: string;
  bin: string;
  home: string;
  ws: string;
  argvLog: string;
  tripwireLog: string;
}

/** A fresh root with the fixture PATH: the hard dependencies init probes, plus the tripwires. */
function fixture(telepty: string | null): Fixture {
  const base = tmpdir();
  assert.ok(!insideGit(base), `${base} is inside a Git working tree; init refuses to write into one`);
  const root = mkdtempSync(join(base, "telepty-requirement-1293-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const dir of [bin, home]) mkdirSync(dir, { recursive: true });
  const argvLog = join(root, "telepty-argv.jsonl");
  const tripwireLog = join(root, "tripwires.log");
  writeFileSync(argvLog, "");
  writeFileSync(tripwireLog, "");
  const script = (name: string, body: string): void =>
    writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  // init's POSIX hard dependencies. Present only so step 1 reaches the telepty check; each
  // one answers `--version` and nothing else.
  for (const tool of ["jq", "python3", "claude", "cmux"]) script(tool, `console.log("${tool} 9.9.9");`);
  for (const tool of TRIPWIRES) {
    script(tool, `require("node:fs").appendFileSync(${JSON.stringify(tripwireLog)}, ` +
      `JSON.stringify(["${tool}", ...process.argv.slice(2)]) + "\\n"); process.exit(99);`);
  }
  if (telepty !== null) {
    script("telepty", `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
${telepty}`);
  }
  return { root, bin, home, ws: join(root, "ws"), argvLog, tripwireLog };
}

function runInit(f: Fixture): { status: number | null; stdout: string; stderr: string } {
  // PATH is the fixture bin and NOTHING else: every stub carries an absolute node shebang, and a
  // real telepty or npm from the ambient PATH would silently decide these cases.
  const env: NodeJS.ProcessEnv = { HOME: f.home, USERPROFILE: f.home, AIGENTRY_HOME: join(f.home, ".aigentry"),
    PATH: f.bin, TMPDIR: f.root };
  const r = spawnSync(process.execPath, [INIT_CLI, "init", "--yes", "--dry-run", "--workspace", f.ws],
    { cwd: f.root, env, encoding: "utf8", timeout: 120_000 });
  assert.ifError(r.error);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const lines = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** Every refusal shape must produce exactly ONE message, with the same four facts in it. */
function assertOneRequirementMessage(out: { stdout: string; stderr: string }, observed: RegExp, label: string): void {
  const text = `${out.stdout}\n${out.stderr}`;
  assert.equal(occurrences(text, INSTALL_COMMAND), 1, `${label}: the install command must appear exactly once:\n${text}`);
  assert.equal(occurrences(text, `${MIN_VERSION} or later`), 1, `${label}: the minimum version must be named once`);
  assert.match(out.stderr, observed, `${label}: the observed fact is not named`);
  assert.match(out.stderr, /declares NO dependency on @dmsdc-ai\/aigentry-telepty/, `${label}: the requirement is not explicit`);
  assert.match(out.stderr, /installs, upgrades, starts, stops and restarts nothing/, `${label}: the no-self-repair promise is missing`);
  assert.match(out.stderr, /allow-create-v1 and inject-bound-v1/, `${label}: the required capability is not named`);
  // The 0.2.0 wording this replaces claimed telepty was a declared dependency installed nested
  // under the package. Both claims are now false and must never come back.
  assert.doesNotMatch(out.stderr, /node_modules/, `${label}: the message still points at a nested copy`);
  assert.doesNotMatch(out.stderr, /declared dependency of this package/, `${label}: the message still claims a dependency`);
}

function assertChangedNothing(f: Fixture, label: string): void {
  assert.deepEqual(lines(f.tripwireLog), [], `${label}: init invoked an installer, supervisor or signal`);
  assert.equal(existsSync(f.ws), false, `${label}: --dry-run created the workspace`);
  assert.equal(existsSync(join(f.home, ".aigentry")), false, `${label}: --dry-run created AIGENTRY_HOME`);
}

for (const [label, stub, observed] of [
  ["missing", null, /telepty is not on PATH/],
  ["old CLI help + exit 0", `process.stdout.write(${JSON.stringify(OLD_HELP)});`,
    /did not print a telepty-boot-capabilities-v1 document/],
  ["sealed document without inject-bound-v1",
    `console.log(JSON.stringify({ ...${JSON.stringify(SEALED)}, verbs: ["allow-create-v1"] }));`,
    /does not declare inject-bound-v1 in its boot-capabilities/],
  ["sealed document without allow-create-v1",
    `console.log(JSON.stringify({ ...${JSON.stringify(SEALED)}, verbs: ["inject-bound-v1"] }));`,
    /does not declare allow-create-v1 in its boot-capabilities/],
  ["deleting viewer detach",
    `console.log(JSON.stringify({ ...${JSON.stringify(SEALED)}, viewer_detach: "deleting-v1" }));`,
    /declares viewer_detach "deleting-v1", not nondeleting-v1/],
  ["another schema",
    `console.log(JSON.stringify({ ...${JSON.stringify(SEALED)}, schema: "telepty-capabilities-v0" }));`,
    /printed schema "telepty-capabilities-v0", not telepty-boot-capabilities-v1/],
  ["non-zero exit", "process.exit(3);", /'telepty boot-capabilities' exited 3/],
] as const) {
  test(`1293: a ${label} telepty produces ONE precise requirement message and changes nothing`,
    { skip: SKIP_WIN }, () => {
      const f = fixture(stub);
      try {
        const r = runInit(f);
        // telepty is a warning, not a hard dependency: the control workspace is complete without it.
        assert.equal(r.status, 0, `${label}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
        assertOneRequirementMessage(r, observed, label);
        assertChangedNothing(f, label);
        // The capability probe, not a version comparison, and exactly once.
        assert.deepEqual(lines(f.argvLog).map((l) => JSON.parse(l) as string[]),
          stub === null ? [] : [["boot-capabilities"]], `${label}: the telepty argv is not one capability probe`);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });
}

test("1293: a sufficient telepty is accepted silently — no requirement message, still nothing installed",
  { skip: SKIP_WIN }, () => {
    const f = fixture(`console.log(JSON.stringify(${JSON.stringify(SEALED)}));`);
    try {
      const r = runInit(f);
      assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /telepty found; its boot-capabilities declare allow-create-v1 and inject-bound-v1/);
      assert.equal(occurrences(`${r.stdout}\n${r.stderr}`, INSTALL_COMMAND), 0,
        "a sufficient telepty must not be told to upgrade");
      assertChangedNothing(f, "sufficient");
      assert.deepEqual(lines(f.argvLog).map((l) => JSON.parse(l) as string[]), [["boot-capabilities"]]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

test("1293: all three telepty doors name the same floor and install command, and none of them is a version compare", () => {
  const doors = ["bin/init/cli.mjs", "src/dispatch/cli.ts", "src/orchestrator-boot/cli.ts"];
  for (const door of doors) {
    const source = readFileSync(join(REPO, door), "utf8");
    assert.equal(occurrences(source, `TELEPTY_MIN_VERSION = "${MIN_VERSION}"`), 1,
      `${door}: the floor must be declared exactly once, as ${MIN_VERSION}`);
    assert.equal(occurrences(source, `TELEPTY_INSTALL_COMMAND = "${INSTALL_COMMAND}"`), 1,
      `${door}: the install command must be declared exactly once`);
    // The requirement is a capability, read from the sealed document; no door may decide by
    // parsing `telepty --version`, which an older CLI is free to format any way it likes.
    assert.ok(source.includes("boot-capabilities"), `${door}: the capability document is not read`);
    assert.doesNotMatch(source, /telepty",\s*\["--version"\]|telepty --version/,
      `${door}: a telepty version string is being compared instead of the capability`);
  }
  // The 0.2.0 claim that telepty ships nested under this package is gone from the init door.
  const init = readFileSync(join(REPO, "bin/init/cli.mjs"), "utf8");
  assert.ok(!init.includes("declared dependency of this package"), "init still claims a telepty dependency");
  assert.ok(!init.includes('"node_modules", ".bin", "telepty"'), "init still points at a nested telepty");
});
