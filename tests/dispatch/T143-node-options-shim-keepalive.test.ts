// T143 (#1075) — reconciler step 0f keeps cmux's NODE_OPTIONS restore shim alive.
//
// cmux's claude wrapper writes $TMPDIR/cmux-claude-node-options/restore-node-options.cjs
// at claude LAUNCH and exports NODE_OPTIONS='--require=<it> …' into the session. macOS
// purges idle $TMPDIR entries after 3 days (tmp_cleaner: -atime/-mtime/-ctime +3;
// dirhelper: CLEAN_FILES_OLDER_THAN_DAYS=3), so a session older than that keeps a
// --require pointing at nothing and every node child it spawns dies at preload. The
// step reads which paths live processes still --require (ps -E, macOS's /proc-less
// env read, behind platform.sh), touches each one every tick, and puts a missing one
// back with the wrapper's exact bytes. Everything here runs against a temp TMPDIR
// and a stub `ps`; the live shim of the session running this suite is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NODE_OPTIONS_SHIM_SOURCE, keepNodeOptionsShimAlive } from "../../src/reconciler/node-options-shim.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PLATFORM_SH = join(REPO_ROOT, "bin", "lib", "platform.sh");
const RECONCILER_SH = join(REPO_ROOT, "bin", "session-reconciler.sh");
const TELEPTY_STUB = join(REPO_ROOT, "tests", "dispatch", "stubs", "telepty");
const WRAPPER = "/Applications/cmux.app/Contents/Resources/bin/cmux-claude-wrapper";
const SUFFIX = "/cmux-claude-node-options/restore-node-options.cjs";

/** A throwaway TMPDIR (the launching session's, in the wrapper's terms) and the shim path under it. */
function fixture(): { dir: string; shim: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "t143-"));
  return { dir, shim: join(dir, "cmux-claude-node-options", "restore-node-options.cjs"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A `ps` that answers every invocation with the given lines — one fake process per line. */
function stubPs(binDir: string, lines: string[]): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "ps"), `#!/bin/sh\ncat <<'PSEOF'\n${lines.join("\n")}\nPSEOF\n`, { mode: 0o755 });
}

/** One fake `ps -E` row: a claude whose exec-time environment --require's <shim>. */
function claudeRow(shim: string): string {
  return `/Users/x/.local/bin/claude --session-id abc NODE_OPTIONS=--require=${shim} --max-old-space-size=4096 CMUX_ORIGINAL_NODE_OPTIONS_PRESENT=0`;
}

/** platform::node_options_shim_refs through the same bash door the reconciler uses. */
function shimRefs(psLines: string[], os = "macos"): { status: number; stdout: string; stderr: string } {
  const bin = mkdtempSync(join(tmpdir(), "t143-bin-"));
  try {
    stubPs(bin, psLines);
    const r = spawnSync("bash", ["-c", '. "$1"; platform::node_options_shim_refs', "_", PLATFORM_SH], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PLATFORM_OVERRIDE: os },
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

function recorder(): { lines: string[]; log: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, log: (msg) => lines.push(msg) };
}

test("T143(a): a missing shim that a live process still --require's is put back byte-identical, once, with one log line", () => {
  const f = fixture();
  try {
    // Two processes, one path: the primitive reports each distinct path once.
    const refs = shimRefs([claudeRow(f.shim), `node /x/mcp.js NODE_OPTIONS=--require=${f.shim} --max-old-space-size=4096`, "/bin/zsh -c foo PATH=/usr/bin"]);
    assert.equal(refs.status, 0, refs.stderr);
    assert.equal(refs.stdout, `${f.shim}\n`);

    assert.equal(existsSync(f.shim), false);
    const rec = recorder();
    keepNodeOptionsShimAlive(refs.stdout.split("\n").filter(Boolean), rec.log);
    assert.equal(readFileSync(f.shim, "utf8"), NODE_OPTIONS_SHIM_SOURCE);
    assert.equal(statSync(f.shim).mode & 0o777, 0o644);
    assert.equal(rec.lines.length, 1, rec.lines.join("\n"));
    assert.match(rec.lines[0] ?? "", /^NODE_OPTIONS_SHIM recreated /);
    assert.ok(rec.lines[0]?.includes(f.shim), rec.lines[0]);
    // No temp sibling left behind (the wrapper's tmp+mv idiom, completed).
    assert.deepEqual(readdirSync(dirname(f.shim)), ["restore-node-options.cjs"]);
  } finally {
    f.cleanup();
  }
});

test("T143(b): a present shim is only touched — its bytes are never overwritten, its mtime moves", () => {
  const f = fixture();
  try {
    mkdirSync(dirname(f.shim), { recursive: true });
    // Deliberately NOT the canonical bytes: a newer cmux may have written a newer shim.
    const foreign = `${NODE_OPTIONS_SHIM_SOURCE}// written by a newer wrapper\n`;
    writeFileSync(f.shim, foreign);
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(f.shim, old, old);
    assert.equal(statSync(f.shim).mtimeMs, old.getTime());

    const before = Date.now() - 1000;
    const rec = recorder();
    keepNodeOptionsShimAlive([f.shim], rec.log);
    assert.equal(readFileSync(f.shim, "utf8"), foreign);
    assert.ok(statSync(f.shim).mtimeMs >= before, `mtime did not move: ${statSync(f.shim).mtimeMs} < ${before}`);
    assert.deepEqual(rec.lines, []);
  } finally {
    f.cleanup();
  }
});

test("T143(c): no NODE_OPTIONS anywhere → no refs, nothing created, exit 0; linux prints nothing (fail-open)", () => {
  const f = fixture();
  try {
    const none = shimRefs(["/Users/x/.local/bin/claude --session-id abc PATH=/usr/bin TMPDIR=/var/folders/x/T/", "launchd"]);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout, "");
    const linux = shimRefs([claudeRow(f.shim)], "linux");
    assert.equal(linux.status, 0, linux.stderr);
    assert.equal(linux.stdout, "");

    const rec = recorder();
    keepNodeOptionsShimAlive([], rec.log);
    assert.equal(existsSync(dirname(f.shim)), false);
    assert.deepEqual(rec.lines, []);
  } finally {
    f.cleanup();
  }
});

test("T143(d): the canonical bytes equal the installed wrapper's heredoc (ensure_node_options_restore_module)", (t) => {
  if (!existsSync(WRAPPER)) {
    t.skip(`${WRAPPER} not installed — byte-equality against the bundle not measurable here`);
    return;
  }
  const lines = readFileSync(WRAPPER, "utf8").split("\n");
  const fn = lines.findIndex((l) => l.startsWith("ensure_node_options_restore_module()"));
  assert.notEqual(fn, -1, "wrapper no longer defines ensure_node_options_restore_module — re-measure #1075");
  const open = lines.findIndex((l, i) => i > fn && /<<'EOF'$/.test(l));
  const close = lines.findIndex((l, i) => i > open && l === "EOF");
  assert.ok(open > fn && close > open, "heredoc not found inside the function");
  assert.equal(NODE_OPTIONS_SHIM_SOURCE, `${lines.slice(open + 1, close).join("\n")}\n`);
});

test("T143(e): the jail — only the wrapper's basename under an absolute, normalized directory is ever written", () => {
  const f = fixture();
  try {
    const rec = recorder();
    keepNodeOptionsShimAlive(
      [
        join(f.dir, "evil.cjs"),
        join(f.dir, "cmux-claude-node-options", "evil.cjs"),
        `relative/cmux-claude-node-options/restore-node-options.cjs`,
        `${f.dir}/../t143-escape${SUFFIX}`,
        `${f.dir}/.${SUFFIX}`,
      ],
      rec.log,
    );
    assert.deepEqual(readdirSync(f.dir), []);
    assert.equal(existsSync(join(dirname(f.dir), "t143-escape")), false);
    assert.equal(existsSync(resolve("relative")), false);
    assert.deepEqual(rec.lines, []);
  } finally {
    f.cleanup();
  }
});

test("T143(f): a second tick changes nothing — same bytes, no second log line", () => {
  const f = fixture();
  try {
    const rec = recorder();
    keepNodeOptionsShimAlive([f.shim, f.shim], rec.log);
    keepNodeOptionsShimAlive([f.shim], rec.log);
    assert.equal(readFileSync(f.shim, "utf8"), NODE_OPTIONS_SHIM_SOURCE);
    assert.equal(rec.lines.length, 1, rec.lines.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("T143(g): a hermetic reconciler tick runs the step — even under --dry-run — and logs the recreate", () => {
  const f = fixture();
  const bin = join(f.dir, "stubbin");
  const state = join(f.dir, "state");
  try {
    stubPs(bin, [claudeRow(f.shim)]);
    copyFileSync(TELEPTY_STUB, join(bin, "telepty"));
    writeFileSync(join(bin, "noop"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "active.json"), '{"schema_version": 2, "generation": 0, "dispatches": []}\n');
    writeFileSync(join(f.dir, "list.json"), "[]");
    const noop = join(bin, "noop");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PLATFORM_OVERRIDE: "macos",
      AIGENTRY_WORKSPACE_HOST: "headless",
      AIGENTRY_ROLE_SANDBOX_DIR: join(f.dir, "role-sandbox"),
      AIGENTRY_BUS_BRIDGE: "0",
      AIGENTRY_SLEEP_GUARD: "0",
      DISPATCH_STATE_DIR: state,
      HITL_STATE_DIR: join(f.dir, "hitl"),
      TELEPTY: join(bin, "telepty"),
      STUB_LIST_FILE: join(f.dir, "list.json"),
      CLEANUP_SH: noop,
      SCHEDULER_SH: noop,
      TRACKER_SH: noop,
      COMMS_AUDITOR_SH: noop,
      BRIDGE_AUDITOR_SH: noop,
      BUS_BRIDGE_SH: noop,
      HITL_SH: noop,
    };
    delete env.AIGENTRY_WORKER_SESSION;
    // --dry-run: every session action above and below the step is skipped; the step is not.
    const r = spawnSync("bash", [RECONCILER_SH, "--once", "--dry-run"], { encoding: "utf8", env });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(readFileSync(f.shim, "utf8"), NODE_OPTIONS_SHIM_SOURCE);
    const log = readFileSync(join(state, "reconciler.log"), "utf8");
    assert.equal(log.split("\n").filter((l) => l.includes("NODE_OPTIONS_SHIM recreated")).length, 1, log);
    assert.ok(log.includes(f.shim), log);
    assert.match(log, /dry_run=1/);
  } finally {
    f.cleanup();
  }
});
