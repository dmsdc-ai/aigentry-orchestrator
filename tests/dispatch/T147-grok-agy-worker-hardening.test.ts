// T147 (#1091) — grok/agy worker hardening, measured live on 2026-09-06.
//
//   (a) An IDLE grok reads as idle+ready, not as a sandbox approval prompt and not as
//       working. Two independent bugs put it there: telepty renders grok's TUI as ONE
//       line, so `sandbox.*approv` spanned the role-sandbox cwd header and the
//       "always-approve" footer; and grok's welcome box draws the xAI mark in BRAILLE
//       ART, which the spinner membership test read as a spinner. The fixture keeps
//       both triggers on screen, so it still bites if either fix is reverted.
//   (b) The REAL codex 0.153.4 approval modal — captured live, not transcribed — is
//       classified sandbox_prompt. This is the half of the change that could only be
//       written after measuring: the arm that named "sandbox…approv" never matched
//       codex at all (the assertion below proves the fixture contains no such text),
//       so the regex was simultaneously firing on the wrong CLI and missing the right one.
//   (c) Real spinner frames still read as working — including grok's own boot screen,
//       which shows "⠋ MCP (0/4)" and now classifies exactly as codex's MCP-boot screen
//       already does in tests/fixtures/session-state/cases.json (working / moving / ready).
//   (d) The probe resolves the CLI kind from the guard launcher's `exec -a` line, the way
//       dispatch does, so dispatch-verify.sh and the reconciler — which never pass --cli —
//       stop reading every worker as claude once its welcome header scrolls off.
//   (e/f) session-cleanup prunes the agy trust entry boot-prepare added for the reaped
//       sid, and only that one.
//
// Fixtures: grok_idle_settled.txt (a settled grok rendered through telepty's own
// stripAnsiForScreen), codex_sandbox_prompt.txt (live codex 0.153.4 with
// approval_policy=on-request + sandbox_mode=read-only), grok_welcome_idle.txt (#1090).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "./model-router-fixtures.js";

const PROBE = join(REPO, "bin/session-probe.py");
const CLEANUP_JS = join(REPO, "dist/src/cleanup/cli.js");
const FIXTURES = join(REPO, "tests/dispatch/fixtures");
const STATE_FIXTURES = join(REPO, "tests/fixtures/session-state");

type ProbeState = {
  ready: boolean; surface: string; cli: string;
  detail: { tracker_class: string; ready_reason: string; verify_started: boolean };
};

function probe(screen: string, opts: { cli?: string; info?: string } = {}): ProbeState {
  const r = spawnSync("python3", [PROBE, "--sid", "sid-A", "--screen-file", screen,
    "--info-file", opts.info ?? join(FIXTURES, "agy_launcher.info"),
    ...(opts.cli ? ["--cli", opts.cli] : [])], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as ProbeState;
}

test("T147(a): an idle grok is idle+ready — the role-sandbox cwd and the always-approve footer no longer read as an approval prompt, and the braille logo no longer reads as a spinner", () => {
  const screen = join(FIXTURES, "grok_idle_settled.txt");
  const text = readFileSync(screen, "utf8");
  // The fixture must keep every trigger on screen, or it stops measuring the bug.
  assert.match(text, /role-sandbox/, "fixture lost the sandbox cwd header");
  assert.match(text, /always-approve/, "fixture lost the always-approve footer");
  assert.match(text, /[⠀-⣿]{4,}/, "fixture lost grok's braille logo art");
  assert.match(text, /❯/, "fixture lost grok's ❯ prompt");
  // …and it must still be the shape that fooled the old regex: one line, no newline-anchored rescue.
  assert.equal(text.trimEnd().includes("\n"), false, "telepty renders grok's TUI as ONE line — that is the point");

  // With the --cli hint dispatch passes, and without it (dispatch-verify.sh / reconciler).
  for (const cli of ["grok", ""] as const) {
    const got = probe(screen, cli ? { cli } : {});
    assert.equal(got.surface, "idle", `--cli ${cli}: surface`);
    assert.equal(got.ready, true, `--cli ${cli}: ready`);
    assert.equal(got.detail.ready_reason, "prompt");
    assert.equal(got.detail.tracker_class, "prompt_observed", `--cli ${cli}: tracker_class`);
  }
});

test("T147(b): the real codex 0.153.4 approval modal is sandbox_prompt — and contains no 'sandbox…approv' text, so the arm it replaced could never have matched it", () => {
  const screen = join(FIXTURES, "codex_sandbox_prompt.txt");
  const text = readFileSync(screen, "utf8");
  assert.match(text, /Would you like to run the following command\?/);
  assert.match(text, /Yes, and don't ask again for commands that start with/);
  assert.equal(/sandbox[\s\S]*approv/i.test(text), false,
    "if a capture ever does contain sandbox…approv, this test stops proving the old arm was dead");
  const got = probe(screen, { cli: "codex" });
  assert.equal(got.surface, "sandbox_prompt");
  assert.equal(got.ready, false); // a blocking modal is not a REPL ready for an inject
});

test("T147(c): real spinner frames still read as working, including grok's boot screen", () => {
  for (const [screen, cli] of [
    [join(FIXTURES, "active.txt"), "claude"],
    [join(FIXTURES, "postinject_ok.txt"), "claude"],
    [join(STATE_FIXTURES, "codex-init-spinner.screen"), "codex"],
  ] as const) {
    assert.equal(probe(screen, { cli }).surface, "working", `${screen} must still be working`);
  }
  // grok's FIRST screen (#1090's capture) genuinely shows "⠋ MCP (0/4)" while its MCP
  // servers boot. It is no longer mistaken for an approval prompt; it reads as working,
  // which is what codex's own MCP-boot screen has always been pinned to.
  const boot = probe(join(FIXTURES, "grok_welcome_idle.txt"), { cli: "grok" });
  assert.notEqual(boot.surface, "sandbox_prompt");
  assert.equal(boot.surface, "working");
  assert.equal(boot.ready, true);
});

test("T147(d): the probe reads the CLI kind off the guard launcher's `exec -a` line, and a sid that contains a CLI name does not fool it", () => {
  const root = mkdtempSync(join(tmpdir(), "t147-launcher-"));
  try {
    const launcher = (name: string, kind: string) => {
      const dir = join(root, name, "guard");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "worker-launcher.sh");
      writeFileSync(file, "#!/usr/bin/env bash\nset -euo pipefail\nexport AIGENTRY_WORKER_SESSION=1\n" +
        `exec -a ${kind} /Users/x/.aigentry/sessions/${name}/boot/launcher.sh "$@"\n`, { mode: 0o755 });
      const info = join(root, `${name}.info`);
      writeFileSync(info, JSON.stringify({ id: name, command: file, healthStatus: "CONNECTED",
        ready: true, transport: { ready: true, bootstrap: { ready: true } } }));
      return info;
    };
    const screen = join(FIXTURES, "grok_idle_settled.txt");
    // agy is the `gemini` kind, exactly as src/dispatch/cli.ts cliKindOf maps it.
    assert.equal(probe(screen, { info: launcher("mr1091-agy-proof", "agy") }).cli, "gemini");
    assert.equal(probe(screen, { info: launcher("mr1091-grok-proof", "grok") }).cli, "grok");
    assert.equal(probe(screen, { info: launcher("mr1091-codex-x", "codex") }).cli, "codex");
    // The sid is inside the launcher PATH, and sids carry CLI names (this task's own
    // session is "mr1091-mr1091-grok-agy"). The launcher's own line is what decides.
    assert.equal(probe(screen, { info: launcher("mr1091-mr1091-grok-agy", "claude") }).cli, "claude");
    // A launcher path that does not exist falls back to the pre-existing screen guess
    // rather than erroring — T144(d) depends on that fallback.
    assert.equal(probe(join(FIXTURES, "agy_welcome_idle.txt")).cli, "gemini");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── (e/f) the trust-store prune, exercised through the real cleanupOne path ──
// Hermetic: stub telepty/jq/curl on PATH, AIGENTRY_SHIM_SCRIPT_DIR pointed at a stub
// bin/ (so wh-cli.sh and dispatch-registry.py resolve to nothing), a throwaway HOME and
// a sid no session ever had. Nothing real is listed, signalled, closed or DELETEd.
// AIGENTRY_WORKER_SESSION is dropped from the CHILD env only: the #524 worker guard
// refuses before any teardown, and this test is about the code after it.
function cleanupFixture() {
  const root = mkdtempSync(join(tmpdir(), "t147-cleanup-"));
  const bin = join(root, "bin"), home = join(root, "home");
  mkdirSync(join(bin, "lib"), { recursive: true });
  mkdirSync(join(home, ".gemini/antigravity-cli"), { recursive: true });
  const stub = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  stub("telepty", 'if [ "$1" = "list" ]; then echo "[]"; else exit 0; fi');
  // #835: an empty `telepty list` is only an ABSENCE if the daemon corroborates it, so the
  // real bin/lib readers run here (copied, not re-implemented — T87 keeps them the only
  // credential path) against the $CURL seam: 200 on the probe, 404 on the registry DELETE.
  stub("curl", 'case "$*" in *DELETE*) echo 404;; *) echo 200;; esac');
  for (const lib of ["telepty-listing.sh", "telepty-auth.sh"]) {
    copyFileSync(join(REPO, "bin/lib", lib), join(bin, "lib", lib));
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    AIGENTRY_SHIM_SCRIPT_DIR: bin, ORCHESTRATOR_SID: "orchestrator-fixture", CURL: join(bin, "curl") };
  delete env.AIGENTRY_WORKER_SESSION;
  const settings = join(home, ".gemini/antigravity-cli/settings.json");
  return {
    root, env, settings,
    seed(entries: string[]) {
      writeFileSync(settings, JSON.stringify({ model: "Gemini 3.8 Flash (High)", trustedWorkspaces: entries }, null, 2) + "\n", { mode: 0o600 });
    },
    run(sid: string) {
      const r = spawnSync(process.execPath, [CLEANUP_JS, sid], { env, encoding: "utf8", timeout: 20000 });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      return r;
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("T147(e): cleaning a session drops its own agy trust entry and nothing else", () => {
  const f = cleanupFixture();
  try {
    const mine = "/Users/x/.aigentry/role-sandbox/logger-mr1091-agy-proof";
    const others = [
      "/private/tmp/demoagy",                                          // a human's own trusted dir
      "/Users/x/.aigentry/role-sandbox/logger-mr1093-agy-idle",        // another LIVE worker's sandbox
      "/Users/x/projects/mr1091-agy-proof",                            // same leaf, not a role-sandbox path
    ];
    f.seed([others[0]!, mine, others[1]!, others[2]!]);
    const r = f.run("mr1091-agy-proof");
    assert.match(r.stdout, /agy trust: pruned 1 trustedWorkspaces entry/);
    const cfg = JSON.parse(readFileSync(f.settings, "utf8"));
    assert.deepEqual(cfg.trustedWorkspaces, others, "only this sid's role-sandbox entry may go");
    assert.equal(cfg.model, "Gemini 3.8 Flash (High)", "every other key survives");
    assert.equal(statSync(f.settings).mode & 0o777, 0o600, "agy keeps the file 0600");
    assert.equal(readFileSync(f.settings, "utf8").endsWith("]\n}\n"), true, "agy's 2-space + trailing-newline layout");
  } finally { f.cleanup(); }
});

test("T147(f): no settings.json, or no matching entry, means no write and nothing created", () => {
  const f = cleanupFixture();
  try {
    // (i) agy not installed for this user: cleanup succeeds and invents no tree.
    const r = f.run("mr1091-agy-proof");
    assert.doesNotMatch(r.stdout, /agy trust/);
    assert.equal(existsSync(f.settings), false);
    // (ii) a file with nothing of this sid's is left byte-identical.
    f.seed(["/private/tmp/demoagy", "/Users/x/.aigentry/role-sandbox/logger-mr1093-agy-idle"]);
    const before = readFileSync(f.settings, "utf8");
    f.run("mr1091-agy-proof");
    assert.equal(readFileSync(f.settings, "utf8"), before);
  } finally { f.cleanup(); }
});
