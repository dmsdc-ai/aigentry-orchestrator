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

export function geminiAdapter() {
  return makeAdapter({
    name: "gemini",
    min_version: GEMINI_MIN_VERSION,
    needScratchCwd: false, // additive path runs in ctx.cwd (sandbox), no /control dir
    codeCwdFlag: null, // do NOT pass --include-directories <project> (re-leak, §4)
    contextFile: GEMINI_CONTEXT_FILE,
    homeEnv: GEMINI_HOME_ENV,
    homeExclude: GEMINI_HOME_EXCLUDE,
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
