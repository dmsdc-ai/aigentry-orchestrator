import { validateSetting } from "./descriptors.js";
import * as path from "node:path";
import { validateExecutableBinding, type ExecutableBinding } from "../session/model-decision.js";

export const MAX_CONFIG_BYTES = 128 * 1024;
export type Settings = Record<string, string>;
export interface BaseConfig {
  revision: number;
  selectedProfile: string | null;
  settings: Settings;
  profiles: Record<string, Settings>;
  projects: Record<string, Settings>;
}
export interface ConfigV1 extends BaseConfig { version: 1 }
export interface FileIdentity { dev: string; ino: string }
export interface ControllerRecord { rootId: string; canonicalRoot: string; rootIdentity: FileIdentity }
export interface ProjectEnrollment { canonicalRoot: string; identity: FileIdentity; enabled: boolean; securityEpoch: number }
export interface ProjectOverride { settings: Settings; profiles: Record<string, Settings> }
export interface Binding {
  descriptorId: "claude.worker.oauth";
  source: { kind: "invocation-input"; locatorId: string } | { kind: "vault-ref"; refId: string } |
    { kind: "automation-owner"; ownerId: string; locatorId: string };
  enabled: boolean;
  securityEpoch: number;
  projectEnrollmentIds: string[];
  consumerId: "claude-confined-worker";
  destinationId: "claude-code-oauth-env";
  executableBinding: ExecutableBinding;
}
export interface ConfigV2 extends BaseConfig {
  version: 2;
  authorityGeneration: number;
  controller: ControllerRecord;
  projectEnrollments: Record<string, ProjectEnrollment>;
  projectOverrides: Record<string, ProjectOverride>;
  bindings: Record<string, Binding>;
}
export type Config = ConfigV1 | ConfigV2;
export const emptyConfig = (): ConfigV1 => ({ version: 1, revision: 0, selectedProfile: null, settings: {}, profiles: {}, projects: {} });
export const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const decimal = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);
export const absoluteRoot = (v: unknown): v is string => typeof v === "string" && v.length <= 4096 && path.isAbsolute(v) && path.normalize(v) === v && !/[\u0000-\u001f\u007f]/.test(v);
function exact(o: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(o).length !== keys.length || keys.some((k) => !Object.hasOwn(o, k))) throw new Error("ENV_SCHEMA");
}
function identity(v: unknown): FileIdentity {
  const o = object(v); exact(o, ["dev", "ino"]);
  if (!decimal(o.dev) || !decimal(o.ino)) throw new Error("ENV_SCHEMA");
  return { dev: o.dev, ino: o.ino };
}
function registries(o: Record<string, unknown>): Pick<ConfigV2, "controller" | "projectEnrollments" | "projectOverrides" | "bindings" | "authorityGeneration"> {
  if (!positive(o.authorityGeneration)) throw new Error("ENV_SCHEMA");
  const c = object(o.controller); exact(c, ["rootId", "canonicalRoot", "rootIdentity"]);
  if (!uuid(c.rootId) || !absoluteRoot(c.canonicalRoot)) throw new Error("ENV_SCHEMA");
  const controller: ControllerRecord = { rootId: c.rootId, canonicalRoot: c.canonicalRoot, rootIdentity: identity(c.rootIdentity) };
  const projectEnrollments: Record<string, ProjectEnrollment> = {};
  const projectOverrides: Record<string, ProjectOverride> = {};
  const bindings: Record<string, Binding> = {};
  const pe = Object.entries(object(o.projectEnrollments));
  const po = Object.entries(object(o.projectOverrides));
  const bs = Object.entries(object(o.bindings));
  if (pe.length > 64 || po.length > 64 || bs.length > 64) throw new Error("ENV_SCHEMA_BOUND");
  for (const [id, raw] of pe) {
    const e = object(raw); exact(e, ["canonicalRoot", "identity", "enabled", "securityEpoch"]);
    if (!uuid(id) || !absoluteRoot(e.canonicalRoot) || typeof e.enabled !== "boolean" || !positive(e.securityEpoch)) throw new Error("ENV_SCHEMA");
    projectEnrollments[id] = { canonicalRoot: e.canonicalRoot, identity: identity(e.identity), enabled: e.enabled, securityEpoch: e.securityEpoch };
  }
  for (const [id, raw] of po) {
    const p = object(raw); exact(p, ["settings", "profiles"]);
    if (!Object.hasOwn(projectEnrollments, id)) throw new Error("ENV_SCHEMA");
    const profiles: Record<string, Settings> = {};
    for (const [name, v] of Object.entries(object(p.profiles))) profiles[profileName(name)] = settings(v);
    if (Object.keys(profiles).length > 32) throw new Error("ENV_SCHEMA_BOUND");
    projectOverrides[id] = { settings: settings(p.settings), profiles };
  }
  for (const [id, raw] of bs) {
    const b = object(raw); exact(b, ["descriptorId", "source", "enabled", "securityEpoch", "projectEnrollmentIds", "consumerId", "destinationId", "executableBinding"]);
    if (!uuid(id) || b.descriptorId !== "claude.worker.oauth" || typeof b.enabled !== "boolean" || !positive(b.securityEpoch) ||
        b.consumerId !== "claude-confined-worker" || b.destinationId !== "claude-code-oauth-env") throw new Error("ENV_SCHEMA");
    const s = object(b.source);
    if (s.kind === "invocation-input") { exact(s, ["kind", "locatorId"]); if (!uuid(s.locatorId)) throw new Error("ENV_SCHEMA"); }
    else if (s.kind === "vault-ref") { exact(s, ["kind", "refId"]); if (!uuid(s.refId)) throw new Error("ENV_SCHEMA"); }
    else if (s.kind === "automation-owner") { exact(s, ["kind", "ownerId", "locatorId"]); if (typeof s.ownerId !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/.test(s.ownerId) || !uuid(s.locatorId)) throw new Error("ENV_SCHEMA"); }
    else throw new Error("ENV_SCHEMA");
    if (!Array.isArray(b.projectEnrollmentIds) || b.projectEnrollmentIds.length > 64 ||
        new Set(b.projectEnrollmentIds).size !== b.projectEnrollmentIds.length ||
        !b.projectEnrollmentIds.every((x) => uuid(x) && Object.hasOwn(projectEnrollments, x))) throw new Error("ENV_SCHEMA");
    bindings[id] = { descriptorId: "claude.worker.oauth", source: s as unknown as Binding["source"], enabled: b.enabled,
      securityEpoch: b.securityEpoch, projectEnrollmentIds: b.projectEnrollmentIds,
      consumerId: "claude-confined-worker", destinationId: "claude-code-oauth-env",
      executableBinding: validateExecutableBinding(b.executableBinding, "claude") };
  }
  return { controller, authorityGeneration: o.authorityGeneration, projectEnrollments, projectOverrides, bindings };
}
const forbidden = (k: string) => k === "__proto__" || k === "prototype" || Object.hasOwn(Object.prototype, k);
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ENV_SCHEMA");
  return value as Record<string, unknown>;
}
export function profileName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) || forbidden(value)) throw new Error("ENV_PROFILE_INVALID");
  return value;
}
// Tokenize before JSON.parse so escaped duplicate keys cannot be silently overwritten.
// No evaluation; JSON.parse remains the grammar authority. Bounded depth prevents stack exhaustion.
export function strictJson(raw: string): unknown {
  if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) throw new Error("ENV_CONFIG_TOO_LARGE");
  const tokens = raw.match(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "{" || t === "[") {
      if (stack.length >= 16) throw new Error("ENV_CONFIG_DEPTH");
      stack.push(t === "{" ? new Set() : null);
    } else if (t === "}" || t === "]") stack.pop();
    else if (t?.startsWith('"') && tokens[i + 1] === ":") {
      const key = JSON.parse(t) as string;
      const keys = stack[stack.length - 1];
      if (forbidden(key) || keys?.has(key)) throw new Error("ENV_DUPLICATE_OR_PROTOTYPE_KEY");
      keys?.add(key);
    }
  }
  try { return JSON.parse(raw) as unknown; } catch { throw new Error("ENV_JSON_INVALID"); }
}
export function settings(value: unknown): Settings {
  const result: Settings = {};
  const entries = Object.entries(object(value));
  if (entries.length > 64) throw new Error("ENV_SCHEMA_BOUND");
  for (const [id, v] of entries) result[id] = validateSetting(id, v);
  return result;
}
export function validateConfig(value: unknown): Config {
  const o = object(value);
  if (Object.keys(o).length === 0) return emptyConfig();
  const keys = ["version", "revision", "selectedProfile", "settings", "profiles", "projects"];
  const version = o.version;
  if (version !== 1 && version !== 2) throw new Error("ENV_SCHEMA");
  exact(o, version === 1 ? keys : [...keys, "controller", "projectEnrollments", "projectOverrides", "bindings", "authorityGeneration"]);
  if (
      !Number.isSafeInteger(o.revision) || Number(o.revision) < 0) throw new Error("ENV_SCHEMA");
  const profiles: Record<string, Settings> = {};
  const projects: Record<string, Settings> = {};
  for (const [key, v] of Object.entries(object(o.profiles))) profiles[profileName(key)] = settings(v);
  // Canonical target roots are revalidated by the resolver, never derived from project labels.
  for (const [key, v] of Object.entries(object(o.projects))) {
    if (!path.isAbsolute(key) || key.length > 4096 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error("ENV_PROJECT_INVALID");
    projects[key] = settings(v);
  }
  if (Object.keys(profiles).length > 32 || Object.keys(projects).length > 64) throw new Error("ENV_SCHEMA_BOUND");
  const selectedProfile = o.selectedProfile === null ? null : profileName(o.selectedProfile);
  if (selectedProfile !== null && !Object.hasOwn(profiles, selectedProfile)) throw new Error("ENV_PROFILE_MISSING");
  const base = { revision: Number(o.revision), selectedProfile, settings: settings(o.settings), profiles, projects };
  return version === 1 ? { version: 1, ...base } : { version: 2, ...base, ...registries(o) };
}
