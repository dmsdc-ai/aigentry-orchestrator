// #1167 — typed bridge to the Windows private-storage primitive `bin/lib/win-private-storage.mjs`
// (plain ESM, shipped under bin/). At runtime this file is dist/src/session/private-storage.js, so
// `../../../` is the package root. The import stays conditional on win32: POSIX never loads the
// module (claude-worker-oauth.test.ts runs a copy of dist/src/session without bin/).

export type PrivateStorageCode =
  | "ok" | "unsupported_platform"
  | "system_root_invalid" | "tool_missing" | "tool_timeout" | "tool_failed" | "tool_output_invalid"
  | "principal_unavailable" | "path_invalid" | "missing" | "access_denied" | "read_failed" | "identity_changed"
  | "reparse_point" | "not_directory" | "not_file"
  | "owner_mismatch" | "dacl_absent" | "dacl_null" | "dacl_not_protected" | "ace_unsupported" | "ace_foreign_allow"
  | "ace_deny_user" | "owner_ace_missing" | "ace_foreign_write";

export type PrivateKind = "directory" | "file";
export type PrivateWant = "private" | "owned" | "owner";

export interface PrivateError { readonly status: "error"; readonly code: PrivateStorageCode; readonly exitCode?: number | null; readonly dev?: string; readonly ino?: string }
export interface PrivateOk { readonly status: "ok" }
export interface Principal { readonly status: "ok"; readonly userSid: string; readonly elevatedAdmin: boolean }
export interface Ace { readonly type: number; readonly flags: number; readonly mask: number | null; readonly sid: string | null }
export interface SecurityFacts {
  readonly status: "ok"; readonly ownerSid: string; readonly control: number; readonly dacl: readonly Ace[] | null;
  readonly dev: string; readonly ino: string;
}
export interface CheckResult { readonly ok: boolean; readonly code?: PrivateStorageCode }
export interface VerifyResult { readonly ok: boolean; readonly code?: PrivateStorageCode; readonly digest?: string; readonly dev?: string; readonly ino?: string }
export interface PrivateItem { readonly path: string; readonly kind: PrivateKind }
export interface VerifyItem extends PrivateItem { readonly want: PrivateWant }

export interface PrivateSession {
  readonly status: "ok";
  require(items: readonly VerifyItem[]): readonly VerifyResult[];
  require(path: string, want: PrivateWant): VerifyResult;
  markSet(path: string, kind: PrivateKind): PrivateOk | PrivateError;
  flush(): PrivateOk | PrivateError;
  digest(path: string): VerifyResult;
}

export interface WinPrivateStorage {
  currentPrincipal(): Principal | PrivateError;
  /** Directories only; kind 'file' is refused `path_invalid` (Q-FILE = R2). */
  setPrivate(path: string, kind: PrivateKind): PrivateOk | PrivateError;
  readSecurity(items: readonly PrivateItem[]): readonly (SecurityFacts | PrivateError)[];
  checkPrivate(facts: SecurityFacts | PrivateError, kind: PrivateKind, principal: Principal | PrivateError,
    options?: { readonly parentPrivate?: boolean }): CheckResult;
  checkOwned(facts: SecurityFacts | PrivateError, principal: Principal | PrivateError): CheckResult;
  checkOwner(facts: SecurityFacts | PrivateError, principal: Principal | PrivateError): CheckResult;
  aclDigest(facts: SecurityFacts): string | null;
  verify(items: readonly VerifyItem[]): readonly VerifyResult[];
  createSession(): PrivateSession | PrivateError;
  describe(code: PrivateStorageCode): string;
}

export const winPrivateStorage: WinPrivateStorage | null = process.platform === "win32"
  ? (await import(new URL("../../../bin/lib/win-private-storage.mjs", import.meta.url).href)) as WinPrivateStorage
  : null;
