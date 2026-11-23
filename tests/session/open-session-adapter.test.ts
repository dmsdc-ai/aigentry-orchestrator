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
// R1303-01: a spawn that did not happen must fail at once — non-zero, NO sid on stdout. The tmux/wezterm
// recorders below exit with T1303_TMUX_RC / T1303_WEZTERM_RC, `telepty spawn` with T1303_SPAWN_RC (all
// default 0, so every earlier leg is unchanged). The tmux arms consume platform:: primitives, which only a
// caller that sources bin/lib/platform.sh provides, so they are driven through wh_open with platform.sh
// sourced (T55's idiom) rather than through open-session.
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
const WH_LIB = join(REPO_ROOT, "bin", "lib", "workspace-host.sh");
const PLATFORM_LIB = join(REPO_ROOT, "bin", "lib", "platform.sh");
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
  sh(join(bin, "telepty"), `printf 'telepty %s\\n' "$*" >> "$T1303_LOG"\n[ "$1" = list ] && printf '[]'\n[ "$1" = spawn ] && exit "\${T1303_SPAWN_RC:-0}"\nexit 0\n`);
  // tmux / wezterm recorders: argv recorded, nothing started; status from the env (default 0).
  // Task 1304 D3: a successful `new-window -P -F '#{window_id}'` prints the window id, as tmux does.
  sh(join(bin, "tmux"), `printf 'tmux %s\\n' "$*" >> "$T1303_LOG"\n[ "$1" = new-window ] && [ "\${T1303_TMUX_RC:-0}" = 0 ] && echo "@1303"\nexit "\${T1303_TMUX_RC:-0}"\n`);
  sh(join(bin, "wezterm"), `printf 'wezterm %s\\n' "$*" >> "$T1303_LOG"\nexit "\${T1303_WEZTERM_RC:-0}"\n`);
  // R2-03: an aterm that always FAILS, first on PATH. open-session.sh appends /opt/homebrew/bin and
  // /usr/local/bin, so without it a host's real aterm could open a real terminal; failing, it sends every
  // aterm leg down _wh_fallback_spawn exactly as an absent aterm would, and the call is recorded.
  sh(join(bin, "aterm"), `printf 'aterm %s\\n' "$*" >> "$T1303_LOG"\nexit 1\n`);
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

  // ── R1303-01 / N-01: a failed spawn is non-zero with no sid; the success path still prints it ──
  test("forced wezterm whose `wezterm cli spawn` fails: open-session exits 2 and prints NO sid", () => {
    const W = world(), r = openSession(W, "wezfail", { AIGENTRY_WORKSPACE_HOST: "wezterm", T1303_WEZTERM_RC: "1" });
    assert.match(r.calls, /^wezterm cli spawn --cwd /m, r.calls);
    assert.equal(r.status, 2, r.err);
    assert.equal(r.out, "", "a sid was printed for a spawn that did not happen");
    assert.match(r.err, /ERR wezterm spawn failed \(rc=1\)/);
    oneDiag(r, "open-session.sh: terminal detected=headless forced=wezterm adapter=wezterm", W);
  });

  test("forced wezterm whose spawn succeeds: exit 0 and the sid is the sole stdout line", () => {
    const W = world(), r = openSession(W, "wezok", { AIGENTRY_WORKSPACE_HOST: "wezterm" });
    assert.match(r.calls, /^wezterm cli spawn --cwd /m, r.calls);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "t1303-wezok");
  });

  test("forced headless whose `telepty spawn` fails: exit 2, NO sid, no attach hint", () => {
    const W = world(), r = openSession(W, "hlfail", { AIGENTRY_WORKSPACE_HOST: "headless", T1303_SPAWN_RC: "1" });
    assert.match(r.calls, /^telepty spawn --id t1303-hlfail -- /m, r.calls);
    assert.equal(r.status, 2, r.err);
    assert.equal(r.out, "");
    assert.match(r.err, /ERR telepty spawn failed \(rc=1\)/);
    assert.doesNotMatch(r.err, /telepty attach/, "an attach hint was printed for a session that was never started");
  });

  test("forced aterm whose CLI fails, daemon fallback whose `telepty spawn` fails: exit 2, NO sid", () => {
    const W = world(), r = openSession(W, "atfail", { AIGENTRY_WORKSPACE_HOST: "aterm", T1303_SPAWN_RC: "1" });
    assert.match(r.err, /\[workspace-host\] open: adapter=aterm sid=t1303-atfail/);
    // R2-03: the aterm that was resolved is the failing recorder, never a host binary.
    assert.match(r.calls, /^aterm new-session /m, r.calls);
    assert.match(r.calls, /^telepty spawn --id t1303-atfail -- /m, r.calls);
    assert.equal(r.status, 2, r.err);
    assert.equal(r.out, "");
    assert.doesNotMatch(r.err, /Session spawned as daemon/);
  });

  /** wh_open through the real lib with platform.sh sourced (T55's idiom) — the tmux arms' caller contract. */
  function whOpen(W: World, sid: string, extra: Record<string, string>): { status: number | null; out: string; err: string; calls: string } {
    const cwd = join(W.root, `cwd-${sid}`);
    mkdirSync(cwd, { recursive: true });
    const env: Record<string, string> = { PATH: `${W.bin}:/usr/bin:/bin`, HOME: W.home, LANG: "en_US.UTF-8", T1303_LOG: W.log, ...extra };
    const r = spawnSync("bash", ["-c", '. "$1"; . "$2"; wh_open "$3" "$4" "codex"', "_", PLATFORM_LIB, WH_LIB, sid, cwd],
      { encoding: "utf8", env, timeout: 30000 });
    return { status: r.status, out: (r.stdout ?? "").trim(), err: r.stderr ?? "", calls: readFileSync(W.log, "utf8") };
  }

  test("forced tmux: a failing `tmux new-window` gives rc 2 and NO handle; a working one prints the window id", () => {
    const W = world();
    const bad = whOpen(W, "t1303-tmuxfail", { AIGENTRY_WORKSPACE_HOST: "tmux", T1303_TMUX_RC: "1" });
    assert.match(bad.calls, /^tmux new-window -c .* -n t1303-tmuxfail /m, bad.calls);
    assert.equal(bad.status, 2, bad.err);
    assert.equal(bad.out, "", "a handle was printed for a tmux window that was never opened");
    assert.match(bad.err, /ERR tmux spawn failed \(rc=1\)/);
    const ok = whOpen(W, "t1303-tmuxok", { AIGENTRY_WORKSPACE_HOST: "tmux" });
    assert.equal(ok.status, 0, ok.err);
    // Task 1304 D3: the handle is the window id the lifecycle verbs address, not the sid.
    assert.equal(ok.out, "@1303");
  });

  test("fallback tmux branch (aterm fails, inside tmux): a failing window gives rc 2 and NO sid; a working one prints it", () => {
    const W = world();
    const bad = whOpen(W, "t1303-fbfail", { AIGENTRY_WORKSPACE_HOST: "aterm", TMUX: "/tmp/t1303-fake-tmux", T1303_TMUX_RC: "1" });
    assert.match(bad.calls, /^tmux new-window -c .* -n t1303-fbfail /m, bad.calls);
    assert.doesNotMatch(bad.calls, /^telepty spawn/m, "the tmux branch was not the one exercised");
    assert.equal(bad.status, 2, bad.err);
    assert.equal(bad.out, "");
    const ok = whOpen(W, "t1303-fbok", { AIGENTRY_WORKSPACE_HOST: "aterm", TMUX: "/tmp/t1303-fake-tmux" });
    assert.equal(ok.status, 0, ok.err);
    assert.equal(ok.out, "t1303-fbok");
  });

  // ── R1303-02: a registry probe that could not answer is not called an unregistered value ──
  test("a failed registry probe is labelled registry-probe-failed, not unregistered, and the value is not echoed", () => {
    const W = world();
    // A `bash` first on PATH that fails ONLY the registry probe (its script names _wh_is_registered) and
    // otherwise execs the bash this PATH would have found without it, so detection and `open` still work.
    const realBash = [dirname(process.execPath), "/usr/bin", "/bin"].map((d) => join(d, "bash")).find((p) => existsSync(p));
    assert.ok(realBash, "no bash on the test PATH");
    // R2-03: the real bash path travels in the environment, so no character in it (an apostrophe
    // included) can break the wrapper's own shell text.
    writeFileSync(join(W.bin, "bash"),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in *_wh_is_registered*) exit 1;; esac; done\nexec "$T1303_REAL_BASH" "$@"\n`, { mode: 0o755 });
    const r = openSession(W, "probefail", { AIGENTRY_WORKSPACE_HOST: "wezterm", T1303_REAL_BASH: realBash! });
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "t1303-probefail");
    assert.doesNotMatch(r.calls, /^wezterm /m, "an unverified force was applied");
    oneDiag(r, "open-session.sh: terminal detected=headless forced=registry-probe-failed-ignored adapter=headless", W);
  });

  // ── R2-01: an unreadable registry table is a failed probe, never an authoritative miss ──
  test("the registry predicate answers 0 registered, 1 explicit miss, 2 unreadable table", () => {
    const W = world();
    const ask = (name: string, path: string): number | null =>
      spawnSync("bash", ["-c", '. "$1"; _wh_is_registered "$2"', "_", WH_LIB, name],
        { env: { PATH: path, HOME: W.home }, encoding: "utf8", timeout: 30000 }).status;
    assert.equal(ask("wezterm", `${W.bin}:/usr/bin:/bin`), 0);
    assert.equal(ask("not-a-registered-adapter-1303", `${W.bin}:/usr/bin:/bin`), 1);
    // A `cat` that fails with no output: the table cannot be read, so a REGISTERED name is not a miss.
    const broken = join(W.root, "broken-cat");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "cat"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.equal(ask("wezterm", `${broken}:${W.bin}:/usr/bin:/bin`), 2);
  });

  test("a registered force whose registry table cannot be read is labelled registry-probe-failed, not unregistered", () => {
    const W = world();
    writeFileSync(join(W.bin, "cat"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = openSession(W, "catfail", { AIGENTRY_WORKSPACE_HOST: "wezterm" });
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "t1303-catfail");
    assert.doesNotMatch(r.calls, /^wezterm /m, "an unverified force was applied");
    oneDiag(r, "open-session.sh: terminal detected=headless forced=registry-probe-failed-ignored adapter=headless", W);
  });

  // ── R1303-03: both forced directions across the legacy cmux switch ──
  test("a non-cmux force inside cmux with AIGENTRY_WH_LEGACY_SPAWN=1 goes to wh_open, never the inline cmux arm", () => {
    const W = world();
    const r = openSession(W, "lgfh", { CMUX_WORKSPACE_ID: "t1303", AIGENTRY_WH_LEGACY_SPAWN: "1", AIGENTRY_WORKSPACE_HOST: "headless" });
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "t1303-lgfh");
    assert.match(r.err, /\[workspace-host\] open: adapter=headless sid=t1303-lgfh/);
    assert.match(r.calls, /^telepty spawn --id t1303-lgfh -- /m, r.calls);
    assert.doesNotMatch(r.calls, /^cmux (new|rename)-workspace/m, "the inline legacy cmux arm ran for a non-cmux force");
    oneDiag(r, "open-session.sh: terminal detected=cmux forced=headless adapter=headless", W);
  });

  test("a cmux force with no cmux markers and AIGENTRY_WH_LEGACY_SPAWN=1 takes the inline cmux arm", () => {
    const W = world();
    const r = openSession(W, "lgfc", { AIGENTRY_WH_LEGACY_SPAWN: "1", AIGENTRY_WORKSPACE_HOST: "cmux" });
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, REF);
    assert.doesNotMatch(r.err, /\[workspace-host\] open:/, "the cmux force bypassed the legacy switch");
    assert.match(r.calls, /^cmux rename-workspace --workspace workspace:1303 t1303-lgfc$/m, r.calls);
    oneDiag(r, "open-session.sh: terminal detected=headless forced=cmux adapter=cmux", W);
  });
}
