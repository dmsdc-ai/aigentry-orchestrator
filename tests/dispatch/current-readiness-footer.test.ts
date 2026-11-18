// #1136 — the rendered completed-duration footer must not read as a live spinner.
//
// Source-level, portable regression coverage for the current-screen readiness arm of
// bin/session-probe.py (candidate a2545602). Compiles to
// `dist/tests/dispatch/current-readiness-footer.test.js`, which scripts/run-tests.mjs
// collects by its recursive `*.test.js` walk of `dist/tests` — the runner is unchanged
// and T144's `dist/tests/dispatch/…` neighbours prove the layout. The compiled pathname
// is asserted below rather than asserted about in prose.
//
// What it exercises: the REAL functions in the repo's own bin/session-probe.py —
// `current_controls`, `classify_surface(current=True)` and `ready_by_current_screen`,
// plus `current_busy_signal` / `has_spinner`, and one guard that the legacy
// `--screen-file` / `ready_by_screen` path is untouched. The probe is hyphenated, so it
// is imported by path through Python's stdlib importlib with its own `bin/` on
// sys.path (that is how it binds the sibling `current_screen.py`), inside ONE bounded
// `python3` subprocess that is handed its cases as JSON on stdin and answers with JSON.
//
// Offline and non-sensitive by construction: every screen below is a synthetic string
// built in this file. No terminal, telepty/cmux, provider, network or live capture is
// touched, and nothing is written anywhere. The two settled-session viewports that
// originally reproduced the bug were real captures; they are reduced here to their
// load-bearing shape (reply text, blank line, bare duration row, rule-framed empty
// composer, mode bar) with generic text — no private paths, session ids or user content.
//
// Readiness is a screen observation only. Nothing here says a task finished, that work
// was delivered, or that any modal may be answered.
//
// #1284 — codex-cli 0.170.0 moved its footer: the row below the model/cwd row now reads
// `  ← for agents · ? for shortcuts … ⚠ 1 warning · f2 to view`, so the closed pattern in
// `codex_current_composer` stopped recognizing it, an idle and EMPTY 0.170.0 composer
// could never read as empty, and no dispatch could be delivered to such a session — safe,
// but undispatchable. The #1284 block at the end of this file drives the SAME real
// functions on the measured 0.170.0 capture, copied in verbatim below. Everything above
// that block is unchanged.
//
// SCOPE NOTE on the "Offline and non-sensitive by construction" paragraph above: it
// describes the #1136 fixtures, where it holds for every screen. Two of its clauses do NOT
// hold for the #1284 fixture — "every screen below is a synthetic string" and "no private
// paths, session ids or user content". That fixture is a
// real capture, not a synthetic string, and it carries the captured session's own cwd — a
// role-sandbox path containing a session id. It is reproduced verbatim because the point
// of the case is that the reader meets codex's bytes exactly as codex emits them, and the
// path is part of the model/cwd row the reader must match. It carries no task content, no
// credential and no reply text. Still nothing is read from a terminal, telepty/cmux,
// provider or network at test time, and nothing is written anywhere.
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO } from "./model-router-fixtures.js";

// Test-only baseline override: point the suite at a staged/baseline copy of the probe to
// see it go red. The name is unique to this suite and is read HERE only — no product
// module or CLI consults it, and it is never written back into process.env, so a caller
// of session-probe.py can never be redirected by it.
const PROBE = process.env.AIGENTRY_1136_PROBE_UNDER_TEST?.trim() || join(REPO, "bin/session-probe.py");
// The runner also runs compiled tests on win32 (scripts/run-tests.mjs only skips the
// POSIX control harness there), where the launcher is usually `python`. A missing
// interpreter is a FAILURE, never a skip — see runDriver().
const PYTHON = process.platform === "win32" ? ["python3", "python"] : ["python3"];

const DRIVER = `
import importlib.util, json, sys

req = json.loads(sys.stdin.read())
probe = req["probe"]
sys.dont_write_bytecode = True
sys.path.insert(0, req["bin"])
spec = importlib.util.spec_from_file_location("agy1136_session_probe", probe)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def pipeline_surface(cli, raw):
    # Mirrors observe()'s live-screen resolution: classify, then re-classify the
    # controls pass. Not a copy of the product decision, just the same two calls.
    surface, _ = module.classify_surface(cli, raw, current=True)
    if surface in ("working", "idle", "welcome", module.SURFACE_UNKNOWN):
        surface, _ = module.classify_surface(cli, module.current_controls(cli, raw), current=True)
    return surface

def busy_after_controls(cli, raw):
    # Mirrors ready_by_current_screen()'s ordering: the controls pass FIRST, then the
    # busy check on its output. Feeding the raw viewport instead (the plain
    # current_busy_signal op) answers a different, deliberately kept question.
    return module.current_busy_signal(module.current_controls(cli, raw))

def call(case):
    fn = case["fn"]
    cli = case["cli"]
    screen = case["screen"]
    if fn == "current_controls":
        return module.current_controls(cli, screen)
    if fn == "busy_after_controls":
        return busy_after_controls(cli, screen)
    if fn == "ready_by_current_screen":
        return list(module.ready_by_current_screen(cli, screen, case["surface"]))
    if fn == "pipeline_surface":
        return pipeline_surface(cli, screen)
    if fn == "current_busy_signal":
        return module.current_busy_signal(screen)
    if fn == "has_spinner":
        return module.has_spinner(screen)
    if fn == "ready_by_screen":
        return list(module.ready_by_screen(cli, screen))
    if fn == "pipeline_ready":
        return list(module.ready_by_current_screen(cli, screen, pipeline_surface(cli, screen)))
    if fn == "legacy_surface":
        return module.classify_surface(cli, screen)[0]
    if fn == "codex_composer":
        return module.codex_current_composer(screen)
    raise SystemExit("unknown fn: " + fn)

json.dump({"probe": probe,
           "python": sys.version.split()[0],
           "unknown": module.SURFACE_UNKNOWN,
           "results": dict((c["id"], call(c)) for c in req["cases"])},
          sys.stdout, ensure_ascii=False)
`;

type Fn =
  | "current_controls"
  | "ready_by_current_screen"
  | "pipeline_surface"
  | "busy_after_controls"
  | "current_busy_signal"
  | "has_spinner"
  | "pipeline_ready"
  | "legacy_surface"
  | "codex_composer"
  | "ready_by_screen";
type Case = { id: string; fn: Fn; cli: string; screen: string; surface?: string };
type DriverOut = { probe: string; python: string; unknown: string; results: Record<string, unknown> };

// ── Fixtures: the measured shapes, reduced to generic text ──────────────────────────
const RULE = "─".repeat(99);
const PROMPT = "❯  "; // measured empty composer: the ❯ glyph then blank/NBSP padding
const MODE_BAR = "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents";
const ACTIVE_BAR = "  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt · ← for agents";
const BARE_FOOTER = "✻ Brewed for 4m 40s"; // the reported bug: completed row, no `· done`
const BARE_FOOTER_ALT = "✻ Cooked for 7m 37s"; // second settled session, same bare shape
const DONE_FOOTER = "✻ Crunched for 8m 55s · done  오후 3:24"; // measured tail: `done` + clock

const screen = (...body: string[]) => body.join("\n");
const idleFrame = (body: string[], prompt = PROMPT, bar = MODE_BAR) =>
  screen(...body, "", RULE, prompt, RULE, bar);

/** A settled session's current viewport: reply, bare completed row, empty composer. */
const settled = (footer: string) => idleFrame(["  HOLD — awaiting controller pull/decision.", "", footer]);
const IDLE_BARE = settled(BARE_FOOTER);
const IDLE_BARE_ALT = settled(BARE_FOOTER_ALT);
const IDLE_DONE = settled(DONE_FOOTER);
const IDLE_DONE_TOOLS = settled("✻ Crunched for 1h 2m 3s · done (7 tool uses)");
// A busy viewport with a populated composer — nothing about it may relax. Kept with a
// trailing newline because a real capture has one (the probe's controls pass drops that
// one byte on every tree, pre-existing; the assertion below is line-wise for that reason).
const ACTIVE_VIEWPORT = screen(
  "  ✻ Brewing… (esc to interrupt · ctrl+t to hide todos)",
  "", RULE, "❯ continue the parser work", RULE, ACTIVE_BAR, "",
);
const MODAL = idleFrame(["  Do you trust the files in this folder?", "  1. Yes, proceed", "  2. No, exit"]);
// Outside the measured grammar → the row stays, and a row that stays keeps blocking.
const AMBIGUOUS = [
  "✻ Brewed for 4m 40s · 1.2k tokens",        // token-count suffix: synthetic, never measured
  "✻ Brewed for 4m 40s · done · 1.2k tokens",
  "✻ Brewed for 4m 40s ·",                    // truncated separator
  "✻ Brewed for 4m 40s (esc to interrupt)",   // live control on the row
  "✻ Brewing… for 4m 40s",                    // active ellipsis
  "✻ Brewed for",                             // no duration
  "✻ Brewed for a while",                     // non-numeric duration
  "✻ Brewed for 4m 40s ← for agents",
  "✻ Compacting for 4m 40s · done …",
  "✻ Two words for 4m 40s",                   // not one word before ` for `
];
const UNREADY_SURFACES = ["unknown", "modal", "error", "unsubmitted", "crash", "raw_shell"];

// ── Cases ───────────────────────────────────────────────────────────────────────────
const ready = (id: string, screenText: string, surface: string): Case =>
  ({ id, fn: "ready_by_current_screen", cli: "claude", screen: screenText, surface });

// ── #1284 fixture: the MEASURED idle viewport of codex-cli 0.170.0 ───────────────────
// Copied in VERBATIM from the capture facts/CODEX-0.170.0-idle-screen-cmux.txt — the real
// viewport of a freshly started, idle, empty session of codex-cli 0.170.0. One row per
// array element so that no editor, formatter or lint autofix can rewrite the single-space
// rows the capture really has, joined by LF with the capture's one trailing LF; the sha256
// pins the exact bytes, so a later edit to the fixture fails loudly instead of quietly
// testing something codex never printed. See the SCOPE NOTE in the file header for what
// this capture does and does not contain.
// 0.170.0 renders `← for agents · ` IN FRONT of `? for shortcuts` on the footer row. The
// closed footer pattern in codex_current_composer refused that row, so the three footer
// rows stayed in the composer and this screen — an empty composer — read
// `no-empty-current-prompt` forever: never ready, never dispatchable.
const CODEX_0170_ROWS = [
  " ",
  "  >_ OpenAI Codex (v0.170.0)",
  "     /Users/duckyoungkim/.aigentry/role-sandbox/analyst-E-orch652-preflight-codex2-analyst-20261118",
  "  permissions: YOLO mode",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  "                                                                                            ⣀⣤⣤⣤⣀⣀",
  "                                                                                         ⣠⣶⣿⣿⣿⣿⣿⣿⣿⣿⣦⣤⣤⣤⣤⣤⣤⡀",
  "                                                                                       ⢀⣾⣿⣿⠿⠋⠉⠉⢉⣭⣿⣿⣿⣿⣿⠿⣿⣿⣿⣿⣷⣄",
  "                                                                                      ⣀⣾⣿⣿⠃ ⣀⣴⣾⣿⣿⡿⠟⠋ ⣀⡀ ⠈⠙⢿⣿⣿⣧",
  "                                                                                   ⣀⣶⣿⣿⣿⣿⡇ ⢸⣿⣿⡿⠛⠉⢀⣠⣴⣿⣿⣿⣷⣦⣀⠈⢻⣿⣿⡇",
  "                                                                                  ⣰⣿⣿⡿⢿⣿⣿⡇ ⢸⣿⣿⢀⣤⣶⣿⣿⣿⠟⠛⠻⣿⣿⣿⣿⣮⣿⣿⡷",
  "                                                                                 ⢰⣿⣿⡟⠁⢸⣿⣿⡇ ⢸⣿⣿⣿⣿⠿⠿⣿⣿⣿⣦⣄⡀⠈⠛⠿⣿⣿⣿⣧⡀",
  "                                                                                 ⣾⣿⣿⠃ ⢸⣿⣿⡇ ⢸⣿⣿⠋⠁  ⠈⠙⢻⣿⣿⣿⣶⣤⡀ ⠹⢿⣿⣷⡄",
  "                                                                                 ⢸⣿⣿⣇ ⠸⣿⣿⣷⣦⣼⣿⣿      ⢸⣿⣿⠻⢿⣿⣿⡇ ⠘⣿⣿⣿",
  "                                                                                 ⠈⢿⣿⣿⣦⡀⠈⠛⠿⣿⣿⣿⣿⣄⡀  ⢀⣠⣼⣿⣿  ⣿⣿⡇  ⣿⣿⣿⠇",
  "                                                                                   ⢻⣿⣿⣿⣷⣦⣀⠈⠙⠻⣿⣿⣿⣶⣶⣿⣿⣿⣿⣿  ⣿⣿⡇ ⣠⣿⣿⣿",
  "                                                                                   ⢸⣿⣿⡿⢿⣿⣿⣿⣦⣠⣴⣿⣿⣿⡿⠟⠋⢸⣿⣿  ⣿⣿⣷⣴⣿⣿⣿⠃",
  "                                                                                   ⠘⣿⣿⣷ ⠈⠛⢿⣿⣿⣿⠿⠋⠉ ⣠⣴⣿⣿⣿  ⣿⣿⣿⣿⣿⠟⠁",
  "                                                                                    ⠻⣿⣿⣿⣤⣀ ⠈⠉ ⢀⣤⣶⣿⣿⣿⠿⠟⠁ ⣰⣿⣿⡟⠋⠁",
  "                                                                                     ⠈⠿⣿⣿⣿⣿⣶⣾⣿⣿⣿⣿⠟⠋⠁  ⣠⣼⣿⣿⡟",
  "                                                                                        ⠙⠛⠛⠛⠻⠛⢿⣿⣿⣿⣿⣷⣾⣿⣿⣿⡿⠏",
  "                                                                                               ⠈⠙⠛⠿⠿⠿⠿⠛⠉",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  "› Ask Codex to do anything",
  " ",
  "  GPT-6.2-Astra medium · /Users/duckyoungkim/.aigentry/role-sandbox/analyst-E-orch652-preflight-codex2-analyst-20261118",
  "  ← for agents · ? for shortcuts                                                                                                                                         ⚠ 1 warning · f2 to view",
];
const CODEX_0170_IDLE = CODEX_0170_ROWS.join("\n") + "\n";
assert.equal(createHash("sha256").update(CODEX_0170_IDLE).digest("hex"), "6d7b65f24ccf9950433ee4196999b0fd73caca5da00ef59d525f44af3301df74",
  "CODEX_0170_IDLE must be the measured capture byte-for-byte");
/** The measured footer, model/cwd and placeholder rows, taken FROM the fixture. */
const CODEX_0170_FOOTER = CODEX_0170_ROWS[CODEX_0170_ROWS.length - 1];
const CODEX_0170_MODEL = CODEX_0170_ROWS[CODEX_0170_ROWS.length - 2];
const CODEX_0170_PROMPT = "› Ask Codex to do anything";
/** Each helper rewrites exactly one row of the measured screen (first occurrence; every
 *  rewritten row occurs exactly once, asserted in #1284(b)). Nothing else moves. */
const refootered = (footer: string) => CODEX_0170_IDLE.replace(CODEX_0170_FOOTER, footer);
const retyped = (promptRow: string) => CODEX_0170_IDLE.replace(CODEX_0170_PROMPT, promptRow);
// [name, screen, expected pipeline surface, expected ready, expected reason]
const CODEX_0170_CASES: [string, string, string, boolean, string][] = [
  // The bug, and the fix: the measured idle screen with an EMPTY composer is ready.
  ["0170-idle", CODEX_0170_IDLE, "idle", true, "prompt"],
  // The other newly accepted footer shape: the measured `← for agents · ` prefix in front
  // of the OTHER tail the reader's footer pattern already accepted on its own
  // (`· <n> warnings`). This pairing is a cross-product of two separately measured
  // segments rather than a field measurement of its own; it is pinned HERE so the whole
  // newly-accepted set is visible in one place and can be reviewed as such.
  ["0170-count-tail", refootered("  ← for agents · ? for shortcuts · 2 warnings"), "idle", true, "prompt"],

  // Text typed after the prompt: the footer is recognized and removed, so what remains is
  // exactly the typed text — and typed text is never an empty composer.
  ["0170-typed", retyped("› implement the footer fix"), "idle", false, "no-empty-current-prompt"],
  ["0170-typed-after-hint", retyped(CODEX_0170_PROMPT + " right now"), "idle", false, "no-empty-current-prompt"],
  ["0170-typed-continuation", retyped(CODEX_0170_PROMPT + "\n  second typed row"), "idle", false, "no-empty-current-prompt"],
  ["0170-typed-below-footer", CODEX_0170_IDLE + "pending input\n", "idle", false, "no-empty-current-prompt"],
  // An unsubmitted context-ref at the live prompt still reads through the new footer.
  ["0170-typed-marker", retyped("› [context-ref] pending task"), "unsubmitted", false, "current-surface-not-ready"],

  // UNKNOWN footer rows stay in the composer: nothing beyond the measured prefix is
  // tolerated, in any position on the row.
  ["0170-footer-extra-segment", refootered(CODEX_0170_FOOTER + " · 3 queued"), "idle", false, "no-empty-current-prompt"],
  ["0170-footer-extra-affordance", refootered(CODEX_0170_FOOTER.replace("← for agents · ", "← for agents · ctrl+r to expand · ")), "idle", false, "no-empty-current-prompt"],
  ["0170-footer-wrong-glyph", refootered(CODEX_0170_FOOTER.replace("←", "→")), "idle", false, "no-empty-current-prompt"],
  ["0170-footer-wrong-separator", refootered(CODEX_0170_FOOTER.replace("agents · ?", "agents, ?")), "idle", false, "no-empty-current-prompt"],
  ["0170-footer-no-separator-space", refootered(CODEX_0170_FOOTER.replace("agents · ?", "agents ·?")), "idle", false, "no-empty-current-prompt"],
  ["0170-footer-wrong-hint", refootered(CODEX_0170_FOOTER.replace("f2 to view", "f3 to view")), "idle", false, "no-empty-current-prompt"],
  ["0170-footer-no-count", refootered(CODEX_0170_FOOTER.replace("1 warning", "warning")), "idle", false, "no-empty-current-prompt"],
  ["0170-footer-unindented", refootered(CODEX_0170_FOOTER.slice(1)), "idle", false, "no-empty-current-prompt"],
  // The rest of the frame is still required: drop the blank separator row, or put an
  // unrecognized effort word on the model/cwd row, and the three rows are no longer the
  // recognized suffix. (An extra ` · <segment>` on the model row is NOT in this list: the
  // measured status segment has been recognized chrome since #1136 and is untouched here.)
  ["0170-no-separator", CODEX_0170_IDLE.replace(CODEX_0170_PROMPT + "\n \n", CODEX_0170_PROMPT + "\n"), "idle", false, "no-empty-current-prompt"],
  ["0170-model-row-unknown", CODEX_0170_IDLE.replace(CODEX_0170_MODEL, CODEX_0170_MODEL.replace(" medium ", " turbo ")), "idle", false, "no-empty-current-prompt"],
];

const CASES: Case[] = [
  // Positives — the fix: a bare completed row is not a spinner.
  ready("bare/ready", IDLE_BARE, "idle"),
  ready("bare-alt/ready", IDLE_BARE_ALT, "idle"),
  ready("done/ready", IDLE_DONE, "idle"),
  ready("done-tools/ready", IDLE_DONE_TOOLS, "idle"),
  { id: "bare/surface", fn: "pipeline_surface", cli: "claude", screen: IDLE_BARE },
  { id: "done/surface", fn: "pipeline_surface", cli: "claude", screen: IDLE_DONE },
  { id: "bare/controls", fn: "current_controls", cli: "claude", screen: IDLE_BARE },
  // Composed exactly as the product composes it: controls pass, then the busy check on
  // its output. `bare/raw-busy` is the paired control — the SAME raw viewport handed
  // straight to current_busy_signal still reads busy, so `false` below is the ordering's
  // doing and not an always-false answer.
  { id: "bare/controls-busy", fn: "busy_after_controls", cli: "claude", screen: IDLE_BARE },
  { id: "bare/raw-busy", fn: "current_busy_signal", cli: "claude", screen: IDLE_BARE },

  // Negatives — every gate that blocked still blocks.
  { id: "active/controls", fn: "current_controls", cli: "claude", screen: ACTIVE_VIEWPORT },
  { id: "active/busy", fn: "current_busy_signal", cli: "claude", screen: ACTIVE_VIEWPORT },
  ready("active/ready-idle", ACTIVE_VIEWPORT, "idle"),
  ready("active/ready-working", ACTIVE_VIEWPORT, "working"),
  ready("interrupt-bar/ready", idleFrame(["  Working on it.", "", BARE_FOOTER], PROMPT, ACTIVE_BAR), "idle"),
  ready("status-row/ready", idleFrame([BARE_FOOTER, "✻ Brewing… (esc to interrupt)"]), "idle"),
  { id: "spinner/has", fn: "has_spinner", cli: "claude", screen: idleFrame([BARE_FOOTER, "⠹ Reticulating splines"]) },
  ready("spinner/ready", idleFrame([BARE_FOOTER, "⠹ Reticulating splines"]), "idle"),
  ready("working/ready", IDLE_BARE, "working"),
  { id: "modal/surface", fn: "pipeline_surface", cli: "claude", screen: MODAL },
  ready("modal/ready-modal", MODAL, "modal"),
  ready("modal/ready-idle", MODAL, "idle"),
  ready("modal-footer/ready", idleFrame([BARE_FOOTER, "  Do you trust the files in this folder?"]), "idle"),
  ready("composer/ready", idleFrame(["  HOLD.", "", BARE_FOOTER], "❯ next task: fix the parser"), "idle"),
  ready("no-prompt/ready", screen("  HOLD.", "", BARE_FOOTER, "", RULE, RULE, MODE_BAR), "idle"),
  ready("blank/ready", "", "idle"),
  ...UNREADY_SURFACES.map((s) => ready(`surface/${s}`, IDLE_BARE, s)),

  // Unrecognized grammar fails closed: the row stays, readiness stays blocked, and an
  // explicit `done` row outside the grammar stays unknown — never "work started".
  ...AMBIGUOUS.flatMap((row, i): Case[] => {
    const raw = idleFrame(["  HOLD.", "", row]);
    return [
      { id: `ambiguous/${i}/controls`, fn: "current_controls", cli: "claude", screen: raw },
      ready(`ambiguous/${i}/ready`, raw, "idle"),
    ];
  }),
  {
    id: "unrecognized-done/surface", fn: "pipeline_surface", cli: "claude",
    screen: idleFrame(["  HOLD.", "", "✻ Crunched for 8m 55s · done · 1.2k tokens"]),
  },

  // Unchanged behaviour outside the claude current-viewport controls pass.
  ...["codex", "gemini", "grok", ""].map((cli): Case =>
    ({ id: `identity/${cli || "none"}`, fn: "current_controls", cli, screen: IDLE_BARE })),
  { id: "legacy/blank", fn: "ready_by_screen", cli: "claude", screen: "" },
  {
    id: "legacy/hard-negative", fn: "ready_by_screen", cli: "claude",
    screen: screen(BARE_FOOTER, "Working... (esc to interrupt)"),
  },
  { id: "legacy/prompt", fn: "ready_by_screen", cli: "claude", screen: IDLE_BARE },
  { id: "spinner/frame", fn: "has_spinner", cli: "claude", screen: "⠹ Reticulating splines" },
  { id: "spinner/logo", fn: "has_spinner", cli: "claude", screen: "⠙⠹⠸ logo art" },
  { id: "spinner/footer", fn: "has_spinner", cli: "claude", screen: BARE_FOOTER },

  // #1284 — the codex 0.170.0 footer, on the measured capture. New ids only; the cases
  // above are untouched.
  ...CODEX_0170_CASES.flatMap(([name, screenText]): Case[] => [
    { id: `codex/${name}/surface`, fn: "pipeline_surface", cli: "codex", screen: screenText },
    { id: `codex/${name}/ready`, fn: "pipeline_ready", cli: "codex", screen: screenText },
  ]),
  { id: "codex/0170/composer", fn: "codex_composer", cli: "codex", screen: CODEX_0170_IDLE },
  {
    id: "codex/0170/composer-unknown", fn: "codex_composer", cli: "codex",
    screen: refootered(CODEX_0170_FOOTER + " · 3 queued"),
  },
  { id: "codex/0170/has-spinner", fn: "has_spinner", cli: "codex", screen: CODEX_0170_IDLE },
  { id: "codex/0170/busy", fn: "current_busy_signal", cli: "codex", screen: CODEX_0170_IDLE },
  { id: "codex/0170/controls", fn: "current_controls", cli: "codex", screen: CODEX_0170_IDLE },
  { id: "codex/0170/legacy-surface", fn: "legacy_surface", cli: "codex", screen: CODEX_0170_IDLE },
  { id: "codex/0170/legacy-ready", fn: "ready_by_screen", cli: "codex", screen: CODEX_0170_IDLE },
];

// ── One bounded subprocess, at module load: an unusable probe or interpreter is a
// hard failure of this file (node --test exits nonzero), never a green skip. ─────────
function runDriver(cases: Case[]): DriverOut {
  if (!existsSync(PROBE)) throw new Error(`session-probe.py not found at ${PROBE} — cannot run #1136 coverage`);
  const input = JSON.stringify({ probe: PROBE, bin: dirname(PROBE), cases });
  const attempts: string[] = [];
  for (const exe of PYTHON) {
    const r = spawnSync(exe, ["-c", DRIVER], {
      input, encoding: "utf8", timeout: 60000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") { attempts.push(`${exe}: ENOENT`); continue; }
    if (r.error) throw new Error(`${exe} failed to run the #1136 probe driver: ${r.error.message}`);
    if (r.status !== 0 || r.signal) {
      throw new Error(`${exe} exited status=${r.status} signal=${r.signal} for ${PROBE}\n${r.stderr}`);
    }
    return JSON.parse(r.stdout) as DriverOut;
  }
  throw new Error(`no usable Python interpreter (${attempts.join(", ")}) — #1136 coverage FAILS rather than skips`);
}

const OUT = runDriver(CASES);
function got(id: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(OUT.results, id)) throw new Error(`no driver result for case ${id}`);
  return OUT.results[id];
}
/** Python's str.splitlines() semantics: a single trailing newline is not a line. */
const splitLines = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
const lines = (id: string) => splitLines(String(got(id)));

test("#1136(0): the suite ran the repo's own probe, every declared case answered, and it is the file the runner collects", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { name?: string };
  assert.equal(pkg.name, "@dmsdc-ai/aigentry-orchestrator", "REPO must resolve to the orchestrator repo, not a workstation path");
  assert.equal(relative(REPO, fileURLToPath(import.meta.url)).split(sep).join("/"),
    "dist/tests/dispatch/current-readiness-footer.test.js",
    "scripts/run-tests.mjs collects exactly this compiled pathname");
  assert.equal(OUT.probe, PROBE);
  assert.equal(Object.keys(OUT.results).length, CASES.length);
  assert.ok(CASES.length >= 40, `expected the full case set, got ${CASES.length}`);
  assert.match(OUT.python, /^3\./);
});

test("#1136(a): a settled Claude viewport whose completed row has NO `done` is ready — the reported regression", () => {
  for (const [id, footer] of [["bare/ready", BARE_FOOTER], ["bare-alt/ready", BARE_FOOTER_ALT]] as const) {
    assert.doesNotMatch(footer, /done/, "the whole point: the measured row is bare");
    assert.deepEqual(got(id), [true, "prompt"], id);
  }
  assert.equal(got("bare/surface"), "idle");
});

test("#1136(b): only the completed row is dropped — the composer survives and nothing is busy afterwards", () => {
  const kept = lines("bare/controls");
  const dropped = splitLines(IDLE_BARE).filter((line) => !kept.includes(line));
  assert.deepEqual(dropped.map((line) => line.trim()), [BARE_FOOTER]);
  assert.ok(kept.some((line) => line.trimEnd() === PROMPT.trimEnd()), "the empty composer must remain");
  assert.equal(got("bare/controls-busy"), false);
  // Sensitivity control for the line above: the bare footer DOES match the generic
  // leading-glyph busy pattern, so the raw viewport reads busy. Only the product's
  // controls-then-busy ordering clears it — if this ever went false the assertion above
  // would pass for the wrong reason.
  assert.equal(got("bare/raw-busy"), true, "the raw viewport still reads busy — the ordering is what clears it");
});

test("#1136(c): the explicit `done` tails stay ready — relaxing the tail did not narrow it", () => {
  assert.deepEqual(got("done/ready"), [true, "prompt"]);
  assert.deepEqual(got("done-tools/ready"), [true, "prompt"]);
  assert.equal(got("done/surface"), "idle");
});

test("#1136(d): a busy current viewport still blocks, and the controls pass is line-wise identity there", () => {
  // Line-wise, not byte-wise: current_controls drops a trailing newline on every tree
  // (pre-existing wart, documented by rt1136fn). No CONTENT row may be dropped.
  assert.deepEqual(lines("active/controls"), splitLines(ACTIVE_VIEWPORT));
  assert.equal(got("active/busy"), true);
  assert.deepEqual(got("active/ready-idle"), [false, "no-empty-current-prompt"]);
  assert.deepEqual(got("active/ready-working"), [false, "no-empty-current-prompt"]);
  // Sensitivity control for the identity assertion above: on a screen where the row IS
  // supposed to go, the same comparison is unequal. An always-true identity proves nothing.
  assert.notDeepEqual(lines("bare/controls"), splitLines(IDLE_BARE));
});

test("#1136(e): a live control anywhere in the viewport still blocks, even beside a completed row", () => {
  assert.deepEqual(got("interrupt-bar/ready"), [false, "current-busy-or-modal"], "interrupt affordance in the mode bar");
  assert.deepEqual(got("status-row/ready"), [false, "current-busy-or-modal"], "active status row above the composer");
  assert.equal(got("spinner/has"), true);
  assert.deepEqual(got("spinner/ready"), [false, "current-busy-or-modal"], "braille spinner");
  assert.deepEqual(got("working/ready"), [false, "current-working"], "a working surface is never relaxed by the footer");
});

test("#1136(f): trust/approval modals and populated or absent composers are never ready", () => {
  assert.equal(got("modal/surface"), "modal");
  assert.deepEqual(got("modal/ready-modal"), [false, "current-surface-not-ready"]);
  // Even handed an `idle` surface, the current-control gate blocks: readiness never answers a modal.
  assert.deepEqual(got("modal/ready-idle"), [false, "current-busy-or-modal"]);
  assert.deepEqual(got("modal-footer/ready"), [false, "current-busy-or-modal"]);
  assert.deepEqual(got("composer/ready"), [false, "no-empty-current-prompt"]);
  assert.deepEqual(got("no-prompt/ready"), [false, "no-empty-current-prompt"]);
});

test("#1136(g): blank evidence and unavailable surfaces fail closed", () => {
  assert.deepEqual(got("blank/ready"), [false, "no-empty-current-prompt"]);
  for (const surface of UNREADY_SURFACES) {
    assert.deepEqual(got(`surface/${surface}`), [false, "current-surface-not-ready"], surface);
  }
});

test("#1136(h): rows outside the measured grammar keep their row and keep blocking", () => {
  AMBIGUOUS.forEach((row, i) => {
    const raw = idleFrame(["  HOLD.", "", row]);
    assert.equal(got(`ambiguous/${i}/controls`), raw, `row must not be stripped: ${row}`);
    assert.deepEqual(got(`ambiguous/${i}/ready`), [false, "current-busy-or-modal"], row);
  });
  // Preserved negative result: the token-count suffix was synthetic, never a field
  // measurement, so it is NOT in the grammar. An unrecognized explicit `done` row stays
  // unknown — saying "done" is not evidence that work started, finished or is approved.
  assert.equal(got("unrecognized-done/surface"), OUT.unknown);
});

test("#1136(i): non-claude CLIs and the legacy --screen-file path are byte-for-byte unchanged", () => {
  for (const cli of ["codex", "gemini", "grok", ""]) {
    assert.equal(got(`identity/${cli || "none"}`), IDLE_BARE, `current_controls must be identity for cli=${cli || "(none)"}`);
  }
  assert.deepEqual(got("legacy/blank"), [false, "blank-screen"]);
  assert.deepEqual(got("legacy/hard-negative"), [false, "hard-negative"]);
  assert.deepEqual(got("legacy/prompt"), [true, "prompt"]);
  assert.equal(got("spinner/frame"), true);
  assert.equal(got("spinner/logo"), false, "braille logo art is not a spinner");
  assert.equal(got("spinner/footer"), false);
});

// ── #1284: the readiness reader must recognise the idle footer of codex-cli 0.170.0 ──
for (const [name, , surface, isReady, reason] of CODEX_0170_CASES) {
  test(`#1284(a): codex 0.170.0 footer ${name}`, () => {
    assert.equal(got(`codex/${name}/surface`), surface, name);
    assert.deepEqual(got(`codex/${name}/ready`), [isReady, reason], name);
  });
}

test("#1284(b): the measured idle 0.170.0 screen is ready, and ONLY its three footer rows are chrome", () => {
  // The row the old closed pattern refused, read off the fixture itself.
  assert.match(CODEX_0170_FOOTER, /^ {2}← for agents · \? for shortcuts {2,}⚠ 1 warning · f2 to view$/);
  assert.doesNotMatch(CODEX_0170_FOOTER, /^ {2}\? for shortcuts/, "the whole point: `? for shortcuts` no longer starts the row");
  // Each rewritten row must occur exactly once in the capture, or the helpers above would
  // be editing some other row of it.
  for (const row of [CODEX_0170_FOOTER, CODEX_0170_PROMPT, CODEX_0170_MODEL]) {
    assert.equal(CODEX_0170_IDLE.split(row).length - 1, 1, `row must occur once: ${row}`);
  }
  assert.deepEqual(got("codex/0170-idle/ready"), [true, "prompt"]);
  assert.equal(got("codex/0170-idle/surface"), "idle");
  // The composer the reader is left with is the placeholder row ALONE: the blank
  // separator, the model/cwd row and the footer row went, and nothing else did.
  assert.equal(got("codex/0170/composer"), CODEX_0170_PROMPT);
  // Sensitivity control for the line above: with ONE unknown segment on that same row the
  // footer is not chrome, so all three rows stay in the composer and the screen is not
  // ready. Without this, the assertion above could pass for an always-stripping reader.
  const kept = String(got("codex/0170/composer-unknown"));
  assert.ok(kept.startsWith(CODEX_0170_PROMPT), "the placeholder row still anchors the composer");
  assert.ok(kept.includes("· 3 queued"), "an unknown footer row stays IN the composer");
  assert.ok(kept.includes(CODEX_0170_MODEL), "and so does the model/cwd row above it");
  assert.deepEqual(got("codex/0170-footer-extra-segment/ready"), [false, "no-empty-current-prompt"]);
});

test("#1284(c): the 0.170.0 welcome logo art is not a spinner, and the codex controls pass is identity", () => {
  assert.equal(got("codex/0170/has-spinner"), false, "runs of adjacent braille cells are logo art, not a spinner frame");
  assert.equal(got("codex/0170/busy"), false);
  assert.equal(got("codex/0170/controls"), CODEX_0170_IDLE, "current_controls is identity for every non-claude kind");
});

test("#1284(d): the legacy --screen-file path is untouched by the footer change", () => {
  assert.equal(got("codex/0170/legacy-surface"), "idle");
  assert.deepEqual(got("codex/0170/legacy-ready"), [true, "prompt"]);
});
