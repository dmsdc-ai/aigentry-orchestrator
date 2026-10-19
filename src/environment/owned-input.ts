import * as fs from "node:fs";
import { inspect } from "node:util";
const CLAUDE_OAUTH_OPT_IN = "AIGENTRY_CLAUDE_OAUTH_TOKEN";

const MAX = 4096;
function validate(bytes: Buffer): void {
  if (bytes.length < 1 || bytes.length > MAX || !bytes.every(b => b >= 0x21 && b <= 0x7e)) {
    throw new Error("ENV_INPUT_INVALID");
  }
}
export class OwnedInput {
  #bytes: Buffer | null;
  private constructor(bytes: Buffer) { this.#bytes = bytes; }
  static fromBytes(bytes: Buffer): OwnedInput { validate(bytes); return new OwnedInput(Buffer.from(bytes)); }
  consume(): Buffer {
    if (!this.#bytes) throw new Error("ENV_INPUT_CONSUMED");
    const bytes = this.#bytes;
    this.#bytes = null;
    return bytes;
  }
  dispose(): void { this.#bytes?.fill(0); this.#bytes = null; }
  toJSON(): never { throw new Error("ENV_INPUT_OPAQUE"); }
  toString(): string { return "[OwnedInput]"; }
  [inspect.custom](): string { return "[OwnedInput]"; }
}
/** Capture before any affected import or helper, and remove from the actual parent. */
export function captureCompatibilityInput(env: NodeJS.ProcessEnv = process.env): OwnedInput | undefined {
  const raw = env[CLAUDE_OAUTH_OPT_IN];
  delete env[CLAUDE_OAUTH_OPT_IN];
  if (!raw) return undefined;
  const bytes = Buffer.from(raw, "utf8");
  try { validate(bytes); return OwnedInput.fromBytes(bytes); }
  catch { throw new Error("CLAUDE_OAUTH_TOKEN_INVALID"); }
  finally { bytes.fill(0); }
}
/** Caller transfers a selected channel only after invocation preflight succeeds. */
export async function ingestInvocationInput(fd: number): Promise<OwnedInput> {
  if (process.platform === "win32" || !Number.isInteger(fd) || fd < 3 || fd > 63) throw new Error("ENV_INPUT_CHANNEL_UNSUPPORTED");
  const st = fs.fstatSync(fd);
  if (!(st.isFIFO() || st.isSocket())) throw new Error("ENV_INPUT_CHANNEL_UNSUPPORTED");
  let closed = false;
  const owner = { dispose(): void {
    if (closed) return;
    closed = true;
    try { fs.closeSync(fd); } catch { throw new Error("ENV_INPUT_CHANNEL_UNSUPPORTED"); }
  } };
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    const stream = fs.createReadStream("", { fd, autoClose: false, highWaterMark: 4098 });
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const clear = (): void => { for (const chunk of chunks) chunk.fill(0); };
      const done = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { clear(); stream.destroy(); reject(error); }
        else { const result = Buffer.concat(chunks, length); clear(); resolve(result); }
      };
      const timer = setTimeout(() => done(new Error("ENV_INPUT_TIMEOUT")), 10_000);
      stream.on("data", (chunk: string | Buffer) => {
        const part = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        if (settled) { part.fill(0); return; }
        length += part.length;
        if (length > MAX + 1) { part.fill(0); done(new Error("ENV_INPUT_INVALID")); return; }
        chunks.push(part);
      });
      stream.once("error", () => done(new Error("ENV_INPUT_INVALID")));
      stream.once("end", () => done());
      stream.once("close", () => done(new Error("ENV_INPUT_INVALID")));
    });
    try {
      if (bytes.length < 2 || bytes.length > MAX + 1 || bytes[bytes.length - 1] !== 0x0a) throw new Error("ENV_INPUT_INVALID");
      return OwnedInput.fromBytes(bytes.subarray(0, -1));
    } finally { bytes.fill(0); }
  } finally { owner.dispose(); }
}
