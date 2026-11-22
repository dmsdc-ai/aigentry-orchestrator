// controller-link v1 — record store (SPEC §4, §5, §7; task 1291, shared with 1294).
//
// Layout under the injected root (`<package root>/state/controller-link/` by default, override
// `AIGENTRY_CONTROLLER_LINK_DIR`):
//
//   store.json                      {"v":1,"kind":"controller-link"} marker
//   store.json.lock                 withIndexLock lock file
//   outbox/<id>.json                sender records
//   inbox/<peer label>/<id>.json    receiver records
//   raw/<sha256>.env                exact canonical envelope bytes, write-once, content-addressed
//   probe-answers.json              record-less probe answers of the last 60 s (SPEC §8.1 throttle)
//
// Every path component is a validated UUID, label or hex64 before any filesystem call; no other
// record value becomes a path. Every mutation runs under withIndexLock(store.json): read, check,
// write the raw files the record names (write-once), atomicWrite the record, release. Directories are
// 0700 and files 0600 on POSIX, checked as in request-capture/receipt.ts; modes are not checked on
// win32 (THREAT-MODEL R5). The clock and the root are injected; this module reads no environment
// except through resolveStoreRoot(), which callers pass `process.env` to.
//
// Root decisions on HOLD-1 (2026-11-22) that amend SPEC §4.1: a message entry carries `sha256` =
// sha256 of the canonical envelope bytes (raw file name, new|duplicate|conflict key, corroboration
// match) AND `body_sha256` = sha256 of the normalised body (dispatch de-duplication only).
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWrite } from "../session/persistence/atomic-write.js";
import { withIndexLock } from "../session/persistence/index-lock.js";

// ---------------------------------------------------------------------------------------------
// Constants (SPEC §3.2, §4)

export const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const LABEL_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Obligation messages stored in `messages`: REQUEST-1 and REPLY-1..32. */
export const MESSAGE_KEY_RE = /^(?:REQUEST-1|REPLY-(?:[1-9]|[12][0-9]|3[0-2]))$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RECORD_FILE_RE = /^([0-9a-f-]{36})\.json$/;
const RAW_FILE_RE = /^([0-9a-f]{64})\.env$/;
const RECORDLESS_KEY_RE = /^[a-z][a-z0-9-]{0,31}\/[0-9a-f-]{36}\/(?:REQUEST-1|REPLY-(?:[1-9]|[12][0-9]|3[0-2]))$/;

export const MAX_RECORD_BYTES = 262_144;
export const HISTORY_MAX = 64;
export const SENDS_MAX = 32;
export const OPEN_RECORDS_MAX = 256;
export const UNVERIFIED_COPIES_MAX = 4;
export const RETENTION_MS = 30 * 86_400 * 1000;
/** At most this many record-less probe answers are remembered (all younger than the throttle interval). */
export const RECORDLESS_ANSWERS_MAX = 256;
/**
 * Windows device names (CON, PRN, AUX, NUL, COM0-9, LPT0-9; case-insensitive there). LABEL_RE accepts
 * them, but no directory can carry such a name on native Windows, so the store refuses them as a
 * peer label on every platform, and behaves the same everywhere.
 */
export const RESERVED_LABEL_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export const SENDER_STATES = [
  "prepared", "sent", "send_unknown", "send_refused", "unverified_at_peer", "received",
  "accepted", "refused", "replied", "stalled", "closed",
] as const;
export const RECEIVER_STATES = [
  "unverified", "received", "accepted", "refused", "replying", "replied", "stalled", "closed",
] as const;
export const TERMINAL_STATES = ["refused", "replied", "closed"] as const;
export const ATTEMPT_RESULTS = ["pending", "handed_over", "refused_definite", "unknown"] as const;
export const CORROBORATION_STATES = ["corroborated", "not_found", "audit_unavailable"] as const;

const STORE_MARKER = { v: 1, kind: "controller-link" } as const;

// ---------------------------------------------------------------------------------------------
// Types

export type Role = "sender" | "receiver";
export type SenderState = (typeof SENDER_STATES)[number];
export type ReceiverState = (typeof RECEIVER_STATES)[number];
export type RecordState = SenderState | ReceiverState;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];
export type MessageKey = string; // "REQUEST-1" | "REPLY-<1..32>", checked by MESSAGE_KEY_RE

export interface SendAttempt {
  n: number;
  at: string;
  owner: string;
  result: AttemptResult;
  submit?: string | null;
  inject_id?: string | null;
  detail?: string | null;
  [extra: string]: unknown;
}

export interface Corroboration {
  state: (typeof CORROBORATION_STATES)[number];
  at: string;
  inject_id: string | null;
  checks: number;
  [extra: string]: unknown;
}

export interface MessageEntry {
  /** sha256 of the canonical envelope bytes; names `raw/<sha256>.env`. */
  sha256: string;
  /** sha256 of the normalised body (envelope field body_sha256); dispatch de-duplication only. */
  body_sha256: string;
  /** Always `raw/<sha256>.env`. */
  raw: string;
  sends?: SendAttempt[];
  ingested_at?: string;
  outcome?: string;
  final?: string;
  /** Receiver's REQUEST-1 only (SPEC §4.2). */
  corroboration?: Corroboration;
  [extra: string]: unknown;
}

export interface UnverifiedCopy {
  sha256: string;
  raw: string;
  at: string;
}

export interface HistoryEntry {
  at: string;
  event: string;
  detail?: string | null;
  [extra: string]: unknown;
}

export interface LinkRecord {
  v: 1;
  role: Role;
  request_id: string;
  peer: string;
  peer_target: string;
  self_label: string;
  /** The request sender's task id, or "-" (dispatch --no-task). */
  sender_task: string;
  receiver_task: string | null;
  state: RecordState;
  state_at: string;
  next_action: { code: string; due_at: string | null; text: string; [extra: string]: unknown };
  messages: Record<MessageKey, MessageEntry>;
  acks_in: Record<MessageKey, { last_seq: number; state: string; [extra: string]: unknown }>;
  probes_out: Record<MessageKey, { last_seq: number; sends: SendAttempt[]; [extra: string]: unknown }>;
  acks_out: { last_seq: number; sends: SendAttempt[]; [extra: string]: unknown };
  notices: { n: number; last_at: string | null; [extra: string]: unknown };
  history: HistoryEntry[];
  history_dropped: number;
  /** Uncorroborated copies kept beside the record (SPEC §8.1), at most 4. */
  unverified_copies?: UnverifiedCopy[];
  /** Probe-answer throttle (SPEC §8.1 PROBE): referenced message key -> ISO time of the last answer. */
  probe_answers?: Record<MessageKey, string>;
  [extra: string]: unknown;
}

export type RecordRef =
  | { role: "sender"; requestId: string }
  | { role: "receiver"; peer: string; requestId: string };

export interface RawBlob {
  sha256: string;
  bytes: Uint8Array;
}

export interface StoreClock {
  nowMs(): number;
}

export interface StoreOptions {
  /** Absolute path of the store directory (see resolveStoreRoot). */
  root: string;
  clock: StoreClock;
  /** withIndexLock timeout; default that of withIndexLock (30 s). */
  lockTimeoutMs?: number;
}

export interface MutationContext {
  /** Injected clock, ISO-8601 UTC with milliseconds. */
  nowIso: string;
  nowMs: number;
}

export interface Mutation<T> {
  /** The full new record, or null to write nothing. */
  write: LinkRecord | null;
  /** Raw files the new record names that may not exist yet; written (if absent) before the record. */
  raws?: RawBlob[];
  value: T;
}

export type PutResult = "new" | "duplicate" | "conflict" | "absent";

export interface PutMessageInput {
  key: MessageKey;
  entry: MessageEntry;
  /** The canonical envelope bytes; sha256(raw) MUST equal entry.sha256. */
  raw: Uint8Array;
  /** Builds the record when none exists (it MUST contain `entry` under `key`). Without it: "absent". */
  create?: (ctx: MutationContext) => LinkRecord;
  /** Applied to the record after `entry` is stored, for a "new" result only (state, history, …). */
  apply?: (record: LinkRecord, ctx: MutationContext) => void;
}

export interface StatusEntry {
  role: Role;
  request_id: string;
  id8: string;
  peer: string;
  state: RecordState;
  next: string;
  due_at: string | null;
  sender_task: string;
  receiver_task: string | null;
  terminal: boolean;
}

export interface RetentionSelection {
  /** Terminal records with now − (the later of state_at and every message's ingested_at) ≥ 30 days. */
  records: RecordRef[];
  /** Raw files no record outside `records` names (orphans, or named only by selected records). */
  raws: string[];
}

export type StoreErrorCode = "STORE_CORRUPT" | "STORE_UNAVAILABLE" | "LINK_CAPACITY";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "StoreError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Pure helpers

export function isTerminal(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function rawRef(sha256: string): string {
  return `raw/${sha256}.env`;
}

/**
 * The idempotence key of an obligation message (SPEC §5): (peer, request id, kind, seq) — the
 * record ref plus `key` — and the envelope sha256.
 */
export function classifyMessage(record: LinkRecord | null, key: MessageKey, sha256: string): Exclude<PutResult, "absent"> {
  const existing = record?.messages[key];
  if (existing === undefined) return "new";
  return existing.sha256 === sha256 ? "duplicate" : "conflict";
}

/** ACK ordering (SPEC §7.1): a seq not greater than acks_in[ref].last_seq is stale. */
export function classifyAck(record: LinkRecord, ref: MessageKey, seq: number): "new" | "stale" {
  const seen = record.acks_in[ref];
  return seen !== undefined && seq <= seen.last_seq ? "stale" : "new";
}

export function statusOf(record: LinkRecord): StatusEntry {
  return {
    role: record.role,
    request_id: record.request_id,
    id8: record.request_id.slice(0, 8),
    peer: record.peer,
    state: record.state,
    next: record.next_action.code,
    due_at: record.next_action.due_at,
    sender_task: record.sender_task,
    receiver_task: record.receiver_task,
    terminal: isTerminal(record.state),
  };
}

/**
 * `<package root>/state/controller-link`, or AIGENTRY_CONTROLLER_LINK_DIR: absolute, no `..`
 * segment, no NUL (the DISPATCH_STATE_DIR rule, bin/dispatch-registry.py:148-160). Both
 * separators are segment boundaries on every platform.
 */
export function resolveStoreRoot(env: Record<string, string | undefined>, packageRoot: string): string {
  const override = env.AIGENTRY_CONTROLLER_LINK_DIR;
  if (override === undefined || override === "") {
    return path.join(packageRoot, "state", "controller-link");
  }
  if (override.includes("\0") || override.split(/[/\\]/).includes("..") || !path.isAbsolute(override)) {
    throw new StoreError("STORE_UNAVAILABLE", "AIGENTRY_CONTROLLER_LINK_DIR must be an absolute path without '..' segments");
  }
  return path.resolve(override);
}

function checkRequestId(id: unknown): string {
  if (typeof id !== "string" || !REQUEST_ID_RE.test(id)) {
    throw new StoreError("STORE_UNAVAILABLE", "path component invalid (request id)");
  }
  return id;
}

/** A label that can name a directory on every platform. */
const safeLabel = (label: string): boolean => LABEL_RE.test(label) && !RESERVED_LABEL_RE.test(label);

function checkLabel(label: unknown): string {
  if (typeof label !== "string" || !safeLabel(label)) {
    throw new StoreError("STORE_UNAVAILABLE", "path component invalid (peer label)");
  }
  return label;
}

function checkHex(sha: unknown): string {
  if (typeof sha !== "string" || !HEX64_RE.test(sha)) {
    throw new StoreError("STORE_UNAVAILABLE", "path component invalid (sha256)");
  }
  return sha;
}

function checkRef(ref: RecordRef): RecordRef {
  if (ref === null || typeof ref !== "object") throw new StoreError("STORE_UNAVAILABLE", "path component invalid (ref)");
  if (ref.role === "sender") return { role: "sender", requestId: checkRequestId(ref.requestId) };
  if (ref.role === "receiver") {
    return { role: "receiver", peer: checkLabel(ref.peer), requestId: checkRequestId(ref.requestId) };
  }
  throw new StoreError("STORE_UNAVAILABLE", "path component invalid (role)");
}

// --- record validation ------------------------------------------------------------------------

type Mode = "read" | "write";

function corrupt(mode: Mode, what: string): never {
  // A record the store would later read as corrupt is never written (nothing changes).
  throw new StoreError("STORE_CORRUPT", `${mode === "read" ? "record" : "refused write of record"}: ${what}`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const isNat = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
const isIsoOrNull = (v: unknown): boolean => v === null || isIso(v);
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === "string";

function checkSends(v: unknown, mode: Mode, where: string): void {
  if (!Array.isArray(v)) corrupt(mode, `${where} sends`);
  for (const a of v) {
    if (!isObj(a) || !isNat(a.n) || !isIso(a.at) || typeof a.owner !== "string"
      || !(ATTEMPT_RESULTS as readonly unknown[]).includes(a.result)) corrupt(mode, `${where} send attempt`);
    for (const k of ["submit", "inject_id", "detail"] as const) {
      if (k in a && !isStrOrNull(a[k])) corrupt(mode, `${where} send attempt ${k}`);
    }
  }
}

function validateRecord(value: unknown, ref: RecordRef, mode: Mode): LinkRecord {
  if (!isObj(value)) corrupt(mode, "not an object");
  if (value.v !== 1) corrupt(mode, "unknown v");
  if (value.role !== ref.role) corrupt(mode, "role");
  if (value.request_id !== ref.requestId) corrupt(mode, "request_id");
  if (typeof value.peer !== "string" || !LABEL_RE.test(value.peer)) corrupt(mode, "peer");
  if (ref.role === "receiver" && value.peer !== ref.peer) corrupt(mode, "peer");
  if (typeof value.self_label !== "string" || !LABEL_RE.test(value.self_label)) corrupt(mode, "self_label");
  if (typeof value.peer_target !== "string" || value.peer_target === "") corrupt(mode, "peer_target");
  if (typeof value.sender_task !== "string" || (value.sender_task !== "-" && !TASK_ID_RE.test(value.sender_task))) {
    corrupt(mode, "sender_task");
  }
  if (value.receiver_task !== null
    && (typeof value.receiver_task !== "string" || !TASK_ID_RE.test(value.receiver_task))) corrupt(mode, "receiver_task");
  const states: readonly unknown[] = ref.role === "sender" ? SENDER_STATES : RECEIVER_STATES;
  if (!states.includes(value.state)) corrupt(mode, "state");
  if (!isIso(value.state_at)) corrupt(mode, "state_at");
  const na = value.next_action;
  if (!isObj(na) || typeof na.code !== "string" || !isIsoOrNull(na.due_at) || typeof na.text !== "string") {
    corrupt(mode, "next_action");
  }

  if (!isObj(value.messages) || !isObj(value.messages["REQUEST-1"])) corrupt(mode, "messages");
  for (const [key, m] of Object.entries(value.messages)) {
    if (!MESSAGE_KEY_RE.test(key) || !isObj(m)) corrupt(mode, "message key");
    if (typeof m.sha256 !== "string" || !HEX64_RE.test(m.sha256)) corrupt(mode, `${key} sha256`);
    if (typeof m.body_sha256 !== "string" || !HEX64_RE.test(m.body_sha256)) corrupt(mode, `${key} body_sha256`);
    if (m.raw !== rawRef(m.sha256)) corrupt(mode, `${key} raw`);
    if ("sends" in m) checkSends(m.sends, mode, key);
    if ("ingested_at" in m && !isIso(m.ingested_at)) corrupt(mode, `${key} ingested_at`);
    if ("corroboration" in m) {
      const c = m.corroboration;
      if (key !== "REQUEST-1" || !isObj(c) || !(CORROBORATION_STATES as readonly unknown[]).includes(c.state)
        || !isIso(c.at) || !isStrOrNull(c.inject_id) || !isNat(c.checks)) corrupt(mode, `${key} corroboration`);
    }
  }
  if (!isObj(value.acks_in)) corrupt(mode, "acks_in");
  for (const [key, a] of Object.entries(value.acks_in)) {
    if (!MESSAGE_KEY_RE.test(key) || !isObj(a) || !isNat(a.last_seq) || typeof a.state !== "string") corrupt(mode, "acks_in entry");
  }
  if (!isObj(value.probes_out)) corrupt(mode, "probes_out");
  for (const [key, p] of Object.entries(value.probes_out)) {
    if (!MESSAGE_KEY_RE.test(key) || !isObj(p) || !isNat(p.last_seq)) corrupt(mode, "probes_out entry");
    checkSends(p.sends, mode, `probes_out ${key}`);
  }
  if (!isObj(value.acks_out) || !isNat(value.acks_out.last_seq)) corrupt(mode, "acks_out");
  checkSends(value.acks_out.sends, mode, "acks_out");
  if (!isObj(value.notices) || !isNat(value.notices.n) || !isIsoOrNull(value.notices.last_at)) corrupt(mode, "notices");
  if (!Array.isArray(value.history)) corrupt(mode, "history");
  for (const h of value.history) {
    if (!isObj(h) || !isIso(h.at) || typeof h.event !== "string" || ("detail" in h && !isStrOrNull(h.detail))) {
      corrupt(mode, "history entry");
    }
  }
  if (!isNat(value.history_dropped)) corrupt(mode, "history_dropped");
  if ("unverified_copies" in value) {
    const u = value.unverified_copies;
    if (!Array.isArray(u)) corrupt(mode, "unverified_copies");
    for (const c of u) {
      if (!isObj(c) || typeof c.sha256 !== "string" || !HEX64_RE.test(c.sha256) || c.raw !== rawRef(c.sha256) || !isIso(c.at)) {
        corrupt(mode, "unverified copy");
      }
    }
    if (u.length > UNVERIFIED_COPIES_MAX) {
      if (mode === "write") throw new StoreError("LINK_CAPACITY", `more than ${UNVERIFIED_COPIES_MAX} unverified copies`);
      corrupt(mode, "unverified_copies count");
    }
  }
  if ("probe_answers" in value) {
    const p = value.probe_answers;
    if (!isObj(p)) corrupt(mode, "probe_answers");
    for (const [key, at] of Object.entries(p)) {
      if (!MESSAGE_KEY_RE.test(key) || !isIso(at)) corrupt(mode, "probe_answers entry");
    }
  }
  return value as unknown as LinkRecord;
}

/** Raw files a record names (messages and unverified copies). */
export function rawsNamedBy(record: LinkRecord): string[] {
  const out = new Set<string>();
  for (const m of Object.values(record.messages)) out.add(m.sha256);
  for (const c of record.unverified_copies ?? []) out.add(c.sha256);
  return [...out];
}

/** The later of `state_at` and every message's `ingested_at` (retention's start). */
function lastChangeMs(record: LinkRecord): number {
  let t = Date.parse(record.state_at);
  for (const m of Object.values(record.messages)) {
    if (typeof m.ingested_at === "string") t = Math.max(t, Date.parse(m.ingested_at));
  }
  return t;
}

/** history ≤ 64 newest (+ history_dropped), every sends list ≤ 32 newest. Operates on a copy. */
function trimmed(record: LinkRecord): LinkRecord {
  const r = JSON.parse(JSON.stringify(record)) as LinkRecord;
  if (r.history.length > HISTORY_MAX) {
    r.history_dropped += r.history.length - HISTORY_MAX;
    r.history = r.history.slice(-HISTORY_MAX);
  }
  const cap = (s: SendAttempt[]): SendAttempt[] => (s.length > SENDS_MAX ? s.slice(-SENDS_MAX) : s);
  for (const m of Object.values(r.messages)) if (m.sends !== undefined) m.sends = cap(m.sends);
  for (const p of Object.values(r.probes_out)) p.sends = cap(p.sends);
  r.acks_out.sends = cap(r.acks_out.sends);
  return r;
}

// ---------------------------------------------------------------------------------------------
// Filesystem helpers

function requirePrivate(mode: number, expected: number): void {
  if (process.platform !== "win32" && (mode & 0o777) !== expected) {
    throw new StoreError("STORE_UNAVAILABLE", "invalid permissions");
  }
}

async function lstatIfPresent(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function checkDirectory(directory: string): Promise<boolean> {
  const stat = await lstatIfPresent(directory);
  if (stat === null) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StoreError("STORE_UNAVAILABLE", "invalid directory");
  requirePrivate(stat.mode, 0o700);
  return true;
}

async function privateDirectory(directory: string): Promise<void> {
  if (await checkDirectory(directory)) return;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!(await checkDirectory(directory))) throw new StoreError("STORE_UNAVAILABLE", "directory vanished");
}

/** Reads a private regular file, or null when absent. Over `limit` bytes is STORE_CORRUPT. */
async function readPrivateFile(target: string, limit: number): Promise<Buffer | null> {
  const stat = await lstatIfPresent(target);
  if (stat === null) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new StoreError("STORE_UNAVAILABLE", "invalid file");
  requirePrivate(stat.mode, 0o600);
  if (stat.size > limit) throw new StoreError("STORE_CORRUPT", "file too large");
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new StoreError("STORE_UNAVAILABLE", "file changed");
    const bytes = await handle.readFile();
    if (bytes.byteLength > limit) throw new StoreError("STORE_CORRUPT", "file too large");
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new StoreError("STORE_CORRUPT", "unparseable JSON");
  }
}

async function readDirNames(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// Marks a failure thrown by caller code inside a mutation, so it is rethrown unchanged.
class CallerFailure {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}

// ---------------------------------------------------------------------------------------------
// Store

export class ControllerLinkStore {
  readonly root: string;
  private readonly clock: StoreClock;
  private readonly lockTimeoutMs: number | undefined;

  constructor(opts: StoreOptions) {
    if (typeof opts.root !== "string" || opts.root.includes("\0") || !path.isAbsolute(opts.root)) {
      throw new StoreError("STORE_UNAVAILABLE", "store root must be an absolute path");
    }
    this.root = path.resolve(opts.root);
    this.clock = opts.clock;
    this.lockTimeoutMs = opts.lockTimeoutMs;
  }

  // --- paths (validated before use; never built from anything else) ---------------------------

  get markerPath(): string {
    return path.join(this.root, "store.json");
  }

  recordPath(ref: RecordRef): string {
    const r = checkRef(ref);
    return r.role === "sender"
      ? path.join(this.root, "outbox", `${r.requestId}.json`)
      : path.join(this.root, "inbox", r.peer, `${r.requestId}.json`);
  }

  rawPath(sha256: string): string {
    return path.join(this.root, "raw", `${checkHex(sha256)}.env`);
  }

  // --- reads (no lock: every file is replaced by an atomic rename) ----------------------------

  /** Null when the store, or the record, does not exist. */
  async read(ref: RecordRef): Promise<LinkRecord | null> {
    const r = checkRef(ref);
    const file = this.recordPath(r);
    return this.guard(async () => {
      if (!(await this.readable())) return null;
      if (!(await this.recordDirs(r, false))) return null;
      return this.readRecordFile(file, r);
    });
  }

  /** Raw envelope bytes, verified against their name; null when absent. */
  async readRaw(sha256: string): Promise<Buffer | null> {
    const file = this.rawPath(sha256);
    return this.guard(async () => {
      if (!(await this.readable())) return null;
      if (!(await checkDirectory(path.join(this.root, "raw")))) return null;
      const bytes = await readPrivateFile(file, MAX_RECORD_BYTES);
      if (bytes !== null && sha256Hex(bytes) !== sha256) throw new StoreError("STORE_CORRUPT", "raw bytes differ from their name");
      return bytes;
    });
  }

  /**
   * Every record (status, pump), sorted by role (sender first), peer, request id. Optional filters:
   * role, peer label, open (non-terminal) only. A missing store is an empty list.
   */
  async list(filter: { role?: Role; peer?: string; open?: boolean } = {}): Promise<LinkRecord[]> {
    const peerFilter = filter.peer === undefined ? undefined : checkLabel(filter.peer);
    return this.guard(async () => {
      if (!(await this.readable())) return [];
      const refs = await this.scanRefs(filter.role, peerFilter);
      const out: LinkRecord[] = [];
      for (const ref of refs) {
        const rec = await this.readRecordFile(this.recordPath(ref), ref);
        if (rec === null) continue; // removed by retention between readdir and read
        if (peerFilter !== undefined && rec.peer !== peerFilter) continue;
        if (filter.open === true && isTerminal(rec.state)) continue;
        out.push(rec);
      }
      return out;
    });
  }

  /** status / boot lines: statusOf() of every record matching `filter`. */
  async status(filter: { role?: Role; peer?: string; open?: boolean } = {}): Promise<StatusEntry[]> {
    return (await this.list(filter)).map(statusOf);
  }

  /**
   * Retention selector (SPEC §4; selection only, deletion belongs to the pump). Call it inside
   * withLock() and delete the selected records BEFORE the selected raw files.
   *
   * The 30 days run from the later of `state_at` and every message's `ingested_at`, so a key is kept
   * at least 30 days after its last arrival by this clock even when the clock went back in between, or
   * a message was stored on an already terminal record. With ingest's bound on future `sent_at`
   * (STALE_MESSAGE, cli.ts) that is longer than the 25 days an exact copy stays admissible.
   */
  async selectRetention(): Promise<RetentionSelection> {
    const now = this.clock.nowMs();
    return this.guard(async () => {
      if (!(await this.readable())) return { records: [], raws: [] };
      const named = new Set<string>();
      const records: RecordRef[] = [];
      for (const ref of await this.scanRefs(undefined, undefined)) {
        const rec = await this.readRecordFile(this.recordPath(ref), ref);
        if (rec === null) continue;
        if (isTerminal(rec.state) && now - lastChangeMs(rec) >= RETENTION_MS) {
          records.push(ref);
        } else {
          for (const sha of rawsNamedBy(rec)) named.add(sha);
        }
      }
      const raws: string[] = [];
      if (await checkDirectory(path.join(this.root, "raw"))) {
        for (const name of await readDirNames(path.join(this.root, "raw"))) {
          const m = RAW_FILE_RE.exec(name);
          if (m !== null && !named.has(m[1]!)) raws.push(m[1]!);
        }
      }
      return { records, raws };
    });
  }

  // --- mutations ------------------------------------------------------------------------------

  /** Runs `fn` holding the store lock (creating the store if needed). Not re-entrant. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.guard(async () => {
      await privateDirectory(this.root);
      const lock = await lstatIfPresent(`${this.markerPath}.lock`);
      if (lock !== null && (!lock.isFile() || lock.isSymbolicLink())) throw new StoreError("STORE_UNAVAILABLE", "invalid lock");
      return withIndexLock(this.markerPath, async () => {
        // Same fail-closed check as every read: records without a marker are STORE_CORRUPT.
        if (!(await this.readable())) {
          await atomicWrite(this.markerPath, Buffer.from(JSON.stringify(STORE_MARKER)), { sessionId: randomUUID() });
        }
        try {
          return await fn();
        } catch (error) {
          throw new CallerFailure(error);
        }
      }, this.lockTimeoutMs === undefined ? {} : { timeoutMs: this.lockTimeoutMs });
    });
  }

  /**
   * The one write path. Under the lock: read the current record (null if none), call `fn`, then —
   * if it returns a record — validate it, trim history/sends, check size and capacity, write the
   * given raw files (write-once) and atomicWrite the record. Errors thrown by `fn` pass unchanged.
   */
  async mutate<T>(ref: RecordRef, fn: (current: LinkRecord | null, ctx: MutationContext) => Mutation<T> | Promise<Mutation<T>>): Promise<T> {
    const r = checkRef(ref);
    const file = this.recordPath(r);
    return this.withLock(async () => {
      const current = await this.internal(async () => {
        await this.recordDirs(r, true);
        return this.readRecordFile(file, r);
      });
      const nowMs = this.clock.nowMs();
      const result = await fn(current, { nowMs, nowIso: new Date(nowMs).toISOString() });
      if (result.write !== null) await this.internal(() => this.commit(r, file, current, result.write!, result.raws ?? []));
      return result.value;
    });
  }

  /**
   * Idempotent write of an obligation message keyed (ref, key, envelope sha256) (SPEC §5):
   * "new" stores it (and applies `apply`), "duplicate" (same sha) and "conflict" (other sha)
   * write nothing, "absent" means no record and no `create`.
   */
  async putMessage(ref: RecordRef, input: PutMessageInput): Promise<{ result: PutResult; record: LinkRecord | null }> {
    const r = checkRef(ref);
    if (typeof input.key !== "string" || !MESSAGE_KEY_RE.test(input.key)) throw new StoreError("STORE_CORRUPT", "refused write: message key");
    const sha = checkHex(input.entry.sha256);
    if (sha256Hex(input.raw) !== sha) throw new StoreError("STORE_CORRUPT", "refused write: entry sha256 differs from raw bytes");
    return this.mutate<{ result: PutResult; record: LinkRecord | null }>(r, (current, ctx) => {
      if (current === null) {
        if (input.create === undefined) return { write: null, value: { result: "absent" as PutResult, record: null } };
        const created = input.create(ctx);
        if (created.messages[input.key]?.sha256 !== sha) {
          throw new StoreError("STORE_CORRUPT", "refused write: created record lacks the message");
        }
        return { write: created, raws: [{ sha256: sha, bytes: input.raw }], value: { result: "new" as PutResult, record: created } };
      }
      const verdict = classifyMessage(current, input.key, sha);
      if (verdict !== "new") return { write: null, value: { result: verdict as PutResult, record: current } };
      const next = JSON.parse(JSON.stringify(current)) as LinkRecord;
      next.messages[input.key] = input.entry;
      input.apply?.(next, ctx);
      return { write: next, raws: [{ sha256: sha, bytes: input.raw }], value: { result: "new" as PutResult, record: next } };
    });
  }

  /**
   * SPEC §8.1 PROBE throttle for a probe about a request with no record (the record keeps its own
   * `probe_answers`): true, and remembered under the store lock, when no answer to (peer, id, ref) was
   * given in the last `intervalMs`; false when one was. Entries older than `intervalMs` are dropped
   * on every claim, so the file holds only the last interval's answers; at RECORDLESS_ANSWERS_MAX of
   * them a further claim is false (no answer), so a flood cannot grow it.
   */
  async claimRecordlessAnswer(peer: string, requestId: string, ref: MessageKey, intervalMs: number): Promise<boolean> {
    const key = `${checkLabel(peer)}/${checkRequestId(requestId)}/${ref}`;
    if (!RECORDLESS_KEY_RE.test(key)) throw new StoreError("STORE_UNAVAILABLE", "path component invalid (ref)");
    const file = path.join(this.root, "probe-answers.json");
    return this.withLock(() => this.internal(async () => {
      const nowMs = this.clock.nowMs();
      const bytes = await readPrivateFile(file, MAX_RECORD_BYTES);
      const v = bytes === null ? { v: 1, answers: {} } : parseJson(bytes);
      if (!isObj(v) || v.v !== 1 || !isObj(v.answers)) throw new StoreError("STORE_CORRUPT", "probe-answers.json");
      const answers: Record<string, string> = {};
      for (const [k, at] of Object.entries(v.answers)) {
        if (!RECORDLESS_KEY_RE.test(k) || !isIso(at)) throw new StoreError("STORE_CORRUPT", "probe-answers.json entry");
        const age = nowMs - Date.parse(at);
        if (age >= 0 && age < intervalMs) answers[k] = at;
      }
      if (answers[key] !== undefined || Object.keys(answers).length >= RECORDLESS_ANSWERS_MAX) return false;
      answers[key] = new Date(nowMs).toISOString();
      await atomicWrite(file, Buffer.from(JSON.stringify({ v: 1, answers }), "utf8"), { sessionId: randomUUID() });
      return true;
    }));
  }

  // --- internals --------------------------------------------------------------------------------

  /** Maps any non-store failure of store code to STORE_UNAVAILABLE; caller failures pass through. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof CallerFailure) throw error.error;
      if (error instanceof StoreError) throw error;
      throw new StoreError("STORE_UNAVAILABLE", "filesystem or lock failure");
    }
  }

  /** Store code run inside a caller-facing lock callback: keep its errors classified. */
  private async internal<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError("STORE_UNAVAILABLE", "filesystem failure");
    }
  }

  /** False when there is no store yet. Checks the root and the marker. */
  private async readable(): Promise<boolean> {
    if (!(await checkDirectory(this.root))) return false;
    const marker = await readPrivateFile(this.markerPath, 1024);
    if (marker === null) {
      for (const sub of ["outbox", "inbox", "raw"]) {
        if (await lstatIfPresent(path.join(this.root, sub))) throw new StoreError("STORE_CORRUPT", "records without store marker");
      }
      return false;
    }
    this.checkMarker(marker);
    return true;
  }

  private checkMarker(bytes: Buffer): void {
    const m = parseJson(bytes);
    if (!isObj(m) || Object.keys(m).length !== 2 || m.v !== STORE_MARKER.v || m.kind !== STORE_MARKER.kind) {
      throw new StoreError("STORE_CORRUPT", "invalid store marker");
    }
  }

  /** Checks (and with `create`, makes) the directories of a record. False if one is absent. */
  private async recordDirs(ref: RecordRef, create: boolean): Promise<boolean> {
    const dirs = ref.role === "sender"
      ? [path.join(this.root, "outbox")]
      : [path.join(this.root, "inbox"), path.join(this.root, "inbox", ref.peer)];
    for (const d of dirs) {
      if (create) await privateDirectory(d);
      else if (!(await checkDirectory(d))) return false;
    }
    if (create) await privateDirectory(path.join(this.root, "raw"));
    return true;
  }

  private async readRecordFile(file: string, ref: RecordRef): Promise<LinkRecord | null> {
    const bytes = await readPrivateFile(file, MAX_RECORD_BYTES);
    return bytes === null ? null : validateRecord(parseJson(bytes), ref, "read");
  }

  /**
   * Record refs on disk (names that are not `<uuid>.json` / label directories are not records).
   * `peer` narrows the inbox scan to inbox/<peer>; the outbox is always scanned whole.
   */
  private async scanRefs(role: Role | undefined, peer: string | undefined): Promise<RecordRef[]> {
    const refs: RecordRef[] = [];
    if (role !== "receiver") {
      if (await checkDirectory(path.join(this.root, "outbox"))) {
        for (const name of await readDirNames(path.join(this.root, "outbox"))) {
          const m = RECORD_FILE_RE.exec(name);
          if (m !== null && REQUEST_ID_RE.test(m[1]!)) refs.push({ role: "sender", requestId: m[1]! });
        }
      }
    }
    if (role !== "sender" && (await checkDirectory(path.join(this.root, "inbox")))) {
      const labels = peer !== undefined ? [peer] : (await readDirNames(path.join(this.root, "inbox"))).filter(safeLabel);
      for (const label of labels) {
        if (!(await checkDirectory(path.join(this.root, "inbox", label)))) continue;
        for (const name of await readDirNames(path.join(this.root, "inbox", label))) {
          const m = RECORD_FILE_RE.exec(name);
          if (m !== null && REQUEST_ID_RE.test(m[1]!)) refs.push({ role: "receiver", peer: label, requestId: m[1]! });
        }
      }
    }
    return refs;
  }

  private async countOpen(ref: RecordRef): Promise<number> {
    const scope = ref.role === "sender" ? await this.scanRefs("sender", undefined) : await this.scanRefs("receiver", ref.peer);
    let open = 0;
    for (const other of scope) {
      if (other.requestId === ref.requestId) continue;
      const rec = await this.readRecordFile(this.recordPath(other), other);
      if (rec !== null && !isTerminal(rec.state)) open += 1;
    }
    return open;
  }

  private async writeRaw(blob: RawBlob): Promise<void> {
    const sha = checkHex(blob.sha256);
    const bytes = Buffer.from(blob.bytes);
    if (sha256Hex(bytes) !== sha) throw new StoreError("STORE_CORRUPT", "raw bytes differ from their name");
    const existing = await readPrivateFile(this.rawPath(sha), MAX_RECORD_BYTES);
    if (existing !== null) {
      if (!existing.equals(bytes)) throw new StoreError("STORE_CORRUPT", "existing raw file differs");
      return;
    }
    await atomicWrite(this.rawPath(sha), bytes, { sessionId: randomUUID() });
  }

  private async commit(ref: RecordRef, file: string, current: LinkRecord | null, next: LinkRecord, raws: RawBlob[]): Promise<void> {
    validateRecord(next, ref, "write");
    const record = trimmed(next);
    const bytes = Buffer.from(JSON.stringify(record), "utf8");
    if (bytes.byteLength > MAX_RECORD_BYTES) throw new StoreError("LINK_CAPACITY", "record larger than 256 KiB");
    if ((current === null || isTerminal(current.state)) && !isTerminal(record.state) && (await this.countOpen(ref)) >= OPEN_RECORDS_MAX) {
      throw new StoreError("LINK_CAPACITY", `${OPEN_RECORDS_MAX} open records`);
    }
    // A raw file is written (if absent) before the record that names it.
    for (const blob of raws) await this.writeRaw(blob);
    for (const sha of rawsNamedBy(record)) {
      const present = await readPrivateFile(this.rawPath(sha), MAX_RECORD_BYTES);
      if (present === null) throw new StoreError("STORE_CORRUPT", "record names a missing raw file");
      if (sha256Hex(present) !== sha) throw new StoreError("STORE_CORRUPT", "raw bytes differ from their name");
    }
    await atomicWrite(file, bytes, { sessionId: randomUUID() });
  }
}
