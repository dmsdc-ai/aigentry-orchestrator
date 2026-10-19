import { accessSync, constants, statSync } from "node:fs";

/** Native Windows needs an interpreter; keep the script path and argv unmodified. */
export function registryInvocation(script: string, args: string[], platform: NodeJS.Platform): { cmd: string; args: string[] } {
  return platform === "win32"
    ? { cmd: "python", args: [script, ...args] }
    : { cmd: script, args };
}

/** Python's redirected output must be UTF-8 even when Windows defaults to cp1252. */
export function registryEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8" };
  for (const key of ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "DISPATCH_STATE_DIR"])
    if (inherited[key] !== undefined) result[key] = inherited[key];
  return result;
}

/** Windows reads the Python source; POSIX executes its shebang. */
export function registryAvailable(script: string): boolean {
  try {
    accessSync(script, process.platform === "win32" ? constants.R_OK : constants.X_OK);
    return statSync(script).isFile();
  } catch {
    return false;
  }
}
