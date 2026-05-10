---
type: adr
status: accepted
revision: r4
accepted_at: 2026-05-05
acceptance_basis: "r1 (3aa83d3) gemini ACCEPT (boundary direction) + codex ACCEPT_WITH_CONDITIONS (5C+5M+3AP); r2 (9384540) codex ACCEPT_WITH_CONDITIONS 4-new-issues; r3 (41456d6) codex ACCEPT_WITH_CONDITIONS 3-textual; r4 (7c5575d) all 3 conditions resolved per codex §8 guidance — no further re-review required. Cumulative: 5C+5M+3AP+4N+3T = ALL RESOLVED."
previous_revision: 41456d6
r2_basis: "codex-e0b528b (5 conditions + 5 majors + 5 minors + 3 anti-patterns); gemini-3aa83d3 ACCEPT (preserved)"
r3_basis: "codex-72f45b9 r2 re-review (4 NEW issues N1-N4 + §6.5/M0 testable readiness gates + re-verification of 1 waiver / 1 deferral / 1 waived anti-pattern); gemini r1 ACCEPT preserved (boundary direction unchanged)"
r4_basis: "codex-89a80a5 r3 review ACCEPT_WITH_CONDITIONS — 3 textual conditions only (C1: §5 Q2 stale 4-surface count; C2: §3.6.1 sessions[].version disambiguation; C3: §3.6.1 fixture paths TBD-with-owner). Targeted text patch only per codex §8 guidance; no boundary direction change; no re-architecture; gemini r1 ACCEPT preserved by construction."
date: 2026-05-05
author: aigentry-architect-telepty-boundary-adr (r1) → aigentry-architect-boundary-adr-r2 (r2) → aigentry-architect-boundary-adr-r3 (r3) → aigentry-architect-boundary-r4 (r4)
scope: ecosystem
decision_type: one-way
tier: T2
trigger: "Phase 2.5 — telepty issues #8 / #10.2 / #3 require pre-decision on telepty/devkit role boundary (triage Q3, commit 30abd73). r2 trigger: codex r1 review (e0b528b) demanded protocol-grade contract specifications. r3 trigger: codex r2 re-review (72f45b9) demanded resolution of `[context-ref/v1]` binding-vs-deferral contradiction (N1), 3 additional new issues (N2-N4), and testable §6.5/M0 readiness gates before Phase 2 sub-dispatch."
related:
  - "~/projects/aigentry-architect/docs/triage/2026-05-04-telepty-issues-triage.md"
  - "~/projects/aigentry/docs/CONSTITUTION.md (Articles 1, 3, 9, 15, 17)"
  - "~/projects/aigentry-telepty/AGENTS.md"
  - "~/projects/aigentry-devkit/AGENTS.md"
  - "~/projects/aigentry-devkit/docs/reports/2026-05-05-boundary-adr-codex-review.md (r1 review, e0b528b)"
  - "~/projects/aigentry-devkit/docs/reports/2026-05-05-boundary-adr-gemini-review.md (r1 review, 3aa83d3)"
  - "~/projects/aigentry-devkit/docs/reports/2026-05-05-boundary-adr-r2-codex-review.md (r2 re-review, 72f45b9)"
related_tasks: [8, 10, 3]
unblocks:
  - "telepty issue #8 (telepty init for AGENTS.md/CLAUDE.md/GEMINI.md)"
  - "telepty issue #10.2 (devkit-owned per-CLI hook installation; rejects telepty install hooks)"
  - "telepty issue #3 (auto-generate CLAUDE.md + .claude/settings.json on session create)"
tags: [boundary, telepty, devkit, role-separation, article-3, content-vs-mechanism, protocol-grade-r2, contradiction-resolution-r3, testable-gates-r3]
supersedes: []
reviewers_recommended: [codex, gemini]
revision_history:
  - r1: "2026-05-05 (commit 3aa83d3) — initial draft. gemini ACCEPT, codex ACCEPT_WITH_CONDITIONS"
  - r2: "2026-05-05 (commit 9384540) — protocol-grade contract specifications added (§3.1.1, §3.1.2, §3.3.1); codex 5 conditions integrated verbatim (§3.5); 3 anti-patterns addressed (§11.4); sharper 4-rule boundary (§3.1); strengthened grandfathering (§6.2.1); session launch audit scoped (§6.6); verification M0+M6 added (§8)"
  - r3: "2026-05-05 — codex r2 re-review (72f45b9) integrated. N1 contradiction resolved via Option C versioned-binding policy (§3.1.2.1.1); N2 four-vs-six surfaces cleanup (§4.4, §11.1, §11.3); N3 telepty list --json schema/fixture concretized (§3.6); N4 path grammar accepts absolute+`~/` forms (§3.1.2.2); §6.5 elevated with testable per-surface artifact gates (§6.5.1); M0 metric tied to verifiable shell commands (§8); OQ-1 removed (was the source of N1); §11.3 deferral language removed; prior fixes re-verified (§3.5.5); gemini r1 ACCEPT preserved (boundary direction invariant per r2/r3 hard rule)"
  - r4: "2026-05-05 — codex r3 ACCEPT_WITH_CONDITIONS (89a80a5) targeted text patch (3 conditions). C1: §5 Q2 stale '4 contract surfaces' → '6 contract surfaces (3 stable + 3 newly specified)' (N2 partial cleanup). C2: §3.6.1 schema disambiguation — Option (a) chosen, removed `sessions[].version` from session-object example, envelope-only versioning explicitly stated, 'envelope + 11 fields' restated. C3: §3.6.1 fixture paths labeled TBD Phase 3 deliverables with owner (aigentry-telepty) and merge-block (M6/G5). No boundary direction change; no re-architecture; no §6.5.1/§8/§3.5.5/§6.6 alterations; §13 r3 self-check rubric remains valid (textual cleanup only)."
---

# ADR 2026-05-05: Telepty / Devkit Repository Boundary — Mechanism vs Content Split

## §1 Status, Context, Trigger

- **Status**: **proposed** (user signoff via aigentry-orchestrator converts to `accepted`).
- **Date**: 2026-05-05.
- **Author**: aigentry-architect-telepty-boundary-adr.
- **Trigger**: Phase 2.5 of the telepty 13-issue triage (`~/projects/aigentry-architect/docs/triage/2026-05-04-telepty-issues-triage.md`, commit `30abd73`) blocks three feature dispatches — **#8 telepty init**, **#10.2 telepty install hooks**, **#3 CLAUDE.md scaffold** — on a **pre-decision** of which repository owns "install integration files into user's home directory" responsibilities. Triage §5 Q3 and §3.4 (#3, #8, #10) all explicitly mark this ADR as the **boundary lock**.
- **Tier**: **T2** — `type=adr × scope=ecosystem × decision_type=one-way` per `references/frontmatter-schema.md` table → 2 reviewer threshold (recommend codex + gemini after drafting; see §10.4).
- **Decision type**: **one-way** — repository boundaries define long-term coupling; reversing means cross-repo migration of code, history, and consumer references. Per ADR-template §3 / Bezos one-way principle, this warrants up-front rigor.
- **Scope**: **ecosystem** — binds telepty + devkit + downstream consumers (orchestrator, aterm, brain, dustcraw — every component that installs telepty primitives or scaffolds project files).

### §1.1 Why this ADR now

The triage (`30abd73`) identified that **without a boundary lock**, three Phase 2 issues either stall or get implemented in the wrong repo:

| Issue | Triage section | Blocker text |
|---|---|---|
| #8 telepty init | §3.3 #8 | "borderline. Editing `~/CLAUDE.md` is a config file mutation. Telepty owns session/cross-machine; devkit owns install/scaffolding (per Article 3 table). DECISION REQUIRED (see §5 Q3)" |
| #10.2 install hooks | §3.4 #10 | "per-CLI hook installation = devkit territory. Telepty owns the protocol semantics" |
| #3 CLAUDE.md scaffold | §3.4 #3 | "This is devkit's `aigentry scaffold` job per the table. Telepty's role is session transport, not project file generation" |

All three issues ship code that crosses telepty↔devkit responsibility. Implementing them in the wrong repo creates Article 3 (역할) violations and Article 4 (경계) duplications that are expensive to unwind later.

### §1.2 Evidence — current ambiguity in production

Direct verification (2026-05-05) shows the boundary is already partially crossed in incoherent ways:

| Artifact | Current location | Evidence | Boundary classification (this ADR) |
|---|---|---|---|
| `bin/open-session.sh` | devkit (canonical) | `ls -la ~/projects/aigentry-orchestrator/bin/open-session.sh` → symlink to `~/projects/aigentry-devkit/bin/open-session.sh` | Content (devkit) — orchestrator session bootstrap is provisioning |
| `skill-installer.js` | telepty (`~/projects/aigentry-telepty/skill-installer.js`, AGENTS.md table line 11) | telepty AGENTS.md §Architecture lists it; triage Phase 1 #7 patches it in-place | Content (devkit) per this boundary — but stays put under §6.2 grandfathering |
| `skills/telepty-{inject,broadcast,list,attach,allow,daemon,listen,rename,session,session}/SKILL.md` | telepty repo | `ls ~/projects/aigentry-telepty/skills/` → 10 entries | **Reference docs for telepty's own commands** — stays in telepty (mechanism docs, see §3.4 ruling) |
| `skills/{deliberation,env-manager,deliberation-executor,…}` | devkit repo (`ls ~/projects/aigentry-devkit/skills/` → 11 entries) | devkit AGENTS.md §Architecture | Content (devkit) — already correct |
| `aigentry session create X` | devkit (`bin/aigentry-devkit.js`) | devkit AGENTS.md §Commands; **also** mirrored as `telepty session start --launch` in telepty CLI | Overlap — this ADR §3.4 row deconflicts |

The mixture is not deliberate; it is an accretion of "wherever was easiest at the time" decisions. Triage §5 Q3 now asks the orchestrator to pick a rule.

### §1.3 Inputs synthesized (binding)

| Input | Path | Frozen ref |
|---|---|---|
| Telepty triage (Phase 2.5 trigger) | `~/projects/aigentry-architect/docs/triage/2026-05-04-telepty-issues-triage.md` | architect commit `30abd73` |
| Constitution (Articles 1, 3, 9, 17) | `~/projects/aigentry/docs/CONSTITUTION.md` | this repo |
| Telepty AGENTS.md / CLAUDE.md (scope claim) | `~/projects/aigentry-telepty/{AGENTS.md, CLAUDE.md}` | repo HEAD |
| Devkit AGENTS.md / CLAUDE.md (scope claim) | `~/projects/aigentry-devkit/{AGENTS.md, CLAUDE.md}` | repo HEAD |
| Architect references | `~/projects/aigentry-architect/references/{adr-template.md, frontmatter-schema.md, constitution-check.md, reviewer-matrix.md}` | repo HEAD |
| Worked-example ADR style | `~/projects/aigentry-orchestrator/docs/adr/2026-05-04-phase6-conclusion.md` | this repo |

---

## §2 Problem Statement

**Question**: For each artifact in the telepty/devkit shared territory — installers, scaffolders, per-CLI hooks, agent integration recipes, project-file generators, snippets — **which repository owns it**?

The current state has **three distinct ambiguity classes**:

### §2.1 Class A — clearly-bounded artifacts (no ambiguity)

| Artifact class | Repo | Why obvious |
|---|---|---|
| Transport, daemon, sessions, inject/broadcast/allow | **telepty** | telepty's literal raison d'être (AGENTS.md §Overview) |
| Cross-cutting installable skills (deliberation, env-manager) | **devkit** | devkit AGENTS.md §Managed Modules |
| Install profiles, healthchecks, `aigentry setup` | **devkit** | devkit AGENTS.md §Architecture |

These are not in dispute and stay where they are.

### §2.2 Class B — telepty-itself documentation

| Artifact class | Currently | Question |
|---|---|---|
| `skills/telepty-inject/SKILL.md` etc. (10 files) | telepty | Is reference documentation **about telepty CLI commands** mechanism (telepty owns) or content (devkit owns)? |
| `telepty init --print-snippet` (proposed) | undecided | Snippet text "telepty is your primary session tool" — telepty (source of truth) or devkit (install content)? |

### §2.3 Class C — cross-cutting installation/scaffolding mechanisms

| Artifact class | Currently | Question |
|---|---|---|
| `~/CLAUDE.md` / `AGENTS.md` / `GEMINI.md` sentinel-managed appender (#8) | does not exist | telepty subcommand or devkit `aigentry scaffold` extension? |
| Per-CLI hook installer for `[context-ref]` (#10.2) | does not exist | `telepty install hooks claude` or `aigentry scaffold install-hooks claude`? |
| Project `CLAUDE.md` + `.claude/settings.json` auto-gen on session create (#3) | does not exist | telepty TUI `s` key or devkit `aigentry scaffold`? |
| `skill-installer.js` (already exists, telepty Phase 1 #7 patched it) | telepty | Stay put or migrate to devkit? |
| `bin/open-session.sh` symlinked from orchestrator → devkit | devkit | Already in devkit; is this correct under the boundary? |
| `aigentry session create` (devkit) vs `telepty session start --launch` (telepty) | both | One canonical or two with role split? |

This ADR locks the rule that resolves all Class B + Class C cases without case-by-case re-litigation.

---

## §3 Decision

### §3.1 The boundary rule (4-rule sharpening, codex r1 minor 1)

The r1 one-line "mechanism vs content" was directionally correct but allowed two acknowledged exceptions (telepty owns SKILL.md content; devkit owns `open-session.sh` runtime). Codex r1 review §1 demanded a sharper 4-rule formulation. **Adopted verbatim** as the binding rule:

1. **Telepty owns transport/runtime primitives and normative protocol semantics.** (inject, broadcast, allow, daemon, session lifecycle; `[context-ref]` + retry-safe submit semantics; cross-host `<id>@<host>` addressing.)
2. **Telepty may own reference content only when it documents telepty's own CLI/protocol surface.** (`skills/telepty-*/SKILL.md`, `--print-snippet` output describing telepty itself.)
3. **Devkit owns all mutation of user/project files, install profiles, generated templates, and per-AI-CLI integration.** (`~/CLAUDE.md` editing, `.claude/settings.json` generation, claude/codex/gemini hook installation.)
4. **Devkit may own session provisioning workflows only when they are multi-component orchestration over telepty primitives, not alternative implementations of telepty primitives.** (provisioning facade; if reusable terminal/session primitive surfaces in devkit, it must migrate to or be exposed from telepty per §6.6.)

**One-line restatement (for executive use)**: telepty owns transport + protocol semantics + telepty-self reference docs; devkit owns disk-side content + per-CLI integration + multi-component provisioning over telepty primitives.

**Test of any future artifact**: apply rules 1→2→3→4 in order. First match wins. If two rules match, the artifact is decomposable — split it.

### §3.1.1 Snippet Protocol Specification (`telepty-snippet/v1`)

**Addresses**: codex r1 condition 1 (verbatim §3.5 row 1) + codex r1 major 1.

This subsection defines the **stdout/stderr/exit-code/version contract** for `telepty init --print-snippet` so a telepty implementer and a devkit implementer (`aigentry scaffold --integrate-telepty`) can build independently without re-litigating behavior. SSOT registry tag: `telepty-snippet/v1`.

#### §3.1.1.1 Producer side — `telepty init --print-snippet`

| Field | Specification |
|---|---|
| **Invocation** | `telepty init --print-snippet [--target {claude\|agents\|gemini\|all}] [--format {markdown\|json}]` |
| **Default `--target`** | `all` — emits one section per target file with section header `## telepty-snippet:claude` / `:agents` / `:gemini` |
| **Default `--format`** | `markdown` — JSON envelope opt-in only (devkit consumes markdown by default) |
| **stdin** | **NEVER** consumed. Argv flags only. (Reason: deterministic CLI, no piping ambiguity.) |
| **stdout — envelope** | Begins with sentinel header line: `<!-- telepty-snippet/v1 BEGIN target=<name> sha256=<hex8> -->`<br>Ends with: `<!-- telepty-snippet/v1 END target=<name> -->`<br>Body between sentinels = canonical snippet markdown (UTF-8, LF-only, no CRLF). |
| **stdout — JSON form** (when `--format json`) | `{"version":"telepty-snippet/v1","target":"claude\|agents\|gemini","sha256":"<hex>","body":"<markdown text>"}` per line (NDJSON, one object per target). |
| **stderr** | **Warnings only** (e.g., "telepty version > spec range, snippet may include forward-compat content"). NEVER errors. NEVER status messages. Devkit consumers may safely tee stderr to a log without affecting stdin pipelines. |
| **Body content** | Pure description: what telepty is, the canonical 5-line quick-start (`telepty daemon`, `telepty allow --id`, `telepty list`, `telepty inject`, `telepty attach`). NO user-specific shell substitution, NO `$HOME` expansion, NO commands run at install time. (Security: prevents code injection through scaffold pipeline.) |
| **Idempotency** | sha256 of body is stable across invocations on the same telepty version. Different telepty versions MAY change body → different sha256 → devkit detects via §3.1.1.2 sentinel diff. |
| **Versioning** | Body format changes are **additive within `v1`** (new lines appended to canonical text). Breaking changes (line removal, semantic shift) require `v2` bump and 14-day deprecation announcement per Article 15. |

#### §3.1.1.2 Exit codes

| Code | Meaning | Devkit response |
|---|---|---|
| **0** | Success — snippet emitted to stdout | Proceed with §3.1.1.3 consumption |
| **2** | Unsupported `--target` value | Devkit error: "telepty rejected target — verify devkit/telepty version compatibility" |
| **3** | Telepty version older than `--print-snippet` introduction (legacy telepty, command not found) | Detected via shell exit 127 (command not found) OR exit 3; devkit error: "telepty too old; upgrade to ≥ supported version" |
| **4** | Internal failure (snippet generation error) | Devkit refuses to write file; prints actionable error |
| **64-78** | Reserved (sysexits.h aligned) — not used by `--print-snippet` in v1 | — |

Exit codes are part of the SSOT-registered contract. Telepty MAY add new non-zero codes in `v2`; devkit MUST treat any non-zero code as fail-closed (refuse to write).

#### §3.1.1.3 Consumer side — `aigentry scaffold --integrate-telepty`

| Aspect | Specification |
|---|---|
| **Invocation pattern** | `aigentry scaffold --integrate-telepty [--target {claude\|agents\|gemini\|all}] [--dry-run] [--backup] [--uninstall]` |
| **Subprocess** | `child_process.spawn('telepty', ['init', '--print-snippet', '--target', target, '--format', 'markdown'], { stdio: ['ignore', 'pipe', 'pipe'] })` — NEVER pipe stdin (matches §3.1.1.1 row "stdin"). |
| **Timeout** | 10 seconds. On timeout devkit kills the subprocess and exits 4 (preflight failure). Reason: prevents hanging scaffold if telepty daemon is wedged. |
| **Sentinel labels (file edit)** | `<!-- BEGIN telepty setup v1 sha256=<hex8> -->` … `<!-- END telepty setup v1 -->`. Sentinel labels are devkit-owned and stable across telepty body revisions. |
| **Idempotency** | Re-running scaffold detects sentinel + identical body sha256 → no-op; different body sha256 → in-place replacement (or `--backup` writes `.bak.<timestamp>` first). |
| **Target files** | `~/CLAUDE.md`, `~/AGENTS.md`, `~/GEMINI.md`. Created if absent (mode 0644). Append-only (new section at EOF) on first run. |
| **`--dry-run`** | Prints intended diff to stdout; modifies nothing; exit 0 if would-change, exit 1 if no-change. |
| **`--backup`** | Always writes `.bak.<ISO8601>` before in-place edit. Default: backup ON for replace, OFF for first-time append. |
| **`--uninstall`** | Removes the sentinel-bracketed section. Idempotent (no-op if absent). Backup always ON. |
| **Failure mode (telepty missing/broken)** | Refuse to write. Print: `"telepty CLI not found or version mismatch — install or upgrade @dmsdc-ai/aigentry-telepty before integrating"`. Exit 4. **NEVER** write empty/stale snippet to user's `~/CLAUDE.md`. |
| **Security** | Body is treated as opaque text. Devkit MUST NOT shell-eval or substitute. Sentinel comments use `<!-- … -->` (markdown comments) — safe in CLAUDE.md/AGENTS.md/GEMINI.md (all markdown). |

#### §3.1.1.4 Conformance fixtures (SSOT registry)

Both repos MUST ship golden tests:

- **Telepty repo**: `tests/snippet-protocol/v1/golden-{claude,agents,gemini,all}.{md,json}` — fixed-output snapshot tests. Fail CI if `telepty init --print-snippet` output diverges.
- **Devkit repo**: `tests/scaffold-integrate-telepty/v1/{idempotent,replace,uninstall,timeout,missing-telepty}.spec.js` — exercise consumer logic against fixture stdin (mocked telepty subprocess).
- **SSOT entry**: `aigentry-ssot/contracts/telepty-snippet-v1.md` — references both fixture sets as conformance evidence.

#### §3.1.1.5 Migration / deprecation

When telepty introduces `telepty-snippet/v2`, the protocol guarantees:

- Telepty CLI continues emitting `v1` for ≥ 14 days post-`v2` announcement (Article 15 §SSOT).
- `--print-snippet --version v1` flag accepted to pin output version during migration.
- Devkit reads `<!-- telepty-snippet/vN BEGIN ... -->` sentinel to detect emitted version; mismatched expected/actual → warn + use what was emitted.

### §3.1.2 Context-ref Hook Protocol Specification (`[context-ref/v1]`)

**Addresses**: codex r1 condition 2 (verbatim §3.5 row 2) + codex r1 major 2 (parser library vs pure spec).

This subsection resolves codex's "library or pure spec" ambiguity for `[context-ref]` and defines the per-CLI hook installer contract owned by devkit (`aigentry scaffold install-hooks <cli>`). SSOT registry tag: `[context-ref/v1]`.

#### §3.1.2.1 Decision: PURE SPEC + REFERENCE PARSER (telepty-internal use only)

**Codex r1 §2.10.2 quote**: "Is telepty providing only a markdown grammar, a JS parser module, or a CLI parser command? If a parser library exists, is it part of telepty's public API and semver surface?"

**Resolution**:

- **Telepty publishes a normative grammar** (markdown spec + ABNF + conformance fixtures) as the **sole authoritative protocol artifact**.
- **Telepty MAY ship an internal reference parser** at `~/projects/aigentry-telepty/src/context-ref/parser.js` for telepty's own use (e.g., `telepty inject --ref` decoding) — but this parser is **explicitly NOT part of telepty's public API surface**, NOT semver-stable, NOT importable by devkit, NOT documented as a library.
- **Devkit hook scripts re-implement against the spec.** Each per-CLI hook (claude/codex/gemini) carries its own minimal parser scoped to that CLI's hook framework requirements. This avoids the dependency-path that codex flagged ("a library creates a runtime dependency path").
- **Conformance fixtures are the bridge**: telepty publishes `tests/context-ref/v1/conformance/*.json` with input prompt + expected decoded payload. Devkit hook tests run against the same fixtures.

**Why pure spec**: keeps telepty CLI as the only public surface; aligns with Article 9 (telepty independence — no devkit linkage); aligns with Article 17 (no cross-repo runtime coupling beyond CLI). The reference parser stays internal; if it ever moves to a public package, it must go through a separate ADR.

#### §3.1.2.1.1 r3 N1 Resolution — Versioned-binding policy (Option C)

**Codex r2 review §8 verbatim (top issue)**:

> "`[context-ref/v1]` cannot be both a binding r2 protocol and an open question deferred to Phase 3."

**Codex r2 review §5 N1 verbatim**:

> "**N1 — BLOCKING CONDITION: `[context-ref/v1]` is both binding and deferred.** §3.1.2 defines `[context-ref/v1]` as a normative grammar and §6.5 makes it an SSOT blocker. But §9 OQ-1 asks whether `[context-ref]` versioning should ship with this ADR or be deferred to Phase 3, and §11.3 says the versioning matrix is 'deferred to OQ-1 / Phase 3 #10.2 spec.' This is a direct contradiction. Fix by deleting OQ-1 or rewriting it to say Phase 3 may refine implementation details but cannot change the r2 `context-ref/v1` wire contract without an ADR amendment."

**r3 disposition: Option C (versioned binding) — adopted as binding policy**.

This subsection eliminates the contradiction by locking the **wire contract** of `[context-ref/v1]` BINDING NOW (this ADR), while explicitly reserving Phase 3 to ship `[context-ref/v2+]` for any expansion that requires breaking changes. There is no remaining "deferred" axis on `v1`; Phase 3 deferrals attach only to `v2+` work or to non-wire-contract implementation details (e.g., per-CLI hook UX, error-message text).

**Three-rule policy (binding from r3 acceptance)**:

1. **Wire contract LOCKED in r3** (binding, immutable without ADR amendment):
   - Grammar (§3.1.2.2 ABNF + path-token rule).
   - Storage convention (§3.1.2.2: `~/.telepty/shared/<sha256>.md`, mode 0600, owner-only).
   - Receiver detection rule (§3.1.2.2: literal `[context-ref]` prefix on first line).
   - Hook payload schema (§3.1.2.3: 6 named fields, `version: "context-ref/v1"`).
   - Versioning model: additive within v1; breaking changes require v2 + 30-day deprecation.

   These five elements are the **r3 wire contract minimum subset**. They are SSOT-registered as immutable per §6.5/§6.5.1 and may not be modified by any Phase 3 spec without a successor ADR.

2. **Phase 3 may refine ONLY non-wire-contract implementation details**:
   - Per-CLI hook UX (error message text, log verbosity, `--dry-run` output format) — these are devkit-internal and do NOT change the wire contract.
   - Conformance fixture *content* (more cases, sharper boundary tests) within the v1 schema, additive only.
   - Hook installer flag surface — additive flags only (covered by `scaffold/v1` semver-additive policy).

   Phase 3 specs that propose changes to any item in rule 1 are out of scope for #10.2 and require a `[context-ref/v2]` ADR.

3. **`[context-ref/v2+]` reserved for future expansion** (NOT in r3 scope):
   - Examples of v2-class changes: per-payload MIME type header, payload expiry timestamp, multi-file payloads, encrypted payloads, non-filesystem ref schemes (URL refs).
   - v2 dispatch rule: a successor ADR formally locks v2 wire contract; v1 remains supported for ≥30 days post-v2 acceptance per §3.1.2.2 versioning rule.
   - Forward compatibility: v1 hooks MUST gracefully ignore unknown trailing tokens on the prefix line per §3.1.2.2 — this is the seam through which v2 will introduce optional metadata without breaking v1 receivers.

**Removed in r3 (the contradiction sources)**:

- §9 OQ-1 deleted (was: "Should `[context-ref]` protocol versioning ship with this ADR or be deferred to Phase 3?"). r3 answer: ships with this ADR. No open question remains.
- §11.3 third bullet's "deferred to OQ-1 / Phase 3 #10.2 spec" language replaced with reference to this §3.1.2.1.1 versioned-binding policy.

**Why Option C, not A or B**:

- Option A (full v1 protocol now, no Phase 3 deferral) would force this ADR to specify error-message text, hook UX details, log formats — protocol grade is not implementation grade; bundling them inflates r3 scope and re-litigates Phase 3 work.
- Option B (drop "binding" claim, mark as draft) would invalidate gemini r1 ACCEPT (boundary direction depends on `[context-ref/v1]` being a stable composition contract) and would block §6.5 SSOT registration (cannot register a "draft" protocol).
- Option C preserves r2 protocol-fidelity gains (binding wire contract) while answering codex r2's contradiction concern (Phase 3 cannot mutate the locked subset). This matches codex r2 §5 N1's prescribed fix verbatim: "rewriting it to say Phase 3 may refine implementation details but cannot change the r2 `context-ref/v1` wire contract without an ADR amendment."

**SSOT enforcement**: §6.5/§6.5.1 stub for `[context-ref/v1]` MUST cite this §3.1.2.1.1 policy; any Phase 3 PR proposing wire-contract changes MUST be rejected by reviewer with citation to §3.1.2.1.1 rule 1.

#### §3.1.2.2 `[context-ref/v1]` grammar (normative, telepty README + spec doc)

```
context-ref-prompt = "[context-ref] Read " <path-token> " and use it as the source of truth for this task." LF
                     [<inline-message-body>]

path-token         = absolute-path / home-relative-path
absolute-path      = "/" *( pchar / "/" )                   ; e.g. "/Users/<user>/.telepty/shared/<sha>.md"
home-relative-path = "~/" *( pchar / "/" )                  ; e.g. "~/.telepty/shared/<sha>.md"
pchar              = unreserved / pct-encoded / sub-delims  ; per RFC 3986 §3.3
inline-message-body = arbitrary markdown; OPTIONAL; ≤ 2 KB recommended
```

**r3 N4 grammar normalization (codex r2 §5 N4 verbatim)**:

> "§3.1.2.2 says `abs-path = absolute filesystem path; '~' expansion is the receiver's responsibility`. Current telepty prompts, including this review dispatch, use `~/.telepty/shared/<sha>.md`. Clarify the grammar as `path-token = absolute-path / '~/' home-relative-path` so conformance fixtures do not reject the current production form."

**r3 disposition**: ADOPTED VERBATIM. The `path-token` rule above accepts both the absolute form (`/Users/.../shared/<sha>.md`) and the home-relative form (`~/.telepty/shared/<sha>.md`). The current production telepty `inject --ref` emit form (`~/.telepty/shared/<sha>.md`) is **conformant**; no telepty CLI change required. The `~/` expansion responsibility moves to receivers (hooks) per the receiver contract below.

**Storage** (telepty-side, on inject `--ref`):
- File: `~/.telepty/shared/<sha256>.md` (sha256 of payload body bytes)
- Permissions: `0600` (owner-only readable)
- TTL: never garbage-collected automatically; manual cleanup via `telepty clean --shared`
- Emit form: telepty CLI emits the `~/`-prefixed path-token (matches current production behavior); receivers expand.

**Receiver contract** (consumed by devkit-installed hooks):
1. Detect literal `[context-ref]` prefix on the FIRST line of the prompt.
2. Parse the path-token (between "Read " and " and use it as").
3. **Path-token expansion**: if path-token starts with `~/`, expand to `$HOME/` (POSIX `getenv("HOME")`); else use as-is. Reject path-token that is neither absolute nor `~/`-prefixed (defense-in-depth — no relative paths, no environment-variable substitution beyond `$HOME`).
4. Verify file exists, mode 0600, owned by current user (security check — refuse to read others' shared files).
5. Treat file body as the **authoritative payload**; inline message is supplementary context.

**Versioning** (binding per §3.1.2.1.1): future `[context-ref/v2]` may add metadata header inside the file (e.g., MIME type, expiry). v1 hooks MUST gracefully ignore unknown trailing tokens on the prefix line. v2 dispatch requires a successor ADR per §3.1.2.1.1 rule 3; v1 wire contract (this section) remains supported ≥30 days post-v2 acceptance.

**Conformance fixture coverage requirement (r3)**: per §3.1.2.1 fixture path `tests/context-ref/v1/conformance/`, the fixture set MUST include both `path-absolute-{golden}.json` and `path-home-relative-{golden}.json` cases. Devkit hook tests that reject the `~/`-prefixed form fail M6 (§8) and block PR merge.

#### §3.1.2.3 Hook payload schema (devkit-owned)

When a v1 hook decodes a `[context-ref]` prompt and prepares to feed it to the AI CLI, the standardized internal payload schema (NOT exposed to user) is:

```json
{
  "version": "context-ref/v1",
  "ref_path": "/abs/path/to/payload.md",
  "ref_sha256": "<hex>",
  "ref_body": "<utf-8 markdown>",
  "inline_message": "<remainder after first line>",
  "decoded_at": "<ISO8601>"
}
```

This schema is **devkit's internal hook contract**. Each per-CLI hook script materializes this object then injects it into the CLI's expected format (Claude `additionalContext`, Codex AGENTS.md preamble, Gemini settings prompt). The schema is SSOT-registered as `aigentry-ssot/contracts/context-ref-hook-payload-v1.md`.

#### §3.1.2.4 Per-CLI hook installer — `aigentry scaffold install-hooks <cli>`

| Aspect | Specification |
|---|---|
| **Invocation** | `aigentry scaffold install-hooks {claude\|codex\|gemini} [--global\|--project <path>] [--dry-run] [--uninstall]` |
| **Target files** (per CLI) | **claude**: `<scope>/.claude/settings.json` (UserPromptSubmit hook block) + `<scope>/.claude/hooks/context-ref.{sh,js}` script.<br>**codex**: `<scope>/AGENTS.md` (sentinel-managed `<!-- BEGIN context-ref/v1 -->` block describing pre-prompt loading directive).<br>**gemini**: `<scope>/.gemini/settings.json` (custom directive) + `<scope>/.gemini/hooks/context-ref.js` script. |
| **Scope resolution** | `--global` → `$HOME`. `--project <path>` → that directory. Default `--project .` (cwd). |
| **Hook handshake (telepty version awareness)** | Hook script reads `telepty --version` at install time → records minimum required telepty version in hook script header comment. At runtime, hook re-checks → if telepty too old, hook prints actionable error + falls back to passing prompt through unchanged (graceful degradation per Article 17). |
| **Idempotency** | Sentinel `<!-- BEGIN context-ref/v1 cli=<name> -->` … `<!-- END context-ref/v1 cli=<name> -->`. Re-run with no version change → no-op. Version bump → in-place replacement with `.bak.<ISO8601>`. |
| **Hook failure runtime behavior** | Hook MUST fail-open: if file path missing, permissions wrong, or parser exception → log to stderr, pass original prompt through to CLI unchanged. NEVER block AI CLI startup. |
| **Uninstall** | Sentinel-bounded removal + script file deletion. Idempotent. `aigentry scaffold install-hooks <cli> --uninstall`. |
| **Exit codes** | 0 = success / 2 = unknown CLI / 3 = scope inaccessible / 4 = hook installation failure (e.g., settings.json malformed, refused to overwrite without --force). |
| **Cross-CLI matrix coverage** | Initial v1 covers `claude`, `codex`, `gemini`. Future CLI additions are MINOR version bumps (additive) within `v1`. New CLI breaks → `v2`. |

#### §3.1.2.5 Telepty README cleanup (codex r1 condition 4 — verbatim)

**Codex r1 §2.10.2 / §6.4 (verbatim)**: "Current telepty README still names `telepty install hooks ...` as follow-up, contradicting the ADR's rejection of that subcommand."

**Mandated by this ADR**: as part of the implementation gate (§6.5), telepty README §"Integration scope" (current line ~155) MUST be amended to:

> Per-agent receiver integrations are **out of scope for telepty core**. Per-CLI hook installation lives in devkit. Run `aigentry scaffold install-hooks {claude|codex|gemini}` after installing `@dmsdc-ai/aigentry-devkit`. (Older drafts referenced `telepty install hooks …`; that command is rejected per ADR 2026-05-05-telepty-devkit-boundary.)

This is a **doc-only PR** scoped to telepty repo, sequenced before any devkit `aigentry scaffold install-hooks` implementation lands.

### §3.2 Telepty (mechanism repo) hosts

1. **Transport primitives** — `inject`, `broadcast`, `multicast`, `reply`, `allow-bridge`, `daemon` (HTTP/WS at port 3848), `list`, `attach`, UDS/TCP transport, `--submit-force`, `--submit-retry`, prompt-symbol render gate, render-gated submit (sessionStateManager).
2. **Session lifecycle primitives** — `allow --id <name> <cli>`, `session start --launch`, host detection, alias resolution (`session-routing.js`), singleton daemon control (`daemon-control.js`), TUI dashboard (`tui.js`), interactive-terminal raw mode.
3. **Protocol semantics** — `[context-ref]` syntax + decoding rules, `<id>@<host_ip>` cross-host inject pattern (#13a), retry-safe 504 reasons, busy-session CR/text queuing order.
4. **Cross-machine glue** — peer registry (`~/.telepty/peers.json` from #13b), `--persistent` + `--cwd-remote` + `--inject-after-ready` primitives (#11/#12 sub-primitives).
5. **Telepty-CLI reference docs** — `skills/telepty-{inject,broadcast,list,attach,allow,daemon,listen,rename,session}/SKILL.md` (one per telepty subcommand; functions as machine-readable man pages for telepty's own surface).
6. **Telepty-baseline snippet content** (#8 sub-primitive only) — `telepty init --print-snippet` returns the canonical text describing what telepty is and how to use it. **Telepty does not write that snippet to disk; telepty only emits it.**

**Telepty does NOT host**: cross-cutting skills (deliberation, env-manager), CLI-specific hook recipes (claude/codex/gemini), project scaffolding templates, install profiles, idempotent file-edit logic.

### §3.3 Devkit (content + scaffolding repo) hosts

1. **Cross-cutting installable skills** — `skills/{deliberation, env-manager, deliberation-executor, npm-release, project-ops, telepty-deliberate, ...}` (current 11 entries) and any future cross-CLI skill.
2. **Project / global file scaffolding** — idempotent sentinel-managed appenders for `~/CLAUDE.md`, `~/AGENTS.md`, `~/GEMINI.md`; project-level `CLAUDE.md` + `.claude/settings.json` generation.
3. **Per-CLI hook integrations** — claude/codex/gemini-specific hook installation, settings.json patches, `[context-ref]` agent-side parsing recipes.
4. **Agent-specific recipes** — anything that requires knowledge of a specific AI CLI's bootstrap UI, prompt symbol, settings format, or update flow (e.g., #12 ai-session bootstrap-UI dismissal logic).
5. **Install profiles + lifecycle** — `installer-manifest.json`, `aigentry setup`, `aigentry status`, `aigentry doctor`, `aigentry up`, module adapters.
6. **Orchestrator / multi-session bootstrap infrastructure** — `bin/open-session.sh` (already there), `aigentry session create`, kitty/tmux tab orchestration, telepty allow + AI CLI spawn composition.
7. **Templates** — `templates/AGENTS.md`, adapter templates, CLAUDE.md skeletons.

### §3.3.1 Scaffold Contract Specification (`scaffold/v1`)

**Addresses**: codex r1 condition 3 (verbatim §3.5 row 3) + codex r1 major 3 (bidirectional CLI coupling).

This subsection defines the bilateral contract between `telepty session start --scaffold` (opt-in shim) and `aigentry scaffold --project <cwd>` (devkit owner of project file generation). SSOT registry tag: `scaffold/v1`. Codex flagged this as the **highest coupling point** because telepty optionally calls devkit; the spec below enforces "best-effort preflight, warn-and-continue" semantics codex recommended.

#### §3.3.1.1 Decision: opt-in via flag (NOT env var)

| Choice | Resolution | Rationale |
|---|---|---|
| Flag or env var? | **Flag**: `telepty session start --scaffold` | Discoverability (flag visible in `--help`); explicit per-invocation control; env vars create hidden global state that violates Article 1 (lightweight, predictable). |
| Bilateral or unilateral? | **Unilateral preflight**: telepty invokes devkit before launching session terminal. Devkit does NOT query telepty session state. | Matches codex condition 3: "best-effort preflight." Devkit treats the call as a regular `aigentry scaffold --project <cwd>` invocation indistinguishable from manual user invocation. |
| Communication channel | **Argv only**: `aigentry scaffold --project <abs-cwd> [--cli <claude\|codex\|gemini>]`. Telepty MAY pass `--cli` if known. NO env vars, NO stdin payload. | POSIX-portable, deterministic, easy to debug (the user can copy-paste the same command). |

#### §3.3.1.2 Ordering semantics (codex r1 §2.10.3 quote: "Does --scaffold run before terminal launch or inside the launched session?")

**Resolution**: **BEFORE** terminal launch, blocking with bounded timeout.

```
telepty session start --launch --scaffold --id <name> <cmd>
  │
  ├─ 1. PATH detection: command -v aigentry  (≤ 50ms)
  │     └─ if absent → skip scaffold, print info note, proceed to step 4
  │
  ├─ 2. Resolve <cwd>: telepty's process cwd at session-start invocation time
  │     (NOT remote cwd, NOT the future terminal's cwd)
  │
  ├─ 3. Subprocess: aigentry scaffold --project <cwd> [--cli <inferred>]
  │     ├─ stdout: tee to telepty stdout (user sees scaffold progress)
  │     ├─ stderr: tee to telepty stderr (user sees scaffold warnings)
  │     ├─ TIMEOUT: 30 seconds wall clock
  │     ├─ exit 0  → continue to step 4
  │     ├─ exit non-0 → warn-and-continue (proceed to step 4 with warning printed)
  │     └─ timeout → kill subprocess, warn-and-continue
  │
  └─ 4. Terminal launch (existing telepty session-start logic)
```

**Why before**: the user expects `~/CLAUDE.md` and `.claude/settings.json` to exist when the AI CLI process starts; running scaffold inside the session race-conditions against the AI CLI's own bootstrap reads.

**Why bounded timeout**: prevents a wedged devkit (e.g., npm postinstall hung on slow disk) from hanging telepty session-start indefinitely.

#### §3.3.1.3 Failure modes — best-effort preflight (codex r1 §2.10.3, §4.2 verbatim resolution)

**Codex r1 §2.10.3 quote**: "Does a non-zero `aigentry scaffold --project` abort launch, warn and continue, or prompt? What timeout prevents telepty from hanging on a devkit scaffold bug?"

| Scenario | Telepty behavior |
|---|---|
| `command -v aigentry` not found | Skip scaffold. Print: `"info: aigentry CLI not on PATH — skipping project scaffold; install @dmsdc-ai/aigentry-devkit to enable"`. Proceed to launch (Article 17 fallback). |
| `aigentry scaffold` exits 0 | Proceed to launch. No warning. |
| `aigentry scaffold` exits non-zero | Print: `"warn: aigentry scaffold --project failed (exit=<N>) — see stderr above. Launching session anyway."`. Proceed to launch. |
| Timeout (30s exceeded) | Kill subprocess (SIGTERM, then SIGKILL after 5s). Print: `"warn: aigentry scaffold --project timed out — proceeding without scaffold."`. Proceed to launch. |
| User wants strict mode (FUTURE, not v1) | Reserved flag `--scaffold-strict` for v2 — abort launch on scaffold failure. **Out of scope for v1.** |
| Devkit scaffold prompts interactively | Devkit `aigentry scaffold` MUST be non-interactive (auto-accept defaults, fail on missing required input rather than blocking on tty). Telepty assumes non-interactivity; if devkit ever prompts, it's a devkit bug. |

This matches codex condition 3 verbatim: "warn-and-continue on devkit failure unless the user passes a future strict flag."

#### §3.3.1.4 Devkit `aigentry scaffold --project` shape (NEW CLI surface — codex r1 minor 5)

**Codex r1 §6.5 verbatim**: "devkit lacks an existing scaffold command, so Phase 3 needs a small CLI-surface spec first."

This ADR locks the CLI surface shape; full implementation spec is Phase 3 (`aigentry-architect-bootstrap-spec` per §6.3). Locked surface:

```
aigentry scaffold --project <cwd>           # generate project CLAUDE.md + .claude/settings.json
aigentry scaffold --integrate-telepty       # §3.1.1 — append telepty snippet to ~/CLAUDE.md etc.
aigentry scaffold install-hooks <cli>       # §3.1.2 — install per-CLI hooks
aigentry scaffold --uninstall {project|integrate-telepty|install-hooks <cli>}
                                            # idempotent removal of any of the above
```

All four take optional `--dry-run` and `--backup`. All emit on stdout the actions taken (one line per file touched, machine-parseable: `<verb> <path>`).

Exit codes uniform across all subcommands (matching §3.1.1.2 + §3.1.2.4): 0 success / 2 invalid argv / 3 scope inaccessible / 4 internal failure.

#### §3.3.1.5 What telepty MUST NOT do

To prevent codex's "circular dependency risk" (anti-pattern 1, §11.4):

- Telepty CI MUST pass on a clean machine without devkit installed (Article 9 / §8 M3).
- Telepty's core test suite MUST NOT invoke `aigentry scaffold` for any non-`--scaffold` codepath.
- `--scaffold` opt-in MUST remain a convenience path; `telepty session start` (no flag) is the canonical primitive and bears no devkit coupling.
- Telepty docs MUST describe `--scaffold` as optional sugar, not as the recommended path.

#### §3.3.1.6 Conformance fixtures

- **Telepty**: `tests/scaffold-shim/v1/{path-not-found,exit-zero,exit-nonzero,timeout,interactive-prompt}.spec.js` — exercise telepty's preflight wrapper against mocked `aigentry` subprocess.
- **Devkit**: `tests/scaffold-project/v1/{fresh,reapply,uninstall,unknown-cli-flag}.spec.js` — exercise scaffold logic against fixture cwd directories.
- **SSOT entry**: `aigentry-ssot/contracts/scaffold-v1.md`.

### §3.4 Cross-cutting issues — concrete placement (HARD COMMITMENT)

| Issue / artifact | Mechanism part (telepty) | Content / install part (devkit) | Composition contract |
|---|---|---|---|
| **#8 telepty init** for `~/CLAUDE.md` etc. | `telepty init --print-snippet` emits canonical telepty-baseline snippet text on stdout (telepty knows what it is). No file I/O. | `aigentry scaffold --integrate-telepty` performs the idempotent `<!-- BEGIN telepty setup -->`…`<!-- END -->` sentinel append, with `--dry-run`, `--backup`, `--uninstall`. Calls `telepty init --print-snippet` to fetch content. | telepty exposes stable stdout contract (versioned snippet); devkit consumes it. **No file editing in telepty.** |
| **#10.2 telepty install hooks {claude\|codex\|gemini}** | Telepty owns the `[context-ref]` protocol spec (parsing rules, escape, body format) — documented in telepty README + `skills/telepty-inject/SKILL.md`. | Devkit owns per-CLI hook installation: `aigentry scaffold install-hooks <cli>`. Devkit ships the agent-specific hook scripts that decode `[context-ref]` for each CLI's hook framework. | **r2 resolution (§3.1.2.1)**: telepty publishes a normative grammar (PURE SPEC) as the sole authoritative protocol artifact. Telepty MAY ship an internal reference parser at `src/context-ref/parser.js` for telepty's own use, but it is explicitly NOT public API and NOT importable by devkit. Devkit hook scripts re-implement against the spec + shared conformance fixtures. **`telepty install hooks` subcommand is rejected.** |
| **#3 project CLAUDE.md + .claude/settings.json scaffold** | Telepty's `session start --launch` MAY accept opt-in `--scaffold` flag. If devkit is detected (`command -v aigentry`), telepty execs `aigentry scaffold --project <cwd>` and proceeds. If devkit is missing, telepty proceeds with bare session — Article 17 (무의존). | Devkit owns all template content (CLAUDE.md, settings.json) and the file-generation logic in `aigentry scaffold`. | Opt-in invocation via `--scaffold`; devkit detection via PATH only. **No hard dependency.** |
| **`skill-installer.js`** (currently telepty) | — | Logically devkit (per §3.3.3). | **Grandfathered**: stays in telepty for now (§6.2). Migration deferred to Phase 7+ audit (§6.4). New similar code goes to devkit. |
| **`bin/open-session.sh`** (orchestrator → devkit symlink) | — | Devkit (correct under boundary). | No change. Symlink behavior preserved. |
| **`aigentry session create` (devkit) vs `telepty session start --launch` (telepty)** | Telepty owns the **lower-level session-start primitive** (telepty allow + kitty tab). | Devkit's `aigentry session create` is the **higher-level orchestrated workflow** (multi-session `aigentry.yml`-driven, scaffolding, role-folder creation). | Both kept; devkit composes telepty primitives. Recommend documenting in next devkit AGENTS.md edit (NOT this ADR). |
| **`skills/telepty-*/SKILL.md`** (10 files in telepty) | Reference documentation for telepty's own CLI commands → stays in telepty (mechanism docs, akin to man pages). Telepty-independence (Article 9) requires telepty users find these without devkit installed. | Devkit may **mirror or link** them in install profiles, but cannot be the canonical source. **Freshness rule (codex r1 minor 2)**: any devkit copy MUST carry a `Source: telepty@<version> sha256=<hex>` header at top; devkit install profile rebuilds copies at install time from telepty package; CI check fails if copy drifts > 1 minor version behind telepty. | Telepty = source of truth; devkit copies are version-pinned and freshness-gated. |
| **Future installable cross-cutting skills** (e.g., new `telepty-ai-session` skill from #12) | — | Devkit `skills/`. | Default rule: any new SKILL.md not describing a telepty-CLI subcommand → devkit. |

### §3.5 Codex r1 conditions — verbatim quotes + integration mapping

**HARD RULE compliance**: this subsection quotes codex r1 review (`~/projects/aigentry-devkit/docs/reports/2026-05-05-boundary-adr-codex-review.md`, commit `e0b528b`) §7 verbatim before integration.

| # | Codex r1 condition (verbatim §7) | r2 integration | Section |
|---|---|---|---|
| 1 | "**Contract spec gate**: before #8/#10.2/#3 implementation, publish SSOT entries and conformance fixtures for `telepty-snippet/v1`, `[context-ref/v1]`, `telepty list --json`, and `--scaffold`." | INTEGRATED — full protocol specs added; SSOT registration mandated as pre-implementation gate (§6.5 strengthened to BLOCKER for Phase 3). | §3.1.1, §3.1.2, §3.3.1, §6.5 |
| 2 | "**README conflict cleanup**: patch telepty README to remove `telepty install hooks ...` as a proposed receiver-side command and point to devkit-owned `aigentry scaffold install-hooks <cli>`." | INTEGRATED — telepty README cleanup mandated as separate doc-only PR; sequenced before devkit hook implementation. | §3.1.2.5 |
| 3 | "**Scaffold behavior spec**: define `aigentry scaffold` command shape, file targets, sentinels, dry-run/backup/uninstall behavior, exit codes, and tests before coding." | INTEGRATED — full shape spec; 4 subcommand surface; uniform exit codes; conformance fixtures required. | §3.3.1.4 |
| 4 | "**Session launch boundary audit**: decide whether `open-session.sh` and `aigentry session create` should keep direct terminal launch logic or delegate more of it to telepty primitives." | DEFERRED to §6.6 Phase 7+ audit (out-of-scope for r2 protocol-grade contracts; r2 hard rule "NO new boundary changes"). Audit scope locked. | §6.6 |
| 5 | "**Legacy exception policy**: record `skill-installer.js` as grandfathered-only, with migration criteria and a ban on new installer feature expansion in telepty." | INTEGRATED — explicit "no new feature expansion except bugfixes" rule + migration trigger criteria. | §6.2 |

#### §3.5.1 Codex r1 majors (5) — integration mapping

| # | Major (verbatim §6) | r2 integration |
|---|---|---|
| 1 | "`telepty init --print-snippet` lacks protocol-grade stdout/stderr/exit-code/version details." | RESOLVED §3.1.1 |
| 2 | "#10.2 leaves 'parser library or pure spec' undecided; that is a real boundary/dependency decision." | RESOLVED §3.1.2.1 (decision: pure spec + telepty-internal reference parser, NOT public API) |
| 3 | "`telepty session start --scaffold` creates bidirectional CLI coupling without enough failure/timeout/ordering semantics." | RESOLVED §3.3.1.2 + §3.3.1.3 |
| 4 | "Current telepty README still names `telepty install hooks ...` as follow-up, contradicting the ADR's rejection of that subcommand." | RESOLVED §3.1.2.5 (mandatory README PR) |
| 5 | "`open-session.sh`, `aigentry session create`, and `telepty session start --launch` overlap enough to risk duplicate terminal/session runtime logic." | DEFERRED §6.6 (boundary stable per r2 hard rule; audit scoped) |

#### §3.5.2 Codex r1 minors (5) — integration mapping

| # | Minor (verbatim §6) | r2 integration |
|---|---|---|
| 1 | "The phrase 'content vs mechanism' should be refined to cover telepty-owned reference content and devkit-owned provisioning mechanisms." | RESOLVED §3.1 (4-rule sharpening adopted verbatim from codex §1) |
| 2 | "Devkit skill mirroring/linking needs a freshness/version rule." | RESOLVED §3.4 row "skills/telepty-*" amended (§3.4 below) |
| 3 | "`skill-installer.js` should be documented as a legacy exception with no new feature expansion." | RESOLVED §6.2 strengthened |
| 4 | "Verification metric M1 ('next 5 PRs') is too slow for known current conflicts; add immediate doc/API checks." | RESOLVED §8 — added M0 (immediate, day-of-acceptance gate) |
| 5 | "Phase 3 is unblocked, but devkit lacks an existing scaffold command, so Phase 3 needs a small CLI-surface spec first." | RESOLVED §3.3.1.4 (CLI surface shape locked in this ADR) |

#### §3.5.3 Codex r1 anti-patterns (3) — addressed

See §11.4 for full treatment. Summary:

| # | Anti-pattern (verbatim §4) | r2 disposition |
|---|---|---|
| 1 | Circular dependency risk | ADDRESSED — §3.3.1.5 telepty MUST NOT require devkit; M3 verification |
| 2 | Distributed monolith risk (session launching) | DEFERRED to §6.6 audit; explicitly waived for r2 with rationale |
| 3 | Coordination overhead (every contract needs version + fixture + repos + deprecation) | ADDRESSED — every protocol surface (§3.1.1, §3.1.2, §3.3.1) ships version tag + conformance fixtures + owning/consuming repos + migration policy |

#### §3.5.4 Codex r2 review — verbatim quotes + r3 integration mapping

**HARD RULE compliance**: this subsection quotes the codex r2 re-review (`~/projects/aigentry-devkit/docs/reports/2026-05-05-boundary-adr-r2-codex-review.md`, commit `72f45b9`) §5 (new issues), §6 (gates), §8 (top issue) verbatim before integration.

| # | Codex r2 finding (verbatim) | r3 disposition | Section |
|---|---|---|---|
| N1 | "**N1 — BLOCKING CONDITION: `[context-ref/v1]` is both binding and deferred.** §3.1.2 defines `[context-ref/v1]` as a normative grammar and §6.5 makes it an SSOT blocker. But §9 OQ-1 asks whether `[context-ref]` versioning should ship with this ADR or be deferred to Phase 3, and §11.3 says the versioning matrix is 'deferred to OQ-1 / Phase 3 #10.2 spec.' This is a direct contradiction. Fix by deleting OQ-1 or rewriting it to say Phase 3 may refine implementation details but cannot change the r2 `context-ref/v1` wire contract without an ADR amendment." | RESOLVED — Option C (versioned binding) adopted. `[context-ref/v1]` wire contract LOCKED in r3; v2+ reserved for Phase 3 expansion via successor ADR. OQ-1 removed. §11.3 deferral language replaced with reference to versioned-binding policy. | §3.1.2.1.1; §9 r3 cleanup note; §11.3 |
| N2 | "**N2 — Stale '4 surfaces' language conflicts with §3.6.** §3.6 says six surfaces. §4.4, §11.1, and §11.1's surrounding bullets still say '4 surfaces' / 'four contract surfaces' and even 'all already CLI-stable.' That is stale r1 text: `aigentry scaffold` and `scaffold-shim/v1` are new surfaces, not already stable." | RESOLVED — all "4 surfaces" / "four contract surfaces" / "all already CLI-stable" occurrences updated to "6 surfaces" with explicit 3-stable + 3-new split per §3.6 stability provenance table. | §3.6 (stability provenance table); §4.4; §11.1 |
| N3 | "**N3 — `telepty list --json` accountability is not yet protocol-grade.** Prior C1 named `telepty list --json`. r2 registers it as a surface, but §3.6 lists its conformance fixtures as '(existing)' and does not point to a schema. If it is a Phase 3 blocking surface, it needs a concrete SSOT schema path or an explicit statement that it is outside #8/#10.2/#3 dispatch scope." | RESOLVED — promoted to `telepty-list-json/v1` with concrete schema (envelope + 11 fields with semantics) + 4 fixture file paths + SSOT registry path. §3.6 accountability row + §3.6.1 schema body. | §3.6 (row promoted); §3.6.1 (new schema section) |
| N4 | "**N4 — `[context-ref/v1]` path grammar should align with actual prompts.** §3.1.2.2 says `abs-path = absolute filesystem path; '~' expansion is the receiver's responsibility`. Current telepty prompts, including this review dispatch, use `~/.telepty/shared/<sha>.md`. Clarify the grammar as `path-token = absolute-path / '~/' home-relative-path` so conformance fixtures do not reject the current production form." | ADOPTED VERBATIM — grammar now defines `path-token = absolute-path / home-relative-path`; receiver contract specifies `~/` → `$HOME/` expansion; conformance fixture set MUST include both forms (M6 gate). | §3.1.2.2 (grammar + receiver contract + fixture coverage requirement) |
| §6 (Phase 2/3 readiness) | "Readiness call: **not immediate dispatch-ready until §6.5/M0 are satisfied and N1 is fixed**. After those are done, the three sub-dispatches are cleanly referenceable and do not need another broad boundary ADR." | RESOLVED — §6.5.1 r3 testable readiness gates added: 9 named gates G1-G9, each with concrete artifact path + one-line shell verification command + pass criterion + canonical M0 audit script; orchestrator runs script before dispatching #8/#10.2/#3. | §6.5.1; §8 M0 metric updated to reference §6.5.1 audit script |
| §8 (top issue) | "`[context-ref/v1]` cannot be both a binding r2 protocol and an open question deferred to Phase 3." | RESOLVED via §3.1.2.1.1 (Option C). Absence of contradiction is the binding test: r3 has no remaining "deferred to Phase 3" language attached to `[context-ref/v1]`. | §3.1.2.1.1; §9; §11.3 |
| §7 condition 1 | "Before status flip or Phase 3 dispatch, resolve the `[context-ref/v1]` contradiction by removing/reframing OQ-1 and §11.3 deferral language." | RESOLVED — OQ-1 deleted (replaced with explicit r3 cleanup note in §9); §11.3 deferred-language bullet replaced with §3.1.2.1.1 reference. | §3.1.2.1.1; §9; §11.3 |
| §7 condition 2 | "Before Phase 3 dispatch, complete §6.5/M0 gates: SSOT stubs for all six surfaces; telepty README cleanup; telepty AGENTS legacy exception; `skill-installer.js` legacy header." | RESOLVED — all 4 condition items mapped to G1-G6 + G7 + G8 + G9 in §6.5.1; M0 audit script verifies all in one run. | §6.5.1 |
| §7 condition 3 | "Before Phase 3 dispatch, tighten §3.6 for `telepty list --json` with a concrete schema/fixture reference or explicitly remove it from the #8/#10.2/#3 blocking set." | RESOLVED — kept in blocking set + tightened with full schema (§3.6.1) + 4 concrete fixture paths + SSOT path locked. | §3.6.1; §3.6 row updated |
| §7 condition 4 | "Before conformance fixtures freeze, clarify `[context-ref/v1]` path grammar to accept both absolute and `~/` forms." | RESOLVED — §3.1.2.2 grammar updated (`path-token = absolute-path / home-relative-path`); conformance fixture set MUST cover both forms; M6 gate enforces. | §3.1.2.2 |

#### §3.5.5 r3 prior-fix re-verification (codex r2 §1-§3 re-attestation)

Per dispatch hard rule: re-verify 1 WAIVED-OK condition, 1 deferred major, and 1 waived anti-pattern remain defensible after r3 changes. Each item below cites the codex r2 attestation and provides the r3 defensibility test.

| Item | Codex r2 attestation | Codex r2 quote | r3 re-verification | Status |
|---|---|---|---|---|
| C4 (session launch boundary audit) | WAIVED-OK | "This is not fully integrated despite the r2 summary language. The ADR does not decide the launch boundary; it scopes and time-boxes a successor audit. That is acceptable for r2 because the unresolved overlap does not block the #8 / #10.2 / #3 protocol split, and §6.6 has real triggers, a 90-day forced audit, and concrete deliverables." | r3 made no boundary changes (hard rule: NO new boundary placement changes). §6.6 scope, 4 trigger criteria (T1-T4 incl. 90-day T4), and 3 deliverables remain unchanged. r3 specifically does NOT touch session-launch ownership; only protocol-grade specs and gate testability changed. | DEFENSIBLE — waiver rationale unchanged after r3; r3 protocol-grade work does not interact with §6.6 scope |
| Major 5 (overlap among `open-session.sh`, `aigentry session create`, `telepty session start --launch`) | DEFERRED-ACCEPTABLE | "DEFERRED-ACCEPTABLE. §6.6 scope lock is sufficient for r2; forcing it into r3 would expand r2 from protocol-fidelity review into a new boundary decision." | r3 honors the same hard rule — protocol-grade specification only. The overlap analysis remains scoped to §6.6 audit. r3's `scaffold-shim/v1` and `[context-ref/v1]` work does not redefine session-launch ownership. | DEFENSIBLE — codex r2 explicitly warned that bundling this into r3 would invalidate r2 framing; r3 honors that warning |
| AP2 (Distributed monolith risk — session launching) | WAIVED-RATIONALE-DEFENSIBLE | "§6.6 is a real escape hatch, not just kicking the can. It names the four artifacts to audit, gives dispatch triggers, includes a 90-day forced trigger, and requires a successor ADR plus migration plan. The risk remains, but it is not introduced by r2 and should not block the three Phase 3 protocol dispatches." | r3 §6.6 (scope + 4 triggers + 3 deliverables) is unchanged. T4 (90-day forced trigger) remains. r3 does not introduce new session-launch coupling — `scaffold-shim/v1` is a preflight wrapper, NOT a session-launch primitive (§3.3.1.2 ordering: scaffold runs BEFORE terminal launch; existing session-launch logic is untouched). | DEFENSIBLE — waiver rationale unchanged; r3 explicitly does not introduce new session-launch logic |

**Cross-cutting attestation**: gemini r1 ACCEPT (commit `3aa83d3`) was based on industry alignment of the boundary direction. r3 changes are confined to (a) protocol-fidelity (`[context-ref/v1]` wire contract lock), (b) accountability (`telepty-list-json/v1` schema), (c) gate testability (§6.5.1 shell verification). None of (a)-(c) alters boundary direction. **gemini r1 ACCEPT is preserved by r3** by construction (hard rule "NO new boundary placement changes" honored).

### §3.6 The composition contract (telepty ⇄ devkit)

To make the split actionable, telepty exposes a **stable stdout/CLI contract** that devkit consumes. Devkit may not poke at telepty internals; telepty may not assume devkit is installed.

| Contract surface | Producer | Consumer | Spec ref | Stability tag |
|---|---|---|---|---|
| `telepty init --print-snippet` (stdout sentinel-bracketed markdown + exit codes 0/2/3/4) | telepty | devkit `aigentry scaffold --integrate-telepty` | §3.1.1 | `telepty-snippet/v1` (semver-stable; v2 requires 14d announce per Article 15) |
| `[context-ref]` protocol grammar (ABNF + receiver contract) | telepty README + spec doc | devkit hook scripts (per CLI) | §3.1.2 | `[context-ref/v1]` (additive within v1; v2 requires deprecation cycle) |
| `aigentry scaffold` CLI surface shape (4 subcommands + uniform exit codes) | devkit | telepty `--scaffold` shim + manual users | §3.3.1.4 | `scaffold/v1` (additive within v1) |
| `telepty session start --scaffold` opt-in shim semantics (preflight, 30s timeout, warn-and-continue) | telepty | (calls devkit) | §3.3.1.2 + §3.3.1.3 | `scaffold-shim/v1` |
| `telepty list --json` schema (`telepty-list-json/v1`) | telepty | devkit `aigentry session create` / `aigentry up` + orchestrator + aterm | §3.6.1 (r3 — concrete schema + fixtures) | `telepty-list-json/v1` (semver-additive within v1; new optional fields allowed; field removal/rename = v2 + 14d announce) |
| `command -v aigentry` (PATH detection) | OS | telepty `session start --scaffold` (opt-in path) | §3.3.1.3 | POSIX baseline |

**Six surfaces** (up from 4 in r1 — codex r1 condition 1 demanded explicit specification). All MUST be SSOT-registered before Phase 3 implementation per §6.5 (BLOCKER gate). Anything else implies a boundary violation.

**Surface stability provenance (r3 N2 cleanup)** — codex r2 §5 N2 verbatim:

> "**N2 — Stale '4 surfaces' language conflicts with §3.6.** §3.6 says six surfaces. §4.4, §11.1, and §11.1's surrounding bullets still say '4 surfaces' / 'four contract surfaces' and even 'all already CLI-stable.' That is stale r1 text: `aigentry scaffold` and `scaffold-shim/v1` are new surfaces, not already stable."

**r3 disposition**: ADOPTED. The 6 surfaces split into existing-stable (3) + newly-specified-by-r2 (3):

| Surface | Provenance | Stability status as of r3 acceptance |
|---|---|---|
| `telepty list --json` (now `telepty-list-json/v1`) | EXISTING (pre-r1) | CLI-stable; r3 formalizes schema + fixtures (see §3.6.1) |
| `command -v aigentry` | EXISTING (POSIX) | OS contract; trivially stable |
| `[context-ref/v1]` grammar | EXISTING (pre-r1, telepty 0.3.4 ships `inject --ref`) | r3 formalizes wire contract per §3.1.2.1.1 (binding) |
| `telepty-snippet/v1` | NEW (r2 §3.1.1) | Specified r2; CLI surface to be implemented in Phase 3 #8 |
| `scaffold/v1` (devkit `aigentry scaffold` shape) | NEW (r2 §3.3.1.4) | Specified r2; CLI surface to be implemented in Phase 3 #8/#10.2/#3 |
| `scaffold-shim/v1` (telepty `--scaffold` preflight) | NEW (r2 §3.3.1.2-3) | Specified r2; telepty wrapper to be implemented in Phase 3 #3 |

Stale "all already CLI-stable" claim removed from §4.4 r3; bullets updated to reflect 3 stable + 3 newly-specified split.

#### §3.6.1 `telepty-list-json/v1` schema (r3 N3 promotion — codex r2 §5 N3 verbatim)

**Codex r2 §5 N3 verbatim**:

> "**N3 — `telepty list --json` accountability is not yet protocol-grade.** Prior C1 named `telepty list --json`. r2 registers it as a surface, but §3.6 lists its conformance fixtures as '(existing)' and does not point to a schema. If it is a Phase 3 blocking surface, it needs a concrete SSOT schema path or an explicit statement that it is outside #8/#10.2/#3 dispatch scope."

**r3 disposition**: PROMOTED to protocol-grade. The schema below is now the v1 wire contract; concrete fixture paths replace the "(existing)" placeholder; SSOT registration is required as a §6.5/§6.5.1 gate item.

**Schema** (NDJSON-equivalent JSON array, one object per allowed session):

```json
{
  "id": "<allow-id>",
  "host": "<hostname-or-alias>",
  "host_ip": "<ipv4-or-ipv6-or-empty>",
  "cli": "claude|codex|gemini|<other>",
  "status": "ready|busy|disconnected|unknown",
  "pid": <int-or-null>,
  "tty": "<tty-path-or-empty>",
  "started_at": "<ISO8601-or-empty>",
  "last_active_at": "<ISO8601-or-empty>"
}
```

Top-level envelope when invoked `telepty list --json`:

```json
{
  "version": "telepty-list-json/v1",
  "telepty_version": "<semver>",
  "sessions": [ <session-object>, ... ]
}
```

**Versioning location (r4 — codex r3 Condition 2 disambiguation)**: `version` is an **envelope-only** field. Session objects do **NOT** carry a separate `version` field. Total schema surface = envelope + 11 fields exactly (2 envelope metadata fields `version` + `telepty_version`, plus the `sessions` array carrier, plus 9 fields per session-object element). Implementers MUST treat any `sessions[].version` literal in legacy producer output as an unknown additional field and ignore it (forward-compatibility rule below).

**Field semantics**:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | string | yes | Wire contract version tag; v1 frozen by r3. |
| `telepty_version` | semver string | yes | Producer telepty version; consumers MAY use to gate behavior on minimum version. |
| `sessions` | array | yes | Allowed sessions known to telepty daemon at invocation time. |
| `sessions[].id` | string | yes | Allow-ID per `telepty allow --id <name>`. |
| `sessions[].host` | string | yes | Hostname or alias per peer registry. Empty string for local. |
| `sessions[].host_ip` | string | optional | IPv4/IPv6 address per `<id>@<host_ip>` cross-host pattern (#13a). Empty string when unknown. |
| `sessions[].cli` | string | yes | AI CLI tag; consumers may match for capability gating. |
| `sessions[].status` | string | yes | One of `ready` / `busy` / `disconnected` / `unknown`. |
| `sessions[].pid` | int or null | optional | OS PID when known; null otherwise. |
| `sessions[].tty` | string | optional | TTY path when allocated; empty string otherwise. |
| `sessions[].started_at` | ISO8601 string | optional | Session start time. Empty string when unknown (legacy entries). |
| `sessions[].last_active_at` | ISO8601 string | optional | Last activity timestamp; empty string when unknown. |

**Versioning**: additive within v1 (new optional fields allowed; existing field removal or type/semantic change requires v2 + 14-day announce per Article 15). v1 consumers MUST tolerate unknown additional fields by ignoring them.

**Fixture paths** (locked by r3 — referenced by §6.5.1 testable gate):

- `~/projects/aigentry-telepty/tests/list-json/v1/golden-empty.json` — zero allowed sessions.
- `~/projects/aigentry-telepty/tests/list-json/v1/golden-single-session.json` — one local session.
- `~/projects/aigentry-telepty/tests/list-json/v1/golden-multi-session.json` — three sessions, mixed status.
- `~/projects/aigentry-telepty/tests/list-json/v1/golden-host-aliased.json` — cross-host `<id>@<host_ip>` entries.

**Fixture status (r4 — codex r3 Condition 3)**: These 4 fixture paths are **TBD Phase 3 deliverables**. **Owner**: aigentry-telepty. **Merge-blocked by M6** (and §6.5.1 G5 testable gate by reference). Until M6 closes, the SSOT path is registered but the fixtures are not yet materialized — readers MUST NOT interpret the absence of these files as a defect; they are **intentionally deferred** to Phase 3 implementation under aigentry-telepty ownership.

**SSOT registry path** (locked by r3): `~/projects/aigentry-ssot/contracts/telepty-list-json-v1.md` — references the four fixture files above as conformance evidence.

**Consumer contract**: devkit `aigentry session create` / `aigentry up` and orchestrator / aterm parse using this schema. Consumers MUST treat `version != "telepty-list-json/v1"` as fatal (refuse to proceed); consumers MUST ignore unknown additional fields (forward compatibility).

**Per-surface accountability table (codex r1 anti-pattern 3 — coordination overhead):**

| Surface | Owning repo | Consuming repo(s) | Conformance fixtures | Deprecation policy |
|---|---|---|---|---|
| `telepty-snippet/v1` | aigentry-telepty | aigentry-devkit | telepty `tests/snippet-protocol/v1/` + devkit `tests/scaffold-integrate-telepty/v1/` | 14-day pre-announce + dual-emit during overlap |
| `[context-ref/v1]` | aigentry-telepty | aigentry-devkit (hooks) | telepty `tests/context-ref/v1/conformance/` shared with devkit hook tests | 30-day deprecation; receiver hooks gracefully ignore unknown trailing tokens |
| `scaffold/v1` (CLI shape) | aigentry-devkit | aigentry-telepty (`--scaffold` shim) + manual users | devkit `tests/scaffold-{project,integrate-telepty,install-hooks}/v1/` | semver per devkit release |
| `scaffold-shim/v1` (telepty's preflight wrapper) | aigentry-telepty | (internal — telepty session-start) | telepty `tests/scaffold-shim/v1/` | tied to telepty release; no breaking change without 14d announce |
| `telepty-list-json/v1` (r3 promoted) | aigentry-telepty | aigentry-devkit + orchestrator + aterm | telepty `tests/list-json/v1/{golden-empty,single-session,multi-session,host-aliased}.json` (path locked r3) | semver-additive within v1; field removal/rename = v2 + 14d announce per Article 15 |
| `command -v aigentry` | POSIX | telepty | n/a | n/a (OS contract) |

---

## §4 Alternatives Considered

§5.3 INVARIANT mandate: minimum 2 alternatives + tradeoff analysis. Three alternatives below; the chosen approach is §3.

### §4.1 Alternative A: Status quo — case-by-case, no boundary rule

- **Description**: Continue current ad-hoc placement. Each new artifact debated in its own dispatch.
- **Pros**:
  - Zero migration cost.
  - Maximum per-decision flexibility.
- **Cons**:
  - Triage `30abd73` shows three concurrent issues (#8/#10.2/#3) blocked on this question — case-by-case has **already failed** to resolve this efficiently.
  - Future PRs continue to violate Article 3 (역할) and Article 4 (경계) ad libitum.
  - SSOT (Article 15) becomes meaningless without a register-able rule.
  - Cumulative drift makes a future boundary lock harder (more grandfathering).
- **Eviction reason**: The trigger of this ADR (`30abd73` Phase 2.5 §5 Q3) is itself proof status quo is not viable; user-decision Q3 explicitly demands a rule.

### §4.2 Alternative B: Merge telepty + devkit into one repo

- **Description**: Eliminate boundary by collapsing both into a single npm package (e.g., `@dmsdc-ai/aigentry-platform`).
- **Pros**:
  - No coupling problem because no boundary.
  - One install, one version, one CHANGELOG.
- **Cons**:
  - **Article 1 violation (경량)**: telepty is currently ~3.5k LOC across cli.js + daemon.js + tui.js — installing it pulls 11 cross-cutting skills + bash installer + adapter declarations the user may not need.
  - **Article 9 violation (독립)**: telepty is supposed to work without aigentry/orchestrator/devkit (`CONSTITUTION.md` §3 표 column 4: "telepty는 orchestrator 없이도 동작한다" — and by extension devkit). Merging breaks the npm-only telepty install path that public users rely on.
  - **Article 10 violation (원클릭)**: forces devkit-bundle install on users who only want PTY multiplexing.
  - **Article 17 violation (무의존)**: collapses the explicit zero-external-dependency posture devkit's install profile model relies on.
  - One-way: very expensive to undo (must re-extract telepty from a merged history).
- **Eviction reason**: 4 of 18 articles violated, with Article 9 (independence) being foundational. Triage §1 explicitly warns against this in Q1's "Article 1 vs Article 17" framing.

### §4.3 Alternative C: Split by AI vs system layer (telepty hosts AI integrations too)

- **Description**: Telepty hosts both transport AND AI-CLI integration recipes (claude/codex/gemini knowledge); devkit hosts only install profiles + cross-cutting skills.
- **Pros**:
  - Single repo for "anything that talks to AI sessions".
  - Could simplify #10.2 (`telepty install hooks claude` becomes natural).
- **Cons**:
  - **Article 3 violation**: telepty's role per CONSTITUTION.md §3 표 = "모든 크로스 레이어 해결. 세션/머신/OS 연결" (신경계). Adding "claude/codex/gemini hook knowledge" promotes telepty to **두뇌** territory (deliberation's role) or **골격계** (devkit's role).
  - Bloats telepty from a focused PTY multiplexer into a Swiss-army knife (mirrors the rejected Q1 "all-in-one autossh" path).
  - Per-CLI integrations evolve at different cadences than transport — coupling them to telepty's release cycle creates either churn (frequent telepty releases) or staleness (slow per-CLI fixes).
  - Reverses the existing devkit `skills/` investment (11 entries already correctly placed).
- **Eviction reason**: Article 3 violation is direct and constitutional-level; the existing devkit `skills/` distribution invalidates the premise.

### §4.4 Chosen: Mechanism vs Content split (§3)

- **Description**: §3.1 boundary rule. Telepty = mechanism; devkit = content.
- **Selection rationale**:
  - **Maps cleanly to CONSTITUTION.md §3 표** — telepty (신경계, "세션/머신/OS 연결"), devkit (골격계, "설치. 스킬. 템플릿. 개발 도구"). The constitutional table is itself a mechanism vs content split; this ADR formalizes it.
  - **All three blocked issues (#8, #10.2, #3) get unambiguous placements** (§3.4 table) without bundling features into the wrong repo.
  - **Composition contract (§3.6) is small** — 6 surfaces (r3 count): 3 already CLI-stable (`telepty list --json` formalized as `telepty-list-json/v1`, `[context-ref/v1]` grammar formalized in r3 per §3.1.2.1.1, `command -v aigentry` POSIX baseline) + 3 newly specified by r2 (`telepty-snippet/v1`, `scaffold/v1`, `scaffold-shim/v1`) per §3.6 stability provenance table.
  - **Backward compatible** — no immediate code migration required (§6.1); existing artifacts grandfather under §6.2.
  - **Testable** — §8 verification plan defines measurable acceptance criteria (M1: zero new boundary violations in next 5 PRs; M2: composition-contract surfaces semver-stable for 60 days).

---

## §5 Constitution Check (위헌 심사)

Per `references/constitution-check.md` §1 — 5 mandatory questions. Cross-cutting Article 3 explicitly cited per dispatch hard rule.

### Q1 — AI 기술 격차 해소에 복무하는가?

**PASS**. Boundary clarity reduces friction for new contributors who currently must guess where to put cross-cutting code. Triage §5 Q3 evidence: three issues (#8, #10.2, #3) blocked on guessing — non-experts cannot navigate this; clear rule democratizes contribution. Also: clean boundaries are prerequisites for the 원클릭 install (Article 10) goal — an installable devkit can advertise "everything content-side" without entangling transport version skew.

### Q2 — 이 기능은 어느 컴포넌트의 역할인가? (Article 3 — explicitly cited per dispatch HARD RULE)

**PASS**. This ADR's primary purpose **is** to answer Q2 for the entire telepty/devkit shared territory. The chosen split (§3) directly maps to **CONSTITUTION.md §3 표** rows:

| Constitution row (verbatim) | Boundary mapping |
|---|---|
| **telepty** — "모든 크로스 레이어 해결. 세션/머신/OS 연결" / "신경계" / "절대 하지 않는 것: UI 렌더링, 기억 저장" | Confirms telepty = transport mechanism only. **§3.2 enforces this**. |
| **devkit** — "설치. 스킬. 템플릿. 개발 도구" / "골격계" / "절대 하지 않는 것: 런타임 기능" | Confirms devkit = content + scaffolding. **§3.3 enforces this**. |
| Article 4 (경계) — "자기 영역이 아닌 핵심 로직을 본인 프로젝트에 구현하지 않는다. 1. Client adapter / thin wrapper만 허용" | §3.6 composition contract enforces thin-wrapper only (6 contract surfaces — 3 stable + 3 newly specified per §3.6 stability provenance table). |

The boundary literally codifies Article 3. **No alternative section of the constitution is contradicted**.

### Q3 — 이 프레임워크/라이브러리가 정말 필요한가? (Articles 1, 17)

**PASS**. This ADR adds **zero** new frameworks, libraries, or runtime dependencies. The composition contract (§3.6) uses existing `command -v`, stdout text, and CLI exit codes — POSIX shell baseline. Per Alternative B analysis (§4.2), the rejected merge path would have **violated** Article 1; the chosen split preserves it.

### Q4 — 모든 크로스 환경에서 동작하는가? (Article 2)

**PASS**. The boundary is defined at the **repo / CLI surface** level, not OS-specific. All composition-contract surfaces (`telepty init --print-snippet`, `command -v aigentry`, `telepty list --json`, exit codes) are POSIX-portable. Article 2 §2 (Cross-OS macOS/Linux/Windows) is unaffected — telepty already commits to it; devkit already commits to it (devkit AGENTS.md Rule 26 cross-OS abstraction). Article 2 §7 (Cross-AI) is **strengthened** because per-CLI knowledge is now uniformly hosted in devkit — no telepty CLI-specific quirks leak across the boundary.

### Q5 — 사용자에게 "어떻게"를 강요하지 않는가? (Article 11 — 격차 해소)

**PASS**. End-user experience is unchanged — the boundary is a **developer-facing** contract. From a public user's perspective:
- `npm install -g @dmsdc-ai/aigentry-telepty` → still works alone (Article 9 preserved by §3.4 row "session start --scaffold opt-in if devkit on PATH").
- `npm install -g @dmsdc-ai/aigentry-devkit` → installs everything content-side; auto-pulls telepty as managed module (devkit AGENTS.md §Managed Modules).
- `aigentry setup` → still one command; internally now invokes `telepty init --print-snippet` rather than mixing snippet text into devkit hardcode (cleaner SSOT, invisible to user).

No new "how" is imposed on users. The "how" is removed from contributors.

### Q6 (Article 9 — Independence, additional check given scope=ecosystem)

**PASS**. §3.4 row "#3" explicitly preserves telepty independence: `session start --scaffold` is opt-in and falls back to bare session if `aigentry` not on PATH. Devkit independence is intrinsic — devkit doesn't need to call into telepty internals; it composes telepty CLI like any other consumer. Both packages remain individually `npm install`-able.

### Q7 (Article 17 — 무의존, additional check)

**PASS**. No new mandatory external dependencies. The composition contract is "telepty CLI + devkit CLI" — both are aigentry-internal. Per Article 17 §4 ("외부 의존성이 필요한 경우 반드시 fallback 경로를 제공"), the `--scaffold` opt-in fallback (#3 row in §3.4) provides the required degraded path.

### Q8 (Article 15 — SSOT contract registration) — explicit r2 strengthening

**ACTION REQUIRED on acceptance — STRENGTHENED to BLOCKER per codex r1 §5.4**.

The **6** composition-contract surfaces in §3.6 (post-r2) must be registered in `aigentry-ssot` per Article 15 §1 before any cross-repo consumer (devkit's `--integrate-telepty`, devkit hooks, etc.) implements against them. **§6.5 elevates this to BLOCKER status** for Phase 3 dispatches — orchestrator MUST verify each surface registered before dispatching `aigentry-architect-init-cmd-spec` / `aigentry-architect-context-ref-spec` / `aigentry-architect-bootstrap-spec`.

**Codex r1 verbatim concern §5.4**: "until registration happens, the contract is not enforceable. Treat SSOT registration as a pre-implementation gate for #8/#10.2/#3."

**Article 15 binding entries** (each MUST include spec doc link, owning repo, consuming repos, conformance fixture paths, deprecation policy per §3.6 accountability table):

1. `telepty-snippet/v1` (§3.1.1)
2. `[context-ref/v1]` (§3.1.2)
3. `scaffold/v1` (§3.3.1.4)
4. `scaffold-shim/v1` (§3.3.1.2-3)
5. `telepty list --json` schema (existing surface)
6. POSIX `command -v aigentry` (trivial registration acknowledgment)

**Verification**: M0 immediate post-acceptance gate (§8) checks at least stub SSOT entries exist for all 6 within 7 days of acceptance; conformance fixtures may follow during Phase 3 implementation but stub registration is the gate.

Without this strengthening, the boundary remains paper-only — codex r1 §5.4 concern. r2 satisfies the concern.

---

## §6 Implementation Plan

### §6.1 Status flip on acceptance

- User signoff via aigentry-orchestrator → `status: accepted` in this ADR's frontmatter.
- Orchestrator records acceptance in task-queue (issues #8, #10.2, #3 unblocked).
- This ADR added to `~/projects/aigentry-orchestrator/docs/adr/` index (already there by file path).

### §6.2 No immediate code migration (grandfathering rule)

**Existing artifacts that violate the new boundary do not move yet.** Specifically:
- `skill-installer.js` stays in telepty (despite §3.3.3 logically placing it in devkit).
- `skills/telepty-*/SKILL.md` stays in telepty (this is correct under §3.4 row "skills/telepty-*").
- Any mid-flight Phase 1 / Phase 2 PR continues against current placement; rebase to new boundary not required.

**Why grandfather**: triage §3 already scoped Phase 1/2 work against current layout. Forcing immediate migration introduces merge conflict risk for in-flight quick-wins (#14, #7, #5, #6, #13a). Recent telepty 0.3.4 history (`486bc1e feat(skill-installer): auto-detect installed AI CLIs`) ships Phase 1 work against current location. Boundary rule applies to **net-new code from acceptance forward**.

#### §6.2.1 Legacy exception policy — `skill-installer.js` (codex r1 condition 5 — verbatim)

**Codex r1 §1 / §7.5 verbatim**: "mark `skill-installer.js` as a named legacy exception in telepty docs/AGENTS and add a 'no new feature expansion except bugfixes' rule. New installer behavior must land in devkit."

**Adopted as binding policy**:

1. **Status**: `skill-installer.js` (in `~/projects/aigentry-telepty/`) is the **single named legacy exception** to §3.1 rule 3. It is NOT precedent for new placements.
2. **No new feature expansion**: the file accepts ONLY bugfixes, security patches, and dependency upgrades. Net-new functionality (new CLI detection, new skill types, new install paths, new flags) MUST land in devkit — at migration time, devkit will introduce `aigentry scaffold install-skills` (FUTURE; NOT in r2 §3.3.1.4 locked surface — added Phase 7+ when §6.2.1 trigger fires).
3. **Documentation requirements (mandatory side effect of this ADR's acceptance)**:
   - `~/projects/aigentry-telepty/AGENTS.md` MUST add a "Legacy exception" subsection naming `skill-installer.js` as grandfathered per ADR 2026-05-05.
   - `~/projects/aigentry-telepty/skill-installer.js` MUST gain a top-of-file comment header: `// LEGACY: grandfathered by ADR 2026-05-05-telepty-devkit-boundary §6.2.1. New installer behavior MUST land in @dmsdc-ai/aigentry-devkit. Bugfixes only.`
4. **Migration trigger criteria** (any one fires §6.6 audit dispatch):
   - C1: ≥2 PRs in 60 days attempt to add new feature to `skill-installer.js` (PR reviewer rejects + flags).
   - C2: A devkit feature requires functionality currently only in `skill-installer.js` (forces duplication or migration).
   - C3: Telepty CHANGELOG indicates breaking change to `skill-installer.js` interface.
5. **Migration path** (when triggered): per §10.6 — copy with history, telepty shim with deprecation notice, one-minor-cycle deprecation, removal in next major.

**Enforcement**: PR reviewers (codex/gemini/claude per `references/reviewer-matrix.md`) cite §6.2.1 when rejecting feature-expansion PRs to `skill-installer.js`.

### §6.3 Phase 2 follow-ups (issues unblocked by acceptance)

Each follow-up dispatch references this ADR by commit SHA:

| Issue | Follow-up dispatch | Boundary placement applied |
|---|---|---|
| #8 telepty init | `aigentry-architect-init-cmd-spec` (per triage §3.3 #8) — now SPEC scope is reduced: split into telepty `--print-snippet` mini-spec + devkit `--integrate-telepty` spec | §3.4 row #8 |
| #10.2 install hooks | Phase 3 `aigentry-architect-context-ref-spec` per triage §3.4 #10 — scope: protocol doc (telepty README) + devkit `aigentry scaffold install-hooks <cli>` design | §3.4 row #10.2 |
| #3 CLAUDE.md scaffold | Phase 3 `aigentry-architect-bootstrap-spec` per triage §3.4 #3 — scope: devkit `aigentry scaffold --project` + opt-in `telepty session start --scaffold` shim | §3.4 row #3 |

Sequencing: per triage §4 dependency diagram, Phase 2.5 (this ADR) must accept before Phase 3 issues #8/#3/#10.2 dispatch.

### §6.4 Phase 7+ optional — boundary-violation audit + migration

Out of scope for this ADR. After Phase 3 stabilizes, an optional architect dispatch may:
- Audit `skill-installer.js` migration telepty → devkit.
- Audit whether `skills/telepty-*/SKILL.md` should mirror into devkit's installable distribution (per §3.4 last row).
- Audit whether `bin/open-session.sh` symlink direction or canonical location needs adjustment.

**Trigger**: ≥3 boundary-violation incidents in Phase 3 follow-ups (per §8 M1 rollback trigger).

### §6.5 Article 15 SSOT registration — BLOCKER gate (codex r1 condition 1)

**Codex r1 §5.4 verbatim**: "The ADR correctly calls SSOT registration mandatory, but until registration happens, the contract is not enforceable. Treat SSOT registration as a pre-implementation gate for #8/#10.2/#3."

**r2 strengthening**: SSOT registration is a **BLOCKER** for Phase 3 dispatches (not just "mandatory before"). Orchestrator MUST verify each surface registered before dispatching `aigentry-architect-init-cmd-spec`, `aigentry-architect-context-ref-spec`, `aigentry-architect-bootstrap-spec`.

Composition-contract surfaces (§3.6) requiring SSOT registration (6 surfaces post-r2):

1. `telepty-snippet/v1` — full §3.1.1 spec with conformance fixtures.
2. `[context-ref/v1]` — full §3.1.2 grammar + receiver contract + hook payload schema (binding wire contract per §3.1.2.1.1).
3. `scaffold/v1` — full §3.3.1.4 CLI shape with conformance fixtures.
4. `scaffold-shim/v1` — telepty's preflight wrapper semantics (§3.3.1.2 + §3.3.1.3).
5. `telepty-list-json/v1` — full §3.6.1 schema + 4 fixture files (r3 promotion).
6. POSIX `command -v aigentry` — **acknowledgment-only registration** (no spec body required; registry entry exists solely to record telepty's reliance on POSIX `command -v` for devkit detection per §3.3.1.3, so the contract surface is enumerated for audit completeness).

Registration target: `aigentry-ssot` per Article 15 §1. Each entry MUST include: spec doc link, owning repo, consuming repos, conformance fixture paths, deprecation policy.

#### §6.5.1 r3 testable readiness gates (codex r2 §6 — Phase 2/3 readiness)

**Codex r2 §6 verbatim**:

> "Readiness call: **not immediate dispatch-ready until §6.5/M0 are satisfied and N1 is fixed**. After those are done, the three sub-dispatches are cleanly referenceable and do not need another broad boundary ADR."

**r3 disposition**: r3 makes §6.5 (SSOT) and M0 (immediate post-acceptance gate, §8) mechanically verifiable. Each gate item below has (a) a concrete artifact path, (b) a one-line shell verification command (POSIX `test`/`grep`-based), and (c) a pass criterion. The orchestrator runs all gates before dispatching Phase 3 sub-tasks; failure on any gate blocks dispatch.

**Gate G1 — `telepty-snippet/v1` SSOT stub exists**

| Field | Value |
|---|---|
| Artifact | `~/projects/aigentry-ssot/contracts/telepty-snippet-v1.md` |
| Verification | `test -f ~/projects/aigentry-ssot/contracts/telepty-snippet-v1.md && grep -q 'telepty-snippet/v1' ~/projects/aigentry-ssot/contracts/telepty-snippet-v1.md` |
| Pass | exit 0 |

**Gate G2 — `[context-ref/v1]` SSOT stub exists**

| Field | Value |
|---|---|
| Artifact | `~/projects/aigentry-ssot/contracts/context-ref-v1.md` |
| Verification | `test -f ~/projects/aigentry-ssot/contracts/context-ref-v1.md && grep -q 'context-ref/v1' ~/projects/aigentry-ssot/contracts/context-ref-v1.md && grep -q '§3.1.2.1.1' ~/projects/aigentry-ssot/contracts/context-ref-v1.md` |
| Pass | exit 0 (must cite §3.1.2.1.1 versioned-binding policy) |

**Gate G3 — `scaffold/v1` SSOT stub exists**

| Field | Value |
|---|---|
| Artifact | `~/projects/aigentry-ssot/contracts/scaffold-v1.md` |
| Verification | `test -f ~/projects/aigentry-ssot/contracts/scaffold-v1.md && grep -q 'scaffold/v1' ~/projects/aigentry-ssot/contracts/scaffold-v1.md` |
| Pass | exit 0 |

**Gate G4 — `scaffold-shim/v1` SSOT stub exists**

| Field | Value |
|---|---|
| Artifact | `~/projects/aigentry-ssot/contracts/scaffold-shim-v1.md` |
| Verification | `test -f ~/projects/aigentry-ssot/contracts/scaffold-shim-v1.md && grep -q 'scaffold-shim/v1' ~/projects/aigentry-ssot/contracts/scaffold-shim-v1.md` |
| Pass | exit 0 |

**Gate G5 — `telepty-list-json/v1` SSOT stub + schema cite exists**

| Field | Value |
|---|---|
| Artifact | `~/projects/aigentry-ssot/contracts/telepty-list-json-v1.md` |
| Verification | `test -f ~/projects/aigentry-ssot/contracts/telepty-list-json-v1.md && grep -q 'telepty-list-json/v1' ~/projects/aigentry-ssot/contracts/telepty-list-json-v1.md && grep -q '§3.6.1' ~/projects/aigentry-ssot/contracts/telepty-list-json-v1.md` |
| Pass | exit 0 (must cite §3.6.1 schema) |

**Gate G6 — `command -v aigentry` SSOT acknowledgment exists**

| Field | Value |
|---|---|
| Artifact | `~/projects/aigentry-ssot/contracts/posix-command-v-aigentry.md` |
| Verification | `test -f ~/projects/aigentry-ssot/contracts/posix-command-v-aigentry.md` |
| Pass | exit 0 (file existence sufficient — acknowledgment-only) |

**Gate G7 — Telepty README receiver-side cleanup landed (M0 doc check, §3.1.2.5)**

| Field | Value |
|---|---|
| Artifact | `~/projects/aigentry-telepty/README.md` |
| Verification | `! grep -nE 'telepty install hooks' ~/projects/aigentry-telepty/README.md` |
| Pass | exit 0 (zero matches — old `telepty install hooks` follow-up text removed) |

**Gate G8 — Telepty AGENTS.md legacy-exception subsection added (§6.2.1)**

| Field | Value |
|---|---|
| Artifact | `~/projects/aigentry-telepty/AGENTS.md` |
| Verification | `grep -q 'Legacy exception' ~/projects/aigentry-telepty/AGENTS.md && grep -q 'skill-installer.js' ~/projects/aigentry-telepty/AGENTS.md && grep -q 'ADR 2026-05-05' ~/projects/aigentry-telepty/AGENTS.md` |
| Pass | exit 0 (subsection present, names file, cites this ADR) |

**Gate G9 — `skill-installer.js` legacy header comment landed (§6.2.1.3)**

| Field | Value |
|---|---|
| Artifact | `~/projects/aigentry-telepty/skill-installer.js` |
| Verification | `head -5 ~/projects/aigentry-telepty/skill-installer.js \| grep -q 'LEGACY: grandfathered by ADR 2026-05-05'` |
| Pass | exit 0 (top-of-file legacy comment present) |

**M0 composite pass criterion**: ALL 9 gates G1-G9 pass within 7 days of `status: accepted`. Failure on any gate → orchestrator MUST NOT dispatch Phase 3 sub-tasks (#8 / #10.2 / #3); ADR moves to `revision` and architect re-dispatch is triggered.

**M0 audit script (canonical, orchestrator-runnable)**:

```bash
# Run from any cwd; requires only POSIX shell
set -e
test -f ~/projects/aigentry-ssot/contracts/telepty-snippet-v1.md
grep -q 'telepty-snippet/v1' ~/projects/aigentry-ssot/contracts/telepty-snippet-v1.md
test -f ~/projects/aigentry-ssot/contracts/context-ref-v1.md
grep -q 'context-ref/v1' ~/projects/aigentry-ssot/contracts/context-ref-v1.md
grep -q '§3.1.2.1.1' ~/projects/aigentry-ssot/contracts/context-ref-v1.md
test -f ~/projects/aigentry-ssot/contracts/scaffold-v1.md
grep -q 'scaffold/v1' ~/projects/aigentry-ssot/contracts/scaffold-v1.md
test -f ~/projects/aigentry-ssot/contracts/scaffold-shim-v1.md
grep -q 'scaffold-shim/v1' ~/projects/aigentry-ssot/contracts/scaffold-shim-v1.md
test -f ~/projects/aigentry-ssot/contracts/telepty-list-json-v1.md
grep -q 'telepty-list-json/v1' ~/projects/aigentry-ssot/contracts/telepty-list-json-v1.md
grep -q '§3.6.1' ~/projects/aigentry-ssot/contracts/telepty-list-json-v1.md
test -f ~/projects/aigentry-ssot/contracts/posix-command-v-aigentry.md
! grep -nE 'telepty install hooks' ~/projects/aigentry-telepty/README.md
grep -q 'Legacy exception' ~/projects/aigentry-telepty/AGENTS.md
grep -q 'skill-installer.js' ~/projects/aigentry-telepty/AGENTS.md
grep -q 'ADR 2026-05-05' ~/projects/aigentry-telepty/AGENTS.md
head -5 ~/projects/aigentry-telepty/skill-installer.js | grep -q 'LEGACY: grandfathered by ADR 2026-05-05'
echo "M0 ALL GATES PASS"
```

Conformance fixtures (the test files themselves, e.g., `tests/snippet-protocol/v1/golden-claude.md`, `tests/list-json/v1/golden-empty.json`) are NOT M0 gate items — they are Phase 3 implementation deliverables tracked by M6. M0 only verifies SSOT stub registration (G1-G6) + the three doc-only changes (G7-G9). This separation matches codex r2 §1 verdict that "stub SSOT registration before dispatch and fixtures during Phase 3 PRs ... is acceptable if M6 remains merge-blocking."

### §6.6 Phase 7+ Session Launch Boundary Audit (codex r1 condition 4 + major 5 — DEFERRED)

**Codex r1 §7.4 verbatim**: "**Session launch boundary audit**: decide whether `open-session.sh` and `aigentry session create` should keep direct terminal launch logic or delegate more of it to telepty primitives."

**r2 disposition**: DEFERRED out of scope per r2 hard rule "NO new boundary changes — only protocol specification of existing boundaries." However, audit scope is **locked** in this ADR so a future architect dispatch can pick it up without re-litigation.

#### §6.6.1 Audit scope (locked)

The audit MUST examine and produce a successor ADR for:

| Artifact | Current behavior | Audit question |
|---|---|---|
| `bin/open-session.sh` (devkit; orchestrator symlink) | Terminal detection (cmux/aterm/tmux/wezterm/iTerm/ghostty), `telepty allow`, daemon fallback spawn, lifecycle cleanup | Is this **provisioning facade** (devkit-correct per §3.1 rule 4) OR **runtime primitive** (must migrate to or be exposed from telepty per rule 1)? |
| `aigentry session create` (devkit) | Multi-session orchestrated workflow, kitty/tmux tab orchestration, `telepty allow` + AI CLI spawn composition | Same question — facade vs primitive boundary. |
| `telepty session start --launch` (telepty) | Lower-level session-start primitive with kitty launch flow | Does this overlap with devkit's launch logic? Should some of devkit's logic move down to telepty as a reusable primitive? |
| Terminal-matrix dispatch logic (cmux/aterm/tmux/wezterm/iTerm/ghostty branching) | Exists in `open-session.sh` + partially in `telepty session start --launch` | Single canonical owner OR explicit dual-layer with non-overlapping responsibilities? |

#### §6.6.2 Audit triggers (any one fires dispatch)

- T1: ≥3 boundary-violation incidents flagged in Phase 3 follow-up PRs (per §8 M1 rollback metric).
- T2: §6.2.1 C1/C2/C3 (skill-installer.js migration trigger) fires — bundles with this audit.
- T3: New ecosystem component (brain/dustcraw/aterm/amplify) needs to launch sessions and finds the dual-layer ambiguous.
- T4: 90 days post-r2 acceptance with no T1-T3 trigger — opportunistic audit during normal cadence.

#### §6.6.3 Audit deliverables

- Successor ADR (`adr-XXXX-session-launch-boundary.md`) — supersedes parts of §3.4 rows "bin/open-session.sh", "aigentry session create", "telepty session start --launch" if needed.
- Migration plan if any artifact moves.
- Updated §6.2 grandfather list (additions or removals).

**Out of scope for r2** (r2 hard rule: NO new boundary changes). r2 commits only to **scoping** the audit so it cannot be punted indefinitely.

---

## §7 Cross-Cutting Issues Resolution Table (final placement, normative)

This is the binding lookup table for **every** currently-known cross-cutting artifact. Future artifacts apply §3.1 default rule.

| # | Artifact | Repo (this ADR) | Mechanism it uses (if cross-repo) | Triage ref |
|---|---|---|---|---|
| 1 | Transport (inject/broadcast/allow/etc.) | telepty | n/a (single-repo) | telepty AGENTS.md §1 |
| 2 | Daemon, session lifecycle | telepty | n/a | telepty AGENTS.md §1 |
| 3 | `[context-ref]` protocol spec | telepty (README + skills/telepty-inject/SKILL.md) | devkit consumes via spec | triage §3.4 #10 |
| 4 | `[context-ref]` per-CLI hook installer | devkit | shell out to PATH `telepty` for runtime | triage §3.4 #10.2 |
| 5 | `~/CLAUDE.md` snippet text | telepty (`init --print-snippet`) | devkit consumes via stdout | triage §3.3 #8 |
| 6 | `~/CLAUDE.md` idempotent file edit | devkit (`aigentry scaffold --integrate-telepty`) | calls `telepty init --print-snippet` | triage §3.3 #8 |
| 7 | Project `CLAUDE.md` + `.claude/settings.json` scaffold | devkit (`aigentry scaffold --project`) | opt-in invoked by `telepty session start --scaffold` if devkit on PATH | triage §3.4 #3 |
| 8 | `skill-installer.js` (logically devkit; physically telepty grandfather) | telepty (grandfathered) | Migration deferred (§6.4) | triage §3.2 #7 |
| 9 | `skills/telepty-*/SKILL.md` (10 files, command reference) | telepty | n/a (telepty-CLI mechanism docs) | telepty AGENTS.md table |
| 10 | `skills/{deliberation, env-manager, …}` (cross-cutting skills) | devkit | n/a (already correct) | devkit AGENTS.md §Architecture |
| 11 | `bin/open-session.sh` (orchestrator → devkit symlink) | devkit (canonical) | symlinked from orchestrator | verified `ls -la` 2026-05-05 |
| 12 | `aigentry session create` (multi-session orchestrated) | devkit | composes `telepty allow` + kitty | devkit AGENTS.md §Commands |
| 13 | `telepty session start --launch` (lower-level primitive) | telepty | n/a | telepty AGENTS.md §Commands |
| 14 | Install profiles, `aigentry setup`, healthchecks | devkit | n/a | devkit AGENTS.md §Architecture |
| 15 | TUI (telepty `tui`, blessed) | telepty | n/a (telepty-internal display) | telepty AGENTS.md table |
| 16 | Future cross-CLI installable skill (e.g., `telepty-ai-session` from #12) | devkit | composes telepty primitives | triage §3.4 #12 lean (b) |
| 17 | Future telepty CLI subcommand reference doc (new SKILL.md describing telepty-only command) | telepty | n/a | §3.4 row "skills/telepty-*" |

**Default rule (for future artifacts not in table)**: Apply §3.1 — does it move bytes between sessions or describe telepty's own CLI surface? → telepty. Does it sit on disk as content, install/scaffold, or carry per-CLI knowledge? → devkit.

---

## §8 Verification Plan

§5.9 INVARIANT mandate: measurable metrics + rollback triggers. r2 adds **M0 (immediate doc/API checks)** per codex r1 minor 4 ("M1 next-5-PRs is too slow for known current conflicts").

| Metric | Measurement method | Success threshold | Failure → action |
|---|---|---|---|
| **M0 — Immediate post-acceptance gate (testable per r3 §6.5.1)** | Run §6.5.1 M0 audit script — 9 gates G1-G9: (a) §6.5.1 G7 telepty README receiver-side cleanup per §3.1.2.5 — no `telepty install hooks` mention; (b) G8 telepty AGENTS.md "Legacy exception" subsection per §6.2.1; (c) G9 `skill-installer.js` top-of-file legacy comment; (d) G1-G6 stub SSOT entries for all 6 surfaces with required content cites (`§3.1.2.1.1` for context-ref, `§3.6.1` for list-json) | ALL 9 gates pass (exit 0 for the audit script) within **7 days** of `status: accepted` | Any gate fail → ADR moves to `revision`; orchestrator re-dispatches before Phase 3 unblocks |
| **M1 — Boundary respect rate** | Audit next 5 PRs across telepty + devkit (post-acceptance, 60-day window) for compliance with §7 placement table + §3.1 4-rule sharpening. Reviewer flags violations during PR review. | ≥4 of 5 (80%) compliant on first submission; 5 of 5 after 1-cycle revision | <80% on first submission → §6.6 audit triggered; <100% after revision → ADR REQUEST-REVISION |
| **M2 — Composition contract stability** | Track changes to the 6 surfaces in §3.6 (post-r2) over 60 days post-acceptance. Stability tags: `telepty-snippet/v1`, `[context-ref/v1]`, `scaffold/v1`, `scaffold-shim/v1`, `telepty list --json` schema, POSIX `command -v` | Zero unannounced breaking changes (semver-major bumps OK if announced 14 days ahead per Article 15) | Any unannounced breaking change → orchestrator emergency dispatch + ADR amendment |
| **M3 — Article 9 (telepty independence) preserved** | Smoke test: `npm install -g @dmsdc-ai/aigentry-telepty@latest` on clean machine WITHOUT devkit; run `telepty daemon`, `telepty allow`, `telepty inject`, `telepty list --json`. **NEW r2**: also verify `telepty session start` (no `--scaffold` flag) launches successfully with no devkit-related error. **NEW r2**: telepty CI MUST pass without devkit installed (codex anti-pattern 1). | All commands exit 0; CI green without devkit | Failure → boundary violation; ADR REQUEST-REVISION |
| **M4 — Article 17 (zero external dep) preserved** | Inspect `~/projects/aigentry-telepty/package.json` and `~/projects/aigentry-devkit/package.json` for new dependencies introduced by §6.3 follow-up implementations | No new external runtime deps introduced by Phase 3 implementations of #8/#10.2/#3 | Any new external dep → return to spec for justification |
| **M5 — Phase 3 unblock latency** | Time from this ADR `accepted` → first Phase 3 sub-dispatch (`aigentry-architect-init-cmd-spec` or successor) | ≤14 days | >14 days → orchestrator follow-up; signals boundary unclear in practice |
| **M6 — Conformance fixture coverage (NEW r2)** | Each Phase 3 implementation PR ships conformance fixtures matching §3.1.1.4 / §3.1.2 / §3.3.1.6 spec | 100% — no Phase 3 PR merges without fixtures | Missing fixtures → PR blocked at review |

**Rollback trigger composite**: Any 2 of {M0 fail, M1 fail, M2 unannounced break, M3 fail} → ADR moves to `revision` status; architect re-dispatches.

**Verification owner**: aigentry-orchestrator-claude assigns audit tracking to whichever architect session next handles a Phase 3 follow-up. M0 specifically owned by orchestrator (day-of-acceptance gate before Phase 3 dispatch).

---

## §9 Open Questions

§5 INVARIANT: explicit OQ list, no answer-by-omission accepted.

> **r3 N1 cleanup note**: r2's OQ-1 ("Should `[context-ref]` protocol versioning ship with this ADR or be deferred to Phase 3?") was **REMOVED in r3** because §3.1.2.1.1 now binds the `[context-ref/v1]` wire contract immutably. Phase 3 specs may refine non-wire-contract implementation details only; any change to the locked wire contract subset (grammar, storage, receiver detection rule, hook payload schema, versioning model) requires a `[context-ref/v2]` successor ADR. The remaining OQs below are renumbered to OQ-1 .. OQ-3.

- **OQ-1** (was OQ-2): Should the §6.4 Phase 7+ migration audit have a triggering KPI besides §8 M1 rollback? E.g., contributor confusion incidents? **Architect lean**: defer; M1 covers the operational signal.
- **OQ-2** (was OQ-3): Does the boundary apply to other aigentry components (brain, dustcraw, amplify) by extension, or is it strictly telepty/devkit? **Architect lean**: this ADR is strictly telepty/devkit. Generalization is a separate ADR if needed (likely deserves its own ecosystem-scope decision).
- **OQ-3** (was OQ-4): Should `aigentry session create` (devkit higher-level) and `telepty session start --launch` (telepty lower-level) be renamed to make the layer distinction explicit (e.g., `aigentry orchestrate` vs `telepty session`)? **Architect lean**: out of scope; documentation note in next devkit AGENTS.md edit suffices.

---

## §10 Backward Compatibility

§5.8 INVARIANT mandate: no "no impact" assertion without analysis.

### §10.1 Existing telepty consumers

- **Public users running `telepty` CLI (npm install -g @dmsdc-ai/aigentry-telepty)** — **no breaking change**. All current commands preserved. New `telepty init --print-snippet` is **additive** (§3.4 row #8). M3 verification (§8) explicitly tests independence preservation.
- **Orchestrator / aterm / brain / dustcraw / amplify sessions calling `telepty inject` / `telepty list --json`** — **no breaking change**. JSON schema is on the §3.6 stable-contract list; any future change requires Article 15 SSOT registration.

### §10.2 Existing devkit consumers

- **Public users running `aigentry setup` / `aigentry up`** — **no breaking change**. Future `aigentry scaffold --integrate-telepty` is additive.
- **`bin/open-session.sh` callers (orchestrator)** — **no breaking change**. Symlink unchanged.

### §10.3 Existing skill-installer.js consumers

- Phase 1 #7 fix is in-flight against telepty location. **Grandfather rule (§6.2) preserves it**; no migration. New similar code goes to devkit per §3.3.3.

### §10.4 Boundary-violating in-flight PRs

- Triage Phase 1 quick-wins (#14, #7, #5, #6, #13a) all touch telepty internals or telepty `skills/telepty-*/SKILL.md` — **all compliant** with §3.2 / §3.4 row "skills/telepty-*". No conflict.
- Triage Phase 2 #13b/#13c (cross-host inject) lives in telepty `cli.js` — **compliant** with §3.2 (transport mechanism).

### §10.5 Telepty `skill-installer.js` — degenerate case explicit

- Currently in telepty; logically devkit per §3.3.3. **Grandfathered §6.2** — no immediate migration. If kept in telepty long term, it will be the **single explicit exception** to the boundary; future similar code MUST go to devkit. This exception is **not a precedent** for new placement decisions.

### §10.6 Migration path (if §6.4 future audit migrates `skill-installer.js`)

If a future ADR migrates `skill-installer.js` telepty → devkit, the migration path is:
1. Copy file with git-mv-style history preservation to devkit.
2. Telepty CLI gains a thin `skill-installer` shim that exec()'s `aigentry scaffold install-skills` (FUTURE — not in r2 §3.3.1.4 locked surface; added when migration triggers per §6.2.1) if devkit present, prints deprecation notice + manual install link if not (Article 17 fallback).
3. Telepty deprecates the in-repo skill-installer in CHANGELOG one minor cycle ahead.
4. Telepty removes the in-repo skill-installer in next major.

Out of scope for this ADR; documented for future ADR reference.

---

## §11 Consequences

### §11.1 Positive

- **Three blocked issues unblock immediately on acceptance** (#8, #10.2, #3) per §6.3 + triage §4 dependency chain.
- **Article 3 (역할) operationalized** — what was a constitutional principle becomes an enforceable per-PR rule (§7 lookup table).
- **Article 15 (SSOT) gets concrete artifacts** to register (§3.6 six contract surfaces post-r2 — 3 stable + 3 newly specified per §3.6 stability provenance table).
- **Future contributor onboarding lighter** — one rule (§3.1) replaces five rounds of architect arbitration.
- **Composition contract is small** (6 surfaces post-r2 / r3-formalized) — keeps coupling minimal and reviewable.

### §11.2 Negative / Costs

- **Grandfather rule (§6.2) creates an explicit exception** (`skill-installer.js`) — the boundary is not 100% pure on day one. Risk: future contributors cite the exception as license to add more.
- **§6.3 Phase 3 dispatches now have a hard prerequisite** on this ADR's acceptance — a rejected ADR (REQUEST-REVISION) blocks 3 features.
- **Article 15 SSOT registration adds one bureaucratic step** (§6.5) before Phase 3 implementation.
- **§3.4 row #3 (`--scaffold` opt-in)** — telepty gains a tiny new flag (one-line), even though semantically the work happens in devkit. Mild Article 1 cost.

### §11.3 Unknown risks

- The six-surface composition contract may prove too narrow for some future use case we cannot foresee. Mitigation: §6.4 audit can extend.
- Gradual contributor compliance (M1 metric) may reveal the rule statement (§3.1) is ambiguous in edge cases. Mitigation: §7 lookup table grows over time; §6.4 audit lifts repeated edge cases into rule clarification.
- `[context-ref]` protocol versioning interaction with per-CLI hook installer evolution may create a 2D version matrix devkit must manage (telepty protocol vN × CLI hook vM). **r3 mitigation**: §3.1.2.1.1 versioned-binding policy locks v1 wire contract and reserves v2+ for expansion via successor ADR; hook handshake (§3.1.2.4) records minimum required telepty version with graceful degradation. The 2D matrix is therefore bounded by Article 15 SSOT registration of each `[context-ref/vN]` and is no longer "deferred"; it is governed.

### §11.4 Anti-patterns (codex r1 §4 — verbatim quotes + r2 disposition)

**HARD RULE**: each codex-flagged anti-pattern MUST be either refactored to avoid OR explicitly waived with rationale (per dispatch directive). r2 dispositions:

#### §11.4.1 Anti-pattern 1: Circular dependency risk (codex r1 §4.1 verbatim)

> "The ADR creates a bidirectional CLI relationship: Devkit calls telepty for snippets and session primitives. Telepty may call devkit for `--scaffold`. This is acceptable only because `--scaffold` is opt-in and has a fallback. But it must remain a convenience path, not a required path in telepty tests or normal operation. **Condition**: telepty CI and smoke tests must pass on a clean machine without devkit installed."

**r2 disposition**: ADDRESSED (refactored to comply, not waived).

- §3.3.1.5 explicitly forbids telepty CI from invoking `aigentry scaffold` for any non-`--scaffold` codepath.
- §3.3.1.5 mandates `--scaffold` remain convenience-only; canonical path (no flag) is devkit-free.
- §8 M3 verification metric tests this directly (telepty CI green without devkit installed).
- §3.3.1.3 fallback: `command -v aigentry` absent → skip scaffold + proceed (Article 17 compliant).

#### §11.4.2 Anti-pattern 2: Distributed monolith risk (codex r1 §4.2 verbatim)

> "Session launching is already split across telepty and devkit. Devkit's `aigentry session create` directly handles kitty/tmux and invokes `telepty allow`; telepty's `session start --launch` also handles kitty launch mechanics. `open-session.sh` adds a third facade. **Condition**: define one canonical layer for reusable terminal launch primitives. My recommendation: telepty owns primitive session wrapping and local launch APIs; devkit owns named ecosystem workflows and config-driven orchestration."

**r2 disposition**: WAIVED FOR r2; DEFERRED to §6.6 audit with locked scope.

**Waiver rationale**:
- r2 hard rule: "NO new boundary changes — only protocol specification of existing boundaries." Refactoring session-launch ownership is a boundary change.
- gemini r1 ACCEPT preserved direction; redrawing session-launch boundaries risks invalidating cross-LLM consensus.
- §6.6 locks audit scope (4 artifacts, 4 trigger criteria, 3 deliverables) so the question cannot be punted indefinitely.
- r2 strengthens §3.1 rule 4 explicitly: "Devkit may own session provisioning workflows only when they are multi-component orchestration over telepty primitives, not alternative implementations of telepty primitives" — this is the operating rule until §6.6 audit completes.

**Risk if §6.6 audit indefinitely delayed**: dual-layer ambiguity persists; new ecosystem components (T3 trigger) may compound the issue. Mitigation: §6.6.2 trigger T4 (90-day opportunistic) ensures audit fires within 90 days of r2 acceptance regardless.

#### §11.4.3 Anti-pattern 3: Coordination overhead (codex r1 §4.3 verbatim)

> "The ADR says the composition contract is 'small' at four surfaces, but each surface is cross-repo and version-sensitive. `[context-ref]` alone can become a matrix of telepty protocol version × devkit hook version × AI CLI hook format. **Condition**: every accepted contract surface needs a version, conformance fixture, owning repo, consuming repo, and deprecation policy."

**r2 disposition**: ADDRESSED (refactored to comply, not waived).

- §3.6 per-surface accountability table now lists for each of 6 surfaces: version tag, owning repo, consuming repo(s), conformance fixture path, deprecation policy. **Five-field schema satisfied.**
- §3.1.2.3 hook payload schema explicitly carries `version: "context-ref/v1"` field, enabling devkit hook version negotiation.
- §3.1.2.4 hook handshake mechanism: hook script records minimum required telepty version; runtime check + graceful degradation if telepty older.
- §6.5 SSOT registration is BLOCKER for Phase 3 — no implementation without registry entries.
- §8 M2 + M6 verification: contract stability tracked + conformance fixture coverage required.

The 2D version matrix codex flagged (`[context-ref]` × hook version × CLI format) is now explicitly handled by the hook handshake (§3.1.2.4) + per-CLI matrix coverage (§3.1.2.4 row "Cross-CLI matrix coverage") + conformance fixture sharing (§3.1.2.1 telepty-internal parser is NOT public, so devkit hooks re-implement against fixtures — single source of truth = fixtures).

### §11.5 Failure modes (per §5 FAILED APPROACHES §6.2 lesson — dependency-component-failure analysis)

- **Telepty crashes / unavailable while devkit `aigentry scaffold` is running**: devkit's `aigentry scaffold --integrate-telepty` calls `telepty init --print-snippet`. If telepty CLI is missing/broken, scaffold must:
  1. Detect missing/broken telepty (`command -v telepty` or non-zero exit on `--print-snippet`).
  2. **Refuse to write** the integration snippet (avoid stale or empty content in user's `~/CLAUDE.md`).
  3. Print actionable error: "telepty CLI not found / version mismatch — install or upgrade telepty before integrating".
- **Devkit not installed when telepty `session start --scaffold` invoked**: Telepty must:
  1. Detect via `command -v aigentry`.
  2. Proceed with bare session (no scaffold) — Article 17 fallback path.
  3. Print informational note: "aigentry CLI not on PATH — skipping project scaffold; install @dmsdc-ai/aigentry-devkit to enable".
- **SSOT registry (§6.5) unavailable when contract surfaces are referenced**: Defer to existing aigentry-ssot fallback patterns (this ADR does not redefine SSOT availability semantics).

### §11.6 r4 changelog (codex r3 ACCEPT_WITH_CONDITIONS — 3 textual conditions resolved)

**Source**: codex r3 review `~/projects/aigentry-devkit/docs/reports/2026-05-05-boundary-adr-r3-codex-review.md` (commit `89a80a5`), verdict ACCEPT_WITH_CONDITIONS, §7 conditions + §8 explicit guidance: "targeted r4 text patch only. No boundary-direction re-review is needed after the three conditions are patched."

**Scope discipline (per dispatch SAWP §INVARIANTS + §SCOPE GUARDRAILS)**: I1 boundary direction unchanged (gemini r1 ACCEPT preserved by construction); I2 §3.1.2.1.1 untouched; I3 §3.1.2.2 untouched; I4 §3.5.5 / §6.6 untouched; I5 §6.5.1 G1-G9 untouched (Condition 2 cross-reference fix kept inline in §3.6.1 only — no gate redesign); I6 §8 M0 metric untouched.

#### §11.6.1 Condition 1 — §5 Q2 stale "4 contract surfaces" → "6 contract surfaces"

**Location**: §5 Q2 Article 4 (경계) constitution-mapping table row.

**Before** (r3, line ~728):
> "§3.6 composition contract enforces thin-wrapper only (4 contract surfaces)."

**After** (r4):
> "§3.6 composition contract enforces thin-wrapper only (6 contract surfaces — 3 stable + 3 newly specified per §3.6 stability provenance table)."

**Rationale**: §3.6 / §4.4 / §11.1 already use the 6-surface count post-r3 N2 cleanup ("3 stable + 3 newly specified"). §5 Q2 was the only stale "4" reference remaining — codex flagged it explicitly as the residual N2 class. Wording aligned with §3.6 stability provenance table for consistency.

#### §11.6.2 Condition 2 — §3.6.1 schema field semantics disambiguation

**Location**: §3.6.1 `telepty-list-json/v1` schema definitions.

**Option chosen**: **Option (a) — PREFERRED**. Removed `"version": "telepty-list-json/v1"` from the session-object JSON example. Envelope-only versioning. Schema restated as "envelope + 11 fields" exactly (2 envelope metadata fields + `sessions` array carrier + 9 fields per session-object element).

**Why (a) over (b)**: Option (b) would have promoted per-session versioning to a normative requirement — but no consumer use-case demands per-session version stamps, and dual-location versioning creates a redundancy class (envelope says v1, session says v1 → nothing gained, two places to drift). Single source of truth (envelope) matches the SSOT discipline of Article 15.

**Before** (r3 session-object example, lines ~588-601):
```json
{
  "version": "telepty-list-json/v1",
  "id": "<allow-id>",
  ...
}
```

**After** (r4 session-object example):
```json
{
  "id": "<allow-id>",
  ...
}
```

**Plus added** explicit "Versioning location" paragraph after the envelope example clarifying envelope-only semantics, restating "envelope + 11 fields exactly", and instructing implementers to ignore any legacy `sessions[].version` literal as forward-compat unknown additional field.

**Rationale**: r3 §3.6.1 stated "envelope + 11 fields" but the session-object example contradicted the field semantics table by including a 12th field (`sessions[].version`) absent from the table. Implementers reading table-only would have been incorrect; implementers reading example-only would have been incorrect. Schema is now unambiguous (Article 15 SSOT registration prerequisite).

**Cross-reference impact**: §6.5.1 G5 / G6 (if they reference field count) and §3.5.4 N3 row (says "envelope + 11 fields with semantics") remain consistent — no edits needed because the count is preserved at exactly 11. M6 fixture-coverage gate is unaffected (per codex r3 confirmation: 9/9 gate testability preserved either way).

#### §11.6.3 Condition 3 — §3.6.1 fixture paths labeled TBD-with-owner

**Location**: §3.6.1 fixture paths bullet list.

**Option chosen**: **Option (a) — PREFERRED**. Added explicit "Fixture status (r4)" paragraph immediately after the 4 fixture path bullets, before the SSOT registry path entry.

**Why (a) over (b)**: Option (b) would have required a telepty repo commit (creating stub `golden-empty.json` etc.), expanding r4 scope beyond ADR text and triggering a Phase 3 implementation prematurely — explicitly NOT RECOMMENDED by dispatch and contrary to architect role boundary (no implementation work).

**Before** (r3): 4 fixture paths listed; no statement of materialization status; ambiguous whether files were "missing in error" or "intentionally deferred".

**After** (r4): explicit "Fixture status (r4 — codex r3 Condition 3): These 4 fixture paths are TBD Phase 3 deliverables. Owner: aigentry-telepty. Merge-blocked by M6 (and §6.5.1 G5 testable gate by reference). Until M6 closes, the SSOT path is registered but the fixtures are not yet materialized — readers MUST NOT interpret the absence of these files as a defect; they are intentionally deferred to Phase 3 implementation under aigentry-telepty ownership."

**Rationale**: codex r3 confirmed §6.5.1 G5 9/9 testability is preserved either way, but the spec MUST state the deferral explicitly so future readers / Phase 3 implementers / SSOT auditors can distinguish "missing in error" from "intentionally deferred". Owner attribution (aigentry-telepty) makes the delivery accountable.

#### §11.6.4 Out-of-scope confirmations (per dispatch §SCOPE GUARDRAILS)

The following were explicitly **NOT** modified in r4:

- Boundary direction (§3 / §4.4 chosen alternative): unchanged — gemini r1 ACCEPT preserved.
- §3.1.2.1.1 N1 Option C versioned-binding policy: unchanged.
- §3.1.2.2 N4 path-token grammar: unchanged.
- §3.5.5 r3 prior-fix re-verification (C4 / Major-5 / AP2): unchanged.
- §6.5.1 G1-G9 testable gates: unchanged structurally; only §3.6.1 schema disambiguation note interacts with G5 by reference (no gate redesign).
- §6.6 session-launch boundary audit scope: unchanged.
- §8 M0 metric / canonical audit script: unchanged.
- §9 Open Questions: unchanged (no new follow-up questions added).
- Telepty repo: zero commits (Condition 3 Option b explicitly rejected).
- §13 Self-Check rubric: r3 attestation remains valid for r4 (textual cleanup only — no design, no boundary, no protocol changes).

---

## §12 Sign-off

- **Drafted by**: aigentry-architect-telepty-boundary-adr (r1, 2026-05-05) → aigentry-architect-boundary-adr-r2 (r2, 2026-05-05) → aigentry-architect-boundary-adr-r3 (r3, 2026-05-05).
- **r1 review outcomes**:
  - **gemini** (commit `3aa83d3`): **ACCEPT** (0 blockers, 0 majors, 1 minor — skill-installer.js documentation; addressed in r2 §6.2.1).
  - **codex** (commit `e0b528b`): **ACCEPT_WITH_CONDITIONS** (0 blockers, 5 majors, 5 minors, 3 anti-patterns, 5 conditions). r2 integrates all 5 conditions verbatim (§3.5); resolves 4/5 majors (1 deferred to §6.6 with locked scope); resolves 5/5 minors; addresses 2/3 anti-patterns + waives 1 with rationale.
- **r2 review outcome**:
  - **codex r2 re-review** (commit `72f45b9`): **ACCEPT_WITH_CONDITIONS**. Prior 5 conditions: 4 INTEGRATED + 1 WAIVED-OK. Prior 5 majors: 4 RESOLVED + 1 DEFERRED-ACCEPTABLE. Prior 3 anti-patterns: 2 ADDRESSED + 1 WAIVED-RATIONALE-DEFENSIBLE. Article 15 SSOT BLOCKER: correctly framed. **4 new issues introduced (N1-N4)**. **Phase 2/3 ready: NO** — needs N1 + §6.5/M0 gates. **Top issue (§8): N1 contradiction.** r3 integrates: N1 RESOLVED (§3.1.2.1.1 Option C versioned binding); N2 RESOLVED (4→6 surfaces with provenance split); N3 RESOLVED (§3.6.1 `telepty-list-json/v1` schema); N4 ADOPTED VERBATIM (§3.1.2.2 grammar); §6.5/M0 gates RESOLVED (§6.5.1 9-gate testable spec + canonical M0 audit script); 3 prior-fix re-verifications DEFENSIBLE (§3.5.5).
  - **gemini r2 re-review**: NOT REQUESTED (r2 architect lean: skip). r3 preserves the same skip permissibility — boundary direction remains invariant per r2/r3 hard rule.
- **Self-check**: 7-item rubric per `~/projects/aigentry-architect/CLAUDE.md` §6 — all PASS (see §13).
- **Cross-LLM re-review recommendation (r3)**:
  - **codex** — RECOMMENDED. r3 directly addresses every codex r2 finding (4 new issues + N1 + §6.5/M0 gates) plus re-verifies the 3 prior carry-overs. Estimated re-review scope: §3.1.2.1.1, §3.1.2.2, §3.5.4, §3.5.5, §3.6 stability provenance, §3.6.1, §6.5.1, §8 M0, §9 r3 cleanup note, §11.3.
  - **gemini** — OPTIONAL (architect lean: skip). gemini r1 ACCEPT was based on industry alignment of boundary direction; r3 preserves direction unchanged (hard rule). Re-review delivers low marginal information unless protocol detail is in scope.
- **Review threshold**: 2 (T2 per `references/frontmatter-schema.md`).
- **Awaiting**: aigentry-orchestrator-claude routes user signoff; on acceptance, `status: proposed` → `status: accepted`, frontmatter `accepted_date` + `accepted_by` populated.
- **Cross-LLM dispatch decision (r3)**: Per dispatch hard rule "Cross-LLM review optional — architect recommends but orchestrator decides post-DONE based on user appetite". r3 **recommends codex re-review** (protocol fidelity check on N1 resolution + gate testability); **gemini skip permissible** (boundary direction preserved). Orchestrator final call.

---

## §13 Architect Self-Check (CLAUDE.md §6 7-item rubric — r3 refresh)

| # | Question | Answer | Evidence (r3) |
|---|---|---|---|
| 1 | Context §1 explains why decision needed? | YES | §1.1 cites triage `30abd73` Phase 2.5; 3 issues blocked. r2 trigger note: codex r1 (e0b528b). r3 trigger added in frontmatter: codex r2 (72f45b9) demanded N1 contradiction resolution + testable §6.5/M0 gates. |
| 2 | Decision §2/§3 has ≥2 alternatives + tradeoffs? | YES | §4 lists 3 alternatives + chosen. r3 §3.1.2.1.1 explicitly compares Option A / B / C for N1 resolution and rationalizes Option C selection vs the other two. |
| 3 | Each alternative cites evidence? | YES | §4 evidence preserved. r3 §3.1.2.1.1 cites codex r2 §5 N1 + §8 verbatim, then evidence-grounds Option A/B rejection (Option A: scope inflation; Option B: invalidates gemini r1 ACCEPT + blocks §6.5 registration). r3 §3.5.4 quotes all codex r2 findings verbatim. |
| 4 | Consequences includes failure modes? | YES | §11.4 (3 anti-patterns) + §11.5 (telepty/devkit/SSOT failure) preserved. r3 §11.3 rewritten to govern (not defer) the [context-ref] 2D version matrix via §3.1.2.1.1. §3.5.5 explicitly re-attests prior fixes (1 waiver / 1 deferral / 1 anti-pattern) remain defensible after r3. |
| 5 | Backward compat analyzed? | YES | §10 preserved + §3.1.2.1.1 explicitly defines wire contract immutability (binding test for v1; v2+ via successor ADR). §3.1.2.2 N4 grammar update is BACKWARD COMPATIBLE — `~/`-prefixed form was already production behavior; r3 only formalizes acceptance. §3.6.1 schema-additive policy preserves existing `telepty list --json` consumers. |
| 6 | Constitution Check filled? | YES | §5 Q1-Q8 preserved. r3 Q8 explicitly strengthened with §6.5.1 testable gates (G1-G9 + canonical M0 audit script) — Article 15 SSOT registration is now mechanically verifiable, not just textually mandatory. |
| 7 | Verification Plan with measurable metrics? | YES | §8 M0-M6 preserved. r3 M0 metric points to §6.5.1 audit script (one-shot pass/fail) — replaces narrative "4 checks" with 9 named gates each with shell verification command. M6 enforces conformance fixture coverage including the new §3.1.2.2 path-token absolute+`~/` cases. |

**r3 specific additions** (in addition to r2 carryover):

- §3.1.2.1.1 N1 resolution via Option C (versioned binding) — wire contract LOCKED in r3; v2+ reserved for Phase 3 successor ADR; Phase 3 may refine implementation details only.
- §3.1.2.2 grammar updated — `path-token = absolute-path / home-relative-path`; receiver contract specifies `~/` → `$HOME/` expansion; both fixture forms required (codex r2 N4 verbatim adoption).
- §3.5.4 codex r2 verbatim quote table (4 new issues + Phase 2/3 readiness gates + top issue + 4 conditions).
- §3.5.5 prior-fix re-verification table (1 WAIVED-OK condition / 1 deferred major / 1 waived anti-pattern — all DEFENSIBLE after r3).
- §3.6 stability provenance table — explicit 3-stable + 3-newly-specified split per codex r2 N2.
- §3.6.1 `telepty-list-json/v1` schema (envelope + 11 fields + 4 fixture paths + SSOT path locked) per codex r2 N3.
- §6.5.1 testable readiness gates — 9 gates G1-G9 with concrete artifact + verification command + pass criterion + canonical M0 audit script per codex r2 §6.
- §8 M0 metric updated to reference §6.5.1 audit script (replaces narrative).
- §9 OQ-1 deleted (was the source of N1 contradiction); r3 cleanup note explains; remaining OQs renumbered.
- §11.3 deferral language replaced — 2D version matrix now governed by §3.1.2.1.1, not deferred.
- §12 Sign-off — codex r2 review outcomes summarized; r3 cross-LLM recommendation refreshed.

**Self-check: 7/7 PASS** (r3). Ready for codex re-review (recommended); gemini r1 ACCEPT preserved by construction (boundary direction unchanged per r2/r3 hard rule).

### §13.1 Pre-submit Self-Check (CLAUDE.md §6 7-item rubric — r3)

Per CLAUDE.md §6 — 2+ NO triggers self-revision. r3 answers:

1. **Context §1 explains why decision needed?** YES — §1.1 preserved + r3 trigger in frontmatter cites codex r2 72f45b9.
2. **Decision §2/§3 has ≥2 alternatives + tradeoffs?** YES — §4 preserved; §3.1.2.1.1 explicitly compares Option A/B/C for N1 with eviction rationales.
3. **Each alternative cites evidence?** YES — §4 + §3.1.2.1.1 cite codex r2 §5 N1 + §8 verbatim; gemini r1 ACCEPT cited as Option B eviction rationale.
4. **Consequences §11 has failure modes?** YES — §11.4 + §11.5 preserved; §11.3 rewritten to govern (no deferral); §3.5.5 re-verifies 3 prior carry-overs DEFENSIBLE.
5. **Backward compat §10 analyzed?** YES — §10 preserved; §3.1.2.1.1 defines wire-contract immutability; §3.1.2.2 N4 grammar update is backward compatible (formalizes existing prod form); §3.6.1 schema-additive preserves consumers.
6. **Constitution Check §5 filled?** YES — Q1-Q8 preserved; Q8 §6.5 BLOCKER now mechanically testable via §6.5.1.
7. **Verification Plan §8 measurable?** YES — M0 now cites §6.5.1 9-gate audit script; M6 covers §3.1.2.2 fixture forms.

**Result**: 7/7 PASS. r3 ready for orchestrator routing + recommended codex r3 re-review.

---

## §14 Related

- **Triage**: `~/projects/aigentry-architect/docs/triage/2026-05-04-telepty-issues-triage.md` (commit `30abd73`)
- **Constitution**: `~/projects/aigentry/docs/CONSTITUTION.md` Articles 1, 3, 4, 9, 15, 17
- **Telepty repo philosophy**: `~/projects/aigentry-telepty/{AGENTS.md, CLAUDE.md}`
- **Devkit repo philosophy**: `~/projects/aigentry-devkit/{AGENTS.md, CLAUDE.md}`
- **Architect references**: `~/projects/aigentry-architect/references/{adr-template.md, frontmatter-schema.md, constitution-check.md, reviewer-matrix.md, review-automation.md}`
- **Worked-example ADR (style reference)**: `~/projects/aigentry-orchestrator/docs/adr/2026-05-04-phase6-conclusion.md`
- **Telepty issues unblocked on acceptance**: gh #8, #10 (sub #10.2), #3
- **Supersedes**: none (first boundary ADR for this pair)
