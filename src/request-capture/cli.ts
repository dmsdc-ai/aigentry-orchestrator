import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { captureSubmittedPrompt } from "./receipt.js";

/** Importing this module has no executable hook side effects. */
export async function runCaptureHook(args: string[]): Promise<number> {
  let reason: string | undefined;
  try {
    const root = args[1];
    if (args.length !== 2 || args[0] !== "--root" || !root || !isAbsolute(root)) {
      throw new Error("invalid arguments");
    }
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)) {
      throw new Error("invalid store");
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      // Refuse a previously decoded stream rather than reconstructing lost bytes.
      if (!Buffer.isBuffer(chunk)) throw new Error("invalid input stream");
      chunks.push(chunk);
    }
    const receipt = await captureSubmittedPrompt(Buffer.concat(chunks), { root });
    if (receipt.durability !== "file-and-directory-fsync") {
      reason = "Capture blocked: full file and directory durability is unavailable on this platform.";
    }
  } catch {
    reason = "Capture blocked: submitted prompt could not be durably recorded.";
  }

  const code = reason === undefined ? 0 : 2;
  const line = reason === undefined ? "{}\n" : `${JSON.stringify({ decision: "block", reason })}\n`;
  // A write callback alone does not consume the stream's subsequent error event.
  process.stdout.on("error", () => { process.exitCode = 2; });
  try {
    const written = await new Promise<boolean>((resolve) => {
      process.stdout.write(line, (error) => resolve(!error));
    });
    if (!written) {
      process.exitCode = 2;
      return 2;
    }
    return code;
  } catch {
    process.exitCode = 2;
    return 2;
  }
}
