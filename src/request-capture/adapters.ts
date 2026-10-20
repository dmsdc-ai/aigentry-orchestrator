// Shipped submission-adapter declarations (#1166 U2, AC1).
//
// WHAT THIS FILE IS: a source-capability declaration, so a consumer reads what this tree can and
// cannot capture instead of inferring coverage from silence.
//
// WHAT IT IS NOT, ever: evidence that an adapter is installed, registered, enabled or active.
// Registration is an operator action through the init preservation transaction and is decided
// per workspace (U2-ORIGINAL-SPEC §7 O1, unapproved). Every row therefore carries
// `installation: "not-evidenced-here"` and `activation: "not-evidenced-here"`, and this module
// exports no probe that could be mistaken for one.
//
// Pure data and two pure lookups: no I/O, no `process` access, no environment read, no provider
// probe, no import of the capture store. Importing this module has no side effect.
//
// `caller_evidence` entries are `<repo-relative file>:<line>#<token>`: the token is what a
// reviewer must still find on that line. `tests/request-capture/adapters.test.ts` re-opens every
// citation, so a declaration cannot silently outlive the source it describes.

/** `supported` = this tree persists the original prompt; the other two are honest refusals. */
export type AdapterCaptureStatus = "supported" | "unsupported" | "unobservable";

/**
 * A qualifier narrows a status; it never upgrades one. In particular a lane that observes turn
 * lifecycle is `unsupported` + `lifecycle-observation-only`, never `supported`.
 */
export type AdapterQualifier =
  | "opt-in"
  | "posix-only"
  | "lifecycle-observation-only"
  | "not-prompt-capture"
  | "mechanism-present-not-registered"
  | "no-hook-surface-in-source"
  | "deferred-to-unit-u6";

export interface SubmissionAdapter {
  /** Stable declaration key; not a channel and not a session id. */
  adapter_id: string;
  cli: string;
  lane: string;
  capture_status: AdapterCaptureStatus;
  qualifiers: readonly AdapterQualifier[];
  /** The observable mechanism, or `null` when the source references none at all. */
  mechanism: string | null;
  caller_evidence: readonly string[];
  /** The receipt `channel` this lane writes, and `null` unless it actually captures. */
  channel: "codex-native" | null;
  /** No provider delivery id has been measured on any lane in this source. */
  upstream_id_status: "unavailable";
  upstream_delivery_id: null;
  installation: "not-evidenced-here";
  activation: "not-evidenced-here";
  owning_task: string;
}

export const ADAPTER_DECLARATION_BASIS =
  "source-capability declaration derived from traced caller paths; "
  + "not installed, not activated, not a runtime probe";

const UNMEASURED = {
  upstream_id_status: "unavailable",
  upstream_delivery_id: null,
  installation: "not-evidenced-here",
  activation: "not-evidenced-here",
} as const;

export const SUBMISSION_ADAPTERS: readonly SubmissionAdapter[] = Object.freeze([
  {
    adapter_id: "codex-native",
    cli: "codex",
    lane: "codex-native-user-prompt-submit",
    capture_status: "supported",
    // Opt-in: only `--capture-root`/`--preservation-root` prepare it. POSIX only: win32 is
    // refused by the CLI and again by the preparation step.
    qualifiers: ["opt-in", "posix-only"],
    mechanism: "synchronous UserPromptSubmit command hook in .codex/hooks.json; blocks the "
      + "submission when the prompt cannot be durably recorded",
    caller_evidence: [
      "bin/init/cli.mjs:947#opts.captureRoot ? prepareNativeCapture(",
      "bin/init/cli.mjs:922#process.platform === \"win32\" && (opts.captureRoot",
      "bin/init/native-capture.mjs:100#[\"darwin\", \"linux\"].includes(process.platform)",
      "bin/init/native-capture.mjs:177#UserPromptSubmit",
      "bin/init/native-capture.mjs:19#.codex/hooks.json",
      "bin/hook-prompt-submit.mjs:29#request-capture\", \"cli.js\"",
      "src/request-capture/cli.ts:24#captureSubmittedPrompt(",
      "src/request-capture/cli.ts:37#decision: \"block\"",
      "src/request-capture/receipt.ts:141#export async function captureSubmittedPrompt(",
    ],
    channel: "codex-native",
    ...UNMEASURED,
    owning_task: "#1166",
  },
  {
    adapter_id: "claude-confined-worker",
    cli: "claude",
    lane: "confined-worker-turn-lifecycle",
    // The hook fires on UserPromptSubmit, but what it persists is turn state and a dispatch-ref
    // binding — never the prompt and never a capture receipt. Observation is not capture.
    capture_status: "unsupported",
    qualifiers: ["lifecycle-observation-only", "not-prompt-capture"],
    mechanism: "host-generated inline --settings hooks (UserPromptSubmit/Stop/StopFailure/"
      + "SessionEnd) writing turn-status observations to the worker report outbox",
    caller_evidence: [
      "src/session/worker-sandbox.ts:358#hooks: { UserPromptSubmit: hook(\"UserPromptSubmit\", 5)",
      "src/report/turn-hook.ts:110#\"UserPromptSubmit\", \"Stop\", \"StopFailure\", \"SessionEnd\"",
      "src/report/turn-hook.ts:404#bindPrompt(fsApi, a, input.prompt)",
      "src/report/turn-hook.ts:131#prompt.slice(head.length",
    ],
    channel: null,
    ...UNMEASURED,
    owning_task: "#1136",
  },
  {
    adapter_id: "claude-orchestrator",
    cli: "claude",
    lane: "orchestrator-or-ordinary-session",
    // The mechanism exists and is used for confined workers; the shipped settings register no
    // UserPromptSubmit, so the controller's own prompts are uncaptured. This is the gap, named.
    capture_status: "unsupported",
    qualifiers: ["mechanism-present-not-registered"],
    mechanism: "the same inline --settings hook mechanism, with no UserPromptSubmit registered "
      + "in the shipped .claude/settings.json",
    caller_evidence: [
      "src/session/worker-sandbox.ts:360#\"--settings\", settings",
      ".claude/settings.json:3#\"PreToolUse\"",
    ],
    channel: null,
    ...UNMEASURED,
    owning_task: "#1166",
  },
  {
    adapter_id: "gemini",
    cli: "gemini",
    lane: "gemini-cli-session",
    // Declared, not claimed: no prompt-submission hook surface is referenced anywhere in this
    // tree, so coverage cannot be asserted even in principle.
    capture_status: "unobservable",
    qualifiers: ["no-hook-surface-in-source"],
    mechanism: null,
    caller_evidence: [
      "src/session/boot-adapter/gemini.ts:53#name: \"gemini\"",
      "src/session/boot-adapter/gemini.ts:38#UPSTREAM-GAP",
    ],
    channel: null,
    ...UNMEASURED,
    owning_task: "#1166",
  },
  {
    adapter_id: "grok",
    cli: "grok",
    lane: "grok-cli-session",
    capture_status: "unobservable",
    qualifiers: ["no-hook-surface-in-source"],
    mechanism: null,
    caller_evidence: [
      "src/session/boot-adapter/grok.ts:8#name: \"grok\"",
      "src/session/boot-adapter/grok.ts:14#--always-approve",
    ],
    channel: null,
    ...UNMEASURED,
    owning_task: "#1166",
  },
  {
    adapter_id: "telepty-peer-to-orchestrator",
    cli: "telepty",
    lane: "peer-inject-to-orchestrator",
    // The auditor's orchestrator lane is deliberately out of scope today: a peer record addressed
    // to an orchestrator sid is skipped, so no peer body is classified, logged or persisted.
    capture_status: "unsupported",
    qualifiers: ["deferred-to-unit-u6"],
    mechanism: "comms-auditor pass over the peer log; the orchestrator lane is skipped",
    caller_evidence: [
      "src/comms-auditor/cli.ts:371#ORCH LANE",
      "src/comms-auditor/cli.ts:372#orch.has(recFrom) || orch.has(recTo)) continue",
    ],
    channel: null,
    ...UNMEASURED,
    owning_task: "#1166, #1215",
  },
] satisfies readonly SubmissionAdapter[]);

/** The declaration for `adapterId`, or `null`. A lookup miss is not an error. */
export function findSubmissionAdapter(adapterId: string): SubmissionAdapter | null {
  return SUBMISSION_ADAPTERS.find((adapter) => adapter.adapter_id === adapterId) ?? null;
}

/**
 * The receipt channels this source actually captures on. A fresh array each call, so a caller
 * cannot mutate the declaration through it.
 */
export function supportedCaptureChannels(): string[] {
  return SUBMISSION_ADAPTERS
    .filter((adapter) => adapter.capture_status === "supported" && adapter.channel !== null)
    .map((adapter) => adapter.channel as string);
}
