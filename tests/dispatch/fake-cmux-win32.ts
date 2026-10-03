// #1167: Windows has no shebang exec, so the extensionless JS `cmux` stub is never found by the
// product's bare, shell-less `spawnSync("cmux")` there (ENOENT -> host-missing). On win32 the
// fixture instead installs a native `cmux.exe` compiled once per test process from the fixed
// C# 5 source below with the in-box .NET Framework compiler at one absolute path. Test-only:
// no PATH lookup, download, install or fallback; any missing prerequisite throws (never skips).
// The fake itself only reads two env vars, appends one log line and writes one reply: no child
// process, shell, network or reflection (a source property, not a measured native one).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, copyFileSync, lstatSync, mkdtempSync, openSync, readFileSync, rmdirSync, type Stats, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

/** Mirrors the POSIX `cmux` script in model-router-fixtures.ts byte-for-byte (LF, no BOM). */
export const FAKE_CMUX_CS = [
  "using System;",
  "using System.IO;",
  "using System.Text;",
  "",
  "internal static class FakeCmux",
  "{",
  "    private static int Main(string[] args)",
  "    {",
  "        string caps = Environment.GetEnvironmentVariable(\"CMUX_CAPS_LOG\");",
  "        string work = Environment.GetEnvironmentVariable(\"WORK_LOG\");",
  "        if (string.IsNullOrEmpty(caps) || string.IsNullOrEmpty(work)) return 98;",
  "        UTF8Encoding utf8 = new UTF8Encoding(false);",
  "        try",
  "        {",
  "            if (args.Length == 1 && string.Equals(args[0], \"capabilities\", StringComparison.Ordinal))",
  "            {",
  "                File.AppendAllText(caps, \"[\\\"capabilities\\\"]\\n\", utf8);",
  "                byte[] reply = utf8.GetBytes(\"{\\\"protocol\\\":\\\"cmux-socket\\\",\\\"version\\\":2,\\\"methods\\\":[]}\\n\");",
  "                using (Stream stdout = Console.OpenStandardOutput())",
  "                {",
  "                    stdout.Write(reply, 0, reply.Length);",
  "                    stdout.Flush();",
  "                }",
  "                return 0;",
  "            }",
  "            File.AppendAllText(work, \"forbidden\\n\", utf8);",
  "            return 99;",
  "        }",
  "        catch (Exception)",
  "        {",
  "            return 97;",
  "        }",
  "    }",
  "}",
].join("\n") + "\n";
export const FAKE_CMUX_CS_SHA256 = "7d14cad8a67e10064e5d81dd6c8ae8a878ac09a64780e5af80d9866e3f69d2c4";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
if (sha256(Buffer.from(FAKE_CMUX_CS, "utf8")) !== FAKE_CMUX_CS_SHA256) throw new Error("fake-cmux: FAKE_CMUX_CS does not match its sha256 pin");

export interface FakeCmuxBuild {
  /** Compiled exe inside this process's private scratch dir; fixtures copy it, never run it here. */
  readonly exe: string;
  readonly sourceSha256: string;
  readonly compilerSha256: string;
  /** The one corelib the compiler may bind (`/nostdlib+ /reference:` that exact file). */
  readonly mscorlibSha256: string;
  readonly exeSha256: string;
  readonly compilerStatus: number;
  readonly compilerElapsedMs: number;
}

const COMPILER_TIMEOUT_MS = 60000, COMPILER_MAX_BUFFER = 1024 * 1024, OUTPUT_LIMIT = 2048;
let built: FakeCmuxBuild | undefined, failure: Error | undefined;

/** One case-insensitive Windows env value, required, absolute `X:\...`, already normalized. */
function absoluteWindowsEnv(name: string): string {
  const values = new Set(Object.entries(process.env)
    .filter(([key, value]) => key.toUpperCase() === name.toUpperCase() && value !== undefined).map(([, value]) => value!));
  if (values.size !== 1) throw new Error(`fake-cmux prerequisite: ${name} must be set exactly once rc=-1`);
  const [value] = [...values] as [string];
  if (!/^[A-Za-z]:\\/.test(value) || value.indexOf(":", 2) !== -1 || /[\x00-\x1f"*<>?|/]/.test(value) || win32.normalize(value) !== value)
    throw new Error(`fake-cmux prerequisite: ${name} is not an explicit absolute path rc=-1`);
  return value;
}

/** Deletes only this attempt's known leaves, then the owned root without recursion; returns failures. */
function cleanupOwned(root: string, leaves: readonly string[]): string[] {
  const failed: string[] = [];
  for (const leaf of leaves) {
    try { lstatSync(join(root, leaf)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; failed.push(leaf); continue; }
    try { unlinkSync(join(root, leaf)); } catch { failed.push(leaf); }
  }
  try { rmdirSync(root); } catch { failed.push("<scratch>"); }
  return failed;
}

function compile(): FakeCmuxBuild {
  if (process.platform !== "win32") throw new Error("fake-cmux: the native fake is win32-only");
  const systemRoot = absoluteWindowsEnv("SystemRoot"), windir = absoluteWindowsEnv("WINDIR"), comSpec = absoluteWindowsEnv("ComSpec");
  if (systemRoot.toLowerCase() !== windir.toLowerCase()) throw new Error("fake-cmux prerequisite: SystemRoot and WINDIR disagree rc=-1");
  const framework = win32.join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319"), compiler = win32.join(framework, "csc.exe");
  let compilerStat;
  try { compilerStat = lstatSync(compiler); } catch { throw new Error("fake-cmux prerequisite: Framework64 v4.0.30319 csc.exe is missing rc=-1"); }
  if (!compilerStat.isFile() || compilerStat.isSymbolicLink() || compilerStat.size === 0) throw new Error("fake-cmux prerequisite: csc.exe is not a non-empty regular file rc=-1");
  const compilerSha256 = sha256(readFileSync(compiler));
  const mscorlib = win32.join(framework, "mscorlib.dll");
  let mscorlibStat;
  try { mscorlibStat = lstatSync(mscorlib); } catch { throw new Error("fake-cmux prerequisite: Framework64 v4.0.30319 mscorlib.dll is missing rc=-1"); }
  if (!mscorlibStat.isFile() || mscorlibStat.isSymbolicLink() || mscorlibStat.size === 0) throw new Error("fake-cmux prerequisite: mscorlib.dll is not a non-empty regular file rc=-1");
  const mscorlibSha256 = sha256(readFileSync(mscorlib));

  // Ownership is registered before anything that can fail: the exit hook removes exactly the
  // leaves this attempt created (cmux.cs, the compiler's cmux.exe) and then the private root.
  const scratchParent = tmpdir();
  const root = mkdtempSync(join(scratchParent, "fake cmux 1167 \u00fc-"));
  const leaves: string[] = [];
  let pending = true;
  const release = () => {
    if (!pending) return;
    pending = false;
    const failed = cleanupOwned(root, leaves);
    if (failed.length === 0) return;
    process.exitCode = 1;
    process.stderr.write(`fake-cmux: scratch cleanup failed for ${failed.join(", ")}\n`);
  };
  process.once("exit", release);
  // Compiler detail is redacted for these known paths only: each matched case-insensitively as an
  // escaped literal, longest first so the scratch root wins over its tmpdir parent or SystemRoot.
  const redactions = ([[root, "<scratch>"], [scratchParent, "<tmpdir>"], [systemRoot, "<SystemRoot>"]] as const)
    .filter(([path]) => path !== "").sort(([a], [b]) => b.length - a.length)
    .map(([path, label]) => [new RegExp(path.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"), "gi"), label] as const);
  const redact = (text: string) => redactions.reduce((acc, [pattern, label]) => acc.replace(pattern, label), text);
  const fail = (reason: string, rc: number | string, output = "") => {
    release();
    const detail = redact(output).slice(0, OUTPUT_LIMIT);
    return new Error(`fake-cmux prerequisite: ${reason} rc=${rc}${detail ? `\n${detail}` : ""}`);
  };

  const source = win32.join(root, "cmux.cs"), exe = win32.join(root, "cmux.exe");
  // Exclusive create is the ownership point: cmux.cs is registered the moment it exists, and the
  // compiler output cmux.exe before csc can run, so a failed write/close/compile still removes both.
  let fd: number;
  try { fd = openSync(source, "wx", 0o600); } catch { throw fail("cannot exclusively create cmux.cs", -1); }
  leaves.push("cmux.cs", "cmux.exe");
  const sourceFailures: string[] = [];
  try { writeFileSync(fd, FAKE_CMUX_CS, "utf8"); } catch (error) { sourceFailures.push(`write ${(error as NodeJS.ErrnoException).code ?? "error"}`); }
  finally { try { closeSync(fd); } catch (error) { sourceFailures.push(`close ${(error as NodeJS.ErrnoException).code ?? "error"}`); } }
  if (sourceFailures.length > 0) throw fail(`cannot write cmux.cs (${sourceFailures.join(", ")})`, -1);
  const sourceSha256 = sha256(readFileSync(source));
  if (sourceSha256 !== FAKE_CMUX_CS_SHA256) throw fail("written cmux.cs does not match its pin", -1);

  const started = Date.now();
  const r = spawnSync(compiler, ["/nologo", "/noconfig", "/nostdlib+", `/reference:${mscorlib}`, "/target:exe", "/optimize+", "/codepage:65001", "/utf8output", `/out:${exe}`, source], {
    cwd: root, env: { SystemRoot: systemRoot, WINDIR: windir, ComSpec: comSpec }, shell: false, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: COMPILER_TIMEOUT_MS, maxBuffer: COMPILER_MAX_BUFFER,
  });
  const compilerElapsedMs = Date.now() - started, output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error) throw fail(`csc.exe did not complete (${(r.error as NodeJS.ErrnoException).code ?? r.error.name})`, r.status ?? -1, output);
  if (r.signal !== null) throw fail(`csc.exe ended by ${r.signal}`, -1, output);
  if (r.status !== 0) throw fail("csc.exe failed", r.status ?? -1, output);

  let exeStat;
  try { exeStat = lstatSync(exe); } catch { throw fail("csc.exe produced no cmux.exe", r.status, output); }
  if (!exeStat.isFile() || exeStat.isSymbolicLink() || exeStat.size === 0) throw fail("cmux.exe is not a non-empty regular file", r.status, output);
  const exeBytes = readFileSync(exe);
  if (exeBytes.subarray(0, 2).toString("latin1") !== "MZ") throw fail("cmux.exe is not a PE image", r.status, output);
  return { exe, sourceSha256, compilerSha256, mscorlibSha256, exeSha256: sha256(exeBytes), compilerStatus: r.status, compilerElapsedMs };
}

/** Lazily compiles the fake once per test process; a failure is cached and rethrown, never retried. */
export function fakeCmuxBuild(): FakeCmuxBuild {
  if (failure) throw failure;
  try { built ??= compile(); }
  catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  return built;
}

/** Unlinks a rejected install copy only while it is still the owned regular file; else says why not. */
function removeOwnedCopy(target: string, owned: Stats | undefined): string | undefined {
  if (!owned) return "ownership not proven";
  let current: Stats;
  try { current = lstatSync(target); } catch (error) { return `re-check ${(error as NodeJS.ErrnoException).code ?? "error"}`; }
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) return "no longer the owned copy";
  try { unlinkSync(target); } catch (error) { return `unlink ${(error as NodeJS.ErrnoException).code ?? "error"}`; }
  return undefined;
}

/** Copies the compiled fake into a fixture bin as `cmux.exe` (exclusive) and rebinds it by sha256. */
export function installFakeCmux(bin: string): string {
  const build = fakeCmuxBuild(), target = win32.join(bin, "cmux.exe");
  // EEXIST or any copy fault propagates before ownership, so an existing/unknown target is never touched.
  copyFileSync(build.exe, target, fsConstants.COPYFILE_EXCL);
  // The successful exclusive copy is this attempt's. A rejected copy is removed only while lstat still
  // shows that same regular file (dev/ino); otherwise it is left and the failure says so. Private
  // test-fixture data: not a race-proof guard against adversarial shared directories.
  let owned: Stats | undefined, rejection: Error;
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("fake-cmux: installed cmux.exe is not a regular file");
    owned = stat;
    if (sha256(readFileSync(target)) === build.exeSha256) return target;
    rejection = new Error("fake-cmux: installed cmux.exe does not match the compiled sha256");
  } catch (error) { rejection = error instanceof Error ? error : new Error(String(error)); }
  const residue = removeOwnedCopy(target, owned);
  if (residue) throw new Error(`${rejection.message}; cmux.exe left in place (${residue})`, { cause: rejection });
  throw rejection;
}
