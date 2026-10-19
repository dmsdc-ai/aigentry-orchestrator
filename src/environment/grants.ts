import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { absoluteRoot, strictJson, uuid, type Binding, type ConfigV2, type FileIdentity } from "./contract.js";
import { commitConfigUnderLock, durableWriteExclusive, fsyncDirectory, mutateConfig, readBounded, readConfig, withWriterLock } from "./storage.js";
import { validateExecutableBinding, type ExecutableBinding } from "../session/model-decision.js";

export interface ControllerContext { readonly home: string; readonly rootId: string; readonly rootIdentity: FileIdentity }
const id = (s: fs.Stats): FileIdentity => ({ dev: String(s.dev), ino: String(s.ino) });
const same = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;
function canonicalDirectory(root: string): { path: string; identity: FileIdentity } {
  if (!absoluteRoot(root)) throw new Error("ENV_PROJECT_NOT_CANONICAL");
  const real = fs.realpathSync.native(root);
  const st = fs.statSync(real);
  if (root !== real || !st.isDirectory()) throw new Error("ENV_PROJECT_NOT_CANONICAL");
  return { path: real, identity: id(st) };
}
export function controllerContext(home: string): ControllerContext {
  const { path: real, identity } = canonicalDirectory(home);
  const c = readConfig(real);
  if (c.version !== 2) throw new Error("ENV_SCHEMA_UPGRADE_REQUIRED");
  if (c.controller.canonicalRoot !== real || !same(c.controller.rootIdentity, identity)) throw new Error("ENV_CONTROLLER_ROOT_REFUSED");
  return { home: real, rootId: c.controller.rootId, rootIdentity: identity };
}
export function currentConfig(ctx: ControllerContext): ConfigV2 {
  const c = readConfig(ctx.home);
  if (c.version !== 2) throw new Error("ENV_SCHEMA_UPGRADE_REQUIRED");
  if (c.controller.rootId !== ctx.rootId || c.controller.canonicalRoot !== ctx.home ||
      !same(c.controller.rootIdentity, ctx.rootIdentity) || !same(id(fs.statSync(ctx.home)), ctx.rootIdentity)) {
    throw new Error("ENV_CONTROLLER_ROOT_REFUSED");
  }
  return c;
}
export function upgradeConfig(home: string, expected: number): ConfigV2 {
  const root = canonicalDirectory(home);
  const next = mutateConfig(root.path, expected, (c) => {
    if (c.version !== 1) throw new Error("ENV_SCHEMA");
    return { ...c, version: 2, authorityGeneration: 1,
      controller: { rootId: randomUUID(), canonicalRoot: root.path, rootIdentity: root.identity },
      projectEnrollments: {}, projectOverrides: {}, bindings: {} };
  });
  if (next.version !== 2) throw new Error("ENV_SCHEMA");
  return next;
}
function mutate(ctx: ControllerContext, expected: number, change: (c: ConfigV2) => void): ConfigV2 {
  const next = mutateConfig(ctx.home, expected, (c) => {
    if (c.version !== 2 || c.controller.rootId !== ctx.rootId || !same(c.controller.rootIdentity, ctx.rootIdentity)) throw new Error("ENV_CONTROLLER_ROOT_REFUSED");
    change(c);
    return c;
  });
  if (next.version !== 2) throw new Error("ENV_SCHEMA");
  return next;
}
export function enrollProject(ctx: ControllerContext, root: string, expected: number): { id: string; revision: number } {
  const project = canonicalDirectory(root);
  const enrollmentId = randomUUID();
  const next = mutate(ctx, expected, c => {
    if (Object.values(c.projectEnrollments).some(e => e.canonicalRoot === project.path && e.enabled)) throw new Error("ENV_PROJECT_ENROLLED");
    if (Object.keys(c.projectEnrollments).length >= 64) throw new Error("ENV_SCHEMA_BOUND");
    c.projectEnrollments[enrollmentId] = { canonicalRoot: project.path, identity: project.identity, enabled: true, securityEpoch: 1 };
  });
  return { id: enrollmentId, revision: next.revision };
}
export function disableProject(ctx: ControllerContext, enrollmentId: string, expected: number): number {
  if (!uuid(enrollmentId)) throw new Error("ENV_PROJECT_UNENROLLED");
  return mutate(ctx, expected, c => {
    const e = c.projectEnrollments[enrollmentId];
    if (!e) throw new Error("ENV_PROJECT_UNENROLLED");
    if (!Number.isSafeInteger(e.securityEpoch + 1)) throw new Error("ENV_EPOCH_EXHAUSTED");
    e.enabled = false; e.securityEpoch++;
  }).revision;
}
export function createBinding(ctx: ControllerContext, projectId: string, executable: ExecutableBinding,
  expected: number): { id: string; locatorId: string; revision: number } {
  if (!uuid(projectId)) throw new Error("ENV_PROJECT_UNENROLLED");
  const verified = validateExecutableBinding(executable, "claude");
  if (verified.version === null || verified.versionSource === "unknown") throw new Error("ENV_BINDING_POLICY_REFUSED");
  const bindingId = randomUUID(), locatorId = randomUUID();
  const next = mutate(ctx, expected, c => {
    if (!c.projectEnrollments[projectId]?.enabled) throw new Error("ENV_PROJECT_UNENROLLED");
    if (Object.keys(c.bindings).length >= 64) throw new Error("ENV_SCHEMA_BOUND");
    c.bindings[bindingId] = { descriptorId: "claude.worker.oauth", source: { kind: "invocation-input", locatorId },
      enabled: true, securityEpoch: 1, projectEnrollmentIds: [projectId], consumerId: "claude-confined-worker",
      destinationId: "claude-code-oauth-env", executableBinding: verified };
  });
  return { id: bindingId, locatorId, revision: next.revision };
}
export function revokeBinding(ctx: ControllerContext, bindingId: string, expected: number): number {
  if (!uuid(bindingId)) throw new Error("ENV_BINDING_POLICY_REFUSED");
  return mutate(ctx, expected, c => {
    const b = c.bindings[bindingId];
    if (!b) throw new Error("ENV_BINDING_POLICY_REFUSED");
    if (!Number.isSafeInteger(b.securityEpoch + 1)) throw new Error("ENV_EPOCH_EXHAUSTED");
    b.enabled = false; b.securityEpoch++;
  }).revision;
}
export interface BindingSelection {
  readonly bindingId: string;
  readonly binding: Binding;
  readonly enrollmentId: string;
  readonly projectRoot: string;
  readonly projectIdentity: FileIdentity;
  readonly projectEpoch: number;
  readonly rootId: string;
  readonly authorityGeneration: number;
  readonly revision: number;
}
export function resolveBinding(ctx: ControllerContext, targetRoot: string, executable?: ExecutableBinding,
  explicitBindingId?: string): BindingSelection {
  const c = currentConfig(ctx);
  const project = canonicalDirectory(targetRoot);
  const enrollments = Object.entries(c.projectEnrollments).filter(([, e]) => e.enabled && e.canonicalRoot === project.path);
  if (enrollments.length !== 1) throw new Error("ENV_PROJECT_UNENROLLED");
  const [enrollmentId, enrolled] = enrollments[0]!;
  if (!same(project.identity, enrolled.identity)) throw new Error("ENV_PROJECT_IDENTITY_CHANGED");
  const bindings = Object.entries(c.bindings).filter(([id, b]) => (!explicitBindingId || id === explicitBindingId) &&
    b.enabled && b.descriptorId === "claude.worker.oauth" && b.projectEnrollmentIds.includes(enrollmentId));
  if (bindings.length === 0) throw new Error("ENV_BINDING_POLICY_REFUSED");
  if (bindings.length !== 1) throw new Error("ENV_BINDING_AMBIGUOUS");
  const [bindingId, binding] = bindings[0]!;
  if (binding.source.kind !== "invocation-input") throw new Error("ENV_BACKEND_UNAVAILABLE");
  if (executable && JSON.stringify(binding.executableBinding) !== JSON.stringify(validateExecutableBinding(executable, "claude"))) {
    throw new Error("ENV_BINDING_POLICY_REFUSED");
  }
  return { bindingId, binding: structuredClone(binding), enrollmentId, projectRoot: project.path,
    projectIdentity: project.identity, projectEpoch: enrolled.securityEpoch,
    rootId: ctx.rootId, authorityGeneration: c.authorityGeneration, revision: c.revision };
}
export function assertSelectionCurrent(ctx: ControllerContext, selected: BindingSelection): ConfigV2 {
  const c = currentConfig(ctx);
  const e = c.projectEnrollments[selected.enrollmentId], b = c.bindings[selected.bindingId];
  if (!e?.enabled || !b?.enabled || c.authorityGeneration !== selected.authorityGeneration ||
      e.securityEpoch !== selected.projectEpoch || b.securityEpoch !== selected.binding.securityEpoch ||
      JSON.stringify(b) !== JSON.stringify(selected.binding)) throw new Error("ENV_GRANT_REVOKED");
  const project = canonicalDirectory(selected.projectRoot);
  if (project.path !== e.canonicalRoot || !same(project.identity, e.identity)) throw new Error("ENV_PROJECT_IDENTITY_CHANGED");
  if (c.revision < selected.revision) throw new Error("ENV_AUTH_STATE_DRIFT");
  return c;
}
const sidPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
function ownedDirectory(dir: string): void {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error("ENV_UNSAFE_PATH");
}
function privateChain(home: string, file: string): void {
  const relative = path.relative(home, path.dirname(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("ENV_UNSAFE_PATH");
  let current = home;
  ownedDirectory(current);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    ownedDirectory(current);
  }
}
function ownedFile(file: string): boolean {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() ||
      (st.mode & 0o077)) throw new Error("ENV_UNSAFE_PATH");
  return true;
}
function record(file: string, max: number, keys: readonly string[]): Record<string, unknown> | null {
  const raw = readBounded(file);
  if (raw === null) return null;
  if (Buffer.byteLength(raw) > max) throw new Error("ENV_GRANT_INVALID");
  const value = strictJson(raw) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) throw new Error("ENV_GRANT_INVALID");
  return value;
}
const grantKeys = ["version", "grantId", "controllerRootId", "authorityGeneration", "task", "sid", "attempt",
  "consumerId", "executableBinding", "projectEnrollmentId", "targetRootIdentity", "configRevision", "bindingId",
  "bindingEpoch", "projectEpoch", "destinationId", "issuedAt", "expiresAt"];
const countKeys = ["version", "controllerRootId", "authorityGeneration", "sid", "attempt"];
const cleanupKeys = ["version", "kind", "controllerRootId", "authorityGeneration", "id", "sid", "attempt", "manifestSha256",
  "bindingId", "bindingEpoch", "projectEnrollmentId", "projectEpoch"];
const shaPattern = /^[0-9a-f]{64}$/;
function validateIdentity(r: Record<string, unknown>, ctx: ControllerContext, id: string, explicit: boolean): void {
  if (r.version !== 1 || r.controllerRootId !== ctx.rootId || r.authorityGeneration === undefined ||
      !Number.isSafeInteger(r.authorityGeneration) || Number(r.authorityGeneration) < 1 ||
      !sidPattern.test(String(r.sid)) || !uuid(r.attempt) ||
      (explicit ? r.attempt !== id : (r.grantId ?? r.id) !== id)) throw new Error("ENV_GRANT_INVALID");
  if (Object.hasOwn(r, "kind") && r.kind !== (explicit ? "explicit" : "central")) throw new Error("ENV_GRANT_INVALID");
}
export interface GrantCounts {
  readonly total: number; readonly grants: number; readonly explicit: number;
  readonly currentGeneration: number; readonly retiredGeneration: number;
  readonly prepared: number; readonly spent: number; readonly terminal: number;
  readonly partial: number; readonly payloadPresent: number; readonly payloadAbsent: number;
}
export function inspectGrants(ctx: ControllerContext): GrantCounts {
  const generation = currentConfig(ctx).authorityGeneration;
  const dir = path.join(ctx.home, "environment", "grants");
  const grantIds = present(dir) ? (ownedDirectory(dir), fs.readdirSync(dir)) : [];
  const explicitDir = path.join(ctx.home, "environment", "explicit-receipts");
  const receiptIds = present(explicitDir) ? (ownedDirectory(explicitDir), fs.readdirSync(explicitDir)) : [];
  if ([...grantIds, ...receiptIds].some(x => !uuid(x))) throw new Error("ENV_GRANT_INVALID");
  if (grantIds.length + receiptIds.length > 1024) throw new Error("ENV_GRANT_STORE_FULL");
  let currentGeneration = 0, retiredGeneration = 0, prepared = 0, spent = 0, terminal = 0, partial = 0;
  let payloadPresent = 0, payloadAbsent = 0;
  const count = (item: Record<string, unknown> | null, marker: string, spentFile: string, terminalFile: string,
    payload: string | null): void => {
    if (!item) { partial++; return; }
    if (Number(item.authorityGeneration) === generation) currentGeneration++;
    else if (Number(item.authorityGeneration) < generation) retiredGeneration++;
    else throw new Error("ENV_GRANT_INVALID");
    if (ownedFile(terminalFile)) terminal++;
    else if (ownedFile(spentFile)) spent++;
    else if (ownedFile(marker)) prepared++;
    else partial++;
    if (payload === null) { payloadAbsent++; return; }
    if (ownedFile(payload)) payloadPresent++; else payloadAbsent++;
  };
  for (const id of grantIds) {
    const owned = path.join(dir, id); ownedDirectory(owned);
    privateChain(ctx.home, path.join(owned, "grant.json"));
    const r = record(path.join(owned, "grant.json"), 16 * 1024, grantKeys) ??
      record(path.join(owned, "cleanup.json"), 4096, cleanupKeys);
    if (r) validateIdentity(r, ctx, id, false);
    const sid = typeof r?.sid === "string" ? r.sid : "";
    const attempt = typeof r?.attempt === "string" ? r.attempt : "";
    const payload = sidPattern.test(sid) && uuid(attempt)
      ? path.join(ctx.home, "sessions", sid, "sandbox", attempt, "claude-oauth", "token") : null;
    count(r, path.join(owned, "prepared.json"), path.join(owned, "spent.json"), path.join(owned, "terminal.json"), payload);
  }
  for (const id of receiptIds) {
    const owned = path.join(explicitDir, id); ownedDirectory(owned);
    privateChain(ctx.home, path.join(owned, "record.json"));
    const r = record(path.join(owned, "record.json"), 4096, countKeys) ??
      record(path.join(owned, "cleanup.json"), 4096, cleanupKeys);
    if (r) validateIdentity(r, ctx, id, true);
    const sid = typeof r?.sid === "string" ? r.sid : "";
    const attempt = typeof r?.attempt === "string" ? r.attempt : "";
    const receiptDir = sidPattern.test(sid) && uuid(attempt)
      ? path.join(ctx.home, "sessions", sid, "explicit-handoffs", attempt) : null;
    count(r, receiptDir ? path.join(receiptDir, "receipt.json") : path.join(owned, "missing"),
      receiptDir ? path.join(receiptDir, "spent.json") : path.join(owned, "missing"),
      receiptDir ? path.join(receiptDir, "terminal.json") : path.join(owned, "missing"),
      receiptDir ? path.join(receiptDir, "token") : null);
  }
  return { total: grantIds.length + receiptIds.length, grants: grantIds.length, explicit: receiptIds.length,
    currentGeneration, retiredGeneration, prepared, spent, terminal, partial, payloadPresent, payloadAbsent };
}
export function rotateGrants(ctx: ControllerContext, expectedRevision: number, expectedGeneration: number): ConfigV2 & { retiredRecords: number } {
  return withWriterLock(ctx.home, () => {
    const c = currentConfig(ctx);
    if (c.revision !== expectedRevision || c.authorityGeneration !== expectedGeneration) throw new Error("ENV_REVISION_CONFLICT");
    if (!Number.isSafeInteger(c.revision + 1) || !Number.isSafeInteger(c.authorityGeneration + 1)) throw new Error("ENV_REVISION_EXHAUSTED");
    const retiredRecords = inspectGrants(ctx).currentGeneration;
    c.revision++; c.authorityGeneration++;
    commitConfigUnderLock(ctx.home, c);
    return { ...c, retiredRecords };
  });
}
function unlinkOwned(file: string): void {
  if (!ownedFile(file)) return;
  fs.unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}
function currentPointer(file: string, keys: readonly string[]): Record<string, unknown> | null {
  return record(file, 4096, keys);
}
function centralDeauthorized(c: ConfigV2, r: Record<string, unknown>): boolean {
  const binding = c.bindings[String(r.bindingId)], project = c.projectEnrollments[String(r.projectEnrollmentId)];
  return !binding?.enabled || binding.securityEpoch !== r.bindingEpoch ||
    !project?.enabled || project.securityEpoch !== r.projectEpoch;
}
const preparedKeys = ["version", "grantId", "controllerRootId", "authorityGeneration", "task", "sid", "attempt",
  "manifestSha256", "scope", "payloadPath", "preparedAt", "clock"];
function detachCentral(ctx: ControllerContext, sid: string, attempt: string, hash: unknown): void {
  const stage = path.join(ctx.home, "sessions", sid), pointer = path.join(stage, "sandbox-current.json");
  if (!present(stage)) return;
  privateChain(ctx.home, pointer);
  const pin = currentPointer(pointer, ["manifest", "hash"]);
  const manifest = path.join(stage, "sandbox", attempt, "manifest.json");
  if (pin?.manifest !== manifest) return;
  if (!shaPattern.test(String(pin.hash))) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
  if (hash === null) {
    privateChain(ctx.home, manifest);
    const raw = readBounded(manifest);
    if (raw === null || createHash("sha256").update(raw).digest("hex") !== pin.hash) {
      throw new Error("ENV_MAINTENANCE_INCOMPLETE");
    }
  } else if (!shaPattern.test(String(hash)) || pin.hash !== hash) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
  unlinkOwned(pointer);
}
function detachExplicit(ctx: ControllerContext, sid: string, attempt: string): void {
  const stage = path.join(ctx.home, "sessions", sid), pointer = path.join(stage, "explicit-current.json");
  if (!present(stage)) return;
  privateChain(ctx.home, pointer);
  const pin = currentPointer(pointer, ["receipt", "attempt"]);
  if (pin?.receipt !== path.join(stage, "explicit-handoffs", attempt, "receipt.json")) return;
  if (pin.attempt !== attempt) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
  unlinkOwned(pointer);
}
function cleanupCentral(ctx: ControllerContext, c: ConfigV2, id: string): boolean {
  const base = path.join(ctx.home, "environment", "grants"), dir = path.join(base, id);
  privateChain(ctx.home, path.join(dir, "grant.json"));
  ownedDirectory(dir);
  const names = fs.readdirSync(dir);
  if (names.length === 0) { fs.rmdirSync(dir); fsyncDirectory(base); return true; }
  if (names.some(name => !["grant.json", "prepared.json", "spent.json", "terminal.json",
    "cleanup.json"].includes(name))) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
  for (const name of names) ownedFile(path.join(dir, name));
  const grant = record(path.join(dir, "grant.json"), 16 * 1024, grantKeys);
  let cleanup = record(path.join(dir, "cleanup.json"), 4096, cleanupKeys);
  const source = cleanup ?? grant;
  if (!source) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
  validateIdentity(source, ctx, id, false);
  if (Number(source.authorityGeneration) > c.authorityGeneration) throw new Error("ENV_GRANT_INVALID");
  if (Number(source.authorityGeneration) === c.authorityGeneration &&
      (!ownedFile(path.join(dir, "terminal.json")) && !cleanup || !centralDeauthorized(c, source))) return false;
  if (grant && cleanup && (grant.sid !== cleanup.sid || grant.attempt !== cleanup.attempt ||
      grant.authorityGeneration !== cleanup.authorityGeneration)) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
  if (!cleanup) {
    const prepared = record(path.join(dir, "prepared.json"), 64 * 1024, preparedKeys);
    const hash = prepared?.manifestSha256 ?? null;
    if (hash !== null && !shaPattern.test(String(hash))) throw new Error("ENV_GRANT_INVALID");
    cleanup = { version: 1, kind: "central", controllerRootId: ctx.rootId,
      authorityGeneration: grant!.authorityGeneration, id, sid: grant!.sid, attempt: grant!.attempt,
      manifestSha256: hash, bindingId: grant!.bindingId, bindingEpoch: grant!.bindingEpoch,
      projectEnrollmentId: grant!.projectEnrollmentId, projectEpoch: grant!.projectEpoch };
    durableWriteExclusive(path.join(dir, "cleanup.json"), JSON.stringify(cleanup) + "\n");
  }
  const sid = String(cleanup.sid), attempt = String(cleanup.attempt);
  const handoff = path.join(ctx.home, "sessions", sid, "sandbox", attempt, "claude-oauth");
  const payload = path.join(handoff, "token");
  if (present(payload)) { privateChain(ctx.home, payload); unlinkOwned(payload); }
  detachCentral(ctx, sid, attempt, cleanup.manifestSha256);
  for (const name of ["prepared.json", "grant.json", "spent.json", "terminal.json"]) {
    unlinkOwned(path.join(dir, name));
  }
  unlinkOwned(path.join(dir, "cleanup.json"));
  fs.rmdirSync(dir); fsyncDirectory(base);
  return true;
}
function cleanupExplicit(ctx: ControllerContext, c: ConfigV2, id: string): boolean {
  const base = path.join(ctx.home, "environment", "explicit-receipts"), counted = path.join(base, id);
  privateChain(ctx.home, path.join(counted, "record.json"));
  ownedDirectory(counted);
  const names = fs.readdirSync(counted);
  if (names.length === 0) { fs.rmdirSync(counted); fsyncDirectory(base); return true; }
  if (names.some(name => !["record.json", "cleanup.json"].includes(name))) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
  for (const name of names) ownedFile(path.join(counted, name));
  const sourceRecord = record(path.join(counted, "record.json"), 4096, countKeys);
  let cleanup = record(path.join(counted, "cleanup.json"), 4096, cleanupKeys);
  const source = cleanup ?? sourceRecord;
  if (!source) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
  validateIdentity(source, ctx, id, true);
  if (Number(source.authorityGeneration) >= c.authorityGeneration) return false;
  if (sourceRecord && cleanup && (sourceRecord.sid !== cleanup.sid || sourceRecord.attempt !== cleanup.attempt ||
      sourceRecord.authorityGeneration !== cleanup.authorityGeneration)) throw new Error("ENV_MAINTENANCE_INCOMPLETE");
  if (!cleanup) {
    cleanup = { version: 1, kind: "explicit", controllerRootId: ctx.rootId,
      authorityGeneration: sourceRecord!.authorityGeneration, id, sid: sourceRecord!.sid, attempt: id,
      manifestSha256: null, bindingId: null, bindingEpoch: null, projectEnrollmentId: null, projectEpoch: null };
    durableWriteExclusive(path.join(counted, "cleanup.json"), JSON.stringify(cleanup) + "\n");
  }
  const sid = String(cleanup.sid), stage = path.join(ctx.home, "sessions", sid);
  const owned = path.join(stage, "explicit-handoffs", id);
  if (present(owned)) {
    privateChain(ctx.home, path.join(owned, "receipt.json"));
    ownedDirectory(owned);
    const files = fs.readdirSync(owned);
    if (files.some(name => !["receipt.json", "token", "spent.json", "terminal.json"].includes(name))) {
      throw new Error("ENV_MAINTENANCE_INCOMPLETE");
    }
    for (const name of files) ownedFile(path.join(owned, name));
    unlinkOwned(path.join(owned, "token"));
    detachExplicit(ctx, sid, id);
    for (const name of ["receipt.json", "spent.json", "terminal.json"]) unlinkOwned(path.join(owned, name));
    fs.rmdirSync(owned); fsyncDirectory(path.dirname(owned));
  } else detachExplicit(ctx, sid, id);
  unlinkOwned(path.join(counted, "record.json"));
  unlinkOwned(path.join(counted, "cleanup.json"));
  fs.rmdirSync(counted); fsyncDirectory(base);
  return true;
}
export function reclaimGrants(ctx: ControllerContext, expectedRevision: number, expectedGeneration: number, limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error("ENV_SCHEMA_BOUND");
  return withWriterLock(ctx.home, () => {
    const c = currentConfig(ctx);
    if (c.revision !== expectedRevision || c.authorityGeneration !== expectedGeneration) throw new Error("ENV_REVISION_CONFLICT");
    let deleted = 0;
    const central = path.join(ctx.home, "environment", "grants");
    for (const id of present(central) ? (ownedDirectory(central), fs.readdirSync(central)) : []) {
      if (deleted === limit) break;
      if (!uuid(id)) throw new Error("ENV_GRANT_INVALID");
      if (cleanupCentral(ctx, c, id)) deleted++;
    }
    const explicit = path.join(ctx.home, "environment", "explicit-receipts");
    for (const id of present(explicit) ? (ownedDirectory(explicit), fs.readdirSync(explicit)) : []) {
      if (deleted === limit) break;
      if (!uuid(id)) throw new Error("ENV_GRANT_INVALID");
      if (cleanupExplicit(ctx, c, id)) deleted++;
    }
    return deleted;
  });
}
export function abortGrant(ctx: ControllerContext, id: string, reason = "cancelled"): boolean {
  if (!uuid(id) || !["cancelled", "expired", "clock-uncertain"].includes(reason)) throw new Error("ENV_GRANT_INVALID");
  return withWriterLock(ctx.home, () => {
    const c = currentConfig(ctx), dir = path.join(ctx.home, "environment", "grants", id);
    privateChain(ctx.home, path.join(dir, "grant.json"));
    ownedDirectory(dir);
    const grant = record(path.join(dir, "grant.json"), 16 * 1024, grantKeys);
    if (!grant) throw new Error("ENV_GRANT_INVALID");
    validateIdentity(grant, ctx, id, false);
    if (grant.authorityGeneration !== c.authorityGeneration) throw new Error("ENV_GRANT_REVOKED");
    if (ownedFile(path.join(dir, "spent.json"))) return false;
    const prepared = record(path.join(dir, "prepared.json"), 64 * 1024, preparedKeys);
    const newlyTerminal = !ownedFile(path.join(dir, "terminal.json"));
    if (newlyTerminal) durableWriteExclusive(path.join(dir, "terminal.json"), JSON.stringify({ version: 1, grantId: id,
      controllerRootId: ctx.rootId, authorityGeneration: c.authorityGeneration,
      attempt: grant.attempt, reason, terminalAt: Date.now() }) + "\n");
    const sid = String(grant.sid), attempt = String(grant.attempt);
    detachCentral(ctx, sid, attempt, prepared?.manifestSha256 ?? null);
    unlinkOwned(path.join(dir, "prepared.json"));
    const payload = path.join(ctx.home, "sessions", sid, "sandbox", attempt, "claude-oauth", "token");
    if (present(payload)) privateChain(ctx.home, payload);
    unlinkOwned(payload);
    return newlyTerminal;
  });
}
export function abortExplicitReceipt(ctx: ControllerContext, sid: string, attempt: string, reason = "cancelled"): boolean {
  if (!sidPattern.test(sid) || !uuid(attempt) || !["cancelled", "expired", "clock-uncertain"].includes(reason)) {
    throw new Error("ENV_GRANT_INVALID");
  }
  return withWriterLock(ctx.home, () => {
    const c = currentConfig(ctx), counted = path.join(ctx.home, "environment", "explicit-receipts", attempt);
    privateChain(ctx.home, path.join(counted, "record.json"));
    const count = record(path.join(counted, "record.json"), 4096, countKeys);
    if (!count || count.sid !== sid || count.authorityGeneration !== c.authorityGeneration) throw new Error("ENV_GRANT_INVALID");
    const dir = path.join(ctx.home, "sessions", sid, "explicit-handoffs", attempt);
    privateChain(ctx.home, path.join(dir, "receipt.json"));
    ownedDirectory(dir);
    if (ownedFile(path.join(dir, "spent.json"))) return false;
    const newlyTerminal = !ownedFile(path.join(dir, "terminal.json"));
    if (newlyTerminal) durableWriteExclusive(path.join(dir, "terminal.json"), JSON.stringify({ version: 1, controllerRootId: ctx.rootId,
      authorityGeneration: c.authorityGeneration, attempt, reason, terminalAt: Date.now() }) + "\n");
    detachExplicit(ctx, sid, attempt);
    unlinkOwned(path.join(dir, "token"));
    return newlyTerminal;
  });
}
export function reapExpired(ctx: ControllerContext, limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error("ENV_SCHEMA_BOUND");
  const expiryReason = (r: Record<string, unknown>, stamp: Record<string, unknown> | null): "expired" | "clock-uncertain" | null => {
    const now = Date.now(), uptime = Math.floor(os.uptime() * 1000);
    const c = stamp?.clock;
    if (!c || typeof c !== "object" || Array.isArray(c) ||
        Object.keys(c).sort().join(",") !== "bootEstimateEpochMs,issuedUptimeMs") return "clock-uncertain";
    const clock = c as Record<string, unknown>;
    if (![now, uptime, r.issuedAt, r.expiresAt, clock.issuedUptimeMs, clock.bootEstimateEpochMs].every(Number.isSafeInteger) ||
        typeof r.issuedAt !== "number" || typeof r.expiresAt !== "number" ||
        typeof clock.issuedUptimeMs !== "number" || typeof clock.bootEstimateEpochMs !== "number" ||
        r.expiresAt - r.issuedAt !== 300_000 || now < r.issuedAt || uptime < clock.issuedUptimeMs ||
        Math.abs(now - uptime - clock.bootEstimateEpochMs) > 1000 ||
        Math.abs(now - r.issuedAt - (uptime - clock.issuedUptimeMs)) > 1000) return "clock-uncertain";
    return now >= r.expiresAt || uptime - clock.issuedUptimeMs >= 300_000 ? "expired" : null;
  };
  let reaped = 0;
  const central = path.join(ctx.home, "environment", "grants");
  for (const id of fs.existsSync(central) ? fs.readdirSync(central) : []) {
    if (reaped === limit) break;
    if (!uuid(id)) throw new Error("ENV_GRANT_INVALID");
    const grant = record(path.join(central, id, "grant.json"), 16 * 1024, grantKeys);
    if (!grant || grant.authorityGeneration !== currentConfig(ctx).authorityGeneration) continue;
    const prepared = record(path.join(central, id, "prepared.json"), 64 * 1024, preparedKeys);
    const reason = expiryReason(grant, prepared);
    if (reason && abortGrant(ctx, id, reason)) reaped++;
  }
  const explicit = path.join(ctx.home, "environment", "explicit-receipts");
  for (const id of fs.existsSync(explicit) ? fs.readdirSync(explicit) : []) {
    if (reaped === limit) break;
    if (!uuid(id)) throw new Error("ENV_GRANT_INVALID");
    const count = record(path.join(explicit, id, "record.json"), 4096, countKeys);
    if (!count || count.authorityGeneration !== currentConfig(ctx).authorityGeneration ||
        !sidPattern.test(String(count.sid))) continue;
    const receipt = record(path.join(ctx.home, "sessions", String(count.sid), "explicit-handoffs", id, "receipt.json"),
      16 * 1024, ["version", "consumerId", "controllerRootId", "authorityGeneration", "sid", "attempt",
        "executable", "command", "issuedAt", "expiresAt", "payloadPath", "restart", "clock"]);
    if (receipt) {
      const reason = expiryReason(receipt, receipt);
      if (reason && abortExplicitReceipt(ctx, String(count.sid), id, reason)) reaped++;
    }
  }
  return reaped;
}
