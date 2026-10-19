import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { emptyConfig, MAX_CONFIG_BYTES, strictJson, uuid, validateConfig, type Config } from "./contract.js";
import { nativeMaintenanceProof, type MaintenanceProofAdapter } from "./native-boot.js";

export function environmentHome(env: NodeJS.ProcessEnv = process.env): string {
  const supplied = env.AIGENTRY_HOME;
  if (supplied !== undefined && (!supplied || Buffer.byteLength(supplied) > 4096 || !path.isAbsolute(supplied) || /[\u0000-\u001f\u007f]/.test(supplied))) throw new Error("ENV_HOME_NOT_ABSOLUTE");
  return path.normalize(supplied ?? path.join(os.homedir(), ".aigentry"));
}
export const configPath = (home: string): string => path.join(home, "environment", "config.json");
function absent(e: unknown): boolean { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
function supported(): void {
  if (process.platform === "win32" || typeof process.getuid !== "function" || !fs.constants.O_NOFOLLOW) throw new Error("ENV_PROTECTION_UNAVAILABLE");
}
function inspect(file: string, directory: boolean, privateMode: boolean): fs.Stats {
  const s = fs.lstatSync(file);
  supported();
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) ||
      s.uid !== process.getuid?.() || (privateMode && (s.mode & 0o077) !== 0)) throw new Error("ENV_UNSAFE_PATH");
  return s;
}
function parents(home: string): void {
  supported();
  const parts = path.resolve(home).split(path.sep).filter(Boolean);
  let p = path.parse(home).root;
  for (const part of parts) {
    p = path.join(p, part);
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== 0 && s.uid !== process.getuid?.()) ||
        ((s.mode & 0o022) !== 0 && (s.mode & 0o1000) === 0)) throw new Error("ENV_UNSAFE_PARENT");
  }
  inspect(home, true, true);
  inspect(path.join(home, "environment"), true, true);
}
function creationParents(home: string): void {
  supported();
  let p = path.parse(home).root;
  for (const part of home.split(path.sep).filter(Boolean)) {
    p = path.join(p, part);
    try {
      const s = fs.lstatSync(p);
      if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== 0 && s.uid !== process.getuid?.()) ||
          ((s.mode & 0o022) !== 0 && (s.mode & 0o1000) === 0)) throw new Error("ENV_UNSAFE_PARENT");
    } catch (e) { if (absent(e)) break; throw e; }
  }
}
export function readBounded(file: string, privateMode = true): string | null {
  let before: fs.Stats;
  try { before = inspect(file, false, privateMode); } catch (e) { if (absent(e)) return null; throw e; }
  supported();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const after = fs.fstatSync(fd);
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino ||
        after.uid !== process.getuid?.() || (privateMode && (after.mode & 0o077) !== 0)) throw new Error("ENV_UNSAFE_PATH");
    return readFdBounded(fd, after.size);
  } finally { fs.closeSync(fd); }
}
function readFdBounded(fd: number, size: number): string {
  if (size > MAX_CONFIG_BYTES) throw new Error("ENV_CONFIG_TOO_LARGE");
  const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
  let count = 0;
  while (count < bytes.length) {
    const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
    if (n === 0) break;
    count += n;
  }
  if (count > MAX_CONFIG_BYTES) throw new Error("ENV_CONFIG_TOO_LARGE");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)); }
  catch { throw new Error("ENV_UTF8_INVALID"); }
}
// Legacy config is nonsecret, may have public read bits, and predates central
// protected storage. Its bounded read must not depend on POSIX mutation support.
export function readLegacyBounded(file: string): string | null {
  const check = (s: fs.Stats) => {
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 ||
        (process.platform !== "win32" && typeof process.getuid === "function" && s.uid !== process.getuid())) throw new Error("ENV_UNSAFE_PATH");
  };
  let before: fs.Stats;
  try { before = fs.lstatSync(file); check(before); } catch (e) { if (absent(e)) return null; throw e; }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const after = fs.fstatSync(fd);
    check(after);
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("ENV_UNSAFE_PATH");
    return readFdBounded(fd, after.size);
  } finally { fs.closeSync(fd); }
}
export function readConfig(home: string): Config {
  let existing = path.parse(home).root;
  for (const part of home.split(path.sep).filter(Boolean)) {
    existing = path.join(existing, part);
    try {
      const s = fs.lstatSync(existing);
      if (s.isSymbolicLink() || !s.isDirectory()) throw new Error("ENV_UNSAFE_PARENT");
    } catch (e) { if (absent(e)) return emptyConfig(); throw e; }
  }
  // Walk existing components even when the leaf is missing: a symlinked central
  // directory must never turn an absent config read into an external read.
  for (const p of [home, path.join(home, "environment")]) {
    try { const s = fs.lstatSync(p); if (s.isSymbolicLink() || !s.isDirectory()) throw new Error("ENV_UNSAFE_PATH"); }
    catch (e) { if (absent(e)) return emptyConfig(); throw e; }
  }
  let exists = true;
  try { fs.lstatSync(configPath(home)); } catch (e) { if (absent(e)) exists = false; else throw e; }
  if (!exists) return emptyConfig();
  parents(home);
  const raw = readBounded(configPath(home));
  return raw === null ? emptyConfig() : validateConfig(strictJson(raw));
}
function ensure(home: string): void {
  creationParents(home);
  // Never chmod an existing foreign/legacy root. Only explicit mutation creates paths.
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  inspect(home, true, true);
  try { fs.mkdirSync(path.join(home, "environment"), { mode: 0o700 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
}
const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;
function entryExists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (e) { if (absent(e)) return false; throw e; }
}
export function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function durableWriteExclusive(file: string, bytes: string | Buffer): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fsyncDirectory(path.dirname(file));
}
export function withWriterLock<T>(home: string, work: () => T, proof: MaintenanceProofAdapter = nativeMaintenanceProof): T {
  ensure(home);
  parents(home);
  const rootIdentity = fs.lstatSync(home), parent = path.join(home, "environment");
  const parentIdentity = fs.lstatSync(parent);
  const lock = path.join(parent, "writer.lock");
  const guard = path.join(parent, "maintenance.guard");
  const journal = path.join(parent, "maintenance-journal");
  if (entryExists(guard) || entryExists(journal)) throw new Error("ENV_WRITER_LOCKED");
  if (entryExists(path.join(parent, "commit-unknown"))) throw new Error("ENV_COMMIT_OUTCOME_UNKNOWN");
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("ENV_WRITER_LOCKED"); throw e; }
  const lockIdentity = inspect(lock, true, true);
  // A crash between mkdir and this durable owner record intentionally leaves an
  // unclaimable lock. Recovery must prove offline quiescence; PID/age never suffice.
  let owned = false;
  const pinned = () => {
    if (entryExists(guard) || entryExists(journal)) throw new Error("ENV_WRITER_LOCKED");
    parents(home);
    if (!same(rootIdentity, fs.lstatSync(home)) || !same(parentIdentity, fs.lstatSync(parent)) || !same(lockIdentity, inspect(lock, true, true))) throw new Error("ENV_PATH_CHANGED");
  };
  try {
    pinned();
    const owner = JSON.stringify({ version: 1, nonce: randomUUID(), boot: proof.bootIdentity() }) + "\n";
    durableWriteExclusive(path.join(lock, "owner.json"), owner);
    fsyncDirectory(parent);
    owned = true;
    pinned();
    return work();
  } finally {
    if (owned) {
      try {
        pinned();
        fs.unlinkSync(path.join(lock, "owner.json"));
        fsyncDirectory(lock);
        fs.rmdirSync(lock);
        fsyncDirectory(parent);
      } catch { throw new Error("ENV_COMMIT_OUTCOME_UNKNOWN"); }
    }
  }
}
type LockOwner = { version: 1; nonce: string; boot: string | null };
function ownerRecord(file: string): LockOwner | null {
  const raw = readBounded(file);
  if (raw === null) return null;
  if (Buffer.byteLength(raw) > 4096) throw new Error("ENV_WRITER_LOCKED");
  const value = strictJson(raw) as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || value.version !== 1 || !uuid(value.nonce) ||
      !(value.boot === null || typeof value.boot === "string" && /^[0-9a-f-]{36}$/.test(value.boot))) {
    throw new Error("ENV_WRITER_LOCKED");
  }
  return value as LockOwner;
}
function provenQuiescent(home: string, owner: LockOwner | null, proof: MaintenanceProofAdapter): boolean {
  const current = proof.bootIdentity();
  return !!(owner?.boot && current && owner.boot !== current) || proof.offlineQuiescence(home);
}
/** Explicit, zero-wait recovery. A same-boot or empty lock needs platform-approved offline proof. */
export function recoverWriterLock(home: string, proof: MaintenanceProofAdapter = nativeMaintenanceProof): boolean {
  parents(home);
  const parent = path.join(home, "environment"), lock = path.join(parent, "writer.lock");
  const guard = path.join(parent, "maintenance.guard"), journal = path.join(parent, "maintenance-journal");
  if (entryExists(path.join(parent, "commit-unknown"))) throw new Error("ENV_COMMIT_OUTCOME_UNKNOWN");
  if (![lock, guard, journal].some(entryExists)) return false;
  const pinnedParent = inspect(parent, true, true);
  const existingGuard = entryExists(guard);
  if (existingGuard) {
    inspect(guard, true, true);
    if (!provenQuiescent(home, ownerRecord(path.join(guard, "owner.json")), proof)) throw new Error("ENV_WRITER_LOCKED");
  }
  const existingJournal = entryExists(journal);
  if (existingJournal) {
    inspect(journal, true, true);
    if (!provenQuiescent(home, ownerRecord(path.join(journal, "owner.json")), proof)) throw new Error("ENV_WRITER_LOCKED");
  }
  const originalLock = entryExists(lock) ? inspect(lock, true, true) : null;
  const lockOwner = originalLock ? ownerRecord(path.join(lock, "owner.json")) : null;
  if (originalLock && !provenQuiescent(home, lockOwner, proof)) throw new Error("ENV_WRITER_LOCKED");
  if (!existingGuard) {
    fs.mkdirSync(guard, { mode: 0o700 }); fsyncDirectory(parent);
    durableWriteExclusive(path.join(guard, "owner.json"), JSON.stringify({ version: 1,
      nonce: randomUUID(), boot: proof.bootIdentity() }) + "\n");
  }
  const guardIdentity = inspect(guard, true, true);
  if (!existingJournal) {
    fs.mkdirSync(journal, { mode: 0o700 }); fsyncDirectory(parent);
    durableWriteExclusive(path.join(journal, "owner.json"), JSON.stringify({ version: 1,
      nonce: randomUUID(), boot: proof.bootIdentity() }) + "\n");
    if (originalLock) durableWriteExclusive(path.join(journal, "pin.json"), JSON.stringify({ version: 1,
      dev: String(originalLock.dev), ino: String(originalLock.ino), ownerNonce: lockOwner?.nonce ?? null }) + "\n");
  }
  const journalIdentity = inspect(journal, true, true);
  const moved = path.join(journal, "writer.lock"), rawPin = readBounded(path.join(journal, "pin.json"));
  if (rawPin !== null) {
    if (Buffer.byteLength(rawPin) > 4096) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
    const pin = strictJson(rawPin) as Record<string, unknown>;
    if (Object.keys(pin).length !== 4 || pin.version !== 1 || !/^(0|[1-9][0-9]*)$/.test(String(pin.dev)) ||
        !/^(0|[1-9][0-9]*)$/.test(String(pin.ino)) || !(pin.ownerNonce === null || uuid(pin.ownerNonce))) {
      throw new Error("ENV_MAINTENANCE_INCOMPLETE");
    }
    if (originalLock) {
      if (entryExists(moved) || String(originalLock.dev) !== pin.dev || String(originalLock.ino) !== pin.ino ||
          (lockOwner?.nonce ?? null) !== pin.ownerNonce) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
      fs.renameSync(lock, moved); fsyncDirectory(parent); fsyncDirectory(journal);
    }
    if (entryExists(moved)) {
      const pinned = inspect(moved, true, true);
      if (String(pinned.dev) !== pin.dev || String(pinned.ino) !== pin.ino) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
      const currentOwner = ownerRecord(path.join(moved, "owner.json"));
      if (currentOwner && currentOwner.nonce !== pin.ownerNonce) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
      if (fs.readdirSync(moved).some(name => name !== "owner.json")) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
      if (currentOwner) { fs.unlinkSync(path.join(moved, "owner.json")); fsyncDirectory(moved); }
      fs.rmdirSync(moved); fsyncDirectory(journal);
    }
    fs.unlinkSync(path.join(journal, "pin.json")); fsyncDirectory(journal);
  } else if (originalLock || entryExists(moved)) {
    // Journal mkdir-before-owner/pin may be resumed only with offline proof;
    // otherwise a replacement lock could be mistaken for the old one.
    if (!proof.offlineQuiescence(home) || entryExists(moved)) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
    const st = inspect(lock, true, true), owner = ownerRecord(path.join(lock, "owner.json"));
    durableWriteExclusive(path.join(journal, "pin.json"), JSON.stringify({ version: 1,
      dev: String(st.dev), ino: String(st.ino), ownerNonce: owner?.nonce ?? null }) + "\n");
    throw new Error("ENV_MAINTENANCE_RETRY_REQUIRED");
  }
  if (entryExists(lock) || !same(pinnedParent, inspect(parent, true, true)) ||
      !same(guardIdentity, inspect(guard, true, true)) || !same(journalIdentity, inspect(journal, true, true))) {
    throw new Error("ENV_MAINTENANCE_INCOMPLETE");
  }
  const journalOwner = path.join(journal, "owner.json");
  if (entryExists(journalOwner)) { inspect(journalOwner, false, true); fs.unlinkSync(journalOwner); fsyncDirectory(journal); }
  fs.rmdirSync(journal); fsyncDirectory(parent);
  const guardOwner = path.join(guard, "owner.json");
  if (entryExists(guardOwner)) { inspect(guardOwner, false, true); fs.unlinkSync(guardOwner); fsyncDirectory(guard); }
  fs.rmdirSync(guard); fsyncDirectory(parent);
  return true;
}
export function commitConfigUnderLock(home: string, next: Config): void {
  const parent = path.join(home, "environment");
  const bytes = JSON.stringify(validateConfig(next), null, 2) + "\n";
  if (Buffer.byteLength(bytes) > MAX_CONFIG_BYTES) throw new Error("ENV_CONFIG_TOO_LARGE");
  const temporary = path.join(parent, `.config-${randomBytes(16).toString("hex")}.tmp`);
  const stop = path.join(parent, "commit-unknown");
  let renamed = false;
  try {
    durableWriteExclusive(temporary, bytes);
    durableWriteExclusive(stop, JSON.stringify({ version: 1, nonce: randomUUID() }) + "\n");
    fs.renameSync(temporary, configPath(home));
    renamed = true;
    fsyncDirectory(parent);
    fs.unlinkSync(stop);
    fsyncDirectory(parent);
  } catch (e) {
    if (renamed || fs.existsSync(stop)) throw new Error("ENV_COMMIT_OUTCOME_UNKNOWN");
    try { fs.unlinkSync(temporary); } catch { /* preserve original failure */ }
    throw e;
  }
}
export function mutateConfig(home: string, expected: number, change: (c: Config) => Config): Config {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("ENV_EXPECTED_REVISION_REQUIRED");
  const nextFor = (locked: Config): Config => {
    if (locked.revision !== expected) throw new Error("ENV_REVISION_CONFLICT");
    const next = validateConfig(change(structuredClone(locked)));
    if (locked.version === 2 && next.version === 2) {
      if (next.authorityGeneration < locked.authorityGeneration) throw new Error("ENV_AUTH_STATE_DRIFT");
      for (const [id, b] of Object.entries(locked.bindings)) {
        const n = next.bindings[id];
        if (!n || n.securityEpoch < b.securityEpoch) throw new Error("ENV_AUTH_STATE_DRIFT");
        if (JSON.stringify(n) !== JSON.stringify(b) && n.securityEpoch === b.securityEpoch) throw new Error("ENV_AUTH_STATE_DRIFT");
      }
      for (const [id, p] of Object.entries(locked.projectEnrollments)) {
        const n = next.projectEnrollments[id];
        if (!n || n.securityEpoch < p.securityEpoch) throw new Error("ENV_AUTH_STATE_DRIFT");
        if (JSON.stringify(n) !== JSON.stringify(p) && n.securityEpoch === p.securityEpoch) throw new Error("ENV_AUTH_STATE_DRIFT");
      }
    } else if (locked.version === 2) throw new Error("ENV_AUTH_STATE_DRIFT");
    next.revision = expected + 1;
    if (!Number.isSafeInteger(next.revision)) throw new Error("ENV_REVISION_EXHAUSTED");
    return next;
  };
  // Reject invalid changes before writer-lock creation. Recompute from the
  // locked config so the preview never substitutes for the CAS authority.
  nextFor(readConfig(home));
  return withWriterLock(home, () => {
    const next = nextFor(readConfig(home));
    commitConfigUnderLock(home, next);
    return next;
  });
}
