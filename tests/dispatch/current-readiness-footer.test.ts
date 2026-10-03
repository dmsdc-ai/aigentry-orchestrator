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
