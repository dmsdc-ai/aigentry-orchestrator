import * as path from "node:path";
import { validDeclaredVersion } from "./executable-version.js";

export interface Descriptor {
  readonly id: string;
  readonly kind?: "setting";
  readonly owner?: "controller";
  readonly aliases: readonly string[];
  readonly valid: (value: unknown) => value is string;
  readonly fallback?: string;
  readonly legacy?: "cli" | "model" | "effort";
}
export interface CatalogRecord {
  readonly id: string;
  readonly kind: "secret-reference" | "native-owner" | "runtime-output" | "external-owner";
  readonly owner: string;
  readonly sourceKinds: readonly string[];
  readonly consumerIds: readonly string[];
  readonly deliveryIds: readonly string[];
  readonly editable: false;
  readonly capability: string;
  readonly readiness: string;
  readonly provenance: "repository";
}
const catalog = (id: string, kind: CatalogRecord["kind"], owner: string, capability: string,
  readiness: string, sourceKinds: string[] = [], consumerIds: string[] = [], deliveryIds: string[] = []): CatalogRecord =>
  Object.freeze({ id, kind, owner, sourceKinds, consumerIds, deliveryIds, editable: false, capability, readiness, provenance: "repository" });
export const CATALOG: readonly CatalogRecord[] = Object.freeze([
  catalog("claude.worker.oauth", "secret-reference", "trusted-controller", "confined-worker-delivery", "fresh-input-required",
    ["invocation-input"], ["claude-confined-worker"], ["claude-code-oauth-env"]),
  catalog("claude.native.oauth", "native-owner", "claude", "native-only", "native-owner-unmeasured"),
  catalog("codex.native.auth", "native-owner", "codex", "native-only", "native-owner-unmeasured"),
  catalog("codex.appServer.externalChatGPTTokens", "external-owner", "codex-app-server", "interface-known", "unsupported"),
  catalog("gemini.native.auth", "native-owner", "gemini", "native-only", "unsupported"),
  catalog("grok.native.auth", "native-owner", "grok", "native-only", "unsupported"),
  catalog("telepty.daemon.auth", "external-owner", "telepty", "loopback-control-only", "native-owner-unmeasured"),
  catalog("vault.references", "secret-reference", "optional-vault", "unavailable", "backend-unavailable"),
  catalog("runtime.task", "runtime-output", "controller", "read-only", "runtime-owned"),
  catalog("runtime.sid", "runtime-output", "controller", "read-only", "runtime-owned"),
  catalog("runtime.attempt", "runtime-output", "controller", "read-only", "runtime-owned"),
  catalog("runtime.outbox", "runtime-output", "controller", "read-only", "runtime-owned"),
  catalog("runtime.home", "runtime-output", "controller", "read-only", "runtime-owned"),
]);
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/.test(v);
const effort = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9_-]{0,23}$/.test(v);
const absolute = (v: unknown): v is string => typeof v === "string" && Buffer.byteLength(v) <= 4096 && path.isAbsolute(v) && !/[\u0000-\u001f\u007f]/.test(v);
const choice = (...values: string[]) => (v: unknown): v is string => typeof v === "string" && values.includes(v);
const integer = (min: number, max: number) => (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) && Number(v) >= min && Number(v) <= max;
export const DESCRIPTORS: readonly Descriptor[] = Object.freeze([
  { id: "boot.cli", aliases: ["ORCHESTRATOR_CLI", "AIGENTRY_BOOT_CLI"], valid: choice("claude", "codex", "gemini", "grok"), legacy: "cli" },
  { id: "dispatch.cli", aliases: ["AIGENTRY_DISPATCH_CLI"], valid: choice("auto", "claude", "codex", "gemini", "grok"), legacy: "cli" },
  { id: "control.workspace", aliases: ["AIGENTRY_CONTROL_WORKSPACE"], valid: absolute },
  { id: "boot.sid", aliases: ["ORCHESTRATOR_SID"], valid: (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128 && !v.startsWith("-") && !/[\s\u0000-\u001f\u007f-\u009f]/.test(v), fallback: "orchestrator" },
  { id: "boot.model", aliases: ["AIGENTRY_BOOT_MODEL"], valid: token, legacy: "model" },
  { id: "boot.effort", aliases: ["AIGENTRY_BOOT_EFFORT"], valid: effort, legacy: "effort" },
  ...(["claude", "codex", "gemini", "grok"] as const).flatMap((cli): Descriptor[] => [
    { id: `${cli}.model`, aliases: [`AIGENTRY_${cli.toUpperCase()}_MODEL`], valid: token, legacy: "model" },
    { id: `${cli}.effort`, aliases: [`AIGENTRY_${cli.toUpperCase()}_EFFORT`], valid: effort, legacy: "effort" },
  ]),
  ...(["claude", "codex"] as const).flatMap((cli): Descriptor[] => [
    { id: `${cli}.executable`, aliases: [`AIGENTRY_${cli.toUpperCase()}_EXECUTABLE`], valid: absolute },
    { id: `${cli}.version`, aliases: [`AIGENTRY_${cli.toUpperCase()}_EXECUTABLE_VERSION`], valid: validDeclaredVersion },
  ]),
  { id: "gemini.binary", aliases: ["AIGENTRY_GEMINI_BINARY"], valid: choice("agy", "gemini") },
  { id: "router.profile", aliases: ["AIGENTRY_ROUTER_PROFILE"], valid: absolute },
  { id: "catalog.metadata", aliases: ["AIGENTRY_MODEL_METADATA"], valid: choice("off") },
  { id: "catalog.deadlineMs", aliases: ["AIGENTRY_CATALOG_REVALIDATE_MS"], valid: integer(1, 2500) },
  { id: "catalog.maxBytes", aliases: ["AIGENTRY_CATALOG_MAX_BYTES"], valid: integer(1, 2097152) },
  { id: "catalog.maxRedirects", aliases: ["AIGENTRY_CATALOG_MAX_REDIRECTS"], valid: integer(0, 2) },
]);
export function descriptor(id: string): Descriptor {
  const d = DESCRIPTORS.find((entry) => entry.id === id);
  if (!d) throw new Error("ENV_UNKNOWN_SETTING");
  return d;
}
export function validateSetting(id: string, value: unknown): string {
  if ((id === "claude.version" || id === "codex.version") && !validDeclaredVersion(value)) {
    throw new Error(`ENV_INVALID_VALUE: ${id}: identity-bound JSON declaration required; bare version refused`);
  }
  if (!descriptor(id).valid(value)) throw new Error(`ENV_INVALID_VALUE: ${id}`);
  return value as string;
}
