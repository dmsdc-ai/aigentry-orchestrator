export interface ExecutableVersionDeclaration {
  version: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

// The compiled runtime lives in dist/src/environment; its package owns bin/lib.
// Explicit types preserve the synchronous public API and emitted declarations.
const implementation: {
  parseDeclaredVersion(raw: unknown): ExecutableVersionDeclaration | null;
  validDeclaredVersion(raw: unknown): raw is string;
} = await import(new URL("../../../bin/lib/executable-version.mjs", import.meta.url).href);

export const parseDeclaredVersion = implementation.parseDeclaredVersion;
export const validDeclaredVersion = implementation.validDeclaredVersion;
