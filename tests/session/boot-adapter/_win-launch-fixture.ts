// #1167 — fixtures + independent oracle for win-launch.test.ts. Test-only; never product code.
//
// Oracle = the pinned npm cmd-shim 6.0.3 GENERATOR itself (its own lib/index.js, executed),
// fed with fields this harness authored (P, A, T, vars). Expected bytes and the expected
// direct argv are therefore derived from what we gave the generator, never by parsing a
// wrapper and never by reproducing the product resolver.
// A second, separate transcription of CONTRACT-R2 §2 (contractBytes) cross-checks that the
// contract text matches the generator.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

// Raw bytes as shipped in official node-v20.20.2-win-x64.zip (SHASUMS256 dc3700fd…); lib/index.js has CRLF line ends.
export const CMD_SHIM_PIN = Object.freeze({
  version: "6.0.3",
  "lib/index.js": "4e5f3fcf05a00ece29888768a5f91b52d15ef736cfefab452ca77b66aa71b234",
  "lib/to-batch-syntax.js": "e39a03dac6e5e31c6c4bb58fab2c23e8aeeaacd53e0b8c63e742fe7f4ef476ec",
});

export const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
export const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

export type CmdShim = (from: string, to: string) => Promise<void>;

// WIN_LAUNCH_CMD_SHIM_DIR, else the cmd-shim bundled with this node's npm. Any identity
// mismatch is a skip reason (oracle unavailable), never a silent substitute.
export function locateGenerator(): { gen: CmdShim; dir: string } | { skip: string } {
  const bin = dirname(process.execPath);
  const candidates = process.env["WIN_LAUNCH_CMD_SHIM_DIR"]
    ? [process.env["WIN_LAUNCH_CMD_SHIM_DIR"]]
    : [join(bin, "node_modules", "npm", "node_modules", "cmd-shim"),
      join(bin, "..", "lib", "node_modules", "npm", "node_modules", "cmd-shim")];
  for (const dir of candidates) {
    if (!existsSync(join(dir, "package.json"))) continue;
    const version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version;
    if (version !== CMD_SHIM_PIN.version) return { skip: `ORACLE_UNAVAILABLE: cmd-shim ${String(version)} at ${dir}` };
    for (const f of ["lib/index.js", "lib/to-batch-syntax.js"] as const) {
      if (sha256(readFileSync(join(dir, f))) !== CMD_SHIM_PIN[f]) return { skip: `ORACLE_UNAVAILABLE: ${f} hash mismatch at ${dir}` };
    }
    return { gen: createRequire(import.meta.url)(join(dir, "lib", "index.js")) as CmdShim, dir };
  }
  return { skip: "ORACLE_UNAVAILABLE: no cmd-shim 6.0.3 (set WIN_LAUNCH_CMD_SHIM_DIR)" };
}

// ---- CONTRACT-R2 §2 transcription (independent of the generator source) ----
const HEADER = ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0"]
  .map((l) => l + "\r\n").join("");
export function contractBytes(form: "V-A", T: string, P: string, A: string): string;
export function contractBytes(form: "V-B", T: string): string;
export function contractBytes(form: "V-A" | "V-B", T: string, P = "", A = ""): string {
  if (form === "V-B") return `${HEADER}"%dp0%\\${T}"   %*\r\n`;
  return `${HEADER}\r\nIF EXIST "%dp0%\\${P}.exe" (\r\n  SET "_prog=%dp0%\\${P}.exe"\r\n) ELSE (\r\n  SET "_prog=${P}"\r\n` +
    `  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n` +
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ${A} "%dp0%\\${T}" %*\r\n`;
}

// #1167 P5: the real npm-style V-A `<name>.cmd` (P=node, A empty) that npm would place next to an
// extensionless JS bin target `<name>` in the same directory. Bytes from the §2 transcription above,
// never from the product generator. The extensionless target is left in place.
export function writeNpmCmdShim(dir: string, name: string): string {
  const file = join(dir, `${name}.cmd`);
  writeFileSync(file, contractBytes("V-A", name, "node", ""), "latin1");
  return file;
}

// ---- fake CLI (inert; self-expiring; nonce-bound start/exit receipts) ----
// Reports raw evidence only: argv0 / execArgv are NOT normalised by node (argv[1] is),
// so execArgv carries the original spelling of a `--require <T>` target.
export const FAKE_LIFETIME_MS = 4_000;
export function fakeCliSource(shebang: string | null): string {
  return `${shebang === null ? "" : shebang + "\n"}"use strict";
const fs = require("node:fs"), p = require("node:path"), crypto = require("node:crypto");
const dir = process.env.FAKE_DIR, nonce = process.env.FAKE_NONCE;
if (!dir || !nonce) process.exit(96);
const w = (k, o) => fs.writeFileSync(p.join(dir, nonce + "." + process.pid + "." + k), JSON.stringify({ nonce, pid: process.pid, ppid: process.ppid, ...o }));
w("start", {});
process.on("exit", (code) => w("exit", { code }));
setTimeout(() => process.exit(97), ${FAKE_LIFETIME_MS}).unref();
const B = (s) => Buffer.from(String(s), "utf8").toString("base64");
const report = (stdin) => {
  const keys = ["FAKE_NONCE", "FAKE_ENV_PROBE", "FOO", "_prog", "dp0", "PATHEXT"];
  const env = {}; for (const k of keys) env[k] = process.env[k] === undefined ? null : B(process.env[k]);
  process.stdout.write(JSON.stringify({ argv0: B(process.argv0), execPath: B(process.execPath),
    execArgv: process.execArgv.map(B), args: process.argv.slice(2).map(B), cwd: B(process.cwd()), env,
    stdin: stdin === null ? null : { len: stdin.length, sha256: crypto.createHash("sha256").update(stdin).digest("hex") } }));
  process.exitCode = Number(process.env.FAKE_EXIT || 0);
};
if (process.argv[2] === "--version") { process.stdout.write("fake-cli 1.2.3\\n"); }
else if (process.env.FAKE_MODE === "noread") report(null);
else { const c = []; process.stdin.on("data", (d) => c.push(d)); process.stdin.on("end", () => report(Buffer.concat(c))); }
`;
}
export interface FakeReport {
  argv0: string; execPath: string; execArgv: string[]; args: string[]; cwd: string;
  env: Record<string, string | null>; stdin: { len: number; sha256: string } | null;
}
export const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

export interface Receipt { nonce: string; pid: number; ppid: number; code?: number }
// Receipts for one nonce, keyed by pid. Missing exit for a started pid = cleanup unknown.
export function readReceipts(dir: string, nonce: string): Map<number, { start?: Receipt; exit?: Receipt }> {
  const out = new Map<number, { start?: Receipt; exit?: Receipt }>();
  for (const f of readdirSync(dir)) {
    const m = /^([0-9a-f]+)\.(\d+)\.(start|exit)$/.exec(f);
    if (!m || m[1] !== nonce) continue;
    const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Receipt;
    if (r.nonce !== nonce || r.pid !== Number(m[2])) throw new Error(`receipt provenance mismatch: ${f}`);
    const e = out.get(r.pid) ?? {};
    e[m[3] as "start" | "exit"] = r;
    out.set(r.pid, e);
  }
  return out;
}

// Owned case directory under an owned root; never deleted by the harness (evidence).
export function newCase(root: string, label: string): { dir: string; nonce: string } {
  const nonce = randomBytes(16).toString("hex");
  const dir = join(root, `${label}-${nonce.slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, nonce };
}

// A package dir with one bin target + the generator-produced wrapper in shimDir.
export interface ShimSpec { shebang: string | null; targetName: string; body?: string }
export async function makeShim(gen: CmdShim, pkgDir: string, shimDir: string, name: string, spec: ShimSpec): Promise<{ cmd: string; T: string }> {
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  const from = join(pkgDir, spec.targetName);
  if (!existsSync(from)) writeFileSync(from, spec.body ?? fakeCliSource(spec.shebang));
  await gen(from, join(shimDir, name));
  const cmd = readFileSync(join(shimDir, name + ".cmd"), "latin1");
  // T as the generator spells it (path.relative + "/"→"\\"), recomputed from our own inputs.
  return { cmd, T: relative(shimDir, from).split("/").join("\\") };
}

// ---- negative oracle: byte-level mutations of a valid generator output ----
export const MUTATIONS: ReadonlyArray<{ id: string; apply: (v: string) => string }> = Object.freeze([
  { id: "plus-line", apply: (v) => v.replace("CALL :find_dp0\r\n", "CALL :find_dp0\r\nREM x\r\n") },
  { id: "minus-line", apply: (v) => v.replace("SETLOCAL\r\n", "") },
  { id: "lf-only", apply: (v) => v.split("\r\n").join("\n") },
  { id: "cr-only", apply: (v) => v.split("\r\n").join("\r") },
  { id: "bom", apply: (v) => "ï»¿" + v }, // UTF-8 BOM bytes (latin1 string)
  { id: "no-final-crlf", apply: (v) => v.slice(0, -2) },
  { id: "extra-final-crlf", apply: (v) => v + "\r\n" },
  { id: "case-flip", apply: (v) => v.replace("@ECHO off", "@ECHO OFF") },
  { id: "trailing-space", apply: (v) => v.slice(0, -2) + " \r\n" },
  { id: "field-inconsistent", apply: (v) => v.replace(/SET "_prog=([^"%]+)"/, 'SET "_prog=$1x"') },
  { id: "vv-injected", apply: (v) => v.replace("CALL :find_dp0\r\n", "CALL :find_dp0\r\n@SET FOO=bar\r\n") },
]);
// Older-style wrapper. APPROXIMATION of pre-6 cmd-shim output, not byte-verified against
// any older release; it only has to be "not 6.0.3 bytes".
export const unknownVersionCmd = (T: string) =>
  `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\${T}" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n` +
  `  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\${T}" %*\r\n)\r\n`;

// T2 literal set: receipt CI37200420966 literals + CONTRACT-R2 §7 T2 additions.
export const SENTINEL = "injection-sentinel";
export const LITERALS: readonly string[] = Object.freeze([
  "", "two words", "한글 😀", 'a"b', "tail\\", "(parentheses)", "&", "|", "<", ">", "^", "%", "!", ";", "line1\nline2",
  "%PROBE_EXPANSION%", "!PROBE_EXPANSION!", `& echo owned>${SENTINEL}`, `| echo owned>${SENTINEL}`,
  `\n echo owned>${SENTINEL}`, `x" & echo owned>${SENTINEL} & rem "`,
  "a\rb", "\r", "a\r\nb", "%PATH%", '\\"', "tail\\\\",
]);
export const HOSTILE = LITERALS.filter((a) => /PROBE_EXPANSION|injection-sentinel|%PATH%/.test(a));
export const STDIN = "stdin empty-line follows\n\n한글 😀\r\n\" & | % !\n";
