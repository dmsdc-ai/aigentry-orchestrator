// plan.ts — the boot plan: its type, its validation, its env schema, and the ONE function
// that turns it into an exec argv (#1181). NEW SURFACE, not a port.
//
// PURE BY CONSTRUCTION. Nothing in this file reads `process.env`, touches a file, spawns
// anything or writes a stream. `parseEnvPlan` takes the environment as an argument. That is
// not tidiness: it is what lets the whole validation matrix be exercised without a PTY, a
// daemon, a provider or a process table, and it is why the wizard (interactive) and the
// non-TTY env plan (automated) cannot drift apart — they both end at `buildExecArgv`.
//
// ⚠️ WHAT THIS FILE IS RESPONSIBLE FOR NOT DOING:
//
//   1. NEVER BUILDING A COMMAND STRING. Every value below lands in exactly one element of
//      a string[]. There is no template, no join into a shell line, no `shell: true`
//      anywhere downstream. `;`, `$(…)`, backticks, `&&` and spaces in a value are
//      therefore inert — but they are refused anyway, because the argv crosses back to
//      bin/orchestrator-boot.sh as NEWLINE-DELIMITED TEXT (cli.ts D1) and a field that
//      cannot survive that round trip must not reach it.
//   2. NEVER FILLING AN ABSENCE WITH A PERMISSION. A plan that omits an axis is
//      INCOMPLETE, not "use the unrestricted value". Every missing required field is exit
//      2 with the field named. There is no path through this file that yields an elevated
//      or bypass value the operator did not name AND acknowledge.
//   3. NEVER TREATING ONE PROVIDER'S TOKEN AS ANOTHER'S. Values are looked up in the
//      chosen provider's own axis (provider-capabilities.ts), and the argv they contribute
//      is the array stored beside them. `bypassPermissions` for claude and
//      `bypassPermissions` for grok are two unrelated lookups that happen to spell the
//      same word.
//   4. NEVER CALLING A HANDOFF A RESUME. Native resume is never called a handoff. A handoff
//      is delivered only as tokens from provider-capabilities.ts `handoff` data that point
//      at a file; this module reads no transcript (task 1201, D-1).
import {
  type AxisName,
  type AxisValue,
  type HistorySupport,
  type ProviderCapability,
  type Risk,
  type SelectorForm,
  capabilityKeys,
  defaultAxisValue,
  findAxisValue,
  findCapability,
  findHistory,
} from "./provider-capabilities.js";
import type { HandoffDelivery } from "../context-handoff/types.js";

// ── the env schema, in one place ────────────────────────────────────────────
// ONE deterministic spelling per field, no aliases, no comma lists. The per-axis field is
// semicolon-separated `axis=value` pairs precisely BECAUSE a comma-joined string cannot say
// whether `a,b` is two axes or one value containing a comma, and an undocumented alias is
// how a caller ends up asserting a permission it did not mean.
//
// EVERY NAME HERE MUST ALSO APPEAR IN usage.ts. tests/dispatch/T134 block B and
// tests/packaging/installed-boot-selector.test.mjs read `env.NAME` back out of the
// COMPILED cli.js and fail if usage does not name it.
export const PLAN_ENV = {
  enable: "AIGENTRY_BOOT_PLAN",
  cli: "ORCHESTRATOR_CLI",
  model: "AIGENTRY_BOOT_MODEL",
  effort: "AIGENTRY_BOOT_EFFORT",
  permission: "AIGENTRY_BOOT_PERMISSION",
  history: "AIGENTRY_BOOT_HISTORY",
  ack: "AIGENTRY_BOOT_RISK_ACK",
  sid: "ORCHESTRATOR_SID",
} as const;

export type ModelChoice = { readonly kind: "provider-default" } | { readonly kind: "explicit"; readonly id: string };

export type EffortChoice =
  | { readonly kind: "provider-default" }
  | { readonly kind: "enum"; readonly flag: string; readonly value: string }
  | { readonly kind: "unverified"; readonly flag: string; readonly value: string };

export interface AxisChoice {
  readonly axis: AxisName;
  readonly value: string;
  readonly argv: readonly string[];
  readonly risk: Risk;
  readonly covers: readonly AxisName[];
}

export type HistoryChoice =
  | { readonly kind: "new" }
  | { readonly kind: "last" }
  | { readonly kind: "selected"; readonly selector: string };

/** A complete, validated boot plan. Only `validate*` / `parseEnvPlan` may produce one. */
export interface BootPlan {
  readonly provider: ProviderCapability;
  readonly sid: string;
  readonly model: ModelChoice;
  readonly effort: EffortChoice;
  readonly permissions: readonly AxisChoice[];
  readonly history: HistoryChoice;
  /** The cwd the exec will INHERIT. Recorded for display; never turned into a flag. */
  readonly inheritedCwd: string;
}

export interface PlanError {
  readonly field: string;
  readonly message: string;
}

export type PlanResult = { readonly ok: true; readonly plan: BootPlan } | { readonly ok: false; readonly errors: readonly PlanError[] };

// ── field validation ────────────────────────────────────────────────────────

/**
 * The same code-point scan cli.ts's D1 refusal uses, for the same reason: the argv crosses
 * back to the shim as text. A regex would need an escaped range; a scan needs no escaping,
 * which is one less thing for a copy of this file to get wrong.
 */
export function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === undefined) continue;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * The floor every field crosses, whatever else is checked on top: non-empty, no control
 * character (which covers NUL, newline, CR and tab), and NO LEADING `-`.
 *
 * The leading dash is the option-injection stop. `--sandbox` as a *model id* would reach
 * the provider as a flag, and a provider that accepted it would be configured by a field
 * that claimed to name a model. Refusing is the only answer that cannot silently mean
 * something else.
 */
function baseFieldError(field: string, value: string, max: number): PlanError | null {
  if (value === "") return { field, message: "is empty; a field that must be explicit cannot be blank" };
  if (hasControlChar(value))
    return {
      field,
      message:
        "contains a control character (NUL, newline, CR or tab). The exec argv is handed " +
        "back to bin/orchestrator-boot.sh as newline-delimited text and a value that " +
        "cannot survive that round trip cannot be exec'd correctly",
    };
  if (value.startsWith("-"))
    return { field, message: "starts with '-', which would reach the provider as an option rather than as this field's value (option injection)" };
  if (value.length > max) return { field, message: `is longer than ${max} characters` };
  return null;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,110}(\[[A-Za-z0-9]{1,8}\])?$/;

/**
 * A model id is a VALIDATED EXPLICIT IDENTIFIER or the provider's own default — never a
 * catalogue entry pinned in this repo. Pinning one would go stale and then claim an old
 * model was the latest, and no validation here can promise the account can reach it: the
 * provider answers that, at boot, and says so itself.
 */
export function validateModel(cap: ProviderCapability, raw: string | undefined): { ok: true; choice: ModelChoice } | { ok: false; error: PlanError } {
  const field = PLAN_ENV.model;
  if (raw === undefined || raw === "") return { ok: true, choice: { kind: "provider-default" } };
  const base = baseFieldError(field, raw, 120);
  if (base) return { ok: false, error: base };
  if (!MODEL_RE.test(raw))
    return {
      ok: false,
      error: {
        field,
        message:
          `'${raw}' is not a model identifier this wizard will pass to ${cap.key}. Accepted ` +
          "form: letters/digits first, then letters, digits, '.', '_', ':', '+' or '-', " +
          "optionally ending in a bracketed suffix such as '[1m]'. Leave it unset for the " +
          "provider default",
      },
    };
  return { ok: true, choice: { kind: "explicit", id: raw } };
}

/**
 * Effort is offered ONLY in the semantics the capture evidenced, per provider:
 *
 *   enum        claude — one of the printed values, nothing else.
 *   literal     grok — the flag exists, the value set does not. One bounded explicit
 *                literal, carried with an unverified-value warning, or the default.
 *   gap         codex — no flag, and a config key this capture cannot corroborate. Setting
 *                the field at all is an error that NAMES the gap, because silently
 *                ignoring it would let a caller believe it took effect.
 *   unsupported gemini — measured absent. Same refusal, different reason.
 */
export function validateEffort(cap: ProviderCapability, raw: string | undefined): { ok: true; choice: EffortChoice } | { ok: false; error: PlanError } {
  const field = PLAN_ENV.effort;
  const effort = cap.effort;
  if (raw === undefined || raw === "") return { ok: true, choice: { kind: "provider-default" } };
  const base = baseFieldError(field, raw, 32);
  if (base) return { ok: false, error: base };
  if (effort.kind === "gap")
    return { ok: false, error: { field, message: `${cap.key} ${cap.measuredVersion} exposes no measured effort flag. ${effort.evidence}` } };
  if (effort.kind === "unsupported")
    return { ok: false, error: { field, message: `${cap.key} ${cap.measuredVersion} has no effort flag. ${effort.evidence}` } };
  if (effort.kind === "enum") {
    if (!effort.values.includes(raw))
      return {
        ok: false,
        error: { field, message: `'${raw}' is not one of ${cap.key} ${cap.measuredVersion}'s measured effort levels (${effort.values.join(", ")})` },
      };
    return { ok: true, choice: { kind: "enum", flag: effort.flag, value: raw } };
  }
  if (raw.length > effort.maxLength)
    return { ok: false, error: { field, message: `is longer than ${effort.maxLength} characters, the bound this wizard puts on an unverified value` } };
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(raw))
    return { ok: false, error: { field, message: `'${raw}' is not a bounded literal (letters, digits and '-' only). ${effort.warning}` } };
  return { ok: true, choice: { kind: "unverified", flag: effort.flag, value: raw } };
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TITLE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const INDEX_RE = /^(latest|[0-9]{1,6})$/;

/**
 * A history selector names an identity INSIDE the provider's own store. So on top of the
 * base checks it must not look like a path and must match the provider's measured form:
 *
 *   '/' '\' '~' '..' and ':' are refused outright — a selector is not a file, and the one
 *   history mechanism this module will never offer is an external transcript path.
 *
 * The forms narrow deliberately. claude's `--resume` also accepts a free-text SEARCH TERM
 * that opens an interactive picker; a picker drawing inside a command substitution would
 * write to the stdout the shim execs, so claude is UUID-only here.
 */
export function validateSelector(form: SelectorForm, field: string, raw: string): PlanError | null {
  const base = baseFieldError(field, raw, 80);
  if (base) return base;
  for (const bad of ["/", "\\", "~", "..", ":"])
    if (raw.includes(bad))
      return { field, message: `contains '${bad}'. A session selector names an identity in the provider's own store, never a path` };
  const shapes: Record<SelectorForm, { test: (s: string) => boolean; describe: string }> = {
    uuid: { test: (s) => UUID_RE.test(s), describe: "a session UUID (8-4-4-4-12 hex)" },
    "uuid-or-name": { test: (s) => UUID_RE.test(s) || NAME_RE.test(s), describe: "a session UUID, or a session name (letters, digits, '.', '_', '-')" },
    "uuid-or-title": { test: (s) => UUID_RE.test(s) || TITLE_RE.test(s), describe: "a session UUID, or a session title (letters, digits, spaces, '.', '_', '-')" },
    "latest-or-index": { test: (s) => INDEX_RE.test(s), describe: "'latest', or a session index number" },
  };
  const shape = shapes[form];
  if (!shape.test(raw)) return { field, message: `'${raw}' does not match the supported form: ${shape.describe}` };
  return null;
}

/**
 * The sid crosses back to the shim inside the FIXED head `telepty allow --id <sid>
 * --auto-restart`, and it is also the singleton guard's match token and the registry
 * record's id. Control characters are already refused by cli.ts's D1 on every path; this
 * adds the two checks that refusal never had — no leading `-`, no whitespace — because a sid
 * is one argv token and one registry id, and neither can be an option or two words.
 *
 * It is REQUIRED, not defaulted: a control tower that inherits its identity silently is how a
 * second bridge ends up sharing an id nobody chose (#539).
 */
export function validateSid(raw: string | undefined): { ok: true; sid: string } | { ok: false; error: PlanError } {
  const field = PLAN_ENV.sid;
  if (raw === undefined || raw === "")
    return {
      ok: false,
      error: { field, message: "is required by an explicit plan. A control tower that inherits its identity silently is a duplicate bridge waiting to happen (#539)" },
    };
  const base = baseFieldError(field, raw, 128);
  if (base) return { ok: false, error: base };
  if (/\s/.test(raw)) return { ok: false, error: { field, message: "contains whitespace; the sid is one argv token and one registry id" } };
  return { ok: true, sid: raw };
}

// ── permissions ─────────────────────────────────────────────────────────────

/**
 * Resolve one `axis=value` pair per axis the provider HAS — all of them, exactly once.
 *
 * A value whose `covers` names another axis (codex's single bypass literal disables
 * approvals AND the sandbox) makes that axis's own value forbidden rather than optional:
 * two fields that contradict each other on the same command line is precisely the state
 * where a review screen stops describing what will happen.
 */
export function resolvePermissions(
  cap: ProviderCapability,
  chosen: ReadonlyMap<string, string>,
  field: string,
): { ok: true; choices: readonly AxisChoice[] } | { ok: false; errors: readonly PlanError[] } {
  const errors: PlanError[] = [];
  const known = new Set(cap.axes.map((a) => a.axis as string));
  for (const key of chosen.keys())
    if (!known.has(key))
      errors.push({
        field,
        message: `'${key}' is not an axis ${cap.key} ${cap.measuredVersion} has. Its axes are: ${cap.axes.map((a) => `${a.axis} (${a.flag})`).join(", ") || "none"}`,
      });

  // Pass 1 — resolve what was actually named, so the cover set is known before anything is
  // called missing. Doing this the other way round makes codex's combined bypass unsatisfiable:
  // the sandbox axis would be required, and then rejected for contradicting the value that
  // already disabled it.
  const named = new Map<AxisName, AxisValue>();
  const coveredBy = new Map<AxisName, string>();
  for (const axis of cap.axes) {
    const raw = chosen.get(axis.axis);
    if (raw === undefined || raw === "") continue;
    const value: AxisValue | undefined = findAxisValue(axis, raw);
    if (value === undefined) {
      errors.push({
        field,
        message:
          `'${raw}' is not a value of ${cap.key}'s ${axis.axis} axis (${axis.flag}). ` +
          `Values: ${axis.values.map((v) => v.value).join(" | ")}. Another provider ` +
          "spelling a similar token is not evidence for this one",
      });
      continue;
    }
    named.set(axis.axis, value);
    for (const covered of value.covers) if (covered !== axis.axis) coveredBy.set(covered, value.value);
  }

  // Pass 2 — every axis is either covered by another axis's value (and must then be ABSENT,
  // because two contradictory policies on one command line is the state where a review screen
  // stops describing what will happen) or required.
  const picked: AxisChoice[] = [];
  for (const axis of cap.axes) {
    const value = named.get(axis.axis);
    const by = coveredBy.get(axis.axis);
    if (by !== undefined) {
      if (value !== undefined)
        errors.push({
          field,
          message:
            `'${by}' already disables the ${axis.axis} axis, so ${axis.axis}=${value.value} ` +
            "would put two contradictory policies on one command line. Remove one",
        });
      continue;
    }
    if (value === undefined) {
      errors.push({
        field,
        message:
          `${axis.axis}= is missing. ${cap.key}'s ${axis.axis} axis (${axis.flag}) must be ` +
          `named explicitly — an omitted axis is an incomplete plan, never a permissive ` +
          `default. Values: ${axis.values.map((v) => v.value).join(" | ")}`,
      });
      continue;
    }
    picked.push({ axis: axis.axis, value: value.value, argv: value.argv, risk: value.risk, covers: value.covers });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, choices: picked };
}

/** The axis choices that are not restrictive or moderate — the ones needing the ack. */
export function elevatedChoices(plan: BootPlan): readonly AxisChoice[] {
  return plan.permissions.filter((p) => p.risk === "elevated" || p.risk === "bypass");
}

/**
 * The EXACT phrase an automated caller must set, and the exact words the wizard makes a
 * human type. It is derived from the selections themselves, so it cannot be pre-set in a
 * deployment script once and then keep authorising a DIFFERENT elevated choice later.
 */
export function ackPhrase(plan: BootPlan): string {
  const parts = elevatedChoices(plan).map((c) => `${c.axis}=${c.value}`);
  return `I ACCEPT ELEVATED ${plan.provider.key} ${parts.join(";")}`;
}

// ── argv ────────────────────────────────────────────────────────────────────

/**
 * The provider half of the argv: everything AFTER `--auto-restart`.
 *
 * Order: executable, history subcommand, positional selector, model, effort, permission
 * axes in registry order, history flags. The positional selector sits directly after its
 * subcommand because that is where `codex resume [SESSION_ID]` reads it.
 */
export function providerArgv(plan: BootPlan): string[] {
  const cap = plan.provider;
  const history = findHistory(cap, plan.history.kind);
  // A plan is only constructible with a history mode the provider has; this keeps the
  // absence typed rather than asserted.
  const support: HistorySupport = history ?? { mode: "new", subcommand: [], flags: [], evidence: "", scope: "" };
  const argv: string[] = [cap.key, ...support.subcommand];
  if (plan.history.kind === "selected" && support.selector?.placement === "positional") argv.push(plan.history.selector);
  if (plan.model.kind === "explicit") argv.push(cap.model.flag, plan.model.id);
  if (plan.effort.kind === "enum" || plan.effort.kind === "unverified") argv.push(plan.effort.flag, plan.effort.value);
  for (const choice of plan.permissions) argv.push(...choice.argv);
  argv.push(...support.flags);
  if (plan.history.kind === "selected" && support.selector?.placement === "flag-value") argv.push(plan.history.selector);
  return argv;
}

/**
 * THE FULL EXEC ARGV. The head is FIXED DATA, byte-identical to what cli.ts has always
 * emitted: `telepty allow --id <sid> --auto-restart`. The wizard composes only the tail.
 *
 * That split is the whole safety story. `--auto-restart` keeps its measured
 * pre-command-word position (telepty cli.js 0.8.0 splices it out before reading
 * `allowArgs[0]`), the telepty lifecycle is untouched, and the singleton guard's match
 * token (`--id <sid>`) is still the same token this boot will carry.
 */
export function buildExecArgv(plan: BootPlan, ref?: HandoffRef): string[] {
  // D-5: a handoff rides only on a NEW conversation. With no ref the argv is byte-identical
  // to the pre-handoff one.
  const handoff = ref === undefined || plan.history.kind !== "new" ? [] : handoffArgv(plan.provider, ref);
  return ["telepty", "allow", "--id", plan.sid, "--auto-restart", ...providerArgv(plan), ...handoff];
}

// ── context handoff (task 1201, SPEC §6.2) ──────────────────────────────────

/**
 * What this module knows of a resolved handoff: the file it points at, the one-line
 * first-turn prompt, and the source it names. Structural, so the engine's own ref
 * (src/context-handoff) is accepted as-is and this file still imports nothing from it.
 */
export interface HandoffRef {
  readonly file: string;
  readonly line: string;
  readonly source: { readonly cli: string; readonly sessionId: string; readonly lastActivity: string };
}

/** The review screen's view of the handoff scan. Absent = not scanned yet (it runs after the guard). */
export type HandoffPreview = { readonly kind: "found"; readonly ref: HandoffRef } | { readonly kind: "none"; readonly reason: string };

const HANDOFF_LINE_MAX_BYTES = 400;

/**
 * Why a ref may not reach the argv, or null. The same floor as baseFieldError — no control
 * character, no leading `-` — because these tokens cross back to the shim as
 * newline-delimited text too, plus §4.1's bound on the first-turn line.
 */
export function handoffRefusal(ref: HandoffRef): string | null {
  // The source fields are printed on the review screen and the boot line, never exec'd.
  if ([ref.source.cli, ref.source.sessionId, ref.source.lastActivity].some(hasControlChar)) return "the source names a control character";
  if (ref.file === "" || hasControlChar(ref.file) || ref.file.startsWith("-")) return "the handoff path is empty, has a control character or starts with '-'";
  if (ref.line === "" || hasControlChar(ref.line) || ref.line.startsWith("-")) return "the first-turn line is empty, has a control character or starts with '-'";
  if (Buffer.byteLength(ref.line, "utf8") > HANDOFF_LINE_MAX_BYTES) return `the first-turn line is longer than ${HANDOFF_LINE_MAX_BYTES} bytes`;
  return null;
}

/**
 * The delivery tokens for one provider, from its `handoff` data only. Pointer-only (D-2): the
 * path and the one-line prompt, never the content. An `owed` channel contributes nothing,
 * and a ref that fails handoffRefusal contributes nothing at all.
 */
export function handoffArgv(cap: ProviderCapability, ref: HandoffRef): string[] {
  if (handoffRefusal(ref) !== null) return [];
  const tokens: string[] = [];
  const { content, firstTurn } = cap.handoff;
  const inSystemPrompt = content.kind === "system-file" && content.status === "measured";
  if (inSystemPrompt) tokens.push(content.flag, ref.file);
  if (firstTurn.status === "measured") {
    // §6.2: with the content already in the system prompt the model is told so, not asked to load it.
    const line = inSystemPrompt ? systemPromptFirstTurn(ref) : ref.line;
    if (handoffRefusal({ ...ref, line }) !== null) return tokens;
    if (firstTurn.placement === "flag-value" && firstTurn.flag !== null) tokens.push(firstTurn.flag, line);
    else if (firstTurn.placement === "positional") tokens.push(line);
  }
  return tokens;
}

/** The §6.2 first-turn line for a provider that already holds the handoff in its system prompt. */
export function systemPromptFirstTurn(ref: HandoffRef): string {
  return (
    `aigentry handoff: continuing from ${ref.source.cli} session ${ref.source.sessionId.slice(0, 8)}, last activity ` +
    `${ref.source.lastActivity}. The handoff (${ref.file}) is already in your system prompt; reply with one line ` +
    "naming what you are continuing and wait for the user."
  );
}

/** latest.json's `delivery` object (W's optional resolveHandoff input), from the same data. */
export function handoffDeliveryRecord(cap: ProviderCapability): HandoffDelivery | undefined {
  // Integration (1201): the engine's record names the CLI with its closed union; a provider key
  // outside it (none exists today) yields no delivery record rather than a mislabelled one.
  const cli = cap.key;
  if (cli !== "claude" && cli !== "codex" && cli !== "gemini" && cli !== "grok") return undefined;
  const c = cap.handoff.content;
  const content = c.kind === "turn-1-read" ? "first-turn-read" : c.status === "measured" ? "system-file" : "none";
  return { cli, content, first_turn: cap.handoff.firstTurn.status };
}

/** `<cli>:system-file+first-turn` and its subsets, or `<cli>:unmeasured` (§7's delivery field). */
export function handoffDeliveryLabel(cap: ProviderCapability): string {
  const parts: string[] = [];
  if (cap.handoff.content.kind === "system-file" && cap.handoff.content.status === "measured") parts.push("system-file");
  if (cap.handoff.firstTurn.status === "measured") parts.push("first-turn");
  return `${cap.key}:${parts.length > 0 ? parts.join("+") : "unmeasured"}`;
}

// ── the env plan (non-TTY) ──────────────────────────────────────────────────

/** `axis=value;axis=value`. Semicolons, not commas — see the PLAN_ENV header. */
function parsePermissionField(raw: string, field: string): { ok: true; pairs: ReadonlyMap<string, string> } | { ok: false; errors: readonly PlanError[] } {
  const errors: PlanError[] = [];
  const pairs = new Map<string, string>();
  for (const part of raw.split(";")) {
    const token = part.trim();
    if (token === "") {
      errors.push({ field, message: "has an empty ';'-separated entry" });
      continue;
    }
    const m = /^([a-z][a-z0-9-]*)=([^;=]+)$/.exec(token);
    if (m === null) {
      errors.push({ field, message: `'${token}' is not an 'axis=value' pair. Schema: axis=value;axis=value (semicolon-separated, one entry per axis, no aliases)` });
      continue;
    }
    if (pairs.has(m[1])) {
      errors.push({ field, message: `names the axis '${m[1]}' more than once` });
      continue;
    }
    pairs.set(m[1], m[2]);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, pairs };
}

/**
 * `new` | `last` | `selected=<selector>`. One spelling each; `selected` without a selector
 * is an error rather than an implicit `last`, because "resume something" is not a choice a
 * control tower may make on the operator's behalf.
 */
function parseHistoryField(cap: ProviderCapability, raw: string, field: string): { ok: true; choice: HistoryChoice } | { ok: false; errors: readonly PlanError[] } {
  const modes = cap.history.map((h) => h.mode);
  const eq = raw.indexOf("=");
  const mode = eq === -1 ? raw : raw.slice(0, eq);
  const selector = eq === -1 ? "" : raw.slice(eq + 1);
  if (!modes.includes(mode as HistorySupport["mode"]))
    return { ok: false, errors: [{ field, message: `'${mode}' is not a history mode ${cap.key} ${cap.measuredVersion} supports (${modes.join(" | ")})` }] };
  const support = findHistory(cap, mode);
  if (support === undefined) return { ok: false, errors: [{ field, message: `'${mode}' has no measured support entry` }] };
  if (mode !== "selected") {
    if (eq !== -1) return { ok: false, errors: [{ field, message: `'${mode}' takes no selector; only 'selected=<selector>' does` }] };
    return { ok: true, choice: mode === "last" ? { kind: "last" } : { kind: "new" } };
  }
  if (support.selector === undefined) return { ok: false, errors: [{ field, message: `${cap.key} has no measured selector form` }] };
  if (selector === "")
    return { ok: false, errors: [{ field, message: `'selected' requires a selector: ${field}=selected=<${support.selector.describe}>` }] };
  const bad = validateSelector(support.selector.form, field, selector);
  if (bad !== null) return { ok: false, errors: [bad] };
  return { ok: true, choice: { kind: "selected", selector } };
}

/**
 * THE NON-TTY DOOR, and the only one. `AIGENTRY_BOOT_PLAN=1` is an explicit opt-in: with it
 * set, EVERY required field must be present and valid or this returns errors and the caller
 * exits 2 having touched nothing. There is no arm in this function that substitutes a default
 * for a missing permission or history choice, and there is nothing left for it to fall back
 * TO: the hardcoded `--dangerously-skip-permissions --continue` /
 * `resume --last --dangerously-bypass-approvals-and-sandbox` tails that `ORCHESTRATOR_CLI`
 * alone used to select were removed with this door's arrival.
 *
 * `cwd` is passed in rather than read, and is DISPLAY ONLY: it is the cwd this process
 * inherited and therefore the cwd the shell's `exec` will keep. No provider cwd flag is
 * emitted from it, and nothing here can change the parent shell's cwd — a Node `chdir`
 * inside a command substitution changes only this short-lived child.
 */
export function parseEnvPlan(env: Readonly<Record<string, string | undefined>>, cwd: string): PlanResult {
  const errors: PlanError[] = [];
  const cliRaw = env[PLAN_ENV.cli];
  const cap = cliRaw === undefined || cliRaw === "" ? undefined : findCapability(cliRaw);
  if (cap === undefined) {
    return {
      ok: false,
      errors: [
        {
          field: PLAN_ENV.cli,
          message:
            `an explicit plan must name a registered provider executable. Registered: ` +
            `${capabilityKeys().join(" | ")}` +
            (cliRaw === undefined || cliRaw === "" ? " (it was unset)" : ` (got '${cliRaw}')`),
        },
      ],
    };
  }

  const sid = validateSid(env[PLAN_ENV.sid]);
  const model = validateModel(cap, env[PLAN_ENV.model]);
  const effort = validateEffort(cap, env[PLAN_ENV.effort]);
  if (!sid.ok) errors.push(sid.error);
  if (!model.ok) errors.push(model.error);
  if (!effort.ok) errors.push(effort.error);

  const permRaw = env[PLAN_ENV.permission];
  let permissions: readonly AxisChoice[] = [];
  if (permRaw === undefined || permRaw === "") {
    errors.push({
      field: PLAN_ENV.permission,
      message:
        `is required. Schema: ${cap.axes.map((a) => `${a.axis}=<value>`).join(";") || "(this provider has no axes)"}` +
        `. Absent is not permissive`,
    });
  } else {
    const pairs = parsePermissionField(permRaw, PLAN_ENV.permission);
    if (!pairs.ok) errors.push(...pairs.errors);
    else {
      const resolved = resolvePermissions(cap, pairs.pairs, PLAN_ENV.permission);
      if (!resolved.ok) errors.push(...resolved.errors);
      else permissions = resolved.choices;
    }
  }

  const histRaw = env[PLAN_ENV.history];
  let history: HistoryChoice = { kind: "new" };
  if (histRaw === undefined || histRaw === "") {
    errors.push({
      field: PLAN_ENV.history,
      message: `is required. Values: ${cap.history.map((h) => (h.mode === "selected" ? "selected=<selector>" : h.mode)).join(" | ")}. A new conversation is the default only when you say so`,
    });
  } else {
    const parsed = parseHistoryField(cap, histRaw, PLAN_ENV.history);
    if (!parsed.ok) errors.push(...parsed.errors);
    else history = parsed.choice;
  }

  if (errors.length > 0) return { ok: false, errors };

  const plan: BootPlan = {
    provider: cap,
    sid: sid.ok ? sid.sid : "",
    model: model.ok ? model.choice : { kind: "provider-default" },
    effort: effort.ok ? effort.choice : { kind: "provider-default" },
    permissions,
    history,
    inheritedCwd: cwd,
  };

  // The elevated acknowledgement is checked LAST, so its message can quote the exact phrase
  // for the plan that was actually assembled.
  const elevated = elevatedChoices(plan);
  if (elevated.length > 0) {
    const want = ackPhrase(plan);
    const got = env[PLAN_ENV.ack];
    if (got !== want)
      return {
        ok: false,
        errors: [
          {
            field: PLAN_ENV.ack,
            message:
              `this plan selects ${elevated.map((c) => `${c.axis}=${c.value}`).join(", ")}, which ` +
              `${elevated.some((c) => c.risk === "bypass") ? "disables a protection mechanism" : "stops the provider asking"}. ` +
              `Set it to exactly:\n  ${PLAN_ENV.ack}='${want}'\n` +
              "An automated caller must restate the elevation it is asking for; the phrase " +
              "changes with the selection, so it cannot keep authorising a later, different one",
          },
        ],
      };
  }
  return { ok: true, plan };
}

// ── rendering (pure strings; the caller owns the stream) ────────────────────

/**
 * The review screen's body and `--dry-run`'s plan report, as lines. One function so the two
 * cannot describe the same plan differently.
 */
export function describePlan(plan: BootPlan, handoff?: HandoffPreview): string[] {
  const cap = plan.provider;
  const lines: string[] = [];
  lines.push(`provider    ${cap.key} — ${cap.displayName}, capabilities measured at ${cap.measuredVersion} (provenance: ${cap.provenance})`);
  lines.push(`session id  ${plan.sid}   (telepty allow --id ${plan.sid}; the singleton guard matches this token)`);
  lines.push(
    plan.model.kind === "explicit"
      ? `model       ${plan.model.id}   (passed as ${cap.model.flag}; availability is the provider's answer, not this wizard's)`
      : `model       provider default   (${cap.model.defaultNote})`,
  );
  if (plan.effort.kind === "provider-default") {
    const gap = cap.effort.kind === "gap" || cap.effort.kind === "unsupported" ? ` — ${cap.effort.evidence}` : "";
    lines.push(`effort      provider default${gap}`);
  } else if (plan.effort.kind === "enum") {
    lines.push(`effort      ${plan.effort.value}   (${plan.effort.flag}, one of ${cap.key} ${cap.measuredVersion}'s measured levels)`);
  } else {
    lines.push(`effort      ${plan.effort.value}   (${plan.effort.flag}) ⚠ UNVERIFIED — ${cap.effort.kind === "literal" ? cap.effort.warning : ""}`);
  }
  for (const choice of plan.permissions) {
    const axis = cap.axes.find((a) => a.axis === choice.axis);
    const value = axis === undefined ? undefined : findAxisValue(axis, choice.value);
    const mark = choice.risk === "bypass" ? "⚠ BYPASS" : choice.risk === "elevated" ? "⚠ elevated" : choice.risk;
    lines.push(`${choice.axis.padEnd(11)} ${choice.value}   [${mark}] ${axis?.flag ?? ""} — ${value?.note ?? ""}`);
  }
  const support = findHistory(cap, plan.history.kind);
  const selector = plan.history.kind === "selected" ? ` '${plan.history.selector}'` : "";
  lines.push(`history     ${plan.history.kind}${selector} — ${support?.scope ?? ""}`);
  lines.push(`            native resume is NOT a context handoff: the provider reopens its own session. A handoff is derived from the previous transcript and delivered as a file (below).`);
  const delivery = handoffDeliveryLabel(cap);
  const backstop = delivery.endsWith(":unmeasured") ? " — backstop only (AGENTS.md)" : "";
  if (plan.history.kind !== "new") lines.push(`handoff     not run — native resume chosen (the handoff runs only on history=new)`);
  else if (handoff === undefined)
    lines.push(`handoff     scanned after the singleton guard (claude/codex/gemini/grok stores, read-only) — delivery ${delivery}${backstop}`);
  else if (handoff.kind === "none") lines.push(`handoff     none — ${handoff.reason}`);
  else
    lines.push(
      `handoff     ${handoff.ref.source.cli} session ${handoff.ref.source.sessionId.slice(0, 8)}, last activity ${handoff.ref.source.lastActivity} → ${handoff.ref.file} — delivery ${delivery}${backstop}`,
    );
  lines.push(`cwd         ${plan.inheritedCwd}   (INHERITED — the shell execs the bridge and keeps this cwd. No provider cwd flag is passed: ${cap.cwd.note})`);
  for (const w of cap.warnings) lines.push(`warning     ${w}`);
  return lines;
}

/** What a real boot will DO, in plain language, before anything has been done. */
export function describeEffects(plan: BootPlan): string[] {
  return [
    `DELETE a registry record for '${plan.sid}' — only if the daemon reports it STALE with 0 attached clients (#905).`,
    `SIGKILL stale 'telepty allow --id ${plan.sid}' bridges — never this process and never any ancestor of it (#539).`,
    `REPLACE this shell with the argv below, so this terminal BECOMES the orchestrator bridge.`,
  ];
}

const SAFE_ENV_VALUE = /^[A-Za-z0-9._:;=+/-]+$/;

/**
 * `--wizard-plan`'s output: the env a non-TTY caller can reuse verbatim.
 *
 * Quoting is for the HUMAN copying these lines into a script. Nothing here is ever exec'd,
 * parsed back or written to a file by this module.
 */
export function planEnvLines(plan: BootPlan): string[] {
  const q = (v: string): string => (SAFE_ENV_VALUE.test(v) ? v : `'${v.split("'").join("'\\''")}'`);
  const lines = [`${PLAN_ENV.enable}=1`, `${PLAN_ENV.cli}=${q(plan.provider.key)}`, `${PLAN_ENV.sid}=${q(plan.sid)}`];
  if (plan.model.kind === "explicit") lines.push(`${PLAN_ENV.model}=${q(plan.model.id)}`);
  if (plan.effort.kind !== "provider-default") lines.push(`${PLAN_ENV.effort}=${q(plan.effort.value)}`);
  lines.push(`${PLAN_ENV.permission}=${q(plan.permissions.map((p) => `${p.axis}=${p.value}`).join(";"))}`);
  lines.push(
    `${PLAN_ENV.history}=${q(plan.history.kind === "selected" ? `selected=${plan.history.selector}` : plan.history.kind)}`,
  );
  if (elevatedChoices(plan).length > 0) lines.push(`${PLAN_ENV.ack}=${q(ackPhrase(plan))}`);
  return lines;
}

/** Axis defaults for the wizard's pre-selection. Restrictive, always. */
export function restrictiveDefaults(cap: ProviderCapability): readonly AxisChoice[] {
  return cap.axes.map((axis) => {
    const v = defaultAxisValue(axis);
    return { axis: axis.axis, value: v.value, argv: v.argv, risk: v.risk, covers: v.covers };
  });
}
