// #1167 CONTRACT-R2 §2–§5 / D1 — Windows launch resolution. stdlib only.
// Identity on non-win32. On win32, resolve argv0 the way cmd's command search
// would; launch `.exe`/`.com` hits directly, and launch a `.cmd` only when its
// bytes are exactly npm cmd-shim 6.0.3 output (V-A / V-B) with inert fields,
// as its program + fixed prefix + target. Everything else refuses. Never runs
// cmd.exe/PowerShell, never sets shell or windowsVerbatimArguments, never skips
// to a later hit, never follows the interpreter's own wrappers.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { BootAdapterError } from "./types.js";

export interface ResolvedLaunch {
  file: string;
  args: string[];
  // win32 only: the argv[0] spelling the wrapper / shell would have used.
  argv0?: string;
}

export function resolveLaunch(
  argv0: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): ResolvedLaunch {
  if (process.platform !== "win32") return { file: argv0, args: [...args] };
  const base = win32.resolve(cwd ?? process.cwd());
  const hit = findWindowsCommand(argv0, env, base);
  // Nothing found: let spawn surface the original OS error (ENOENT).
  if (hit === null) return { file: argv0, args: [...args] };
  if (isNative(hit)) return { file: hit, args: [...args], argv0 };
  if (win32.extname(hit).toLowerCase() === ".cmd") {
    const shim = readCmdShim(hit);
    // The shim's %dp0% spells every non-root parent as its directory entry (Windows CI 37228963220).
    const dir = parentSpelling(win32.dirname(hit));
    if (shim && !/[%"^&|<>]/.test(dir)) {
      // %~dp0 carries a trailing backslash; the wrapper then adds another.
      const dp0 = dir.endsWith("\\") ? dir : dir + "\\";
      const target = `${dp0}\\${shim.target}`;
      if (shim.form === "V-B") return { file: target, args: [...args], argv0: target };
      const prefix = shim.args.split(/[ \t]+/).filter((a) => a !== "");
      const local = `${dp0}\\${shim.prog}.exe`;
      if (existsSync(local)) return { file: local, args: [...prefix, target, ...args], argv0: local };
      const prog = findWindowsCommand(shim.prog, env, base);
      if (prog !== null && isNative(prog)) {
        return { file: prog, args: [...prefix, target, ...args], argv0: shim.prog };
      }
    }
  }
  throw new BootAdapterError("CLI_LAUNCH_UNSUPPORTED", hit);
}

// cmd's command search: cwd first (unless NoDefaultCurrentDirectoryInExePath is
// defined), then PATH entries in order; per directory the exact name (only if
// it already has an extension), then name + each PATHEXT extension. A name with
// a path component searches only that location. Returns the first hit or null.
export function findWindowsCommand(name: string, env: NodeJS.ProcessEnv, cwd: string): string | null {
  if (name === "") return null;
  const pathExt = envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  const exts = pathExt.split(";").filter((e) => e !== "");
  let dirs: string[];
  let base = name;
  if (/[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) {
    dirs = [win32.resolve(cwd, win32.dirname(name))];
    base = win32.basename(name);
  } else {
    dirs = splitPathList(envValue(env, "PATH") ?? "").map((d) => win32.resolve(cwd, d));
    if (envValue(env, "NoDefaultCurrentDirectoryInExePath") === undefined) dirs.unshift(cwd);
  }
  const names = win32.extname(base) !== "" ? [base] : [];
  for (const e of exts) names.push(base + e);
  for (const dir of dirs) {
    for (const n of names) {
      const p = win32.join(dir, n);
      if (isFile(p)) return onDiskSpelling(dir, n);
    }
  }
  return null;
}

// A confirmed hit, with its final component spelled as the directory entry (the
// constructed name carries the PATHEXT spelling): the exact entry first, else the
// unique case-insensitive entry. dir is kept as given (no realpath: junction/UNC/
// 8.3 segments stay). Ambiguous, no entry, or readdir refused → the confirmed hit
// unchanged (residual spelling parity unmeasured); never a different directory.
export function onDiskSpelling(dir: string, name: string, list: (d: string) => readonly string[] = readdirSync): string {
  let entries: readonly string[];
  try { entries = list(dir); } catch { return win32.join(dir, name); }
  if (entries.includes(name)) return win32.join(dir, name);
  const folded = entries.filter((e) => e.toUpperCase() === name.toUpperCase());
  return win32.join(dir, folded.length === 1 ? folded[0]! : name);
}

// A confirmed shim directory with each non-root component re-spelled root to leaf by the onDiskSpelling rule.
// The root/drive is kept as typed; no realpath (junction/UNC/8.3 segments keep their given name). Ambiguous or
// no entry → that component as given, traversal continues; readdir refused → that component and the rest as
// given, traversal stops. Unmeasured: UNC, junction, 8.3-enabled volumes, non-ASCII, uppercase-typed drive.
export function parentSpelling(dir: string, list: (d: string) => readonly string[] = readdirSync): string {
  const root = win32.parse(dir).root;
  const parts = dir.slice(root.length).split("\\").filter((p) => p !== "");
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    let refused = false;
    const next = onDiskSpelling(cur, parts[i]!, (d) => {
      try { return list(d); } catch (e) { refused = true; throw e; }
    });
    if (refused) return win32.join(cur, ...parts.slice(i));
    cur = next;
  }
  return cur;
}

export interface CmdShim {
  form: "V-A" | "V-B";
  prog: string;   // V-A only ("" for V-B)
  args: string;   // V-A only ("" for V-B)
  target: string;
}

// cmd-shim 6.0.3 lib/index.js:89-96.
const HEAD = "@ECHO off\r\n" +
  "GOTO start\r\n" +
  ":find_dp0\r\n" +
  "SET dp0=%~dp0\r\n" +
  "EXIT /b\r\n" +
  ":start\r\n" +
  "SETLOCAL\r\n" +
  "CALL :find_dp0\r\n";
const LAUNCH = "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ";
const DP0 = "\"%dp0%\\";

// The 6.0.3 `.cmd` formula (lib/index.js:61-119) without `env -S` variables.
export function generateCmdShim(s: CmdShim): string {
  if (s.form === "V-B") return `${HEAD}${DP0}${s.target}"   %*\r\n`;
  const longProg = `${DP0}${s.prog}.exe"`;
  return HEAD
    + "\r\n"
    + `IF EXIST ${longProg} (\r\n`
    + `  SET "_prog=${longProg.replace(/(^")|("$)/g, "")}"\r\n`
    + ") ELSE (\r\n"
    + `  SET "_prog=${s.prog.replace(/(^")|("$)/g, "")}"\r\n`
    + "  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n"
    + ")\r\n"
    + "\r\n"
    + LAUNCH
    + `"%_prog%" ${s.args.trim()} ${DP0}${s.target}" %*\r\n`;
}

// Recognition by regeneration: extract the fields, require them inert, then
// require the regenerated bytes to equal the file bytes. null = not recognised.
export function parseCmdShim(bytes: Buffer): CmdShim | null {
  const text = bytes.toString("latin1");
  if (!text.startsWith(HEAD)) return null;
  const body = text.slice(HEAD.length);
  let s: CmdShim;
  if (body.startsWith(DP0)) {
    if (!body.endsWith("\"   %*\r\n")) return null;
    s = { form: "V-B", prog: "", args: "", target: body.slice(DP0.length, -8) };
    if (!/\.(exe|com)$/i.test(s.target)) return null;
  } else {
    const prog = /^\r\nIF EXIST "%dp0%\\([^\r\n]*)\.exe" \(\r\n/.exec(body)?.[1];
    const lines = body.split("\r\n");
    const last = lines[lines.length - 2] ?? "";
    const head = `${LAUNCH}"%_prog%" `;
    if (prog === undefined || !last.startsWith(head) || !last.endsWith("\" %*")) return null;
    const rest = last.slice(head.length, -4);
    const at = rest.indexOf(DP0);
    if (at < 1 || rest[at - 1] !== " ") return null;
    s = { form: "V-A", prog, args: rest.slice(0, at - 1), target: rest.slice(at + DP0.length) };
    // Bare program name: printable ASCII, no blanks/separators/wildcards/cmd specials.
    if (!/^[\x21-\x7e]+$/.test(s.prog) || /[%"^&|<>!\\/:*?]/.test(s.prog)) return null;
    if (!/^[A-Za-z0-9._:=,/+@ \t-]*$/.test(s.args)) return null;
  }
  // Printable ASCII only: cmd decodes batch bytes in the active code page.
  if (!/^[\x20-\x7e]+$/.test(s.target) || /[%"^&|<>!]/.test(s.target) || s.target.endsWith("\\")) return null;
  return Buffer.from(generateCmdShim(s), "latin1").equals(bytes) ? s : null;
}

function readCmdShim(file: string): CmdShim | null {
  try { return parseCmdShim(readFileSync(file)); } catch { return null; }
}

function isNative(file: string): boolean {
  const ext = win32.extname(file).toLowerCase();
  return ext === ".exe" || ext === ".com";
}

function isFile(p: string): boolean {
  try { return statSync(p, { throwIfNoEntry: false })?.isFile() === true; } catch { return false; }
}

// Windows env names are case-insensitive. Mirror node's win32 spawn dedupe:
// keys sorted, the first spelling of a name wins.
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const keys: string[] = [];
  for (const k in env) keys.push(k);
  const key = keys.sort().find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

// cmd PATH list: `;`-separated, double quotes group and are stripped.
function splitPathList(list: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of list) {
    if (ch === "\"") quoted = !quoted;
    else if (ch === ";" && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.filter((d) => d !== "");
}
