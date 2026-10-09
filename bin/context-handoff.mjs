#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Context handoff (#1201): prints the previous orchestrator session's derived, redacted context.
// Flags: [--workspace <abs>] [--before <ISO>] [--json] [--write|--dry-run].
// Exit 0 handoff printed, 3 no source, 2 invalid invocation or failure.
// dist resolution is bin/lib/node-shim.sh's, in node so it also runs where bash does not
// (native Windows): the sibling package root first (repo tree / installed package), then the
// package behind `aigentry-orchestrator` on PATH (a control workspace ships no dist/).
const REL = join("dist", "src", "context-handoff", "cli.js");

process.stdout.on("error", () => { process.exitCode = 2; });
process.stderr.on("error", () => { process.exitCode = 2; });

function onPath(name) {
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".ps1"] : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function packageRoots() {
  const roots = [];
  try {
    roots.push(dirname(dirname(realpathSync(fileURLToPath(import.meta.url)))));
  } catch {
    // Fall through to the PATH lookup.
  }
  const bin = onPath("aigentry-orchestrator");
  if (bin !== null) {
    try {
      const real = realpathSync(bin);
      if (real.endsWith(join("bin", "init", "cli.mjs"))) roots.push(resolve(real, "..", "..", ".."));
      else {
        for (const c of [join(dirname(bin), "node_modules", "@dmsdc-ai", "aigentry-orchestrator"),
          join(dirname(bin), "..", "@dmsdc-ai", "aigentry-orchestrator")]) {
          try {
            if (JSON.parse(readFileSync(join(c, "package.json"), "utf8")).name === "@dmsdc-ai/aigentry-orchestrator") roots.push(c);
          } catch {
            // Not this layout.
          }
        }
      }
    } catch {
      // No usable package on PATH.
    }
  }
  return roots;
}

let run;
const target = packageRoots().map((root) => join(root, REL)).find((file) => existsSync(file));
if (target === undefined) {
  process.stderr.write(`context-handoff: compiled implementation not found (${REL}); run \`tsc -p .\` in the repo, or install @dmsdc-ai/aigentry-orchestrator so 'aigentry-orchestrator' is on PATH\n`);
  process.exitCode = 2;
} else {
  try {
    const module = await import(pathToFileURL(target).href);
    if (typeof module.runHandoff !== "function") throw new Error("invalid module");
    run = module.runHandoff;
  } catch {
    process.stderr.write("context-handoff: module_unavailable\n");
    process.exitCode = 2;
  }
}

if (run) {
  try {
    const code = await run(process.argv.slice(2));
    if (process.exitCode !== 2) process.exitCode = code;
  } catch {
    process.stderr.write("context-handoff: handoff_failed\n");
    process.exitCode = 2;
  }
}
