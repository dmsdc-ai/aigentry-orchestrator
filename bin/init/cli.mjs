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
  MANIFEST,
  SCAFFOLD_PREFIX,
  TEMPLATE_TOKENS,
  isSubstitutionExempt,
  isExecutable,
  STATE_DIRS,
  AIGENTRY_DIRS,
  FOREIGN_CONFIG_KEYS,
} from "./manifest.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
const AIGENTRY_HOME = process.env.AIGENTRY_HOME || path.join(os.homedir(), ".aigentry");

const USAGE = `aigentry-orchestrator init [--workspace PATH] [--yes] [--dry-run] [--force] [--upgrade]

  --workspace PATH  where the control workspace goes (default: ~/aigentry/_orchestrator,
                    or $AIGENTRY_CONTROL_WORKSPACE)
  --yes             take defaults without prompting
  --dry-run         run the checks, print every path that would be touched, write nothing
  --force           overwrite an already-initialised workspace
  --upgrade         re-copy the manifest into an existing workspace; state/ is never touched
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

const has = (cmd) => spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;

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

function parseArgs(argv) {
  const opts = { workspace: null, yes: false, dryRun: false, force: false, upgrade: false };
  const rest = [...argv];
  const cmd = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    if (a === "--workspace") opts.workspace = rest.shift();
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--upgrade") opts.upgrade = true;
    else {
      console.error(`unknown argument: ${a}\n\n${USAGE}`);
      process.exit(1);
    }
  }
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
  if (p === "darwin" || p === "linux") return;
  const detail = p === "win32" ? "" : ` Detected platform: ${p} (${os.type()} ${os.release()}).`;
  die(
    2,
    "aigentry-orchestrator does not support Windows natively. bin/lib/platform-windows.sh returns " +
      "'not implemented' for every primitive (#305) and bin/dispatch-registry.py locks the dispatch " +
      "registry with fcntl.flock, which does not exist on Windows Python. Run init inside WSL2, where " +
      `the Linux path is supported. Tracked at #663.${detail}`,
  );
}

// ------------------------------------------------------- step 1: dependency checks

function dependencyChecks() {
  step("Step 1 — dependency checks (detect only; nothing is installed)");

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) die(3, `node >= 20 is required; this process is node ${process.version}.`);
  info(`node ${process.version}`);

  for (const [tool, install] of [
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

  if (has("telepty")) info("telepty found");
  else
    warn(
      "telepty CLI not on PATH. It is a declared dependency of this package; if you installed " +
        "globally it should be at <npm prefix>/bin/telepty. Run 'telepty-install' to set up the " +
        "daemon. Dispatch will not function until it is reachable.",
    );

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

  info(`${summary.written.length} written, ${summary.preserved.length} preserved, ${summary.skipped.length} unchanged`);
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
  const r = spawnSync("bash", opts.force ? [script, "--force"] : [script], { encoding: "utf8" });
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
  if (!fs.existsSync(cfgPath)) {
    fs.writeFileSync(cfgPath, substitute(template, subs));
    summary.written.push(cfgPath);
    info(`wrote ${cfgPath}`);
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

const substitute = (text, subs) =>
  Object.entries(subs).reduce((acc, [token, value]) => acc.split(token).join(value), text);

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
  const text = `Control workspace ready: ${ws}
  ${counts.governance} governance files, ${counts.scaffold} scaffold files, state/ initialised empty.

Next:
  1. cd ${ws}
  2. telepty-install                # if the daemon is not yet running (telepty owns this)
  3. bin/orchestrator-boot.sh       # boots the orchestrator session

Do NOT boot with a bare \`claude\`. bin/orchestrator-boot.sh enforces the
singleton-at-boot guard (#539): a bare \`telepty allow --id orchestrator\` is
idempotent, so a second bare boot silently shares the session and a later
SIGTERM cascades a close to the live one.

Not installed by init:
${notInstalled}
`;
  fs.writeFileSync(path.join(ws, "GETTING-STARTED.md"), text);
  step("Step 7 — next steps");
  console.log(text);
}

function stamp(ws, subs) {
  const h = createHash("sha256");
  for (const rel of MANIFEST)
    h.update(rel).update("\0").update(createHash("sha256").update(fs.readFileSync(path.join(PKG_ROOT, rel))).digest());
  fs.writeFileSync(
    path.join(ws, ".aigentry-init.json"),
    JSON.stringify(
      { version: PKG.version, installedAt: subs["{{CREATED_AT}}"], manifestDigest: h.digest("hex"), workspace: ws },
      null,
      2,
    ) + "\n",
  );
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
  dependencyChecks();
  const { ws } = await resolveWorkspace(opts);

  if (opts.dryRun) {
    dryRun(ws);
    process.exit(0);
  }

  const subs = {
    "{{CONSTITUTION_PATH}}": path.join(AIGENTRY_HOME, "CONSTITUTION.md"),
    "{{CONTROL_WORKSPACE}}": ws,
    "{{DEVICE_ID}}": `device-${os.hostname()}`,
    "{{CREATED_AT}}": new Date().toISOString(),
  };

  verifyPackageComplete();
  copyManifest(ws, opts);
  createState(ws, opts);
  const scaffoldWritten = await scaffold(ws, opts, subs);
  substituteAll(ws, scaffoldWritten, subs);
  stamp(ws, subs);

  const scaffoldCount = MANIFEST.filter((p) => p.startsWith(SCAFFOLD_PREFIX)).length;
  guidance(ws, { governance: MANIFEST.length - scaffoldCount, scaffold: scaffoldCount });

  step("Step 8 — summary");
  console.log(
    `  written   ${summary.written.length}\n` +
      `  preserved ${summary.preserved.length}\n` +
      `  skipped   ${summary.skipped.length}\n` +
      `  warned    ${summary.warned.length}`,
  );
}

main().catch((e) => die(1, e.stack || e.message));
