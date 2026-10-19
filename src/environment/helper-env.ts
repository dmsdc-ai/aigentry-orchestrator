import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

export type HelperOperation = "verify" | "model" | "boot" | "registry" | "telemetry" | "control" | "terminal" | "binder";
export interface TrustedRuntimeContext { readonly base: Readonly<NodeJS.ProcessEnv>; readonly temporary: string }
type ToolIdentity = { path: string; realpath: string; dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; mode: bigint; uid: bigint };
function identity(file: string, realpath: string, st: fs.BigIntStats): ToolIdentity {
  return { path: file, realpath, dev: st.dev, ino: st.ino, size: st.size,
    mtimeNs: st.mtimeNs, mode: st.mode, uid: st.uid };
}
function sameIdentity(a: ToolIdentity, b: ToolIdentity): boolean {
  return Object.keys(a).every(key => a[key as keyof ToolIdentity] === b[key as keyof ToolIdentity]);
}
function owned(st: fs.BigIntStats): boolean { return st.uid === 0n || st.uid === BigInt(process.getuid?.() ?? -1); }
const toolPins = new WeakMap<TrustedRuntimeContext, Map<string, ToolIdentity>>();
const filePins = new WeakMap<TrustedRuntimeContext, Map<string, ToolIdentity>>();
const SAFE_SETTINGS = ["ORCHESTRATOR_CLI", "AIGENTRY_BOOT_CLI", "AIGENTRY_DISPATCH_CLI", "AIGENTRY_CONTROL_WORKSPACE",
  "ORCHESTRATOR_SID", "AIGENTRY_BOOT_MODEL", "AIGENTRY_BOOT_EFFORT", "AIGENTRY_CLAUDE_MODEL", "AIGENTRY_CLAUDE_EFFORT",
  "AIGENTRY_CODEX_MODEL", "AIGENTRY_CODEX_EFFORT", "AIGENTRY_GEMINI_MODEL", "AIGENTRY_GEMINI_EFFORT", "AIGENTRY_GROK_MODEL",
  "AIGENTRY_GROK_EFFORT", "AIGENTRY_CLAUDE_EXECUTABLE", "AIGENTRY_CLAUDE_EXECUTABLE_VERSION", "AIGENTRY_CODEX_EXECUTABLE",
  "AIGENTRY_CODEX_EXECUTABLE_VERSION", "AIGENTRY_GEMINI_BINARY", "AIGENTRY_ROUTER_PROFILE", "AIGENTRY_MODEL_METADATA",
  "AIGENTRY_CATALOG_REVALIDATE_MS", "AIGENTRY_CATALOG_MAX_BYTES", "AIGENTRY_CATALOG_MAX_REDIRECTS"];
const CONTROL = ["AIGENTRY_HOME", "AIGENTRY_TARGET_CWD", "AIGENTRY_TASK_ID", "TELEPTY", "TELEPTY_PORT", "DISPATCH_STATE_DIR", "DISPATCH_REGISTRY_PY"];
const TERMINAL = ["AIGENTRY_SHIM_SCRIPT_DIR", "AIGENTRY_SHIM_SCRIPT_PATH", "AIGENTRY_WORKSPACE_HOST", "AIGENTRY_WH_LEGACY_SPAWN",
  "AIGENTRY_MANAGED_BIN_DIR",
  "CMUX", "CMUX_WORKSPACE_ID", "ATERM_IPC_SOCKET", "TMUX", "TERM_PROGRAM", "XDG_DATA_HOME", "AIGENTRY_WARP_SURFACE_DIR",
  "AIGENTRY_WARP_TAB_CONFIG_DIR", "CMUX_READY_TIMEOUT_MS", "CMUX_READY_INTERVAL_MS", "WARP_READY_TIMEOUT_MS",
  "WARP_READY_INTERVAL_MS"];
const ALLOWED: Record<HelperOperation, readonly string[]> = {
  verify: [], model: [...CONTROL, ...SAFE_SETTINGS], boot: [...CONTROL, ...SAFE_SETTINGS, "AIGENTRY_SPAWN_DECISION"],
  registry: ["DISPATCH_STATE_DIR", "PYTHONIOENCODING"], telemetry: [...CONTROL], control: [...CONTROL],
  terminal: [...CONTROL, ...TERMINAL], binder: ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_TERMINAL_LIFECYCLE_ID"],
};
const SAFE_VALUE = /^[^\u0000-\u001f\u007f]*$/;
export function captureManagedRuntime(source: NodeJS.ProcessEnv, scratchRoot: string): TrustedRuntimeContext {
  const dirs = (source.PATH ?? "").split(path.delimiter);
  if (!dirs.length || dirs.some(d => !d || !path.isAbsolute(d))) throw new Error("ENV_HELPER_PATH_REFUSED");
  const pinned = dirs.flatMap(d => {
    let real: string, st: fs.BigIntStats;
    try { real = fs.realpathSync.native(d); st = fs.statSync(real, { bigint: true }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("ENV_HELPER_PATH_REFUSED");
    }
    if (!st.isDirectory() || (st.mode & 0o022n) !== 0n || !owned(st)) throw new Error("ENV_HELPER_PATH_REFUSED");
    return [real];
  });
  if (!pinned.length) throw new Error("ENV_HELPER_PATH_REFUSED");
  if (!path.isAbsolute(scratchRoot) || path.normalize(scratchRoot) !== scratchRoot) throw new Error("ENV_HELPER_SCRATCH_REFUSED");
  let real: string, parent: fs.BigIntStats;
  try {
    real = fs.realpathSync.native(scratchRoot);
    parent = fs.lstatSync(scratchRoot, { bigint: true });
  } catch { throw new Error("ENV_HELPER_SCRATCH_REFUSED"); }
  if (real !== scratchRoot || !parent.isDirectory() || parent.isSymbolicLink() ||
      parent.uid !== BigInt(process.getuid?.() ?? -1) || (parent.mode & 0o077n) !== 0n) throw new Error("ENV_HELPER_SCRATCH_REFUSED");
  const temporary = fs.mkdtempSync(path.join(real, "aigentry-control-"));
  const created = fs.lstatSync(temporary, { bigint: true }), after = fs.lstatSync(scratchRoot, { bigint: true });
  if (after.dev !== parent.dev || after.ino !== parent.ino || !created.isDirectory() || created.isSymbolicLink() ||
      created.uid !== BigInt(process.getuid?.() ?? -1) || (created.mode & 0o077n) !== 0n) throw new Error("ENV_HELPER_SCRATCH_REFUSED");
  const locale = (v: string | undefined, fallback: string): string => v && /^[A-Za-z0-9_.@-]{1,64}$/.test(v) ? v : fallback;
  const base = Object.freeze({ HOME: os.userInfo().homedir, PATH: pinned.join(path.delimiter),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary, LANG: locale(source.LANG, "C"),
    LC_ALL: locale(source.LC_ALL, "C"), TERM: locale(source.TERM, "dumb") });
  const context = { base, temporary };
  toolPins.set(context, new Map());
  filePins.set(context, new Map());
  return context;
}
export function helperEnvironment(ctx: TrustedRuntimeContext, op: HelperOperation,
  source: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  if (Object.keys(extra).some(key => !ALLOWED[op].includes(key))) throw new Error("ENV_HELPER_INPUT_REFUSED");
  const result: NodeJS.ProcessEnv = { ...ctx.base };
  for (const key of ALLOWED[op]) {
    if (key === "AIGENTRY_MANAGED_BIN_DIR" && extra[key] === undefined) continue;
    const value = extra[key] ?? source[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 16 * 1024 || !SAFE_VALUE.test(value)) throw new Error("ENV_HELPER_INPUT_REFUSED");
    result[key] = value;
  }
  if (op === "registry") result.PYTHONIOENCODING = "utf-8";
  if (result.TELEPTY_PORT !== undefined) {
    if (!/^[1-9][0-9]{0,4}$/.test(result.TELEPTY_PORT) || Number(result.TELEPTY_PORT) > 65535) {
      throw new Error("TELEPTY_PORT_INVALID");
    }
  }
  return result;
}

/** The bootstrap installer needs only its prefix, trusted home, tools and locale. */
export function instructionsInstallerEnvironment(ctx: TrustedRuntimeContext, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = source.AIGENTRY_HOME;
  if (home !== undefined && (typeof home !== "string" || !path.isAbsolute(home) ||
      home.length > 16 * 1024 || !SAFE_VALUE.test(home))) throw new Error("ENV_HELPER_INPUT_REFUSED");
  return { HOME: ctx.base.HOME, PATH: ctx.base.PATH, LANG: ctx.base.LANG, LC_ALL: ctx.base.LC_ALL,
    ...(home === undefined ? {} : { AIGENTRY_HOME: home }) };
}

export function trustedTool(ctx: TrustedRuntimeContext, name: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error("ENV_HELPER_PATH_REFUSED");
  for (const dir of (ctx.base.PATH ?? "").split(path.delimiter)) {
    const file = path.join(dir, name);
    try {
      const real = fs.realpathSync.native(file), st = fs.statSync(real, { bigint: true });
      if (st.isFile() && (st.mode & 0o111n) !== 0n && (st.mode & 0o022n) === 0n && owned(st)) {
        const current = identity(file, real, st);
        const pins = toolPins.get(ctx);
        if (!pins) throw new Error("ENV_HELPER_PATH_REFUSED");
        const earlier = pins.get(name);
        if (earlier && !sameIdentity(current, earlier)) {
          throw new Error("ENV_HELPER_PATH_REFUSED");
        }
        pins.set(name, current);
        return real;
      }
    } catch { /* next pinned directory */ }
  }
  throw new Error("ENV_HELPER_PATH_REFUSED");
}

export function assertTrustedTool(ctx: TrustedRuntimeContext, name: string, file: string): void {
  const pin = toolPins.get(ctx)?.get(name);
  if (!pin || pin.realpath !== file || trustedTool(ctx, name) !== file) throw new Error("ENV_HELPER_PATH_REFUSED");
}

function fileIdentity(file: string, executable: boolean): ToolIdentity {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) throw new Error("ENV_HELPER_PATH_REFUSED");
  try {
    const realpath = fs.realpathSync.native(file), st = fs.statSync(realpath, { bigint: true });
    if (!st.isFile() || (st.mode & 0o022n) !== 0n || (executable && (st.mode & 0o111n) === 0n) ||
        !owned(st)) throw new Error("ENV_HELPER_PATH_REFUSED");
    return identity(file, realpath, st);
  } catch { throw new Error("ENV_HELPER_PATH_REFUSED"); }
}
/** Pin an operation's actual executable or script, including a resolved symlink target. */
export function pinTrustedFile(ctx: TrustedRuntimeContext, operation: HelperOperation, file: string,
  executable = true): void {
  const pins = filePins.get(ctx);
  if (!pins) throw new Error("ENV_HELPER_PATH_REFUSED");
  const key = `${operation}:${file}`;
  const identity = fileIdentity(file, executable), earlier = pins.get(key);
  if (earlier && !sameIdentity(identity, earlier)) {
    throw new Error("ENV_HELPER_PATH_REFUSED");
  }
  pins.set(key, identity);
}
export function assertTrustedFile(ctx: TrustedRuntimeContext, operation: HelperOperation, file: string,
  executable = true): void {
  const prior = filePins.get(ctx)?.get(`${operation}:${file}`);
  if (!prior) throw new Error("ENV_HELPER_PATH_REFUSED");
  const current = fileIdentity(file, executable);
  if (!sameIdentity(current, prior)) {
    throw new Error("ENV_HELPER_PATH_REFUSED");
  }
}

// The terminal shell has a fixed set of external commands. Its private PATH contains
// only these bound doors; a command absent at capture cannot appear later via PATH.
const TERMINAL_TOOLS = ["aterm", "awk", "bash", "caffeinate", "cat", "cmux", "date", "dirname", "grep",
  "head", "jq", "mkdir", "node", "nohup", "open", "osascript", "pgrep", "ps", "rm", "sed", "sh",
  "sleep", "sort", "systemd-inhibit", "tmux", "touch", "tr", "uname", "wezterm", "xdg-open",
  "telepty"] as const;
export interface ManagedTerminalTools {
  readonly directory: string;
  readonly launcher: string;
  readonly platform: string;
  readonly workspaceHost: string;
  assert(): void;
  assertSource(): void;
  assertDoors(): void;
  markHandoffPossible(): void;
  retireSource(): void;
  retireBeforeHandoff(): void;
}
function shellWord(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
export function terminalIdentityText(st: Pick<fs.BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "uid">): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs / 1000000000n}:${st.uid}`;
}

/** Read each shell library from a no-follow descriptor and retain its exact bytes. */
function sourceBytes(file: string): { pin: ToolIdentity; bytes: Buffer; hash: string } {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) throw new Error("ENV_HELPER_PATH_REFUSED");
  let fd: number | undefined;
  try {
    const real = fs.realpathSync.native(file);
    if (real !== file) throw new Error("ENV_HELPER_PATH_REFUSED");
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || !owned(before) || (before.mode & 0o022n) !== 0n) throw new Error("ENV_HELPER_PATH_REFUSED");
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(identity(file, real, before), identity(file, real, opened))) throw new Error("ENV_HELPER_PATH_REFUSED");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const pathname = fs.lstatSync(file, { bigint: true });
    if (!sameIdentity(identity(file, real, before), identity(file, real, after)) ||
        !sameIdentity(identity(file, real, before), identity(file, real, pathname)) ||
        BigInt(bytes.length) !== before.size) throw new Error("ENV_HELPER_PATH_REFUSED");
    return { pin: identity(file, real, before), bytes, hash: digest(bytes) };
  } catch { throw new Error("ENV_HELPER_PATH_REFUSED"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Bind the managed terminal operation before any adapter detection or launch. */
export function bindManagedTerminalTools(ctx: TrustedRuntimeContext, launcher: string,
  sourceBin: string, compiledDist: string): ManagedTerminalTools {
  const stat = "/usr/bin/stat", hash = process.platform === "darwin" ? "/usr/bin/shasum" : "/usr/bin/sha256sum";
  for (const file of ["/bin/bash", stat, hash]) pinTrustedFile(ctx, "terminal", file);
  assertTrustedFile(ctx, "terminal", launcher);
  const parent = fs.lstatSync(ctx.temporary, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== BigInt(process.getuid?.() ?? -1) ||
      fs.realpathSync.native(ctx.temporary) !== ctx.temporary) throw new Error("ENV_HELPER_PATH_REFUSED");
  const directory = fs.mkdtempSync(path.join(ctx.temporary, "terminal-tools-"));
  type OwnedEntry = { file: string; kind: "directory" | "file" | "link"; dev: bigint; ino: bigint;
    uid: bigint; mode: bigint; hash?: string; target?: string; removed: boolean; pendingSync?: boolean; writable?: boolean };
  const entries = new Map<string, OwnedEntry>();
  let handoffPossible = false;
  const record = (file: string, kind: OwnedEntry["kind"]): OwnedEntry => {
    const st = fs.lstatSync(file, { bigint: true });
    if (st.uid !== parent.uid || (kind === "directory" ? !st.isDirectory() :
      kind === "file" ? !st.isFile() || st.nlink !== 1n : !st.isSymbolicLink())) throw new Error("ENV_HELPER_PATH_REFUSED");
    const entry: OwnedEntry = { file, kind, dev: st.dev, ino: st.ino, uid: st.uid, mode: st.mode, removed: false };
    entries.set(file, entry);
    return entry;
  };
  record(directory, "directory");
  const verify = (entry: OwnedEntry): void => {
    const st = fs.lstatSync(entry.file, { bigint: true });
    if (st.dev !== entry.dev || st.ino !== entry.ino || st.uid !== entry.uid ||
        (!entry.writable && st.mode !== entry.mode) ||
        (entry.kind === "directory" ? !st.isDirectory() : entry.kind === "file" ? !st.isFile() || st.nlink !== 1n : !st.isSymbolicLink())) {
      throw new Error("ENV_HELPER_RETIRE_REFUSED");
    }
    if (entry.kind === "link") {
      if (fs.readlinkSync(entry.file) !== entry.target) throw new Error("ENV_HELPER_RETIRE_REFUSED");
    } else if (entry.kind === "file" && entry.hash !== undefined) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(entry.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd, { bigint: true });
        if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.uid !== entry.uid ||
            digest(fs.readFileSync(fd)) !== entry.hash) throw new Error("ENV_HELPER_RETIRE_REFUSED");
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  };
  const verifyParent = (): void => {
    const now = fs.lstatSync(ctx.temporary, { bigint: true });
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== parent.dev || now.ino !== parent.ino ||
        now.uid !== parent.uid) throw new Error("ENV_HELPER_RETIRE_REFUSED");
  };
  const children = (dir: string): OwnedEntry[] => [...entries.values()].filter(e => path.dirname(e.file) === dir);
  const verifyChildren = (dir: string): void => {
    verifyParent();
    if (dir !== ctx.temporary) verify(entries.get(dir)!);
    const expected = children(dir).filter(e => !e.removed).map(e => path.basename(e.file)).sort();
    const actual = fs.readdirSync(dir).sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      throw new Error("ENV_HELPER_RETIRE_REFUSED");
    }
  };
  const syncDir = (dir: string): void => {
    if (dir === ctx.temporary) verifyParent();
    else verify(entries.get(dir)!);
    const expected = dir === ctx.temporary ? parent : entries.get(dir)!;
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let failed = false;
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(dir, { bigint: true });
      if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.uid !== expected.uid ||
          !current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev ||
          current.ino !== expected.ino || current.uid !== expected.uid) throw new Error("ENV_HELPER_RETIRE_REFUSED");
      fs.fsyncSync(fd);
    } catch (error) { failed = true; throw error; }
    finally {
      try { fs.closeSync(fd); }
      catch (closeError) { if (!failed) throw closeError; }
    }
  };
  const syncPending = (entry: OwnedEntry): void => {
    if (!entry.pendingSync) return;
    syncDir(path.dirname(entry.file));
    entry.pendingSync = false;
  };
  const preflight = (dir: string): void => {
    verifyChildren(dir);
    for (const child of children(dir)) {
      if (child.removed) continue;
      verify(child);
      if (child.kind === "directory") preflight(child.file);
    }
  };
  const chmodOwnedDir = (entry: OwnedEntry, mode: number): void => {
    verify(entry);
    const fd = fs.openSync(entry.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd, { bigint: true });
      if (!st.isDirectory() || st.dev !== entry.dev || st.ino !== entry.ino || st.uid !== entry.uid) {
        throw new Error("ENV_HELPER_RETIRE_REFUSED");
      }
      fs.fchmodSync(fd, mode);
    } finally { fs.closeSync(fd); }
  };
  const removeTree = (dir: string): void => {
    const entry = entries.get(dir)!;
    if (entry.removed) { syncPending(entry); return; }
    verifyChildren(dir);
    const previousMode = fs.lstatSync(dir).mode & 0o777;
    if ((previousMode & 0o200) === 0) { chmodOwnedDir(entry, previousMode | 0o200); entry.writable = true; }
    try {
      for (const child of children(dir)) {
        if (child.removed) { syncPending(child); continue; }
        verifyChildren(dir);
        verify(child);
        if (child.kind === "directory") removeTree(child.file);
        else {
          fs.unlinkSync(child.file);
          child.removed = true;
          child.pendingSync = true;
          syncPending(child);
        }
      }
      verifyChildren(dir);
      verifyParent();
      fs.rmdirSync(dir);
      entry.removed = true;
      entry.pendingSync = true;
      syncPending(entry);
    } catch (error) {
      if (!entry.removed) {
        try {
          const now = fs.lstatSync(dir, { bigint: true });
          if (now.dev === entry.dev && now.ino === entry.ino && now.uid === entry.uid && now.isDirectory()) {
            chmodOwnedDir(entry, previousMode);
            entry.writable = false;
          }
        } catch { /* preserve the first retirement error and the remaining tree */ }
      }
      throw error;
    }
  };
  try {
  const chosen = new Map<string, { source: string; real: string; doorHash: string }>();
  const makeDoor = (name: string, source: string, real: string): void => {
    const st = fs.statSync(source, { bigint: true });
    const expected = terminalIdentityText(st);
    const expectedMode = process.platform === "darwin" ? st.mode.toString(8) : (st.mode & 0o7777n).toString(8);
    const hashValue = digest(fs.readFileSync(source));
    const statArgs = process.platform === "darwin" ? "-L -f '%d:%i:%z:%m:%u'" : "-L -c '%d:%i:%s:%Y:%u'";
    const modeArgs = process.platform === "darwin" ? "-L -f '%p'" : "-L -c '%a'";
    const hashArgs = process.platform === "darwin" ? "-a 256" : "";
    const body = `#!/bin/bash\nset -u\nsource_file=${shellWord(source)}\nreal_file=${shellWord(real)}\n` +
      `actual=$(${shellWord(stat)} ${statArgs} "$source_file" 2>/dev/null) || exit 78\n` +
      `[[ "$actual" == ${shellWord(expected)} && "$source_file" -ef "$real_file" && -f "$source_file" && -x "$source_file" ]] || exit 78\n` +
      `actual_mode=$(${shellWord(stat)} ${modeArgs} "$source_file" 2>/dev/null) || exit 78\n` +
      `[[ "$actual_mode" == ${shellWord(expectedMode)} ]] || exit 78\n` +
      `sum=$(${shellWord(hash)} ${hashArgs} "$source_file" 2>/dev/null) || exit 78\n` +
      `[[ "${"${sum%% *}"}" == ${shellWord(hashValue)} ]] || exit 78\nexec "$real_file" "$@"\n`;
    const door = path.join(directory, name);
    const fd = fs.openSync(door, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o700);
    const entry = record(door, "file");
    try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); entry.hash = digest(Buffer.from(body)); }
    finally { fs.closeSync(fd); }
    pinTrustedFile(ctx, "terminal", door);
    chosen.set(name, { source, real, doorHash: digest(Buffer.from(body)) });
  };
  for (const name of TERMINAL_TOOLS) {
    let real: string;
    try { real = trustedTool(ctx, name); }
    catch (e) {
      if (name === "bash" || name === "telepty") throw e;
      continue;
    }
    const source = toolPins.get(ctx)?.get(name)?.path;
    if (!source) throw new Error("ENV_HELPER_PATH_REFUSED");
    makeDoor(name, source, real);
  }
  makeDoor("managed-launcher", launcher, fs.realpathSync.native(launcher));
  const sourceRoot = path.join(directory, "source"), snapshotBin = path.join(sourceRoot, "bin");
  const snapshotLib = path.join(snapshotBin, "lib");
  for (const dir of [sourceRoot, snapshotBin, snapshotLib]) {
    fs.mkdirSync(dir, { mode: 0o700 });
    record(dir, "directory");
  }
  const sourcePins = new Map<string, { original: string; pin: ToolIdentity; hash: string; copy: string; copyPin: ToolIdentity }>();
  for (const name of ["platform.sh", "platform-unix.sh", "platform-windows.sh", "workspace-host.sh", "node-shim.sh"]) {
    const original = path.join(sourceBin, "lib", name), copy = path.join(snapshotLib, name);
    const captured = sourceBytes(original);
    const fd = fs.openSync(copy, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const entry = record(copy, "file");
    try { fs.writeFileSync(fd, captured.bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o400);
      entry.mode = fs.fstatSync(fd, { bigint: true }).mode; fs.fsyncSync(fd);
      entry.hash = captured.hash; }
    finally { fs.closeSync(fd); }
    const copyStat = fs.lstatSync(copy, { bigint: true });
    sourcePins.set(name, { original, pin: captured.pin, hash: captured.hash, copy,
      copyPin: identity(copy, copy, copyStat) });
  }
  const metadata = path.join(compiledDist, "src/session/agent-metadata.js");
  pinTrustedFile(ctx, "terminal", metadata, false);
  const distLink = path.join(sourceRoot, "dist");
  fs.symlinkSync(compiledDist, distLink, "dir");
  record(distLink, "link").target = compiledDist;
  const distLinkPin = identity(distLink, distLink, fs.lstatSync(distLink, { bigint: true }));
  for (const dir of [snapshotLib, snapshotBin, sourceRoot]) {
    chmodOwnedDir(entries.get(dir)!, 0o500);
    entries.get(dir)!.mode = fs.lstatSync(dir, { bigint: true }).mode;
  }
  const treePins = [directory, sourceRoot, snapshotBin, snapshotLib].map(dir => ({
    dir, pin: identity(dir, dir, fs.lstatSync(dir, { bigint: true })),
  }));
  const result: ManagedTerminalTools = {
    directory, launcher: path.join(directory, "managed-launcher"),
    platform: path.join(snapshotLib, "platform.sh"), workspaceHost: path.join(snapshotLib, "workspace-host.sh"),
    assertDoors(): void {
      for (const file of ["/bin/bash", stat, hash]) assertTrustedFile(ctx, "terminal", file);
      assertTrustedFile(ctx, "terminal", launcher);
      for (const { dir, pin } of treePins.slice(0, 1)) {
        const now = fs.lstatSync(dir, { bigint: true });
        if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== pin.dev || now.ino !== pin.ino ||
            now.uid !== BigInt(process.getuid?.() ?? -1) || (now.mode & 0o077n) !== 0n) throw new Error("ENV_HELPER_PATH_REFUSED");
      }
      for (const [name, binding] of chosen) {
        if (name === "managed-launcher") continue;
        assertTrustedTool(ctx, name, binding.real);
      }
      for (const [name, binding] of chosen) {
        const door = path.join(directory, name);
        assertTrustedFile(ctx, "terminal", door);
        if (digest(fs.readFileSync(door)) !== binding.doorHash) throw new Error("ENV_HELPER_PATH_REFUSED");
      }
    },
    assertSource(): void {
      assertTrustedFile(ctx, "terminal", metadata, false);
      if (fs.readlinkSync(distLink) !== compiledDist ||
          !sameIdentity(distLinkPin, identity(distLink, distLink, fs.lstatSync(distLink, { bigint: true })))) {
        throw new Error("ENV_HELPER_PATH_REFUSED");
      }
      for (const { dir, pin } of treePins.slice(1)) {
        const now = fs.lstatSync(dir, { bigint: true });
        if (!now.isDirectory() || !sameIdentity(pin, identity(dir, dir, now)) ||
            now.uid !== BigInt(process.getuid?.() ?? -1) || (now.mode & 0o077n) !== 0n) throw new Error("ENV_HELPER_PATH_REFUSED");
      }
      for (const { original, pin, hash: expectedHash, copy, copyPin } of sourcePins.values()) {
        const current = sourceBytes(original);
        const st = fs.lstatSync(copy, { bigint: true });
        if (!sameIdentity(pin, current.pin) || current.hash !== expectedHash || !st.isFile() ||
            st.uid !== BigInt(process.getuid?.() ?? -1) || (st.mode & 0o777n) !== 0o400n ||
            !sameIdentity(copyPin, identity(copy, copy, st)) ||
            digest(fs.readFileSync(copy)) !== expectedHash) throw new Error("ENV_HELPER_PATH_REFUSED");
      }
    },
    assert(): void { this.assertDoors(); this.assertSource(); },
    markHandoffPossible(): void { handoffPossible = true; },
    retireSource(): void {
      if (entries.get(sourceRoot)!.removed) { syncPending(entries.get(sourceRoot)!); return; }
      if (![...entries.values()].some(entry => entry.removed)) this.assertSource();
      this.assertDoors();
      verifyChildren(directory);
      preflight(sourceRoot);
      removeTree(sourceRoot);
    },
    retireBeforeHandoff(): void {
      if (handoffPossible) throw new Error("ENV_HELPER_RETIRE_REFUSED");
      if (entries.get(directory)!.removed) { syncPending(entries.get(directory)!); return; }
      preflight(directory);
      removeTree(directory);
    },
  };
  return result;
  } catch (error) {
    try { preflight(directory); removeTree(directory); } catch { /* retain the exact partial tree for inspection */ }
    throw error;
  }
}

const RUNTIME_FILES: Readonly<Record<string, string>> = Object.freeze({
  "dist/sandbox/sandbox-manager.js": "9eef40ef0700f36a57fa55f253dd48cb2fccadbe8ac4caca5aac47a2e4c686a5",
  "dist/sandbox/sandbox-utils.js": "f2c4c1cbbffc915e74870db5f5e075fcae3c6ca678bf92034b9b2a358ce062fe",
  "dist/sandbox/linux-sandbox-utils.js": "30c7edb9b3199da320e7ded80f2757c0045b07c890bc066ddc64a5f46dd7c639",
  "dist/sandbox/macos-sandbox-utils.js": "5e7672b216ac850e28c9ea90688d705a068ad6f8d1f2ece7e8399c7db92319dd",
  "dist/sandbox/java-proxy-agent.js": "173442a4445ac8ae721696029bebd1189ddf70ead2660b915ecd890b242f0cc9",
  "dist/utils/shell-quote.js": "40898decd1babc4bffdc2a43cc0bbe6e655fe891194379c0ef441df3df621225",
});
const PROXY_KEYS = new Set(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy",
  "GRPC_PROXY", "grpc_proxy", "FTP_PROXY", "ftp_proxy", "DOCKER_HTTP_PROXY", "DOCKER_HTTPS_PROXY"]);
const CERT_KEYS = new Set(["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
  "PIP_CERT", "GIT_SSL_CAINFO", "AWS_CA_BUNDLE", "CARGO_HTTP_CAINFO", "DENO_CERT",
  "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE", "NIX_SSL_CERT_FILE"]);
const GENERATED_KEYS = new Set(["SANDBOX_RUNTIME", "TMPDIR", "NO_PROXY", "no_proxy",
  "GIT_CONFIG_PARAMETERS", "GIT_SSH_COMMAND", "RSYNC_PROXY", "CLOUDSDK_PROXY_TYPE",
  "CLOUDSDK_PROXY_ADDRESS", "CLOUDSDK_PROXY_PORT", "CLOUDSDK_PROXY_USERNAME",
  "CLOUDSDK_PROXY_PASSWORD", "JAVA_TOOL_OPTIONS", "CLAUDE_CODE_HOST_HTTP_PROXY_PORT",
  "CLAUDE_CODE_HOST_SOCKS_PROXY_PORT",
  ...PROXY_KEYS, ...CERT_KEYS]);
const NO_PROXY = "localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
const FAST = /^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/;
function quoted(word: string): string {
  return word === "" ? "''" : FAST.test(word) ? word : "'" + word.replace(/'/g, "'\"'\"'") + "'";
}
/** Decode only the exact single-quote grammar of pinned SRT shell-quote.js. */
function srtWords(shell: string): string[] {
  if (!shell || Buffer.byteLength(shell) > 256 * 1024) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  const result: string[] = [];
  let i = 0;
  while (i < shell.length) {
    let word = "";
    if (shell[i] === " ") throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    while (i < shell.length && shell[i] !== " ") {
      if (shell[i] === "'") {
        const end = shell.indexOf("'", i + 1);
        if (end < 0) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
        word += shell.slice(i + 1, end); i = end + 1;
      } else if (shell.slice(i, i + 3) === "\"'\"") {
        word += "'"; i += 3;
      } else {
        const start = i;
        while (i < shell.length && /[A-Za-z0-9_./:=@+,-]/.test(shell[i]!)) i++;
        if (i === start) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
        word += shell.slice(start, i);
      }
    }
    result.push(word);
    if (shell[i] === " ") i++;
  }
  if (result.map(quoted).join(" ") !== shell) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  return result;
}
function generatedAssignments(words: string[]): Map<string, string> {
  const values = new Map<string, string>();
  const add = (key: string, value: string): void => {
    if (!GENERATED_KEYS.has(key) || values.has(key) || value.length > 8192) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    values.set(key, value);
  };
  if (process.platform === "linux") {
    if (!["bwrap", "/usr/bin/bwrap", "/bin/bwrap"].includes(words[0])) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    for (let i = 1; i < words.length; i++) {
      if (words[i] !== "--setenv") continue;
      if (!words[i + 1] || words[i + 2] === undefined) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
      add(words[i + 1]!, words[i + 2]!); i += 2;
    }
  } else if (process.platform === "darwin") {
    if (words[0] !== "env") throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    let found = false;
    for (let i = 1; i < words.length; i++) {
      if (words[i] === "/usr/bin/sandbox-exec") { found = true; break; }
      const part = words[i]!, at = part.indexOf("=");
      if (at <= 0) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
      add(part.slice(0, at), part.slice(at + 1));
    }
    if (!found) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  } else throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  if (values.get("SANDBOX_RUNTIME") !== "1") throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  return values;
}
function validPort(text: string): boolean {
  return /^[1-9][0-9]{0,4}$/.test(text) && Number(text) <= 65535;
}
function proxy(value: string, platform: NodeJS.Platform): { user: string; token: string; port: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED"); }
  if (!["http:", "socks5h:"].includes(url.protocol) || url.hostname !== "localhost" || !validPort(url.port) ||
      !["", "/"].includes(url.pathname) || url.search || url.hash) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  if (platform === "linux" && !["3128", "1080"].includes(url.port)) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  let user: string;
  try { user = decodeURIComponent(url.username); } catch { throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED"); }
  if (!/^srt(?:\.[A-Za-z0-9+/=]{1,251})?$/.test(user) || !/^[0-9a-f]{32}$/.test(url.password)) {
    throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  }
  return { user, token: url.password, port: url.port };
}
/** Pin the shipped SRT source and admit only its measured generated environment grammar. */
export function assertRuntimeOverlaySupported(runtimeRoot: string, wrapped: { argv: string[]; env: NodeJS.ProcessEnv },
  manifestEnv: Readonly<Record<string, string>>): void {
  const pkg = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8")) as { version?: unknown };
  if (pkg.version !== "0.0.76") throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  for (const [relative, expected] of Object.entries(RUNTIME_FILES)) {
    const actual = createHash("sha256").update(fs.readFileSync(path.join(runtimeRoot, relative))).digest("hex");
    if (actual !== expected) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  }
  if (wrapped.argv.length !== 3 || wrapped.argv[0] !== "/bin/bash" || wrapped.argv[1] !== "-c" ||
      Object.keys(wrapped.env).length !== Object.keys(manifestEnv).length ||
      Object.entries(manifestEnv).some(([key, value]) => wrapped.env[key] !== value)) {
    throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  }
  const values = generatedAssignments(srtWords(wrapped.argv[2]!));
  const proxyValues: Array<{ user: string; token: string; port: string }> = [];
  for (const [key, value] of values) {
    if (Object.hasOwn(manifestEnv, key) && key !== "TMPDIR" && manifestEnv[key] !== value) {
      throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    }
    if (key === "SANDBOX_RUNTIME") continue;
    if (key === "TMPDIR") {
      if (value !== (manifestEnv.CLAUDE_CODE_TMPDIR ?? manifestEnv.CLAUDE_TMPDIR ?? "/tmp/claude") ||
          value !== manifestEnv.TMPDIR) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    } else if (key === "NO_PROXY" || key === "no_proxy") {
      if (value !== NO_PROXY) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    } else if (PROXY_KEYS.has(key)) {
      proxyValues.push(proxy(value, process.platform));
    } else if (CERT_KEYS.has(key)) {
      if (!path.isAbsolute(value) || !fs.statSync(value).isFile()) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    } else if (key === "GIT_CONFIG_PARAMETERS") {
      if (value !== "'http.proxyAuthMethod=basic'") throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    } else if (key === "GIT_SSH_COMMAND") {
      if (!/^ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand='(?:nc -X 5 -x localhost:[1-9][0-9]{0,4} %h %p|socat - PROXY:localhost:%h:%p,proxyport=[1-9][0-9]{0,4},proxyauth=srt(?:\.[A-Za-z0-9+/=]{1,251})?:[0-9a-f]{32})'$/.test(value)) {
        throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
      }
    } else if (key === "RSYNC_PROXY") {
      if (!/^localhost:[1-9][0-9]{0,4}$/.test(value)) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    } else if (key === "CLOUDSDK_PROXY_TYPE") {
      if (value !== "http") throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    } else if (key === "CLOUDSDK_PROXY_ADDRESS") {
      if (value !== "localhost") throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    } else if (key.endsWith("_PORT")) {
      if (!validPort(value)) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    } else if (key === "CLOUDSDK_PROXY_USERNAME") {
      if (!/^srt(?:\.[A-Za-z0-9+/=]{1,251})?$/.test(value)) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    } else if (key === "CLOUDSDK_PROXY_PASSWORD") {
      if (!/^[0-9a-f]{32}$/.test(value)) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
    } else if (key === "JAVA_TOOL_OPTIONS") {
      const suffix = " -Djava.net.preferIPv4Stack=true";
      const agent = value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
      const jar = agent.startsWith("-javaagent:") ? agent.slice(11) : "";
      if (value !== suffix.trim() && !(jar && path.isAbsolute(jar) &&
          path.resolve(jar).startsWith(runtimeRoot + path.sep) && (agent === value || value === agent + suffix))) {
        throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
      }
    } else throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  }
  if (proxyValues.length === 0 || new Set(proxyValues.map(x => x.token)).size !== 1 ||
      new Set(proxyValues.map(x => x.user)).size !== 1) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  const http = values.get("HTTP_PROXY"), all = values.get("ALL_PROXY"), ftp = values.get("FTP_PROXY");
  if (!all || values.get("NO_PROXY") !== NO_PROXY || values.get("no_proxy") !== NO_PROXY) {
    throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  }
  if (http && (!http.startsWith("http://") || ["HTTPS_PROXY", "http_proxy", "https_proxy"]
      .some(key => values.get(key) !== http))) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  if (http && values.get("GIT_CONFIG_PARAMETERS") !== "'http.proxyAuthMethod=basic'") {
    throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  }
  if (all && ["all_proxy", "GRPC_PROXY", "grpc_proxy"].some(key => values.get(key) !== all)) {
    throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  }
  if (http && all !== http) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  if (ftp && (!ftp.startsWith("socks5h://") || values.get("ftp_proxy") !== ftp ||
      values.get("RSYNC_PROXY") !== `localhost:${new URL(ftp).port}`)) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  if (ftp && (!http || values.get("DOCKER_HTTP_PROXY") !== http ||
      values.get("DOCKER_HTTPS_PROXY") !== http)) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  const certs = [...CERT_KEYS].filter(key => values.has(key));
  if (certs.length && (certs.length !== CERT_KEYS.size ||
      new Set(certs.map(key => values.get(key))).size !== 1)) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  const expectedSsh = ftp && (process.platform === "darwin"
    ? `ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand='nc -X 5 -x localhost:${new URL(ftp).port} %h %p'`
    : `ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand='socat - PROXY:localhost:%h:%p,proxyport=${http ? new URL(http).port : ""},proxyauth=${proxyValues[0]!.user}:${proxyValues[0]!.token}'`);
  if (ftp && values.get("GIT_SSH_COMMAND") !== expectedSsh) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  const cloudKeys = ["CLOUDSDK_PROXY_TYPE", "CLOUDSDK_PROXY_ADDRESS", "CLOUDSDK_PROXY_PORT",
    "CLOUDSDK_PROXY_USERNAME", "CLOUDSDK_PROXY_PASSWORD"];
  if ((ftp && http && cloudKeys.some(key => !values.has(key))) ||
      (cloudKeys.some(key => values.has(key)) && cloudKeys.some(key => !values.has(key)))) {
    throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  }
  if (values.has("CLOUDSDK_PROXY_PORT") && (!http || values.get("CLOUDSDK_PROXY_PORT") !== new URL(http).port ||
      values.get("CLOUDSDK_PROXY_USERNAME") !== proxyValues[0]!.user ||
      values.get("CLOUDSDK_PROXY_PASSWORD") !== proxyValues[0]!.token)) {
    throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  }
  if (values.has("CLAUDE_CODE_HOST_HTTP_PROXY_PORT") && (!http ||
      values.get("CLAUDE_CODE_HOST_HTTP_PROXY_PORT") !== new URL(http).port)) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
  if (values.has("CLAUDE_CODE_HOST_SOCKS_PROXY_PORT") && (!ftp ||
      values.get("CLAUDE_CODE_HOST_SOCKS_PROXY_PORT") !== new URL(ftp).port)) throw new Error("ENV_RUNTIME_OVERLAY_UNSUPPORTED");
}
