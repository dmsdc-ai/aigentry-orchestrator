#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let outputFailed = false;
const outputError = () => {
  outputFailed = true;
  process.exitCode = 2;
};
process.stdout.on("error", outputError);
process.stderr.on("error", outputError);

let run;
let root;
try {
  const args = process.argv.slice(2);
  let packageRoot;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !isAbsolute(value)) throw new Error("invalid arguments");
    if (flag === "--root" && root === undefined) root = value;
    else if (flag === "--package-root" && packageRoot === undefined) packageRoot = value;
    else throw new Error("invalid arguments");
  }
  if (root === undefined) throw new Error("missing root");
  packageRoot ??= dirname(dirname(await realpath(fileURLToPath(import.meta.url))));
  const module = await import(pathToFileURL(join(packageRoot, "dist", "src", "request-capture", "cli.js")).href);
  if (typeof module.runCaptureHook !== "function") throw new Error("invalid module");
  run = module.runCaptureHook;
} catch {
  process.exitCode = 2;
  try {
    await new Promise((resolve) => {
      process.stdout.write(`${JSON.stringify({
        decision: "block",
        reason: "Capture blocked: hook arguments or capture module are unavailable.",
      })}\n`, () => resolve());
    });
  } catch {
    outputError();
  }
}

if (run) {
  try {
    const code = await run(["--root", root]);
    process.exitCode = !outputFailed && code === 0 ? 0 : 2;
  } catch {
    process.exitCode = 2;
    try {
      await new Promise((resolve) => {
        process.stdout.write(`${JSON.stringify({
          decision: "block",
          reason: "Capture blocked: submitted prompt could not be durably recorded.",
        })}\n`, () => resolve());
      });
    } catch {
      outputError();
    }
  }
}
