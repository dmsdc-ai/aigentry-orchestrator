#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Read-only capture inventory (#1166 U1). Exit 0 complete, 3 partial/unavailable, 2 failure.
let outputFailed = false;
const outputError = () => {
  outputFailed = true;
  process.exitCode = 2;
};
process.stdout.on("error", outputError);
process.stderr.on("error", outputError);

const fail = async (error) => {
  process.exitCode = 2;
  try {
    await new Promise((resolve) => {
      process.stdout.write(`${JSON.stringify({ schema_version: 1, error })}\n`, () => resolve());
    });
  } catch {
    outputError();
  }
};

let run;
let forwarded;
let packageRoot;
try {
  const args = process.argv.slice(2);
  let root;
  let limit;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof value !== "string" || value === "") throw new Error("invalid arguments");
    if (flag === "--root" && root === undefined && isAbsolute(value)) root = value;
    else if (flag === "--package-root" && packageRoot === undefined && isAbsolute(value)) packageRoot = value;
    else if (flag === "--limit" && limit === undefined) limit = value;
    else throw new Error("invalid arguments");
  }
  if (root === undefined) throw new Error("missing root");
  forwarded = limit === undefined ? ["--root", root] : ["--root", root, "--limit", limit];
} catch {
  await fail("invalid_invocation");
}

if (forwarded) {
  try {
    packageRoot ??= dirname(dirname(await realpath(fileURLToPath(import.meta.url))));
    const module = await import(pathToFileURL(join(packageRoot, "dist", "src", "request-capture", "inventory-cli.js")).href);
    if (typeof module.runInventory !== "function") throw new Error("invalid module");
    run = module.runInventory;
  } catch {
    await fail("module_unavailable");
  }
}

if (run) {
  try {
    const code = await run(forwarded);
    process.exitCode = outputFailed ? 2 : code;
  } catch {
    await fail("inventory_failed");
  }
}
