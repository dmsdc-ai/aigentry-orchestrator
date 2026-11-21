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
// It is also the MIGRATION door. An install of 0.2.5-0.2.7 left a real, runnable telepty inside
// this package's own tree — npm hoists a dependency's bins — so a host could have been using
//   <project>/node_modules/.bin/telepty                                         (local install)
//   <prefix>/lib/node_modules/@dmsdc-ai/aigentry-orchestrator/node_modules/…    (global install)
// through PATH, through an explicit TELEPTY, or through a launchd/systemd program path. For such a
// host 0.2.8 removes the only telepty it had, so init DETECTS that and prints one instruction. It
// installs, repairs, starts, stops and restarts nothing.
//
// WHAT IS MEASURED HERE, and nothing else:
//   * the real bin/init/cli.mjs of this checkout, as a subprocess, in a fresh HOME and a fresh
//     workspace, with `--dry-run` so nothing is written anywhere (one case runs a FULL init on
//     purpose — the review R6 case — and asserts the console states the command once);
//   * a FAKE telepty — absent, an older CLI that answers the unknown verb with its help text and
//     exit 0, documents malformed in each way the boot door refuses, a sufficient one, and a
//     sufficient one that lives inside a fake orchestrator install;
//   * fake user service definitions under the fixture HOME;
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
//     the ambient PATH, after asserting that the ambient PATH resolves no telepty of its own,
//     which would otherwise decide these cases;
//   * the service-target case asserts the launchd directory on darwin, the systemd user directory
//     on linux, and the "not inspected on this platform" sentence on win32.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../..");
const INIT_CLI = join(REPO, "bin/init/cli.mjs");
const MIN_VERSION = "0.11.1";
const INSTALL_COMMAND = "npm i -g @dmsdc-ai/aigentry-telepty@latest";
const ORCHESTRATOR_PACKAGE = "@dmsdc-ai/aigentry-orchestrator";
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
/** The fake global install the migration cases place a nested telepty inside. */
const GLOBAL_INSTALL = `prefix/lib/node_modules/${ORCHESTRATOR_PACKAGE}`;
const NESTED_BIN = `${GLOBAL_INSTALL}/node_modules/.bin`;

function insideGit(dir: string): boolean {
  for (let cur = dir; ; cur = dirname(cur)) {
    if (existsSync(join(cur, ".git"))) return true;
    if (cur === dirname(cur)) return false;
  }
}

/**
 * The ambient PATH must not resolve a telepty of its own wherever it is appended, or it — not the
 * fixture — would answer the capability probe in the cases that place no stub. Resolved the way
 * each platform's own door resolves it, so this check cannot disagree with the product.
 */
function assertNoAmbientTelepty(): void {
  const exts = WIN
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())
    : [""];
  const found: string[] = [];
  for (const entry of (process.env.PATH || "").split(delimiter)) {
    if (entry === "") continue;
    for (const ext of exts) {
      const file = join(entry.replace(/^"(.*)"$/, "$1"), `telepty${ext}`);
      try {
        if (statSync(file).isFile()) found.push(file);
      } catch {
        // not present in this PATH entry
      }
    }
  }
  assert.deepEqual(found, [], "the ambient PATH already resolves a telepty; it would decide these cases");
}

interface Options {
  /** The telepty stub's JS body, or undefined for no telepty at all. */
  readonly telepty?: string;
  /** Where the telepty stub goes, relative to the fixture root; that directory goes FIRST on PATH. */
  readonly teleptyDir?: string;
  /** Directories to create under the fixture root before init runs (the fake orchestrator install). */
  readonly dirs?: readonly string[];
  /** An explicit TELEPTY override, relative to the fixture root. */
  readonly override?: string;
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
  readonly override: string | null;
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
  const base = tmpdir();
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
  // the ambient PATH supplies for real.
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
  if (WIN) assertNoAmbientTelepty();
  const dirs = [...(options.teleptyDir === undefined ? [] : [teleptyDir]), bin,
    ...(WIN ? [process.env.PATH ?? ""] : [])];
  return { root, bin, home, ws: join(root, "ws"), argvLog, tripwireLog,
    path: dirs.filter((d) => d !== "").join(delimiter),
    override: options.override === undefined ? null : join(root, options.override) };
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
  if (f.override !== null) env.TELEPTY = f.override;
  return env;
}

function runInit(f: Fixture, args: readonly string[] = ["--dry-run"]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [INIT_CLI, "init", "--yes", ...args, "--workspace", f.ws],
    { cwd: f.root, env: envFor(f), encoding: "utf8", timeout: 600_000, windowsHide: true });
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
  // The exit-code contract, stated by OPERATION (review R5). init used to promise 78 while an
  // ordinary missing-CLI dispatch returned 6 after spending the whole registration budget;
  // dispatch now refuses that condition at once with 78 TELEPTY_CLI_UNAVAILABLE, and this says so.
  assert.match(out.stderr, /exit 78 — TELEPTY_CLI_UNAVAILABLE when the CLI cannot run at all, BOUND_INJECT_UNSUPPORTED/,
    `${label}: the dispatch refusal codes are not stated by operation`);
  assert.match(out.stderr, /orchestrator-boot with exit 3 boot preflight UNSUPPORTED/, `${label}: the boot refusal code is missing`);
  // The 0.2.0 wording this replaces claimed telepty was a declared dependency installed nested
  // under the package. That claim is false and must never come back.
  assert.doesNotMatch(out.stderr, /declared dependency of this package/, `${label}: the message still claims a dependency`);
}

function assertChangedNothing(f: Fixture, label: string): void {
  assert.deepEqual(lines(f.tripwireLog), [], `${label}: init invoked an installer, supervisor or signal`);
  assert.equal(existsSync(f.ws), false, `${label}: --dry-run created the workspace`);
  assert.equal(existsSync(join(f.home, ".aigentry")), false, `${label}: --dry-run created AIGENTRY_HOME`);
}

// ── the capability verdicts: one message each, and the probe is a capability read ────────────────
//
// Each row is a telepty answer init must map to exactly one refusal. The last four are review R3
// (init must apply the BOOT document rule, not a looser one, or it reports OK where boot refuses)
// and review R8 (a malformed diagnostic field must not turn an optional warning into a fatal exit).
const CASES: readonly (readonly [string, string | undefined, RegExp])[] = [
  ["missing", undefined, /telepty is not on PATH/],
  ["old CLI help + exit 0", `process.stdout.write(${JSON.stringify(OLD_HELP)});`,
    /did not print exactly one line \(an older telepty prints its help text and exits 0/],
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
  ["a schema value that cannot be coerced to a string",
    `process.stdout.write(JSON.stringify({ schema: { toString: null }, verbs: ${JSON.stringify(SEALED.verbs)}, ` +
    `viewer_detach: "nondeleting-v1" }) + "\\n");`,
    /printed schema \{"toString":null\}, not telepty-boot-capabilities-v1/],
];

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
    const r = runInit(f);
    assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /telepty found at .*; its boot-capabilities declare allow-create-v1 and inject-bound-v1/);
    assert.equal(occurrences(`${r.stdout}\n${r.stderr}`, INSTALL_COMMAND), 0,
      "a sufficient telepty must not be told to upgrade");
    assert.doesNotMatch(r.stderr, /MIGRATION \(aigentry-orchestrator/, "a healthy global telepty is not a migration");
    assertChangedNothing(f, "sufficient");
    assert.deepEqual(probes(f), [["boot-capabilities"]]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ── the migration door (review R1, MAJOR) ────────────────────────────────────────────────────────
//
// Both real shapes an install of 0.2.5-0.2.7 could leave behind. In each the telepty is SUFFICIENT,
// so nothing but its LOCATION can produce the warning — which is exactly the finding: the
// capability is fine and the file is still about to be deleted by the next install of that tree.
// Neither shape needs a symlink (win32 would need a privilege for one): the stub is placed INSIDE
// the tree and that directory goes first on PATH, which is what a real hoisted .bin entry does.
const SHAPES: readonly (readonly [string, string, string, string])[] = [
  // label, the orchestrator install that must exist, where telepty sits, the root init must name
  ["a global install's own nested tree", GLOBAL_INSTALL, NESTED_BIN, GLOBAL_INSTALL],
  ["a hoisted local install, where telepty is a SIBLING of the orchestrator",
    `project/node_modules/${ORCHESTRATOR_PACKAGE}`, "project/node_modules/.bin",
    `project/node_modules/${ORCHESTRATOR_PACKAGE}`],
];

for (const [label, installDir, teleptyDir, named] of SHAPES) {
  test(`1293: a telepty inside ${label} is detected as the 0.2.5-0.2.7 nested copy, and nothing is repaired`, () => {
    const f = fixture({ telepty: PRINT_SEALED, teleptyDir, dirs: [installDir] });
    try {
      const r = runInit(f);
      assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
      assertOneRequirementMessage(r, /MIGRATION \(aigentry-orchestrator 0\.2\.5-0\.2\.7 -> /, label);
      // The install directory it found, and the file that is about to disappear, both by name.
      assert.ok(r.stderr.includes(join(f.root, named)), `${label}: the orchestrator install is not named:\n${r.stderr}`);
      assert.match(r.stderr, /the next 'npm install', 'npm ci' or upgrade of that install deletes /, label);
      assert.match(r.stderr, /Do this BEFORE you upgrade/, label);
      // Detect-only: no installer, no supervisor, no signal, no write — and the nested copy's
      // capability was read exactly once, with the capability verb, never `--version`.
      assertChangedNothing(f, label);
      assert.deepEqual(probes(f), [["boot-capabilities"]], label);
      // It IS sufficient, so the message must not also claim a capability refusal.
      assert.doesNotMatch(r.stderr, /Its capability was also refused/, `${label}: a capability refusal was invented`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("1293: a stale TELEPTY override into the deleted nested copy is reported even when PATH is healthy", () => {
  // The exact post-upgrade state, and the one review R2 names: the PATH CLI is current, while the
  // value dispatch and every bin/*.sh wrapper actually run still points at the dependency copy
  // that the upgrade deleted. The override is NEVER probed — there is nothing to probe, and a
  // capability verdict about it would be invented — so the PATH telepty is read exactly once.
  const f = fixture({ telepty: PRINT_SEALED, dirs: [GLOBAL_INSTALL], override: `${NESTED_BIN}/telepty` });
  try {
    const r = runInit(f);
    assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    assertOneRequirementMessage(r, /The explicit TELEPTY .* names a file that does not exist/, "stale override");
    assert.match(r.stderr, /satisfies the requirement, but it is not what every door uses/, "stale override");
    assert.ok(r.stderr.includes(join(f.root, GLOBAL_INSTALL)), `the orchestrator install is not named:\n${r.stderr}`);
    assert.match(r.stderr, /an install or upgrade of that tree deleted it/, "stale override");
    assertChangedNothing(f, "stale override");
    assert.deepEqual(probes(f), [["boot-capabilities"]], "exactly the PATH telepty is probed, exactly once");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("1293: a user service definition whose program path is the nested telepty is reported, per platform", () => {
  // darwin reads ~/Library/LaunchAgents, linux reads ~/.config/systemd/user, and win32 has no such
  // per-user directory for telepty — so win32 says it inspected none rather than guessing at one.
  const f = fixture({ telepty: PRINT_SEALED, teleptyDir: NESTED_BIN, dirs: [GLOBAL_INSTALL] });
  try {
    const target = join(f.root, NESTED_BIN, WIN ? "telepty.cmd" : "telepty");
    const definition = process.platform === "darwin"
      ? { file: join(f.home, "Library/LaunchAgents/ai.dmsdc.telepty.plist"), dir: join(f.home, "Library/LaunchAgents"),
        text: `<plist><dict><key>ProgramArguments</key><array><string>${target}</string><string>daemon</string></array></dict></plist>\n` }
      : process.platform === "linux"
        ? { file: join(f.home, ".config/systemd/user/telepty.service"), dir: join(f.home, ".config/systemd/user"),
          text: `[Service]\nExecStart=${target} daemon\nRestart=always\n` }
        : null;
    if (definition !== null) {
      mkdirSync(dirname(definition.file), { recursive: true });
      writeFileSync(definition.file, definition.text);
    }
    const r = runInit(f);
    assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    assertOneRequirementMessage(r, /MIGRATION \(aigentry-orchestrator 0\.2\.5-0\.2\.7 -> /, "service target");
    if (definition === null) {
      assert.match(r.stderr, /User service definitions are not inspected on this platform; check the program path/,
        "win32 must say it inspected no service definition");
    } else {
      assert.ok(r.stderr.includes(`1 service definition(s) under ${definition.dir} name a telepty inside an orchestrator install`),
        `the service definition was not reported:\n${r.stderr}`);
      assert.ok(r.stderr.includes(`${definition.file} -> ${target}`),
        `the definition and its program path were not named:\n${r.stderr}`);
      assert.match(r.stderr, /their next start fails too until the program path names a telepty you installed/,
        "the consequence for the service is not stated");
    }
    // Reading a service definition is a READ. Nothing was started, stopped, reloaded or written —
    // launchctl and systemctl are armed tripwires on the fixture PATH.
    assertChangedNothing(f, "service target");
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
  // The documented dispatch contract and the code must name the SAME refusal for a telepty that
  // cannot run (review R5): the usage text and the CLI both say exit 78 TELEPTY_CLI_UNAVAILABLE.
  const dispatch = readFileSync(join(REPO, "src/dispatch/cli.ts"), "utf8");
  const usage = readFileSync(join(REPO, "src/dispatch/usage.ts"), "utf8");
  assert.ok(dispatch.includes('const TELEPTY_UNAVAILABLE = "TELEPTY_CLI_UNAVAILABLE"'),
    "dispatch does not define the missing-CLI refusal by name");
  assert.ok(usage.includes("exit 78") && usage.includes("TELEPTY_CLI_UNAVAILABLE"),
    "the dispatch usage does not document exit 78 TELEPTY_CLI_UNAVAILABLE");
});
