import { isAbsolute } from "node:path";
import { listCaptureInventory } from "./inventory.js";

const LIMIT_PATTERN = /^[1-9][0-9]{0,3}$/;

function parseArgs(args: string[]): { root: string; limit: number } | null {
  if (args.length % 2 !== 0) return null;
  let root: string | undefined;
  let limit: number | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof value !== "string") return null;
    if (flag === "--root" && root === undefined && isAbsolute(value)) {
      root = value;
    } else if (flag === "--limit" && limit === undefined && LIMIT_PATTERN.test(value)
      && Number(value) <= 1000) {
      limit = Number(value);
    } else {
      return null;
    }
  }
  return root === undefined ? null : { root, limit: limit ?? 100 };
}

async function writeLine(line: string): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolve) => {
      process.stdout.write(line, (error) => resolve(!error));
    });
  } catch {
    return false;
  }
}

/**
 * Read-only capture inventory: one JSON document on stdout.
 * Exit 0 complete, 3 partial or unavailable observation, 2 invalid invocation or output failure.
 * Importing this module has no side effects.
 */
export async function runInventory(args: string[]): Promise<number> {
  // A write callback alone does not consume the stream's subsequent error event (EPIPE).
  process.stdout.on("error", () => { process.exitCode = 2; });
  const parsed = parseArgs(args);
  if (parsed === null) {
    // Arguments are rejected before any store access; caller input is never echoed.
    await writeLine(`${JSON.stringify({ schema_version: 1, error: "invalid_invocation" })}\n`);
    process.exitCode = 2;
    return 2;
  }
  let document: string;
  let code: number;
  try {
    const inventory = await listCaptureInventory(parsed.root, { limit: parsed.limit });
    document = `${JSON.stringify(inventory)}\n`;
    code = inventory.complete ? 0 : 3;
  } catch {
    document = `${JSON.stringify({ schema_version: 1, error: "inventory_failed" })}\n`;
    code = 2;
  }
  if (!(await writeLine(document))) {
    process.exitCode = 2;
    return 2;
  }
  return code;
}
