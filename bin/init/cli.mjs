#!/usr/bin/env node
// aigentry-orchestrator init — materialise a control workspace from the installed package.
// SPEC docs/specs/2026-08-15-npm-init-environment.md §5. Every arm's exit code and message
// are specified there; no arm returns 0 without having done what it said (§1 premise 4).
//
// Exit map: 0 ok · 2 unsupported platform · 3 missing hard dependency · 4 workspace refused
//           5 copy failure / packaging defect · 6 scaffold failure · 7 substitution failure

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import {
  NATIVE_FILES, assertNoNativeOperation, prepareNativeCapture, beginNativeCapture,
  commitNativeCapture, inspectNativeOperation, restoreNativeOperation, beginLegacyInit,
} from "./native-capture.mjs";

import {
  MANIFEST,
  SCAFFOLD_PREFIX,
  TEMPLATE_TOKENS,
  templateSubs,
  substitute,
  isSubstitutionExempt,
  isExecutable,
  STATE_DIRS,
  AIGENTRY_DIRS,
  FOREIGN_CONFIG_KEYS,
} from "./manifest.mjs";

const PKG_ROOT = path.resolve(path.dirname(fs.realpathSync.native(fileURLToPath(import.meta.url))), "..", "..");
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
const AIGENTRY_HOME = process.env.AIGENTRY_HOME || path.join(os.homedir(), ".aigentry");
// win32 only: the P2 private-storage primitive for the legacy init lock (C7). Never loaded on POSIX.
const winStorage = process.platform === "win32" ? await import("../lib/win-private-storage.mjs") : null;
// win32 only: the Git for Windows bash.exe resolved in step 1 (C5) and used by step 5.
let gitBash = null;

const USAGE = `aigentry-orchestrator init [--workspace PATH] [--yes] [--dry-run] [--force] [--upgrade]

  --workspace PATH  where the control workspace goes (default: ~/aigentry/_orchestrator,
                    or $AIGENTRY_CONTROL_WORKSPACE)
  --yes             take defaults without prompting
  --dry-run         run the checks, print every path that would be touched, write nothing
  --force           overwrite an already-initialised workspace
  --upgrade         re-copy the manifest into an existing workspace; state/ is never touched
  --capture-root ABS       existing canonical private capture root (mode 0700)
  --preservation-root ABS  existing canonical private backup root (mode 0700)
                          supply both to install native capture; roots must be disjoint
                          from workspace, AIGENTRY_HOME and cleanup roots
  --inspect-native UUID   read-only native operation inspection; supply both roots
  --restore-native UUID   explicitly restore unchanged owned outputs; supply both roots
                          retains capture evidence, receipts and backups

Native setup requires preexisting workspace and AIGENTRY_HOME roots. It preserves
unowned/shared .codex/hooks.json even under --force/--yes. Installation requires
interactive /hooks review; it does not establish capture readiness or trust.
`;

const summary = { written: [], preserved: [], skipped: [], warned: [] };
const warn = (msg) => {
  summary.warned.push(msg);
  console.warn(`WARN  ${msg}`);
};
const info = (msg) => console.log(`      ${msg}`);
const step = (msg) => console.log(`\n==> ${msg}`);
const die = (code, msg) => {
  console.error(`\nERR  ${msg}`);
  process.exit(code);
};

const has = (cmd) => process.platform === "win32" ? winWhich(cmd).length > 0
  : spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;

// win32 (C3, P5): PATH x PATHEXT with fs only, no shell. Candidates under %SystemRoot% (the WSL
// bash.exe launcher) and %LOCALAPPDATA%\Microsoft\WindowsApps (App Execution Alias stubs such as
// the Store python3.exe) are skipped. Returns the existing candidates in PATH order.
function winWhich(cmd) {
  const under = (dir, root) => typeof root === "string" && path.isAbsolute(root) &&
    (dir.toLowerCase() === path.resolve(root).toLowerCase() ||
      dir.toLowerCase().startsWith(`${path.resolve(root).toLowerCase()}\\`));
  const excluded = [process.env.SystemRoot,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps")];
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const found = [];
  for (const raw of (process.env.PATH || "").split(path.delimiter)) {
    const entry = raw.replace(/^"(.*)"$/, "$1");
    if (!path.isAbsolute(entry)) continue;
    const dir = path.resolve(entry);
    if (excluded.some((root) => under(dir, root))) continue;
    for (const ext of exts) {
      const file = path.join(dir, cmd + ext.toLowerCase());
      try {
        if (fs.statSync(file).isFile()) found.push(file);
      } catch {
        // not present in this PATH entry
      }
    }
  }
  return found;
}

// win32 (C4, P5): run a resolved tool once with a constant argv, bounded. An .exe/.com runs with
// shell:false; a .cmd/.bat runs through %SystemRoot%\System32\cmd.exe /d /s /c with strict quoting.
function winRun(file, args) {
  const options = { encoding: "utf8", windowsHide: true, timeout: 10_000 };
  if (!/\.(cmd|bat)$/i.test(file)) return spawnSync(file, args, { ...options, shell: false });
  const sr = process.env.SystemRoot;
  if (typeof sr !== "string" || !/^[A-Za-z]:\\/.test(sr) || /["%^&|<>!\r\n]/.test(file))
    // #1293 (review R4): this refusal is NOT an answer about the tool — a perfectly good
    // .cmd shim in a prefix spelled `C:\Users\a!b\...` lands here. `unsupportedPath` marks it
    // so a caller can diagnose the PROBE instead of claiming the tool is missing or too old.
    // The two hard-dependency callers above read `status`/`stdout` only and are unchanged.
    return { status: null, stdout: "", stderr: "", unsupportedPath: true };
  return spawnSync(path.join(sr, "System32", "cmd.exe"), ["/d", "/s", "/c", `""${file}" ${args.join(" ")}"`],
    { ...options, windowsVerbatimArguments: true });
}

// win32 (C5): Git for Windows bash = first of (a) a PATH x PATHEXT bash.exe not excluded by C3,
// (b) <dir of git.exe on PATH>\..\bin\bash.exe. Accepted only when `uname -s` prints MINGW*/MSYS*.
function resolveGitBash() {
  const direct = winWhich("bash").find((file) => /\.exe$/i.test(file));
  const git = winWhich("git").find((file) => /\.exe$/i.test(file));
  const derived = git ? path.join(path.dirname(git), "..", "bin", "bash.exe") : null;
  const candidate = direct || (derived && fs.existsSync(derived) ? derived : null);
  const hint = "Git for Windows provides the bash that every shipped bin/*.sh script and init step 5 need. " +
    "Install it, then re-run init:\n  winget install Git.Git";
  if (!candidate) die(3, `Git for Windows bash.exe was not found on PATH or next to git.exe. ${hint}`);
  const r = spawnSync(candidate, ["-c", "uname -s"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  const uname = (r.stdout || "").trim();
  if (r.status !== 0 || !/^(MINGW|MSYS)/.test(uname))
    die(3, `${candidate} is not Git for Windows bash (\`uname -s\` printed "${uname}", exit ${r.status}). ${hint}`);
  return candidate;
}

/** bin/** files that invoke `tool` — measured from the installed package, never a stale count. */
function binFilesUsing(tool) {
  const re = new RegExp(`(^|[^\\w-])${tool}([^\\w-]|$)`);
  return MANIFEST.filter((p) => p.startsWith("bin/")).filter((p) => {
    try {
      return re.test(fs.readFileSync(path.join(PKG_ROOT, p), "utf8"));
    } catch {
      return false;
    }
  });
}

// ─────────────── the telepty requirement and the 0.2.5-0.2.7 migration (task #1293) ───────────────
//
// WHAT CHANGED IN 0.2.8. package.json declared `"@dmsdc-ai/aigentry-telepty": "^0.8.0"` from 0.2.0
// onward. NOTHING under src/ or bin/ ever imported, required or resolved that package — every call
// site runs the `telepty` that PATH (or an explicit TELEPTY) names: src/dispatch/cli.ts:51,
// src/tracker/cli.ts:57, src/reconciler/cli.ts:93, src/cleanup/cli.ts:604, src/hitl/cli.ts:94,
// src/bus-bridge/cli.ts:72, src/comms-auditor/cli.ts:120, src/bridge-auditor/cli.ts:150 and the
// `: "${TELEPTY:=$(command -v telepty …)}"` line in every shipped bin/*.sh — while the fixed
// `telepty` word in the boot command door (src/orchestrator-boot/cli.ts:473) resolves the same way.
// So the nested copy was never EXECUTED, but its postinstall ran on the HOST at install time and
// replaced a newer running daemon. The dependency is gone; the requirement is stated here instead.
//
// WHAT THIS CHECK ASKS (r3). Only questions with an exact answer: is there a telepty on PATH, and
// does its `telepty boot-capabilities` document declare what the later doors need. Install advice
// follows only an established fact — no telepty on PATH, or a valid document that lacks a
// capability; any other answer is reported as inconclusive. It never guesses who installed or
// "owns" a telepty, and it reads no service definition (r3: a single on-disk file cannot establish
// what a service manager will start; the README/CHANGELOG manual check covers services). It
// installs, repairs, starts, stops and restarts nothing, and it writes nothing.
const TELEPTY_MIN_VERSION = "0.11.1";
const TELEPTY_REQUIRED_VERBS = ["allow-create-v1", "inject-bound-v1"];
const TELEPTY_INSTALL_COMMAND = "npm i -g @dmsdc-ai/aigentry-telepty@latest";
const TELEPTY_CAPABILITIES_SCHEMA = "telepty-boot-capabilities-v1";
const TELEPTY_PROBE_TIMEOUT_MS = 10_000;
/** The most the boot door reads of the capability document (src/orchestrator-boot/cli.ts, bootDoor maxBuffer). */
const TELEPTY_PROBE_MAX_BYTES = 4096;

/** An untrusted value for a diagnostic: JSON (never String(), which an object can make throw), bounded. */
function shownJson(v) {
  let text;
  try {
    text = JSON.stringify(v);
  } catch {
    return "<unprintable>";
  }
  if (typeof text !== "string") return "<undefined>";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * The telepty the runtime doors would run, as an absolute file, or null when PATH names none.
 * POSIX asks the same `command -v` shell the rest of step 1 asks; win32 uses the C3 PATH x PATHEXT
 * walk, so a Store alias or the WSL launcher is never taken for the real tool.
 */
function resolveTelepty() {
  if (process.platform === "win32") return winWhich("telepty")[0] ?? null;
  const r = spawnSync("/bin/sh", ["-c", "command -v telepty"], { encoding: "utf8", timeout: TELEPTY_PROBE_TIMEOUT_MS });
  const out = (r.stdout || "").trim();
  return r.status === 0 && out !== "" ? out : null;
}

/**
 * Runs `telepty boot-capabilities` ONCE, read-only: printing the sealed document starts, stops,
 * repairs, upgrades and contacts nothing. The verdict is THREE-valued (r3):
 *   ok           — the document satisfies both runtime doors
 *   refused      — a valid telepty-boot-capabilities-v1 document that lacks a required verb or
 *                  declares another viewer detach: the one answer that ESTABLISHES an older telepty
 *   inconclusive — everything else: no answer (spawn error, signal, timeout, over-long output), a
 *                  non-zero exit, or output that is not a valid v1 document. None of these says
 *                  which telepty this is, so none of them may produce replacement advice.
 * The document is validated with EXACTLY the rule the boot door applies (review R3,
 * src/orchestrator-boot/cli.ts bootCapabilitiesRefusal), within the same 4096-byte bound (review F5),
 * plus dispatch's verb. No untrusted field is coerced with String() (review R8).
 */
function teleptyCapabilityVerdict(file) {
  let r;
  if (process.platform === "win32") {
    r = winRun(file, ["boot-capabilities"]);
    if (r.unsupportedPath === true)
      return { kind: "inconclusive", why: `init cannot probe ${file} through the cmd.exe shim door: its path ` +
        "carries a character (a quote, %, ^, &, |, <, > or !) that cannot be quoted safely, or SystemRoot " +
        "is not an absolute drive path, so the capability was NOT measured" };
  } else {
    // The file RESOLVED above, not the bare word again: one lookup, then exactly what was found, so
    // a PATH change between the two reads cannot make the message describe a different executable.
    r = spawnSync(file, ["boot-capabilities"], { encoding: "utf8", timeout: TELEPTY_PROBE_TIMEOUT_MS });
  }
  const inconclusive = (why) => ({ kind: "inconclusive", why });
  if (r.error !== undefined && r.error !== null)
    return inconclusive(`'telepty boot-capabilities' could not run (${r.error.code || "spawn error"})`);
  if (Buffer.byteLength(r.stdout || "") > TELEPTY_PROBE_MAX_BYTES)
    return inconclusive(`'telepty boot-capabilities' printed more than ${TELEPTY_PROBE_MAX_BYTES} ` +
      "bytes, more than the boot door reads");
  if (r.status === null)
    return inconclusive(`'telepty boot-capabilities' did not finish (${r.signal || "no exit status"})`);
  if (r.status !== 0) return inconclusive(`'telepty boot-capabilities' exited ${r.status}`);
  const out = r.stdout || "";
  if (!out.endsWith("\n") || out.indexOf("\n") !== out.length - 1)
    return inconclusive("'telepty boot-capabilities' did not print exactly one line (an older " +
      `telepty prints its help text and exits 0, and so can a wrapper that fails); it printed ${shownJson(out)}`);
  let doc = null;
  try {
    const parsed = JSON.parse(out);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed;
  } catch {
    doc = null;
  }
  const verbs = doc === null ? null : doc.verbs;
  if (doc === null || Object.keys(doc).sort().join(",") !== "schema,verbs,viewer_detach" ||
    !Array.isArray(verbs) || !verbs.every((v) => typeof v === "string") || new Set(verbs).size !== verbs.length ||
    typeof doc.viewer_detach !== "string") // r4 (review R4-3): a non-string viewer_detach is malformed, not a refusal
    return inconclusive(`'telepty boot-capabilities' did not print a ${TELEPTY_CAPABILITIES_SCHEMA} ` +
      `document with exactly schema/verbs/viewer_detach, unique string verbs and a string viewer_detach; it printed ${shownJson(out)}`);
  if (doc.schema !== TELEPTY_CAPABILITIES_SCHEMA)
    return inconclusive(`'telepty boot-capabilities' printed schema ${shownJson(doc.schema)}, ` +
      `not ${TELEPTY_CAPABILITIES_SCHEMA}`);
  const missing = TELEPTY_REQUIRED_VERBS.filter((v) => !verbs.includes(v));
  if (missing.length > 0)
    return { kind: "refused", why: `the telepty in use does not declare ${missing.join(" or ")} in its boot-capabilities` };
  if (doc.viewer_detach !== "nondeleting-v1")
    return { kind: "refused", why: `the telepty in use declares viewer_detach ${shownJson(doc.viewer_detach)}, not nondeleting-v1` };
  return { kind: "ok", why: null };
}

/**
 * The ONE message for a missing or insufficient CLI: the observation, the capability required, the
 * first published version carrying it, the single command the OPERATOR runs, and what each later
 * door does until then (review F6: stated per door and per operation, never wider than the code).
 */
function teleptyMessage(observed) {
  return `${observed} aigentry-orchestrator declares NO dependency on @dmsdc-ai/aigentry-telepty, so no ` +
    "copy of it is installed with this package: it runs the telepty that PATH (or an explicit TELEPTY) " +
    `names. That telepty's 'telepty boot-capabilities' must declare ${TELEPTY_REQUIRED_VERBS.join(" and ")} ` +
    `with nondeleting-v1 viewer detach: @dmsdc-ai/aigentry-telepty ${TELEPTY_MIN_VERSION} or later ` +
    `(${TELEPTY_MIN_VERSION} is the first published version declaring inject-bound-v1). init detects only: ` +
    "it installs, upgrades, starts, stops and restarts nothing. Install or upgrade telepty under your own " +
    `control with '${TELEPTY_INSTALL_COMMAND}'. Until then orchestrator-boot exits 3 (boot preflight ` +
    "UNSUPPORTED) when its own check of the telepty on PATH fails — missing, or without allow-create-v1 and nondeleting-v1 viewer detach; " +
    "inject-bound-v1 is not part of that check — and a supervised boot exits 2 earlier, when 'telepty allow-check' " +
    "does not admit it; " +
    "dispatch exits 78: TELEPTY_CLI_UNAVAILABLE when the telepty command cannot be started at registration, " +
    "BOUND_INJECT_UNSUPPORTED when bound delivery to a busy worker finds no inject-bound-v1.";
}

/**
 * What init observed when the probe established nothing (r3, review R3-6): the observation, the
 * requirement as a fact, and one instruction that changes nothing — never install or replace advice.
 */
function teleptyInconclusive(file, why) {
  return `${why}. So init could not establish whether the telepty on PATH (${file}) declares what the later ` +
    `doors need: a one-line ${TELEPTY_CAPABILITIES_SCHEMA} document from 'telepty boot-capabilities' declaring ` +
    `${TELEPTY_REQUIRED_VERBS.join(" and ")} with nondeleting-v1 viewer detach (@dmsdc-ai/aigentry-telepty ` +
    `${TELEPTY_MIN_VERSION} or later). Run 'telepty boot-capabilities' yourself to see its answer. init detects ` +
    "only: it installs, upgrades, starts, stops and restarts nothing.";
}

/** Step 1's telepty handling: the CLI on PATH only. No effect of any kind. */
function teleptyCheck() {
  const file = resolveTelepty();
  const verdict = file === null ? null : teleptyCapabilityVerdict(file);
  if (verdict === null) warn(teleptyMessage("telepty is not on PATH."));
  else if (verdict.kind === "refused")
    warn(teleptyMessage(`The telepty on PATH (${file}) does not report the required capabilities: ${verdict.why}.`));
  else if (verdict.kind === "inconclusive") warn(teleptyInconclusive(file, verdict.why));
  else info(`telepty found at ${file}; its boot-capabilities declare ${TELEPTY_REQUIRED_VERBS.join(" and ")}`);
}

function parseArgs(argv) {
  const opts = { workspace: null, yes: false, dryRun: false, force: false, upgrade: false,
    captureRoot: null, preservationRoot: null, inspectNative: null, restoreNative: null };
  const rest = [...argv];
  const cmd = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    if (a === "--workspace") opts.workspace = rest.shift();
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--upgrade") opts.upgrade = true;
    else if (["--capture-root", "--preservation-root", "--inspect-native", "--restore-native"].includes(a)) {
      const value = rest.shift();
      if (!value || value.startsWith("--")) die(1, `${a} requires a value`);
      const key = { "--capture-root": "captureRoot", "--preservation-root": "preservationRoot",
        "--inspect-native": "inspectNative", "--restore-native": "restoreNative" }[a];
      if (opts[key] !== null) die(1, `${a} may be supplied only once`);
      opts[key] = value;
    }
    else {
      console.error(`unknown argument: ${a}\n\n${USAGE}`);
      process.exit(1);
    }
  }
  if (Boolean(opts.captureRoot) !== Boolean(opts.preservationRoot))
    die(1, "--capture-root and --preservation-root must be supplied together");
  if ((opts.inspectNative || opts.restoreNative) && !opts.captureRoot)
    die(1, "native inspect/restore requires both explicit roots");
  if (opts.inspectNative && opts.restoreNative) die(1, "choose one native operation");
  return { cmd, opts };
}

async function ask(question, fallback, nonInteractive) {
  if (nonInteractive) {
    info(`${question} -> ${fallback} (non-interactive)`);
    return fallback;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer === "" ? fallback : answer;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- step 0: platform gate

function platformGate() {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return;
  die(2, `aigentry-orchestrator supports macOS, Linux and Windows; detected ${p} (${os.type()} ${os.release()}).`);
}

// ------------------------------------------------------- step 1: dependency checks

function dependencyChecks() {
  step("Step 1 — dependency checks (detect only; nothing is installed)");

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) die(3, `node >= 20 is required; this process is node ${process.version}.`);
  info(`node ${process.version}`);

  // win32 (C4) probes its own hard-dependency list; the POSIX list below is not consulted there.
  if (process.platform === "win32") gitBash = winHardDependencies();
  for (const [tool, install] of process.platform === "win32" ? [] : [
    ["jq", "brew install jq  (macOS)  |  apt-get install jq  (Debian/Ubuntu)"],
    ["python3", "brew install python  (macOS)  |  apt-get install python3  (Debian/Ubuntu)"],
  ]) {
    if (has(tool)) {
      info(`${tool} found`);
      continue;
    }
    const users = binFilesUsing(tool);
    die(
      3,
      `${tool} is not on PATH. ${users.length} shipped script(s) invoke it unguarded, so a missing ` +
        `${tool} is an opaque runtime failure rather than an install-time one:\n  ${users.join("\n  ")}\n` +
        `Install it, then re-run init:\n  ${install}`,
    );
  }

  // #1293: at most one telepty message per run, from the capability the runtime doors read. The 0.2.0
  // wording this replaces claimed telepty was a dependency installed nested under this package; that
  // became false when the dependency was removed (its exact phrase is pinned absent by
  // tests/packaging/telepty-runtime-requirement.test.ts, so it is not quoted here).
  teleptyCheck();

  if (has("claude")) info("claude CLI found");
  else
    warn(
      "claude CLI not on PATH. init cannot install it. See " +
        "https://docs.claude.com/en/docs/claude-code/setup — the control workspace is complete " +
        "without it, but nothing will boot into it.",
    );

  const devkitSkills = ["propose-next-task", "work-breakdown"];
  const missingSkills = devkitSkills.filter(
    (s) => !fs.existsSync(path.join(os.homedir(), ".claude", "skills", s)),
  );
  if (missingSkills.length === 0) info("devkit skills present (propose-next-task, work-breakdown)");
  else
    warn(
      "orchestrate-turn steps 1-1 and 5 invoke the 'work-breakdown' and 'propose-next-task' skills, " +
        "which are owned by aigentry-devkit (ADR 2026-07-26). Install with: " +
        `npm i -g @dmsdc-ai/aigentry-devkit. Missing: ${missingSkills.join(", ")}. Without them the ` +
        "orchestration loop runs with those two steps unassisted.",
    );

  // Constitution §2 — a missing cmux is a supported configuration, never a failure.
  if (has("cmux")) info("workspace host: cmux adapter active");
  else
    info(
      "workspace host: headless adapter active; terminal workspaces will not be opened or closed " +
        "automatically.",
    );

  // gh is deliberately NOT checked: measured usage in the shipping set is zero (§0).
}

// win32 (C4, W-D1): jq, Python 3 as `python` and Git for Windows bash are hard prerequisites. Each
// is probed by running it, so a Store alias or the WSL launcher is never taken for the real tool.
function winHardDependencies() {
  for (const [tool, args, works, install] of [
    ["jq", ["--version"], (r) => r.status === 0, "winget install jqlang.jq"],
    ["python", ["--version"], (r) => /^Python 3\./.test(`${r.stdout || ""}${r.stderr || ""}`.trim()),
      "winget install Python.Python.3.12"],
  ]) {
    const file = winWhich(tool)[0];
    if (file && works(winRun(file, args))) {
      info(`${tool} found (${file})`);
      continue;
    }
    const problem = file ? `${file} did not answer \`${tool} ${args.join(" ")}\` as expected` : `${tool} is not on PATH`;
    const users = tool === "python" ? "the dispatch registry runs under it" :
      `${binFilesUsing(tool).length} shipped script(s) invoke it unguarded`;
    die(3, `${problem}. ${users}, so a missing ${tool} is an opaque runtime failure rather than an ` +
      `install-time one.\nInstall it, then re-run init:\n  ${install}`);
  }
  const bash = resolveGitBash();
  info(`bash found (${bash})`);
  return bash;
}

// -------------------------------------------- step 2: resolve and validate the workspace

function gitTreeAt(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

async function resolveWorkspace(opts) {
  step("Step 2 — control workspace");

  const fallback = path.join(os.homedir(), "aigentry", "_orchestrator");
  let ws = opts.workspace || process.env.AIGENTRY_CONTROL_WORKSPACE || null;
  if (!ws) {
    const nonInteractive = opts.yes || !process.stdin.isTTY;
    ws = await ask(`Control workspace path [${fallback}]: `, fallback, nonInteractive);
  }
  ws = path.resolve(ws.replace(/^~(?=$|\/)/, os.homedir()));

  const tree = gitTreeAt(ws);
  if (tree)
    die(
      4,
      `${ws} is a git working tree (${tree}). init writes a fresh control workspace and will not ` +
        "modify a clone; if this is the aigentry-orchestrator repo itself, you already have the " +
        "environment init would create. Choose another path with --workspace.",
    );

  const stamp = path.join(ws, ".aigentry-init.json");
  const initialised = fs.existsSync(stamp);
  if (fs.existsSync(ws)) {
    const entries = fs.readdirSync(ws);
    if (entries.length > 0 && !initialised)
      die(
        4,
        `${ws} exists and is not empty, but holds no .aigentry-init.json, so it was not created by ` +
          `init. Refusing to write into it. First entries found: ${entries.slice(0, 3).join(", ")}.`,
      );
    if (initialised && !opts.upgrade && !opts.force)
      die(
        4,
        `${ws} is already an initialised control workspace. Pick one:\n` +
          "  --upgrade  re-copy the manifest, list what changed, leave state/ untouched\n" +
          "  --force    overwrite the whole governance layer, including files you edited\n" +
          "state/ is never deleted by either.",
      );
  }

  info(`workspace: ${ws}${initialised ? "  (re-init)" : ""}`);
  return { ws, initialised };
}

// ----------------------------------------------------- step 3: copy the governance layer

function verifyPackageComplete() {
  const missing = MANIFEST.filter((p) => !fs.existsSync(path.join(PKG_ROOT, p)));
  if (missing.length)
    die(
      5,
      `${missing[0]} is in the init manifest but not in the installed package. This is a packaging ` +
        "defect (see tests/packaging/T96_ship_set_agreement.sh). Nothing was written; the workspace " +
        `is unchanged.\nAll missing entries:\n  ${missing.join("\n  ")}`,
    );
}

function copyManifest(ws, opts) {
  step("Step 3 — governance layer");
  const changed = [];
  for (const rel of MANIFEST) {
    if (opts.captureRoot && NATIVE_FILES.includes(rel)) continue; // Preservation is the sole writer.
    const src = path.join(PKG_ROOT, rel);
    const dest = path.join(ws, rel);
    const existed = fs.existsSync(dest);
    if (existed && !opts.upgrade && !opts.force) {
      summary.preserved.push(rel);
      continue;
    }
    if (existed && fs.readFileSync(src).equals(fs.readFileSync(dest))) {
      summary.skipped.push(rel);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, isExecutable(rel) ? 0o755 : 0o644);
    } catch (e) {
      die(5, `could not write ${dest}: ${e.code || e.message}`);
    }
    summary.written.push(rel);
    if (existed) changed.push(rel);
  }

  // §2.3 — a COPY, never a symlink. npm tarball symlink handling plus the Windows
  // core.symlinks=false failure mode recorded in ADR 2026-07-26 §risks.
  const skillCopy = path.join(ws, ".claude", "skills", "orchestrate-turn", "SKILL.md");
  fs.mkdirSync(path.dirname(skillCopy), { recursive: true });
  fs.copyFileSync(path.join(PKG_ROOT, ".agents/skills/orchestrate-turn/SKILL.md"), skillCopy);
  summary.written.push(".claude/skills/orchestrate-turn/SKILL.md");

  info(`${summary.written.length} written, ${summary.preserved.length} preserved, ${summary.skipped.length} unchanged ` +
    `(workspace: ${MANIFEST.length} manifest files + the .claude/skills/orchestrate-turn/SKILL.md copy)`);
  if (changed.length) info(`overwritten (differed): ${changed.join(", ")}`);
  return changed;
}

// -------------------------------------------------------------- step 4: create state/

function createState(ws, opts) {
  step("Step 4 — state/");
  if (opts.upgrade) {
    info("--upgrade: state/ skipped entirely — not created, not seeded, not inspected.");
    summary.skipped.push("state/ (--upgrade)");
    return;
  }
  for (const d of STATE_DIRS) fs.mkdirSync(path.join(ws, "state", d), { recursive: true });
  const queue = path.join(ws, "state", "task-queue.json");
  if (fs.existsSync(queue)) {
    info("state/task-queue.json exists — preserved");
    summary.preserved.push("state/task-queue.json");
  } else {
    fs.writeFileSync(queue, JSON.stringify({ tasks: [], active_focus: null }, null, 2) + "\n");
    summary.written.push("state/task-queue.json");
    info(`state/ initialised empty (${STATE_DIRS.length} directories + task-queue.json)`);
  }
}

// ------------------------------------------------------- step 5: ~/.aigentry scaffold

async function scaffold(ws, opts, subs) {
  step(`Step 5 — ${AIGENTRY_HOME} scaffold`);

  // 5.1 — delegate to the script that already owns this layer (§2.5, Article 1).
  const script = path.join(ws, "bin", "install-instructions.sh");
  // win32 (C5): Git bash by absolute path, `/` separators so the script derives C:/… paths that Node can read.
  const r = process.platform === "win32"
    ? spawnSync(gitBash, opts.force ? [script.replaceAll("\\", "/"), "--force"] : [script.replaceAll("\\", "/")],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, AIGENTRY_HOME: AIGENTRY_HOME.replaceAll("\\", "/") } })
    : spawnSync("bash", opts.force ? [script, "--force"] : [script], { encoding: "utf8" });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0) die(6, `install-instructions.sh exited ${r.status}:\n${r.stderr || "(no stderr)"}`);

  // Only the files it just wrote may be substituted. "exists file:" lines are preserved
  // content the user (or another component) owns — step 6 must never rewrite those.
  const scaffoldWritten = [...r.stdout.matchAll(/^(?:created|updated) file: (.+)$/gm)].map((m) => m[1]);

  // 5.2 — CONSTITUTION.md. Two different documents share this name (§4.3); never silently overwrite.
  const srcConst = path.join(PKG_ROOT, "tooling/instructions/CONSTITUTION.md");
  const dstConst = path.join(AIGENTRY_HOME, "CONSTITUTION.md");
  fs.mkdirSync(AIGENTRY_HOME, { recursive: true });
  if (!fs.existsSync(dstConst)) {
    fs.copyFileSync(srcConst, dstConst);
    summary.written.push(dstConst);
    info(`wrote ${dstConst}`);
  } else if (fs.readFileSync(srcConst).equals(fs.readFileSync(dstConst))) {
    info(`${dstConst} unchanged`);
    summary.skipped.push(dstConst);
  } else {
    const nonInteractive = opts.yes || !process.stdin.isTTY;
    const answer = nonInteractive
      ? "k"
      : (
          await ask(
            `${dstConst} exists and differs from the one this package ships. ` +
              "[k]eep yours / [o]verwrite / [b]ackup-and-overwrite? [k]: ",
            "k",
            false,
          )
        )
          .toLowerCase()
          .charAt(0);
    if (answer === "o" || answer === "b") {
      if (answer === "b") {
        const backup = `${dstConst}.bak`;
        fs.copyFileSync(dstConst, backup);
        info(`backed up to ${backup}`);
      }
      fs.copyFileSync(srcConst, dstConst);
      summary.written.push(dstConst);
    } else {
      warn(
        `${dstConst} kept as-is and differs from the aigentry 헌법 this package ships. The ` +
          "instructions installed above cite that path — they will resolve to your document, not ours.",
      );
      summary.preserved.push(dstConst);
    }
  }

  // 5.3 — config.json, merged key-wise. Never touches the keys other components own (§2.5).
  const cfgPath = path.join(AIGENTRY_HOME, "config.json");
  const template = fs.readFileSync(path.join(PKG_ROOT, "tooling/instructions/config.template.json"), "utf8");
  // The shipped defaults block carries CLI flags; say so whenever init writes it.
  const flagsWritten = () => info(`wrote default defaults.cli_flags "${JSON.parse(template).defaults.cli_flags}" to ${cfgPath}`);
  if (!fs.existsSync(cfgPath)) {
    fs.writeFileSync(cfgPath, substitute(template, subs));
    summary.written.push(cfgPath);
    info(`wrote ${cfgPath}`);
    flagsWritten();
  } else {
    const existing = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const fresh = JSON.parse(substitute(template, subs));
    const added = [];
    for (const key of ["roles", "defaults"]) {
      if (!(key in existing)) {
        existing[key] = fresh[key];
        added.push(key);
      }
    }
    if (added.length) {
      fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2) + "\n");
      summary.written.push(`${cfgPath} (added: ${added.join(", ")})`);
      if (added.includes("defaults")) flagsWritten();
    }
    const declined = Object.keys(existing).filter((k) => !added.includes(k));
    info(`${cfgPath}: added ${added.length ? added.join(", ") : "nothing"}`);
    info(
      `left untouched: ${declined.join(", ")}` +
        (declined.some((k) => FOREIGN_CONFIG_KEYS.includes(k))
          ? "  (the marked keys are written by other ecosystem components)"
          : ""),
    );
    summary.preserved.push(`${cfgPath} keys: ${declined.join(", ")}`);
  }

  // 5.4
  for (const d of AIGENTRY_DIRS) fs.mkdirSync(path.join(AIGENTRY_HOME, d), { recursive: true });
  info(`${AIGENTRY_DIRS.length} runtime directories ensured under ${AIGENTRY_HOME}`);

  return scaffoldWritten;
}

// ------------------------------------------------------------- step 6: substitution

function substituteAll(ws, scaffoldWritten, subs) {
  step("Step 6 — template substitution");
  const targets = [
    ...MANIFEST.filter((rel) => !isSubstitutionExempt(rel)).map((rel) => path.join(ws, rel)),
    ...scaffoldWritten,
  ];
  let touched = 0;
  for (const file of targets) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      // win32 (C6): a path the script reports writing must be readable, or its tokens would survive unseen.
      if (process.platform === "win32" && scaffoldWritten.includes(file))
        die(7, `${file} was written by install-instructions.sh but cannot be read for substitution`);
      continue;
    }
    if (!TEMPLATE_TOKENS.some((t) => text.includes(t))) continue;
    fs.writeFileSync(file, substitute(text, subs));
    touched += 1;
    info(`substituted ${file}`);
  }

  // The assertion. An unsubstituted variable reaching a user's instruction file is exactly
  // the silent-wrongness class this release removes — so it is exit 7, not a warning.
  for (const file of targets) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const token of TEMPLATE_TOKENS)
      if (text.includes(token)) die(7, `${token} survived substitution in ${file}.`);
  }
  info(`${touched} file(s) substituted; 0 init tokens survive`);
}

// ------------------------------------------------- steps 7 + 8: guidance and summary

function guidance(ws, counts) {
  const notInstalled = summary.warned.length
    ? summary.warned.map((w) => `  - ${w}`).join("\n")
    : "  (nothing — every optional dependency was found)";
  // win32 (C9): the boot script runs from Git Bash; the two 0.2.2 Windows limitations are named.
  const win = process.platform === "win32";
  const boot = win
    ? "3. bash bin/orchestrator-boot.sh  # from Git Bash; boots the orchestrator session"
    : "3. bin/orchestrator-boot.sh       # boots the orchestrator session";
  const limits = win
    ? "\nConfined worker spawn is unavailable on native Windows (SANDBOX_PLATFORM_UNSUPPORTED, exit 78); use WSL2 for confined workers.\n" +
      "Native request capture (--capture-root/--preservation-root) is unavailable on native Windows in 0.2.2; use WSL2 for it.\n"
    : "";
  const body = (notInstalledSection) => `Control workspace ready: ${ws}
  ${counts.governance + counts.scaffold} manifest files (${counts.governance} governance + ${counts.scaffold} tooling/instructions scaffold sources), state/ initialised empty.

Next:
  1. cd ${ws}
  2. telepty-install                # if the daemon is not yet running (telepty owns this)
  ${boot}

Do NOT boot with a bare \`claude\`. bin/orchestrator-boot.sh enforces the
singleton-at-boot guard (#539): a bare \`telepty allow --id orchestrator\` is
idempotent, so a second bare boot silently shares the session and a later
SIGTERM cascades a close to the live one.
${limits}
Not installed by init:
${notInstalledSection}
`;
  // #1293 (review R6): warn() already printed every warning IN FULL, once, at the step that
  // measured it. The saved guide keeps the full list — it is the operator's durable copy — but the
  // console block names them instead of reprinting them, so a long requirement message (and the one
  // command in it) is read once per run rather than twice.
  fs.writeFileSync(path.join(ws, "GETTING-STARTED.md"), body(notInstalled));
  step("Step 7 — next steps");
  console.log(body(summary.warned.length === 0 ? notInstalled
    : `  ${summary.warned.length} warning(s), printed above and written in full to ` +
      `${path.join(ws, "GETTING-STARTED.md")}`));
}

function stampValue(ws, subs) {
  const h = createHash("sha256");
  for (const rel of MANIFEST)
    h.update(rel).update("\0").update(createHash("sha256").update(fs.readFileSync(path.join(PKG_ROOT, rel))).digest());
  return { version: PKG.version, installedAt: subs["{{CREATED_AT}}"], manifestDigest: h.digest("hex"), workspace: ws };
}

function dryRun(ws) {
  step("--dry-run — nothing below was written");
  for (const rel of MANIFEST) console.log(`  copy       ${path.join(ws, rel)}`);
  console.log(`  copy       ${path.join(ws, ".claude/skills/orchestrate-turn/SKILL.md")}`);
  for (const d of STATE_DIRS) console.log(`  mkdir      ${path.join(ws, "state", d)}`);
  console.log(`  create     ${path.join(ws, "state", "task-queue.json")}`);
  console.log(`  create     ${path.join(ws, "GETTING-STARTED.md")}`);
  console.log(`  create     ${path.join(ws, ".aigentry-init.json")}`);
  console.log(`  exec       ${path.join(ws, "bin", "install-instructions.sh")}  (preserves existing files)`);
  console.log(`  write/keep ${path.join(AIGENTRY_HOME, "CONSTITUTION.md")}`);
  console.log(`  merge      ${path.join(AIGENTRY_HOME, "config.json")}`);
  for (const d of AIGENTRY_DIRS) console.log(`  mkdir      ${path.join(AIGENTRY_HOME, d)}`);
  console.log("\n--dry-run complete. Nothing was written.");
}

// ------------------------------------------------------------------------------- main

async function main() {
  // Help must return before parsing or invoking dependency/probe subprocesses.
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    console.log(USAGE);
    return;
  }
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (cmd === "--help" || cmd === "-h" || cmd === undefined) {
    console.log(USAGE);
    process.exit(cmd === undefined ? 1 : 0);
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(PKG.version);
    process.exit(0);
  }
  if (cmd !== "init") {
    console.error(`unknown command: ${cmd}\n\n${USAGE}`);
    process.exit(1);
  }

  console.log(`aigentry-orchestrator ${PKG.version} — init`);
  platformGate();
  // win32 (C8, W-D2 B): native request capture is a documented 0.2.2 Windows limitation; refuse
  // before anything is read or written.
  if (process.platform === "win32" && (opts.captureRoot || opts.preservationRoot || opts.inspectNative || opts.restoreNative))
    die(
      2,
      "native request capture (--capture-root, --preservation-root, --inspect-native, --restore-native) is not " +
        "available on native Windows in 0.2.2. Nothing was written. Run init without these options, or run " +
        "init inside WSL2 to use native capture.",
    );
  if (opts.inspectNative || opts.restoreNative) {
    const ws = opts.workspace || process.env.AIGENTRY_CONTROL_WORKSPACE;
    if (!ws || !path.isAbsolute(ws)) die(4, "native inspect/restore requires an explicit absolute workspace");
    const request = { workspace: ws, home: AIGENTRY_HOME, captureRoot: opts.captureRoot,
      preservationRoot: opts.preservationRoot };
    const id = opts.inspectNative || opts.restoreNative;
    const result = opts.inspectNative || opts.dryRun
      ? inspectNativeOperation(request, id) : restoreNativeOperation(request, id);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  dependencyChecks();
  const { ws } = await resolveWorkspace(opts);
  assertNoNativeOperation(ws, AIGENTRY_HOME);
  const existingStamp = path.join(ws, ".aigentry-init.json");
  if (!opts.captureRoot && fs.existsSync(existingStamp) &&
    JSON.parse(fs.readFileSync(existingStamp, "utf8")).nativeCapture)
    die(4, "capture-configured workspace: supply both explicit capture/preservation roots before re-init");
  const native = opts.captureRoot ? prepareNativeCapture({ workspace: ws, home: AIGENTRY_HOME,
    captureRoot: opts.captureRoot, preservationRoot: opts.preservationRoot, packageRoot: PKG_ROOT }) : null;

  if (opts.dryRun) {
    if (native) info(`would register synchronous UserPromptSubmit at ${path.join(ws, ".codex/hooks.json")}; pending /hooks review`);
    dryRun(ws);
    process.exit(0);
  }

  const subs = templateSubs(ws, AIGENTRY_HOME);

  verifyPackageComplete();
  if (!native) fs.mkdirSync(ws, { recursive: true });
  const finishLegacy = native ? null : beginLegacyInit(ws, AIGENTRY_HOME, winStorage);
  if (!native && fs.existsSync(existingStamp) &&
    JSON.parse(fs.readFileSync(existingStamp, "utf8")).nativeCapture)
    die(4, "workspace became capture-configured; explicit native setup required");
  const nativeTx = native ? beginNativeCapture(native) : null;
  copyManifest(ws, opts);
  createState(ws, opts);
  const scaffoldWritten = await scaffold(ws, opts, subs);
  substituteAll(ws, scaffoldWritten, subs);
  const stamp = stampValue(ws, subs);
  if (nativeTx) {
    const installed = commitNativeCapture(nativeTx, stamp);
    console.error(`Native capture installed/pending-review: ${path.join(ws, ".codex/hooks.json")}\n` +
      `UserPromptSubmit definition SHA-256: ${installed.definitionHash}\n` +
      "Open /hooks in this workspace to review. Effective trust/enabled state is unverified.\n" +
      `Native preservation operation: ${installed.operationId}`);
  } else fs.writeFileSync(path.join(ws, ".aigentry-init.json"), JSON.stringify(stamp, null, 2) + "\n");

  const scaffoldCount = MANIFEST.filter((p) => p.startsWith(SCAFFOLD_PREFIX)).length;
  guidance(ws, { governance: MANIFEST.length - scaffoldCount, scaffold: scaffoldCount });
  if (finishLegacy) finishLegacy();

  step(`Step 8 — summary (all steps: workspace, state/ and ${AIGENTRY_HOME})`);
  console.log(
    `  written   ${summary.written.length}\n` +
      `  preserved ${summary.preserved.length}\n` +
      `  skipped   ${summary.skipped.length}\n` +
      `  warned    ${summary.warned.length}`,
  );
}

main().catch((e) => die(1, e.stack || e.message));
