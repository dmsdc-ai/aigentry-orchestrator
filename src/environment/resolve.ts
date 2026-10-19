import * as fs from "node:fs";
import * as path from "node:path";
import { object, strictJson, type Config, type Settings } from "./contract.js";
import { DESCRIPTORS, validateSetting } from "./descriptors.js";
import { readLegacyBounded } from "./storage.js";

export interface Resolution {
  readonly revision: number;
  readonly values: Settings;
  readonly provenance: Record<string, string>;
}
export interface ResolveInput {
  config: Config;
  env: NodeJS.ProcessEnv;
  flags?: Settings;
  targetCwd?: string;
  role?: string;
  legacy?: Record<string, unknown>;
}
export function readLegacy(home: string): Record<string, unknown> {
  const raw = readLegacyBounded(path.join(home, "config.json"));
  return raw === null ? {} : object(strictJson(raw));
}
export function resolveSettings(input: ResolveInput): Resolution {
  const { config, env } = input;
  const flags = input.flags ?? {};
  for (const [id, v] of Object.entries(flags)) validateSetting(id, v);
  let project: Settings = {};
  let enrolledProject: Settings = {};
  if (Object.keys(config.projects).length) {
    for (const key of Object.keys(config.projects)) {
      if (!path.isAbsolute(key) || fs.realpathSync.native(key) !== key || !fs.statSync(key).isDirectory()) throw new Error("ENV_PROJECT_NOT_CANONICAL");
    }
    if (input.targetCwd) project = config.projects[fs.realpathSync.native(input.targetCwd)] ?? {};
  }
  if (config.version === 2 && input.targetCwd) {
    const target = fs.realpathSync.native(input.targetCwd);
    const st = fs.statSync(target);
    for (const [id, enrollment] of Object.entries(config.projectEnrollments)) {
      if (!enrollment.enabled || enrollment.canonicalRoot !== target ||
          enrollment.identity.dev !== String(st.dev) || enrollment.identity.ino !== String(st.ino)) continue;
      const override = config.projectOverrides[id];
      if (override) enrolledProject = { ...(config.selectedProfile ? override.profiles[config.selectedProfile] : {}), ...override.settings };
      break;
    }
  }
  const profile = config.selectedProfile === null ? {} : config.profiles[config.selectedProfile]!;
  const legacy = input.legacy ?? {};
  const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const defaults = record(legacy.defaults);
  const roles = record(legacy.roles);
  const role = input.role && Object.hasOwn(roles, input.role) ? record(roles[input.role]) : {};
  const owned = { ...defaults, ...role };
  const values: Settings = {}, provenance: Record<string, string> = {};
  const selectedCli = flags["dispatch.cli"] ?? env.AIGENTRY_DISPATCH_CLI ?? enrolledProject["dispatch.cli"] ?? project["dispatch.cli"] ?? profile["dispatch.cli"] ?? config.settings["dispatch.cli"] ??
    flags["boot.cli"] ?? env.ORCHESTRATOR_CLI ?? env.AIGENTRY_BOOT_CLI ?? enrolledProject["boot.cli"] ?? project["boot.cli"] ?? profile["boot.cli"] ?? config.settings["boot.cli"] ?? owned.cli;
  for (const d of DESCRIPTORS) {
    const aliases = d.aliases.filter((name) => env[name] !== undefined);
    for (const name of aliases) validateSetting(d.id, env[name]);
    if (aliases.length > 1 && new Set(aliases.map((name) => env[name])).size !== 1) throw new Error(`ENV_ALIAS_CONFLICT: ${d.id}`);
    const legacyValue = d.legacy && (d.id === "dispatch.cli" || d.id.startsWith("boot.") || d.id.startsWith(`${selectedCli}.`)) ? owned[d.legacy] : undefined;
    const layers: Array<[unknown, string]> = [
      [flags[d.id], "flag"], [aliases.length ? env[aliases[0]!] : undefined, `env:${aliases[0] ?? ""}`],
      [enrolledProject[d.id], "enrolled-project"], [project[d.id], "project"], [profile[d.id], "profile"], [config.settings[d.id], "settings"],
      [legacyValue, "legacy-role"], [d.fallback, "default"],
    ];
    const chosen = layers.find(([v]) => v !== undefined);
    if (chosen) { values[d.id] = validateSetting(d.id, chosen[0]); provenance[d.id] = chosen[1]; }
  }
  const opaque = owned.cli_flags;
  if (opaque !== undefined && typeof opaque !== "string") throw new Error("ENV_LEGACY_FLAGS_INVALID");
  // A conservative lexical conflict check, never shell parsing or migration. Opaque
  // flags remain byte-for-byte owned by the legacy caller when no typed conflict exists.
  if (typeof opaque === "string" && Object.entries(provenance).some(([id, source]) =>
      source !== "legacy-role" && source !== "default" && (
        (id.endsWith(".model") && /(?:--model|-m)(?:[\s="'\\]|$)/.test(opaque)) ||
        (id.endsWith(".effort") && /(?:--effort|--reasoning-effort)(?:[\s="'\\]|$)|model_reasoning_effort\s*=/.test(opaque)) ||
        (id.endsWith(".cli") && owned.cli !== undefined && values[id] !== owned.cli && opaque.trim() !== "")))) {
    throw new Error("ENV_LEGACY_FLAGS_CONFLICT: typed model/effort and opaque cli_flags");
  }
  return { revision: config.revision, values, provenance };
}
export function projectEnvironment(base: NodeJS.ProcessEnv, resolution: Resolution): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const d of DESCRIPTORS) {
    const value = resolution.values[d.id];
    if (value !== undefined && resolution.provenance[d.id] !== "default") for (const alias of d.aliases) env[alias] = value;
  }
  return env;
}
