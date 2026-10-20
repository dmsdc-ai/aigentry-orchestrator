import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { registryEnvironment, registryInvocation } from "../dispatch/registry-command.js";
import { listCaptureInventory, type CaptureInventory, type InventoryItem } from "./inventory.js";
import {
  applyIntakeNotice, derivePositions, emptyIntakeDocument, intakeNoticeId,
  INTAKE_ORDER_LABEL, validateIntakeDocument,
  type IntakeDocument, type IntakeNoticeEvent,
} from "./intake.js";

export const INTAKE_PUMP_LIMITS = { childMs: 10_000, passMs: 60_000,
  streamBytes: 1024 * 1024, imports: 100, notices: 10 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const SID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const matches = (v: unknown, re: RegExp): v is string =>
  typeof v === "string" && re.exec(v)?.[0] === v;
const hash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const seconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export interface ChildObservation {
  code: number | null;
  signal: string | null;
  error: string | null;
  spawned: boolean;
  timeout: boolean;
  overflow: boolean;
  stdout: string;
  stderr: string;
  stdout_eof: boolean;
  stderr_eof: boolean;
}

/** Direct child limits only. Wait for close/EOF; never claim descendant containment. */
export function boundedIntakeChild(command: string, args: string[], env: NodeJS.ProcessEnv,
  timeoutMs: number): Promise<ChildObservation> {
  return new Promise(resolve => {
    const result: ChildObservation = { code: null, signal: null, error: null, spawned: false,
      timeout: false, overflow: false, stdout: "", stderr: "", stdout_eof: false, stderr_eof: false };
    if (timeoutMs <= 0) { result.timeout = true; resolve(result); return; }
    const buffers: Buffer[][] = [[], []];
    const sizes = [0, 0];
    const child = spawn(command, args, { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    child.once("spawn", () => { result.spawned = true; });
    const timer = setTimeout(() => { result.timeout = true; child.kill("SIGKILL"); }, timeoutMs);
    [child.stdout, child.stderr].forEach((stream, i) => {
      stream.on("data", (bytes: Buffer) => {
        const remaining = Math.max(0, INTAKE_PUMP_LIMITS.streamBytes - sizes[i]!);
        if (remaining) buffers[i]!.push(bytes.subarray(0, remaining));
        sizes[i] = sizes[i]! + bytes.length;
        if (sizes[i]! > INTAKE_PUMP_LIMITS.streamBytes) {
          result.overflow = true;
          child.kill("SIGKILL");
        }
      });
      stream.once("end", () => { if (i === 0) result.stdout_eof = true; else result.stderr_eof = true; });
      stream.once("error", () => { result.error = "stream_error"; });
    });
    child.once("error", (error: NodeJS.ErrnoException) => { result.error = error.code ?? "spawn_error"; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      result.code = code;
      result.signal = signal;
      result.stdout = Buffer.concat(buffers[0]!).toString("utf8");
      result.stderr = Buffer.concat(buffers[1]!).toString("utf8");
      resolve(result);
    });
  });
}

export function intakeChildEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM",
    "TELEPTY_PORT", "DISPATCH_STATE_DIR", "AIGENTRY_SHIM_SCRIPT_DIR", "DISPATCH_REGISTRY_PY",
    "TELEPTY", "ORCHESTRATOR_SID"])
    if (base[key] !== undefined) env[key] = base[key];
  return env;
}

export interface IntakePumpPorts {
  inventory(root: string): Promise<CaptureInventory>;
  registry(args: string[], timeoutMs: number): Promise<ChildObservation>;
  send(destination: string, notice: string, timeoutMs: number): Promise<ChildObservation>;
  readStatus(): Promise<IntakeDocument | null>;
  monotonic(): number;
  now(): string;
  token(): string;
}

export interface IntakePumpConfig {
  stateDir: string;
  registryScript: string;
  telepty: string;
  destination: string;
  env: NodeJS.ProcessEnv;
}

/** Status avoids intake-list's error health-log writer, including on malformed data. */
export async function readIntakeStatusFile(stateDir: string): Promise<IntakeDocument | null> {
  let handle: fs.FileHandle | undefined;
  try {
    const filename = path.join(stateDir, "intake.json");
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.size > INTAKE_PUMP_LIMITS.streamBytes) return null;
    handle = await fs.open(filename, constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return null;
    const bytes = Buffer.alloc(INTAKE_PUMP_LIMITS.streamBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (count > INTAKE_PUMP_LIMITS.streamBytes || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return null;
    return checkedDocument(JSON.parse(bytes.subarray(0, count).toString("utf8")));
  } catch (error) {
    return !handle && (error as NodeJS.ErrnoException).code === "ENOENT" ? emptyIntakeDocument() : null;
  } finally {
    await handle?.close();
  }
}

export function defaultIntakePorts(config: IntakePumpConfig): IntakePumpPorts {
  const env = intakeChildEnvironment(config.env);
  return {
    inventory: root => listCaptureInventory(root, { limit: 1000 }),
    registry: (args, ms) => {
      const invocation = registryInvocation(config.registryScript, args, process.platform);
      return boundedIntakeChild(invocation.cmd, invocation.args,
        registryEnvironment({ ...env, DISPATCH_STATE_DIR: config.stateDir }), ms);
    },
    send: (destination, notice, ms) => boundedIntakeChild(config.telepty,
      ["inject", "--submit", "--no-submit-force", "--submit-retry", "0",
        "--from", "intake-pump", destination, notice], env, ms),
    readStatus: () => readIntakeStatusFile(config.stateDir),
    monotonic: () => performance.now(),
    now: () => seconds(Date.now()),
    token: () => randomUUID(),
  };
}

function observed(r: ChildObservation): boolean {
  return !r.error && !r.timeout && !r.overflow && !r.signal && r.stdout_eof && r.stderr_eof;
}

function jsonResult(r: ChildObservation): Record<string, unknown> | null {
  if (!observed(r)) return null;
  try { const value: unknown = JSON.parse(r.stdout); return object(value) ? value : null; }
  catch { return null; }
}

function checkedDocument(value: unknown): IntakeDocument | null {
  if (validateIntakeDocument(value).result !== "ok") return null;
  const doc = value as IntakeDocument;
  if (!Number.isSafeInteger(doc.generation) || doc.generation < 0 || doc.requests.length > 4096) return null;
  // Core validation deliberately checks only part of each row. Validate the fields this caller uses.
  for (const row of doc.requests) {
    if (!matches(row.capture_id, UUID) || !matches(row.sha256, HEX) ||
        !Number.isSafeInteger(row.byte_len) || row.byte_len < 0 ||
        typeof row.received_at !== "string" || !Number.isFinite(Date.parse(row.received_at)) ||
        !["unstarted", "in_progress", "paused", "completed", "failed", "cancelled"].includes(row.work_state) ||
        !(row.owning_task === null || typeof row.owning_task === "string") ||
        !row.bound_dispatch_ids.every(id => typeof id === "string") ||
        !["pause", "superseded_by", "result", "failure"].every(key => Object.hasOwn(row, key))) return null;
  }
  return doc;
}

async function refresh(ports: IntakePumpPorts, remaining: () => number): Promise<IntakeDocument | null> {
  const ms = remaining();
  if (!ms) return null;
  const result = await ports.registry(["intake-list"], ms);
  const value = jsonResult(result);
  if (result.code !== 0 || !value || value.order !== INTAKE_ORDER_LABEL ||
      !Array.isArray(value.requests) || value.count !== value.requests.length) return null;
  return checkedDocument(value);
}

function validItem(item: InventoryItem): boolean {
  return matches(item.ingress_id, UUID) && matches(item.capture_id, UUID) && matches(item.sha256, HEX) &&
    Number.isSafeInteger(item.byte_len) && item.byte_len >= 0 &&
    typeof item.received_at === "string" && Number.isFinite(Date.parse(item.received_at)) &&
    new Date(item.received_at).toISOString() === item.received_at &&
    item.durability === "file-and-directory-fsync" && item.upstream_id_status === "unavailable" &&
    item.upstream_delivery_id === null && item.upstream_scope_sha256 === null &&
    item.task_binding === "pending" && item.provenance === "unverified" &&
    (item.receipt_schema_version === 1
      ? item.ingress_id_provenance === "legacy-derived-from-capture-id" && item.ingress_id === item.capture_id
      : item.receipt_schema_version === 2 && item.ingress_id_provenance === "minted-at-capture");
}

function inventoryReady(view: CaptureInventory): boolean {
  return view.schema_version === 1 && view.complete === true && Array.isArray(view.items) &&
    Array.isArray(view.anomalies) && view.anomalies.length === 0 &&
    view.snapshot === "non-atomic-observation" && view.raw_content_read === false &&
    view.content_hash_verified === false && view.hook_outcome === "unrecorded" &&
    view.execution_state === "unknown" && view.dedupe === "unavailable" &&
    view.items.length <= INTAKE_PUMP_LIMITS.imports &&
    view.items.every(item => object(item) && validItem(item)) &&
    new Set(view.items.map(item => item.ingress_id)).size === view.items.length;
}

export function capturedArguments(item: InventoryItem, now: string): string[] {
  return ["intake-event", "--kind", "captured", "--ingress-id", item.ingress_id,
    "--capture-id", item.capture_id, "--channel", "codex-native", "--upstream-namespace", "codex/session",
    "--upstream-id-status", "unavailable", "--sha256", item.sha256,
    "--byte-len", String(item.byte_len), "--received-at", item.received_at, "--now", now];
}

function noticeArguments(event: IntakeNoticeEvent): string[] {
  return ["intake-notice", ...Object.entries(event).flatMap(([key, value]) =>
    ["--" + (key === "at" ? "now" : key.replaceAll("_", "-")), value === null ? "none" : String(value)])];
}

function written(r: ChildObservation, subject: { ingress_id: string; action?: string; notice_id?: string }): boolean {
  const v = jsonResult(r);
  return r.code === 0 && v?.result === "intake_written" && v.completion_fact === null &&
    Number.isSafeInteger(v.generation) && (v.generation as number) > 0 &&
    v.ingress_id === subject.ingress_id &&
    (subject.action ? v.action === subject.action && v.notice_id === subject.notice_id : v.kind === "captured");
}

/** These CLI markers are observations, not an authenticated receiving-side contract. */
export function intakeTransportOutcome(r: ChildObservation): "unknown" | "not_sent" {
  return !r.spawned && !r.timeout && !r.overflow && (r.error === "ENOENT" || r.error === "EACCES")
    ? "not_sent" : "unknown";
}

export function intakeStatusDocument(doc: IntakeDocument) {
  return { order: INTAKE_ORDER_LABEL, observation: "unlocked-metadata-only", receiver: "verification_unavailable",
    requests: derivePositions(doc).map(row => ({
      ingress_id: row.ingress_id, capture_id: row.capture_id, received_at: row.received_at,
      position: row.position, state: row.state, work_state: row.work_state,
      owning_task: row.owning_task, bound_dispatch_ids: row.bound_dispatch_ids,
      notice_id: intakeNoticeId(row.ingress_id),
      notice: row.notice === null ? "unclaimed" : "version" in row.notice
        ? row.notice.events.at(-1) : "legacy_unknown",
    })) };
}

export interface IntakePass {
  code: 0 | 3 | 4 | 9;
  complete: boolean;
  imported: number;
  replayed: number;
  refused: number;
  notices: number;
  reasons: string[];
  evidence: { operation: string; sha256: string }[];
  provenance: { ingress_id: string; provenance: string }[];
  status: ReturnType<typeof intakeStatusDocument> | null;
  caveats: readonly string[];
}

export async function intakePumpOnce(root: string, destination: string, ports: IntakePumpPorts): Promise<IntakePass> {
  const result: IntakePass = { code: 0, complete: false, imported: 0, replayed: 0, refused: 0,
    notices: 0, reasons: [], evidence: [], provenance: [], status: null,
    caveats: ["metadata-only", "non-atomic-observation", "content-hash-unverified", "receiver-verification-unavailable"] };
  const stop = (code: 3 | 4 | 9, reason: string): IntakePass => {
    result.code = code; result.reasons.push(reason); return result;
  };
  if (!path.isAbsolute(root) || root.includes("\0") || !matches(destination, SID) || destination === "intake-pump")
    return stop(4, "invalid_configuration");
  const deadline = ports.monotonic() + INTAKE_PUMP_LIMITS.passMs;
  const remaining = () => Math.max(0, Math.min(INTAKE_PUMP_LIMITS.childMs, Math.floor(deadline - ports.monotonic())));
  const record = (operation: string, observation: ChildObservation) => {
    result.evidence.push({ operation, sha256: hash(observation) });
  };
  try {
    const view = await ports.inventory(root);
    if (!inventoryReady(view)) return stop(3, "inventory_incomplete_anomalous_unsupported_or_over_bound");
    result.complete = true;
    const items = [...view.items].sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at) ||
      (a.ingress_id < b.ingress_id ? -1 : a.ingress_id > b.ingress_id ? 1 : 0));
    for (const item of items) {
      if (!remaining()) return stop(3, "pass_budget_before_import");
      result.provenance.push({ ingress_id: item.ingress_id, provenance: item.ingress_id_provenance });
      const r = await ports.registry(capturedArguments(item, ports.now()), remaining());
      record("captured:" + item.ingress_id, r);
      const value = jsonResult(r);
      if (written(r, item)) result.imported++;
      else if (r.code === 8 && value?.completion_fact === null &&
          ["intake_replay", "intake_archived"].includes(String(value.result))) {
        result.replayed++;
      } else {
        result.refused++;
        // This adapter has no upstream identity, so an upstream-duplicate response
        // cannot be appropriate evidence for its captured event.
        if (r.code === 8 && value?.result === "intake_upstream_duplicate")
          return stop(9, "unexpected_upstream_duplicate_without_upstream_identity");
        return stop(r.code === 4 && value ? 4 : 9,
          r.code === 4 && value ? "import_refused:" + String(value.result) : "import_storage_unknown");
      }
    }
    const doc = await refresh(ports, remaining);
    if (!doc) return stop(9, "refreshed_intake_unavailable");
    result.status = intakeStatusDocument(doc);
    const byIngress = new Map(items.map(item => [item.ingress_id, item]));
    const blocked = new Set<string>();
    for (const row of derivePositions(doc)) {
      if (row.position === null) continue;
      const receipt = byIngress.get(row.ingress_id);
      if (!receipt || receipt.capture_id !== row.capture_id || receipt.sha256 !== row.sha256 ||
          receipt.byte_len !== row.byte_len || receipt.received_at !== row.received_at) {
        blocked.add(row.ingress_id);
        result.reasons.push("evidence_missing_or_identity_mismatch:" + row.ingress_id);
      }
      if (!row.owning_task || !row.bound_dispatch_ids.length)
        result.reasons.push("binding_pending:" + row.ingress_id);
    }
    if (blocked.size) {
      result.code = 3;
      return result;
    }
    for (const row of derivePositions(doc)) {
      if (blocked.has(row.ingress_id) || row.position === null || row.state !== "queued" ||
          row.work_state !== "unstarted" || row.pause !== null || row.superseded_by !== null ||
          row.result !== null || row.failure !== null) continue;
      if (row.notice && !("version" in row.notice)) { result.reasons.push("legacy_notice_unknown"); continue; }
      const previous = row.notice?.events.at(-1);
      if (previous && (!(previous.action === "result" || previous.action === "resolve") ||
          previous.status !== "not_sent" || previous.retry_at === null || ports.now() < previous.retry_at)) {
        result.reasons.push("notice_or_ack_unresolved:" + row.ingress_id); continue;
      }
      if (result.notices >= INTAKE_PUMP_LIMITS.notices || !remaining()) {
        result.reasons.push("notice_work_remaining"); break;
      }
      const claim: IntakeNoticeEvent = { action: "claim", ingress_id: row.ingress_id,
        notice_id: intakeNoticeId(row.ingress_id), attempt: (previous?.attempt ?? 0) + 1,
        previous_attempt: previous?.attempt ?? 0, previous_claim: previous?.claim ?? null,
        claim: ports.token(), owner: "intake-pump", at: ports.now() };
      if (applyIntakeNotice(doc, claim).result !== "intake_written") {
        result.reasons.push("notice_claim_ineligible:" + row.ingress_id); continue;
      }
      const claimed = await ports.registry(noticeArguments(claim), remaining());
      record("claim:" + row.ingress_id, claimed);
      if (!written(claimed, claim)) return stop(claimed.code === 4 || claimed.code === 8 ? 3 : 9,
        "claim_not_confirmed_no_send");
      if (!remaining()) return stop(3, "claimed_unsent_outcome_unknown_budget");
      const sent = await ports.send(destination, JSON.stringify({
        kind: "intake_pending", ingress_id: row.ingress_id, notice_id: claim.notice_id,
        attempt: claim.attempt, claim: claim.claim, owner: claim.owner,
        received_at: row.received_at, sha256: row.sha256, byte_len: row.byte_len,
        completion_fact: null,
      }), remaining());
      result.notices++;
      record("transport:" + row.ingress_id, sent);
      const status = intakeTransportOutcome(sent);
      const at = ports.now();
      const event: IntakeNoticeEvent = { action: "result", ingress_id: claim.ingress_id,
        notice_id: claim.notice_id, attempt: claim.attempt, claim: claim.claim, owner: claim.owner,
        at, status, evidence_sha256: hash(sent),
        retry_at: status === "not_sent" ? seconds(Date.parse(at) + 60_000) : null };
      if (!remaining()) return stop(3, "transport_result_unrecorded_budget");
      const saved = await ports.registry(noticeArguments(event), remaining());
      record("result:" + row.ingress_id, saved);
      if (!written(saved, event)) return stop(9, "notice_result_unconfirmed_no_retry");
      result.reasons.push("notice_" + status + ":" + row.ingress_id);
      if (status === "unknown") break;
    }
    const final = await refresh(ports, remaining);
    if (!final) return stop(9, "final_intake_unavailable");
    result.status = intakeStatusDocument(final);
    if (result.reasons.length) result.code = 3;
    return result;
  } catch {
    return stop(9, "port_error_effect_unknown");
  }
}

export interface VerifiedReceiverPort {
  /** Only a future authenticated receiver implementation may return a verified exact event. */
  verify(): Promise<Extract<IntakeNoticeEvent, { action: "ack" }> | null>;
}

export async function intakeAck(ports: IntakePumpPorts, verifier?: VerifiedReceiverPort):
Promise<{ code: number; reason: string }> {
  if (!verifier) return { code: 4, reason: "receiver_verification_unavailable" };
  const deadline = ports.monotonic() + INTAKE_PUMP_LIMITS.passMs;
  const remaining = () => Math.max(0, Math.min(INTAKE_PUMP_LIMITS.childMs, Math.floor(deadline - ports.monotonic())));
  try {
    const event = await verifier.verify();
    if (!event || event.action !== "ack") return { code: 4, reason: "receiver_verification_refused" };
    const doc = await refresh(ports, remaining);
    if (!doc) return { code: 9, reason: "intake_unavailable" };
    const check = applyIntakeNotice(doc, event);
    if (check.result === "intake_notice_replay") return { code: 0, reason: "verified_ack_replay" };
    if (check.result !== "intake_written") return { code: 4, reason: "verified_ack_tuple_refused" };
    if (!remaining()) return { code: 3, reason: "ack_budget" };
    const saved = await ports.registry(noticeArguments(event), remaining());
    return written(saved, event) ? { code: 0, reason: "verified_ack_recorded_not_work_completion" }
      : { code: 9, reason: "ack_write_unconfirmed" };
  } catch { return { code: 9, reason: "ack_effect_unknown" }; }
}

export type IntakeCommand = { command: "intake-pump"; root: string } |
  { command: "intake-status"; json: boolean } | { command: "intake-ack" };

export function parseIntakeCommand(args: string[]): IntakeCommand | null {
  if (args[0] === "intake-status")
    return args.length === 1 || (args.length === 2 && args[1] === "--json")
      ? { command: "intake-status", json: args[1] === "--json" } : null;
  if (args[0] === "intake-ack") return args.length === 1 ? { command: "intake-ack" } : null;
  if (args[0] !== "intake-pump" || args.length !== 4) return null;
  const flags = args.slice(1);
  const once = flags.indexOf("--once"), rootFlag = flags.indexOf("--capture-root");
  if (once < 0 || rootFlag < 0 || rootFlag + 1 >= flags.length || once === rootFlag + 1 ||
      flags.filter(f => f === "--once").length !== 1 || flags.filter(f => f === "--capture-root").length !== 1)
    return null;
  const root = flags[rootFlag + 1]!;
  return path.isAbsolute(root) && !root.includes("\0") ? { command: "intake-pump", root } : null;
}

export async function runIntakeCommand(args: string[], config: IntakePumpConfig,
  ports?: IntakePumpPorts): Promise<{ code: number; output: string }> {
  const command = parseIntakeCommand(args);
  if (!command) return { code: 4, output: "invalid_argument\n" };
  // Default ACK has no principal, no CLI tuple and no bypass flag/environment.
  if (command.command === "intake-ack")
    return { code: 4, output: "receiver_verification_unavailable\n" };
  const deps = ports ?? defaultIntakePorts(config);
  if (command.command === "intake-pump") {
    const pass = await intakePumpOnce(command.root, config.destination, deps);
    return { code: pass.code, output: JSON.stringify(pass) + "\n" };
  }
  try {
    const raw = await deps.readStatus();
    const doc = checkedDocument(raw);
    if (!doc) return { code: 9, output: "intake_unavailable\n" };
    const status = intakeStatusDocument(doc);
    return { code: status.requests.some(row => row.position !== null) ? 3 : 0,
      output: command.json ? JSON.stringify(status) + "\n"
        : status.requests.map(row => `${row.position ?? "-"} ${row.ingress_id} ${row.state} ${row.work_state}`).join("\n") +
          "\nreceiver_verification_unavailable; unlocked metadata observation\n" };
  } catch { return { code: 9, output: "intake_unavailable\n" }; }
}

export function reconcilerIntakeArguments(dryRun: number, env: NodeJS.ProcessEnv): string[] | null {
  const root = env.AIGENTRY_CAPTURE_ROOT;
  return dryRun === 0 && env.AIGENTRY_INTAKE_PUMP === "1" && root &&
    path.isAbsolute(root) && !root.includes("\0")
    ? ["intake-pump", "--once", "--capture-root", root] : null;
}
