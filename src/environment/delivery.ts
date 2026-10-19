import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { object, strictJson, uuid, type ConfigV2 } from "./contract.js";
import { assertSelectionCurrent, currentConfig, inspectGrants, type BindingSelection, type ControllerContext } from "./grants.js";
import { durableWriteExclusive, fsyncDirectory, readBounded, withWriterLock } from "./storage.js";
import { type OwnedInput } from "./owned-input.js";
import { CLAUDE_OAUTH_CHILD, CLAUDE_OAUTH_DIR, CLAUDE_OAUTH_FILE, readClaudeOAuthHandoff } from "../session/claude-worker-oauth.js";
import { assertExecutableIdentity, readSandboxCurrent, type WorkerScope, type WorkerManifestV2 } from "../session/worker-sandbox.js";
import { validateExecutableBinding } from "../session/model-decision.js";

const SHA = /^[0-9a-f]{64}$/;
const SID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const sha = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const o = object(value);
  if (Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o, k))) throw new Error("ENV_GRANT_INVALID");
  return o;
}
function doc(file: string, max: number, keys: readonly string[]): Record<string, unknown> {
  const raw = readBounded(file);
  if (raw === null || Buffer.byteLength(raw) > max) throw new Error("ENV_GRANT_INVALID");
  return exact(strictJson(raw), keys);
}
const grantKeys = ["version", "grantId", "controllerRootId", "authorityGeneration", "task", "sid", "attempt",
  "consumerId", "executableBinding", "projectEnrollmentId", "targetRootIdentity", "configRevision", "bindingId",
  "bindingEpoch", "projectEpoch", "destinationId", "issuedAt", "expiresAt"];
const preparedKeys = ["version", "grantId", "controllerRootId", "authorityGeneration", "task", "sid", "attempt",
  "manifestSha256", "scope", "payloadPath", "preparedAt", "clock"];
export interface ReservedDeliveryIds { readonly grantId: string; readonly attempt: string }
export const reserveDeliveryIds = (): ReservedDeliveryIds => ({ grantId: randomUUID(), attempt: randomUUID() });
const grantDir = (ctx: ControllerContext, grantId: string): string => path.join(ctx.home, "environment", "grants", grantId);
const payloadPath = (ctx: ControllerContext, sid: string, attempt: string): string =>
  path.join(ctx.home, "sessions", sid, "sandbox", attempt, CLAUDE_OAUTH_DIR, CLAUDE_OAUTH_FILE);
function safeDir(dir: string): void {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error("ENV_UNSAFE_PATH");
}
function safePayload(file: string): void {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > 4097) {
    throw new Error("ENV_UNSAFE_PATH");
  }
}
function marker(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
function clock(): { issuedUptimeMs: number; bootEstimateEpochMs: number } {
  const uptime = Math.floor(os.uptime() * 1000), now = Date.now();
  if (!Number.isSafeInteger(uptime) || uptime < 0 || !Number.isSafeInteger(now)) throw new Error("ENV_GRANT_CLOCK_UNCERTAIN");
  return { issuedUptimeMs: uptime, bootEstimateEpochMs: now - uptime };
}
function checkClock(grant: Record<string, unknown>, prepared: Record<string, unknown>): void {
  const c = exact(prepared.clock, ["issuedUptimeMs", "bootEstimateEpochMs"]);
  const now = Date.now(), uptime = Math.floor(os.uptime() * 1000);
  const issued = grant.issuedAt, expires = grant.expiresAt;
  if (![now, uptime, issued, expires, c.issuedUptimeMs, c.bootEstimateEpochMs].every(Number.isSafeInteger) ||
      typeof issued !== "number" || typeof expires !== "number" ||
      typeof c.issuedUptimeMs !== "number" || typeof c.bootEstimateEpochMs !== "number" ||
      expires - issued !== 300_000 || now < issued || uptime < c.issuedUptimeMs ||
      Math.abs((now - uptime) - c.bootEstimateEpochMs) > 1000 ||
      Math.abs((now - issued) - (uptime - c.issuedUptimeMs)) > 1000) throw new Error("ENV_GRANT_CLOCK_UNCERTAIN");
  if (now >= expires || uptime - c.issuedUptimeMs >= 300_000) throw new Error("ENV_GRANT_EXPIRED");
}
export interface PreparedGrantRef { readonly grantId: string; readonly manifest: string; readonly hash: string }
export function prepareGrant(ctx: ControllerContext, selected: BindingSelection, scope: WorkerScope,
  manifest: WorkerManifestV2, rawManifest: string, input: OwnedInput): PreparedGrantRef {
  if (!uuid(manifest.delivery.grantId) ||
      manifest.delivery.grantArtifact !== path.join(grantDir(ctx, manifest.delivery.grantId), "grant.json") ||
      manifest.attempt !== path.basename(path.dirname(manifest.receipt)) || manifest.sid !== scope.sid || manifest.task !== scope.task ||
      manifest.controllerRootId !== ctx.rootId || manifest.authorityGeneration !== selected.authorityGeneration ||
      manifest.targetProject.enrollmentId !== selected.enrollmentId || manifest.targetProject.epoch !== selected.projectEpoch) {
    throw new Error("ENV_GRANT_INVALID");
  }
  const hash = sha(rawManifest), manifestFile = path.join(path.dirname(manifest.receipt), "manifest.json");
  if (rawManifest !== JSON.stringify(manifest, null, 2) + "\n") throw new Error("ENV_GRANT_INVALID");
  const ownedPayload = payloadPath(ctx, scope.sid, manifest.attempt);
  const grantId = manifest.delivery.grantId;
  let token: Buffer | undefined;
  try {
    return withWriterLock(ctx.home, () => {
      const c = assertSelectionCurrent(ctx, selected);
      if (inspectGrants(ctx).total >= 1024) throw new Error("ENV_GRANT_STORE_FULL");
      const gbase = path.join(ctx.home, "environment", "grants");
      fs.mkdirSync(gbase, { mode: 0o700, recursive: true }); safeDir(gbase);
      const dir = grantDir(ctx, grantId);
      fs.mkdirSync(dir, { mode: 0o700 }); safeDir(dir); fsyncDirectory(gbase);
      const handoffDir = path.dirname(ownedPayload);
      fs.mkdirSync(handoffDir, { mode: 0o700 }); safeDir(handoffDir);
      token = input.consume();
      if (token.length < 1 || token.length > 4096 || !token.every(b => b >= 0x21 && b <= 0x7e)) throw new Error("ENV_INPUT_INVALID");
      durableWriteExclusive(ownedPayload, Buffer.concat([token, Buffer.from("\n")]));
      token.fill(0); token = undefined;
      safePayload(ownedPayload);
      const now = Date.now(), stamp = clock();
      const grant = { version: 1, grantId, controllerRootId: ctx.rootId, authorityGeneration: c.authorityGeneration,
        task: scope.task, sid: scope.sid, attempt: manifest.attempt, consumerId: selected.binding.consumerId,
        executableBinding: selected.binding.executableBinding, projectEnrollmentId: selected.enrollmentId,
        targetRootIdentity: selected.projectIdentity, configRevision: c.revision, bindingId: selected.bindingId,
        bindingEpoch: selected.binding.securityEpoch, projectEpoch: selected.projectEpoch,
        destinationId: selected.binding.destinationId, issuedAt: now, expiresAt: now + 300_000 };
      durableWriteExclusive(path.join(dir, "grant.json"), JSON.stringify(grant) + "\n");
      const raw = fs.readFileSync(manifestFile, "utf8");
      if (raw !== rawManifest || sha(raw) !== hash) throw new Error("ENV_GRANT_INVALID");
      const prepared = { version: 1, grantId, controllerRootId: ctx.rootId, authorityGeneration: c.authorityGeneration,
        task: scope.task, sid: scope.sid, attempt: manifest.attempt, manifestSha256: hash, scope,
        payloadPath: ownedPayload, preparedAt: now, clock: stamp };
      durableWriteExclusive(path.join(dir, "prepared.json"), JSON.stringify(prepared) + "\n");
      const stage = path.join(ctx.home, "sessions", scope.sid);
      const pointer = path.join(stage, `sandbox-current.${manifest.attempt}.tmp`);
      durableWriteExclusive(pointer, JSON.stringify({ manifest: manifestFile, hash }) + "\n");
      fs.renameSync(pointer, path.join(stage, "sandbox-current.json"));
      fsyncDirectory(stage);
      return { grantId, manifest: manifestFile, hash };
    });
  } finally { token?.fill(0); input.dispose(); }
}
export function claimGrant(ctx: ControllerContext, m: WorkerManifestV2, hash: string): Record<string, string> {
  if (!uuid(m.delivery.grantId) || !SHA.test(hash) || !SID.test(m.sid)) throw new Error("ENV_GRANT_INVALID");
  return withWriterLock(ctx.home, () => {
    const c: ConfigV2 = currentConfig(ctx), dir = grantDir(ctx, m.delivery.grantId);
    safeDir(dir);
    if (marker(path.join(dir, "spent.json"))) throw new Error("ENV_GRANT_SPENT");
    if (marker(path.join(dir, "terminal.json"))) throw new Error("ENV_GRANT_REVOKED");
    const g = doc(path.join(dir, "grant.json"), 16 * 1024, grantKeys);
    const p = doc(path.join(dir, "prepared.json"), 64 * 1024, preparedKeys);
    try { validateExecutableBinding(g.executableBinding, "claude"); }
    catch { throw new Error("ENV_GRANT_INVALID"); }
    const identity = exact(g.targetRootIdentity, ["dev", "ino"]);
    if (typeof identity.dev !== "string" || typeof identity.ino !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(identity.dev) || !/^(0|[1-9][0-9]*)$/.test(identity.ino)) {
      throw new Error("ENV_GRANT_INVALID");
    }
    if (g.version !== 1 || p.version !== 1 || g.grantId !== m.delivery.grantId || p.grantId !== g.grantId ||
        g.controllerRootId !== ctx.rootId || p.controllerRootId !== ctx.rootId ||
        g.authorityGeneration !== c.authorityGeneration || p.authorityGeneration !== c.authorityGeneration ||
        m.authorityGeneration !== c.authorityGeneration || g.task !== m.task || p.task !== m.task ||
        g.sid !== m.sid || p.sid !== m.sid || g.attempt !== m.attempt || p.attempt !== m.attempt ||
        g.consumerId !== "claude-confined-worker" || g.destinationId !== "claude-code-oauth-env" ||
        p.manifestSha256 !== hash || m.delivery.grantArtifact !== path.join(dir, "grant.json")) throw new Error("ENV_GRANT_INVALID");
    const admitted = exact(p.scope, ["version", "task", "sid", "read", "write", "domains"]);
    if (admitted.version !== 1 || admitted.task !== m.task || admitted.sid !== m.sid ||
        ![admitted.read, admitted.write, admitted.domains].every(v => Array.isArray(v) &&
          v.every(x => typeof x === "string"))) throw new Error("ENV_GRANT_INVALID");
    const stage = path.join(ctx.home, "sessions", m.sid), current = readSandboxCurrent(stage);
    const manifestFile = path.join(stage, "sandbox", m.attempt, "manifest.json");
    if (current.manifest !== manifestFile || current.hash !== hash || sha(fs.readFileSync(manifestFile, "utf8")) !== hash) throw new Error("ENV_GRANT_INVALID");
    const selected = c.bindings[String(g.bindingId)], enrolled = c.projectEnrollments[String(g.projectEnrollmentId)];
    if (!selected?.enabled || !enrolled?.enabled || selected.securityEpoch !== g.bindingEpoch || enrolled.securityEpoch !== g.projectEpoch ||
        selected.descriptorId !== "claude.worker.oauth" || selected.source.kind !== "invocation-input" ||
        !selected.projectEnrollmentIds.includes(String(g.projectEnrollmentId)) || c.revision < Number(g.configRevision) ||
        JSON.stringify(selected.executableBinding) !== JSON.stringify(g.executableBinding) ||
        JSON.stringify(enrolled.identity) !== JSON.stringify(g.targetRootIdentity) ||
        enrolled.canonicalRoot !== m.targetProject.canonicalRoot) throw new Error("ENV_GRANT_REVOKED");
    const target = fs.statSync(enrolled.canonicalRoot);
    if (String(target.dev) !== enrolled.identity.dev || String(target.ino) !== enrolled.identity.ino) throw new Error("ENV_PROJECT_IDENTITY_CHANGED");
    assertExecutableIdentity(selected.executableBinding, m.command[0]!);
    checkClock(g, p);
    const tokenFile = payloadPath(ctx, m.sid, m.attempt);
    if (p.payloadPath !== tokenFile) throw new Error("ENV_GRANT_INVALID");
    safePayload(tokenFile);
    const spent = { version: 1, grantId: m.delivery.grantId, controllerRootId: ctx.rootId,
      authorityGeneration: c.authorityGeneration, attempt: m.attempt, claimedAt: Date.now(), claimNonce: randomUUID() };
    // Exclusive durable spend is the linearization point. Any subsequent
    // failure consumes this grant permanently; no retry reads the payload.
    durableWriteExclusive(path.join(dir, "spent.json"), JSON.stringify(spent) + "\n");
    const token = readClaudeOAuthHandoff(tokenFile, tokenFile);
    fs.unlinkSync(tokenFile);
    fsyncDirectory(path.dirname(tokenFile));
    return { [CLAUDE_OAUTH_CHILD]: token };
  });
}
