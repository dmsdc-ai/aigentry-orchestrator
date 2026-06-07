// ADR-MF #13 — Codex adapter.
// #532 reconcile (2026-06-07): the prior `--cd` argv + speculative
// CODEX_NO_CONTEXT_AUTOLOAD / CODEX_SYSTEM_PROMPT_FILE env DO NOT EXIST in the
// shipped CLI (verified against codex 0.133.0: no `--system-prompt` /
// `--append-system-prompt` / `--instructions`; no context-autoload env). The
// additive role-injection design (spec 2026-06-07-codex-gemini-role-injection)
// delivers the role prompt via a cwd `AGENTS.md` that codex auto-discovers
// additively, and neutralizes the per-user global `$CODEX_HOME/AGENTS.md` by
// redirecting CODEX_HOME to a per-session shadow home (symlink-mirror minus the
// global doc). boot-prepare.mjs owns the cwd staging + shadow-home build; this
// adapter only declares the REAL launch flags + the additive descriptor.
import { makeAdapter } from "./common.js";

// Verified-present floor (codex 0.133.0 supports cwd AGENTS.md auto-discovery +
// --dangerously-bypass-approvals-and-sandbox). semverGte(installed, min) gates,
// so newer versions still pass.
export const CODEX_MIN_VERSION = "0.133.0";
// Additive cwd context file codex auto-discovers (codex_core::agents_md).
export const CODEX_CONTEXT_FILE = "AGENTS.md";
// Config-home env (default ~/.codex); holds auth.json + the Global AGENTS.md.
export const CODEX_HOME_ENV = "CODEX_HOME";
// Global-doc filenames excluded from the shadow-home mirror (everything else —
// auth.json, config.toml, skills/ — is symlink-preserved). codex also reads
// AGENTS.override.md at Global scope. UPSTREAM-GAP: if a future codex adds a new
// global context filename, add it here (else it re-leaks soft, never breaks auth).
export const CODEX_HOME_EXCLUDE: readonly string[] = Object.freeze([
  "AGENTS.md",
  "AGENTS.override.md",
]);

export function codexAdapter() {
  return makeAdapter({
    name: "codex",
    min_version: CODEX_MIN_VERSION,
    needScratchCwd: false, // additive path runs in ctx.cwd (sandbox), no /control dir
    codeCwdFlag: null, // do NOT pass -C/--cd (re-exposes project AGENTS.md, §4)
    contextFile: CODEX_CONTEXT_FILE,
    homeEnv: CODEX_HOME_ENV,
    homeExclude: CODEX_HOME_EXCLUDE,
    buildArgvEnv: () => ({
      argv: [
        "codex",
        "-c",
        "check_for_update_on_startup=false",
        "--dangerously-bypass-approvals-and-sandbox",
      ],
      env: {},
    }),
  });
}
