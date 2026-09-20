import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWrite } from "../session/persistence/atomic-write.js";
import { withIndexLock } from "../session/persistence/index-lock.js";

export interface CaptureReceipt {
  schema_version: 1;
  capture_id: string;
  byte_len: number;
  sha256: string;
  original_ref: string;
  channel: "codex-native";
  upstream_namespace: "codex/session";
  upstream_delivery_id: null;
  received_at: string;
  provenance: "unverified";
  task_binding: "pending";
  metadata: {
    session_id: string | null;
    turn_id: string | null;
    hook_event_name: string | null;
    model: string | null;
  };
  durability: "file-and-directory-fsync" | "file-fsync-only";
}

const STORE_MARKER = { schema_version: 1, kind: "request-capture" };

async function statIfPresent(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function requirePrivate(mode: number, expected: number): void {
  if (process.platform !== "win32" && (mode & 0o777) !== expected) {
    throw new Error("capture: invalid permissions");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function privateDirectory(directory: string): Promise<void> {
  let stat = await statIfPresent(directory);
  if (stat === null) {
    await fs.mkdir(directory, { mode: 0o700 });
    stat = await fs.lstat(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("capture: invalid directory");
  }
  requirePrivate(stat.mode, 0o700);
  await syncDirectory(directory);
}

async function readPrivateFile(target: string): Promise<Buffer> {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("capture: invalid file");
  }
  requirePrivate(stat.mode, 0o600);
  const handle = await fs.open(
    target,
    // Windows FlushFileBuffers requires write access; never create or truncate here.
    process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error("capture: file changed");
    }
    const bytes = await handle.readFile();
    // Also establish durability when reusing evidence from an interrupted call.
    await handle.sync();
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeNew(target: string, bytes: Uint8Array): Promise<void> {
  // Every cooperating writer holds the store lock, including collision checks.
  if (await statIfPresent(target)) throw new Error("capture: collision");
  await atomicWrite(target, bytes, { sessionId: randomUUID() });
}

function metadataFrom(bytes: Uint8Array): CaptureReceipt["metadata"] {
  const metadata: CaptureReceipt["metadata"] = {
    session_id: null, turn_id: null, hook_event_name: null, model: null,
  };
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const key of Object.keys(metadata) as (keyof typeof metadata)[]) {
        const field = (value as Record<string, unknown>)[key];
        if (typeof field === "string") metadata[key] = field;
      }
    }
  } catch {
    // Parsing is optional; the original bytes have already been persisted.
  }
  return metadata;
}

export async function captureSubmittedPrompt(
  raw: Uint8Array,
  options: { root: string },
): Promise<CaptureReceipt> {
  try {
    // Snapshot before the first await so caller mutation cannot change the evidence.
    const bytes = Buffer.from(raw);
    const receivedAt = new Date().toISOString();
    if (!path.isAbsolute(options.root)) throw new Error("capture: invalid root");
    const root = path.resolve(options.root);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("capture: invalid root");
    }
    const markerPath = path.join(root, "store.json");
    const lockStat = await statIfPresent(`${markerPath}.lock`);
    if (lockStat && (!lockStat.isFile() || lockStat.isSymbolicLink())) {
      throw new Error("capture: invalid lock");
    }
    return await withIndexLock(markerPath, async () => {
      const markerStat = await statIfPresent(markerPath);
      if (markerStat) {
        const marker: unknown = JSON.parse((await readPrivateFile(markerPath)).toString("utf8"));
        if (marker === null || typeof marker !== "object" || Array.isArray(marker)
          || Object.keys(marker).length !== 2
          || (marker as Record<string, unknown>).schema_version !== STORE_MARKER.schema_version
          || (marker as Record<string, unknown>).kind !== STORE_MARKER.kind) {
          throw new Error("capture: invalid store marker");
        }
      }
      const rawDirectory = path.join(root, "raw");
      const receiptDirectory = path.join(root, "receipts");
      await privateDirectory(rawDirectory);
      await privateDirectory(receiptDirectory);
      if (!markerStat) {
        await writeNew(markerPath, Buffer.from(JSON.stringify(STORE_MARKER)));
      }
      await syncDirectory(root);

      const digest = createHash("sha256").update(bytes).digest("hex");
      const originalRef = `raw/${digest}.bin`;
      const blobPath = path.join(rawDirectory, `${digest}.bin`);
      if (await statIfPresent(blobPath)) {
        const existing = await readPrivateFile(blobPath);
        if (createHash("sha256").update(existing).digest("hex") !== digest
          || !existing.equals(bytes)) throw new Error("capture: corrupt blob");
        await syncDirectory(rawDirectory);
      } else {
        await writeNew(blobPath, bytes);
      }
      const receipt: CaptureReceipt = {
        schema_version: 1,
        capture_id: randomUUID(),
        byte_len: bytes.byteLength,
        sha256: digest,
        original_ref: originalRef,
        channel: "codex-native",
        upstream_namespace: "codex/session",
        upstream_delivery_id: null,
        received_at: receivedAt,
        provenance: "unverified",
        task_binding: "pending",
        metadata: metadataFrom(bytes),
        durability: process.platform === "win32" ? "file-fsync-only" : "file-and-directory-fsync",
      };
      await writeNew(
        path.join(receiptDirectory, `${receipt.capture_id}.json`),
        Buffer.from(JSON.stringify(receipt)),
      );
      return receipt;
    }, { strictRelease: true });
  } catch {
    // Filesystem and JSON errors can contain caller-controlled data; do not expose it.
    throw new Error("capture: failed to persist submitted prompt");
  }
}
