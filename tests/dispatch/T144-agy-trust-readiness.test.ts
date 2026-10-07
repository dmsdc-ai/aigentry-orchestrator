// T144 (#1090) — the readiness probe knows agy's (Antigravity CLI) screens.
//   (d) session-probe: the measured modal is not-ready/surface=modal; the measured
//       idle prompt is ready — with a --cli hint (dispatch) and without one
//       (dispatch-verify.sh / reconciler), where only the screen names the CLI —
//       and the live post-turn screen (header scrolled off) still reads as ready.
// Not ported from the control line: (a)-(c) pin boot-prepare's ensureAgyTrust, which this
// release does not ship — confined dispatch refuses grok/gemini (SANDBOX_CLI_UNSUPPORTED,
// exit 78), so nothing seeds agy's trustedWorkspaces. (e) pinned grok's first screen as
// ready on its mid-line `❯`; this release's anchored prompt readers (#1136) do not read it
// so (ready_reason no-prompt), and its not-a-modal half is T147(c) (surface working).
// Fixtures: agy_trust_modal.txt (orchestrator's measured screen, 2026-09-05),
// agy_welcome_idle.txt (pty capture, real HOME, pre-trusted dir), agy_idle_after_turn.txt
// (`telepty read-screen` of the live #1090 probe).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO } from "./model-router-fixtures.js";

const PROBE = join(REPO, "bin/session-probe.py");
const FIXTURES = join(REPO, "tests/dispatch/fixtures");
const PYTHON = process.env.PYTHON || "python3";

function probe(screen: string, cli?: string) {
  const r = spawnSync(PYTHON, [PROBE, "--sid", "sid-A", "--screen-file", join(FIXTURES, screen), "--info-file", join(FIXTURES, "agy_launcher.info"),
    ...(cli ? ["--cli", cli] : [])], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("T144(d): agy trust modal is not ready; agy idle prompt is ready — with and without a --cli hint", () => {
  const modal = probe("agy_trust_modal.txt", "gemini");
  assert.equal(modal.ready, false);
  assert.equal(modal.surface, "modal");
  const idle = probe("agy_welcome_idle.txt", "gemini");
  assert.equal(idle.ready, true);
  assert.equal(idle.detail.ready_reason, "prompt");
  // dispatch-verify.sh and the reconciler run the probe without --cli; the guard
  // launcher path names no CLI, so the agy header on screen has to.
  for (const [screen, want] of [["agy_welcome_idle.txt", { cli: "gemini", ready: true }], ["agy_trust_modal.txt", { cli: "gemini", ready: false, surface: "modal" }]] as const) {
    const got = probe(screen);
    for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${screen}: ${k}`);
  }
  // Live capture after agy's --prompt-interactive turn: no header left, only the
  // rule-framed `>` box — the anchor alone must carry readiness.
  const after = probe("agy_idle_after_turn.txt", "gemini");
  assert.equal(after.ready, true);
  assert.equal(after.detail.ready_reason, "prompt");
});
