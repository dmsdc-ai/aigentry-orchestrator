import { createHash } from "node:crypto";

export const LIMITS = Object.freeze({
  records: 128, dependencyTasks: 32, depth: 8, manifestBytes: 1024 * 1024,
  sourceBytes: 8 * 1024 * 1024, requiredItemBytes: 64 * 1024,
  requiredBodyBytes: 128 * 1024, optionalBytes: 16 * 1024,
});
export type RefusalCode = "manifest_invalid" | "identity_mismatch" | "source_denied" |
  "source_changed" | "source_cut_unverified" | "source_cut_changed" |
  "coverage_unknown" | "closure_conflict" | "required_context_overflow" |
  "unsupported_required_payload" | "provider_budget_unknown" | "input_unobservable" |
  "registry_context_unavailable" | "attempt_changed";
export interface Diagnostic {
  code: RefusalCode; task: string | null; attempt: string | null; requirement_ids: string[];
  logical_source_id: string | null; expected_revision: string | null;
  observed_revision_or_null: string | null; owner: string; resume_condition: string;
  first_unclosed_edge: { from: string; to: string } | null;
  measured_bytes: number | null; limit_bytes: number | null;
}
export class ContextRefusal extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(`ENV_TASK_CONTEXT_REFUSED: ${JSON.stringify(diagnostic)}`);
  }
}
export function refuse(code: RefusalCode, m?: ContextManifest, source?: Source,
  detail: { edge?: { from: string; to: string }; bytes?: number; limit?: number } = {}): never {
  throw new ContextRefusal({
    code, task: m?.identity.task_id ?? null, attempt: m?.identity.attempt ?? null,
    requirement_ids: m?.basis.requirement_ids ?? [], logical_source_id: source?.id ?? null,
    expected_revision: source?.revision ?? null, observed_revision_or_null: null,
    owner: code.startsWith("provider") || code === "input_unobservable" ? "1201/provider" : "controller/1163",
    resume_condition: "Supply a new authenticated selection/cut and supported admission; do not retry uncertain delivery.",
    first_unclosed_edge: detail.edge ?? null, measured_bytes: detail.bytes ?? null, limit_bytes: detail.limit ?? null,
  });
}
export interface Identity {
  task_id: string; release_group: string; version: string; controller_binding_id: string;
  sid: string; attempt: string; scope_sha256: string; context_id: string; project_id: string;
  partition: { mode: "local-only" | "account"; namespace: string; account_id: string | null };
}
export interface Source {
  id: string; store: string; logical_ref: string; revision: string; sha256: string; bytes: number;
  schema: string; adapter: string; locator_id: string; observed_at: string;
  quality: "declared-snapshot" | "authenticated";
}
export type EdgeKind = "amends" | "supersedes" | "denies" | "revokes" | "requires" |
  "bound-to-task" | "produced-by" | "reviews" | "evidence-for" | "owns/in-flight" | "next-action-precondition";
export interface RecordEntry {
  id: string; kind: string; occurrence_id: string; source_id: string;
  extraction: { schema: string; start: number; end: number };
  text_sha256: string; parents: string[]; scope: string; requirement_ids: string[];
  authority: "user-evidence" | "controller-evidence" | "worker-evidence" | "imported-evidence";
  permission: { issuer: string; evidence_id: string; action: string; resource: string;
    revision: string; expires_at: string | null; revocation_generation: number } | null;
  required: boolean; reason: string; rank: number; source_order: number;
}
export const STATE_KEYS = ["goals", "constraints", "decisions", "approvals", "denials", "reports",
  "owners", "operations", "results", "checkpoints", "blockers", "next_actions"] as const;
export interface ContextManifest {
  schema: "aigentry-task-context/1";
  identity: Identity;
  revision: { generation: number; parent_sha256: string | null; source_cut: string;
    assembler: "1"; created_at: string };
  basis: { selection_revision: string; requirement_ids: string[]; request_ids: string[];
    current_request_id: string; ingress: string; cursor_start: string; cursor_end: string;
    gaps: string[]; owner_attestations: string[] };
  sources: Source[];
  records: RecordEntry[];
  state: { links: Record<typeof STATE_KEYS[number], string[]>; dependency_tasks: string[];
    source_commit: string; source_tree: string; dirty_artifacts: Array<{ id: string; sha256: string }> };
  closure: { selected_ids: string[]; edges: Array<{ from: string; to: string; kind: EdgeKind }>;
    exclusions: Array<{ id: string; reason: string }>; issues: string[];
    enumeration: { complete: boolean; source_count: number; record_count: number; receipt: string } };
  coverage: { expected_required_ids: string[]; expected_required_count: number };
  delivery: { original_ref_sha256: string; body_sha256: string | null; body_bytes: number | null;
    dispatch_id: null; final_ref_sha256: null; observed_input_receipt: null };
}
/** File locators are controller arguments, NEVER manifest-provided read grants. */
export interface ReadGrant {
  logical_id: string; root: string; relative: string; revision: string; sha256: string; bytes: number;
}
export interface Selection {
  identity: Identity; manifest: ReadGrant; original_ref: ReadGrant; sources: ReadGrant[];
  selection_revision: string; source_cut: string; required_ids: string[]; current_request_id: string;
}
export interface ContextRequest { manifestPath: string; manifestSha256: string; refPath: string; task: string; sid: string }
export interface AuthorityPort {
  select(request: ContextRequest): Selection;
  /** Existing writers must validate one authoritative cut, not matching unlocked reads. */
  validateCut(selection: Selection, phase: "preflight" | "before-binding"): {
    source_cut: string; selection_revision: string; receipt: string;
  };
}
export interface ProviderPort {
  /** Measured allowance after role/system/tool reservations; no chars/token estimate. */
  capacity: { receipt: string; provider: string; version: string; available_bytes: number };
  /** Must reserve an observed-input-gated route, not claim that staging proves consumption. */
  admit(finalBody: Buffer, selection: Selection): { receipt: string; body_sha256: string;
    attempt: string; input_status: "awaiting-observation"; route: "input-gated" };
}
export interface ContextPorts {
  authority: AuthorityPort | null; provider: ProviderPort | null;
  registry: { schema: "aigentry-context-binding/1" } | null;
}
export const UNAVAILABLE_PORTS: ContextPorts = Object.freeze({ authority: null, provider: null, registry: null });
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type Check = (value: unknown) => void;
const invalid = (): never => refuse("manifest_invalid");
const str: Check = v => { if (typeof v !== "string" || !v || Buffer.byteLength(v) > 4096 || /[\u0000-\u001f\u007f]/.test(v)) invalid(); };
const hash: Check = v => { if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) invalid(); };
const gitHash: Check = v => { if (typeof v !== "string" || !/^[0-9a-f]{40}$/.test(v)) invalid(); };
const num: Check = v => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) invalid(); };
const bool: Check = v => { if (typeof v !== "boolean") invalid(); };
const nil: Check = v => { if (v !== null) invalid(); };
const nullable = (check: Check): Check => v => { if (v !== null) check(v); };
const one = (...values: string[]): Check => v => { if (typeof v !== "string" || !values.includes(v)) invalid(); };
const list = (check: Check, max: number = LIMITS.records): Check => v => {
  if (!Array.isArray(v) || v.length > max) invalid();
  for (const item of v as unknown[]) check(item);
};
const obj = (shape: Record<string, Check>): Check => v => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) invalid();
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== Object.keys(shape).length || Object.keys(o).some(k => !Object.hasOwn(shape, k))) invalid();
  for (const [key, check] of Object.entries(shape)) check(o[key]);
};
const strings = list(str);
const permission = obj({ issuer: str, evidence_id: str, action: str, resource: str, revision: str,
  expires_at: nullable(str), revocation_generation: num });
const manifestShape = obj({
  schema: one("aigentry-task-context/1"),
  identity: obj({ task_id: str, release_group: str, version: str, controller_binding_id: str, sid: str,
    attempt: str, scope_sha256: hash, context_id: str, project_id: str,
    partition: obj({ mode: one("local-only", "account"), namespace: str, account_id: nullable(str) }) }),
  revision: obj({ generation: num, parent_sha256: nullable(hash), source_cut: str, assembler: one("1"), created_at: str }),
  basis: obj({ selection_revision: str, requirement_ids: strings, request_ids: strings, current_request_id: str,
    ingress: str, cursor_start: str, cursor_end: str, gaps: strings, owner_attestations: strings }),
  sources: list(obj({ id: str, store: str, logical_ref: str, revision: str, sha256: hash, bytes: num,
    schema: str, adapter: str, locator_id: str, observed_at: str, quality: one("declared-snapshot", "authenticated") })),
  records: list(obj({ id: str, kind: str, occurrence_id: str, source_id: str,
    extraction: obj({ schema: str, start: num, end: num }), text_sha256: hash, parents: strings,
    scope: str, requirement_ids: strings, authority: one("user-evidence", "controller-evidence", "worker-evidence", "imported-evidence"),
    permission: nullable(permission), required: bool, reason: str, rank: num, source_order: num })),
  state: obj({ links: obj(Object.fromEntries(STATE_KEYS.map(k => [k, strings]))),
    dependency_tasks: list(str, LIMITS.dependencyTasks), source_commit: gitHash, source_tree: gitHash,
    dirty_artifacts: list(obj({ id: str, sha256: hash })) }),
  closure: obj({ selected_ids: strings,
    edges: list(obj({ from: str, to: str, kind: one("amends", "supersedes", "denies", "revokes", "requires",
      "bound-to-task", "produced-by", "reviews", "evidence-for", "owns/in-flight", "next-action-precondition") }), 1024),
    exclusions: list(obj({ id: str, reason: str })), issues: strings,
    enumeration: obj({ complete: bool, source_count: num, record_count: num, receipt: str }) }),
  coverage: obj({ expected_required_ids: strings, expected_required_count: num }),
  delivery: obj({ original_ref_sha256: hash, body_sha256: nullable(hash), body_bytes: nullable(num),
    dispatch_id: nil, final_ref_sha256: nil, observed_input_receipt: nil }),
});

/** Sorted metadata only. Never use canonicalization on source payload bytes. */
export function canonicalBytes(value: unknown): Buffer {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") return Object.fromEntries(
      Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return Buffer.from(JSON.stringify(sort(value)) + "\n", "utf8");
}
export function decodeUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid(); }
}
export function parseManifest(bytes: Buffer, expectedHash: string): ContextManifest {
  if (bytes.length > LIMITS.manifestBytes) refuse("required_context_overflow");
  if (sha256(bytes) !== expectedHash) refuse("source_changed");
  const raw = decodeUtf8(bytes);
  // Scan key tokens before JSON.parse can discard escaped duplicate keys.
  const tokens = raw.match(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  try {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === "{" || t === "[") { if (stack.length >= 16) invalid(); stack.push(t === "{" ? new Set() : null); }
      else if (t === "}" || t === "]") stack.pop();
      else if (t.startsWith('"')) {
        const s = JSON.parse(t) as string;
        // Reject lone surrogate escapes as well as invalid raw UTF-8.
        if (Buffer.from(s, "utf8").toString("utf8") !== s) invalid();
        if (tokens[i + 1] === ":") {
          const keys = stack[stack.length - 1];
          if (["__proto__", "prototype", "constructor"].includes(s) || keys?.has(s)) invalid();
          keys?.add(s);
        }
      }
    }
    const value: unknown = JSON.parse(raw);
    manifestShape(value);
    const m = value as ContextManifest;
    if ((m.identity.partition.mode === "local-only") !== (m.identity.partition.account_id === null) ||
        (m.revision.generation === 0) !== (m.revision.parent_sha256 === null) ||
        (m.delivery.body_sha256 === null) !== (m.delivery.body_bytes === null)) invalid();
    if (!bytes.equals(canonicalBytes(m))) invalid();
    return m;
  } catch (e) { if (e instanceof ContextRefusal) throw e; return invalid(); }
}
