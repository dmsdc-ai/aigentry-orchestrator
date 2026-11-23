// #1303 D1/D3 — which adapter open-session hands to `wh-cli.sh open`, and the one stderr line
// that says why.
//
// Drives the REAL bin/open-session.sh → dist/src/session/open-session/cli.js → bin/wh-cli.sh →
// bin/lib/workspace-host.sh chain (T116/T117's idiom), with an explicit environment built here (never
// process.env, so an operator's own AIGENTRY_WORKSPACE_HOST, TMUX or TERM_PROGRAM cannot leak in) and
// recorders first on PATH for every binary the spawn path can reach: telepty (daemon-PTY spawn and
// `list --json`), open/xdg-open (the Warp deeplink opener; it FAILS, so no real Warp is ever asked to
// open anything) and a fake cmux through the CMUX seam. Nothing reaches a live daemon or terminal.
//
// win32: open-session is a bash entrypoint and the confined spawn path is POSIX-only, so these legs are
// registered off win32 only (T143's split), never skipped by condition inside a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const OPEN_SESSION = join(REPO_ROOT, "bin", "open-session.sh");
const WIN = process.platform === "win32";
const REF = "workspace:1303";
const DIAG = /^open-session\.sh: terminal /;

const roots: string[] = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface World { root: string; bin: string; home: string; log: string; cmux: string }
function world(): World {
  const root = mkdtempSync(join(tmpdir(), "open-session-1303-"));
  roots.push(root);
  const bin = join(root, "bin"), home = join(root, "home"), log = join(root, "calls.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(log, "");
  const sh = (p: string, body: string): void => writeFileSync(p, `#!/bin/sh\n${body}`, { mode: 0o755 });
  sh(join(bin, "telepty"), `printf 'telepty %s\\n' "$*" >> "$T1303_LOG"\n[ "$1" = list ] && printf '[]'\nexit 0\n`);
  // The Warp deeplink handoff: recorded, then refused, so _wh_warp_open stops at its exit 2.
  sh(join(bin, "open"), `printf 'opener %s\\n' "$*" >> "$T1303_LOG"\nexit 1\n`);
  sh(join(bin, "xdg-open"), `printf 'opener %s\\n' "$*" >> "$T1303_LOG"\nexit 1\n`);
  const cmux = join(root, "cmux-stub");
  sh(cmux, `printf 'cmux %s\\n' "$*" >> "$T1303_LOG"
case "$1" in
  new-workspace)   echo "OK ${REF}" ;;
  list-workspaces) echo "  ${REF}  faketitle" ;;
  surface-health)  echo "surface:9  type=terminal in_window=false" ;;
  read-screen)     echo "  claude prompt rendered" ;;
esac
exit 0
`);
  return { root, bin, home, log, cmux };
}

interface Run { status: number | null; out: string; err: string; calls: string; diag: string[] }
function openSession(W: World, name: string, extra: Record<string, string>): Run {
  const env: Record<string, string> = {
    PATH: `${W.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: W.home, LANG: "en_US.UTF-8", TELEPTY: join(W.bin, "telepty"), T1303_LOG: W.log,
    CTX_ROUTER_PATH: "/nonexistent", AIGENTRY_CONFIG: join(W.root, "no-such-config.json"),
    AIGENTRY_SLEEP_GUARD: "0", CMUX: W.cmux, CMUX_READY_TIMEOUT_MS: "2000", CMUX_READY_INTERVAL_MS: "10",
    AIGENTRY_WARP_TAB_CONFIG_DIR: join(W.root, "warp-tab-configs"),
    AIGENTRY_WARP_SURFACE_DIR: join(W.root, "warp-surfaces"),
    WARP_READY_TIMEOUT_MS: "50", WARP_READY_INTERVAL_MS: "10",
    ...extra,
  };
  const r = spawnSync("bash", [OPEN_SESSION, "--track", "t1303", "--name", name, "--cwd", join(W.root, `cwd-${name}`),
    "--cli", "codex"], { encoding: "utf8", env, timeout: 60000 });
  const err = r.stderr ?? "";
  return { status: r.status, out: (r.stdout ?? "").trim(), err, calls: readFileSync(W.log, "utf8"),
    diag: err.split("\n").filter((l) => DIAG.test(l)) };
}

/** D3: exactly one diagnostic line per open, registry names and fixed words only. */
function oneDiag(r: Run, want: string, W: World): void {
  assert.deepEqual(r.diag, [want], r.err);
  assert.ok(!r.diag[0]!.includes(W.home) && !r.diag[0]!.includes(W.root), `diagnostic carries a path: ${r.diag[0]}`);
}

if (!WIN) {
  test("forced warp with no terminal markers reaches `open` as warp (D1), and the diagnostic says so (D3)", () => {
    assert.ok(existsSync(OPEN_SESSION), OPEN_SESSION);
    const W = world(), r = openSession(W, "warp", { AIGENTRY_WORKSPACE_HOST: "warp" });
    // The warp adapter ran: its own deeplink opener was called for this sid, and its exit 2
    // (deeplink failed, no surface) arrives verbatim. The base routed this to headless (rc 0).
    assert.match(r.err, /\[workspace-host\] open: adapter=warp sid=t1303-warp/);
    assert.match(r.calls, /^opener warp:\/\/tab_config\/telepty-t1303-warp$/m, r.calls);
    assert.doesNotMatch(r.calls, /^telepty spawn/m, "a forced warp spawn fell through to the daemon PTY");
    assert.equal(r.status, 2, r.err);
    assert.equal(r.out, "");
    oneDiag(r, "open-session.sh: terminal detected=headless forced=warp adapter=warp", W);
  });

  test("unforced inside cmux: unchanged cmux open and ref; the diagnostic names no force", () => {
    const W = world(), r = openSession(W, "cmux", { CMUX_WORKSPACE_ID: "t1303" });
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, REF);
    assert.match(r.err, /\[workspace-host\] open: adapter=cmux sid=t1303-cmux/);
    assert.match(r.calls, /^cmux new-workspace --cwd /m, r.calls);
    oneDiag(r, "open-session.sh: terminal detected=cmux forced=none adapter=cmux", W);
  });

  test("unforced inside cmux with AIGENTRY_WH_LEGACY_SPAWN=1: still the inline arm, never wh_open", () => {
    const W = world(), r = openSession(W, "legacy", { CMUX_WORKSPACE_ID: "t1303", AIGENTRY_WH_LEGACY_SPAWN: "1" });
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, REF);
    assert.doesNotMatch(r.err, /\[workspace-host\] open:/);
    assert.match(r.calls, /^cmux rename-workspace --workspace workspace:1303 t1303-legacy$/m, r.calls);
    oneDiag(r, "open-session.sh: terminal detected=cmux forced=none adapter=cmux", W);
  });

  test("unforced with no terminal markers: unchanged headless daemon-PTY fallback", () => {
    const W = world(), r = openSession(W, "hl", {});
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "t1303-hl");
    assert.match(r.err, /\[workspace-host\] open: adapter=headless sid=t1303-hl/);
    assert.match(r.calls, /^telepty spawn --id t1303-hl -- /m, r.calls);
    oneDiag(r, "open-session.sh: terminal detected=headless forced=none adapter=headless", W);
  });

  test("an unregistered forced value is ignored as _wh_adapter ignores it, and never echoed", () => {
    const W = world(), bogus = "not-a-registered-adapter-1303";
    const r = openSession(W, "bogus", { AIGENTRY_WORKSPACE_HOST: bogus });
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "t1303-bogus");
    assert.match(r.err, /\[workspace-host\] open: adapter=headless sid=t1303-bogus/);
    assert.ok(!r.err.includes(bogus), `the raw forced value reached stderr:\n${r.err}`);
    oneDiag(r, "open-session.sh: terminal detected=headless forced=unregistered-ignored adapter=headless", W);
  });
}
