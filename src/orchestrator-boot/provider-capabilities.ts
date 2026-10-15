// provider-capabilities.ts — the orchestrator boot wizard's ONE source of provider truth
// (#1181). NEW SURFACE, not a port.
//
// WHAT THIS FILE IS. A compile-time literal registry, keyed on the EXECUTABLE the boot
// would exec, precedent-matched to src/session/role-capabilities.ts: a frozen literal, not
// a framework (Article 1). Extending it is adding one entry to CAPABILITIES below and
// nothing else — no plugin loader, no runtime override file, no arbitrary shell command.
// That is the extension seam, and it is deliberately the ONLY one: a registry that could
// execute an operator-supplied command would hand the boot path an arbitrary-exec hole on
// the one script whose successor becomes the user's shell.
//
// WHERE EVERY VALUE BELOW COMES FROM. `input/native-help/*` — the read-only
// `--help`/`--version` capture of the four staged executables (task #1181, macOS arm64):
//
//   claude 2.1.283 (Claude Code)       claude-help.stdout.txt   claude-version.stdout.txt
//   codex-cli 0.157.1                  codex-help.stdout.txt    codex-resume-help.stdout.txt
//   gemini 0.53.0                      gemini-help.stdout.txt   gemini-version.stdout.txt
//   grok 1.0.25 (f7e67d6988e2)         grok-help.stdout.txt     grok-version.stdout.txt
//
// and, where `--help` prints a flag but NOT its value set, the vendor page staged at
// input/official/ (Grok only). Nothing here is inferred from a benchmark, a price list or
// docs/model-profiles/model-routing-profile.md — that file is a MODEL routing profile, and
// a model id is not a CLI capability.
//
// ⚠️ FIVE RULES THIS FILE EXISTS TO MAKE STRUCTURAL RATHER THAN REMEMBERED:
//
//   1. NO PROVIDER EXECUTES TO BE DESCRIBED. Every string below is data measured once, at
//      the version named in `measuredVersion`. The wizard renders THIS, never a live
//      `<exe> --help`. Measured 2026-09: even `--help` and `--version` wrote outside
//      process memory — gemini created `$HOME/.gemini/projects.json.*.tmp`, grok created
//      `$HOME/.grok/`, codex populated `$CODEX_HOME/tmp/arg0/…`. A planning step that
//      shells out to `--help` on a real HOME is therefore an EFFECT, and the boot wizard
//      must reach its review screen having caused none.
//   2. SIMILAR NAMES ARE NOT SHARED POLICY. Claude and Grok both spell a flag
//      `--permission-mode` and both print the tokens `acceptEdits|auto|dontAsk|
//      bypassPermissions|plan`. Grok's own docs (input/official/grok-permissions.md)
//      define its modes as Ask/Auto/Always-approve with different semantics, and
//      docs.x.ai does not document `--permission-mode` at all. So every axis value below
//      carries its OWN argv array. There is no shared enum, no cross-provider mapping
//      table, and no code path that can translate one provider's token into another's.
//      The same trap one letter down: `-s` is `--sandbox` on codex and `--session-id` on
//      grok.
//   3. UNKNOWN IS RECORDED AS UNKNOWN. Grok advertises `--reasoning-effort <EFFORT>` and
//      prints no value set; codex has no effort flag at all and only a config key that
//      this capture cannot corroborate. Those are `kind: "literal"` (explicit typed value
//      + warning) and `kind: "gap"` (offered as nothing, named as a gap) respectively.
//      Neither is filled in from another provider's enum.
//   4. NO CWD FLAG IS USED, INCLUDING THE ONE THAT EXISTS. codex `-C, --cd <DIR>` and grok
//      `--cwd <CWD>` are real in these builds (the frozen draft's "codex --cd absent" is
//      false). They are still not used here: `bin/orchestrator-boot.sh` runs this code
//      inside a COMMAND SUBSTITUTION and then `exec`s the argv in the user's own shell, so
//      the bridge inherits THAT shell's cwd. Node cannot change it from in here, and
//      passing a provider cwd flag would make the wizard's own review screen lie about
//      where the session runs. cwd is display-only; see CwdCapability.
//   5. PROVENANCE IS UNVERIFIED FOR ALL FOUR. The staged bytes were hashed, not
//      code-signed; no publisher signature was checked. `provenance` therefore reads
//      "unverified" everywhere and the wizard prints that word rather than implying a
//      trusted catalogue.
//   6. THERE IS NO MODEL CATALOGUE IN HERE, AND THERE MUST NOT BE A SECOND ONE ANYWHERE.
//      Each entry records the FLAG its provider takes (`--model`) and nothing about which
//      ids exist. Model choice is either the provider's own default or one identifier the
//      operator typed and plan.ts validated BY FORM. "Provider default" is never described
//      as "the latest model" — nothing here knows that, and a list frozen in this file
//      would go stale and then keep claiming it. Shared fresh-model discovery/selection is
//      #1148's to supply; when it lands this module gains a CALLER, not a copy of its data.

/** The two axes the capture actually found. A provider with a third widens this union. */
export type AxisName = "approval" | "sandbox";

/**
 * How dangerous a value is, in the ONE ordering the wizard is allowed to use.
 *
 * `restrictive` is the wizard's default for every axis — never an elevated value, and
 * never the boot-adapter's worker flags (those exist to run UNATTENDED workers; reusing
 * them as a human's default would ship "no default permission bypass" as a lie).
 *
 * `elevated` and `bypass` both require the EXTRA typed acknowledgement in plan.ts. The two
 * are kept apart because the wording an operator must type differs in kind: `elevated`
 * stops asking about a bounded class of action, `bypass` disables the mechanism.
 */
export type Risk = "restrictive" | "moderate" | "elevated" | "bypass";

/** One selectable value on one axis, carrying the EXACT argv it contributes. */
export interface AxisValue {
  /** The token the wizard shows and the env plan accepts. Provider-local, never shared. */
  readonly value: string;
  /** Exactly what this value appends to the provider argv. No assembly, no guessing. */
  readonly argv: readonly string[];
  readonly risk: Risk;
  /**
   * Axes this value makes moot — codex's single bypass literal disables approval AND
   * sandbox, so a plan that names it must not also name a sandbox value it contradicts.
   */
  readonly covers: readonly AxisName[];
  readonly note: string;
}

export interface PermissionAxis {
  readonly axis: AxisName;
  /** The flag as THIS provider spells it, for the review screen. */
  readonly flag: string;
  readonly values: readonly AxisValue[];
  readonly evidence: string;
}

/**
 * Effort, in the four shapes the capture actually supports.
 *
 *   enum        — the values were printed. Offer exactly those (claude).
 *   literal     — the flag was printed, the values were not. Offer the provider default or
 *                 ONE explicit bounded literal the operator types, with a warning that the
 *                 value is unverified against this build (grok).
 *   gap         — no flag; a configuration key exists but this capture cannot corroborate
 *                 its name or its value set, so nothing is offered and the gap is NAMED
 *                 rather than filled with a neighbour's enum (codex).
 *   unsupported — measured absent at the CLI (gemini).
 */
export type EffortCapability =
  | { readonly kind: "enum"; readonly flag: string; readonly values: readonly string[]; readonly evidence: string }
  | { readonly kind: "literal"; readonly flag: string; readonly maxLength: number; readonly warning: string; readonly evidence: string }
  | { readonly kind: "gap"; readonly evidence: string }
  | { readonly kind: "unsupported"; readonly evidence: string };

/** The accepted SHAPE of a history selector, so validation can refuse anything else. */
export type SelectorForm = "uuid" | "uuid-or-name" | "uuid-or-title" | "latest-or-index";

export interface SelectorSpec {
  readonly form: SelectorForm;
  /** `positional` sits directly after the subcommand; `flag-value` follows `flags`. */
  readonly placement: "positional" | "flag-value";
  readonly describe: string;
}

/**
 * One history option for one provider. `new` is always present and is always the default:
 * a boot that silently resumed would decide for the operator which conversation the
 * control tower continues.
 *
 * `scope` is prose the review screen prints. Every entry stays inside the provider's own
 * cwd/config-home scoping: no `--all`, no `--include-non-interactive`, no external
 * transcript path, no listing read. NATIVE RESUME IS NOT A CONTEXT HANDOFF and no entry
 * may be labelled as one.
 */
export interface HistorySupport {
  readonly mode: "new" | "last" | "selected";
  /** Subcommand tokens, e.g. codex's `resume`. Empty for a flag-only provider. */
  readonly subcommand: readonly string[];
  /** Flag tokens contributed after the model/effort/permission flags. */
  readonly flags: readonly string[];
  readonly selector?: SelectorSpec;
  readonly evidence: string;
  readonly scope: string;
}

export interface ModelCapability {
  readonly flag: string;
  readonly evidence: string;
  /** What "provider default" MEANS here — never a promise about account availability. */
  readonly defaultNote: string;
}

/** Display-only, always. See rule 4 in the header. */
export interface CwdCapability {
  /** The provider's own cwd flag if it has one — recorded so nobody "adds" it twice. */
  readonly flag: string | null;
  readonly note: string;
}

/** An "important supported option" the review screen explains, with its measured version. */
export interface InfoOption {
  readonly label: string;
  readonly detail: string;
}

/**
 * How a context handoff reaches this provider (task 1201, SPEC §6.2). DATA ONLY: plan.ts
 * `handoffArgv` turns it into tokens, and every token is a POINTER — an absolute path to
 * `<ws>/state/handoff/latest.md`, or the one-line first-turn prompt naming it. Content never
 * goes on argv (D-2: the argv is logged and is readable from the process table).
 *
 * `status` is rule 3 applied to delivery: `owed` means the flag is inferred, not measured
 * for this provider's orchestrator path, and an owed entry contributes NO token. The boot
 * then says so on one line and the AGENTS.md backstop is the only channel. Flipping an
 * entry to `measured` (Phase 0 item P0-6) is the whole of activating it.
 */
export interface HandoffChannel {
  readonly status: "measured" | "owed";
  readonly evidence: string;
}

export interface HandoffDelivery {
  /** `system-file`: the flag takes the file path and the content is in the system prompt at
   *  turn 0. `turn-1-read`: no content flag; the model reads the file in its first turn. */
  readonly content:
    | ({ readonly kind: "system-file"; readonly flag: string } & HandoffChannel)
    | { readonly kind: "turn-1-read"; readonly evidence: string };
  /** The auto-submitted first turn: a positional prompt, or a flag followed by the line. */
  readonly firstTurn: { readonly placement: "positional" | "flag-value"; readonly flag: string | null } & HandoffChannel;
}

export interface ProviderCapability {
  /** Registry key AND executable basename. Executable-keyed, not vendor-keyed. */
  readonly key: string;
  readonly displayName: string;
  /** The version the strings below were read from. Printed on the review screen. */
  readonly measuredVersion: string;
  readonly versionEvidence: string;
  readonly provenance: "unverified";
  readonly model: ModelCapability;
  readonly effort: EffortCapability;
  readonly axes: readonly PermissionAxis[];
  readonly history: readonly HistorySupport[];
  readonly cwd: CwdCapability;
  readonly info: readonly InfoOption[];
  /** Rendered verbatim on the provider's own screens. */
  readonly warnings: readonly string[];
  /** Context-handoff delivery (task 1201). See HandoffDelivery. */
  readonly handoff: HandoffDelivery;
}

// ── claude 2.1.283 ──────────────────────────────────────────────────────────
// `--permission-mode` choices, verbatim: "acceptEdits", "auto", "bypassPermissions",
// "manual", "dontAsk", "plan". `default` is NOT among them in this build, which is why
// `manual` is the restrictive value here rather than a `default` this binary may reject.
// There is NO `--sandbox` flag: `grep -nE 'sandbox' claude-help.stdout.txt` matches prose
// about `--dangerously-skip-permissions` only. So claude has ONE axis, and saying it has a
// sandbox axis because three other providers do would be the false equivalence rule 2
// forbids.
const CLAUDE: ProviderCapability = {
  key: "claude",
  displayName: "Claude Code",
  measuredVersion: "2.1.283",
  versionEvidence: "native-help/claude-version.stdout.txt: '2.1.283 (Claude Code)'",
  provenance: "unverified",
  model: {
    flag: "--model",
    evidence: "claude-help: --model <model> (alias or full name, e.g. 'claude-fable-5')",
    defaultNote:
      "Provider default: whatever this account's claude is configured to use. No id is " +
      "pinned here — a catalogue frozen in this file would go stale and claim an old " +
      "model was the latest.",
  },
  effort: {
    kind: "enum",
    flag: "--effort",
    values: ["low", "medium", "high", "xhigh", "max"],
    evidence: "claude-help: --effort <level> (low, medium, high, xhigh, max)",
  },
  axes: [
    {
      axis: "approval",
      flag: "--permission-mode",
      evidence: 'claude-help: --permission-mode choices "acceptEdits","auto","bypassPermissions","manual","dontAsk","plan"',
      values: [
        { value: "manual", argv: ["--permission-mode", "manual"], risk: "restrictive", covers: [], note: "Ask before each action. This build's help does not list 'default', so 'manual' is the evidenced restrictive value." },
        { value: "plan", argv: ["--permission-mode", "plan"], risk: "restrictive", covers: [], note: "Planning only; edit tools stay limited." },
        { value: "acceptEdits", argv: ["--permission-mode", "acceptEdits"], risk: "moderate", covers: [], note: "Edits auto-approved; other tools still prompt." },
        { value: "auto", argv: ["--permission-mode", "auto"], risk: "elevated", covers: [], note: "Auto-approval beyond edits. Claude's 'auto' is not Grok's 'auto'." },
        { value: "dontAsk", argv: ["--permission-mode", "dontAsk"], risk: "elevated", covers: [], note: "Stops prompting. Not the same mechanism as a sandbox." },
        { value: "bypassPermissions", argv: ["--permission-mode", "bypassPermissions"], risk: "bypass", covers: ["approval"], note: "Disables permission checks. Requires the typed acknowledgement." },
        { value: "dangerously-skip-permissions", argv: ["--dangerously-skip-permissions"], risk: "bypass", covers: ["approval"], note: "The blanket flag the pre-#1181 boot hardcoded. It is now reachable ONLY here, by name, with the acknowledgement typed — which is the point: an operator who genuinely needs it can still have it, and nothing else can select it for them." },
      ],
    },
  ],
  history: [
    { mode: "new", subcommand: [], flags: [], evidence: "claude-help: a bare `claude` starts a new session", scope: "New conversation. Nothing prior is read." },
    { mode: "last", subcommand: [], flags: ["--continue"], evidence: "claude-help: -c, --continue — continue the most recent conversation in the current directory", scope: "Most recent conversation IN THE INHERITED CWD, for this claude config home only." },
    {
      mode: "selected",
      subcommand: [],
      flags: ["--resume"],
      selector: { form: "uuid", placement: "flag-value", describe: "a session UUID" },
      evidence: "claude-help: -r, --resume [value] — resume by session ID, or open a picker",
      scope:
        "One named session id for this claude config home. A UUID only: --resume also " +
        "accepts a free-text search term that opens a PICKER, and a picker inside a " +
        "command substitution would draw on the stdout the shim execs.",
    },
  ],
  cwd: { flag: null, note: "claude has no cwd flag (claude-help). The bridge inherits the shell's cwd." },
  info: [
    { label: "--session-id <uuid>", detail: "Start a new conversation under a chosen UUID. Not offered by this wizard: the orchestrator's own identity is ORCHESTRATOR_SID, and a second id to keep in step is a footgun, not a feature." },
    { label: "--add-dir <dirs...>", detail: "Widens tool access to more directories. Not offered here: it broadens reach, and this wizard only ever narrows." },
    { label: "--fork-session", detail: "With --resume/--continue, writes to a NEW session id instead of the original. Not offered: it changes which session the control tower owns." },
  ],
  warnings: [
    "claude-help output was captured truncated at exactly 16384 bytes (mid-flag, '--settings <file-or'). Flags after that point are UNMEASURED and none of them are offered here.",
    "'ultracode' is documented elsewhere as an effort level but is NOT printed by 2.1.283's --effort help. It is therefore not offered.",
  ],
  handoff: {
    // [measured] on the worker path, not in this capture: the flag sits past the 16384-byte
    // truncation of claude-help, and SPEC F7 records it as verified end to end.
    content: {
      kind: "system-file",
      flag: "--append-system-prompt-file",
      status: "measured",
      evidence:
        "src/session/boot-adapter/claude.ts:30,39 and bin/boot-prepare.mjs:13-14 (verified end to end under OAuth: " +
        "`claude --append-system-prompt-file <file> --print …`). Not in the truncated 2.1.283 help capture.",
    },
    // [inferred] P0-6: a positional [prompt] that auto-submits in the interactive TUI is not measured.
    firstTurn: { placement: "positional", flag: null, status: "owed", evidence: "positional [prompt] — inferred; SPEC P0-6 owes the live boot" },
  },
};

// ── codex-cli 0.157.1 ───────────────────────────────────────────────────────
// TWO orthogonal axes, both printed with their value sets: `-a, --ask-for-approval
// on-request|never` and `-s, --sandbox read-only|workspace-write|danger-full-access`. The
// only blanket bypass in this build is `--dangerously-bypass-approvals-and-sandbox` —
// there is NO `--full-auto` and NO `--yolo` (the draft's claim), and `--ask-for-approval`
// no longer takes `untrusted`.
//
// EFFORT IS A NAMED GAP, not a value. codex-help prints no effort flag; the mechanism is a
// `-c key=value` config override whose key spelling and accepted values this capture
// cannot corroborate. Guessing `model_reasoning_effort=high` would put an unvalidated TOML
// override on the control tower's command line, so nothing is offered.
const CODEX: ProviderCapability = {
  key: "codex",
  displayName: "Codex CLI",
  measuredVersion: "0.157.1",
  versionEvidence: "native-help/codex-version.stdout.txt: 'codex-cli 0.157.1'",
  provenance: "unverified",
  model: {
    flag: "--model",
    evidence: "codex-help and codex-resume-help: -m, --model <MODEL>",
    defaultNote: "Provider default: this codex install's configured model. No id is pinned here.",
  },
  effort: {
    kind: "gap",
    evidence:
      "codex-help prints no effort flag. Reasoning effort is reachable only through a " +
      "`-c <key>=<value>` config override whose key name and value set are NOT printed by " +
      "--help and are not corroborated by any staged evidence. Recorded as a gap; the " +
      "release still owes the measurement.",
  },
  axes: [
    {
      axis: "approval",
      flag: "--ask-for-approval",
      evidence: "codex-help: -a, --ask-for-approval possible values on-request|never",
      values: [
        { value: "on-request", argv: ["--ask-for-approval", "on-request"], risk: "restrictive", covers: [], note: "The model asks before running a command. The most restrictive approval value this build offers." },
        { value: "never", argv: ["--ask-for-approval", "never"], risk: "elevated", covers: [], note: "Never asks; failures go back to the model. The SANDBOX is then the only remaining limit, so pick it deliberately." },
        { value: "dangerously-bypass-approvals-and-sandbox", argv: ["--dangerously-bypass-approvals-and-sandbox"], risk: "bypass", covers: ["approval", "sandbox"], note: "Disables approvals AND the sandbox together. Requires the typed acknowledgement, and no sandbox value may be combined with it." },
      ],
    },
    {
      axis: "sandbox",
      flag: "--sandbox",
      evidence: "codex-help: -s, --sandbox possible values read-only|workspace-write|danger-full-access",
      values: [
        { value: "read-only", argv: ["--sandbox", "read-only"], risk: "restrictive", covers: [], note: "Model-run commands cannot write." },
        { value: "workspace-write", argv: ["--sandbox", "workspace-write"], risk: "moderate", covers: [], note: "Writes confined to the workspace." },
        { value: "danger-full-access", argv: ["--sandbox", "danger-full-access"], risk: "bypass", covers: ["sandbox"], note: "No sandboxing. Requires the typed acknowledgement." },
      ],
    },
  ],
  history: [
    { mode: "new", subcommand: [], flags: [], evidence: "codex-help: a bare `codex` starts an interactive session", scope: "New session. Nothing prior is read." },
    {
      mode: "last",
      subcommand: ["resume"],
      flags: ["--last"],
      evidence: "codex-resume-help: --last — continue the most recent session without showing the picker",
      scope:
        "Most recent RECORDED session under this CODEX_HOME, cwd-filtered. --all (which " +
        "drops cwd filtering) and --include-non-interactive are deliberately never passed.",
    },
    {
      mode: "selected",
      subcommand: ["resume"],
      flags: [],
      selector: { form: "uuid-or-name", placement: "positional", describe: "a session UUID, or a session name" },
      evidence: "codex-resume-help: [SESSION_ID] — session id (UUID) or session name; UUIDs take precedence",
      scope: "One named session under this CODEX_HOME, cwd-filtered. The picker is never reached, because a picker would draw on the exec-argv channel.",
    },
  ],
  cwd: {
    flag: "-C, --cd <DIR>",
    note:
      "codex DOES have a cwd flag in 0.157.1 (the frozen draft said otherwise). It is " +
      "still not passed: the bridge inherits the cwd of the shell that execs it, and a " +
      "flag that disagreed with that would make the review screen wrong.",
  },
  info: [
    { label: "--worktree", detail: "Runs the session in a new managed git worktree. Not offered: it relocates the session's tree away from the cwd shown on the review screen." },
    { label: "--search", detail: "Enables the native web-search tool with no per-call approval. Not offered: it widens reach past the approval value just chosen." },
    { label: "codex exec", detail: "The non-interactive subcommand. Measured to expose -s/--sandbox but NO approval flag, so it has no 'ask the user' option at all. The orchestrator bridge is interactive and never uses it." },
  ],
  warnings: [
    "Effort is a recorded GAP for codex (see effort.evidence) — not an unsupported feature, and not a value guessed from another provider's enum.",
  ],
  handoff: {
    // codex has no system-prompt flag (src/session/boot-adapter/codex.ts:2-10); the model reads the file.
    content: { kind: "turn-1-read", evidence: "no system-prompt flag; codex reads AGENTS.md from cwd (boot-adapter/codex.ts:6-9)" },
    // [inferred] P0-6: positional [PROMPT] for the interactive session is not measured.
    firstTurn: { placement: "positional", flag: null, status: "owed", evidence: "positional [PROMPT] — inferred; SPEC P0-6 owes the live boot" },
  },
};

// ── gemini 0.53.0 ───────────────────────────────────────────────────────────
// `--approval-mode` prints its four choices. The sandbox axis is BOOLEAN (`-s, --sandbox
// Run in sandbox? [boolean]`) — not an enum, so it is modelled as off/on and not mapped
// onto codex's three policies. No effort flag exists at the CLI.
const GEMINI: ProviderCapability = {
  key: "gemini",
  displayName: "Gemini CLI",
  measuredVersion: "0.53.0",
  versionEvidence: "native-help/gemini-version.stdout.txt: '0.53.0'",
  provenance: "unverified",
  model: {
    flag: "--model",
    evidence: "gemini-help: -m, --model [string] (no default printed)",
    defaultNote: "Provider default: this gemini install's configured model. No id is pinned here.",
  },
  effort: {
    kind: "unsupported",
    evidence: "gemini-help prints no effort or reasoning-effort flag at 0.53.0. Measured absent, so the step is skipped rather than shown as 'default'.",
  },
  axes: [
    {
      axis: "approval",
      flag: "--approval-mode",
      evidence: 'gemini-help: --approval-mode choices "default","auto_edit","yolo","plan"',
      values: [
        { value: "default", argv: ["--approval-mode", "default"], risk: "restrictive", covers: [], note: "Prompt for approval." },
        { value: "plan", argv: ["--approval-mode", "plan"], risk: "restrictive", covers: [], note: "Read-only mode." },
        { value: "auto_edit", argv: ["--approval-mode", "auto_edit"], risk: "moderate", covers: [], note: "Auto-approve edit tools only." },
        { value: "yolo", argv: ["--approval-mode", "yolo"], risk: "bypass", covers: ["approval"], note: "Auto-approve ALL tools. Requires the typed acknowledgement. (-y/--yolo is the same policy as a separate boolean; one spelling is offered, not two.)" },
      ],
    },
    {
      axis: "sandbox",
      flag: "--sandbox",
      evidence: "gemini-help: -s, --sandbox — 'Run in sandbox?' [boolean]. A boolean, with no profile enum.",
      values: [
        { value: "on", argv: ["--sandbox"], risk: "restrictive", covers: [], note: "Run inside gemini's sandbox." },
        { value: "off", argv: [], risk: "moderate", covers: [], note: "No sandbox flag passed. gemini's own default; the boolean has no printed default state, so 'off' means 'this wizard passes nothing'." },
      ],
    },
  ],
  history: [
    { mode: "new", subcommand: [], flags: [], evidence: "gemini-help: a bare `gemini` starts interactive mode", scope: "New session. Nothing prior is read." },
    {
      mode: "last",
      subcommand: [],
      flags: ["--resume", "latest"],
      evidence: 'gemini-help: -r, --resume — "Use \'latest\' for most recent or index number"',
      scope: "Most recent session for the current project, as gemini scopes it. --list-sessions is never run and no session file is read.",
    },
    {
      mode: "selected",
      subcommand: [],
      flags: ["--resume"],
      selector: { form: "latest-or-index", placement: "flag-value", describe: "'latest', or a session index number (e.g. 5)" },
      evidence: "gemini-help: -r, --resume latest|<index>",
      scope:
        "One session for the current project, by gemini's own index. The index is NOT " +
        "discovered here: --list-sessions is a read this planning step must not perform, " +
        "so the operator types the number they already know.",
    },
  ],
  cwd: { flag: null, note: "gemini has no cwd flag (gemini-help). The bridge inherits the shell's cwd." },
  info: [
    { label: "--session-file <json>", detail: "Loads a session from a JSON file. Not offered: an external transcript path is neither native history nor this module's business." },
    { label: "--delete-session <index>", detail: "Deletes a session. Never reachable from a boot wizard — planning a boot must not destroy history." },
    { label: "--skip-trust", detail: "Trusts the workspace for the session. Not offered: it is a third axis this capture has no value semantics for." },
  ],
  warnings: [
    "Measured 2026-09: `gemini --help` itself created $HOME/.gemini/projects.json.*.tmp. This wizard therefore never executes gemini to describe it.",
    "0.53.0's help does NOT mark --yolo deprecated, contrary to secondary documentation. Only --approval-mode yolo is offered, so the ambiguity cannot reach the argv.",
  ],
  handoff: {
    // gemini-cli has no system-prompt flag (src/session/boot-adapter/gemini.ts:1-10); the model reads the file.
    content: { kind: "turn-1-read", evidence: "no system-prompt flag; gemini reads GEMINI.md → @AGENTS.md from cwd (boot-adapter/gemini.ts:1-10)" },
    // [inferred] for gemini-cli 0.53.0. --prompt-interactive is measured for agy only
    // (boot-adapter/gemini.ts:54), and agy is not this registry's `gemini`.
    firstTurn: {
      placement: "flag-value",
      flag: "--prompt-interactive",
      status: "owed",
      evidence: "--prompt-interactive <line> — measured for agy (boot-adapter/gemini.ts:54), inferred for gemini-cli 0.53.0; SPEC P0-6",
    },
  },
};

// ── grok 1.0.25 (f7e67d6988e2) ──────────────────────────────────────────────
// TWO flags, NEITHER with a printed value set for what we need:
//   --permission-mode <MODE>   [possible values: default, acceptEdits, auto, dontAsk,
//                              bypassPermissions, plan]   ← printed, but see rule 2
//   --sandbox <PROFILE>        [env: GROK_SANDBOX=]        ← NO profile enum printed
//   --reasoning-effort <EFFORT> [aliases: --effort]        ← NO value set printed
//
// The sandbox profiles come from input/official/grok-sandbox.md (off|workspace|devbox|
// read-only|strict), which is vendor documentation for the same feature, cited per value.
// The effort values come from NOWHERE, so effort is `kind: "literal"`.
const GROK: ProviderCapability = {
  key: "grok",
  displayName: "Grok Build",
  measuredVersion: "1.0.25",
  versionEvidence: "native-help/grok-version.stdout.txt: 'grok 1.0.25 (f7e67d6988e2)'",
  provenance: "unverified",
  model: {
    flag: "--model",
    evidence: "grok-help: -m, --model <MODEL>",
    defaultNote: "Provider default: this grok install's configured model. No id is pinned here.",
  },
  effort: {
    kind: "literal",
    flag: "--reasoning-effort",
    maxLength: 16,
    warning:
      "UNVERIFIED VALUE: grok 1.0.25 prints --reasoning-effort but NOT its accepted " +
      "values, so this wizard cannot check what you type. grok itself will accept or " +
      "reject it. Claude's low|medium|high|xhigh|max enum is NOT evidence for grok.",
    evidence: "grok-help: --reasoning-effort <EFFORT> [aliases: --effort] — no possible-values block printed",
  },
  axes: [
    {
      axis: "approval",
      flag: "--permission-mode",
      evidence:
        "grok-help: --permission-mode [possible values: default, acceptEdits, auto, " +
        "dontAsk, bypassPermissions, plan]. NAME-IDENTICAL to claude's and NOT the same " +
        "policy: input/official/grok-permissions.md defines grok's modes as " +
        "Ask/Auto/Always-approve and does not document this flag at all.",
      values: [
        { value: "default", argv: ["--permission-mode", "default"], risk: "restrictive", covers: [], note: "grok's documented 'Ask': prompt for anything not already allowed." },
        { value: "plan", argv: ["--permission-mode", "plan"], risk: "restrictive", covers: [], note: "Plan mode; grok documents plan review as not skipped even under auto." },
        { value: "acceptEdits", argv: ["--permission-mode", "acceptEdits"], risk: "moderate", covers: [], note: "Printed by grok's help. Its exact semantics are grok's, not claude's." },
        { value: "auto", argv: ["--permission-mode", "auto"], risk: "elevated", covers: [], note: "grok's documented 'Auto': a classifier auto-approves safe tools; deny rules and hooks still apply." },
        { value: "dontAsk", argv: ["--permission-mode", "dontAsk"], risk: "elevated", covers: [], note: "grok documents dontAsk as a headless/enterprise mode." },
        { value: "bypassPermissions", argv: ["--permission-mode", "bypassPermissions"], risk: "bypass", covers: ["approval"], note: "Requires the typed acknowledgement. (--always-approve is grok's documented equivalent policy; one spelling is offered, not two.)" },
      ],
    },
    {
      axis: "sandbox",
      flag: "--sandbox",
      evidence:
        "grok-help: --sandbox <PROFILE> [env: GROK_SANDBOX=] with NO profile enum " +
        "printed. The five profile names below are from input/official/grok-sandbox.md, " +
        "the vendor page for this feature, and are cited per value.",
      values: [
        { value: "strict", argv: ["--sandbox", "strict"], risk: "restrictive", covers: [], note: "grok-sandbox.md: read CWD and system paths; write CWD, ~/.grok, temp; child network blocked. Documented for untrusted repositories." },
        { value: "read-only", argv: ["--sandbox", "read-only"], risk: "restrictive", covers: [], note: "grok-sandbox.md: write ~/.grok and temp only; child network blocked." },
        { value: "workspace", argv: ["--sandbox", "workspace"], risk: "moderate", covers: [], note: "grok-sandbox.md: write CWD, ~/.grok, temp; network allowed. Documented as normal development." },
        { value: "devbox", argv: ["--sandbox", "devbox"], risk: "elevated", covers: [], note: "grok-sandbox.md: write top-level dirs except /data. Documented for cloud devboxes." },
        { value: "off", argv: ["--sandbox", "off"], risk: "bypass", covers: ["sandbox"], note: "grok-sandbox.md: unrestricted, and grok's own default. Passed EXPLICITLY here so the review screen cannot show a blank where 'no sandbox' was meant. Requires the typed acknowledgement." },
      ],
    },
  ],
  history: [
    { mode: "new", subcommand: [], flags: [], evidence: "grok-help: a bare `grok` starts the interactive TUI", scope: "New session. Nothing prior is read." },
    { mode: "last", subcommand: [], flags: ["--continue"], evidence: "grok-help: -c, --continue — continue the most recent session for the current working directory", scope: "Most recent session for the INHERITED CWD under this ~/.grok." },
    {
      mode: "selected",
      subcommand: [],
      flags: ["--resume"],
      selector: { form: "uuid-or-title", placement: "flag-value", describe: "a session UUID, or an exact session title for this directory" },
      evidence: "grok-help: -r, --resume [<SESSION_ID_OR_TITLE>] — UUID-shaped values always mean IDs; other values match titles for the current directory; duplicate titles fail as ambiguous",
      scope: "One session for the current directory under this ~/.grok. grok itself refuses an ambiguous title rather than picking one.",
    },
  ],
  cwd: {
    flag: "--cwd <CWD>",
    note:
      "grok DOES have a cwd flag. It is still not passed, for the same reason as codex's: " +
      "the bridge inherits the cwd of the shell that execs it.",
  },
  info: [
    { label: "-s, --session-id <UUID>", detail: "On grok, -s is --session-id — on codex, -s is --sandbox. Short flags are NOT portable between providers, which is why every value in this registry carries its own long-form argv." },
    { label: "--worktree [<NAME>]", detail: "Starts the session in a new git worktree. Not offered: it relocates the tree away from the cwd on the review screen." },
    { label: "--restore-code", detail: "On resume, restores the original session's repository snapshot. Never offered: a boot wizard must not check code out over your working tree." },
  ],
  warnings: [
    "Measured 2026-09: `grok --help` itself created $HOME/.grok/. This wizard therefore never executes grok to describe it.",
    "grok-sandbox.md records that child-network restriction is enforced on Linux only and is a no-op on macOS for read-only/strict. A profile name is not a platform guarantee.",
    "grok-sandbox.md also records that a managed requirements.toml can OVERRIDE the CLI flag. What this wizard shows is what it passes, not necessarily what grok ends up enforcing.",
  ],
  handoff: {
    // `--rules` is measured at grok 0.2.93 only (boot-adapter/grok.ts:1) and is system-level,
    // so it does not start a turn; it is not this entry. grok reads AGENTS.md from cwd
    // (PHASE0 P0-8, measured), and the model reads the file.
    content: { kind: "turn-1-read", evidence: "no measured content flag at 1.0.25; grok reads AGENTS.md from cwd (Phase 0 P0-8)" },
    // [inferred] P0-6: a positional prompt for the interactive TUI is not measured.
    firstTurn: { placement: "positional", flag: null, status: "owed", evidence: "positional prompt — inferred; SPEC P0-6 owes the live boot" },
  },
};

/**
 * THE REGISTRY, and the extension seam.
 *
 * Adding a fifth provider is appending one `ProviderCapability` literal here, with its
 * `measuredVersion` and a per-value `evidence`/`note` chain, exactly as the four above
 * carry. Nothing else in this module needs to change, and nothing anywhere loads an entry
 * from disk, env or a shell command — `agy`, for one, is NOT here, because no staged
 * capture measured it and "gemini's flags probably work" is precisely the substitution
 * this file exists to prevent.
 */
export const CAPABILITIES: readonly ProviderCapability[] = [CLAUDE, CODEX, GEMINI, GROK];

export function findCapability(key: string): ProviderCapability | undefined {
  return CAPABILITIES.find((c) => c.key === key);
}

export function capabilityKeys(): readonly string[] {
  return CAPABILITIES.map((c) => c.key);
}

/** The axis's restrictive default — the wizard's pre-selection, and never an elevated one. */
export function defaultAxisValue(axis: PermissionAxis): AxisValue {
  const restrictive = axis.values.find((v) => v.risk === "restrictive");
  // Every axis above has one. The fallback is not a policy: it exists so that adding an
  // axis without a restrictive value is a visible wrong default rather than a crash.
  return restrictive ?? axis.values[0];
}

export function findAxisValue(axis: PermissionAxis, value: string): AxisValue | undefined {
  return axis.values.find((v) => v.value === value);
}

export function findHistory(cap: ProviderCapability, mode: string): HistorySupport | undefined {
  return cap.history.find((h) => h.mode === mode);
}
