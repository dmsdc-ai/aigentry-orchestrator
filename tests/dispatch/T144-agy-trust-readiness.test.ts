// T144 (#1090) — agy (Antigravity CLI) workers no longer stop at the folder-trust
// modal, and the readiness probe knows their screens.
//   (a) boot-prepare's agy arm appends the CANONICAL sandbox path to
//       `trustedWorkspaces` in $HOME/.gemini/antigravity-cli/settings.json — once,
//       keeping every other key and the 0600 mode (the fixture HOME lives under a
//       symlinked tmpdir, so the realpath assertion is real).
//   (b) no settings.json → one WARNING, nothing created: agy's tree is never invented.
//   (c) the Gemini CLI arm (--skip-trust) leaves agy's file alone.
//   (d) session-probe: the measured modal is not-ready/surface=modal; the measured
//       idle prompt is ready — with a --cli hint (dispatch) and without one
//       (dispatch-verify.sh / reconciler), where only the screen names the CLI —
//       and the live post-turn screen (header scrolled off) still reads as ready.
//   (e) grok 0.2.93's measured first screen: no modal, no login, ready on its `❯`
//       through the probe's defaults (the `grok` kind needs no glyph table).
// Fixtures: agy_trust_modal.txt (orchestrator's measured screen, 2026-09-05),
// agy_welcome_idle.txt (pty capture, real HOME, pre-trusted dir), agy_idle_after_turn.txt
// + grok_welcome_idle.txt (`telepty read-screen` of the live #1090 probes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, REPO } from "./model-router-fixtures.js";

const BOOT_PREPARE = join(REPO, "bin/boot-prepare.mjs");
const PROBE = join(REPO, "bin/session-probe.py");
const FIXTURES = join(REPO, "tests/dispatch/fixtures");
const SEED = { model: "Gemini 3.8 Flash (High)", trustedWorkspaces: ["/private/tmp/demoagy"] };

function bootPrepare(f: ReturnType<typeof fixture>, overrides: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [BOOT_PREPARE, "--role", "coder", "--cwd", join(f.root, "project"), "--sid", "t144", "--cli", "gemini"],
    { env: { ...f.env, ...overrides }, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
function agySettings(f: ReturnType<typeof fixture>, seed = true) {
  const dir = join(f.env.HOME!, ".gemini/antigravity-cli");
  if (seed) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "settings.json"), JSON.stringify(SEED, null, 2) + "\n", { mode: 0o600 }); }
  return join(dir, "settings.json");
}
function probe(screen: string, cli?: string) {
  const r = spawnSync("python3", [PROBE, "--sid", "sid-A", "--screen-file", join(FIXTURES, screen), "--info-file", join(FIXTURES, "agy_launcher.info"),
    ...(cli ? ["--cli", cli] : [])], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("T144(a): agy arm appends the canonical sandbox path to trustedWorkspaces once, keeps the rest of settings.json and its 0600 mode", () => {
  const f = fixture();
  try {
    const settings = agySettings(f);
    const r = bootPrepare(f);
    assert.doesNotMatch(r.stderr, /agy/);
    const sandbox = realpathSync(join(f.aig, "role-sandbox/coder-t144"));
    assert.notEqual(sandbox, join(f.aig, "role-sandbox/coder-t144"), "fixture tmpdir must be symlinked for the realpath assertion to bite");
    const cfg = JSON.parse(readFileSync(settings, "utf8"));
    assert.deepEqual(cfg, { ...SEED, trustedWorkspaces: [...SEED.trustedWorkspaces, sandbox] });
    assert.equal(statSync(settings).mode & 0o777, 0o600);
    const bytes = readFileSync(settings, "utf8");
    bootPrepare(f);
    assert.equal(readFileSync(settings, "utf8"), bytes, "second spawn of the same sandbox must not touch the file");
    assert.deepEqual(readFileSync(settings, "utf8").endsWith("]\n}\n"), true, "agy's own 2-space + trailing-newline layout");
  } finally { f.cleanup(); }
});

test("T144(b): no agy settings.json → one WARNING, nothing created", () => {
  const f = fixture();
  try {
    const r = bootPrepare(f);
    assert.match(r.stderr, /WARNING .*antigravity-cli\/settings\.json not found; .* will show agy trust modal/);
    assert.equal(existsSync(join(f.env.HOME!, ".gemini")), false);
  } finally { f.cleanup(); }
});

test("T144(c): the Gemini CLI arm leaves agy's settings.json untouched", () => {
  const f = fixture();
  try {
    const settings = agySettings(f);
    const before = readFileSync(settings, "utf8");
    bootPrepare(f, { AIGENTRY_GEMINI_BINARY: "gemini" });
    assert.equal(readFileSync(settings, "utf8"), before);
  } finally { f.cleanup(); }
});

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

test("T144(e): grok's measured first screen has no modal and is ready on its ❯ through the probe defaults", () => {
  const first = probe("grok_welcome_idle.txt", "grok");
  assert.equal(first.ready, true);
  assert.equal(first.detail.ready_reason, "prompt");
  assert.notEqual(first.surface, "modal");
});
