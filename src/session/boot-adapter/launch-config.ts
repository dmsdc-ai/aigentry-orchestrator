// #1162 — LaunchConfig v2 resolution, shared by every adapter.
// Each adapter resolves its model/effort ONCE here, builds argv from `arg` and
// `launch` from the same settings, so the emitted command and its metadata
// cannot drift. Nothing parses argv.
import {
  isCliKind,
  type CliKind,
  type LaunchConfig,
  type LaunchSource,
  type LaunchValue,
} from "./types.js";

// `arg` is what the adapter passes to the CLI; null = no flag (CLI decides).
export interface LaunchSetting {
  readonly arg: string | null;
  readonly source: LaunchSource;
}

// No flag exists or none is passed: the CLI picks the value itself.
export const CLI_DEFAULT: LaunchSetting = Object.freeze({ arg: null, source: "cli-default" });

// Existing `env[name] || fallback` precedence (empty string ⇒ fallback).
export function envOrDefault(
  env: NodeJS.ProcessEnv,
  name: `AIGENTRY_${string}`,
  fallback: string,
): { readonly arg: string; readonly source: LaunchSource } {
  const v = env[name];
  return v ? { arg: v, source: `env:${name}` } : { arg: fallback, source: "default" };
}

// Existing `env[name] ? [flag, value] : []` opt-in (empty string ⇒ no flag).
export function optInEnv(env: NodeJS.ProcessEnv, name: `AIGENTRY_${string}`): LaunchSetting {
  const v = env[name];
  return v ? { arg: v, source: `env:${name}` } : CLI_DEFAULT;
}

// Bounded label charsets (contract v1 §2). Labels are data only.
const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,96}$/;
const EFFORT_RE = /^[a-z0-9_-]{1,24}$/;
const ENV_SOURCE_RE = /^env:AIGENTRY_[A-Z0-9_]{1,64}$/;

const UNKNOWN: LaunchValue = Object.freeze({ value: "unknown", source: "unknown" });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasExactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

function normalizeValue(raw: unknown, re: RegExp): LaunchValue {
  if (!isPlainObject(raw) || !hasExactKeys(raw, ["value", "source"])) return UNKNOWN;
  const { value, source } = raw;
  if (typeof value !== "string" || typeof source !== "string") return UNKNOWN;
  if (source === "cli-default") return value === "unknown" ? Object.freeze({ value, source }) : UNKNOWN;
  if (source === "unknown") return UNKNOWN;
  if (source !== "default" && !ENV_SOURCE_RE.test(source)) return UNKNOWN;
  if (!re.test(value)) return UNKNOWN;
  return Object.freeze({ value, source: source as LaunchSource });
}

// Validate an untrusted/external record. Anything missing or malformed becomes
// an explicit unknown — never a false known value.
export function normalizeLaunch(cli: CliKind, raw: unknown): LaunchConfig {
  const ok = isPlainObject(raw) && hasExactKeys(raw, ["v", "cli", "model", "effort"]) &&
    raw.v === 2 && isCliKind(raw.cli) && raw.cli === cli;
  return Object.freeze({
    v: 2,
    cli,
    model: ok ? normalizeValue(raw.model, MODEL_RE) : UNKNOWN,
    effort: ok ? normalizeValue(raw.effort, EFFORT_RE) : UNKNOWN,
  });
}

// Metadata for the settings an adapter just used to build argv.
export function launchConfig(cli: CliKind, model: LaunchSetting, effort: LaunchSetting): LaunchConfig {
  const field = (s: LaunchSetting) => ({ value: s.arg ?? "unknown", source: s.source });
  return normalizeLaunch(cli, { v: 2, cli, model: field(model), effort: field(effort) });
}
