#!/usr/bin/env node
// boot-prepare.mjs — ADR-MF #4 + #13 wiring bridge for cwd→role contamination fix (#431).
// Hybrid (b-2)+(c): --append-system-prompt-file (OAuth-compatible) + sandbox cwd
//                   (project CLAUDE.md not auto-discovered).
//
// Why hybrid:
//   (b-1) `--bare` was auth-incompatible — `claude --help` for --bare:
//     "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings
//      (OAuth and keychain are never read)."
//   Empirical probe under user's OAuth env → "Not logged in · Please run /login".
//   See ADR 2026-05-12 addendum (#431) for the full incident.
//
//   (b-2) `--append-system-prompt-file` works under OAuth (verified end-to-end
//   `claude --append-system-prompt-file <role.md> --print "Say one word: ROLE"`
//   → returned `ROLE`). The role contract attaches to system-prompt level
//   (high precedence) — claude's default system prompt is preserved.
//
//   (c) Sandbox cwd `$HOME/.aigentry/role-sandbox/<role>-<sid>/`: the wrapped
//   CLI's process cwd. claude walks UP from cwd discovering CLAUDE.md;
//   sandbox has none → project-level CLAUDE.md (e.g.
//   aigentry-orchestrator/CLAUDE.md, the actual contamination source from the
//   2026-05-23 incident) cannot auto-load. User-global ~/.claude/CLAUDE.md
//   still loads (preserves Snyk At-Inception + common project rules — desirable).
//
//   AIGENTRY_TARGET_CWD env var carries the ORIGINAL --cwd into the worker so
//   any code that needs project access can `cd $AIGENTRY_TARGET_CWD` as its
//   first action.
//
// Output: JSON on stdout (parseable by dispatch.sh via python3):
//   {
//     "spawn_cli":   "<launcher_path>",
//     "extra_flags": "",
//     "spawn_cwd":   "<sandbox_path>",
//     "env":         { "AIGENTRY_TARGET_CWD": "<original_cwd>" }
//   }
//
// spawn_cli points at a per-session launcher.sh that EXPORTS env vars then
// EXECS claude with the staged flags. The launcher is necessary because cmux
// (the workspace host on this platform) drops env vars from the CLI invocation
// — only env set INSIDE the workspace shell propagates to the wrapped CLI.
// Verified empirically: `cmux new-workspace --command 'echo $X'` with X
// exported by the caller prints empty; `env X=val claude` works.
//
// Failure modes (per orchestrator reminder a): every unrecoverable error exits
// non-zero with a clear stderr message — never silently emit a broken contract.
//
// Scope: --cli claude | codex | gemini (#532). claude uses the flag-based path
// (--append-system-prompt-file). codex/gemini use the ADDITIVE path: the staged
// effective_prompt.md is also copied into the sandbox cwd under the CLI's
// auto-discovered context filename (codex AGENTS.md / gemini GEMINI.md), and the
// CLI config-home env (CODEX_HOME / GEMINI_CLI_HOME) is redirected to a
// per-session SHADOW home that symlink-mirrors the real home MINUS the global
// context doc — neutralizing the per-user global AGENTS.md/GEMINI.md leak while
// PRESERVING auth (auth.json / oauth_creds.json). The per-CLI knowledge lives in
// the boot adapter ({contextFile, homeEnv, homeExclude}); this script consumes it.
// See docs/superpowers/specs/2026-06-07-codex-gemini-role-injection.md.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

function die(msg, code = 1) {
  process.stderr.write(`boot-prepare: ${msg}\n`);
  process.exit(code);
}

function usage() {
  process.stdout.write(
    "Usage: boot-prepare.mjs --role R --cwd C --sid S [--cli claude|codex|gemini]\n" +
      "  Emits a JSON object on stdout with {spawn_cli, extra_flags, spawn_cwd, env}.\n" +
      "  Exits non-zero on any error.\n",
  );
}

function parseArgs(argv) {
  const out = { role: "", cwd: "", sid: "", cli: "claude" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--role": out.role = argv[++i] ?? ""; break;
      case "--cwd": out.cwd = argv[++i] ?? ""; break;
      case "--sid": out.sid = argv[++i] ?? ""; break;
      case "--cli": out.cli = argv[++i] ?? ""; break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        die(`unknown arg: ${a}`, 4);
    }
  }
  return out;
}

function instructionsRoot() {
  const envHome = process.env.AIGENTRY_HOME;
  if (envHome && envHome.length > 0) return join(envHome, "instructions");
  return join(homedir(), ".aigentry", "instructions");
}

function aigentryHome() {
  return process.env.AIGENTRY_HOME && process.env.AIGENTRY_HOME.length > 0
    ? process.env.AIGENTRY_HOME
    : join(homedir(), ".aigentry");
}

function ensureInstructionsTree() {
  const root = instructionsRoot();
  const commonPath = join(root, "common.md");
  if (existsSync(commonPath)) return root;
  const installer = join(REPO_ROOT, "bin", "install-instructions.sh");
  if (!existsSync(installer)) {
    die(
      `instructions root missing (${root}) and installer not found at ${installer}`,
      2,
    );
  }
  const r = spawnSync("bash", [installer], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  if (r.status !== 0) {
    const err = r.stderr ? r.stderr.toString().trim() : "(no stderr)";
    die(`install-instructions.sh failed (exit ${r.status}): ${err}`, 2);
  }
  if (!existsSync(commonPath)) {
    die(
      `install-instructions.sh succeeded but ${commonPath} still missing`,
      2,
    );
  }
  return root;
}

function shellQuote(s) {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_\-.\/=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Per-session sandbox dirs live under $HOME/.aigentry/role-sandbox/ but each
// path is fresh, so claude shows its trust-folder prompt on first launch
// (blocking the REPL). Mirror aigentry-devkit/bin/trust-path.sh's behavior
// in-process using node:fs so boot-prepare stays Article-17 (zero-dep)
// and orchestrator-local (sibling repo not invoked).
//
// Failure mode: if ~/.claude.json is absent or unwritable, emit a stderr warning
// and continue — the worst case is the worker hits the trust prompt at first
// launch (visible to the user), not a silent break.
async function ensureSandboxTrusted(sandboxCwd) {
  const claudeJson = join(homedir(), ".claude.json");
  if (!existsSync(claudeJson)) {
    process.stderr.write(
      `boot-prepare: WARNING ${claudeJson} not found; sandbox ${sandboxCwd} will show trust prompt\n`,
    );
    return;
  }
  let raw;
  try {
    raw = await readFile(claudeJson, "utf8");
  } catch (e) {
    process.stderr.write(
      `boot-prepare: WARNING read ${claudeJson} failed (${e?.message ?? e}); skipping auto-trust\n`,
    );
    return;
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(
      `boot-prepare: WARNING ${claudeJson} is not valid JSON; skipping auto-trust\n`,
    );
    return;
  }
  cfg.projects ??= {};
  const prior = cfg.projects[sandboxCwd];
  if (prior && prior.hasTrustDialogAccepted === true) return; // idempotent
  cfg.projects[sandboxCwd] = Object.assign(
    {
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      projectOnboardingSeenCount: 0,
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false,
    },
    prior ?? {},
    { hasTrustDialogAccepted: true },
  );
  // Atomic-ish: write to tmp then rename. Avoids torn writes if another tool
  // (or a parallel boot-prepare) reads concurrently.
  const tmp = `${claudeJson}.boot-prepare.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(cfg, null, 2));
    await rename(tmp, claudeJson);
  } catch (e) {
    process.stderr.write(
      `boot-prepare: WARNING write ${claudeJson} failed (${e?.message ?? e}); skipping auto-trust\n`,
    );
  }
}

// Per-CLI memory-file noun for the session contract wording. claude auto-loads
// CLAUDE.md; codex AGENTS.md; gemini GEMINI.md. Defaults to a neutral phrase so a
// future CLI without a registered noun still reads sensibly (#532).
function projectMemoryNoun(cli) {
  switch (cli) {
    case "claude": return "CLAUDE.md";
    case "codex": return "AGENTS.md";
    case "gemini": return "GEMINI.md";
    default: return "project context file";
  }
}

function buildSessionContract({ role, sandboxCwd, targetCwd, sid, cli }) {
  // Documented session contract — no surprise for the worker. Appended to the
  // staged effective_prompt.md. claude reads it via --append-system-prompt-file;
  // codex/gemini read it via the staged cwd context file (AGENTS.md / GEMINI.md)
  // they auto-discover. Either way it sits at role/system level, high precedence
  // over any auto-loaded project memory.
  const memNoun = projectMemoryNoun(cli);
  return (
    `\n` +
    `---\n` +
    `\n` +
    `## Session boot contract (#431 — ADR 2026-05-12 hybrid)\n` +
    `\n` +
    `This session was spawned with role-cwd decoupling enforced at the process boundary.\n` +
    `\n` +
    `- **Role**: \`${role}\` (from boot-prepare; overrides any role hinted by your shell cwd)\n` +
    `- **Sandbox cwd** (your shell pwd): \`${sandboxCwd}\` — clean directory, no project ${memNoun} auto-loaded\n` +
    `- **Target project cwd**: \`${targetCwd}\` — \`cd $AIGENTRY_TARGET_CWD\` as your first action if you need git operations or relative-path access\n` +
    `- **AIGENTRY_TARGET_CWD** env var = \`${targetCwd}\`\n` +
    `- **Session id**: \`${sid}\`\n` +
    `\n` +
    `The role contract above takes precedence over any per-project ${memNoun} you may later discover via tool calls or \`cd\`. Do not infer your role from cwd; trust this contract.\n`
  );
}

// #532 shadow config-home builder. Mirrors every top-level entry of the real CLI
// config-home into a per-session shadow dir via symlinks, EXCEPT the global
// context doc(s) in `exclude`. This neutralizes the per-user global
// AGENTS.md/GEMINI.md leak while PRESERVING auth + settings + skills (symlinked,
// not copied). An empty home would hard-break auth (creds live there), so the
// mirror is strictly safer than a blank CODEX_HOME/GEMINI_CLI_HOME.
//
// Graceful degradation: if the real home is absent there is no auth to preserve,
// so the shadow is just an empty dir (warned). Symlink targets are absolute
// real-home paths; entry names come from readdir (basenames only) so no path
// traversal escapes the shadow dir. Re-run safe (EEXIST per-entry is ignored).
async function buildShadowHome(homeReal, homeShadow, exclude) {
  await mkdir(homeShadow, { recursive: true });
  let entries;
  try {
    entries = await readdir(homeReal);
  } catch (e) {
    process.stderr.write(
      `boot-prepare: WARNING config-home ${homeReal} not readable (${e?.message ?? e}); ` +
        `shadow home is empty — CLI auth may be unavailable\n`,
    );
    return;
  }
  const excludeSet = new Set(exclude);
  for (const name of entries) {
    if (excludeSet.has(name)) continue;
    try {
      await symlink(join(homeReal, name), join(homeShadow, name));
    } catch (e) {
      if (e?.code === "EEXIST") continue;
      process.stderr.write(
        `boot-prepare: WARNING could not mirror ${name} into shadow home (${e?.message ?? e})\n`,
      );
    }
  }
}

// TOML basic-string quoting for a `[projects."<path>"]` key. Paths are absolute
// POSIX (assertCwdSafe-validated) so backslash/quote are not expected, but escape
// the two basic-string metachars defensively to keep emitted TOML valid.
function tomlBasicString(s) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// #552: codex shows an interactive folder-trust modal ("Do you trust this
// directory? 1.Yes 2.No") on a fresh role-sandbox cwd, blocking its REPL —
// dispatch.sh's ready-probe then times out (30s) BEFORE the inject, aborting the
// dispatch. `--dangerously-bypass-approvals-and-sandbox` does NOT bypass
// folder-trust (verified live, codex 0.133.0). Pre-seed the trust exactly the way
// codex itself records it (verified from a live #551 dispatch: codex wrote
// `[projects."<abspath>"]\ntrust_level = "trusted"` into config.toml after the
// user answered "Yes"). Trust is keyed on the project root — the sandbox is a
// non-git dir so codex uses the exact cwd path; the inherited `[projects."$HOME"]`
// entry does NOT cover it (that is why the modal fires despite it).
//
// Boundary: write ONLY into the per-session SHADOW config.toml. buildShadowHome
// SYMLINKS config.toml to the real ~/.codex/config.toml, so we de-symlink it
// first (writeFile through a symlink would follow it and mutate the real file —
// violating the credential/config boundary) and replace it with a real copy
// carrying the extra trust entry. auth.json stays a symlink, untouched.
//
// Graceful degradation mirrors ensureSandboxTrusted: any FS failure → stderr
// WARNING + continue (worst case the worker hits the modal, visible to the user,
// not a silent break). Re-run safe: rebuilt from the real config each time.
async function ensureCodexTrust(homeReal, homeShadow, sandboxCwd) {
  const realConfig = join(homeReal, "config.toml");
  const shadowConfig = join(homeShadow, "config.toml");
  let base = "";
  if (existsSync(realConfig)) {
    try {
      base = await readFile(realConfig, "utf8");
    } catch (e) {
      process.stderr.write(
        `boot-prepare: WARNING read ${realConfig} failed (${e?.message ?? e}); codex may show trust modal\n`,
      );
      return;
    }
  }
  // Match codex's on-disk key to the path codex actually checks: codex resolves
  // its cwd via getcwd() (symlinks collapsed), so the trust key must be the
  // CANONICAL sandbox path. With the default ~/.aigentry (no symlinks) this equals
  // sandboxCwd, but a symlinked AIGENTRY_HOME (e.g. under macOS /tmp → /private/tmp)
  // would otherwise silently mismatch and re-expose the modal. realpath needs the
  // dir to exist — it does (mkdir'd before this runs); fall back to the literal
  // path if resolution fails.
  let canonicalCwd = sandboxCwd;
  try {
    canonicalCwd = await realpath(sandboxCwd);
  } catch {
    // keep sandboxCwd
  }
  const key = `[projects.${tomlBasicString(canonicalCwd)}]`;
  // Append only when the real config does not already trust this exact path —
  // avoids a duplicate-key TOML parse error and keeps the op idempotent.
  const trustBlock = base.includes(key)
    ? ""
    : `\n# aigentry boot-prepare (#552): pre-trust this per-session role-sandbox cwd\n` +
      `# so codex starts past its folder-trust modal (else dispatch.sh ready-probe\n` +
      `# times out before inject). Shadow-home only — real ~/.codex/config.toml untouched.\n` +
      `${key}\ntrust_level = "trusted"\n`;
  // De-symlink before write: buildShadowHome symlinked config.toml to the real
  // file. Removing the link makes the writeFile below create a fresh real file in
  // the shadow instead of following the link into ~/.codex/config.toml.
  try {
    await unlink(shadowConfig);
  } catch (e) {
    if (e?.code !== "ENOENT") {
      process.stderr.write(
        `boot-prepare: WARNING could not unlink shadow ${shadowConfig} (${e?.message ?? e}); codex may show trust modal\n`,
      );
      return;
    }
  }
  try {
    await writeFile(shadowConfig, base + trustBlock);
  } catch (e) {
    process.stderr.write(
      `boot-prepare: WARNING write shadow ${shadowConfig} failed (${e?.message ?? e}); codex may show trust modal\n`,
    );
  }
}

// CWE-23 path-traversal mitigation (Snyk #431 review): sid flows into
// `$HOME/.aigentry/sessions/<sid>/boot/launcher.sh` (chmodSync) and into
// `$HOME/.aigentry/role-sandbox/<role>-<sid>/`. Restrict to a conservative
// charset so traversal (`..`, `/`, NUL) and shell metachars cannot escape the
// intended subtree. Telepty sid convention is already `${track}-${name}` of
// the same charset.
const SID_CHARSET = /^[A-Za-z0-9_.\-]{1,128}$/;

function assertSidSafe(sid) {
  if (!SID_CHARSET.test(sid)) {
    die(`--sid contains disallowed characters or is too long: ${JSON.stringify(sid)}`, 4);
  }
}

function assertCwdSafe(cwd) {
  // Allow only absolute POSIX paths. Rejects `..`, relative paths, NUL.
  if (cwd.length === 0 || cwd[0] !== "/" || cwd.includes("\0") || /(^|\/)\.\.(\/|$)/.test(cwd)) {
    die(`--cwd must be an absolute path without '..' segments: ${JSON.stringify(cwd)}`, 4);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.role) die("--role required", 4);
  if (!args.cwd) die("--cwd required", 4);
  if (!args.sid) die("--sid required", 4);
  assertSidSafe(args.sid);
  assertCwdSafe(args.cwd);
  // #532: gate lifted from claude-only to claude|codex|gemini. Unknown CLIs are
  // still rejected here (and again by getBootAdapter's registry) with a non-zero
  // exit + clear stderr — never a silent broken contract.
  const SUPPORTED_CLIS = ["claude", "codex", "gemini"];
  if (!SUPPORTED_CLIS.includes(args.cli)) {
    die(
      `unsupported --cli ${JSON.stringify(args.cli)}; supported: ${SUPPORTED_CLIS.join(", ")}`,
      4,
    );
  }

  ensureInstructionsTree();

  const distMarker = join(
    REPO_ROOT,
    "dist",
    "src",
    "session",
    "boot-adapter",
    "index.js",
  );
  if (!existsSync(distMarker)) {
    die(`dist/ not built — run 'npm run build' in ${REPO_ROOT}`, 2);
  }

  const { resolveInstructions } = await import(
    join(REPO_ROOT, "dist/src/session/resolve-instructions.js")
  );
  const { getBootAdapter, nodeBootFs, nodeSpawner } = await import(
    join(REPO_ROOT, "dist/src/session/boot-adapter/index.js")
  );
  const { isRole } = await import(
    join(REPO_ROOT, "dist/src/session/types.js")
  );

  if (!isRole(args.role)) die(`unknown role: ${args.role}`, 4);

  // Sandbox cwd: $HOME/.aigentry/role-sandbox/<role>-<sid>/ (hybrid (c) leg).
  // Contains no CLAUDE.md → cwd auto-discovery yields no project memory.
  const sandboxCwd = join(
    aigentryHome(),
    "role-sandbox",
    `${args.role}-${args.sid}`,
  );
  await mkdir(sandboxCwd, { recursive: true });
  // claude-only: pre-accept the fresh sandbox in ~/.claude.json (skips claude's
  // trust modal). gemini uses --skip-trust (§3.3); codex relies on
  // --dangerously-bypass-approvals-and-sandbox (folder-trust verified live, §5).
  if (args.cli === "claude") {
    await ensureSandboxTrusted(sandboxCwd);
  }

  const fs = nodeBootFs();
  const resolved = await resolveInstructions(
    {
      role: args.role,
      cwd: sandboxCwd, // resolveInstructions reads project_id from cwd; sandbox = no project layer
      task_prompt: "",
      task_source_path: "<dispatch-deferred>",
    },
    fs,
  );

  const stagingDir = join(aigentryHome(), "sessions", args.sid, "boot");
  await mkdir(stagingDir, { recursive: true });

  // ctx.cwd = sandbox so the boot adapter sets claude's process cwd to sandbox
  // (claude.ts: needScratchCwd=false → cmd.cwd = ctx.cwd).
  const ctx = {
    session_id: args.sid,
    role: args.role,
    cwd: sandboxCwd,
    task_id: args.sid,
    effective_prompt_digest: resolved.effective_prompt_digest,
    effective_prompt_path: join(stagingDir, "effective_prompt.md"),
    layers: resolved.layers,
    spawn_chain: [args.sid],
    depth: 0,
    created_at: new Date().toISOString(),
  };

  const adapter = getBootAdapter(args.cli);
  const cmd = await adapter.buildBootCommand(ctx, resolved, {
    staging_dir: stagingDir,
    fs,
    spawner: nodeSpawner(),
  });

  if (!existsSync(cmd.prompt_file)) {
    die(`buildBootCommand returned but ${cmd.prompt_file} missing`, 2);
  }

  // Append session contract — documents sandbox + target cwd. claude reads it via
  // --append-system-prompt-file; codex/gemini read it via the staged cwd context
  // file (below). Either way the worker reads it at boot alongside the role layer.
  await appendFile(
    cmd.prompt_file,
    buildSessionContract({
      role: args.role,
      sandboxCwd,
      targetCwd: args.cwd,
      sid: args.sid,
      cli: args.cli,
    }),
  );

  // #532 additive path (codex/gemini): the role prompt is delivered NOT by a flag
  // (none exists) but by (a) copying the finished effective_prompt.md into the
  // sandbox cwd under the CLI's auto-discovered context filename, and (b)
  // redirecting the CLI config-home env to a per-session shadow home that mirrors
  // the real home minus the global doc (neutralizes the per-user global
  // AGENTS.md/GEMINI.md leak; preserves auth). claude leaves both as no-ops.
  const homeEnvAssignments = {};
  if (adapter.contextFile) {
    await copyFile(cmd.prompt_file, join(sandboxCwd, adapter.contextFile));
  }
  if (adapter.homeEnv) {
    const homeRealEnv = process.env[adapter.homeEnv];
    const homeReal =
      homeRealEnv && homeRealEnv.length > 0
        ? homeRealEnv
        : join(homedir(), `.${args.cli}`);
    const homeShadow = join(sandboxCwd, `.${args.cli}home`);
    await buildShadowHome(homeReal, homeShadow, adapter.homeExclude);
    // #552: codex-only — pre-seed folder-trust for the sandbox cwd in the shadow
    // config.toml so codex skips its blocking trust modal at boot (no probe
    // timeout). Other CLIs handle trust via their own flags (gemini --skip-trust).
    if (args.cli === "codex") {
      await ensureCodexTrust(homeReal, homeShadow, sandboxCwd);
    }
    homeEnvAssignments[adapter.homeEnv] = homeShadow;
  }

  // claude appends --permission-mode bypassPermissions to the staged flags. The
  // codex/gemini default flags (from the adapter) already carry their own
  // bypass/yolo modes, so no claude-specific flag is added.
  const flagsArgv =
    args.cli === "claude"
      ? [...cmd.argv.slice(1), "--permission-mode", "bypassPermissions"]
      : [...cmd.argv.slice(1)];
  const flagsLine = flagsArgv.map(shellQuote).join(" ");

  // Per-session launcher.sh — exports env (AIGENTRY_TARGET_CWD always; the CLI
  // config-home redirect for codex/gemini) then execs the wrapped CLI with the
  // staged flags. exec -a <cli> preserves argv[0] so `telepty list` and the
  // dispatch.sh prompt-symbol probe still resolve the right CLI name.
  const sessionsRoot = resolve(aigentryHome(), "sessions");
  const launcherPath = resolve(stagingDir, "launcher.sh");
  // Defense-in-depth: even though sid/cwd are charset-validated above, confirm
  // the resolved launcher path remains under ~/.aigentry/sessions/ before any
  // mode-bit write. Snyk CWE-23 hardening (#431 review).
  if (!`${launcherPath}${sep}`.startsWith(`${sessionsRoot}${sep}`)) {
    die(`launcher path escaped sessions root: ${launcherPath}`, 2);
  }
  const execName = cmd.argv[0]; // "claude" | "codex" | "gemini"
  const homeExportLines = Object.entries(homeEnvAssignments)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}\n`)
    .join("");
  const launcherBody =
    `#!/usr/bin/env bash\n` +
    `# Per-session launcher (#431 hybrid + #532 codex/gemini additive path).\n` +
    `# Exports env (cmux drops env from the CLI invocation; this wrapper restores\n` +
    `# it inside the workspace shell) then execs ${execName} with the staged flags.\n` +
    `# Role prompt: claude via --append-system-prompt-file; codex/gemini via the\n` +
    `# staged cwd context file (AGENTS.md / GEMINI.md) + config-home shadow home.\n` +
    `export AIGENTRY_TARGET_CWD=${shellQuote(args.cwd)}\n` +
    homeExportLines +
    `exec -a ${shellQuote(execName)} ${shellQuote(execName)} ${flagsLine} "$@"\n`;
  // writeFile with mode atomically sets +x — avoids a separate chmodSync call
  // (CWE-23 Snyk avoidance: single FS op on the validated path).
  await writeFile(launcherPath, launcherBody, { mode: 0o755 });

  const out = {
    spawn_cli: launcherPath,
    extra_flags: "",
    spawn_cwd: sandboxCwd,
    env: { AIGENTRY_TARGET_CWD: args.cwd, ...homeEnvAssignments },
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().catch((e) => die(e?.message ?? String(e), 1));
