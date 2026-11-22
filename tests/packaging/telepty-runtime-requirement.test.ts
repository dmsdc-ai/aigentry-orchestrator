// #1293 — the runtime telepty requirement and the 0.2.5-0.2.7 migration: ONE precise message,
// no self-repair, and the same verdict the later doors reach.
//
// Since this package declares no dependency on @dmsdc-ai/aigentry-telepty (see
// tests/packaging/telepty-dependency.test.ts), the requirement has to be explicit where it is
// CHECKED at runtime. The first door is `aigentry-orchestrator init` step 1: it probes the telepty
// in use with the same sealed capability document the two later doors read (`telepty
// boot-capabilities` — src/orchestrator-boot/cli.ts requires allow-create-v1 and nondeleting-v1
// viewer detach, src/dispatch/cli.ts requires inject-bound-v1), and says what is required, which
// published version carries it, which command installs it and what each later door does until then.
//
// r2 (review F1/F2): init asks only questions with an exact answer. It never guesses who installed
// or "owns" a telepty — a healthy telepty is never told to reinstall, wherever it lives, including
// beside the orchestrator in one shared npm prefix.
// r3: install advice follows only an ESTABLISHED fact — no telepty on PATH, or a valid capability
// document that lacks a capability. Every other answer is reported as inconclusive, with no install
// command. init reads no service definition at all (the README/CHANGELOG manual check covers it).
//
// WHAT IS MEASURED HERE, and nothing else:
//   * the real bin/init/cli.mjs of this checkout, as a subprocess, in a fresh HOME and a fresh
//     workspace, with `--dry-run` so nothing is written anywhere (one case runs a FULL init on
//     purpose — the review R6 case — and asserts the console states the command once);
//   * a FAKE telepty — absent, an older CLI that answers the unknown verb with its help text and
//     exit 0, documents malformed in each way the boot door refuses, and a sufficient one placed in
//     every layout an npm install produces;
//   * fake stale service definitions under the fixture HOME, which init must not read;
//   * that init runs the capability probe and NOT a version comparison (the stub records its argv,
//     and `--version` is never asked for);
//   * that init installs, upgrades, starts, stops and restarts nothing: `npm`, `npx`,
//     `telepty-install`, `launchctl`, `systemctl` and `kill` are tripwires on the fixture PATH and
//     must never be invoked.
// No real telepty, daemon, session, registry or network exists in this file.
//
// ZERO SKIPS, ON EVERY OS (the Windows W1 gate forbids them, and a skip is a Windows behaviour that
// went unmeasured). Every test below is REGISTERED unconditionally and asserts its own platform's
// branch, exactly as tests/packaging/init-platform.test.mjs does:
//   * a stub is an extensionless shebang file on POSIX and a `.cmd` shim beside a `.js` body on
//     win32, because CreateProcess cannot run a shebang;
//   * POSIX keeps a hermetic PATH (the fixture bin and nothing else; the one FULL init adds the
//     same five /bin symlinks tests/packaging/installed-boot-selector.test.mjs runs a full init
//     with). win32's step 1 probes jq.exe/python.exe by RUNNING them and resolves Git for Windows
//     bash before it reaches the telepty check, and those are real host tools — so win32 appends
//     ONLY the ambient directories that hold jq.exe, python.exe, bash.exe or git.exe (review F8),
//     never the whole ambient PATH, so a contributor's own telepty cannot decide a case (the one
//     FULL init also appends a directory this file creates holding ONLY a `node` launcher — node.cmd
//     and an extensionless shell shim, each running process.execPath by absolute path — the win32
//     stand-in for POSIX's `node` symlink; r6, review R6-5: never Node's own directory, whose
//     npm/npx siblings Git bash could run by bare name past the `.cmd` tripwires);
//   * the service case writes a launchd plist on darwin and a systemd unit on linux, and asserts
//     silence on every platform, because init inspects no service definition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../..");
const INIT_CLI = join(REPO, "bin/init/cli.mjs");
const MIN_VERSION = "0.11.1";
const INSTALL_COMMAND = "npm i -g @dmsdc-ai/aigentry-telepty@latest";
const ORCHESTRATOR_PACKAGE = "@dmsdc-ai/aigentry-orchestrator";
const TELEPTY_PACKAGE = "@dmsdc-ai/aigentry-telepty";
const WIN = process.platform === "win32";
/** Anything named here would mean init tried to change the host. */
const TRIPWIRES = ["npm", "npx", "telepty-install", "launchctl", "systemctl", "kill", "brew", "apt-get"] as const;
/** The POSIX tools a FULL init's step 5 scaffold runs, and nothing else. */
const SCAFFOLD_TOOLS: readonly (readonly [string, string])[] = [["bash", "/bin/bash"], ["sh", "/bin/sh"],
  ["mkdir", "/bin/mkdir"], ["cp", "/bin/cp"], ["dirname", "/usr/bin/dirname"]];
/** The sealed one-line document a sufficient telepty prints. */
const SEALED = { schema: "telepty-boot-capabilities-v1", verbs: ["allow-create-v1", "inject-bound-v1"],
  viewer_detach: "nondeleting-v1" };
/** The help text an older telepty prints for an unknown verb, before exiting 0. */
const OLD_HELP = "telepty — session multiplexer\nUsage: telepty <command> [options]\n  inject, send-key, list, read-screen, session\n";
const PRINT_SEALED = `console.log(JSON.stringify(${JSON.stringify(SEALED)}));`;
/** The 0.2.5-0.2.7 global install's own nested tree, where its dependency copy of telepty lived. */
const GLOBAL_INSTALL = `prefix/lib/node_modules/${ORCHESTRATOR_PACKAGE}`;
const NESTED_BIN = `${GLOBAL_INSTALL}/node_modules/.bin`;
/** The sentence r2's init printed for a stale service definition; r3 inspects none, so it never appears. */
const SERVICE_WARNING = /A telepty service definition starts a program that does not exist or is not executable/;

function insideGit(dir: string): boolean {
  for (let cur = dir; ; cur = dirname(cur)) {
    if (existsSync(join(cur, ".git"))) return true;
    if (cur === dirname(cur)) return false;
  }
}

/**
 * CI root cause (Ubuntu, r3): a FULL init takes the native-capture lock in the workspace, and
 * bin/init/native-capture.mjs refuses one under a symlinked, foreign-owned or group/world-writable
 * ancestor. Ubuntu's os.tmpdir() is /tmp (mode 1777), so the full-init case exited 1 there, while
 * macOS's per-user /var/folders/.../T passed. The same root rule tests/packaging/init-platform.test.mjs
 * uses: INIT_PLATFORM_TEST_ROOT, else the first of os.tmpdir() and the home directory that is
 * outside Git and, on POSIX, has a lock-safe ancestry. win32 verifies its lock by ACL instead.
 */
function lockAncestryOk(dir: string): boolean {
  if (WIN) return true;
  for (let cur = dir; ; cur = dirname(cur)) {
    const s = lstatSync(cur);
    if (!s.isDirectory() || s.isSymbolicLink() || !(s.uid === 0 || s.uid === process.getuid!()) || (s.mode & 0o022) !== 0) return false;
    if (cur === dirname(cur)) return true;
  }
}
function fullInitBase(): string {
  const explicit = process.env.INIT_PLATFORM_TEST_ROOT;
  const candidates = explicit ? [explicit] : [tmpdir(), homedir()];
  for (const candidate of candidates) {
    const root = realpathSync.native(candidate);
    if (!insideGit(root) && lockAncestryOk(root)) return root;
  }
  throw new Error(`no full-init root outside Git with a lock-safe ancestry among ${candidates.join(", ")}; set INIT_PLATFORM_TEST_ROOT`);
}

/**
 * win32 (review F8): the ambient directories holding a real tool init's win32 step 1 RUNS (jq.exe,
 * python.exe) or resolves Git for Windows bash from (bash.exe, git.exe) — and nothing else from the
 * ambient PATH. A directory among them that also holds a telepty would decide these cases, so that
 * one host shape fails loudly by name instead of silently changing an outcome.
 */
function windowsToolDirs(): string[] {
  const dirs: string[] = [];
  for (const entry of (process.env.PATH || "").split(delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    if (dir === "" || dirs.includes(dir)) continue;
    if (["jq.exe", "python.exe", "bash.exe", "git.exe"].some((exe) => existsSync(join(dir, exe)))) dirs.push(dir);
  }
  const shared = dirs.filter((dir) => ["telepty.cmd", "telepty.exe", "telepty.bat", "telepty.com"]
    .some((name) => existsSync(join(dir, name))));
  assert.deepEqual(shared, [], "a directory that supplies jq/python/Git also holds a telepty; it would decide these cases");
  return dirs;
}

/**
 * win32 CI 910 (r5): the FULL init's step 5 runs bin/install-instructions.sh under Git bash, and that
 * script calls `node` (substitute_tokens). POSIX symlinks process.execPath into the fixture bin for
 * it; win32 cannot rely on a symlink. r6 (review R6-5): r5 appended the directory of
 * process.execPath, which also holds Node's npm/npx — and their extensionless shell shims, which Git
 * bash runs by bare name, past the `.cmd` tripwires. So win32 now gets a directory this function
 * creates and that holds nothing else: `node.cmd` for cmd.exe and an extensionless `node` shell shim
 * for Git bash, each running the node this suite already runs by its absolute path. Nothing in it
 * can be a telepty, npm or npx. It goes LAST, after the fixture bin, as in r5.
 */
function windowsNodeDir(root: string): string {
  const node = process.execPath;
  assert.ok(!/["'%]/.test(node), `process.execPath ${node} cannot be quoted safely in the node launchers`);
  const dir = join(root, "node-launcher");
  mkdirSync(dir);
  writeFileSync(join(dir, "node.cmd"), `@echo off\r\n"${node}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  writeFileSync(join(dir, "node"), `#!/bin/sh\nexec '${node.replace(/\\/g, "/")}' "$@"\n`, { mode: 0o755 });
  return dir;
}

interface Options {
  /** The telepty stub's JS body, or undefined for no telepty at all. */
  readonly telepty?: string;
  /** Where the telepty stub goes, relative to the fixture root; that directory goes FIRST on PATH. */
  readonly teleptyDir?: string;
  /** Directories to create under the fixture root before init runs (a fake orchestrator install). */
  readonly dirs?: readonly string[];
  /** Provide the POSIX scaffold tools, for the one case that runs a FULL init. */
  readonly scaffold?: boolean;
}

interface Fixture {
  readonly root: string;
  readonly bin: string;
  readonly home: string;
  readonly ws: string;
  readonly argvLog: string;
  readonly tripwireLog: string;
  readonly path: string;
}

/** A stub the fixture PATH resolves on every OS. One JS body, two placements. */
function writeStub(root: string, dir: string, name: string, js: string): void {
  if (WIN) {
    const body = join(root, `${name}.stub.js`);
    writeFileSync(body, `${js}\n`);
    writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${body}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
    return;
  }
  writeFileSync(join(dir, name), `#!${process.execPath}\n${js}\n`, { mode: 0o755 });
}

function fixture(options: Options = {}): Fixture {
  const base = options.scaffold === true ? fullInitBase() : tmpdir();
  assert.ok(!insideGit(base), `${base} is inside a Git working tree; init refuses to write into one`);
  // CANONICAL, because the product reports what realpath() gives it: on win32 the temp root is
  // often an 8.3 short name (…\RUNNER~1\…) and the two spellings would not compare equal.
  const root = realpathSync.native(mkdtempSync(join(base, "telepty-requirement-1293-")));
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const dir of [bin, home]) mkdirSync(dir, { recursive: true });
  for (const dir of options.dirs ?? []) mkdirSync(join(root, dir), { recursive: true });
  const argvLog = join(root, "telepty-argv.jsonl");
  const tripwireLog = join(root, "tripwires.log");
  writeFileSync(argvLog, "");
  writeFileSync(tripwireLog, "");
  // POSIX step 1 checks these for presence only; win32 RUNS jq.exe/python.exe and Git bash, which
  // the ambient tool directories supply for real.
  if (!WIN) {
    for (const tool of ["jq", "python3", "claude", "cmux"]) writeStub(root, bin, tool, `console.log("${tool} 9.9.9");`);
    if (options.scaffold === true) {
      // Exactly the allowlisted set tests/packaging/installed-boot-selector.test.mjs runs a full
      // init with (PATH = this directory and nothing else), which that job's init completes on
      // both POSIX legs — so a full init needs no more than this, and nothing here is ambient.
      for (const [name, target] of SCAFFOLD_TOOLS) symlinkSync(target, join(bin, name));
      symlinkSync(process.execPath, join(bin, "node"));
      symlinkSync(INIT_CLI, join(bin, "aigentry-orchestrator"));
    }
  }
  for (const tool of TRIPWIRES) {
    writeStub(root, bin, tool, `require("node:fs").appendFileSync(${JSON.stringify(tripwireLog)}, ` +
      `JSON.stringify(["${tool}", ...process.argv.slice(2)]) + "\\n"); process.exit(99);`);
  }
  const teleptyDir = options.teleptyDir === undefined ? bin : join(root, options.teleptyDir);
  if (options.telepty !== undefined) {
    mkdirSync(teleptyDir, { recursive: true });
    writeStub(root, teleptyDir, "telepty", `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ argv: process.argv.slice(2), file: __filename }) + "\\n");
${options.telepty}`);
  }
  const dirs = [...(options.teleptyDir === undefined ? [] : [teleptyDir]), bin, ...(WIN ? windowsToolDirs() : [])];
  if (WIN && options.scaffold === true) dirs.push(windowsNodeDir(root));
  return { root, bin, home, ws: join(root, "ws"), argvLog, tripwireLog, path: dirs.join(delimiter) };
}

/**
 * The ambient environment MINUS everything that could decide an outcome: the fixture's HOME,
 * AIGENTRY_HOME, workspace, temp roots, PATH and TELEPTY replace it. Everything else (PATHEXT,
 * SystemRoot, COMSPEC, SystemDrive on win32) is kept, because a Node child needs it.
 */
function envFor(f: Fixture): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(TELEPTY|HOME|USERPROFILE|TMPDIR|TMP|TEMP|PATH|NODE_OPTIONS)$/i.test(key)) continue;
    if (/^(AIGENTRY_|XDG_|TELEPTY_)/i.test(key)) continue;
    env[key] = value;
  }
  env.HOME = f.home;
  env.USERPROFILE = f.home;
  env.AIGENTRY_HOME = join(f.home, ".aigentry");
  env.PATH = f.path;
  env.TMPDIR = f.root;
  env.TMP = f.root;
  env.TEMP = f.root;
  return env;
}

function runInit(f: Fixture, args: readonly string[] = ["--dry-run"], extra: NodeJS.ProcessEnv = {}):
  { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [INIT_CLI, "init", "--yes", ...args, "--workspace", f.ws],
    { cwd: f.root, env: { ...envFor(f), ...extra }, encoding: "utf8", timeout: 600_000, windowsHide: true });
  assert.ifError(r.error);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const lines = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
const probes = (f: Fixture): unknown[] => lines(f.argvLog).map((l) => (JSON.parse(l) as { argv: unknown }).argv);
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** Every warning shape must produce exactly ONE message carrying the same load-bearing facts. */
function assertOneRequirementMessage(out: { stdout: string; stderr: string }, observed: RegExp, label: string): void {
  const text = `${out.stdout}\n${out.stderr}`;
  assert.equal(occurrences(text, INSTALL_COMMAND), 1, `${label}: the install command must appear exactly once:\n${text}`);
  assert.equal(occurrences(text, `${MIN_VERSION} or later`), 1, `${label}: the minimum version must be named once`);
  assert.match(out.stderr, observed, `${label}: the observed fact is not named:\n${out.stderr}`);
  assert.match(out.stderr, /declares NO dependency on @dmsdc-ai\/aigentry-telepty/, `${label}: the requirement is not explicit`);
  assert.match(out.stderr, /installs, upgrades, starts, stops and restarts nothing/, `${label}: the no-self-repair promise is missing`);
  assert.match(out.stderr, /allow-create-v1 and inject-bound-v1/, `${label}: the required capability is not named`);
  // The exit-code contract, stated per door and per OPERATION (review R5, F6), and no wider than
  // the code: dispatch's 78 TELEPTY_CLI_UNAVAILABLE is a command that cannot be STARTED at
  // registration (tests/dispatch/telepty-cli-unavailable.test.ts), BOUND_INJECT_UNSUPPORTED is bound
  // delivery to a busy worker, and boot's exit 3 is its own check of the CLI on PATH
  // (tests/packaging/orchestrator-boot-wizard.test.mjs, "1293").
  assert.match(out.stderr, /dispatch exits 78: TELEPTY_CLI_UNAVAILABLE when the telepty command cannot be started at registration, BOUND_INJECT_UNSUPPORTED when bound delivery to a busy worker finds no inject-bound-v1/,
    `${label}: the dispatch refusal codes are not stated by operation`);
  assert.match(out.stderr, /orchestrator-boot exits 3 \(boot preflight UNSUPPORTED\) when its own check of the telepty on PATH fails/,
    `${label}: the boot refusal code is missing`);
  // r4 (review R4-7): every exit path the message names, and each has a test — boot 3 and the earlier
  // supervised exit 2 in tests/packaging/orchestrator-boot-wizard.test.mjs ("1293"), the two 78s above.
  assert.match(out.stderr, /inject-bound-v1 is not part of that check — and a supervised boot exits 2 earlier, when 'telepty allow-check' does not admit it/,
    `${label}: the supervised boot refusal or the boot/dispatch capability boundary is missing`);
  // The 0.2.0 wording this replaces claimed telepty was a declared dependency installed nested
  // under the package. That claim is false and must never come back.
  assert.doesNotMatch(out.stderr, /declared dependency of this package/, `${label}: the message still claims a dependency`);
}

function assertChangedNothing(f: Fixture, label: string): void {
  assert.deepEqual(lines(f.tripwireLog), [], `${label}: init invoked an installer, supervisor or signal`);
  assert.equal(existsSync(f.ws), false, `${label}: --dry-run created the workspace`);
  assert.equal(existsSync(join(f.home, ".aigentry")), false, `${label}: --dry-run created AIGENTRY_HOME`);
}

/** A sufficient telepty: one info line, no requirement message, no service message, one probe. */
function assertHealthy(f: Fixture, r: { status: number | null; stdout: string; stderr: string }, label: string): void {
  assert.equal(r.status, 0, `${label}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /telepty found at .*; its boot-capabilities declare allow-create-v1 and inject-bound-v1/, label);
  assert.equal(occurrences(`${r.stdout}\n${r.stderr}`, INSTALL_COMMAND), 0,
    `${label}: a sufficient telepty must not be told to install or upgrade:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /MIGRATION|telepty/i, `${label}: a telepty warning was printed:\n${r.stderr}`);
  assertChangedNothing(f, label);
  assert.deepEqual(probes(f), [["boot-capabilities"]], `${label}: the telepty argv is not one capability probe`);
}

/**
 * A service definition the platform's own supervisor reads, written under the fixture HOME: a
 * launchd plist on darwin (`Program`/`ProgramArguments` strings, XML-escaped) and a systemd user
 * unit on linux (`ExecStart=`, double-quoted when `quoted`). win32 inspects none, so none is
 * written there. Returns the file, or null on win32.
 */
function writeService(f: Fixture, name: string, argv: readonly string[], quoted: boolean): string | null {
  const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (process.platform === "darwin") {
    const file = join(f.home, "Library/LaunchAgents", `${name}.plist`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n' +
      `  <key>Label</key><string>${name}</string>\n  <key>ProgramArguments</key>\n  <array>\n` +
      argv.map((a) => `    <string>${xml(a)}</string>\n`).join("") + "  </array>\n</dict></plist>\n");
    return file;
  }
  if (process.platform === "linux") {
    const file = join(f.home, ".config/systemd/user", `${name}.service`);
    mkdirSync(dirname(file), { recursive: true });
    const words = argv.map((a) => (quoted ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a)).join(" ");
    writeFileSync(file, `[Unit]\nDescription=${name}\n\n[Service]\nExecStart=${words}\nRestart=always\n\n` +
      "[Install]\nWantedBy=default.target\n");
    return file;
  }
  return null;
}

// ── the capability verdicts: one message each, and the probe is a capability read ────────────────
//
// Each row is a telepty answer init must map to exactly one message. CASES are the answers that
// ESTABLISH a missing or older telepty, and only they carry the install command (r3).
const CASES: readonly (readonly [string, string | undefined, RegExp])[] = [
  ["missing", undefined, /telepty is not on PATH/],
  ["sealed document without inject-bound-v1",
    `console.log(JSON.stringify({ ...${JSON.stringify(SEALED)}, verbs: ["allow-create-v1"] }));`,
    /does not declare inject-bound-v1 in its boot-capabilities/],
  ["sealed document without allow-create-v1",
    `console.log(JSON.stringify({ ...${JSON.stringify(SEALED)}, verbs: ["inject-bound-v1"] }));`,
    /does not declare allow-create-v1 in its boot-capabilities/],
  ["deleting viewer detach",
    `console.log(JSON.stringify({ ...${JSON.stringify(SEALED)}, viewer_detach: "deleting-v1" }));`,
    /declares viewer_detach "deleting-v1", not nondeleting-v1/],
];

// r3 (review answer a, R3-6): every other answer establishes nothing about which telepty this is — a
// wrapper whose interpreter fails exits non-zero or prints prose just like an old CLI — so init
// reports it as inconclusive and gives NO install or replacement advice. Every row below FAILS on r2,
// which printed the install command for each. The last four are review R3 (init applies the BOOT
// document rule, not a looser one) and review R8 (a malformed diagnostic field must not turn an
// optional warning into a fatal exit).
const INCONCLUSIVE: readonly (readonly [string, string, RegExp])[] = [
  ["old CLI help + exit 0", `process.stdout.write(${JSON.stringify(OLD_HELP)});`,
    /did not print exactly one line \(an older telepty prints its help text and exits 0/],
  ["another schema",
    `console.log(JSON.stringify({ ...${JSON.stringify(SEALED)}, schema: "telepty-capabilities-v0" }));`,
    /printed schema "telepty-capabilities-v0", not telepty-boot-capabilities-v1/],
  ["non-zero exit", "process.exit(3);", /'telepty boot-capabilities' exited 3/],
  ["an extra property the boot door refuses",
    `console.log(JSON.stringify({ ...${JSON.stringify(SEALED)}, extra: 1 }));`,
    /did not print a telepty-boot-capabilities-v1 document with exactly schema\/verbs\/viewer_detach/],
  ["duplicate verbs",
    `console.log(JSON.stringify({ ...${JSON.stringify(SEALED)}, verbs: ["allow-create-v1", "inject-bound-v1", "inject-bound-v1"] }));`,
    /did not print a telepty-boot-capabilities-v1 document with exactly schema\/verbs\/viewer_detach/],
  ["a sufficient document over two lines",
    `console.log("\\n" + JSON.stringify(${JSON.stringify(SEALED)}));`,
    /did not print exactly one line/],
  // R8: `schema` is an object whose toString is null, so `String(doc.schema)` THROWS — and main()'s
  // rejection handler would turn an OPTIONAL dependency warning into exit 1.
  // r4 (review R4-3): a null viewer_detach makes the document malformed, even when a verb is also
  // missing. FAILS on r3, which reported the missing verb as established and printed the install command.
  ["null viewer_detach",
    `console.log(JSON.stringify({ ...${JSON.stringify(SEALED)}, verbs: ["allow-create-v1"], viewer_detach: null }));`,
    /unique string verbs and a string viewer_detach; it printed /],
  ["a schema value that cannot be coerced to a string",
    `process.stdout.write(JSON.stringify({ schema: { toString: null }, verbs: ${JSON.stringify(SEALED.verbs)}, ` +
    `viewer_detach: "nondeleting-v1" }) + "\\n");`,
    /printed schema \{"toString":null\}, not telepty-boot-capabilities-v1/],
];

for (const [label, stub, observed] of INCONCLUSIVE) {
  test(`1293 r3: a ${label} telepty is reported as inconclusive, with no install advice, and changes nothing`, () => {
    const f = fixture({ telepty: stub });
    try {
      const r = runInit(f);
      assert.equal(r.status, 0, `${label}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
      const text = `${r.stdout}\n${r.stderr}`;
      assert.match(r.stderr, observed, `${label}: the observed fact is not named:\n${r.stderr}`);
      assert.match(r.stderr, /So init could not establish whether the telepty on PATH \(.*\) declares what the later doors need/,
        `${label}: the probe is not reported as inconclusive:\n${r.stderr}`);
      assert.equal(occurrences(text, INSTALL_COMMAND), 0, `${label}: an inconclusive probe drew install advice:\n${text}`);
      assert.equal(occurrences(text, `${MIN_VERSION} or later`), 1, `${label}: the requirement must be named once, as a fact`);
      assert.match(r.stderr, /Run 'telepty boot-capabilities' yourself to see its answer/, `${label}: the one harmless instruction is missing`);
      assert.match(r.stderr, /installs, upgrades, starts, stops and restarts nothing/, `${label}: the no-self-repair promise is missing`);
      assert.doesNotMatch(r.stdout, /telepty found at/, `${label}: an inconclusive answer was accepted`);
      assertChangedNothing(f, label);
      assert.deepEqual(probes(f), [["boot-capabilities"]], `${label}: the telepty argv is not one capability probe`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

for (const [label, stub, observed] of CASES) {
  test(`1293: a ${label} telepty produces ONE precise requirement message and changes nothing`, () => {
    const f = fixture(stub === undefined ? {} : { telepty: stub });
    try {
      const r = runInit(f);
      // telepty is a warning, not a hard dependency: the control workspace is complete without it.
      assert.equal(r.status, 0, `${label}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
      assertOneRequirementMessage(r, observed, label);
      assertChangedNothing(f, label);
      // No migration claim: this telepty does not live inside an orchestrator install.
      assert.doesNotMatch(r.stderr, /MIGRATION \(aigentry-orchestrator/, `${label}: a migration was claimed`);
      // The capability probe, not a version comparison, and exactly once.
      assert.deepEqual(probes(f), stub === undefined ? [] : [["boot-capabilities"]],
        `${label}: the telepty argv is not one capability probe`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("1293: a sufficient telepty is accepted silently — no requirement message, still nothing installed", () => {
  const f = fixture({ telepty: PRINT_SEALED });
  try {
    assertHealthy(f, runInit(f), "sufficient");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("1293 r2: a capability document over the boot door's 4096-byte bound is not measured, and draws no advice", () => {
  // review F5: boot reads at most 4096 bytes and refuses anything longer as an unfinished probe; init
  // used to accept the same valid one-line document at 5 KiB and report OK where boot refuses.
  const f = fixture({ telepty: `console.log(JSON.stringify({ ...${JSON.stringify(SEALED)}, ` +
    `verbs: [...${JSON.stringify(SEALED.verbs)}, ...Array.from({ length: 400 }, (_, i) => "pad-verb-" + i)] }));` });
  try {
    const r = runInit(f);
    assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /'telepty boot-capabilities' printed more than 4096 bytes, more than the boot door reads/, r.stderr);
    assert.doesNotMatch(r.stdout, /telepty found at/, "an over-long document was accepted");
    assert.equal(occurrences(`${r.stdout}\n${r.stderr}`, INSTALL_COMMAND), 0, "an unmeasured probe drew install advice");
    assertChangedNothing(f, "over-long document");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── review F1 (MAJOR): a healthy telepty is never told to reinstall, wherever it lives ──────────
//
// Candidate r1 walked up from the telepty it found and called any telepty beside an orchestrator
// install "the copy npm installed as this package's dependency". That is a guess about ownership,
// and it is wrong for the most ordinary layout there is: both packages installed globally into one
// npm prefix. r2 deletes the guess. The first row FAILS on r1 (MIGRATION warning plus the install
// command); every row must now print one info line and nothing else. The other two rows are r1's
// own nested shapes: a SUFFICIENT telepty there is still a working telepty, and init says nothing
// it cannot measure about what a later install of that tree will do.
const LAYOUTS: readonly (readonly [string, string, string])[] = [
  // label, the orchestrator install that exists, where the telepty stub lives
  ["a global telepty installed separately into the SAME npm prefix as the orchestrator",
    WIN ? `gp/node_modules/${ORCHESTRATOR_PACKAGE}` : `gp/lib/node_modules/${ORCHESTRATOR_PACKAGE}`,
    WIN ? `gp/node_modules/${TELEPTY_PACKAGE}/bin` : `gp/lib/node_modules/${TELEPTY_PACKAGE}/bin`],
  ["a telepty inside a global orchestrator install's own nested tree", GLOBAL_INSTALL, NESTED_BIN],
  ["a hoisted local install's telepty, a sibling of the orchestrator",
    `project/node_modules/${ORCHESTRATOR_PACKAGE}`, "project/node_modules/.bin"],
];

for (const [label, installDir, teleptyDir] of LAYOUTS) {
  test(`1293 r2: ${label} is healthy and is not told to reinstall`, () => {
    const made = fixture({ telepty: PRINT_SEALED, teleptyDir, dirs: [installDir] });
    let f = made;
    try {
      if (!WIN && teleptyDir.startsWith("gp/")) {
        // POSIX npm links <prefix>/bin/telepty to the package's bin file with a REAL symlink, and
        // r1 followed it (realpath) into the shared node_modules. Reproduce exactly that.
        const shims = join(made.root, "gp/bin");
        mkdirSync(shims, { recursive: true });
        symlinkSync(`../lib/node_modules/${TELEPTY_PACKAGE}/bin/telepty`, join(shims, "telepty"));
        f = { ...made, path: [shims, made.bin].join(delimiter) };
      }
      // A service definition that starts this same, existing telepty is healthy too: silence.
      const program = join(made.root, teleptyDir, WIN ? "telepty.cmd" : "telepty");
      writeService(f, "com.aigentry.telepty", [program, "daemon"], true);
      assertHealthy(f, runInit(f), label);
    } finally {
      rmSync(made.root, { recursive: true, force: true });
    }
  });
}

test("1293 r2: TELEPTY is not judged by init — a bare command name with a healthy PATH draws no message", () => {
  // review F3: r1 tested TELEPTY with fs.existsSync relative to init's cwd, so the valid
  // TELEPTY=telepty (a bare name dispatch resolves through PATH) was called a missing file and given
  // install advice. init now asks only about the telepty on PATH; this FAILS on r1.
  const f = fixture({ telepty: PRINT_SEALED });
  try {
    assertHealthy(f, runInit(f, ["--dry-run"], { TELEPTY: "telepty" }), "bare TELEPTY");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── r3 (review R3-3/4/5/8, task item 6): init reads no service definition ───────────────────────
test("1293 r3: a stale telepty service definition draws nothing from init — services are checked by hand", () => {
  // r2 read launchd plists and systemd units and warned when the program path they named was gone.
  // A single on-disk file cannot establish what the service manager will start (drop-ins, unit
  // shadowing, a RootDirectory, a nested plist dictionary), so that check could warn for a healthy
  // service. r3 deletes it and keeps the manual check in README.md and CHANGELOG.md. This FAILS on
  // r2, which printed the service warning for exactly these definitions.
  const f = fixture({ telepty: PRINT_SEALED });
  try {
    const spaced = join(f.root, "old & prefix", "lib/node_modules", ORCHESTRATOR_PACKAGE, "node_modules/.bin/telepty");
    const plain = join(f.root, NESTED_BIN, "telepty");
    writeService(f, "com.aigentry.telepty", [spaced, "daemon"], true);
    writeService(f, "telepty-plain", [plain, "daemon"], false);
    const r = runInit(f);
    assert.doesNotMatch(r.stderr, SERVICE_WARNING, `init still inspects service definitions:\n${r.stderr}`);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /service definition|telepty-install/i, `init printed a service sentence:\n${r.stderr}`);
    assertHealthy(f, r, "stale service definitions");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("1293 r2: a telepty init cannot probe through the cmd.exe shim door is reported as unmeasured, per platform", () => {
  // review F8 / R4: the path carries `!`, which winRun refuses to quote for cmd.exe. win32 must say
  // the capability was NOT measured and give no install advice; POSIX has no shim door and probes it.
  const f = fixture({ telepty: PRINT_SEALED, teleptyDir: "tools!bin" });
  try {
    const r = runInit(f);
    if (WIN) {
      assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /init cannot probe .*tools!bin.* through the cmd\.exe shim door/, r.stderr);
      assert.match(r.stderr, /so the capability was NOT measured/, r.stderr);
      assert.equal(occurrences(`${r.stdout}\n${r.stderr}`, INSTALL_COMMAND), 0, "an unmeasured probe drew install advice");
      assert.deepEqual(probes(f), [], "the refused shim was run anyway");
      assertChangedNothing(f, "unsupported shim path");
    } else {
      assertHealthy(f, r, "a `!` in a POSIX path");
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── review R6: the full requirement is read once per run, not twice ──────────────────────────────
test("1293: a FULL init prints the requirement once on the console and keeps it in full in the guide", () => {
  // Not --dry-run: warn() prints at step 1 and step 7 used to reprint every stored warning, so the
  // operator read the whole requirement — and its one command — twice. The saved guide is still the
  // durable copy and still carries the full text.
  const f = fixture({ scaffold: true });
  try {
    const r = runInit(f, []);
    assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    const shown = `${r.stdout}\n${r.stderr}`;
    assert.equal(occurrences(shown, INSTALL_COMMAND), 1,
      `the install command must reach the console exactly once:\n${shown}`);
    assert.equal(occurrences(shown, `${MIN_VERSION} or later`), 1, "the version floor must reach the console once");
    assert.match(r.stdout, /warning\(s\), printed above and written in full to /, "the console does not point at the guide");
    const guide = readFileSync(join(f.ws, "GETTING-STARTED.md"), "utf8");
    assert.equal(occurrences(guide, INSTALL_COMMAND), 1, "the guide must carry the full requirement");
    assert.match(guide, /telepty is not on PATH/, "the guide must carry the observed fact");
    assert.deepEqual(lines(f.tripwireLog), [], "a full init invoked an installer, supervisor or signal");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── the source contract: the three doors agree, and none of them compares a version string ───────
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
  // r2 (review F1): no ownership guess survives in the init door.
  assert.ok(!init.includes("orchestratorInstallRoot") && !init.includes("@dmsdc-ai/aigentry-orchestrator\""),
    "init still guesses which install a telepty belongs to");
  // r3 (task item 6): the runtime service inspection is deleted, not narrowed.
  assert.ok(!init.includes("LaunchAgents") && !init.includes("systemd") && !init.includes("ExecStart"),
    "init still reads service definitions");
  // The documented dispatch contract and the code must name the SAME refusal for a telepty that
  // cannot run (review R5): the usage text and the CLI both say exit 78 TELEPTY_CLI_UNAVAILABLE.
  const dispatch = readFileSync(join(REPO, "src/dispatch/cli.ts"), "utf8");
  const usage = readFileSync(join(REPO, "src/dispatch/usage.ts"), "utf8");
  assert.ok(dispatch.includes('const TELEPTY_UNAVAILABLE = "TELEPTY_CLI_UNAVAILABLE"'),
    "dispatch does not define the missing-CLI refusal by name");
  assert.ok(usage.includes("exit 78") && usage.includes("TELEPTY_CLI_UNAVAILABLE"),
    "the dispatch usage does not document exit 78 TELEPTY_CLI_UNAVAILABLE");
});
