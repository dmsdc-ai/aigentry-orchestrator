// #1162 agent-metadata regression suites — shared hermetic harness.
//
// Code under test is the REAL tree this file ships in: <repo>/bin and the tsc output
// under <repo>/dist (run `tsc -p .` first; `npm test` does). Nothing here reaches the
// live workspace (see tests/dispatch/lib.sh THE RULE); this harness replaces PATH
// wholesale, so it carries its own tripwire:
//   * HOME / TMPDIR / sessions root / state live in a private scratch dir under
//     $TMPDIR (an explicitly empty TMPDIR is refused, as in lib.sh t_setup);
//   * PATH = <per-test fakes> : <tripwire> : <tools> : /usr/bin:/bin:/usr/sbin:/sbin.
//     The tripwire dir shadows every host actuator name (cmux, telepty, tmux, …) with
//     a recorder that exits 97, so an installed cmux/telepty is never resolved, and
//     every suite asserts the recorder log stays empty;
//   * tools = node (this process) and bash, resolved from the caller's PATH the way
//     the rest of tests/dispatch finds bash; a missing bash is a hard failure;
//   * nothing is inherited: no CMUX_* / TELEPTY* / AIGENTRY_* from the caller.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
export const DIST = path.join(REPO_ROOT, "dist");
export const BIN = path.join(REPO_ROOT, "bin");

if (process.platform !== "darwin" && process.platform !== "linux") {
  throw new Error(`agent-metadata suites: unsupported platform ${process.platform} (POSIX modes/FIFOs/bash required)`);
}
for (const rel of ["src/session/agent-metadata.js", "src/session/agent-binding.js", "src/reconciler/cli.js"]) {
  if (!fs.existsSync(path.join(DIST, rel))) {
    throw new Error(`MISSING BUILD: dist/${rel} not found under ${REPO_ROOT}. Run \`tsc -p .\` first (npm test does).`);
  }
}

function scratchRoot() {
  if (process.env.TMPDIR !== undefined && process.env.TMPDIR === "") {
    throw new Error("agent-metadata suites: TMPDIR must not be empty");
  }
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aigentry-agent-metadata-"));
  fs.chmodSync(dir, 0o700);
  return dir;
}
export const SANDBOX = scratchRoot();
process.on("exit", () => {
  // Stage-permission cases leave mode-000 dirs; make everything removable first.
  const open = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (!st.isDirectory()) return;
    try { fs.chmodSync(p, 0o700); } catch { /* best effort */ }
    for (const e of fs.readdirSync(p)) open(path.join(p, e));
  };
  open(SANDBOX);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function resolveOnCallerPath(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return fs.realpathSync(p);
    } catch { /* keep looking */ }
  }
  throw new Error(`agent-metadata suites: required tool '${name}' not found on PATH`);
}
const TOOLS = [["bash", resolveOnCallerPath("bash")], ["node", process.execPath]];

const TRIPWIRE_NAMES = [
  "cmux", "telepty", "tmux", "wezterm", "osascript", "security", "caffeinate", "pmset", "ioreg",
  "open", "aigentry-orchestrator", "snyk", "npm", "npx", "git", "curl", "wget", "ssh", "launchctl",
  "systemctl", "warp", "claude", "codex", "gemini", "grok", "sudo", "kill", "pkill",
];

let seq = 0;

/** A fresh private run dir with home/tmp, a tripwire dir and a tools dir. */
export function makeRun(label) {
  const dir = path.join(SANDBOX, `${label}-${++seq}-${randomUUID().slice(0, 8)}`);
  for (const d of ["home", "tmp", "fakes", "tripwire", "tools", "logs"]) {
    fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(dir, 0o700);
  const tripLog = path.join(dir, "logs", "tripwire.log");
  fs.writeFileSync(tripLog, "");
  for (const name of TRIPWIRE_NAMES) {
    const p = path.join(dir, "tripwire", name);
    fs.writeFileSync(p, `#!/bin/sh\nprintf '%s\\t%s\\n' "${name}" "$*" >> '${tripLog}'\nexit 97\n`, { mode: 0o755 });
  }
  for (const [name, target] of TOOLS) fs.symlinkSync(target, path.join(dir, "tools", name));
  return {
    dir,
    home: path.join(dir, "home"),
    tmp: path.join(dir, "tmp"),
    fakes: path.join(dir, "fakes"),
    logs: path.join(dir, "logs"),
    tripLog,
    tripwireHits: () => fs.readFileSync(tripLog, "utf8"),
  };
}

/** Hermetic child env. `extra` wins; nothing host-specific is inherited. */
export function hermeticEnv(run, extra = {}) {
  const e = {
    HOME: run.home,
    TMPDIR: run.tmp,
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    PATH: [run.fakes, path.join(run.dir, "tripwire"), path.join(run.dir, "tools"),
      "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    AIGENTRY_BUS_BRIDGE: "0",
    AIGENTRY_SLEEP_GUARD: "0",
  };
  return { ...e, ...extra };
}

/** Write an executable fake into run.fakes (or `dir`). */
export function fake(run, name, body, dir = run.fakes) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60000, ...opts });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const uuid = () => randomUUID();

/** Private (0700) directory, created fresh. */
export function privDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  fs.chmodSync(p, 0o700);
  return p;
}

export function writePriv(p, data, mode = 0o600) {
  fs.writeFileSync(p, data, { mode });
  fs.chmodSync(p, mode);
}

/** mkfifo through the caller-resolved tool path (no hardcoded location). */
export function mkfifo(p) {
  return spawnSync(resolveOnCallerPath("mkfifo"), ["-m", "600", p]).status;
}

/**
 * A sealed-attempt fixture laid out exactly as prepareWorkerSandbox + runner leave
 * it: <stage>/sandbox-current.json → <stage>/sandbox/<attempt>/manifest.json (hash)
 * → receipt.json (running) → terminal-binding.json. Every piece can be overridden
 * to produce a specific defect. Manifest/auth are FAKE values only.
 */
export function sealedFixture(run, o = {}) {
  const sid = o.sid ?? "w1162-a";
  const task = o.task ?? "1162";
  const attempt = o.attempt ?? uuid();
  const stage = privDir(o.stage ?? path.join(run.dir, "sessions", sid));
  const root = privDir(path.join(stage, "sandbox", attempt));
  const manifestObj = {
    version: 1, task, sid, attempt, cli: o.cli ?? "claude", cwd: run.dir,
    command: ["/nonexistent/claude"],
    env: { HOME: path.join(root, "home"), CANARY_ENV: "IT1162-ENV-CANARY-7f3a" },
    config: { filesystem: { allowWrite: [path.join(root, "home")] } },
    probeFile: path.join(root, "outside-canary.txt"),
    receipt: path.join(root, "receipt.json"),
    ...(o.launch === undefined ? {} : o.launch === null ? {} : { launch: o.launch }),
    ...(o.manifestExtra ?? {}),
  };
  const manifestData = o.manifestData ?? JSON.stringify(manifestObj, null, 2) + "\n";
  const manifest = path.join(root, "manifest.json");
  writePriv(manifest, manifestData);
  const hash = o.hash ?? sha256(manifestData);
  const current = path.join(stage, "sandbox-current.json");
  writePriv(current, JSON.stringify(o.current ?? { manifest, hash }));
  const receiptObj = o.receipt ?? { state: "running", hash, attempt, supervisorPid: 1, childPid: 1, checkedAt: "2026-09-28T00:00:00Z" };
  if (receiptObj !== false) writePriv(path.join(root, "receipt.json"), JSON.stringify(receiptObj));
  const ids = {
    workspace_id: o.workspace_id ?? "0f1162aa-0000-4000-8000-000000000001",
    surface_id: o.surface_id ?? "0f1162aa-0000-4000-8000-000000000002",
    terminal_lifecycle_id: o.terminal_lifecycle_id ?? "0f1162aa-0000-4000-8000-000000000003",
  };
  const bindingObj = o.binding ?? { v: 1, sid, task, attempt, manifest_hash: hash, ...ids };
  const bindingFile = path.join(root, "terminal-binding.json");
  if (bindingObj !== false) writePriv(bindingFile, JSON.stringify(bindingObj) + "\n");
  return { sid, task, attempt, stage, root, manifest, hash, current, bindingFile, ids, manifestData };
}
