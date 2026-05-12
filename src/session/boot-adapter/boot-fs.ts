// ADR-MF #13 — BootFS extends #114 VirtualFS with writeFile + mkdirP.
// OQ3: subtype-not-hoist keeps #114 untouched (Rule 29 + composition).
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { nodeFs, type VirtualFS } from "../virtual-fs.js";

export interface BootFS extends VirtualFS {
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  mkdirP(path: string): Promise<void>;
}

export function nodeBootFs(): BootFS {
  const base = nodeFs();
  return {
    readFile: base.readFile.bind(base),
    exists: base.exists.bind(base),
    async writeFile(p: string, bytes: Uint8Array): Promise<void> {
      await fsWriteFile(p, bytes);
    },
    async mkdirP(p: string): Promise<void> {
      await mkdir(p, { recursive: true });
    },
  };
}

// In-memory test impl. Mirrors memoryFs() (#114) shape so tests can compose
// readFile / exists semantics identically. Empty-string values still register
// (parity with memoryFs marker sentinels). mkdirP is a no-op record — the map
// is path-keyed, so directories are implicit.
export function memoryBootFs(
  initial: Record<string, string | Uint8Array> = {},
): BootFS & { snapshot(): ReadonlyMap<string, Uint8Array> } {
  const enc = new TextEncoder();
  const map = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  for (const [k, v] of Object.entries(initial)) {
    map.set(k, typeof v === "string" ? enc.encode(v) : v);
  }
  return {
    async readFile(p: string): Promise<Uint8Array> {
      const b = map.get(p);
      if (!b) throw new Error(`memoryBootFs: ENOENT ${p}`);
      return b;
    },
    async exists(p: string): Promise<boolean> {
      return map.has(p) || dirs.has(p);
    },
    async writeFile(p: string, bytes: Uint8Array): Promise<void> {
      map.set(p, bytes);
    },
    async mkdirP(p: string): Promise<void> {
      dirs.add(p);
    },
    snapshot(): ReadonlyMap<string, Uint8Array> {
      return new Map(map);
    },
  };
}
