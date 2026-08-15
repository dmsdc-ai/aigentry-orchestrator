// ADR-MF #4 — VirtualFS abstraction (SPEC §6).
// Production reads via node:fs/promises; tests inject an in-memory map.
// Article 17 무의존: stdlib only. Surface kept to the two operations the resolver needs.
import { access, readFile as fsReadFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

export interface VirtualFS {
  readFile(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
}

export function nodeFs(): VirtualFS {
  return {
    async readFile(p: string): Promise<Uint8Array> {
      const buf = await fsReadFile(p);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    // Only "this path is not there" may answer false. A bare `catch { return
    // false }` also swallowed EACCES/EPERM/EIO/ELOOP — i.e. "I was refused" and
    // "I am broken" reported as "it does not exist". readIfExists() in
    // resolve-instructions.ts then drops the layer, so an unreadable role file
    // composes a session whose contract is silently missing a layer rather than
    // failing. A refusal is not an absence; let it propagate.
    async exists(p: string): Promise<boolean> {
      try {
        await access(p, fsConstants.F_OK);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG") {
          return false;
        }
        throw err;
      }
    },
  };
}

// In-memory test fs. String values are UTF-8 encoded; Uint8Array passes through
// (lets fixtures construct CRLF / BOM / NFD byte sequences precisely).
// A registered path with empty content still counts as "exists" — useful for
// marker sentinels like /repo/.git in project_id derivation tests.
export function memoryFs(
  entries:
    | Iterable<readonly [string, Uint8Array | string]>
    | Record<string, Uint8Array | string>,
): VirtualFS {
  const enc = new TextEncoder();
  const map = new Map<string, Uint8Array>();
  const iter: Iterable<readonly [string, Uint8Array | string]> =
    Symbol.iterator in entries
      ? (entries as Iterable<readonly [string, Uint8Array | string]>)
      : Object.entries(entries);
  for (const [k, v] of iter) {
    map.set(k, typeof v === "string" ? enc.encode(v) : v);
  }
  return {
    async readFile(p: string): Promise<Uint8Array> {
      const v = map.get(p);
      if (!v) throw new Error(`memoryFs: not found: ${p}`);
      return v;
    },
    async exists(p: string): Promise<boolean> {
      return map.has(p);
    },
  };
}
