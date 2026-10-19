// Explicit caller lookup only. Importing this module performs no filesystem or
// PATH discovery; pure evidence exports never need a TypeScript runtime.
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const LOCAL_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACKAGE = "@dmsdc-ai/aigentry-orchestrator";
function packageAt(root) {
  const file = path.join(root, "package.json"), st = fs.statSync(file);
  if (!st.isFile() || st.size > 256 * 1024) throw new Error("ENV_RUNTIME_MISSING");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (pkg.name !== PACKAGE || pkg.bin?.["aigentry-orchestrator"] !== "bin/init/cli.mjs") throw new Error("ENV_RUNTIME_MISSING");
  return pkg;
}
function runtimeAt(root) {
  root = fs.realpathSync(root);
  packageAt(root);
  for (const leaf of ["dist/src/environment/bootstrap.js", "dist/src/environment/executable-version.js", "bin/lib/executable-version.mjs"]) {
    if (!fs.statSync(path.join(root, leaf)).isFile()) throw new Error("ENV_RUNTIME_MISSING");
  }
  return { runtimeRoot: root, modulePath: path.join(root, "dist/src/environment/bootstrap.js") };
}
export function environmentRuntime(env) {
  // Recognized colocated package identity owns this invocation before runtime
  // completeness is checked. Copied bins and unrelated/malformed packages do
  // not claim ownership, even when a bootstrap file is present.
  let colocated = false;
  try { packageAt(LOCAL_ROOT); colocated = true; } catch {}
  if (colocated) return runtimeAt(LOCAL_ROOT);
  const names = process.platform === "win32" ? ["aigentry-orchestrator", "aigentry-orchestrator.cmd"] : ["aigentry-orchestrator"];
  for (const dir of (env.PATH ?? "").split(path.delimiter).slice(0, 256)) {
    if (!path.isAbsolute(dir)) continue;
    for (const name of names) {
      let real;
      try { real = fs.realpathSync(path.join(dir, name)); } catch { continue; }
      for (const root of [path.resolve(real, "../../.."), path.join(dir, "node_modules/@dmsdc-ai/aigentry-orchestrator"),
        path.join(dir, "../@dmsdc-ai/aigentry-orchestrator")]) {
        try {
          packageAt(root);
          const cli = fs.realpathSync(path.join(root, "bin/init/cli.mjs"));
          const npmCmd = process.platform === "win32" && name === "aigentry-orchestrator.cmd" &&
            path.dirname(real).toLowerCase() === fs.realpathSync(dir).toLowerCase() &&
            path.basename(real).toLowerCase() === name && root !== path.resolve(real, "../../..");
          if (real !== cli && !npmCmd) continue;
        } catch { continue; }
        // The first registered package in PATH order is authoritative, including
        // its refusal when incomplete. No ambient or later-root import fallback.
        return runtimeAt(root);
      }
    }
  }
  throw new Error("ENV_RUNTIME_MISSING");
}
export function packageCrossSpawn(runtimeRoot) {
  const pkg = packageAt(runtimeRoot);
  if (typeof pkg.dependencies?.["cross-spawn"] !== "string") throw new Error("ENV_DEPENDENCY_MISSING");
  const owned = [path.join(runtimeRoot, "node_modules")];
  // npm may hoist a declared dependency to the containing node_modules. These
  // are package ancestry locations, never the copied workspace or global paths.
  let dir = path.dirname(runtimeRoot);
  for (;;) {
    if (path.basename(dir) === "node_modules") owned.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const require = createRequire(path.join(runtimeRoot, "package.json"));
  for (const owner of owned) {
    const dependency = path.join(owner, "cross-spawn");
    if (!fs.existsSync(dependency)) continue;
    const crossSpawn = require(dependency);
    if (typeof crossSpawn.sync !== "function") throw new Error("ENV_DEPENDENCY_MISSING");
    return crossSpawn;
  }
  throw new Error("ENV_DEPENDENCY_MISSING");
}
