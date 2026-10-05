import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CaptureReceipt } from "./receipt.js";

// Read-only, bounded observation of an existing capture store (#1166 U1).
// Never: mkdir, write-open, chmod, sync, unlink, repair, lock acquire/release, raw blob open.
// A listed item is "captured, hook outcome unrecorded" — never admission or execution authority.

export type InventoryAnomalyCode =
  | "invalid_root" | "invalid_store" | "invalid_receipt" | "blob_missing" | "size_mismatch"
  | "bad_mode" | "symlink" | "tmp_residue" | "lock_present" | "orphan_blob" | "scan_limit"
  | "changed_during_scan" | "io_error";

export interface InventoryItem {
  capture_id: string;
  received_at: string;
  byte_len: number;
  sha256: string;
  durability: CaptureReceipt["durability"];
  task_binding: "pending";
  provenance: "unverified";
}

/** `count` is exact; `refs` holds only validated capture IDs or digests and may be shorter. */
export interface InventoryAnomaly {
  code: InventoryAnomalyCode;
  count: number;
  refs: string[];
}

export interface CaptureInventory {
  schema_version: 1;
  complete: boolean;
  snapshot: "non-atomic-observation";
  order: "received-at-then-capture-id-not-commit";
  raw_content_read: false;
  content_hash_verified: false;
  hook_outcome: "unrecorded";
  execution_state: "unknown";
  dedupe: "unavailable";
  items: InventoryItem[];
  anomalies: InventoryAnomaly[];
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_DIR_ENTRIES = 4096;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_REFS = 1000;
const POSIX = process.platform !== "win32";
const READ_FLAGS = constants.O_RDONLY | (POSIX ? constants.O_NOFOLLOW : 0);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECEIPT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const BLOB_NAME = /^([0-9a-f]{64})\.bin$/;
const RECEIPT_KEYS = [
  "byte_len", "capture_id", "channel", "durability", "metadata", "original_ref", "provenance",
  "received_at", "schema_version", "sha256", "task_binding", "upstream_delivery_id",
  "upstream_namespace",
].join(",");
const METADATA_KEYS = ["hook_event_name", "model", "session_id", "turn_id"].join(",");
const DURABILITY = new Set(["file-and-directory-fsync", "file-fsync-only"]);

class Anomalies {
  private readonly entries = new Map<InventoryAnomalyCode, { count: number; refs: Set<string> }>();
  private refTotal = 0;

  add(code: InventoryAnomalyCode, ref?: string): void {
    let entry = this.entries.get(code);
    if (!entry) {
      entry = { count: 0, refs: new Set() };
      this.entries.set(code, entry);
    }
    entry.count += 1;
    if (ref !== undefined && !entry.refs.has(ref) && this.refTotal < MAX_REFS) {
      entry.refs.add(ref);
      this.refTotal += 1;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  toJSON(): InventoryAnomaly[] {
    return [...this.entries.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([code, entry]) => ({ code, count: entry.count, refs: [...entry.refs].sort() }));
  }
}

function result(complete: boolean, items: InventoryItem[], anomalies: Anomalies): CaptureInventory {
  return {
    schema_version: 1,
    complete,
    snapshot: "non-atomic-observation",
    order: "received-at-then-capture-id-not-commit",
    raw_content_read: false,
    content_hash_verified: false,
    hook_outcome: "unrecorded",
    execution_state: "unknown",
    dedupe: "unavailable",
    items,
    anomalies: anomalies.toJSON(),
  };
}

/** Fixed diagnostic only: no paths, names or error messages. */
function unavailable(code: "invalid_root" | "invalid_store" | "io_error"): CaptureInventory {
  const anomalies = new Anomalies();
  anomalies.add(code);
  return result(false, [], anomalies);
}

async function lstatIfPresent(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function modeIs(stat: Stats, expected: number): boolean {
  if (!POSIX) return true;
  const uid = process.geteuid?.();
  return (stat.mode & 0o777) === expected && (uid === undefined || stat.uid === uid);
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink
    && a.uid === b.uid && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

type ReadOutcome =
  | { ok: true; bytes: Buffer }
  | { ok: false; code: "symlink" | "bad_mode" | "invalid_receipt" | "changed_during_scan" | "io_error" };

/** Bounded O_RDONLY|O_NOFOLLOW read of a private regular file; identity checked before and after. */
async function readBoundedPrivate(target: string): Promise<ReadOutcome> {
  let before: Stats | null;
  try {
    before = await lstatIfPresent(target);
  } catch {
    return { ok: false, code: "io_error" };
  }
  if (before === null) return { ok: false, code: "changed_during_scan" };
  if (before.isSymbolicLink()) return { ok: false, code: "symlink" };
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) {
    return { ok: false, code: "invalid_receipt" };
  }
  if (!modeIs(before, 0o600)) return { ok: false, code: "bad_mode" };
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(target, READ_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { ok: false, code: "symlink" };
    if (code === "ENOENT") return { ok: false, code: "changed_during_scan" };
    return { ok: false, code: "io_error" };
  }
  try {
    const opened = await handle.stat();
    if (!sameIdentity(before, opened)) return { ok: false, code: "changed_during_scan" };
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const afterRead = await handle.stat();
    const afterPath = await lstatIfPresent(target);
    if (length !== before.size || !sameIdentity(before, afterRead)
      || afterPath === null || !sameIdentity(before, afterPath)) {
      return { ok: false, code: "changed_during_scan" };
    }
    return { ok: true, bytes: buffer.subarray(0, length) };
  } catch {
    return { ok: false, code: "io_error" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** Exact v1 receipt contract of receipt.ts; returns the item or null. */
function validateReceipt(value: unknown, captureId: string): InventoryItem | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== RECEIPT_KEYS) return null;
  const metadata = value.metadata;
  if (!isRecord(metadata) || Object.keys(metadata).sort().join(",") !== METADATA_KEYS
    || !Object.values(metadata).every((field) => field === null || typeof field === "string")) {
    return null;
  }
  const { sha256, byte_len: byteLen, durability, received_at: receivedAt } = value;
  if (value.schema_version !== 1
    || value.capture_id !== captureId || !UUID_V4.test(captureId)
    || typeof byteLen !== "number" || !Number.isSafeInteger(byteLen) || byteLen < 0
    || typeof sha256 !== "string" || !SHA256.test(sha256)
    || value.original_ref !== `raw/${sha256}.bin`
    || value.channel !== "codex-native"
    || value.upstream_namespace !== "codex/session"
    || value.upstream_delivery_id !== null
    || !isCanonicalIso(receivedAt)
    || value.provenance !== "unverified"
    || value.task_binding !== "pending"
    || typeof durability !== "string" || !DURABILITY.has(durability)) {
    return null;
  }
  return {
    capture_id: captureId,
    received_at: receivedAt,
    byte_len: byteLen,
    sha256,
    durability: durability as CaptureReceipt["durability"],
    task_binding: "pending",
    provenance: "unverified",
  };
}

/** Bounded, non-recursive listing. `overflow` is true when more than the cap exists. */
async function listDirectory(directory: string): Promise<{ names: { name: string; symlink: boolean }[]; overflow: boolean }> {
  const dir = await fs.opendir(directory, { bufferSize: 64 });
  const names: { name: string; symlink: boolean }[] = [];
  let overflow = false;
  try {
    for (;;) {
      const entry = await dir.read();
      if (entry === null) break;
      if (names.length >= MAX_DIR_ENTRIES) {
        overflow = true;
        break;
      }
      names.push({ name: entry.name, symlink: entry.isSymbolicLink() });
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  return { names, overflow };
}

async function directoryStat(directory: string): Promise<Stats | null> {
  const stat = await lstatIfPresent(directory);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) return null;
  return stat;
}

function compareItems(a: InventoryItem, b: InventoryItem): number {
  const delta = Date.parse(a.received_at) - Date.parse(b.received_at);
  if (delta !== 0) return delta;
  return a.capture_id < b.capture_id ? -1 : a.capture_id > b.capture_id ? 1 : 0;
}

export async function listCaptureInventory(
  root: string,
  options: { limit?: number } = {},
): Promise<CaptureInventory> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError("inventory: invalid limit");
  }
  if (typeof root !== "string" || !path.isAbsolute(root)) return unavailable("invalid_root");
  try {
    const rootPath = path.resolve(root);
    const rootBefore = await directoryStat(rootPath);
    if (rootBefore === null || !modeIs(rootBefore, 0o700)) return unavailable("invalid_root");

    const anomalies = new Anomalies();
    let truncated = false;
    const marker = await readBoundedPrivate(path.join(rootPath, "store.json"));
    if (!marker.ok) {
      if (marker.code === "changed_during_scan" || marker.code === "io_error") {
        // A missing marker is an uninitialised or foreign root: fixed diagnostic only.
        return unavailable(marker.code === "io_error" ? "io_error" : "invalid_store");
      }
      return unavailable("invalid_store");
    }
    const markerValue = parseJson(marker.bytes);
    if (!isRecord(markerValue) || Object.keys(markerValue).length !== 2
      || markerValue.schema_version !== 1 || markerValue.kind !== "request-capture") {
      return unavailable("invalid_store");
    }

    const rawPath = path.join(rootPath, "raw");
    const receiptsPath = path.join(rootPath, "receipts");
    const rawBefore = await directoryStat(rawPath);
    const receiptsBefore = await directoryStat(receiptsPath);
    if (rawBefore === null || receiptsBefore === null) return unavailable("invalid_store");
    if (!modeIs(rawBefore, 0o700)) anomalies.add("bad_mode");
    if (!modeIs(receiptsBefore, 0o700)) anomalies.add("bad_mode");

    // Root: lock and atomic-write/lock-staging residue only. Nothing is swept.
    const rootList = await listDirectory(rootPath);
    if (rootList.overflow) {
      anomalies.add("scan_limit");
      truncated = true;
    }
    for (const { name } of rootList.names) {
      if (name === "store.json.lock") anomalies.add("lock_present");
      else if (name.startsWith("store.json.") && name.includes(".tmp.")) anomalies.add("tmp_residue");
    }

    // Receipts.
    const items: InventoryItem[] = [];
    const referenced = new Set<string>();
    const receiptList = await listDirectory(receiptsPath);
    if (receiptList.overflow) {
      anomalies.add("scan_limit");
      truncated = true;
    }
    const blobStats = new Map<string, Stats | null | "error">();
    for (const { name, symlink } of receiptList.names) {
      const match = RECEIPT_NAME.exec(name);
      if (symlink) {
        anomalies.add("symlink", match?.[1]);
        continue;
      }
      if (!match) {
        anomalies.add(name.includes(".tmp.") ? "tmp_residue" : "invalid_receipt");
        continue;
      }
      const captureId = match[1] as string;
      const read = await readBoundedPrivate(path.join(receiptsPath, name));
      if (!read.ok) {
        anomalies.add(read.code, captureId);
        continue;
      }
      const parsed = parseJson(read.bytes);
      if (isRecord(parsed) && typeof parsed.sha256 === "string" && SHA256.test(parsed.sha256)) {
        referenced.add(parsed.sha256);
      }
      const item = validateReceipt(parsed, captureId);
      if (item === null) {
        anomalies.add("invalid_receipt", captureId);
        continue;
      }
      // Blob METADATA only: lstat, never open, read or hash.
      let blob = blobStats.get(item.sha256);
      if (blob === undefined) {
        try {
          blob = await lstatIfPresent(path.join(rawPath, `${item.sha256}.bin`));
        } catch {
          blob = "error";
        }
        blobStats.set(item.sha256, blob);
      }
      if (blob === "error") anomalies.add("io_error", captureId);
      else if (blob === null) anomalies.add("blob_missing", captureId);
      else if (blob.isSymbolicLink()) anomalies.add("symlink", captureId);
      else if (!blob.isFile()) anomalies.add("blob_missing", captureId);
      else {
        if (!modeIs(blob, 0o600)) anomalies.add("bad_mode", captureId);
        if (blob.size !== item.byte_len) anomalies.add("size_mismatch", captureId);
      }
      // Distinct receipts with an equal digest stay distinct: no content dedupe.
      items.push(item);
    }

    // Raw: orphan candidates are observations only, never deletion authority.
    const rawList = await listDirectory(rawPath);
    if (rawList.overflow) {
      anomalies.add("scan_limit");
      truncated = true;
    }
    for (const { name, symlink } of rawList.names) {
      const match = BLOB_NAME.exec(name);
      if (symlink) anomalies.add("symlink", match?.[1]);
      else if (name.includes(".tmp.")) anomalies.add("tmp_residue");
      else if (!match) anomalies.add("orphan_blob");
      // An orphan cannot be judged against a truncated receipt listing.
      else if (!receiptList.overflow && !referenced.has(match[1] as string)) {
        anomalies.add("orphan_blob", match[1]);
      }
    }

    items.sort(compareItems);
    if (items.length > limit) {
      for (let index = limit; index < items.length; index += 1) anomalies.add("scan_limit");
      items.length = limit;
      truncated = true;
    }

    const rootAfter = await directoryStat(rootPath);
    const rawAfter = await directoryStat(rawPath);
    const receiptsAfter = await directoryStat(receiptsPath);
    if (rootAfter === null || !sameIdentity(rootBefore, rootAfter)
      || rawAfter === null || !sameIdentity(rawBefore, rawAfter)
      || receiptsAfter === null || !sameIdentity(receiptsBefore, receiptsAfter)) {
      anomalies.add("changed_during_scan");
    }

    // Windows ACLs are not verified here, so a win32 observation is never reported complete.
    return result(POSIX && !truncated && anomalies.size === 0, items, anomalies);
  } catch {
    return unavailable("io_error");
  }
}
