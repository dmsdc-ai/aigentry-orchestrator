// ADR-MF #13 — Gemini adapter.
// #532 reconcile (2026-06-07): the prior `--system` + `--workspace-root` flags
// and speculative GEMINI_NO_CONTEXT_AUTOLOAD env DO NOT EXIST in the shipped CLI
// (verified against gemini 0.42.0: no `--system`/`--system-instruction`; the real
// workspace flag is `--include-directories`). The additive role-injection design
// (spec 2026-06-07-codex-gemini-role-injection) delivers the role prompt via a
// cwd `GEMINI.md` that gemini auto-discovers additively as memory/context, and
// neutralizes the per-user global `$GEMINI_CLI_HOME/GEMINI.md` by redirecting
// GEMINI_CLI_HOME to a per-session shadow home (symlink-mirror minus the global
// doc). boot-prepare.mjs owns the cwd staging + shadow-home build; this adapter
// only declares the REAL launch flags + the additive descriptor.
import { makeAdapter } from "./common.js";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function geminiBinary(env: NodeJS.ProcessEnv = process.env): "agy" | "gemini" {
  if (env.AIGENTRY_GEMINI_BINARY === "gemini" || env.AIGENTRY_GEMINI_BINARY === "agy") return env.AIGENTRY_GEMINI_BINARY;
  return (env.PATH || "").split(delimiter).some((dir) => {
    try { accessSync(join(dir, "agy"), constants.X_OK); return true; } catch { return false; }
  }) ? "agy" : "gemini";
}

// Verified-present floor (gemini 0.42.0 supports cwd GEMINI.md auto-discovery +
// --approval-mode yolo + --skip-trust). semverGte(installed, min) gates.
export const GEMINI_MIN_VERSION = "0.42.0";
// Additive cwd context file gemini auto-discovers (contextFileName default).
export const GEMINI_CONTEXT_FILE = "GEMINI.md";
// Config-home env (default ~/.gemini); holds settings.json + oauth_creds.json +
// the global GEMINI.md.
export const GEMINI_HOME_ENV = "GEMINI_CLI_HOME";
// Global-doc filename excluded from the shadow-home mirror (oauth_creds.json +
// settings.json are symlink-preserved). UPSTREAM-GAP: extend if a future gemini
// adds a new global context filename (else soft re-leak, never an auth break).
export const GEMINI_HOME_EXCLUDE: readonly string[] = Object.freeze([
  "GEMINI.md",
]);
// #569: GEMINI_CLI_HOME is gemini's HOME, not its config dir. gemini reads creds
// + settings from `$GEMINI_CLI_HOME/.gemini/` (Storage.getGlobalGeminiDir() =
// join(homedir(), ".gemini"), and gemini's homedir() honors GEMINI_CLI_HOME).
// So the shadow mirror must land under this subdir — else gemini finds no creds
// at `$GEMINI_CLI_HOME/.gemini/` and falls through to its auth-selector (#569).
// Contrast codex: CODEX_HOME IS the config dir directly (homeConfigSubdir=null).
export const GEMINI_CONFIG_SUBDIR = ".gemini";

export function geminiAdapter(binary: "agy" | "gemini" = "gemini") {
  if (binary === "agy") return makeAdapter({
    name: "gemini",
    min_version: "0.0.0", // no numeric version claim; capability-gated below
    capabilityProbe: { executable: "agy", flags: ["--model", "--dangerously-skip-permissions"] },
    // #1093: agy takes the role contract as a cwd rule file, NOT as a first prompt.
    // agy 1.1.27 has no --rules / system-prompt flag, so #1083 delivered it via
    // --prompt-interactive — and an interactive first prompt reads as "do this
    // now": the #1090 probe ran ps/read-screen/cat with no task ref delivered.
    // agy auto-discovers cwd GEMINI.md/AGENTS.md as always-on rules (measured
    // interactively, agy 1.1.27: a bare cwd GEMINI.md steered the reply with and
    // without a git root; --print ignores it, workers are interactive), so the
    // #532 additive contextFile path carries it at rule level instead.
    contextFile: GEMINI_CONTEXT_FILE,
    // No homeEnv: agy honors only $HOME (#1090) — it gets no shadow home, so its
    // global-doc surface (~/.gemini/config/) is untouched here, as before.
    buildArgvEnv: () => ({ argv: ["agy", "--model", process.env.AIGENTRY_GEMINI_MODEL || "gemini-3.8-flash-high",
      "--dangerously-skip-permissions",
      ...(process.env.AIGENTRY_GEMINI_EFFORT ? ["--effort", process.env.AIGENTRY_GEMINI_EFFORT] : [])], env: {} }), // #1084 opt-in
  });
  return makeAdapter({
    name: "gemini",
    min_version: GEMINI_MIN_VERSION,
    contextFile: GEMINI_CONTEXT_FILE,
    homeEnv: GEMINI_HOME_ENV,
    homeExclude: GEMINI_HOME_EXCLUDE,
    homeConfigSubdir: GEMINI_CONFIG_SUBDIR,
    buildArgvEnv: () => ({
      argv: [
        "gemini",
        "-m",
        process.env.AIGENTRY_GEMINI_MODEL || "gemini-2.5-flash",
        "--approval-mode",
        "yolo",
        "--skip-trust",
      ],
      env: {},
    }),
  });
}
