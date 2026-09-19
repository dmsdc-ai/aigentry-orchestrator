/**
 * Preservation core v1/v2 — Node built-ins only; no caller activation or CLI.
 *
 * Trust boundary: callers supply complete, freshly rendered package bytes and
 * independently verified per-file old baselines. A source/aggregate stamp alone
 * is NOT a baseline. Callers own package verification, substitution, human
 * interaction, absence-only config merging and runtime adoption gates.
 *
 * plan(input) is read-only and returns a deeply frozen, process-local Plan.
 * apply(plan, {input, decisions, validateReplacement}) requires fresh input
 * identical to the preview. Only the live validator may attest that a decision
 * is an exact, current per-file human replacement decision. Serialized plans,
 * --force, --yes and decision-shaped JSON confer no authority on their own.
 * inspectPending({roots}) reads fixed root locks. inspectOperation/restore take
 * {roots, operationId, planId}; receipt paths never select roots or file paths.
 *
 * Supported: existing canonical, user-owned workspace/home roots and an existing
 * private (0700) backup root, disjoint, on local macOS/Linux filesystems. Target
 * parent directories must already exist unless explicitly declared below. Missing roots, config/state/
 * unknown entries, unreadable output modes, ACL/xattr fidelity, special bits, native Windows and automatic
 * recovery of an interrupted executor are explicit unsupported gates. No root
 * bootstrap, migration, expiry, automatic rollback or metadata stamp special ordering.
 * Caller must supply an ordered inventory (e.g. stamp last) and keep boot blocked
 * until apply succeeds. Workspace/home writes are recoverable per-file renames,
 * NOT a cross-filesystem atomic transaction.
 *
 * All callers/writers must respect fixed locks and keep trusted roots, ancestors,
 * backup storage and input bytes quiescent. O_NOFOLLOW and identity rechecks narrow
 * races; portable Node APIs cannot prove safety against a hostile filesystem.
 * No PID lock stealing: a crash with executor/ownerless lock left behind refuses
 * mutation. An external recovery owner must establish process quiescence and
 * release ONLY that executor/ownerless lock before explicit restore; this module
 * exposes no unlock/steal API. Backups and target ownership locks remain intact.
 * inspectPending exposes this gate even if no receipt could yet be persisted.
 *
 * Restore preserves bytes, uid/gid/mode and atime/mtime within 1 millisecond.
 * ctime/birthtime, ACLs, xattrs and directory timestamps are not restorable here;
 * callers must exclude files requiring that fidelity. No-op contents, mode and
 * mtime are untouched (reads may change atime). Receipt checksums detect damage,
 * not malicious modification by the trusted owner. Fsync is mandatory for files;
 * unsupported directory fsync is recorded in durabilityWarnings, never hidden.
 *
 * API delta: optional Input.directories is an exact array of
 * {root:'workspace'|'home', path:nonemptyCanonicalRelativePath, mode:0700}.
 * Supplying it (including []) selects schemaVersion 2 plans/receipts, with
 * directories, directoryParents and directoryRoots snapshots. Omission retains
 * the v1 API/receipt format. Missing parent chains must be explicitly declared;
 * existing directories are never chmodded or removed. .git and preservation
 * namespaces are forbidden. Empty state directories confer no file authority.
 * Status v2 adds directoryProgress ({state, identity} per declaration).
 * Created directories are removed only when verified and empty, deepest first.
 * Interrupted mkdir or removal without durable completion requires external
 * recovery; inspect/restore never adopt an unrecorded inode. Root bootstrap,
 * config/state file policy and installer integration remain caller-owned gaps.
 *
 * @typedef {{workspace:string, home:string, backup:string}} Roots
 * @typedef {{root:'workspace'|'home', path:string,
 *   kind:'package'|'state'|'config'|'unknown', bytes:Uint8Array,
 *   mode:number, baseline:null|{hash:string, mode:number}}} OutputEntry
 * @typedef {{root:'workspace'|'home', path:string, mode:number}} DirectoryEntry
 * @typedef {{roots:Roots, sourceHash:string, entries:OutputEntry[], directories?:DirectoryEntry[]}} Input
 * @typedef {{schemaVersion:1|2, operationId:string, planId:string,
 *   inputHash:string, roots:Roots, rootIdentities:object,
 *   entries:object[], refusals:object[], timestampPrecision:string,
 *   directories?:object[], directoryParents?:object[], directoryRoots?:object}} Plan
 * @typedef {{operationId:string, planId:string, root:string, path:string,
 *   beforeHash:string, desiredHash:string}} ReplacementDecision
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const VERSION = 1;
const PREFIX = ".aigentry-preservation";
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ROOT_NAMES = ["workspace", "home", "backup"];
const TARGET_NAMES = ROOT_NAMES.slice(0, 2);
const plans = new WeakMap();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const alias = (value) => value.normalize("NFC").toLowerCase();
const canonical = (value) => JSON.stringify(value, (_, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const same = (a, b) => canonical(a) === canonical(b);

/** Refusals use exitCode 8; an operation requiring recovery uses exitCode 9. */
export class PreservationError extends Error {
  constructor(code, message, operationId = null) {
    super(message);
    this.name = "PreservationError";
    this.code = code;
    this.exitCode = operationId ? 9 : 8;
    this.operationId = operationId;
  }
}
function insist(condition, code, message) {
  if (!condition) throw new PreservationError(code, message);
}
function object(value, keys, label) {
  insist(value && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length &&
    same(Object.keys(value).sort(), [...keys].sort()) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor),
  "SCHEMA", `Invalid ${label} structure`);
}
function array(value, label) {
  insist(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Object.keys(value).every((key, index) => key === String(index)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor),
  "SCHEMA", `Invalid ${label} array`);
}
function hash(value) {
  insist(typeof value === "string" && HASH.test(value), "SCHEMA", "Invalid SHA-256");
}
function mode(value) {
  insist(Number.isInteger(value) && value >= 0 && value <= 0o777,
    "UNSUPPORTED_METADATA", "Only ordinary permission bits are supported");
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function stat(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function directory(file, privateMode = false) {
  const value = stat(file);
  insist(value?.isDirectory() && !value.isSymbolicLink(), "UNSAFE_PATH", `Not a regular directory: ${file}`);
  insist(value.uid === BigInt(process.getuid()) && (Number(value.mode) & 0o022) === 0,
    "UNTRUSTED_ROOT", `Directory must be owned and not writable by other users: ${file}`);
  if (privateMode) insist((Number(value.mode) & 0o777) === 0o700,
    "PRIVATE_MODE", `Directory must have mode 0700: ${file}`);
  return { dev: String(value.dev), ino: String(value.ino) };
}
function absolute(file) {
  insist(typeof file === "string" && path.isAbsolute(file) && file !== "/" &&
    !/[\x00-\x1f\x7f]/.test(file) && path.normalize(file) === file &&
    !file.endsWith(path.sep), "UNSAFE_PATH", "Expected a canonical absolute path");
}
function relative(file) {
  insist(typeof file === "string" && file.length > 0 && !file.startsWith("/") &&
    !/[\\:\x00-\x1f\x7f]/.test(file), "UNSAFE_PATH", "Invalid root-relative path");
  for (const part of file.split("/")) insist(part !== "" && part !== "." && part !== ".." &&
    !part.endsWith(".") && !part.endsWith(" ") && !alias(part).startsWith(PREFIX),
  "UNSAFE_PATH", "Traversal, ambiguous or reserved path component");
}
function ancestors(file) {
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const value = stat(current);
    insist(value?.isDirectory() && !value.isSymbolicLink(), "UNSUPPORTED_PARENT",
      `Missing or unsafe directory; caller must provision it first: ${current}`);
  }
}
function validateRoots(roots) {
  insist(["darwin", "linux"].includes(process.platform) && typeof process.getuid === "function",
    "UNSUPPORTED_PLATFORM", "Only macOS/Linux are supported");
  object(roots, ROOT_NAMES, "roots");
  const identities = {};
  for (const name of ROOT_NAMES) {
    absolute(roots[name]);
    ancestors(roots[name]);
    insist(fs.realpathSync.native(roots[name]) === roots[name], "UNSAFE_PATH", "Root is not canonical");
    identities[name] = directory(roots[name], name === "backup");
  }
  for (let i = 0; i < ROOT_NAMES.length; i++) for (let j = i + 1; j < ROOT_NAMES.length; j++) {
    const a = ROOT_NAMES[i], b = ROOT_NAMES[j];
    const x = alias(roots[a]), y = alias(roots[b]);
    insist(x !== y && !x.startsWith(`${y}/`) && !y.startsWith(`${x}/`) &&
      !same(identities[a], identities[b]), "ROOT_OVERLAP", "Roots overlap or alias");
  }
  return identities;
}
function destination(roots, entry) {
  insist(TARGET_NAMES.includes(entry.root), "SCHEMA", "Invalid target root");
  relative(entry.path);
  const file = path.join(roots[entry.root], entry.path);
  ancestors(path.dirname(file));
  directory(path.dirname(file));
  return file;
}
function protectedEntry(entry) {
  const file = alias(entry.path);
  return entry.kind !== "package" ||
    (entry.root === "workspace" && (file === "state" || file.startsWith("state/") ||
      file === ".git" || file.startsWith(".git/"))) ||
    (entry.root === "home" && (file === "config.json" || file === "instructions/projects" ||
      file.startsWith("instructions/projects/")));
}
function normalizedInput(input) {
  if (input && Object.prototype.hasOwnProperty.call(input, "directories")) return normalizedDirectoryInput(input);
  object(input, ["roots", "sourceHash", "entries"], "input");
  hash(input.sourceHash);
  const rootIdentities = validateRoots(input.roots);
  array(input.entries, "entries");
  const aliases = new Set(), inodes = new Set();
  const entries = input.entries.map((entry) => {
    object(entry, ["root", "path", "kind", "bytes", "mode", "baseline"], "entry");
    insist(["package", "state", "config", "unknown"].includes(entry.kind), "SCHEMA", "Invalid entry kind");
    insist(entry.bytes instanceof Uint8Array, "SCHEMA", "Rendered bytes must be Uint8Array");
    mode(entry.mode);
    insist((entry.mode & 0o400) !== 0, "UNSUPPORTED_METADATA", "Output must remain readable by its owner for verification");
    if (entry.baseline !== null) {
      object(entry.baseline, ["hash", "mode"], "baseline");
      hash(entry.baseline.hash); mode(entry.baseline.mode);
    }
    const file = destination(input.roots, entry);
    const key = alias(file);
    insist(!aliases.has(key), "DUPLICATE_ALIAS", "Duplicate destination alias");
    for (const previous of aliases) insist(!key.startsWith(`${previous}/`) && !previous.startsWith(`${key}/`),
      "DUPLICATE_ALIAS", "A destination is another destination's ancestor");
    aliases.add(key);
    const parentIdentity = directory(path.dirname(file));
    const inodeKey = `${parentIdentity.dev}:${parentIdentity.ino}:${alias(path.basename(file))}`;
    insist(!inodes.has(inodeKey), "DUPLICATE_ALIAS", "Duplicate physical destination");
    inodes.add(inodeKey);
    return { root: entry.root, path: entry.path, kind: entry.kind, mode: entry.mode,
      baseline: entry.baseline && { ...entry.baseline },
      bytes: Buffer.from(entry.bytes).toString("base64"), parentIdentity };
  });
  return { roots: { ...input.roots }, sourceHash: input.sourceHash, rootIdentities, entries };
}
// v2 paths are inert until the complete directory inventory has been checked.
function boundedTarget(roots, entry) {
  insist(TARGET_NAMES.includes(entry.root), "SCHEMA", "Invalid target root");
  relative(entry.path);
  insist(entry.path.normalize("NFC") === entry.path, "UNSAFE_PATH", "Noncanonical Unicode path");
  return path.join(roots[entry.root], entry.path);
}
function directoryIdentity(file) {
  directory(file);
  insist(fs.realpathSync.native(file) === file, "UNSAFE_PATH", "Directory path is not canonical");
  const value = stat(file);
  insist(value?.isDirectory() && !value.isSymbolicLink() && value.uid === BigInt(process.getuid()) &&
    (Number(value.mode) & 0o7022) === 0, "UNSAFE_PATH", "Unsafe directory metadata");
  return { dev: String(value.dev), ino: String(value.ino), uid: Number(value.uid), mode: Number(value.mode) & 0o777 };
}
function directoryIdentityShape(value) {
  object(value, ["dev", "ino", "uid", "mode"], "directory identity");
  for (const key of ["dev", "ino"]) insist(typeof value[key] === "string" && /^\d+$/.test(value[key]), "SCHEMA", "Invalid directory identity");
  mode(value.mode);
  insist(value.uid === process.getuid() && (value.mode & 0o022) === 0, "SCHEMA", "Unsafe directory owner/mode");
}
function uniqueDirectoryIdentities(identities) {
  const seen = new Set();
  for (const identity of identities) {
    if (!identity) continue;
    const key = `${identity.dev}:${identity.ino}`;
    insist(!seen.has(key), "DUPLICATE_ALIAS", "Directory inventory contains a physical alias");
    seen.add(key);
  }
}
function boundedTargetLock(roots, entry) {
  const file = boundedTarget(roots, entry);
  return path.join(path.dirname(file), `${PREFIX}-${digest(alias(path.basename(file)))}.lock`);
}
function boundedStage(roots, entry, id, restoring = false) {
  return path.join(path.dirname(boundedTarget(roots, entry)), `${PREFIX}-${id}-${entry.index}-${restoring ? "restore" : "apply"}.tmp`);
}
function directoryLayout(roots, declarations, entries) {
  const declared = new Map(), spellings = new Map(), files = new Set(), needed = new Map();
  function register(entry) {
    const file = boundedTarget(roots, entry);
    let current = roots[entry.root];
    for (const component of entry.path.split("/")) {
      current = path.join(current, component);
      const key = alias(current);
      insist(!spellings.has(key) || spellings.get(key) === current, "DUPLICATE_ALIAS", "Normalized component alias");
      spellings.set(key, current);
    }
    return file;
  }
  for (const entry of declarations) {
    insist(entry.mode === 0o700, "SCHEMA", "Directory declarations require mode 0700");
    const file = register(entry);
    insist(!entry.path.split("/").some((part) => alias(part) === ".git"), "UNSAFE_PATH", "Reserved .git directory");
    insist(!declared.has(file), "DUPLICATE_ALIAS", "Duplicate directory declaration");
    declared.set(file, entry);
  }
  for (const entry of entries) {
    const file = register(entry);
    insist(!files.has(file) && !declared.has(file), "DUPLICATE_ALIAS", "Duplicate file or file-directory overlap");
    files.add(file);
  }
  for (const entry of [...declarations, ...entries]) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = { root: entry.root, path: parts.slice(0, i).join("/") };
      const file = boundedTarget(roots, parent);
      insist(!files.has(file), "DUPLICATE_ALIAS", "A file is an inventory ancestor");
      needed.set(file, parent);
    }
  }
  for (const [file, entry] of declared) needed.set(file, entry);
  return { declared, needed: [...needed].sort(([a], [b]) => a.split("/").length - b.split("/").length || a.localeCompare(b)) };
}
function normalizedDirectoryInput(input) {
  object(input, ["roots", "sourceHash", "entries", "directories"], "directory input");
  hash(input.sourceHash);
  const rootIdentities = validateRoots(input.roots);
  array(input.entries, "entries"); array(input.directories, "directories");
  const declarations = input.directories.map((entry) => {
    object(entry, ["root", "path", "mode"], "directory declaration");
    return { ...entry };
  });
  const entries = input.entries.map((entry) => {
    object(entry, ["root", "path", "kind", "bytes", "mode", "baseline"], "entry");
    insist(["package", "state", "config", "unknown"].includes(entry.kind), "SCHEMA", "Invalid entry kind");
    insist(entry.bytes instanceof Uint8Array, "SCHEMA", "Rendered bytes must be Uint8Array");
    mode(entry.mode);
    insist((entry.mode & 0o400) !== 0, "UNSUPPORTED_METADATA", "Output must remain readable by its owner for verification");
    if (entry.baseline !== null) {
      object(entry.baseline, ["hash", "mode"], "baseline"); hash(entry.baseline.hash); mode(entry.baseline.mode);
    }
    return { root: entry.root, path: entry.path, kind: entry.kind, mode: entry.mode,
      baseline: entry.baseline && { ...entry.baseline }, bytes: Buffer.from(entry.bytes).toString("base64") };
  });
  const layout = directoryLayout(input.roots, declarations, entries), identities = new Map(), directoryParents = [];
  for (const [file, entry] of layout.needed) {
    const identity = stat(file) ? directoryIdentity(file) : null;
    insist(identity || layout.declared.has(file), "UNSUPPORTED_PARENT", `Missing undeclared parent: ${file}`);
    identities.set(file, identity);
    if (!layout.declared.has(file)) directoryParents.push({ root: entry.root, path: entry.path, identity });
  }
  const directoryRoots = Object.fromEntries(ROOT_NAMES.map((name) => [name, directoryIdentity(input.roots[name])]));
  uniqueDirectoryIdentities([...Object.values(directoryRoots), ...identities.values()]);
  const physical = new Set();
  for (const entry of entries) {
    const file = boundedTarget(input.roots, entry), parent = path.dirname(file);
    const identity = parent === input.roots[entry.root] ? directoryRoots[entry.root] : identities.get(parent);
    entry.parentIdentity = identity ? { dev: identity.dev, ino: identity.ino } : null;
    if (identity) {
      const key = `${identity.dev}:${identity.ino}:${alias(path.basename(file))}`;
      insist(!physical.has(key), "DUPLICATE_ALIAS", "Duplicate physical destination"); physical.add(key);
    }
    if (stat(file)) insist(fs.realpathSync.native(file) === file, "UNSAFE_PATH", "File path is not canonical");
  }
  return { roots: { ...input.roots }, sourceHash: input.sourceHash, rootIdentities, entries,
    directories: declarations.map((entry) => ({ ...entry, before: identities.get(boundedTarget(input.roots, entry)) })),
    directoryParents, directoryRoots };
}
function metadata(value) {
  return { hash: null, dev: String(value.dev), ino: String(value.ino),
    size: String(value.size), mode: Number(value.mode) & 0o777,
    uid: Number(value.uid), gid: Number(value.gid),
    atimeNs: String(value.atimeNs), mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) };
}
function precondition(value) {
  if (!value) return null;
  const { atimeNs, ...rest } = value;
  return rest;
}
function readRegular(file) {
  const before = stat(file);
  if (!before) return null;
  insist(before.isFile() && before.nlink === 1n && !before.isSymbolicLink(),
    "UNSAFE_TARGET", `Refusing symlink, special or hardlinked file: ${file}`);
  insist((Number(before.mode) & 0o7000) === 0 && before.uid === BigInt(process.getuid()),
    "UNSUPPORTED_METADATA", `File ownership or special permissions unsupported: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    insist(opened.isFile() && opened.nlink === 1n &&
      same(precondition(metadata(before)), precondition(metadata(opened))), "STALE_DESTINATION", "File changed during open");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    insist(same(precondition(metadata(opened)), precondition(metadata(after))),
      "STALE_DESTINATION", "File changed during read");
    return { bytes, meta: { ...metadata(before), hash: digest(bytes) } };
  } finally { fs.closeSync(fd); }
}
function snapshot(file) { return readRegular(file)?.meta ?? null; }
function assertBefore(roots, entry) {
  const file = destination(roots, entry);
  insist(same(directory(path.dirname(file)), entry.parentIdentity), "STALE_PARENT", "Parent directory changed");
  insist(same(precondition(snapshot(file)), precondition(entry.before)),
    "STALE_DESTINATION", `Destination differs from frozen plan: ${file}`);
}
function rootLock(roots, name) { return path.join(roots[name], `${PREFIX}.lock`); }
function targetLock(roots, entry) {
  const file = destination(roots, entry);
  return path.join(path.dirname(file), `${PREFIX}-${digest(alias(path.basename(file)))}.lock`);
}
function allLocks(roots, entries) {
  // Acquire roots first and release them last: a partial release remains visible.
  return [...TARGET_NAMES.map((name) => rootLock(roots, name)).sort(),
    ...[...new Set(entries.map((entry) => targetLock(roots, entry)))].sort()];
}
function lockOwner(file) {
  if (!stat(file)) return null;
  directory(file, true);
  const record = readRegular(path.join(file, "owner.json"));
  insist(record, "OWNERLESS_LOCK", `Unfinished ownership acquisition: ${file}`);
  insist(record.meta.mode === 0o600, "PRIVATE_MODE", "Lock owner must have mode 0600");
  const owner = JSON.parse(record.bytes.toString("utf8"));
  object(owner, ["schemaVersion", "operationId", "planId", "backupRoot"], "lock owner");
  insist(owner.schemaVersion === VERSION && UUID.test(owner.operationId), "SCHEMA", "Invalid lock identity");
  hash(owner.planId); absolute(owner.backupRoot);
  return owner;
}

/** Read-only root-level pending status; owner paths are inert information. */
export function inspectPending(request) {
  object(request, ["roots"], "pending request");
  const { roots } = request;
  validateRoots(roots);
  return freeze(TARGET_NAMES.flatMap((root) => {
    const file = rootLock(roots, root);
    if (!stat(file)) return [];
    try { return [{ root, status: "pending", owner: lockOwner(file) }]; }
    catch (error) { return [{ root, status: "blocked", code: error.code ?? "INVALID_LOCK" }]; }
  }));
}

/** @param {Input} input @returns {Plan} No destination or administrative writes. */
export function plan(input) {
  const normalized = normalizedInput(input);
  const pending = inspectPending({ roots: normalized.roots });
  insist(pending.length === 0, "PENDING_OPERATION", "A target has an unfinished operation");
  const entries = normalized.entries.map(({ bytes, ...entry }, index) => {
    const file = normalized.directories ? boundedTarget(normalized.roots, entry) : destination(normalized.roots, entry);
    const lock = normalized.directories ? boundedTargetLock(normalized.roots, entry) : targetLock(normalized.roots, entry);
    insist(!stat(lock), "PENDING_OPERATION", "Destination ownership is held");
    const before = snapshot(file), desiredHash = digest(Buffer.from(bytes, "base64"));
    // Ownership kind takes precedence even if bytes happen to match.
    const action = protectedEntry(entry) ? "unsupported" : !before ? "create" :
      before.hash === desiredHash && before.mode === entry.mode ? "unchanged" :
      entry.baseline?.hash === before.hash && entry.baseline.mode === before.mode ? "replace-package" : "conflict";
    return { ...entry, index, before, desiredHash, action };
  });
  const body = { schemaVersion: normalized.directories ? 2 : VERSION, operationId: randomUUID(),
    inputHash: digest(canonical(normalized)), roots: normalized.roots,
    rootIdentities: normalized.rootIdentities, entries,
    refusals: entries.filter((entry) => ["conflict", "unsupported"].includes(entry.action))
      .map(({ root, path: relativePath, action }) => ({ root, path: relativePath, reason: action })),
    timestampPrecision: "restore-atime-mtime-within-1ms; no-op-mtime-exact" };
  if (normalized.directories) Object.assign(body, {
    directories: normalized.directories, directoryParents: normalized.directoryParents,
    directoryRoots: normalized.directoryRoots,
  });
  const result = freeze({ ...body, planId: digest(canonical(body)) });
  plans.set(result, normalized);
  return result;
}

function syncDirectory(file, warnings) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    try { fs.fsyncSync(fd); }
    catch (error) {
      if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
      if (!warnings.includes("directory-fsync-unsupported")) warnings.push("directory-fsync-unsupported");
    }
  } finally { fs.closeSync(fd); }
}
function writeExclusive(file, bytes, permissions = 0o600) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT |
    fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, permissions);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, permissions); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function ownerFor(planValue) {
  return { schemaVersion: VERSION, operationId: planValue.operationId,
    planId: planValue.planId, backupRoot: planValue.roots.backup };
}
function assertLocks(receipt) {
  const owner = ownerFor(receipt.plan);
  for (const file of allLocks(receipt.plan.roots, receipt.plan.entries))
    insist(same(lockOwner(file), owner), "CONCURRENT_OWNERSHIP", "Target lock is absent or belongs to another operation");
}
function operationDirectory(roots, id) {
  insist(typeof id === "string" && UUID.test(id), "SCHEMA", "Invalid operation UUID");
  return path.join(roots.backup, id);
}
function receiptBytes(receipt) {
  const payload = canonical(receipt);
  return canonical({ checksum: digest(payload), payload: receipt }) + "\n";
}
function saveReceipt(dir, receipt) {
  directory(dir, true);
  const existing = readRegular(path.join(dir, "operation.json"));
  insist(!existing || existing.meta.mode === 0o600, "PRIVATE_MODE", "Existing receipt is not private");
  const temporary = path.join(dir, `receipt-${randomUUID()}.tmp`);
  writeExclusive(temporary, receiptBytes(receipt));
  fs.renameSync(temporary, path.join(dir, "operation.json"));
  syncDirectory(dir, receipt.durabilityWarnings);
}
function stagePath(roots, entry, id, restore = false) {
  return path.join(path.dirname(destination(roots, entry)),
    `${PREFIX}-${id}-${entry.index}-${restore ? "restore" : "apply"}.tmp`);
}
function backupPath(dir, entry) { return path.join(dir, `${entry.index}.${entry.before ? "bin" : "absent"}`); }
function recordShape(value) {
  object(value, ["hash", "dev", "ino", "size", "mode", "uid", "gid", "atimeNs", "mtimeNs", "ctimeNs"], "file metadata");
  hash(value.hash); mode(value.mode);
  for (const key of ["dev", "ino", "size", "atimeNs", "mtimeNs", "ctimeNs"])
    insist(typeof value[key] === "string" && /^-?\d+$/.test(value[key]), "SCHEMA", "Invalid stat metadata");
  for (const key of ["uid", "gid"]) insist(Number.isSafeInteger(value[key]) && value[key] >= 0, "SCHEMA", "Invalid owner");
  for (const key of ["atimeNs", "mtimeNs"]) insist(Number.isSafeInteger(Math.round(Number(value[key]) / 1e6)),
    "UNSUPPORTED_METADATA", "Timestamp exceeds supported precision");
}
function validateStoredPlan(value, roots, id, planId) {
  object(value, ["schemaVersion", "operationId", "planId", "inputHash", "roots", "rootIdentities",
    "entries", "refusals", "timestampPrecision"], "stored plan");
  const { planId: storedHash, ...body } = value;
  insist(value.schemaVersion === VERSION && value.operationId === id && storedHash === planId &&
    digest(canonical(body)) === planId && same(value.roots, roots), "WRONG_OPERATION", "Receipt plan identity mismatch");
  hash(value.inputHash);
  insist(same(validateRoots(roots), value.rootIdentities), "STALE_ROOT", "Root identity changed");
  array(value.entries, "stored entries"); array(value.refusals, "stored refusals");
  insist(value.timestampPrecision === "restore-atime-mtime-within-1ms; no-op-mtime-exact", "SCHEMA", "Invalid stored precision");
  const seen = new Set();
  value.entries.forEach((entry, index) => {
    object(entry, ["root", "path", "kind", "mode", "baseline", "parentIdentity", "index", "before", "desiredHash", "action"], "stored entry");
    insist(entry.index === index && !protectedEntry(entry) &&
      ["create", "unchanged", "replace-package", "conflict"].includes(entry.action), "SCHEMA", "Invalid stored action");
    hash(entry.desiredHash); mode(entry.mode);
    if (entry.before) recordShape(entry.before);
    else insist(entry.before === null && entry.action === "create", "SCHEMA", "Invalid absence");
    if (entry.baseline !== null) {
      object(entry.baseline, ["hash", "mode"], "stored baseline"); hash(entry.baseline.hash); mode(entry.baseline.mode);
    }
    const file = destination(roots, entry), key = alias(file);
    insist(!seen.has(key) && same(directory(path.dirname(file)), entry.parentIdentity), "STALE_PARENT", "Receipt destination alias or parent drift");
    seen.add(key);
  });
}
function loadReceipt({ roots, operationId, planId }) {
  hash(planId); validateRoots(roots);
  const dir = operationDirectory(roots, operationId);
  directory(dir, true);
  const file = readRegular(path.join(dir, "operation.json"));
  insist(file && file.meta.mode === 0o600, "MISSING_RECEIPT", "Missing/private-mode-invalid operation receipt");
  const envelope = JSON.parse(file.bytes.toString("utf8"));
  object(envelope, ["checksum", "payload"], "receipt envelope");
  hash(envelope.checksum);
  insist(digest(canonical(envelope.payload)) === envelope.checksum, "CORRUPT_RECEIPT", "Receipt checksum mismatch");
  const receipt = envelope.payload;
  if (receipt?.schemaVersion === 2) {
    validateDirectoryReceipt(receipt, roots, operationId, planId);
    return { dir, receipt };
  }
  object(receipt, ["schemaVersion", "plan", "phase", "progress", "postimages", "restoreImages", "durabilityWarnings"], "receipt");
  insist(receipt.schemaVersion === VERSION && ["preparing", "prepared", "applying", "partial", "committed", "restoring", "restored"].includes(receipt.phase),
    "SCHEMA", "Invalid receipt phase");
  validateStoredPlan(receipt.plan, roots, operationId, planId);
  for (const key of ["progress", "postimages", "restoreImages"]) insist(Array.isArray(receipt[key]) &&
    receipt[key].length === receipt.plan.entries.length, "SCHEMA", "Invalid receipt inventory");
  insist(receipt.progress.every((value) => ["none", "staged", "written", "restored"].includes(value)), "SCHEMA", "Invalid progress");
  for (const value of [...receipt.postimages, ...receipt.restoreImages]) if (value !== null) recordShape(value);
  for (const entry of receipt.plan.entries) {
    const post = receipt.postimages[entry.index], restored = receipt.restoreImages[entry.index];
    insist(!post || (post.hash === entry.desiredHash && post.mode === entry.mode &&
      post.uid === process.getuid() && post.dev === entry.parentIdentity.dev), "CORRUPT_RECEIPT", "Postimage does not match planned output");
    insist(!restored || (entry.before && restored.hash === entry.before.hash && restored.mode === entry.before.mode &&
      restored.uid === entry.before.uid && restored.gid === entry.before.gid && restored.size === entry.before.size &&
      restored.dev === entry.parentIdentity.dev && restoredMatches(restored, entry.before)),
    "CORRUPT_RECEIPT", "Restoration image does not match original metadata");
    insist(!["staged", "written"].includes(receipt.progress[entry.index]) || post,
      "CORRUPT_RECEIPT", "Written/staged entry has no postimage identity");
  }
  insist(Array.isArray(receipt.durabilityWarnings) && receipt.durabilityWarnings.every((value) =>
    value === "directory-fsync-unsupported"), "SCHEMA", "Invalid durability warnings");
  return { dir, receipt };
}
function validateDirectoryReceipt(receipt, roots, operationId, planId) {
  object(receipt, ["schemaVersion", "plan", "phase", "progress", "postimages", "restoreImages", "durabilityWarnings", "directoryProgress"], "v2 receipt");
  const value = receipt.plan;
  object(value, ["schemaVersion", "operationId", "planId", "inputHash", "roots", "rootIdentities", "entries", "refusals",
    "timestampPrecision", "directories", "directoryParents", "directoryRoots"], "v2 plan");
  const { planId: storedHash, ...body } = value;
  insist(receipt.schemaVersion === 2 && value.schemaVersion === 2 && value.operationId === operationId &&
    storedHash === planId && digest(canonical(body)) === planId && same(value.roots, roots), "WRONG_OPERATION", "Receipt plan identity mismatch");
  hash(value.inputHash);
  insist(same(validateRoots(roots), value.rootIdentities), "STALE_ROOT", "Root identity changed");
  insist(["preparing", "prepared", "applying", "partial", "committed", "restoring", "restored"].includes(receipt.phase), "SCHEMA", "Invalid receipt phase");
  insist(value.timestampPrecision === "restore-atime-mtime-within-1ms; no-op-mtime-exact", "SCHEMA", "Invalid stored precision");
  for (const key of ["entries", "directories", "directoryParents", "refusals"]) array(value[key], key);
  object(value.directoryRoots, ROOT_NAMES, "directory roots");
  for (const name of ROOT_NAMES) {
    directoryIdentityShape(value.directoryRoots[name]);
    insist(same(value.rootIdentities[name], { dev: value.directoryRoots[name].dev, ino: value.directoryRoots[name].ino }), "SCHEMA", "Inconsistent root snapshots");
  }
  const planned = new Map(ROOT_NAMES.map((name) => [roots[name], value.directoryRoots[name]]));
  for (const entry of value.directories) {
    object(entry, ["root", "path", "mode", "before"], "stored directory");
    if (entry.before !== null) directoryIdentityShape(entry.before);
    planned.set(boundedTarget(roots, entry), entry.before);
  }
  const layout = directoryLayout(roots, value.directories, value.entries);
  const parents = layout.needed.filter(([file]) => !layout.declared.has(file));
  insist(parents.length === value.directoryParents.length, "SCHEMA", "Incomplete directory parent inventory");
  value.directoryParents.forEach((entry, index) => {
    object(entry, ["root", "path", "identity"], "stored directory parent");
    directoryIdentityShape(entry.identity);
    const file = boundedTarget(roots, entry);
    insist(file === parents[index][0], "SCHEMA", "Directory parent inventory mismatch");
    planned.set(file, entry.identity);
  });
  for (const [file] of layout.needed) insist(!planned.get(file) || planned.get(path.dirname(file)), "SCHEMA", "Existing directory has an absent parent");
  uniqueDirectoryIdentities(planned.values());
  value.entries.forEach((entry, index) => {
    object(entry, ["root", "path", "kind", "mode", "baseline", "parentIdentity", "index", "before", "desiredHash", "action"], "v2 stored entry");
    insist(entry.index === index && !protectedEntry(entry) && ["create", "unchanged", "replace-package", "conflict"].includes(entry.action), "SCHEMA", "Invalid stored action");
    hash(entry.desiredHash); mode(entry.mode);
    insist((entry.mode & 0o400) !== 0, "SCHEMA", "Unreadable output");
    if (entry.baseline !== null) {
      object(entry.baseline, ["hash", "mode"], "stored baseline"); hash(entry.baseline.hash); mode(entry.baseline.mode);
    }
    const parent = planned.get(path.dirname(boundedTarget(roots, entry)));
    insist(same(entry.parentIdentity, parent ? { dev: parent.dev, ino: parent.ino } : null), "SCHEMA", "File parent snapshot mismatch");
    if (entry.before !== null) { recordShape(entry.before); insist(parent, "SCHEMA", "Original file has absent parent"); }
    const action = !entry.before ? "create" : entry.before.hash === entry.desiredHash && entry.before.mode === entry.mode ? "unchanged" :
      entry.baseline?.hash === entry.before.hash && entry.baseline.mode === entry.before.mode ? "replace-package" : "conflict";
    insist(entry.action === action, "SCHEMA", "Inconsistent file action");
  });
  insist(same(value.refusals, value.entries.filter((entry) => entry.action === "conflict")
    .map((entry) => ({ root: entry.root, path: entry.path, reason: "conflict" }))), "SCHEMA", "Invalid refusals");
  array(receipt.directoryProgress, "directory progress");
  insist(receipt.directoryProgress.length === value.directories.length, "SCHEMA", "Directory progress inventory mismatch");
  receipt.directoryProgress.forEach((item, index) => {
    object(item, ["state", "identity"], "directory progress item");
    const entry = value.directories[index];
    if (entry.before) insist(item.state === "existing" && same(item.identity, entry.before), "SCHEMA", "Existing directory ownership changed");
    else if (["none", "pending"].includes(item.state)) insist(item.identity === null, "SCHEMA", "Unrecorded directory has identity");
    else {
      insist(["created", "removing", "removed"].includes(item.state), "SCHEMA", "Invalid directory progress");
      directoryIdentityShape(item.identity);
      insist(item.identity.mode === 0o700, "SCHEMA", "Created directory must be private");
    }
  });
  uniqueDirectoryIdentities([...Object.values(value.directoryRoots), ...value.directoryParents.map((entry) => entry.identity),
    ...receipt.directoryProgress.map((item) => item.identity)]);
  for (const key of ["progress", "postimages", "restoreImages"]) {
    array(receipt[key], key); insist(receipt[key].length === value.entries.length, "SCHEMA", "Invalid file progress inventory");
  }
  insist(receipt.progress.every((item) => ["none", "staged", "written", "restored"].includes(item)), "SCHEMA", "Invalid file progress");
  for (const image of [...receipt.postimages, ...receipt.restoreImages]) if (image !== null) recordShape(image);
  for (const entry of value.entries) {
    const parentFile = path.dirname(boundedTarget(roots, entry));
    const parentIndex = value.directories.findIndex((item) => boundedTarget(roots, item) === parentFile);
    const parent = parentIndex >= 0 ? receipt.directoryProgress[parentIndex].identity : planned.get(parentFile);
    const post = receipt.postimages[entry.index], restored = receipt.restoreImages[entry.index];
    insist(!post || (parent && post.hash === entry.desiredHash && post.mode === entry.mode && post.uid === process.getuid() && post.dev === parent.dev), "CORRUPT_RECEIPT", "Invalid directory file postimage");
    insist(!restored || (parent && entry.before && restored.dev === parent.dev && restoredMatches(restored, entry.before)), "CORRUPT_RECEIPT", "Invalid restored image");
    insist(!["staged", "written"].includes(receipt.progress[entry.index]) || post, "CORRUPT_RECEIPT", "Missing file postimage");
  }
  array(receipt.durabilityWarnings, "durability warnings");
  insist(receipt.durabilityWarnings.every((item) => item === "directory-fsync-unsupported"), "SCHEMA", "Invalid durability warning");
}
function checkDirectories(receipt, transitioning = -1) {
  checkRoots(receipt);
  const value = receipt.plan;
  for (const name of ROOT_NAMES) insist(same(directoryIdentity(value.roots[name]), value.directoryRoots[name]), "STALE_ROOT", "Root owner/mode/identity changed");
  const inventory = [
    ...value.directoryParents.map((entry) => ({ ...entry, expected: entry.identity })),
    ...value.directories.map((entry, index) => {
      const item = receipt.directoryProgress[index];
      insist(index === transitioning || !["pending", "removing"].includes(item.state), "UNKNOWN_DIRECTORY", "Directory operation lacks durable completion; external recovery required");
      return { ...entry, expected: ["existing", "created", "removing"].includes(item.state) ? item.identity : null };
    }),
  ].sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  uniqueDirectoryIdentities([...Object.values(value.directoryRoots), ...inventory.map((entry) => entry.expected)]);
  for (const entry of inventory) {
    const file = boundedTarget(value.roots, entry), current = stat(file);
    insist(entry.expected ? current && same(directoryIdentity(file), entry.expected) : !current,
      "STALE_DIRECTORY", `Directory absence/identity changed: ${file}`);
  }
}
function directoryRootLocks(receipt) {
  return TARGET_NAMES.map((name) => rootLock(receipt.plan.roots, name)).sort();
}
function directoryFileLocks(receipt) {
  return [...new Set(receipt.plan.entries.map((entry) => boundedTargetLock(receipt.plan.roots, entry)))]
    .filter((file) => stat(path.dirname(file))).sort();
}
function assertDirectoryLocks(receipt, files = directoryRootLocks(receipt)) {
  for (const file of files) insist(same(lockOwner(file), ownerFor(receipt.plan)), "CONCURRENT_OWNERSHIP", "Directory operation lock is absent or foreign");
}
function acquireDirectoryLocks(receipt, files, recovery = false) {
  for (const [index, file] of files.entries()) {
    checkDirectories(receipt);
    assertDirectoryLocks(receipt, files.slice(0, index));
    if (!directoryRootLocks(receipt).includes(file)) assertDirectoryLocks(receipt);
    const current = lockOwner(file);
    insist(current === null || (recovery && same(current, ownerFor(receipt.plan))), "CONCURRENT_OWNERSHIP", "A target lock is already held");
    if (current) continue;
    fs.mkdirSync(file, { mode: 0o700 });
    writeExclusive(path.join(file, "owner.json"), canonical(ownerFor(receipt.plan)) + "\n");
    syncDirectory(file, receipt.durabilityWarnings); syncDirectory(path.dirname(file), receipt.durabilityWarnings);
  }
  assertDirectoryLocks(receipt, files);
}
function releaseDirectoryLocks(receipt, files, roots = false) {
  for (let index = files.length - 1; index >= 0; index--) {
    const file = files[index];
    checkDirectories(receipt); assertDirectoryLocks(receipt, roots ? files.slice(0, index + 1) : directoryRootLocks(receipt));
    if (!stat(file)) continue;
    assertDirectoryLocks(receipt, [file]);
    fs.unlinkSync(path.join(file, "owner.json")); fs.rmdirSync(file);
    syncDirectory(path.dirname(file), receipt.durabilityWarnings);
  }
}
function assertDirectoryBefore(receipt, entry) {
  checkDirectories(receipt);
  insist(same(precondition(snapshot(boundedTarget(receipt.plan.roots, entry))), precondition(entry.before)), "STALE_DESTINATION", "Destination differs from frozen plan");
}
function applyDirectories(value, normalized) {
  const receipt = { schemaVersion: 2, plan: value, phase: "preparing",
    progress: value.entries.map(() => "none"), postimages: value.entries.map(() => null),
    restoreImages: value.entries.map(() => null), durabilityWarnings: [],
    directoryProgress: value.directories.map((entry) => ({ state: entry.before ? "existing" : "none", identity: entry.before })) };
  checkDirectories(receipt);
  for (const entry of value.entries) assertDirectoryBefore(receipt, entry);
  const roots = directoryRootLocks(receipt), dir = operationDirectory(value.roots, value.operationId);
  const initialFiles = directoryFileLocks(receipt), initialLocks = [...roots, ...initialFiles];
  insist(initialLocks.every((file) => !stat(file)), "PENDING_OPERATION", "An existing root or target is locked");
  insist(!stat(dir), "OPERATION_EXISTS", "Operation identity is already in use");
  let unlock, ownedDirectory = false;
  try {
    fs.mkdirSync(dir, { mode: 0o700 }); ownedDirectory = true;
    syncDirectory(value.roots.backup, receipt.durabilityWarnings);
    unlock = executor(dir, receipt.durabilityWarnings); saveReceipt(dir, receipt);
    acquireDirectoryLocks(receipt, roots);
    acquireDirectoryLocks(receipt, initialFiles);
    // Complete backups even for files whose declared parents do not yet exist.
    for (const entry of value.entries) {
      checkDirectories(receipt); assertDirectoryLocks(receipt, initialLocks); assertDirectoryBefore(receipt, entry);
      if (entry.action === "unchanged") continue;
      const original = readRegular(boundedTarget(value.roots, entry));
      insist(same(precondition(original?.meta ?? null), precondition(entry.before)), "STALE_DESTINATION", "Original changed before backup");
      writeExclusive(backupPath(dir, entry), original ? original.bytes : Buffer.from("absent\n"));
    }
    syncDirectory(dir, receipt.durabilityWarnings); verifyBackups(dir, receipt);
    receipt.phase = "prepared"; saveReceipt(dir, receipt);
    const ordered = value.directories.map((entry, index) => ({ entry, index }))
      .sort((a, b) => a.entry.path.split("/").length - b.entry.path.split("/").length);
    for (const { entry, index } of ordered) {
      checkDirectories(receipt); assertDirectoryLocks(receipt, initialLocks);
      if (entry.before) continue;
      const file = boundedTarget(value.roots, entry);
      receipt.directoryProgress[index] = { state: "pending", identity: null }; saveReceipt(dir, receipt);
      // A durable pending record is not ownership authority, even if mkdir succeeded.
      checkDirectories(receipt, index); assertDirectoryLocks(receipt, initialLocks);
      fs.mkdirSync(file, { mode: 0o700 });
      const identity = directoryIdentity(file);
      insist(identity.mode === 0o700, "PRIVATE_MODE", "Created directory is not mode 0700");
      syncDirectory(path.dirname(file), receipt.durabilityWarnings);
      receipt.directoryProgress[index] = { state: "created", identity };
      checkDirectories(receipt); assertDirectoryLocks(receipt, initialLocks); saveReceipt(dir, receipt);
    }
    checkDirectories(receipt); assertDirectoryLocks(receipt, initialLocks);
    const files = directoryFileLocks(receipt);
    acquireDirectoryLocks(receipt, files.filter((file) => !initialFiles.includes(file)));
    const all = [...roots, ...files];
    for (const entry of value.entries) {
      checkDirectories(receipt); assertDirectoryLocks(receipt, all); assertDirectoryBefore(receipt, entry);
      if (entry.action === "unchanged") continue;
      const file = boundedStage(value.roots, entry, value.operationId);
      insist(!stat(file), "STAGING_COLLISION", "Staging path already exists");
      receipt.postimages[entry.index] = stage(file, Buffer.from(normalized.entries[entry.index].bytes, "base64"), entry);
      syncDirectory(path.dirname(file), receipt.durabilityWarnings);
      receipt.progress[entry.index] = "staged"; saveReceipt(dir, receipt);
    }
    receipt.phase = "applying"; saveReceipt(dir, receipt);
    for (const entry of value.entries) {
      checkDirectories(receipt); assertDirectoryLocks(receipt, all); assertDirectoryBefore(receipt, entry);
      if (entry.action === "unchanged") continue;
      verifyBackup(dir, entry);
      const temporary = boundedStage(value.roots, entry, value.operationId);
      insist(imageMatches(snapshot(temporary), receipt.postimages[entry.index]), "STALE_STAGE", "Staged output changed");
      assertDirectoryBefore(receipt, entry); assertDirectoryLocks(receipt, all);
      fs.renameSync(temporary, boundedTarget(value.roots, entry));
      syncDirectory(path.dirname(temporary), receipt.durabilityWarnings);
      insist(imageMatches(snapshot(boundedTarget(value.roots, entry)), receipt.postimages[entry.index]), "WRITE_VERIFICATION", "Postimage verification failed");
      receipt.progress[entry.index] = "written"; saveReceipt(dir, receipt);
    }
    checkDirectories(receipt); assertDirectoryLocks(receipt, all);
    for (const entry of value.entries) insist(entry.action === "unchanged"
      ? same(precondition(snapshot(boundedTarget(value.roots, entry))), precondition(entry.before))
      : imageMatches(snapshot(boundedTarget(value.roots, entry)), receipt.postimages[entry.index]), "STALE_DESTINATION", "Final output verification failed");
    receipt.phase = "committed"; saveReceipt(dir, receipt);
    releaseDirectoryLocks(receipt, files); releaseDirectoryLocks(receipt, roots, true);
  } catch (error) {
    if (ownedDirectory) {
      if (receipt.phase !== "committed") receipt.phase = "partial";
      try { saveReceipt(dir, receipt); } catch { /* Retain the last durable ownership record. */ }
    }
    throw new PreservationError(error.code ?? "IO_FAILURE", error.message, value.operationId);
  } finally {
    if (unlock) try { unlock(); }
    catch (error) { throw new PreservationError(error.code ?? "EXECUTOR_RELEASE", error.message, value.operationId); }
  }
  return publicStatus(dir, receipt);
}
function verifyBackup(dir, entry) {
  const saved = readRegular(backupPath(dir, entry));
  insist(saved?.meta.mode === 0o600, "MISSING_BACKUP", "Backup is missing or not private");
  if (entry.before) insist(digest(saved.bytes) === entry.before.hash && String(saved.bytes.length) === entry.before.size,
    "CORRUPT_BACKUP", "Original backup bytes failed verification");
  else insist(saved.bytes.equals(Buffer.from("absent\n")), "CORRUPT_BACKUP", "Absent marker failed verification");
  return saved.bytes;
}
function verifyBackups(dir, receipt) {
  for (const entry of receipt.plan.entries) if (entry.action !== "unchanged") verifyBackup(dir, entry);
}
function publicStatus(dir, receipt) {
  return freeze({ operationId: receipt.plan.operationId, planId: receipt.plan.planId,
    phase: receipt.phase, progress: [...receipt.progress],
    executorBlocked: stat(path.join(dir, "executor")) !== null,
    durabilityWarnings: [...receipt.durabilityWarnings],
    ...(receipt.schemaVersion === 2 ? { directoryProgress: receipt.directoryProgress.map((item) =>
      ({ state: item.state, identity: item.identity && { ...item.identity } })) } : {}) });
}

/** Read-only inspection; corrupt/incomplete backups explicitly refuse validation. */
export function inspectOperation(request) {
  object(request, ["roots", "operationId", "planId"], "operation request");
  const { dir, receipt } = loadReceipt(request);
  verifyBackups(dir, receipt);
  if (receipt.schemaVersion === 2) checkDirectories(receipt);
  return publicStatus(dir, receipt);
}

function executor(dir, warnings) {
  const file = path.join(dir, "executor");
  try { fs.mkdirSync(file, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new PreservationError("EXECUTOR_BLOCKED",
      "Executor is active or interrupted; external quiescence/recovery is required");
    throw error;
  }
  syncDirectory(dir, warnings);
  return () => { directory(file, true); fs.rmdirSync(file); syncDirectory(dir, warnings); };
}
function releaseLocks(receipt) {
  const expected = ownerFor(receipt.plan);
  for (const file of allLocks(receipt.plan.roots, receipt.plan.entries).reverse()) {
    if (!stat(file)) continue;
    insist(same(lockOwner(file), expected), "CONCURRENT_OWNERSHIP", "Foreign lock prevents release");
    fs.unlinkSync(path.join(file, "owner.json"));
    fs.rmdirSync(file);
    syncDirectory(path.dirname(file), receipt.durabilityWarnings);
  }
}
function checkRoots(receipt) {
  insist(same(validateRoots(receipt.plan.roots), receipt.plan.rootIdentities), "STALE_ROOT", "Root identity changed");
}
function stage(file, bytes, entry, restoreMode = false) {
  writeExclusive(file, bytes);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    if (entry.before) fs.fchownSync(fd, entry.before.uid, entry.before.gid);
    fs.fchmodSync(fd, restoreMode ? entry.before.mode : entry.mode);
    if (restoreMode) fs.futimesSync(fd,
      new Date(Math.round(Number(entry.before.atimeNs) / 1e6)),
      new Date(Math.round(Number(entry.before.mtimeNs) / 1e6)));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const result = snapshot(file);
  insist(result?.hash === digest(bytes) && result.mode === (restoreMode ? entry.before.mode : entry.mode),
    "STAGING_FAILED", "Staged bytes/mode did not verify");
  if (restoreMode) insist(restoredMatches(result, entry.before), "UNSUPPORTED_METADATA", "Restored metadata exceeds 1ms precision");
  return result;
}
function imageMatches(actual, expected) {
  // Rename changes ctime. atime can change through verification reads.
  if (!actual || !expected) return actual === expected;
  const { atimeNs: a, ctimeNs: c, ...left } = actual;
  const { atimeNs: b, ctimeNs: d, ...right } = expected;
  return same(left, right);
}
function restoredMatches(actual, before) {
  return actual && before && actual.hash === before.hash && actual.mode === before.mode &&
    actual.uid === before.uid && actual.gid === before.gid && actual.size === before.size &&
    Math.abs(Number(BigInt(actual.mtimeNs) - BigInt(before.mtimeNs))) <= 1e6 &&
    Math.abs(Number(BigInt(actual.atimeNs) - BigInt(before.atimeNs))) <= 1e6;
}
function finishRestoredTimes(roots, entry, receipt) {
  const expected = receipt.restoreImages[entry.index];
  if (!entry.before || !expected) return;
  const file = destination(roots, entry);
  const current = snapshot(file);
  if (same(precondition(current), precondition(entry.before))) return;
  insist(imageMatches(current, expected), "FOREIGN_EDIT", "Restored file changed before final metadata sync");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = metadata(fs.fstatSync(fd, { bigint: true }));
    insist(opened.dev === expected.dev && opened.ino === expected.ino && opened.mode === expected.mode &&
      opened.mtimeNs === expected.mtimeNs, "FOREIGN_EDIT", "Restored file identity changed before metadata sync");
    // Verification reads may update atime. Reset it only after all content reads;
    // fstat below verifies metadata without reading the file again.
    fs.futimesSync(fd, new Date(Math.round(Number(entry.before.atimeNs) / 1e6)),
      new Date(Math.round(Number(entry.before.mtimeNs) / 1e6)));
    fs.fsyncSync(fd);
    const after = { ...metadata(fs.fstatSync(fd, { bigint: true })), hash: expected.hash };
    insist(restoredMatches(after, entry.before), "UNSUPPORTED_METADATA", "Final restored timestamps exceed 1ms precision");
  } finally { fs.closeSync(fd); }
}

/**
 * @param {Plan} value A process-local plan() result.
 * @param {{input:Input, decisions:ReplacementDecision[],
 * validateReplacement:(decision:ReplacementDecision, plan:Plan)=>boolean}} options
 * Validator must be synchronous, side-effect-free and supplied by trusted caller
 * authorization code, never loaded from stored plan/receipt text. True attests
 * exactly one destination and both hashes for this operation/plan identity.
 * Exceptions after ownership acquisition retain receipts/backups/locks and throw
 * exitCode 9; caller must inspect and explicitly restore, never retry blindly.
 */
export function apply(value, options) {
  const normalized = plans.get(value);
  insist(normalized, "UNTRUSTED_PLAN", "Only an unmodified process-local plan is applicable");
  object(options, ["input", "decisions", "validateReplacement"], "apply options");
  insist(same(normalizedInput(options.input), normalized), "STALE_INPUT", "Fresh rendered input differs from plan");
  array(options.decisions, "decisions");
  insist(typeof options.validateReplacement === "function", "SCHEMA", "Invalid replacement validator");
  const approved = new Set();
  for (const decision of options.decisions) {
    object(decision, ["operationId", "planId", "root", "path", "beforeHash", "desiredHash"], "replacement decision");
    const entry = value.entries.find((item) => item.root === decision.root && item.path === decision.path);
    insist(entry?.action === "conflict" && !approved.has(entry.index) && decision.operationId === value.operationId &&
      decision.planId === value.planId && decision.beforeHash === entry.before.hash && decision.desiredHash === entry.desiredHash,
    "INVALID_DECISION", "Decision does not match exact planned collision");
    const bound = freeze({ ...decision });
    insist(options.validateReplacement(bound, value) === true, "REPLACEMENT_REFUSED", "Caller did not validate exact human replacement");
    approved.add(entry.index);
  }
  for (const entry of value.entries) {
    insist(entry.action !== "unsupported", "UNSUPPORTED_ENTRY", `${entry.kind} is caller-owned and cannot be replaced`);
    insist(entry.action !== "conflict" || approved.has(entry.index), "CONFLICT", `Preserved custom destination: ${entry.path}`);
    if (value.schemaVersion !== 2) assertBefore(value.roots, entry);
  }
  if (value.schemaVersion === 2) return applyDirectories(value, normalized);
  const locks = allLocks(value.roots, value.entries);
  insist(locks.every((file) => !stat(file)), "PENDING_OPERATION", "A target has unfinished/concurrent ownership");
  const dir = operationDirectory(value.roots, value.operationId);
  insist(!stat(dir), "OPERATION_EXISTS", "Operation identity is already in use; inspect or restore it");
  const receipt = { schemaVersion: VERSION, plan: value, phase: "preparing",
    progress: value.entries.map(() => "none"), postimages: value.entries.map(() => null),
    restoreImages: value.entries.map(() => null), durabilityWarnings: [] };
  let unlock, ownedDirectory = false;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    ownedDirectory = true;
    syncDirectory(value.roots.backup, receipt.durabilityWarnings);
    unlock = executor(dir, receipt.durabilityWarnings);
    saveReceipt(dir, receipt);
    for (const file of locks) {
      fs.mkdirSync(file, { mode: 0o700 });
      writeExclusive(path.join(file, "owner.json"), canonical(ownerFor(value)) + "\n");
      syncDirectory(file, receipt.durabilityWarnings);
      syncDirectory(path.dirname(file), receipt.durabilityWarnings);
    }
    checkRoots(receipt); assertLocks(receipt);
    for (const entry of value.entries) assertBefore(value.roots, entry);
    // Complete every original backup/absent marker before creating target stages.
    for (const entry of value.entries) {
      if (entry.action === "unchanged") continue;
      const original = readRegular(destination(value.roots, entry));
      insist(same(precondition(original?.meta ?? null), precondition(entry.before)), "STALE_DESTINATION", "Original changed before backup");
      writeExclusive(backupPath(dir, entry), original ? original.bytes : Buffer.from("absent\n"));
    }
    syncDirectory(dir, receipt.durabilityWarnings);
    verifyBackups(dir, receipt);
    receipt.phase = "prepared"; saveReceipt(dir, receipt);
    for (const entry of value.entries) {
      if (entry.action === "unchanged") continue;
      checkRoots(receipt); assertLocks(receipt); assertBefore(value.roots, entry);
      const file = stagePath(value.roots, entry, value.operationId);
      insist(!stat(file), "STAGING_COLLISION", "Staging path already exists");
      // Stage names derive from the already persisted plan, never receipt paths.
      receipt.postimages[entry.index] = stage(file, Buffer.from(normalized.entries[entry.index].bytes, "base64"), entry);
      syncDirectory(path.dirname(file), receipt.durabilityWarnings);
      receipt.progress[entry.index] = "staged"; saveReceipt(dir, receipt);
    }
    receipt.phase = "applying"; saveReceipt(dir, receipt);
    for (const entry of value.entries) {
      checkRoots(receipt); assertLocks(receipt); assertBefore(value.roots, entry);
      if (entry.action === "unchanged") continue;
      verifyBackup(dir, entry);
      const temporary = stagePath(value.roots, entry, value.operationId);
      insist(imageMatches(snapshot(temporary), receipt.postimages[entry.index]), "STALE_STAGE", "Staged output changed");
      assertBefore(value.roots, entry);
      fs.renameSync(temporary, destination(value.roots, entry));
      syncDirectory(path.dirname(temporary), receipt.durabilityWarnings);
      insist(imageMatches(snapshot(destination(value.roots, entry)), receipt.postimages[entry.index]), "WRITE_VERIFICATION", "Postimage verification failed");
      receipt.progress[entry.index] = "written"; saveReceipt(dir, receipt);
    }
    for (const entry of value.entries) insist(entry.action === "unchanged"
      ? same(precondition(snapshot(destination(value.roots, entry))), precondition(entry.before))
      : imageMatches(snapshot(destination(value.roots, entry)), receipt.postimages[entry.index]),
    "STALE_DESTINATION", "Final output verification failed");
    receipt.phase = "committed"; saveReceipt(dir, receipt);
    releaseLocks(receipt);
  } catch (error) {
    if (ownedDirectory) {
      if (receipt.phase !== "committed") receipt.phase = "partial";
      try { saveReceipt(dir, receipt); } catch { /* Earlier durable receipt remains authoritative. */ }
    }
    throw new PreservationError(error.code ?? "IO_FAILURE", error.message, value.operationId);
  } finally {
    if (unlock) {
      try { unlock(); }
      catch (error) { throw new PreservationError(error.code ?? "EXECUTOR_RELEASE", error.message, value.operationId); }
    }
  }
  return publicStatus(dir, receipt);
}

function restoreState(roots, entry, receipt) {
  const current = snapshot(receipt.schemaVersion === 2 ? boundedTarget(roots, entry) : destination(roots, entry));
  if (same(precondition(current), precondition(entry.before))) return "before";
  if (current && receipt.restoreImages[entry.index] && imageMatches(current, receipt.restoreImages[entry.index]) &&
    (!entry.before || (current.hash === entry.before.hash && current.mode === entry.before.mode &&
      current.uid === entry.before.uid && current.gid === entry.before.gid &&
      Math.abs(Number(BigInt(current.mtimeNs) - BigInt(entry.before.mtimeNs))) <= 1e6))) return "restored";
  if (receipt.postimages[entry.index] && imageMatches(current, receipt.postimages[entry.index])) return "after";
  throw new PreservationError("FOREIGN_EDIT", `Destination is not a verified pre/postimage: ${entry.path}`);
}
function acquireRecoveryLocks(receipt) {
  const owner = ownerFor(receipt.plan);
  const files = allLocks(receipt.plan.roots, receipt.plan.entries);
  for (const file of files) {
    const current = lockOwner(file);
    insist(current === null || same(current, owner), "CONCURRENT_OWNERSHIP", "A foreign operation owns a recovery target");
  }
  for (const file of files) if (!stat(file)) {
    fs.mkdirSync(file, { mode: 0o700 });
    writeExclusive(path.join(file, "owner.json"), canonical(owner) + "\n");
    syncDirectory(file, receipt.durabilityWarnings);
    syncDirectory(path.dirname(file), receipt.durabilityWarnings);
  }
  assertLocks(receipt);
}
function cleanupStage(roots, entry, receipt, restoring) {
  const file = receipt.schemaVersion === 2 ? boundedStage(roots, entry, receipt.plan.operationId, restoring)
    : stagePath(roots, entry, receipt.plan.operationId, restoring);
  const current = snapshot(file);
  if (!current) return;
  const expected = (restoring ? receipt.restoreImages : receipt.postimages)[entry.index];
  insist(expected && imageMatches(current, expected), "UNVERIFIED_STAGE",
    "Interrupted or foreign stage requires external recovery; it will not be deleted");
  fs.unlinkSync(file); syncDirectory(path.dirname(file), receipt.durabilityWarnings);
}
function preflightDirectoryRestore(receipt, files) {
  checkDirectories(receipt); assertDirectoryLocks(receipt, [...directoryRootLocks(receipt), ...files]);
  const value = receipt.plan, allowed = new Set(files);
  for (const entry of value.entries) {
    restoreState(value.roots, entry, receipt);
    allowed.add(boundedTarget(value.roots, entry));
    for (const restoring of [false, true]) {
      const file = boundedStage(value.roots, entry, value.operationId, restoring), current = snapshot(file);
      const expected = (restoring ? receipt.restoreImages : receipt.postimages)[entry.index];
      insist(!current || (expected && imageMatches(current, expected)), "UNVERIFIED_STAGE", "Stage identity is not verified");
      allowed.add(file);
    }
  }
  for (const entry of value.directories) allowed.add(boundedTarget(value.roots, entry));
  for (const file of [...directoryRootLocks(receipt), ...files]) insist(same(fs.readdirSync(file), ["owner.json"]), "FOREIGN_CHILD", "Foreign lock child prevents recovery");
  value.directories.forEach((entry, index) => {
    if (receipt.directoryProgress[index].state !== "created") return;
    const file = boundedTarget(value.roots, entry);
    for (const child of fs.readdirSync(file)) insist(allowed.has(path.join(file, child)), "FOREIGN_CHILD", `Foreign child prevents directory restore: ${file}`);
  });
}
function restoreDirectories(dir, receipt) {
  checkDirectories(receipt);
  const value = receipt.plan, roots = directoryRootLocks(receipt);
  const unlock = executor(dir, receipt.durabilityWarnings);
  try {
    acquireDirectoryLocks(receipt, roots, true);
    const files = directoryFileLocks(receipt);
    acquireDirectoryLocks(receipt, files, true);
    preflightDirectoryRestore(receipt, files);
    const all = [...roots, ...files];
    receipt.phase = "restoring"; saveReceipt(dir, receipt);
    for (const entry of value.entries) {
      checkDirectories(receipt); assertDirectoryLocks(receipt, all);
      const state = restoreState(value.roots, entry, receipt);
      if (state === "after") {
        const bytes = verifyBackup(dir, entry), file = boundedTarget(value.roots, entry);
        if (entry.before) {
          const temporary = boundedStage(value.roots, entry, value.operationId, true);
          cleanupStage(value.roots, entry, receipt, true);
          receipt.restoreImages[entry.index] = stage(temporary, bytes, entry, true);
          syncDirectory(path.dirname(temporary), receipt.durabilityWarnings); saveReceipt(dir, receipt);
          checkDirectories(receipt); assertDirectoryLocks(receipt, all);
          insist(restoreState(value.roots, entry, receipt) === "after", "FOREIGN_EDIT", "Target changed before restoration");
          insist(imageMatches(snapshot(temporary), receipt.restoreImages[entry.index]), "STALE_STAGE", "Restore stage changed");
          fs.renameSync(temporary, file);
        } else {
          checkDirectories(receipt); assertDirectoryLocks(receipt, all);
          insist(restoreState(value.roots, entry, receipt) === "after", "FOREIGN_EDIT", "Created target changed before removal");
          fs.unlinkSync(file);
        }
        syncDirectory(path.dirname(file), receipt.durabilityWarnings);
        insist(["before", "restored"].includes(restoreState(value.roots, entry, receipt)), "RESTORE_VERIFICATION", "Restored image verification failed");
      }
      for (const restoring of [false, true]) {
        checkDirectories(receipt); assertDirectoryLocks(receipt, all);
        cleanupStage(value.roots, entry, receipt, restoring);
      }
      receipt.progress[entry.index] = "restored"; saveReceipt(dir, receipt);
    }
    for (const entry of value.entries) {
      checkDirectories(receipt); assertDirectoryLocks(receipt, all);
      insist(["before", "restored"].includes(restoreState(value.roots, entry, receipt)), "RESTORE_VERIFICATION", "Final restoration verification failed");
      finishRestoredTimes(value.roots, entry, receipt);
    }
    // Target lock directories must be gone before testing created parents for emptiness.
    releaseDirectoryLocks(receipt, files);
    const ordered = value.directories.map((entry, index) => ({ entry, index }))
      .sort((a, b) => b.entry.path.split("/").length - a.entry.path.split("/").length);
    for (const { entry, index } of ordered) {
      checkDirectories(receipt); assertDirectoryLocks(receipt);
      const item = receipt.directoryProgress[index];
      if (item.state !== "created") continue;
      const file = boundedTarget(value.roots, entry);
      insist(fs.readdirSync(file).length === 0, "FOREIGN_CHILD", "Created directory is not empty; external recovery required");
      item.state = "removing"; saveReceipt(dir, receipt);
      checkDirectories(receipt, index); assertDirectoryLocks(receipt);
      fs.rmdirSync(file); syncDirectory(path.dirname(file), receipt.durabilityWarnings);
      item.state = "removed"; saveReceipt(dir, receipt);
    }
    checkDirectories(receipt); assertDirectoryLocks(receipt);
    receipt.phase = "restored"; saveReceipt(dir, receipt);
    releaseDirectoryLocks(receipt, roots, true);
  } finally { unlock(); }
  return publicStatus(dir, receipt);
}

/**
 * Explicit restore, including committed operations; backups are retained forever.
 * All backups and destinations are validated before the first restoration write.
 * Repeated restore validates restored images and returns without rewriting them.
 * Incomplete original backup sets or stages interrupted before their inode receipt
 * was durable require external recovery; no unverified file is deleted or adopted.
 */
export function restore(request) {
  try { return restoreOperation(request); }
  catch (error) {
    throw new PreservationError(error.code ?? "RECOVERY_REQUIRED", error.message,
      typeof request?.operationId === "string" && request.operationId ? request.operationId : "unknown");
  }
}
function restoreOperation(request) {
  object(request, ["roots", "operationId", "planId"], "restore request");
  const { dir, receipt } = loadReceipt(request);
  verifyBackups(dir, receipt);
  if (receipt.schemaVersion === 2) return restoreDirectories(dir, receipt);
  const unlock = executor(dir, receipt.durabilityWarnings);
  try {
    acquireRecoveryLocks(receipt); checkRoots(receipt);
    for (const entry of receipt.plan.entries) restoreState(request.roots, entry, receipt);
    // Validate all extant stages before any cleanup or destination mutation.
    for (const entry of receipt.plan.entries) for (const restoring of [false, true]) {
      const current = snapshot(stagePath(request.roots, entry, request.operationId, restoring));
      const expected = (restoring ? receipt.restoreImages : receipt.postimages)[entry.index];
      insist(!current || (expected && imageMatches(current, expected)), "UNVERIFIED_STAGE", "Stage identity is not verified");
    }
    receipt.phase = "restoring"; saveReceipt(dir, receipt);
    // Inventory order is deliberate: callers can place metadata/stamps last.
    for (const entry of receipt.plan.entries) {
      checkRoots(receipt); assertLocks(receipt);
      const state = restoreState(request.roots, entry, receipt);
      if (state === "after") {
        const bytes = verifyBackup(dir, entry), file = destination(request.roots, entry);
        if (entry.before) {
          const temporary = stagePath(request.roots, entry, request.operationId, true);
          cleanupStage(request.roots, entry, receipt, true);
          receipt.restoreImages[entry.index] = stage(temporary, bytes, entry, true);
          syncDirectory(path.dirname(temporary), receipt.durabilityWarnings);
          saveReceipt(dir, receipt);
          insist(restoreState(request.roots, entry, receipt) === "after", "FOREIGN_EDIT", "Target changed before restoration");
          checkRoots(receipt); assertLocks(receipt);
          insist(imageMatches(snapshot(temporary), receipt.restoreImages[entry.index]), "STALE_STAGE", "Restore stage changed");
          fs.renameSync(temporary, file);
        } else {
          insist(restoreState(request.roots, entry, receipt) === "after", "FOREIGN_EDIT", "Created target changed before removal");
          fs.unlinkSync(file);
        }
        syncDirectory(path.dirname(file), receipt.durabilityWarnings);
        insist(["before", "restored"].includes(restoreState(request.roots, entry, receipt)), "RESTORE_VERIFICATION", "Restored image verification failed");
      }
      cleanupStage(request.roots, entry, receipt, false);
      cleanupStage(request.roots, entry, receipt, true);
      receipt.progress[entry.index] = "restored"; saveReceipt(dir, receipt);
    }
    for (const entry of receipt.plan.entries) insist(["before", "restored"].includes(restoreState(request.roots, entry, receipt)),
      "RESTORE_VERIFICATION", "Final restoration verification failed");
    for (const entry of receipt.plan.entries) {
      checkRoots(receipt); assertLocks(receipt);
      finishRestoredTimes(request.roots, entry, receipt);
    }
    receipt.phase = "restored"; saveReceipt(dir, receipt);
    releaseLocks(receipt);
  } catch (error) {
    throw new PreservationError(error.code ?? "RECOVERY_REQUIRED", error.message, request.operationId);
  } finally { unlock(); }
  return publicStatus(dir, receipt);
}
