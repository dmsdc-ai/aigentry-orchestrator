// #1170 report pump — the controller-side broker for confined worker reports.
//
// A confined worker cannot reach telepty (no sockets, no loopback, no writes to
// ~/.telepty), so it never sends. It writes an envelope-valid item into its own
// outbox; this pump, running as the host, finds the sealed attempt the registry
// pinned at dispatch, reads the outbox through outbox.ts, copies each new item
// into the controller inbox, records it through the registry (the only writer),
// and notifies the orchestrator as `dispatch-tracker` with no forced Enter. It
// then retries on a durable schedule until a human ACK reviews the item.
//
// Every step is idempotent and ordered inbox-write → registry event → notice.
// A notice is CLAIMED in the registry before it is sent (compare-and-set on its
// count), so two concurrent pumps send it once, and a pump that dies between the
// claim and the result leaves `pending`, which the schedule retries.
//
// Nothing here uses bash, curl, pmset, launchd, telepty-auth.sh, uid or mode
// checks as authority: the same code runs on macOS, Linux and native Windows (on
// Windows a valid bound capture refuses before filesystem access because the
// anchored reader has no O_NOFOLLOW there).
import { spawnSync } from "node:child_process";
import crossSpawn from "cross-spawn";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { parseInjectId } from "../dispatch/inject-id.js";
import { registryEnvironment, registryInvocation } from "../dispatch/registry-command.js";
import { validatedTeleptyPort } from "../telepty/http.js";
import { strictJson } from "../environment/contract.js";
import { defaultPathConfig } from "../session/persist-context.js";
import { readPrivate, readSealedManifest } from "../session/worker-sandbox.js";
import {
  DEFAULT_POLICY, claimHeld, decide, heldNoticeAtMs, inScanSet, legacyNoticeDue, nextNoticeAtMs, pendingObservations,
  type Destination, type InjectObservation, type InvalidItem, type PumpPolicy, type ReportRow, type ReportState,
  type ScanResult, type ScannedItem, type SubmitOutcome,
} from "./decide.js";
import {
  HEX64_RE, ITEM_KEY_RE, REQUEST_ID_RE, parseItem, parseTurnFields, renderDegradedNotice, renderLegacyDigest, renderNotice,
  renderUnboundTurnNotice, sanitizeBody, type ItemKind, type LegacyDigestEntry, type NoticeHeader, type SanitizedBody,
} from "./envelope.js";
import {
  DISPATCH_ID_RE, UNBOUND_DIR, scanAnchoredOutbox, writeInboxCopy, type AnchoredEntry,
} from "./outbox.js";

export const BROKER_SID = "dispatch-tracker";
export const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const LEGACY_MARK_PER_PASS = 20;
export const LEGACY_DIGEST_MAX = 20;
export const DEGRADED_AFTER_FAILED_PASSES = 3;
export const HEALTH_FILE = "report-pump-health.json";
const STATUS_RECORDS_MAX = 200;
const STALE_PASS_MS = 10 * 60_000;
const UNBOUND_SEEN_MAX = 256;
const ACK_ITEM_RE = /^(?:(?:REPORT|HOLD)-(?:[1-9]|[12][0-9]|3[0-2])|TURN-(?:[1-9]|[1-5][0-9]|6[0-4])|failure-[1-9][0-9]{0,2}|legacy)$/;
// ── time budgets (F3): inject + margin < claim lease (2 min); a pass ends well before the
// reconciler kills `report-pump --once` (300 s, src/reconciler/cli.ts step 0b3).
/** One inject's hard budget; spawnSync kills telepty after it. */
export const INJECT_TIMEOUT_MS = 90_000;
/** The claim result write after the inject (one registry call); INJECT_TIMEOUT_MS + this < the lease. */
export const CLAIM_MARGIN_MS = 25_000;
/** Real (monotonic) time after which a pass starts no record and no inject that could outlive it. */
export const PASS_DEADLINE_MS = 240_000;
const OWNER_HOST = os.hostname().replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "_";
/** This pump as a claim owner: `<pid>@<host>` (same-host pid liveness is the proof; see ownerMayBeSending). */
export const PUMP_OWNER = `${process.pid}@${OWNER_HOST}`;
/** Set per pumpOnce (synchronous; one pass at a time per process). */
let passDeadline = Infinity;
const VERDICT_RE = /^[a-z_]{1,16}$/;
/** Child env keys that would make telepty claim a session identity for the broker. */
export const TELEPTY_IDENTITY_ENV = ["TELEPTY_SESSION_ID", "TELEPTY_SESSION_TOKEN", "TELEPTY_SESSION_NONCE",
  "TELEPTY_SUBMIT_FORCE_DEFAULT"] as const;

// ── injected ports ───────────────────────────────────────────────────────────
export interface ProcessResult {
  status: number;
  stdout: string;
}

/** bin/dispatch-registry.py, the only writer. `list` → report-list, `event` → report-event. */
export interface RegistryPort {
  list(args: string[]): ProcessResult;
  event(args: string[]): ProcessResult;
}

export interface TeleptySession {
  id: string;
  host?: string;
}

export interface InjectAuditRow {
  inject_id: string;
  to?: string;
  claimed_from?: string | null;
  verified_sender_sid?: string | null;
  delivery_result?: string | null;
}

export interface InjectResult {
  /** null = killed by the timeout: whether bytes landed is unknown. */
  rc: number | null;
  stdout: string;
  stderr: string;
}

export interface TeleptyPort {
  /** `telepty list --json`; null when the listing could not be obtained or parsed. */
  list(): TeleptySession[] | null;
  /** `telepty inject --submit --no-submit-force --submit-retry 2 --from dispatch-tracker <dest> <text>` */
  inject(dest: string, text: string): InjectResult;
  /** `telepty injects --json --to <dest> --since <iso> --limit 200`; null when unavailable. */
  injects(dest: string, sinceIso: string): InjectAuditRow[] | null;
}

export interface ClockPort {
  nowMs(): number;
}

export interface PumpDeps {
  stateDir: string;
  sessionsRoot: string;
  orchestratorSid: string;
  registry: RegistryPort;
  telepty: TeleptyPort;
  clock: ClockPort;
  /** true alive, false ESRCH, null unknown. */
  pidAlive(pid: number): boolean | null;
  policy: PumpPolicy;
}

export interface PumpOptions {
  sid?: string;
  captureOnly?: boolean;
}

export interface PumpResult {
  /** false = the pass itself failed (registry unreadable). */
  ok: boolean;
  rows: number;
  captured: number;
  /** Complete items, or sealed chains, that could not be captured. */
  captureFailed: number;
  notices: number;
  legacyMarked: number;
  /** Per dispatch_id error codes ("*" = the pass). */
  errors: Record<string, string[]>;
  /** #1136: refused TURN status files per dispatch_id (status_ignored; not an error). */
  ignored: Record<string, string[]>;
  /** #1136: highest `_unbound` TURN seq handled this pass, per attempt. */
  unboundSeen: Record<string, number>;
  lines: string[];
}

export interface PumpHealth {
  v: 1;
  last_pass_at: string | null;
  last_ok_at: string | null;
  consecutive_failures: number;
  degraded_noticed: boolean;
  last_error: string | null;
  errors: Record<string, string[]>;
  anomalies: string[];
  /** #1136: refused TURN files from the last full pass (visible, not degrading). */
  ignored?: Record<string, string[]>;
  /** #1136: durable dedup of unbound-turn notices: attempt → highest seq handled (≤256). */
  unbound_seen?: Record<string, number>;
}

export interface CaptureSummary {
  ok: boolean;
  records: number;
  captured: number;
  failed: number;
  errors: string[];
}

export interface AckRequest {
  dispatchId: string;
  item: string;
  sha256: string;
  verdict: string;
  byClaimed: string | null;
}

export interface StatusRecord {
  dispatch_id: string;
  sid: string;
  attempt: string | null;
  request_id: string | null;
  resolution: string;
  lifecycle: string;
  current_final: string | null;
  pending: string[];
  items: Array<Record<string, unknown>>;
  failures: Array<Record<string, unknown>>;
  legacy: Record<string, unknown> | null;
  history_dropped: number;
}

export interface ReportStatusDoc {
  v: 1;
  generated_at: string;
  degraded: boolean;
  degraded_reasons: string[];
  health: PumpHealth | null;
  records: StatusRecord[];
  records_truncated: number;
  completion_fact: null;
}

// ── small helpers ────────────────────────────────────────────────────────────
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + "Z";

function addError(res: PumpResult, key: string, code: string): void {
  const list = (res.errors[key] ??= []);
  if (list.length < 8 && !list.includes(code)) list.push(code);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** No inject starts unless it can finish (its timeout) before the pass deadline. */
function injectFits(): boolean {
  return performance.now() + INJECT_TIMEOUT_MS <= passDeadline;
}

function injectAllowed(res: PumpResult): boolean {
  if (injectFits()) return true;
  addError(res, "*", "pass_deadline");
  return false;
}

/**
 * Whether a pending claim's owner may still be sending. false only when provably gone:
 * same host token and the pid is ESRCH. Pid reuse or another host/pid namespace reads as
 * alive — a held (delayed) re-notice, never a duplicate while the first may be in flight.
 */
function ownerMayBeSending(owner: string, deps: PumpDeps): boolean {
  const m = /^([0-9]{1,10})@(.+)$/.exec(owner);
  if (!m || m[2] !== OWNER_HOST) return true;
  return deps.pidAlive(Number(m[1])) !== false;
}

function liveClaimOwners(rep: ReportState, deps: PumpDeps): string[] {
  return [...new Set(Object.values(rep.claim_owners ?? {}))].filter((o) => ownerMayBeSending(o, deps));
}

/** The registry's named `result` (its JSON stdout), or null. */
function registryResult(stdout: string): string | null {
  try {
    const v: unknown = JSON.parse(stdout);
    return isRecord(v) && typeof v.result === "string" ? v.result : null;
  } catch {
    return null;
  }
}

/** report-list JSONL → rows. Empty output is zero rows; a malformed line fails the whole read. */
export function parseReportRows(stdout: string): ReportRow[] | null {
  const rows: ReportRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { return null; }
    if (!isRecord(v) || typeof v.dispatch_id !== "string" || typeof v.sid !== "string" ||
        (v.report !== null && !isRecord(v.report))) return null;
    rows.push(v as unknown as ReportRow);
  }
  return rows;
}

/** The submit outcome from telepty's stdout markers; anything unmatched is `unknown`. */
export function submitOutcome(r: InjectResult): SubmitOutcome {
  if (r.rc === null) return "unknown";
  if (r.rc !== 0) return "failed";
  if (r.stdout.includes("QUEUED, NOT consumed")) return "queued";
  if (r.stdout.includes("— consumed as a new turn.")) return "consumed";
  if (r.stdout.includes("consumption=unknown")) return "unknown";
  if (r.stdout.includes("Submit gated-timeout")) return "gate_timeout";
  if ((r.stdout + r.stderr).includes("Submit failed")) return "failed";
  return "unknown";
}

/**
 * The record's host-authored destination: from_sid, else the orchestrator sid. It
 * must be a plain local sid, not the worker, and present on the LOCAL daemon now.
 */
export function resolveDestination(fromSid: string, orchestratorSid: string, workerSid: string,
  listing: TeleptySession[] | null): Destination {
  const dest = fromSid || orchestratorSid || "orchestrator";
  if (!SID_RE.test(dest)) return { ok: false, reason: "destination_invalid_format" };
  if (dest === workerSid) return { ok: false, reason: "destination_is_worker" };
  if (listing === null) return { ok: false, reason: "destination_unknown" };
  const local = listing.some((s) => s.id === dest && (s.host === undefined || s.host === "127.0.0.1" || s.host === "localhost"));
  return local ? { ok: true, dest } : { ok: false, reason: "destination_absent" };
}

export function teleptyChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { HOME: os.userInfo().homedir };
  for (const k of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM"])
    if (base[k] !== undefined) e[k] = base[k];
  if (base.TELEPTY_PORT !== undefined) e.TELEPTY_PORT = String(validatedTeleptyPort(base.TELEPTY_PORT));
  return e;
}

// ── default (real) ports ─────────────────────────────────────────────────────
export function defaultRegistryPort(script: string): RegistryPort {
  const run = (args: string[]): ProcessResult => {
    const inv = registryInvocation(script, args, process.platform);
    const r = spawnSync(inv.cmd, inv.args, { encoding: "utf8", env: registryEnvironment(), shell: false,
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    if (r.error) return { status: 127, stdout: "" };
    return { status: r.status ?? 9, stdout: r.stdout ?? "" };
  };
  return { list: (a) => run(["report-list", ...a]), event: (a) => run(["report-event", ...a]) };
}

export function defaultTeleptyPort(bin: string): TeleptyPort {
  const run = (args: string[], timeout: number) =>
    (process.platform === "win32" ? crossSpawn.sync : spawnSync)(bin, args, { encoding: "utf8",
      env: teleptyChildEnv(), stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 16 * 1024 * 1024 });
  return {
    list() {
      const r = run(["list", "--json"], 30_000);
      if (r.error || r.status !== 0) return null;
      try {
        const v: unknown = JSON.parse(String(r.stdout ?? ""));
        return Array.isArray(v) ? v.filter((s): s is TeleptySession => isRecord(s) && typeof s.id === "string") : null;
      } catch {
        return null;
      }
    },
    inject(dest, text) {
      const r = run(["inject", "--submit", "--no-submit-force", "--submit-retry", "2", "--from", BROKER_SID, dest, text],
        INJECT_TIMEOUT_MS);
      const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      const rc = r.error && !timedOut ? 127 : r.status;
      return { rc, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
    },
    injects(dest, sinceIso) {
      const r = run(["injects", "--json", "--to", dest, "--since", sinceIso, "--limit", "200"], 30_000);
      if (r.error || r.status !== 0) return null;
      try {
        const v: unknown = JSON.parse(String(r.stdout ?? ""));
        return isRecord(v) && Array.isArray(v.injects)
          ? v.injects.filter((x): x is InjectAuditRow => isRecord(x) && typeof x.inject_id === "string") : null;
      } catch {
        return null;
      }
    },
  };
}

export function defaultPidAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? false : code === "EPERM" ? true : null;
  }
}

export interface DefaultDepsConfig {
  stateDir: string;
  registryScript: string;
  telepty: string;
  orchestratorSid: string;
  /** TRACKER_NOW-style fixed clock; "" = real time. */
  nowIso: string;
}

export function defaultPumpDeps(c: DefaultDepsConfig): PumpDeps {
  const fixed = c.nowIso ? Date.parse(c.nowIso) : NaN;
  return {
    stateDir: c.stateDir,
    sessionsRoot: defaultPathConfig().sessionsRoot,
    orchestratorSid: c.orchestratorSid,
    registry: defaultRegistryPort(c.registryScript),
    telepty: defaultTeleptyPort(c.telepty),
    clock: { nowMs: () => (Number.isFinite(fixed) ? fixed : Date.now()) },
    pidAlive: defaultPidAlive,
    policy: DEFAULT_POLICY,
  };
}

// ── S1 locate: the attempt pinned at dispatch, never sandbox-current ─────────
type Chain =
  | { ok: true; task: string; attempt: string; root: string; manifestSha: string; receipt: string; hookAnomaly: string | null }
  | { ok: false; code: string; missing: boolean };

function locate(row: ReportRow, deps: PumpDeps): Chain {
  if (!SID_RE.test(row.sid)) return { ok: false, code: "chain_bad_sid", missing: false };
  if (!row.attempt || !row.manifest_sha256) return { ok: false, code: "chain_unbound", missing: false };
  if (!REQUEST_ID_RE.test(row.attempt) || !HEX64_RE.test(row.manifest_sha256)) {
    return { ok: false, code: "chain_bad_binding", missing: false };
  }
  if (process.platform === "win32") return { ok: false, code: "anchored_read_unsupported", missing: false };
  let stage: string;
  try {
    stage = fs.realpathSync(path.join(deps.sessionsRoot, row.sid));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    return { ok: false, code: missing ? "chain_missing" : "chain_unreadable", missing };
  }
  const root = path.join(stage, "sandbox", row.attempt);
  if (!fs.existsSync(root)) return { ok: false, code: "chain_missing", missing: true };
  let sealed: ReturnType<typeof readSealedManifest>;
  try {
    sealed = readSealedManifest(path.join(root, "manifest.json"), row.manifest_sha256);
  } catch (e) {
    return { ok: false, code: `chain_${String((e as Error).message).split(":")[0]!.toLowerCase()}`, missing: false };
  }
  const m = sealed.m;
  const home = m.env?.HOME;
  if (sealed.root !== root) return { ok: false, code: "chain_root_invalid", missing: false };
  if (m.sid !== row.sid || m.attempt !== row.attempt) return { ok: false, code: "chain_identity", missing: false };
  if (typeof home !== "string" || home !== path.join(sealed.root, "home") ||
      m.env.AIGENTRY_REPORT_OUTBOX !== path.join(home, "report-outbox")) {
    return { ok: false, code: "chain_outbox_binding", missing: false };
  }
  // #1136: the staged hook must still be the sealed bytes (anomaly only; it is not authority).
  let hookAnomaly: string | null = null;
  if (m.reportHook) {
    try {
      const bytes = readPrivate(m.reportHook.path, 1024 * 1024);
      if (m.reportHook.path !== path.join(sealed.root, "report-hook", "turn-hook.mjs") ||
          createHash("sha256").update(bytes).digest("hex") !== m.reportHook.sha256) hookAnomaly = "hook_sha_mismatch";
    } catch {
      hookAnomaly = "hook_sha_mismatch";
    }
  }
  return { ok: true, task: m.task, attempt: m.attempt, root, manifestSha: row.manifest_sha256, receipt: m.receipt, hookAnomaly };
}

function readReceipt(file: string, deps: PumpDeps, attempt: string, hash: string):
  { receipt: ScanResult["receipt"]; pidsAlive: boolean | null } {
  try {
    const r: unknown = strictJson(readPrivate(file, 4096));
    if (!isRecord(r)) return { receipt: "unknown", pidsAlive: null };
    const keys = Object.keys(r).sort().join(",");
    if (r.state === "exited") return keys === "attempt,code,state" && r.attempt === attempt &&
      Number.isSafeInteger(r.code) ? { receipt: "exited", pidsAlive: null } : { receipt: "unknown", pidsAlive: null };
    if (r.state !== "running") return { receipt: "unknown", pidsAlive: null };
    if (keys !== "attempt,checkedAt,childPid,hash,state,supervisorPid" || r.attempt !== attempt ||
        r.hash !== hash || typeof r.checkedAt !== "string") return { receipt: "unknown", pidsAlive: null };
    const pids = [r.supervisorPid, r.childPid].filter((p): p is number => typeof p === "number" && Number.isSafeInteger(p) && p > 1);
    if (pids.length !== 2) return { receipt: "running", pidsAlive: null };
    const alive = pids.map((p) => deps.pidAlive(p));
    return { receipt: "running", pidsAlive: alive.includes(true) ? true : alive.includes(null) ? null : false };
  } catch {
    return { receipt: "unknown", pidsAlive: null };
  }
}

// ── S2 scan ──────────────────────────────────────────────────────────────────
function scanOutbox(row: ReportRow, chain: Extract<Chain, { ok: true }>, res: PumpResult):
  { items: ScannedItem[]; invalid: InvalidItem[]; markers: string[] } {
  const rep = row.report!;
  const listing = scanAnchoredOutbox(chain.root, chain.manifestSha, row.sid, chain.attempt, rep.request_id!);
  if (listing.status === "refused") {
    addError(res, row.dispatch_id, listing.error);
    // An incomplete or untrusted directory listing cannot prove every complete
    // item was captured. Cleanup must preserve the attempt for a later retry.
    res.captureFailed += 1;
  }
  const items: ScannedItem[] = [];
  const invalid: InvalidItem[] = [];
  for (const e of listing.entries) {
    if (e.refusalCode || !e.bytes) {
      const code = e.refusalCode ?? "helper_protocol_invalid";
      if (code === "io_error" || code === "race" || code === "helper_protocol_invalid") res.captureFailed += 1;
      invalid.push({ name: e.name, code });
      continue;
    }
    const p = parseItem(e.bytes, { requestId: rep.request_id!, challengeSha256: rep.challenge_sha256 ?? "", kind: e.kind, seq: e.seq });
    if (e.kind === "TURN") {
      // #1136: a refused TURN is status_ignored — visible, never a failure notice, never captured.
      const t = p.ok ? parseTurnFields(p.item.body) : null;
      if (!p.ok && p.error === "incomplete") continue;
      if (!p.ok || !t) {
        const list = (res.ignored[row.dispatch_id] ??= []);
        if (list.length < 8) list.push(`${e.name}:${p.ok ? "bad_fields" : p.error}`);
        continue;
      }
      items.push({ key: p.item.key, kind: "TURN", seq: p.item.seq, sha256: p.item.sha256, bytes: p.item.bytes, raw: e.bytes,
        turn: { end: t.end, assoc: t.assoc, error: t.error, newFormal: t.after.filter((x) => !t.before.includes(x)) } });
      continue;
    }
    if (!p.ok) {
      if (p.error !== "incomplete") invalid.push({ name: e.name, code: p.error });
      continue;
    }
    items.push({ key: p.item.key, kind: p.item.kind, seq: p.item.seq, sha256: p.item.sha256, bytes: p.item.bytes, raw: e.bytes });
  }
  for (const i of invalid) addError(res, row.dispatch_id, `item_${i.code}`);
  return { items, invalid, markers: listing.markers };
}

/** The worker body of a captured item, re-read from the controller inbox and re-verified. */
function inboxBody(row: ReportRow, key: string, sha256: string, inbox: string, deps: PumpDeps): SanitizedBody | null {
  const root = path.resolve(deps.stateDir, "inbox", "reports") + path.sep;
  const rep = row.report!;
  if (!path.resolve(inbox).startsWith(root) || !ITEM_KEY_RE.test(key)) return null;
  try {
    const bytes = fs.readFileSync(inbox);
    const [kind, seq] = key.split("-") as [ItemKind, string];
    const p = parseItem(bytes, { requestId: rep.request_id!, challengeSha256: rep.challenge_sha256 ?? "", kind, seq: Number(seq) });
    return p.ok && p.item.sha256 === sha256 ? sanitizeBody(p.item.body) : null;
  } catch {
    return null;
  }
}

// ── S3 notify (claim → send → result) ────────────────────────────────────────
interface CapturedNow {
  sha256: string;
  bytes: number;
  inbox: string;
  end?: string;
  assoc?: string;
  error?: string | null;
}

function sendNotice(row: ReportRow, chain: Chain, subject: string, expectN: number, dest: string,
  captured: Record<string, CapturedNow>, deps: PumpDeps, res: PumpResult): void {
  const rep = row.report!;
  const nowMs = deps.clock.nowMs();
  const at = iso(nowMs);
  const n = expectN + 1;
  const base = { task: chain.ok ? chain.task : "-", sid: row.sid, attempt: row.attempt ?? "-",
    dispatch_id: row.dispatch_id, request_id: rep.request_id ?? "-", item: subject, n, successor: row.superseded_by };
  let header: NoticeHeader;
  let body: SanitizedBody | null = null;
  if (subject.startsWith("failure-")) {
    const f = rep.failures.find((x) => `failure-${x.n}` === subject);
    if (!f) return;
    header = { ...base, subject: "FAILURE", sha256: f.subject_sha256, bytes: null, inbox: null,
      event: f.event, detail: f.detail, verdicts: ["seen"] };
  } else {
    const it: CapturedNow | undefined = rep.items[subject] ?? captured[subject];
    if (!it) return;
    const kind = subject.startsWith("REPORT-") ? "REPORT" : subject.startsWith("TURN-") ? "TURN" : "HOLD";
    body = inboxBody(row, subject, it.sha256, it.inbox, deps);
    header = { ...base, subject: kind, sha256: it.sha256, bytes: it.bytes, inbox: it.inbox, event: null, detail: null,
      verdicts: kind === "REPORT" ? ["accepted", "rework", "rejected"] : kind === "TURN" ? ["seen"] : ["answered", "rejected"],
      ...(kind === "TURN" ? { turn: { end: it.end ?? "-", assoc: it.assoc ?? "unknown", error: it.error ?? null } } : {}) };
  }
  const ev = (phase: string, expect: number, fields: string[]): ProcessResult => deps.registry.event([
    "--dispatch-id", row.dispatch_id, "--kind", "notice", "--item", subject, "--expect-n", String(expect),
    "--field", `phase=${phase}`, ...fields.flatMap((f) => ["--field", f]), "--now", at]);
  if (!injectAllowed(res)) return; // not claimed: due again next pass
  const claim = ev("claim", expectN, [`dest=${dest}`, `next_at=${iso(nextNoticeAtMs(n, "pending", nowMs, deps.policy))}`,
    `owner=${PUMP_OWNER}`]);
  if (claim.status !== 0) {
    if (claim.status !== 8) addError(res, row.dispatch_id, `notice_claim_${claim.status}`);
    return;
  }
  const r = deps.telepty.inject(dest, renderNotice(header, body));
  const injectId = parseInjectId(r.stdout);
  const submit = submitOutcome(r);
  const done = ev("result", n, [`rc=${r.rc ?? -1}`, `inject_id=${injectId}`, `submit=${submit}`,
    `next_at=${iso(nextNoticeAtMs(n, submit, nowMs, deps.policy))}`]);
  if (done.status !== 0) addError(res, row.dispatch_id, `notice_result_${done.status}`);
  res.notices += 1;
  res.lines.push(`REPORT_NOTICE dispatch_id=${row.dispatch_id} sid=${row.sid} item=${subject} n=${n} ` +
    `submit=${submit} inject_id=${injectId || "null"}`);
}

/** F3: an expired claim whose owner may still be sending → its result is `unknown`, held; nothing is sent. */
function holdClaim(row: ReportRow, subject: string, n: number, deps: PumpDeps, res: PumpResult): void {
  const nowMs = deps.clock.nowMs();
  const ev = deps.registry.event(["--dispatch-id", row.dispatch_id, "--kind", "notice", "--item", subject,
    "--expect-n", String(n), "--field", "phase=result", "--field", "rc=-1", "--field", "inject_id=",
    "--field", "submit=unknown", "--field", `next_at=${iso(heldNoticeAtMs(n, nowMs, deps.policy))}`, "--now", iso(nowMs)]);
  if (ev.status === 0) {
    res.lines.push(`REPORT_NOTICE_HELD dispatch_id=${row.dispatch_id} sid=${row.sid} item=${subject} n=${n} ` +
      "submit=unknown reason=claim_in_flight");
  } else if (ev.status !== 8) {
    addError(res, row.dispatch_id, `notice_held_${ev.status}`);
  }
}

// ── one record ───────────────────────────────────────────────────────────────
function processRecord(row: ReportRow, deps: PumpDeps, policy: PumpPolicy, res: PumpResult,
  listing: () => TeleptySession[] | null, injectsCache: Map<string, InjectAuditRow[] | null>):
  { chain: Chain; destination: Destination } | null {
  const nowMs = deps.clock.nowMs();
  const at = iso(nowMs);
  const did = row.dispatch_id;
  if (!DISPATCH_ID_RE.test(did)) {
    addError(res, did, "bad_dispatch_id");
    return null;
  }
  const chain = locate(row, deps);
  let items: ScannedItem[] = [];
  let invalid: InvalidItem[] = [];
  let receipt: ScanResult["receipt"] = "unknown";
  let pidsAlive: boolean | null = null;
  let hookDegraded: string[] = [];
  if (chain.ok) {
    ({ items, invalid, markers: hookDegraded } = scanOutbox(row, chain, res));
    ({ receipt, pidsAlive } = readReceipt(chain.receipt, deps, row.attempt!, row.manifest_sha256!));
    if (chain.hookAnomaly) addError(res, did, chain.hookAnomaly);
  } else {
    addError(res, did, chain.code);
    // A missing pinned attempt is also an unverified capture during cleanup.
    res.captureFailed += 1;
  }
  let destination: Destination = { ok: false, reason: "capture_only" };
  let presence: ScanResult["presence"] = "unknown";
  const observed: Record<string, InjectObservation> = {};
  if (!policy.captureOnly) {
    const sessions = listing();
    destination = resolveDestination(row.from_sid, deps.orchestratorSid, row.sid, sessions);
    // An absence only counts when the listing is trustworthy, i.e. it shows the destination.
    if (sessions !== null) presence = sessions.some((s) => s.id === row.sid) ? "present" : destination.ok ? "absent" : "unknown";
    const pending = pendingObservations(row);
    if (pending.length && destination.ok) {
      const notices = [...Object.values(row.report!.items).map((i) => i.notice), ...row.report!.failures.map((f) => f.notice)];
      const since = notices.filter((x) => x?.inject_id && pending.includes(x.inject_id))
        .map((x) => x!.last_at ?? "").filter(Boolean).sort()[0] ?? at;
      const cacheKey = `${destination.dest}\u0000${since}`;
      if (!injectsCache.has(cacheKey)) injectsCache.set(cacheKey, deps.telepty.injects(destination.dest, since));
      for (const a of injectsCache.get(cacheKey) ?? []) {
        if (pending.includes(a.inject_id) && typeof a.delivery_result === "string") {
          observed[a.inject_id] = { delivery_result: a.delivery_result, verified_sender: a.verified_sender_sid ?? null };
        }
      }
    }
  }
  const owners = policy.captureOnly ? [] : liveClaimOwners(row.report!, deps);
  const scan: ScanResult = { items, invalid, receipt, pidsAlive, presence, destination, observed, hookDegraded,
    liveClaimOwners: owners };
  const captured: Record<string, CapturedNow> = {};
  const failedKeys = new Set<string>();
  for (const a of decide(row, scan, nowMs, policy)) {
    if (a.type === "capture") {
      const { key, sha256, bytes, raw, turn } = a.item;
      let inbox: string;
      try {
        inbox = writeInboxCopy(deps.stateDir, did, key, sha256, raw);
      } catch {
        res.captureFailed += 1;
        failedKeys.add(key);
        addError(res, did, "inbox_write_failed");
        continue;
      }
      const turnFields = turn ? ["--field", `end=${turn.end}`, "--field", `assoc=${turn.assoc}`,
        "--field", `turn_error=${turn.error ?? ""}`, "--field", `new_formal=${turn.newFormal.join(",")}`] : [];
      const ev = deps.registry.event(["--dispatch-id", did, "--kind", "captured", "--item", key, "--sha256", sha256,
        "--field", `bytes=${bytes}`, "--field", `inbox=${inbox}`, ...turnFields, "--now", at]);
      if (ev.status === 0 || ev.status === 8) {
        captured[key] = { sha256, bytes, inbox, ...(turn ? { end: turn.end, assoc: turn.assoc, error: turn.error } : {}) };
        if (ev.status === 0) {
          res.captured += 1;
          res.lines.push(`REPORT_CAPTURED dispatch_id=${did} sid=${row.sid} item=${key} sha256=${sha256} inbox=${inbox}`);
        }
      } else if (ev.status === 4 && turn && registryResult(ev.stdout) === "turn_fields_invalid") {
        // F1a: worker-authored TURN fields the registry refuses (e.g. a forged `<uuid>/REPORT-n`):
        // status_ignored — visible, never captured or noticed, and not a capture failure.
        failedKeys.add(key);
        const list = (res.ignored[did] ??= []);
        if (list.length < 8) list.push(`${key}.md:registry_bad_fields`);
      } else {
        res.captureFailed += 1;
        failedKeys.add(key);
        addError(res, did, `capture_event_${ev.status}`);
      }
    } else if (a.type === "failure") {
      const ev = deps.registry.event(["--dispatch-id", did, "--kind", "failure", "--item", a.event,
        "--field", `stage=${a.stage}`, "--field", `detail=${a.detail}`, ...(a.key ? ["--field", `key=${a.key}`] : []),
        "--now", at]);
      if (ev.status !== 0 && ev.status !== 8) addError(res, did, `failure_event_${ev.status}`);
      else if (ev.status === 0 && a.stage === "confirm") res.lines.push(`REPORT_FAILURE dispatch_id=${did} sid=${row.sid} event=${a.event}`);
    } else if (a.type === "notice") {
      if (failedKeys.has(a.subject) || !destination.ok) continue;
      sendNotice(row, chain, a.subject, a.expectN, destination.dest, captured, deps, res);
    } else if (a.type === "held") {
      holdClaim(row, a.subject, a.expectN, deps, res);
    } else if (a.type === "observe") {
      const ev = deps.registry.event(["--dispatch-id", did, "--kind", "observed", "--item", a.subject,
        "--field", `inject_id=${a.injectId}`, "--field", `delivery_result=${a.deliveryResult}`,
        "--field", `verified_sender=${a.verifiedSender ?? ""}`, "--now", at]);
      if (ev.status !== 0 && ev.status !== 8) addError(res, did, `observe_event_${ev.status}`);
      if (a.verifiedSender) addError(res, did, "verified_sender_anomaly");
    } else {
      addError(res, did, a.reason);
    }
  }
  return { chain, destination };
}

// ── #1136 unbound turns: one informational notice per attempt turn, durably deduplicated ──
interface AttemptGroup {
  sid: string;
  attempt: string;
  root: string;
  manifestSha: string;
  destination: Destination;
  openRequests: string[];
}

/** Newest unhandled TURN; an incomplete item is still retried by processUnbound. */
export function selectUnboundTurn(entries: readonly AnchoredEntry[], seen: number): AnchoredEntry | undefined {
  return entries.filter((e) => e.kind === "TURN" && e.seq > seen).sort((a, b) => b.seq - a.seq)[0];
}

function processUnbound(g: AttemptGroup, seen: number, deps: PumpDeps, res: PumpResult): void {
  const listing = scanAnchoredOutbox(g.root, g.manifestSha, g.sid, g.attempt, UNBOUND_DIR);
  const key = `${g.sid}/${g.attempt}`;
  if (listing.status === "refused") {
    addError(res, key, listing.error);
    res.captureFailed += 1;
    return;
  }
  const newest = selectUnboundTurn(listing.entries, seen);
  if (!newest) return;
  const p = newest.bytes ? parseItem(newest.bytes, { requestId: "unbound", challengeSha256: "", kind: "TURN", seq: newest.seq, unbound: true }) : null;
  if (p && !p.ok && p.error === "incomplete") return; // re-checked next pass
  const t = p && p.ok ? parseTurnFields(p.item.body) : null;
  if (!t) {
    const list = (res.ignored[key] ??= []);
    if (list.length < 8) list.push(`${UNBOUND_DIR}/${newest.name}:${newest.bytes ? (p && !p.ok ? p.error : "bad_fields") : newest.refusalCode}`);
    if (newest.refusalCode === "io_error" || newest.refusalCode === "race") res.captureFailed += 1;
    res.unboundSeen[g.attempt] = newest.seq;
    return;
  }
  // A new formal item anywhere in the attempt during that turn: nothing to say.
  const silent = t.after.length !== t.before.length || t.after.some((x) => !t.before.includes(x));
  if (!silent) {
    if (!g.destination.ok) {
      addError(res, key, `unbound_${g.destination.reason}`);
      return; // not marked seen: retried next pass
    }
    if (!injectAllowed(res)) return; // not marked seen: retried next pass
    // F3: durably seen BEFORE the send — a pass killed mid-send never repeats the "once" notice.
    if (!persistUnboundSeen(deps.stateDir, g.attempt, newest.seq)) {
      addError(res, key, "unbound_seen_write_failed");
      return;
    }
    const inj = deps.telepty.inject(g.destination.dest, renderUnboundTurnNotice({ sid: g.sid, attempt: g.attempt,
      item: newest.name.slice(0, -3), end: t.end, assoc: t.assoc, open_requests: g.openRequests }));
    res.notices += 1;
    res.lines.push(`REPORT_TURN_UNBOUND sid=${g.sid} attempt=${g.attempt} item=${newest.name.slice(0, -3)} ` +
      `submit=${submitOutcome(inj)} inject_id=${parseInjectId(inj.stdout) || "null"}`);
  }
  res.unboundSeen[g.attempt] = newest.seq;
}

// ── legacy: bounded mark, deduplicated digest with durable backoff ───────────
function sendLegacyDigest(due: Array<{ row: ReportRow; expectN: number }>, deps: PumpDeps, res: PumpResult,
  listing: () => TeleptySession[] | null): void {
  const destination = resolveDestination("", deps.orchestratorSid, "", listing());
  if (!destination.ok) {
    addError(res, "legacy", destination.reason);
    return;
  }
  const nowMs = deps.clock.nowMs();
  const at = iso(nowMs);
  const ev = (row: ReportRow, phase: string, expect: number, fields: string[]): ProcessResult => deps.registry.event([
    "--dispatch-id", row.dispatch_id, "--kind", "notice", "--item", "legacy", "--expect-n", String(expect),
    "--field", `phase=${phase}`, ...fields.flatMap((f) => ["--field", f]), "--now", at]);
  if (!injectAllowed(res)) return; // nothing claimed: due again next pass
  const claimed: Array<{ row: ReportRow; n: number }> = [];
  for (const d of due) {
    const n = d.expectN + 1;
    const c = ev(d.row, "claim", d.expectN, [`dest=${destination.dest}`, `next_at=${iso(nextNoticeAtMs(n, "pending", nowMs, deps.policy))}`,
      `owner=${PUMP_OWNER}`]);
    if (c.status === 0) claimed.push({ row: d.row, n });
    else if (c.status !== 8) addError(res, d.row.dispatch_id, `notice_claim_${c.status}`);
  }
  if (!claimed.length) return;
  const entries: LegacyDigestEntry[] = claimed.map(({ row, n }) => ({ dispatch_id: row.dispatch_id, sid: row.sid,
    lifecycle: row.lifecycle, dispatched_at: row.dispatched_at, subject_sha256: row.report!.legacy!.subject_sha256, n }));
  const r = deps.telepty.inject(destination.dest, renderLegacyDigest(entries));
  const injectId = parseInjectId(r.stdout);
  const submit = submitOutcome(r);
  for (const { row, n } of claimed) {
    const done = ev(row, "result", n, [`rc=${r.rc ?? -1}`, `inject_id=${injectId}`, `submit=${submit}`,
      `next_at=${iso(nextNoticeAtMs(n, submit, nowMs, deps.policy))}`]);
    if (done.status !== 0) addError(res, row.dispatch_id, `notice_result_${done.status}`);
  }
  res.notices += 1;
  res.lines.push(`REPORT_LEGACY_NOTICE records=${claimed.length} submit=${submit} inject_id=${injectId || "null"}`);
}

// ── health ───────────────────────────────────────────────────────────────────
export function readHealth(stateDir: string): PumpHealth | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(path.join(stateDir, HEALTH_FILE), "utf8"));
    return isRecord(v) && v.v === 1 ? (v as unknown as PumpHealth) : null;
  } catch {
    return null;
  }
}

function writeHealth(stateDir: string, h: PumpHealth): void {
  const file = path.join(stateDir, HEALTH_FILE);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.mkdirSync(stateDir, { recursive: true });
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(h, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** F3: `unbound_seen[attempt] = seq`, durable before the unbound notice is sent. */
function persistUnboundSeen(stateDir: string, attempt: string, seq: number): boolean {
  const prev = readHealth(stateDir);
  const h: PumpHealth = prev ?? { v: 1, last_pass_at: null, last_ok_at: null, consecutive_failures: 0,
    degraded_noticed: false, last_error: null, errors: {}, anomalies: [] };
  const seen = { ...(h.unbound_seen ?? {}) };
  delete seen[attempt];
  seen[attempt] = seq;
  const keys = Object.keys(seen);
  for (const k of keys.slice(0, Math.max(0, keys.length - UNBOUND_SEEN_MAX))) delete seen[k];
  try {
    writeHealth(stateDir, { ...h, unbound_seen: seen });
    return true;
  } catch {
    return false;
  }
}

function finishHealth(deps: PumpDeps, res: PumpResult, listing: () => TeleptySession[] | null): void {
  const at = iso(deps.clock.nowMs());
  const prev = readHealth(deps.stateDir);
  const h: PumpHealth = { v: 1, last_pass_at: at, last_ok_at: prev?.last_ok_at ?? null,
    consecutive_failures: prev?.consecutive_failures ?? 0, degraded_noticed: prev?.degraded_noticed ?? false,
    last_error: null, errors: {}, anomalies: [], ignored: {}, unbound_seen: { ...(prev?.unbound_seen ?? {}) } };
  if (res.ok) {
    h.last_ok_at = at;
    h.consecutive_failures = 0;
    h.degraded_noticed = false;
  } else {
    h.consecutive_failures += 1;
    h.last_error = res.errors["*"]?.[0] ?? "pass_failed";
  }
  for (const [k, v] of Object.entries(res.errors).slice(0, STATUS_RECORDS_MAX)) h.errors[k] = v;
  for (const [k, v] of Object.entries(res.ignored).slice(0, STATUS_RECORDS_MAX)) h.ignored![k] = v;
  for (const [k, v] of Object.entries(res.unboundSeen)) {
    delete h.unbound_seen![k];
    h.unbound_seen![k] = v;
  }
  const keys = Object.keys(h.unbound_seen!);
  for (const k of keys.slice(0, Math.max(0, keys.length - UNBOUND_SEEN_MAX))) delete h.unbound_seen![k];
  h.anomalies = Object.entries(res.errors).filter(([, v]) => v.includes("verified_sender_anomaly")).map(([k]) => k).slice(0, 20);
  if (h.consecutive_failures >= DEGRADED_AFTER_FAILED_PASSES && !h.degraded_noticed && injectFits()) {
    const destination = resolveDestination("", deps.orchestratorSid, "", listing());
    if (destination.ok) {
      const r = deps.telepty.inject(destination.dest, renderDegradedNotice(h.consecutive_failures, h.last_error ?? "pass_failed"));
      h.degraded_noticed = r.rc === 0;
      res.lines.push(`REPORT_PUMP_DEGRADED consecutive_failures=${h.consecutive_failures} notice_rc=${r.rc ?? "null"}`);
    }
  }
  try {
    writeHealth(deps.stateDir, h);
  } catch {
    addError(res, "*", "health_write_failed");
  }
}

// ── public entry points ──────────────────────────────────────────────────────
/** One pass over every record the registry lists. `sid` narrows it; `captureOnly` sends nothing. */
export function pumpOnce(deps: PumpDeps, opts: PumpOptions = {}): PumpResult {
  const res: PumpResult = { ok: true, rows: 0, captured: 0, captureFailed: 0, notices: 0, legacyMarked: 0, errors: {},
    ignored: {}, unboundSeen: {}, lines: [] };
  passDeadline = performance.now() + PASS_DEADLINE_MS;
  const policy: PumpPolicy = opts.captureOnly ? { ...deps.policy, captureOnly: true } : deps.policy;
  const full = !opts.sid && !policy.captureOnly;
  let sessions: TeleptySession[] | null | undefined;
  const listing = (): TeleptySession[] | null => (sessions === undefined ? (sessions = deps.telepty.list()) : sessions);
  const listed = deps.registry.list(opts.sid ? ["--sid", opts.sid] : []);
  const rows = listed.status === 0 ? parseReportRows(listed.stdout) : null;
  if (rows === null) {
    res.ok = false;
    addError(res, "*", listed.status === 0 ? "registry_rows_malformed" : `registry_list_${listed.status}`);
    if (full) finishHealth(deps, res, listing);
    return res;
  }
  res.rows = rows.length;
  const nowMs = deps.clock.nowMs();
  const injectsCache = new Map<string, InjectAuditRow[] | null>();
  const legacyDue: Array<{ row: ReportRow; expectN: number }> = [];
  const groups = new Map<string, AttemptGroup>();
  for (const row of rows) {
    // F3: past the deadline no further record is started (cleanup's capture-only pass is not cut short).
    if (!policy.captureOnly && performance.now() >= passDeadline) {
      addError(res, "*", "pass_deadline");
      break;
    }
    try {
      if (!row.report) {
        if (policy.captureOnly || res.legacyMarked >= LEGACY_MARK_PER_PASS || !DISPATCH_ID_RE.test(row.dispatch_id)) continue;
        const ev = deps.registry.event(["--dispatch-id", row.dispatch_id, "--kind", "legacy", "--item", "legacy", "--now", iso(nowMs)]);
        if (ev.status === 0) res.legacyMarked += 1;
        else if (ev.status !== 8) addError(res, row.dispatch_id, `legacy_event_${ev.status}`);
        continue;
      }
      if (row.report.request_id === null) {
        const n = policy.captureOnly ? null : legacyNoticeDue(row, nowMs);
        if (n !== null && claimHeld(row.report, "legacy", row.report.legacy?.notice, liveClaimOwners(row.report, deps))) {
          holdClaim(row, "legacy", n, deps, res);
        } else if (n !== null && legacyDue.length < LEGACY_DIGEST_MAX) legacyDue.push({ row, expectN: n });
        continue;
      }
      if (!inScanSet(row, nowMs, policy)) continue;
      const done = processRecord(row, deps, policy, res, listing, injectsCache);
      if (full && done?.chain.ok && (row.report.resolution === "open" || row.report.resolution === "rework_requested")) {
        const g = groups.get(done.chain.attempt) ?? { sid: row.sid, attempt: done.chain.attempt, root: done.chain.root,
          manifestSha: done.chain.manifestSha,
          destination: done.destination, openRequests: [] };
        g.openRequests.push(row.report.request_id);
        groups.set(done.chain.attempt, g);
      }
    } catch {
      addError(res, row.dispatch_id, "record_exception");
    }
  }
  if (legacyDue.length) sendLegacyDigest(legacyDue, deps, res, listing);
  if (full && groups.size) {
    const seen = readHealth(deps.stateDir)?.unbound_seen ?? {};
    for (const g of groups.values()) {
      try {
        processUnbound(g, seen[g.attempt] ?? 0, deps, res);
      } catch {
        addError(res, `${g.sid}/${g.attempt}`, "unbound_exception");
      }
    }
  }
  if (full) finishHealth(deps, res, listing);
  return res;
}

/** Cleanup's in-process capture: no notices, no failure detection, no telepty. */
export function captureForSid(sid: string, deps: PumpDeps): CaptureSummary {
  if (!SID_RE.test(sid)) return { ok: false, records: 0, captured: 0, failed: 1, errors: ["bad_sid"] };
  const r = pumpOnce(deps, { sid, captureOnly: true });
  const errors = Object.entries(r.errors).flatMap(([k, v]) => v.map((c) => `${k}:${c}`));
  const failed = r.captureFailed + (r.ok ? 0 : 1);
  return { ok: failed === 0, records: r.rows, captured: r.captured, failed, errors };
}

/** After a successful cleanup: every open obligation of the sid with no REPORT gets `cleaned`. */
export function recordCleaned(sid: string, deps: PumpDeps): number {
  if (!SID_RE.test(sid)) return 0;
  const listed = deps.registry.list(["--sid", sid]);
  const rows = listed.status === 0 ? parseReportRows(listed.stdout) : null;
  let n = 0;
  for (const row of rows ?? []) {
    const rep = row.report;
    if (!rep || !rep.request_id || rep.current_final || !inScanSet(row, deps.clock.nowMs(), deps.policy)) continue;
    const ev = deps.registry.event(["--dispatch-id", row.dispatch_id, "--kind", "failure", "--item", "cleaned",
      "--field", "stage=confirm", "--field", "detail=session cleanup with no REPORT captured",
      "--now", iso(deps.clock.nowMs())]);
    if (ev.status === 0) n += 1;
  }
  return n;
}

/** The review ACK. Returns the registry's status (0 ok, 4 stale/invalid, 8 same, 9 error). */
export function reportAck(req: AckRequest, deps: PumpDeps): ProcessResult {
  if (!DISPATCH_ID_RE.test(req.dispatchId) || !ACK_ITEM_RE.test(req.item) || !HEX64_RE.test(req.sha256) ||
      !VERDICT_RE.test(req.verdict) || (req.byClaimed !== null && !SID_RE.test(req.byClaimed))) {
    return { status: 4, stdout: JSON.stringify({ result: "invalid_argument", completion_fact: null }) + "\n" };
  }
  return deps.registry.event(["--dispatch-id", req.dispatchId, "--kind", "reviewed", "--item", req.item,
    "--sha256", req.sha256, "--field", `verdict=${req.verdict}`,
    ...(req.byClaimed ? ["--field", `by_claimed=${req.byClaimed}`] : []), "--now", iso(deps.clock.nowMs())]);
}

/** report-status: 0 healthy, 3 degraded, 9 registry unreadable. */
export function reportStatus(deps: PumpDeps): { code: number; doc: ReportStatusDoc | null } {
  const listed = deps.registry.list(["--all"]);
  const rows = listed.status === 0 ? parseReportRows(listed.stdout) : null;
  if (rows === null) return { code: 9, doc: null };
  const nowMs = deps.clock.nowMs();
  const health = readHealth(deps.stateDir);
  const records: StatusRecord[] = [];
  let open = 0;
  for (const row of rows) {
    const rep = row.report;
    if (!rep) continue;
    if (inScanSet(row, nowMs, deps.policy)) open += 1;
    const pending = [
      ...Object.entries(rep.items).filter(([, i]) => !i.review && !i.superseded_by).map(([k]) => k),
      ...rep.failures.filter((f) => !f.review).map((f) => `failure-${f.n}`),
      ...(rep.legacy && !rep.legacy.review ? ["legacy"] : []),
    ];
    records.push({ dispatch_id: row.dispatch_id, sid: row.sid, attempt: row.attempt, request_id: rep.request_id,
      resolution: rep.resolution, lifecycle: row.lifecycle, current_final: rep.current_final, pending,
      items: Object.entries(rep.items).map(([item, i]) => ({ item, ...i })),
      failures: rep.failures.map((f) => ({ item: `failure-${f.n}`, ...f })),
      legacy: rep.legacy ? { ...rep.legacy } : null, history_dropped: rep.history_dropped });
  }
  const reasons: string[] = [];
  if (open && !health) reasons.push("no_pump_pass");
  if (health && health.consecutive_failures > 0) reasons.push("pump_pass_failed");
  if (health && Object.keys(health.errors).length) reasons.push("record_errors");
  if (open && health?.last_pass_at && nowMs - Date.parse(health.last_pass_at) > STALE_PASS_MS) reasons.push("pump_stale");
  const doc: ReportStatusDoc = { v: 1, generated_at: iso(nowMs), degraded: reasons.length > 0, degraded_reasons: reasons,
    health, records: records.slice(0, STATUS_RECORDS_MAX), records_truncated: Math.max(0, records.length - STATUS_RECORDS_MAX),
    completion_fact: null };
  return { code: reasons.length ? 3 : 0, doc };
}
