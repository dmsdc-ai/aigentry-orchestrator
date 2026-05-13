# ADR — cwd/role decoupling + immutable SessionContext for infinite-depth agent hierarchy

Date: 2026-05-12
Status: proposed (r2-patched — codex r2 verification minor fixes applied)
Author: E-architect-adr-mf
Reviewers: codex (ACCEPT_WITH_MAJOR_FIXES, 9 binding issues — `docs/reports/2026-05-12-adr-mf-codex-review-r1.md`); gemini (ACCEPT_WITH_MINOR_FIXES, 3 industry-comparison additions — `docs/reports/2026-05-12-adr-mf-gemini-review-r1.md`)
Supersedes: parts of AGENTS.md Rule 4 (orchestrator-only spawn — relaxed per Q-R-B Yes; rules.md edit deferred to Migration §6 task)

---

## 1. Context

- **Today's incident (2026-05-12).** A sub-session spawned in `aigentry-orchestrator/` cwd auto-loaded the orchestrator's `CLAUDE.md` / `AGENTS.md`, assumed orchestrator identity, and refused the dispatched architect task. The cwd literally inserted a role.
- **Multi-LLM deliberation (2026-05-11, session `cwd-role-architectur-mp11lo7l28np`, 3 rounds).** Verdict: **UNANIMOUS [AGREE]** across codex (R1/R2/R3) and gemini (R1/R2/R3); claude self-skipped per orchestrator identity rule. Synthesis: adopt F3 direction *reframed* as a **metadata-first, immutable session contract** — not a document-splitting hack. Source: `state/aigentry-orchestrator/archive/deliberation-2026-05-11T1015-cwd-role-architecture-for-infi.md` + `.contract.json` (`structured_synthesis_hash: c261fd0d7f6599bfb4f1b05cd5fc8b9e769f5214`).
- **V1+V4 mechanism verification (2026-05-12, `/tmp/aigentry-v1v4-test/report.md`).** Confirmed empirically:
  - V1: `RECURSIVE_FAIL_FINAL` — the native `Agent` tool is orchestrator-only; max native depth = 2 (orchestrator → L2). Tested across 5 `subagent_type` variants. No `tools=` parameter on Agent calls; no prompt-level bypass.
  - V4a: cwd `CLAUDE.md` / `AGENTS.md` **NOT inherited** by L2 sub-agents (only `~/.claude/CLAUDE.md` global is inherited).
  - V4b: parent conversation transcript **NOT inherited** by L2 sub-agents.
  - V4c: cwd **IS inherited** (sub-agent runs in same cwd as parent).
  - V4d: tool permissions = **strict subset** of parent (MCP servers inherited via deferred ToolSearch; `Agent` excluded).
  - Q-V (bypass): `NO_BYPASS` for in-band Agent recursion; `BYPASS_AVAILABLE_VIA_MCP` only as *out-of-process quasi-L3* (architecturally equivalent to L1 tree).
- **Locked design decisions (user-confirmed, 2026-05-12).** Q1 goal = all-of-four; Q2 depth = theoretical unbounded; Q3 unit semantics = L1/L2/L3 per dispatch §"Background"; Q4 = multi-tenant evolvable from day one; Q5 = general architecture gap; Q6 = session branching mechanism is the missing capability; Q7 = context-appropriate allocation + correct processing + on-demand activation; **Q-R-B = (a) Yes** (L1 tree recursion allowed; Permission Manager + Rule 4 amendment required); **Q-F1F3 = (c) F1+F3** (both dispatch prelude AND `CLAUDE.md` / `CLAUDE-ORCHESTRATOR.md` split); limits = DEFERRED per user.
- **Constitutional anchors.** Article 1 (경량), Article 3 (역할 — cwd → role inference forbidden), Article 17 (무의존). Rule 30 (Operational Autonomy) governs runtime handling of validation rejections.

This ADR is the **agent-hierarchy contract** for the aigentry ecosystem. It is orthogonal to the L1 transport-layer ADR (V1 Q'''-bis) and the supervisor kill-gate spec (SPEC-C3 r1) — both referenced in §9, neither redesigned here.

---

## 2. Problem statement

The ecosystem requires **unbounded-depth agent hierarchies** for: 1-person automation + multi-agent collaboration + AI tree-search + ecosystem self-evolution (Q1, Q2). Current behavior fails this requirement in three concrete ways:

1. **cwd-driven role inference** ("spooky action at a distance"). A session running in `aigentry-orchestrator/` is treated *as* the orchestrator because the CLI auto-loads cwd-local `CLAUDE.md` / `AGENTS.md`. This is path-based behavioral inheritance — exactly the failure mode AutoGen/LangGraph research identifies at depth > 2 (gemini R1 findings).
2. **Implicit parent-role inheritance.** No spawn API gate exists. A child of the orchestrator inherits orchestrator behavior simply by being spawned in the same cwd or by not explicitly overriding role. Depth > 1 amplifies this drift.
3. **No native recursion.** V1 verification proves L3+ native recursion is mechanically impossible inside the `Agent` tool. Infinite depth must therefore be achieved by an **L1 tree** — but every L1 spawn is a fresh top-level CLI process with no implicit context inheritance (V4b). Every context element must be explicitly serialized into the spawn payload.

The architecture must:

- Decouple **cwd** (code scope) from **role** (behavioral contract) at every depth, with zero inference between them (Article 3, deliberation decision 1).
- Make role explicit and validated at every spawn boundary (deliberation decisions 2 + 3).
- Persist resolved context as an **immutable snapshot** at spawn time so children inherit from metadata, not ambient cwd (deliberation decision 5).
- Support **L1 tree recursion** (Q-R-B Yes), which requires relaxing the current orchestrator-only spawn rule (AGENTS.md Rule 4) and introducing a Permission Manager.
- Remain compatible with the empirically-confirmed L2/L3 isolation properties (V4) — the architecture exploits the fact that there is little ambient context to fight against.
- Be evolvable from single-user (dykim) to multi-tenant public (Q4) without architectural change.

---

## 3. Forces and constraints

| # | Force / constraint | Source | Implication |
|---|---|---|---|
| F1 | cwd ≠ role at any depth | Constitution Article 3 + today's incident | No cwd → role inference; spawn API must require explicit role. |
| F2 | No external library dependencies in architecture | Constitution Article 17 | Resolver, snapshot, permission manager = local code; backing storage = markdown. |
| F3 | No over-engineering | Constitution Article 1 | Contract-level only; no new framework. Native-first per user lock. |
| F4 | Orchestrator does not run code | AGENTS.md Rule 1 + Rule 4 | Validation engine runs *inside* the spawn API path of L1 launchers (telepty/cmux/CLI), not as an orchestrator-side service. |
| F5 | L3 native recursion fails | V1V4 report §V1 (`RECURSIVE_FAIL_FINAL`) | Depth ≥ 3 lives in **L1 tree** only. ADR must not design L3 inside L2. |
| F6 | L2 sub-agents context-isolated except cwd | V1V4 report §V4 | Spawn API enforcement is L1-only; L2 inherits SessionContext via prompt-string serialization. |
| F7 | cwd MD auto-load is the leak | Today's incident + V4a | L1 process boot must disable cwd MD auto-discovery; ambient autoload OFF. |
| F8 | Q-R-B Yes (R-B = (a)) | User decision 2026-05-12 | Rule 4 amendment + Permission Manager required. |
| F9 | Q-F1F3 (c) — both F1 + F3 required | User decision 2026-05-12 | Dispatch prelude AND `CLAUDE.md`/`CLAUDE-ORCHESTRATOR.md` split; neither alone sufficient. |
| F10 | Multi-tenant evolvable from day one | Q4 lock | Snapshot schema must allow tenant_id extension without rewrite. |
| F11 | Limits deferred | User instruction | No depth limit / fan-out limit / lifetime limit in this ADR. Future work in §8 Q-OPEN-3. |
| F12 | Operational autonomy | Rule 30 | Spawn validation rejections are handled by orchestrator self-correction, not user prompts. |
| F13 | Native-first | Dispatch §"Locked design decisions" | claude/codex/gemini native capabilities used wherever possible; resolver layers are markdown loads, not a templating language. |
| F14 | MCP servers inherited at L2 | V4d | Quasi-L3 via MCP-deliberation is the *out-of-process* path; architecturally collapses to L1 tree (§5.3). |
| F15 | `~/.claude/CLAUDE.md` is global, inherited | V4a | Snapshotted into the `common` layer source set at digest time (per §4.5); content is captured via `source_path` + `content_sha256` + `read_at` and is no longer ambient or out-of-scope. |

---

## 4. Decision

### 4.1 Three-axis separation (cwd / role / task)

The architecture rests on three **orthogonal** axes:

- **cwd** — *where* code lives. Filesystem location. Inherited by children by reference (V4c).
- **role** — *how/why* the session behaves. Behavioral contract. NEVER inferred from cwd (deliberation decision 1; Article 3).
- **task** — *what now*. The per-spawn directive (the dispatch file body). Bounded to a single spawn.

**Invariant:** mutation of one axis must not mutate another. Changing cwd does not change role; changing role does not move files; changing task does not redefine the role contract. This invariant is the structural answer to "spooky action at a distance" (deliberation §Why-not, gemini R1, AutoGen/LangGraph empirical).

### 4.2 SessionContext immutable snapshot schema

A **spawn** in this ADR is defined as either:

- an **L1 process spawn** (a new top-level CLI process — telepty session, cmux workspace, MCP-launched external CLI, direct CLI invocation); or
- an **L2 Agent call** (a native `Agent` tool invocation inside an existing L1 session).

Both produce a SessionContext-class record. The L1 record is the full schema below; the L2 record is the lightweight subset specified in §4.2.1. This resolves the r1 ambiguity flagged by codex (every spawn = snapshot, but L2 has no separate process). The "every spawn = snapshot" invariant holds at both layers via two record shapes sharing identity + lineage + digest fields.

**Full L1 schema (contract level — concrete typing in Migration §6 task #3):**

```
SessionContext (L1) {
  schema_version          : int           # for forward-compat migration
  session_id              : string        # globally unique; collision = reject (G6)
  parent_session_id       : string?       # null only for the root orchestrator
  parent_agent_id         : string?       # null iff parent is L1; set iff parent is L2 Agent record
  depth_layer             : enum {L1}     # L1 records always L1; L2 records use the §4.2.1 shape
  cwd                     : canonical_path (POSIX absolute, NFC-normalized, no trailing slash)
  project_id              : string        # derivation rule: §4.4.1
  role                    : enum (sawp.md role catalog; see §9.5)
  parent_role             : enum?
  role_override           : bool          # true iff role ≠ parent_role
  role_override_reason    : string?       # required iff role_override = true
  instruction_layers      : { common, project, role, task }   # each layer = { source_path, content_sha256, read_at }
  effective_prompt        : string        # concatenation of layers per §4.4 with canonical bytes
  effective_prompt_digest : sha256        # canonical-bytes hash; see §4.8 canonicalization
  permissions             : capability_set (subset of parent.permissions; see §4.6 + §4.6.1)
  tenant_id               : string?       # null for single-user (Q4 future extension)
  spawned_via             : enum {telepty, cmux, mcp_deliberation, cli_direct}
  created_at              : ISO-8601 with timezone, microsecond precision
}
```

**Per-layer source identity (codex anti-pattern fix).** Each `instruction_layers.{common,project,role,task}` entry is not just a string but `{ source_path, content_sha256, read_at }`. This makes digest audits robust to subsequent file edits: the snapshot records *which file at which content hash* the resolver consumed, not just the prompt text.

#### 4.2.1 L2 Agent record (lightweight child of an L1 snapshot)

L2 Agent calls produce a **child record** persisted under the parent L1 snapshot's lineage. This satisfies "every spawn = snapshot" without inventing a fake process boundary.

```
AgentRecord (L2) {
  schema_version          : int
  agent_id                : string        # globally unique
  parent_session_id       : string        # mandatory — must point to a persisted L1 record
  parent_role             : enum          # mirror of L1.role at spawn time
  role                    : enum          # the Agent's effective role (sawp.md catalog)
  role_override           : bool
  role_override_reason    : string?       # required iff role_override = true
  task_id                 : string        # opaque, parent-assigned
  task_prompt_digest      : sha256        # canonical-bytes hash of the Agent-call prompt string
  permissions             : capability_set (subset of parent.permissions)
  subagent_type           : string        # `general-purpose`, `Explore`, `Plan`, etc.
  spawned_via             : enum {agent_tool}
  created_at              : ISO-8601
}
```

L2 records carry no `effective_prompt` of their own — V4b confirms parent conversation is not inherited and V4a confirms cwd MD is not inherited, so the Agent-call prompt **is** the effective prompt for the L2 child. Identity (`agent_id`), lineage (`parent_session_id` → L1 snapshot), role contract, and digest reproducibility are preserved. Permissions enforcement (G5) is parent-side prompt validation per §4.3 class B; there is no child-process gate to enforce.

**Immutability (both shapes):** once written, both L1 and L2 records are append-only. Corrections = new record with explicit parent linkage. No in-place mutation. The `effective_prompt_digest` (L1) and `task_prompt_digest` (L2) guarantee reproducibility — re-running the resolver against the same backing-storage state must produce the same digest, or the record is invalid (deliberation decisions 4 + 5; codex R3 sketch; gemini R3 OCI/K8s Pod-spec parallel + Temporal event sourcing — gemini R1 finding 2).

### 4.3 Spawn validation — three enforcement classes (G1–G6)

The r1 framing of "a single gate" is **not implementable** as stated (codex Issue 1). V1 proves native `Agent` calls have no `tools=` bypass and no child-process boundary for an external gate to attach to; §4.2.1 now models L2 as a parent-side record; MCP-launched participants run out-of-process under a server we may or may not control. The gate logic therefore splits into **three enforcement classes**. The G1–G6 invariants are uniform; the *mechanism* differs per class.

**Enforcement classes:**

- **Class A — L1 process spawn gate.** Surfaces: `telepty` session creation, `cmux` workspace spawn, `cli_direct` invocation, and MCP-launched external CLI processes (where the wrapper can intercept the launch). Full G1–G6 enforcement at the process boundary — the gate is a wrapper around CLI process creation that refuses to launch the child process if any gate fails.
- **Class B — L2 native Agent prompt validator.** Surface: native `Agent` tool calls from inside an L1 session. The Agent call has no separate child process; V1 confirms no bypass to inject a gate. Enforcement is therefore **parent-side validation before the Agent call**: the parent L1 session computes the would-be AgentRecord (§4.2.1), runs G1–G5 over it, persists the record (G6), *then* invokes the Agent tool. If any gate fails, the parent must not invoke the Agent tool. (Implementation: a thin library that wraps the Agent-call site, e.g., `validateAndSpawn(parent, agentSpec)` → returns gated `Agent` parameters or throws.)
- **Class C — MCP / cmux external launcher adapter.** Surface: MCP-deliberation participant spawn (and any future MCP server that launches CLI processes). The gate lives at the MCP server / launcher mediation layer: the server requires SessionContext-class metadata in its launch request, refuses launches with missing/unknown role, propagates Permission Manager capability subset rules, and persists the L1 snapshot before launching. Where the MCP server does not yet support this (today's `mcp__deliberation__*` family), participants are **quasi-L3 with degraded metadata trail** — they launch successfully but are logged as "ungated" in lineage (see §5.3). Phase 2 work (Migration §6 task #15) extends the deliberation MCP to honor SessionContext.

**Surface → class mapping:**

| Surface | Class | Mechanism location |
|---|---|---|
| `telepty` session create | A | telepty CLI / daemon launch path |
| `cmux` workspace spawn | A | cmux session-create flow |
| `cli_direct` invocation | A | `aigentry` CLI wrapper (Migration §6 task #15) |
| `agent_tool` (native Claude `Agent`) | B | parent L1 session validation library |
| `mcp_deliberation` participant | C | deliberation MCP server (Migration §6 task #15 Phase 2) |

**G1–G6 invariants (uniform across classes):**

- **G1 — role mandatory.** Reject spawns with missing or unknown `role`. No defaulting (deliberation decision 2; codex R1/R2/R3).
- **G2 — parent_role cross-check.** When `parent_session_id` is set, the spawn must declare `parent_role` matching the persisted parent snapshot. Mismatch = reject.
- **G3 — role override discipline.** If `role ≠ parent_role`: require `role_override = true` AND `role_override_reason` non-empty (deliberation decision 3; codex R2/R3).
- **G4 — orchestrator-child guard.** When `parent_role = orchestrator`, implicit same-role inheritance is **forbidden** even with R-B Yes; spawning another orchestrator-role child requires the explicit override semantics of G3 (deliberation decision 2 second clause). R-B Yes relaxes *who may spawn*, not *what may be implicitly inherited*.
- **G5 — capability subset.** Child `permissions ⊆ parent.permissions`. The Permission Manager (§4.6) enforces; per-CLI mapping in §4.6.1.
- **G6 — digest precommit.** The would-be SessionContext (L1) or AgentRecord (L2) is canonicalized, hashed, and persisted to durable storage **before** the child is launched (process for Class A/C, Agent-tool invocation for Class B). A failed persist (lock contention, disk error, atomic-rename failure) must fail the spawn (immutability prerequisite). Persistence protocol in §4.8.

**Rule 30 alignment.** Rejected spawns are operational issues. The parent (or the gate wrapper) surfaces the rejection to the orchestrator's autonomous self-correction loop per Rule 30 — not to the user prompt.

**Class B caveat (codex Specific-to-implementability point).** Class B enforcement is *parent-side*. A malicious or buggy parent that bypasses the validation library and invokes the Agent tool directly would succeed at the harness level; V1 proves there is no out-of-band way to gate the `Agent` tool. The architectural answer is: Class B integrity rests on parent honesty + lint coverage (Migration §6 task #15 includes lint integration). This is the same trust model as any in-process capability system (e.g., a process choosing to honor a permission check it could syscall around). The escalation path — if a parent is suspected of bypassing — is supervisor kill (SPEC-C3 r1, §9.2).

### 4.4 Deterministic layered resolver

The effective prompt for any session is the deterministic concatenation of four layers, **in this order**:

1. **common** — universal runtime/location rules. Backing storage: `CLAUDE.md` (post-split) at repo root.
2. **project** — repo-specific rules. Backing storage: a project-level instruction file (TBD in Migration §6 task #4).
3. **role** — role-specific behavioral contract. Backing storage: `CLAUDE-ORCHESTRATOR.md` (orchestrator role) and `instructions/roles/{role}.md` for other roles.
4. **task** — per-spawn directive. Backing storage: the dispatch file at an absolute path, referenced by the spawn payload.

**Resolver contract (deliberation decision 4):** files are *backing storage*, not architecture. The layer mapping is the contract; re-organization of files cannot break the architecture as long as the layer-to-file mapping is preserved. This matches K8s/OPA/Helm separation of declaration from instantiation (gemini R3) and OCI immutable-layer composition (gemini R3).

**Concatenation protocol (codex §4.4 finding):**

- **Delimiter.** Layers are joined by exactly `"\n\n---\n\n"` (two newlines, a markdown thematic break, two newlines). This is a stable, parser-visible separator so audits can split the effective prompt back into its source layers.
- **Newline canonicalization.** Each layer is loaded, normalized to LF newlines (CRLF → LF), trimmed of trailing whitespace per line, and terminated with exactly one LF. UTF-8 NFC normalization is applied. No BOM. See §4.8 canonicalization rule.
- **Missing-file behavior.** A missing layer file is **not** silently treated as empty. The resolver fails the spawn (G6 fails) and the gate rejects per Class A / B / C. The only exception is the `project` layer, which is optional iff `project_id` resolves to "none" (rare; see §4.4.1).
- **Duplicate / conflicting instructions across layers.** No automatic merge or override semantics. Layers are concatenated verbatim in the deterministic order; conflicting prose between layers (e.g., `common` says X, `role` says ¬X) is the role-layer author's responsibility to resolve at authoring time. The ADR explicitly rejects later-layer-overrides semantics because markdown prose cannot be reliably diffed for "override" intent. A lint task (Migration §6 task #7) flags suspicious conflicts.

#### 4.4.1 project_id derivation

`project_id` is derived **deterministically** from cwd at spawn time:

1. Walk parents of cwd until a directory containing one of: `.aigentry/project.json`, `AGENTS.md`, `CLAUDE.md`, or `.git/` is found.
2. If `.aigentry/project.json` exists, its `project_id` field is authoritative.
3. Else, the basename of that ancestor directory is `project_id`.
4. If no such ancestor exists, `project_id = "none"` and the `project` layer is skipped.

This derivation is canonical (G6 digest input) and cwd-bound. Two sessions with the same cwd resolve to the same `project_id`.

**Why deterministic ordering matters:** stable order + digest is what makes the snapshot auditable. Any spawn whose digest cannot be reproduced is invalid (deliberation decision 5; codex R3 code sketch §3-5).

### 4.5 Process boot — ambient autoload OFF

For L1 sessions spawned through the Class A or Class C gates (§4.3):

- **CLAUDE.md / AGENTS.md auto-discovery from cwd is DISABLED at process boot.** The CLI launches with the resolver-produced `effective_prompt` as the *only* prompt source.
- **Global `~/.claude/CLAUDE.md` policy (r1 ambiguity resolved per codex §1 + Anti-patterns).** Global CLAUDE.md *is* an ambient instruction channel — leaving it "out of scope" reintroduces the very leak this ADR closes. **Decision:** the spawn adapter snapshots `~/.claude/CLAUDE.md` (and equivalent global instruction files for other CLIs) into the `common` layer source set at digest time, recording `source_path` + `content_sha256` + `read_at` per §4.2. The global file *is* loaded — its content is just no longer ambient; it is part of the auditable layer trail. CLIs that cannot suppress global autoload (Claude `--bare` retains the suppression but skips global — see §4.5.1) get their global file content prepended to the resolver-produced prompt by the adapter, with the same `source_path` / `content_sha256` capture.
- **Today's incident is structurally prevented** by this clause. A session in `aigentry-orchestrator/` cwd will not load `aigentry-orchestrator/CLAUDE.md` or `AGENTS.md` unless that file is the configured backing storage for the `common` or `project` layer for that session's `role`.
- For L2 sub-agents (Class B): V4a confirms cwd MD is not inherited and V4b confirms parent conversation is not inherited. Spawn-API enforcement is parent-side prompt validation (§4.3 Class B). L2 records inherit SessionContext via prompt-string serialization (§5.2).

#### 4.5.1 Per-CLI boot adapter matrix

Declarative "autoload OFF" is insufficient — concrete per-CLI invocation contracts are required (codex Issue 2). The adapter strategy per CLI:

| CLI | Cwd-MD autoload suppression | Recommended invocation | Global MD policy | Fail-closed startup self-test |
|---|---|---|---|---|
| **Claude** (claude-code) | `--bare` flag — confirmed locally to skip CLAUDE.md auto-discovery | `claude --bare --system-prompt-file <effective_prompt> --settings <settings> --allowedTools <tools> --mcp-config <mcp>` (final flag set TBD in Migration §6 task #13) | `--bare` skips global; adapter prepends global content into `effective_prompt` per §4.5 decision | After boot, child sends `READY <digest>` — adapter compares to expected `effective_prompt_digest`; mismatch = kill + log |
| **Codex** | No `--bare` equivalent observed in local `codex --help`. Adapter strategy: env-var (`CODEX_NO_CONTEXT_AUTOLOAD=1` if supported), OR launch from a **scratch control cwd** (§4.5.1.1) that contains no Codex context files | Wrapper launches `codex` from a scratch control cwd (e.g., `/tmp/<sid>-control/`); the SessionContext code-scope cwd is passed via Codex's native include-dir / project-root mechanism (e.g., `--cd`, or equivalent — adapter MUST verify the flag exists and works before declaring the adapter ready). Final invocation shape TBD in Migration §6 task #13 | Adapter snapshots Codex's global context file (path TBD) into `common` layer prefix | `READY <digest>` self-test; abort if non-empty `commands/` directories or other context files were nevertheless loaded |
| **Gemini** | Same gap as Codex. No `--bare` equivalent observed. Same scratch-control-cwd strategy (§4.5.1.1) with env-var suppression if available | Wrapper launches `gemini` from a scratch control cwd; SessionContext code-scope cwd passed via Gemini's native workspace-root / add-dir mechanism (e.g., `--workspace-root`, or equivalent — adapter MUST verify the flag exists and works before declaring the adapter ready). Final shape TBD in Migration §6 task #13 | Adapter snapshots Gemini's global context file into `common` layer prefix | `READY <digest>` self-test; abort if non-empty context files were nevertheless loaded |

##### 4.5.1.1 Scratch control cwd vs SessionContext.cwd (axis separation)

The **scratch control cwd** used by the Codex / Gemini adapters is only a control surface for the adapter to suppress ambient context-file auto-loading — it is **not** the SessionContext `cwd` axis. The SessionContext `cwd` (the code-scope axis from §4.1; the canonical path field in §4.2) is the original component repo or working tree and MUST be exposed to the CLI via the CLI's **native include-dir / add-dir / project-root mechanism** (Codex `--cd` or equivalent; Gemini `--workspace-root` or equivalent — adapter MUST verify the flag exists and works before declaring the adapter ready).

If a target CLI lacks a mechanism to accept a code-scope cwd separate from its process cwd, the adapter MUST **fail closed**: refuse the spawn and surface `ERR_BOOT_ADAPTER_UNSUPPORTED` per Rule 30. Two-axis confusion (collapsing scratch control cwd into the SessionContext.cwd axis) is rejected.

For Claude, this concern does not arise: `--bare` suppresses cwd-local auto-discovery without changing the process cwd, so SessionContext.cwd == process cwd is preserved.

**Version-drift behavior (codex §7 + Anti-patterns).** A future Claude / Codex / Gemini version may change instruction-loading semantics. Each adapter ships with a **CLI-version pin range** + a **startup self-test**: at boot, the child emits a deterministic prompt-digest acknowledgment; the adapter compares against the expected `effective_prompt_digest`. Mismatch → adapter logs an `adapter-version-drift` event (per-spawn, per-CLI-version), kills the child, and reports per Rule 30. The ADR explicitly treats CLI ambient-loading behavior as an external surface — Article 17 compliance via fail-closed adapters, not via assumed behavior (codex Constitution alignment note).

**Class B (L2 Agent) note.** Class B has no process boot to gate. The "boot" equivalent is the validation library wrapping the Agent call (§4.3). No CLI flag is needed for L2 because V4a/V4b already isolate the ambient channels empirically.

### 4.6 L1 tree recursion (Q-R-B Yes) + Permission Manager

**Q-R-B = (a) Yes.** Any L1 session with the `spawn` capability may spawn child L1 sessions. The current AGENTS.md Rule 4 restriction ("직접 수행 금지" — orchestrator-only delegation) is **relaxed** at the architectural level. The Rule 4 amendment (Migration §6 task #2) updates the rules document to describe the new gating model:

- The right to spawn is no longer tied to *being* the orchestrator. It is a **capability** carried in `SessionContext.permissions`.
- The Permission Manager governs which roles, by default, carry which capabilities.

**Permission Manager (§4.6 binding scope):**

- Maintains a **role → default capability table** (§4.6.1 below; full implementation in Migration §6 task #8).
- At spawn time, enforces `child.permissions ⊆ parent.permissions` (G5). A child cannot acquire a capability the parent did not have. This aligns with WASI / seL4 capability-based security (gemini R1 finding 1).
- Capabilities at minimum include: `spawn_l1`, `spawn_l2`, `read_fs`, `write_fs`, `bash`, `network`, `mcp_deliberation`, `task_dispatch`. Granularity refinement remains Q-OPEN-2 *for finer-grained capabilities* (e.g., per-MCP-server allowlists, per-domain network rules) — but the minimum table is binding in this ADR.
- **Cycle prevention.** Every spawn walks `parent_session_id` chain; if the proposed child's `session_id` appears in the chain (or any active descendant), reject as a cycle. Cycle detection requires a strongly consistent active-session read (codex Anti-pattern note); the persistence protocol (§4.8) provides this via the index lock.

#### 4.6.1 Capability ↔ CLI adapter table

Capability semantics must map to concrete CLI primitives. Three CLIs have different surface shapes; the adapter table records the enforcement primitive per CLI per capability.

| Capability | Claude (claude-code) | Codex | Gemini |
|---|---|---|---|
| `spawn_l1` | orchestrator role default; spawn API gate (Class A) | same | same |
| `spawn_l2` | `Agent` tool invocation allowed via Class B validator | codex L2 equivalent (TBD per CLI feature parity audit) | gemini L2 equivalent (TBD) |
| `read_fs` | `--allowedTools Read,Glob,Grep` | sandbox file-read policy | policy file-read |
| `write_fs` | `--allowedTools Write,Edit,NotebookEdit` | sandbox file-write policy | policy file-write |
| `bash` | `--allowedTools Bash` (+ optional per-command allowlist) | sandbox exec | policy exec |
| `network` | `--allowedTools WebFetch,WebSearch` + MCP allowlist | sandbox network policy | policy network |
| `mcp_deliberation` | `--mcp-config` allowlist includes `mcp__deliberation__*` family | codex MCP allowlist | gemini MCP allowlist |
| `task_dispatch` | not native; via `telepty inject` from inside session (requires `bash` capability) | same | same |

This table is the **starting** adapter mapping — Q-OPEN-2 is **RESOLVED** by this table at the level of the minimum capability set. Finer-grained refinements (per-MCP-server allowlists, per-domain network policy, per-path filesystem scoping) are tracked as Q-OPEN-2-FOLLOWUP in §8 but no longer block r2 acceptance.

#### 4.6.2 Default role → capability table

| Role | spawn_l1 | spawn_l2 | read_fs | write_fs | bash | network | mcp_deliberation | task_dispatch |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `orchestrator` | ✓ | ✓ | ✓ | ✓ | (subset; per Rule 13 builder delegation) | ✓ | ✓ | ✓ |
| `architect` | (subset — may spawn researcher / grader) | ✓ | ✓ | ✓ (docs only) | — | — | ✓ (for cross-LLM reviews) | ✓ |
| `implementer` / `coder` | — | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `tester` | — | ✓ | ✓ | — | ✓ | — | — | — |
| `builder` | — | — | ✓ | — | ✓ | ✓ | — | — |
| `analyst` | — | ✓ | ✓ | — | — | — | — | — |
| `logger` | — | — | ✓ | — | — | — | — | — |
| `researcher` | — | ✓ | ✓ | — | — | ✓ | ✓ | — |

This table is the **starting point** for Migration §6 task #8. Concrete capability semantics per CLI follow §4.6.1. The role catalog is anchored in sawp.md (§9.5); missing roles (researcher / grader / security-reviewer) are tracked in Q-OPEN-1.

**Depth:** theoretically unbounded per Q2. Practical limits (depth, fan-out, lifetime) are **deferred per explicit user instruction** (F11); they will be added as Permission Manager extensions in a follow-up ADR (Q-OPEN-3) once the system completes its initial deployment. gemini R1 finding 3 (Erlang/Akka supervision-tree analogue) is acknowledged but the user lock takes precedence — see §8 Q-OPEN-3 entry.

### 4.7 Dispatch prelude (F1) + CLAUDE.md split (F3) — combined approach

**Q-F1F3 = (c) F1+F3.** Both required; neither alone is sufficient.

**F1 — dispatch prelude (standard template):** every L1 dispatch file starts with a `## ⚠️ ROLE OVERRIDE (CRITICAL)` block stating, at minimum:

- "You are NOT the orchestrator. You are session `{session_id}`, role = **{role}**."
- The session's effective cwd (and whether it is an isolated tmpdir or shared repo cwd — both supported per §4.5).
- The anti-recursion clause: "Do NOT propose to dispatch this file. This file IS your dispatch. Execute directly."
- A clarification that global instruction content (`~/.claude/CLAUDE.md` and CLI-equivalents) is **snapshotted into the `common` layer by the boot adapter** at digest time (§4.5) — it is not ambient and not auto-loaded by the CLI in r2. Project-local MD files in cwd are NOT the session's role contract.

**F3 — `CLAUDE.md` / `CLAUDE-ORCHESTRATOR.md` split:** `CLAUDE.md` carries only the **common** layer (universal location/runtime rules). `CLAUDE-ORCHESTRATOR.md` carries the orchestrator **role** layer. Other roles get `instructions/roles/{role}.md`. The resolver (§4.4) composes them; the files themselves are not the architecture (deliberation decision 4).

**Why both:**

- F1 alone leaks when a user-typed dispatch forgets the prelude — the session falls back to whatever the CLI auto-loads from cwd.
- F3 alone leaks when the CLI's cwd auto-discovery is still active — a session in `aigentry-orchestrator/` cwd still picks up the orchestrator MD even if the file is named `CLAUDE-ORCHESTRATOR.md`, because nothing tells the session not to.
- F1 + F3 + §4.5 (ambient autoload OFF) together close the leak: the dispatch prelude declares role explicitly, the file split makes the role-layer file role-specific, and ambient autoload off means cwd cannot ambush the session.

### 4.8 Persistence layout + protocol

#### 4.8.1 Storage location (codex Issue 5 — user-global chosen)

Session names are global across repos; multi-repo orchestration is a first-class case (orchestrator spawns into telepty/cmux/MCP across the ecosystem). Repo-local storage would break this. **Decision: user-global** layout under `~/.aigentry/`. (Original dispatch reference `~/.aigentry/sessions/` is the authoritative form; the r1 `state/sessions/` text is corrected here.)

Append-only, on disk:

- `~/.aigentry/sessions/{session_id}/context.json` — the immutable L1 SessionContext snapshot.
- `~/.aigentry/sessions/{session_id}/effective_prompt.md` — the resolved prompt text (for digest reproducibility audits).
- `~/.aigentry/sessions/{session_id}/lineage.json` — materialized `parent_session_id` chain (for tree visualization, cycle detection, operational tools).
- `~/.aigentry/sessions/{session_id}/agents/{agent_id}.json` — L2 AgentRecord snapshots (per §4.2.1) nested under parent L1.
- `~/.aigentry/sessions/index.json` — `session_id` → snapshot directory pointer; the single source of truth for "what sessions exist".
- `~/.aigentry/instructions/` — common / project / role layer backing-storage files (see §4.4).

Repo-local files (`CLAUDE.md`, `CLAUDE-ORCHESTRATOR.md`, etc.) remain in their repos as project/role backing storage — they are *referenced* by `instruction_layers.{layer}.source_path` but not the SSOT for session existence.

#### 4.8.2 Persistence protocol (codex Issue 3)

The r1 layout omitted the durability protocol. r2 binding:

**Canonical bytes (digest input):**

- All snapshot files written as **UTF-8, LF newlines, no BOM, NFC normalization**.
- Embedded JSON written with **sorted object keys** at all nesting levels (deterministic ordering). Equivalent: if the implementation prefers a non-sorted-keys encoding, it must specify and stick to one deterministic ordering, but sorted keys is the default.
- Numbers without trailing zeros (e.g., `1` not `1.0`); ISO-8601 timestamps with explicit `+00:00` offset.
- `effective_prompt_digest = sha256(canonical_bytes(effective_prompt))`. Likewise for `task_prompt_digest`.

**Atomic write (POSIX):**

1. `tmp = <target>.tmp.<session_id>.<pid>`
2. Write content to `tmp` + `fsync(tmp)`
3. `rename(tmp, target)` (atomic on the same filesystem)
4. `fsync(dirname(target))` so the directory entry is durable
5. On error at any step: unlink `tmp`, fail the spawn (G6 fails)

**Atomic write (Windows fallback):** `ReplaceFileW` or `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`. Implementation detail in Migration §6 task #14.

**Index lock:**

- Writes to `~/.aigentry/sessions/index.json` require an exclusive lock: `flock(LOCK_EX)` on POSIX, `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK)` on Windows.
- Lock file: `~/.aigentry/sessions/index.json.lock` (separate file to keep the data file's inode stable across atomic renames).
- Readers are lock-free but must tolerate concurrent writes — the atomic-rename protocol above guarantees readers see either the old version in full or the new version in full, never a torn write.

**Crash recovery:**

- On `aigentry` CLI startup, scan `~/.aigentry/sessions/**/*.tmp.*` and delete (incomplete writes from a previous crash).
- Optional orphan-snapshot detection: snapshot directory exists but has no entry in `index.json` → log as `orphan-snapshot` (do not auto-delete; preserve forensics).

**Concurrent spawn race rule:**

- Two rapid spawns of the same parent: per-parent spawn serialization via a parent-id lock (`~/.aigentry/sessions/{parent_session_id}/spawn.lock`, `flock(LOCK_EX)`). This guarantees cycle detection (§4.6) reads a consistent active-session set.
- Two rapid spawns from different parents: serialized only through the `index.json` lock for the final index update; the snapshot writes themselves are independent.
- Idempotency: if a spawn retries with the same `session_id`, the index-update step detects the existing entry and either no-ops (idempotent retry) or fails with `duplicate session_id` per `Spawn` API contract (TBD in Migration §6 task #3).

#### 4.8.3 Operational properties

- Snapshots are **never mutated**. Corrections = new session with explicit `parent_session_id` link.
- Schema migrations preserve historical readability via `schema_version` field (§4.2). Old records remain valid; readers must handle multiple schema versions.
- GC / pruning policy in §8 Q-OPEN-5 (elevated to **medium priority, pre-public-launch** per gemini-A) — append-only state grows unbounded; Temporal/event-sourcing experience (gemini R1 finding 3 + R3 finding 1) shows this is mandatory before any non-trivial deployment.
- This layout aligns with the Borg/Omega/K8s paper's separation of config-declaration from runtime-instantiation (gemini R3) and Temporal event-sourcing's append-only history (gemini R1 + R3).

---

## 5. Layer-aware application

### 5.1 L1 (telepty session) — full architecture

L1 is where the entire spawn API applies in full:

- Each telepty session corresponds to exactly one SessionContext snapshot, written at spawn time.
- The `effective_prompt` is injected as the session's prompt; the CLI is launched with ambient cwd MD autoload OFF (§4.5).
- Permission Manager enforces G5 capability subset.
- **Q-R-B Yes:** any L1 session may spawn child L1 sessions, gated by its `permissions` and the G1–G6 gates.
- L1 tree recursion is the **sole** infinite-depth path (Q-V (a); F5). Depth ≥ 3 is achieved here.

### 5.2 L2 (CLI native Agent) — isolated by V4; gated by Class B validator; lightweight AgentRecord persisted

L2 sub-agents (the `Agent` tool inside a single CLI session) are empirically context-isolated by V4:

- V4a: cwd `CLAUDE.md` / `AGENTS.md` are **not** auto-loaded into L2.
- V4b: parent conversation transcript is **not** inherited.
- V4d: tool surface is a strict subset (`Agent` itself excluded — see §5.3).
- V4c: cwd is shared with the parent.

**Spawn contract (r2 resolution of r1 contradiction — codex Issue 6, Option B chosen):**

- Every L2 Agent call produces a lightweight **AgentRecord** (§4.2.1) — `agent_id`, `parent_session_id`, role / role_override / role_override_reason, `task_prompt_digest`, permissions, `subagent_type`. This preserves the "every spawn = snapshot" invariant uniformly and gives L2 calls a place in the lineage tree.
- The AgentRecord carries **no separate `effective_prompt`** — the Agent-call prompt **is** the effective prompt (V4a/V4b confirm there's nothing else). The parent serializes the relevant SessionContext fields (role, parent_role, role_override_reason, task) into the prompt string per the dispatch "ROLE OVERRIDE" pattern.
- Enforcement is **Class B** (§4.3): the parent runs G1–G5 over the would-be AgentRecord, persists it (G6 — to `~/.aigentry/sessions/{parent_session_id}/agents/{agent_id}.json`), then invokes the Agent tool. If any gate fails, the parent does not invoke the Agent tool. This is parent-side validation; there is no child-process gate (V1 `RECURSIVE_FAIL_FINAL` — no `tools=` parameter, no bypass).
- The L1 parent's permissions are the upper bound on the L2 child's (G5). Capability semantics map per §4.6.1 (e.g., the parent setting `subagent_type` + the resulting tool subset reflects the capability mapping for `read_fs` / `bash` / etc.).

Spawn-API enforcement at L1 (Class A) + parent-side validation at L2 (Class B) together prevent role drift at L2, because L2 carries no ambient context to drift from (V4) and the validation library refuses to invoke `Agent` without a valid AgentRecord.

### 5.3 L3 — L2 native fail; collapse to L1 tree; MCP gate integration

- V1 verdict `RECURSIVE_FAIL_FINAL`: the `Agent` tool is **not** in any tested L2 sub-agent's toolset (`general-purpose`, `Explore`, `Plan`, `superpowers:code-reviewer`, `codex:codex-rescue`). No bypass via `tools=` parameter (none exists on Agent calls), no bypass via prompt-level assertions, no bypass via subagent_type variant.
- Q-V-3 finds MCP-mediated spawning *is* possible from L2 (an L2 sub-agent may invoke `mcp__deliberation__deliberation_start` and have a participant CLI session launched out-of-process). The spawned participant is a fresh top-level CLI process with its own initial context. Architecturally, **it is an L1 spawn initiated from inside L2.**
- **Therefore:** depth ≥ 3 is *always* L1 tree, never in-process L2 recursion. This ADR does not design L3-within-L2 because L3-within-L2 does not exist. L3 = L1 tree at depth 3.

**MCP gate integration (codex Issue 9, Class C surface):**

The deliberation MCP server is the launcher of the L1 process here, so the gate must live in the server. Two phases:

- **Phase 1 (today, transitional).** The current `mcp__deliberation__*` server does not yet require SessionContext-class metadata. Participants spawned through it run successfully but their L1 SessionContext is created in **"ungated" mode**: the `aigentry` wrapper around the MCP-launched CLI fills in best-effort metadata (parent_session_id = the deliberation session ID, parent_role inferred from the speaker that invoked the spawn, role_override_reason = `"mcp_deliberation_phase1_transitional"`), persists the snapshot, and tags it `gating_status = "ungated"` in `lineage.json`. This is logged-but-permitted operation. Forensic reconstruction is preserved at a degraded fidelity.
- **Phase 2 (Migration §6 task #15).** Extend the deliberation MCP server to require SessionContext metadata in its launch request (mandatory `parent_session_id`, `parent_role`, `role_override_reason`). Server-side validation runs G1–G6 before launching the participant CLI; failed validation rejects the launch. After Phase 2, MCP-launched participants are fully Class C gated, and `gating_status = "ungated"` lineage entries become legacy-only.

The same pattern applies to any future MCP server that launches CLI processes — see §6 task #15 for the integration template.

---

## 6. Migration path

The 8 deliberation-contract tasks (2026-05-11 synthesis, `structured_synthesis_hash: c261fd0d7f6599bfb4f1b05cd5fc8b9e769f5214`) are inherited verbatim. Today's Q-R-B Yes + Q-F1F3 decisions + r2 codex findings add seven new tasks (#2, #7, #8, #12, #13, #14, #15). Sequencing aims for warn-mode → enforcement, matching deliberation decision 7 (staged rollout). The `blockedBy` column records hard ordering dependencies.

| # | Task | Source | Priority | `blockedBy` | Files (initial) |
|---|---|---|---|---|---|
| 1 | Write this ADR (r1 → r2) | Deliberation #1 | high | — | `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` (this file) |
| 2 | **Rule 4 amendment** — document the capability-gated spawn model; reference Permission Manager | NEW (Q-R-B Yes) | high | #8 (hard enforcement); policy *draft* may begin earlier | `docs/rules.md` Rule 4; `AGENTS.md` checklist row 1 |
| 3 | Define `SessionContext` (L1) + `AgentRecord` (L2) + `SpawnRequest` types + validation | Deliberation #2 | high | #1 | `src/session/types.ts`, `src/session/validate-spawn.ts` |
| 4 | Deterministic resolver: common → project → role → task; per-layer source identity; canonical bytes; produce `effective_prompt` + `sha256` digest | Deliberation #3 | high | #3 | `src/session/resolve-instructions.ts`, `~/.aigentry/instructions/common.md`, `~/.aigentry/instructions/roles/{orchestrator,architect,implementer,tester,builder,analyst,logger,researcher}.md` |
| 5 | Persist immutable snapshot at spawn time (atomic write, index lock, crash recovery — depends on #14) | Deliberation #4 | high | #3, #14 | `src/session/persist-context.ts`, `~/.aigentry/sessions/` |
| 6 | Migrate `CLAUDE.md` + `CLAUDE-ORCHESTRATOR.md` content into common + role-orchestrator layers. **No symlinks back to role-heavy files until #13 boot suppression is active** (anti-leak — codex Anti-pattern note) | Deliberation #5 | medium | #4, #13 | `CLAUDE.md`, `CLAUDE-ORCHESTRATOR.md`, `~/.aigentry/instructions/common.md`, `~/.aigentry/instructions/roles/orchestrator.md` |
| 7 | **Dispatch prelude (F1) standard template + generator + lint** | NEW (Q-F1F3) | medium | #1 | `tooling/dispatch-prelude/` (template + generator + linter) |
| 8 | **Permission Manager**: role → capability table (§4.6.2) + adapter table (§4.6.1) + subset-propagation enforcement; cycle detection | NEW (Q-R-B Yes) | high | #3 | `src/session/permissions.ts`, `~/.aigentry/permissions/` |
| 9 | Warn-mode validation behind a flag + telemetry on rejected spawn patterns | Deliberation #6 | medium | #3, #5, #8 | `src/session/validate-spawn.ts`, `src/telemetry/spawn-events.ts` |
| 10 | Tests: deep parent→child→grandchild role preservation; cwd mutation does not mutate role; orchestrator-children no implicit inheritance; digest reproducibility; cycle detection; per-CLI boot adapter conformance | Deliberation #7 | high | #3, #4, #5, #8, #13, #14 | `tests/session/{spawn-validation,instruction-resolver,deep-hierarchy,permissions,cycle-detection,boot-adapters,persistence-protocol}.test.ts` |
| 11 | Hard-fail flip after compatibility audit; document migration completion | Deliberation #8 | low | #9, #10, **Q-OPEN-2 + Q-OPEN-4 acceptance** | `src/session/validate-spawn.ts`, this ADR's §11 changelog |
| 12 | **AGENTS.md surface update** — checklist row 1 (Rule 4) reframed as "spawn-capability-gated" | NEW (Q-R-B Yes, surface only) | medium | #2 | `AGENTS.md` lines 9 + 20–28 area |
| 13 | **Per-CLI boot adapter** (NEW r2 — codex Issue 2): implement Claude `--bare`/global-prepend, Codex/Gemini wrapper strategy, fail-closed startup self-test with version-drift detection | NEW r2 | high | #4 | `src/session/boot-adapter/{claude,codex,gemini}.ts`, `src/session/boot-adapter/self-test.ts` |
| 14 | **Persistence locking / atomicity / canonicalization** (NEW r2 — codex Issue 3): temp-file + fsync + atomic rename, index `flock`, crash recovery (`*.tmp.*` sweep), canonical UTF-8/LF/NFC + sorted-key JSON, concurrent-spawn race rule | NEW r2 | high | — | `src/session/persistence/{atomic-write,index-lock,canonical-bytes,crash-recovery}.ts` |
| 15 | **Gate integration with telepty / cmux / MCP-deliberation / direct CLI** (NEW r2 — codex Issue 1): Class A wrappers for telepty + cmux + cli_direct; Class C extension of deliberation MCP server (Phase 1 ungated transitional → Phase 2 SessionContext-required); validation library for Class B parent-side Agent gating | NEW r2 (closes Q-OPEN-4) | high | #3, #8, #13, #14 | `src/gate/{class-a,class-b,class-c}/`, MCP server PR upstream |

**Ordering notes:**

- **#5 depends on #14.** The "Persist immutable snapshot at spawn time" task (deliberation #4) cannot satisfy G6 without the atomic-write + index-lock + canonicalization protocol of #14. r1 silently assumed this; r2 makes it explicit.
- **#6 depends on #13.** Backwards-compat symlinks (#6) reintroduce the autoload leak unless boot suppression (#13) is active first. Symlinks can be created in #6 only after #13 ships.
- **#2 depends on #8 for *hard* enforcement.** The Rule 4 amendment text can be *drafted* in parallel with #8 (Permission Manager), but the rules-document language saying "spawn is capability-gated" cannot become operational until the Permission Manager actually enforces capabilities.
- **#11 (hard-fail flip) blocked on Q-OPEN-2 + Q-OPEN-4 acceptance.** Per codex Issue 8: Q-OPEN-2 (capability granularity baseline) and Q-OPEN-4 (spawn-path unification) are both resolved in r2 (§4.6.1 + §6 task #15), but their *implementations* (#8 + #15) must ship and the warn-mode audit (#9) must complete before #11 flips to hard-fail.

**Blocking-vs-parallel summary.** Blocking for the "metadata-first SessionContext" to be operational: #1, #3, #4, #5, #8, #10, #13, #14, #15. Surface/policy/rollout (can run in parallel): #2, #6, #7, #9, #11, #12.

---

## 7. Consequences

### 7.1 Positive

- **Today's incident is structurally prevented** (§4.5 + §4.7).
- **Unbounded depth is stable.** Every spawn is an immutable snapshot; children inherit from metadata, not ambient cwd (deliberation decision 5; gemini R2 immutable-infrastructure parallel).
- **Reproducible debugging.** `effective_prompt_digest` allows "why did this session behave as role X?" to be answered deterministically (gemini R2 auditability column).
- **Multi-tenant evolvable (Q4).** `tenant_id` field can be added without architectural change; Permission Manager extends to per-tenant capability tables.
- **Native-first.** No new framework, no external library dependencies (Articles 1 + 17).
- **No filesystem coupling.** cwd can be reused across roles; collaborative editing of one tree by multiple agents is supported (deliberation §"Why not", per-role-cwd rejection).
- **Rule 30 alignment.** Spawn validation rejections are operational issues; orchestrator self-corrects without surfacing to user.
- **Auditability.** Append-only state with parent chains enables forensic reconstruction of any session's lineage.

### 7.2 Negative / open

- **Migration cost.** Every existing dispatch must be reframed against the standard prelude; existing sessions without snapshots are "unmanaged" until §6 task #11 hard-fails.
- **Limits deferred.** Unbounded depth without depth/fan-out/lifetime limits = operational risk. Mitigated by Permission Manager + Rule 30 self-correction, but quantitative limits remain Q-OPEN-3.
- **Permission Manager — minimum schema defined; refinements pending.** Minimum capability set + CLI adapter table is §4.6.1; default role → capability table is §4.6.2. Q-OPEN-2 is RESOLVED at the minimum-viable level in r2. Fine-grained refinements (per-MCP-server allowlists, per-domain network policy, per-path filesystem scoping) remain as **Q-OPEN-2-FOLLOWUP** and are acceptance-blocking for the hard-fail rollout (§6 task #11).
- **Spawn-path unification — designed; integration pending.** §4.3 specifies three enforcement classes (A / B / C) over telepty / cmux / native `Agent` / MCP-deliberation / direct CLI surfaces; §6 task #15 is the integration work. Q-OPEN-4 is RESOLVED at the design level in r2. The implementation is non-trivial and is acceptance-blocking for the hard-fail rollout (§6 task #11).
- **Backwards compatibility window.** During warn-mode rollout (deliberation decision 7), sessions without snapshots will run alongside snapshot-managed sessions. Operational debugging during this window is harder.
- **Telemetry cost.** Warn-mode telemetry (§6 task #9) adds I/O on every spawn; volume / retention TBD.
- **Cross-CLI portability uncertainty.** Codex / Gemini drivers may not honor identical resolver layering (referenced as Q1+Q2 sub-ADR caveats in `rules.md` Rule 4-A). Q-OPEN-6.

### 7.3 Compared alternatives (rejected)

| Alternative | Why rejected | Source |
|---|---|---|
| Isolated cwd per session | Solves filesystem ambiguity, not role drift; collaborative editing breaks | Deliberation §"Why not"; codex R1; gemini R1 |
| Per-role cwd | Fails when multiple agents share a role or must collaboratively edit one tree | Deliberation §"Why not"; gemini R1 comparative table |
| Status quo hybrid (implicit cwd → role) | Path-based inheritance = "spooky action at a distance" at depth > 2 (AutoGen/LangGraph empirical) | Deliberation §"Why not"; gemini R1 + R3 |
| Pure F3 file-split, no metadata | Necessary but insufficient — without spawn-API semantics, depth still drifts | Deliberation §"Why not"; codex R3 |
| Pure F1 dispatch prelude, no file split, no metadata | Leaks if user-typed dispatch omits the prelude; CLI cwd-MD auto-load still active | Today's incident; Q-F1F3 (c) lock |
| Mutable session context | Drift at deep nesting; debugging black holes; violates immutable-infrastructure principle | gemini R2 |
| Per-CLI hardcoded role-from-cwd table | Couples architecture to filesystem layout; fails Article 17; not portable across CLIs | Constitutional + cross-CLI |

---

## 8. Open questions (Q1–Q12 — closed or deferred)

**Closed (locked 2026-05-12):**

- **Q1 — Goal scope.** All four: 1-person automation + collaboration + AI tree-search + ecosystem self-evolution. CLOSED.
- **Q2 — Depth.** Theoretical unbounded; practical limits deferred. CLOSED (with §4.6 + Q-OPEN-3 follow-up).
- **Q3 — Unit semantics.** L1 = telepty session; L2 = CLI native Agent (V4 isolated); L3 = L2 native fail → L1 tree (V1 `RECURSIVE_FAIL_FINAL`). CLOSED.
- **Q4 — Users.** Currently 1 (dykim); multi-tenant evolvable from day one via `tenant_id` extension. CLOSED.
- **Q5 — Motive scope.** General architecture gap, not today's bug alone. CLOSED.
- **Q6 — Missing capability.** Session branching mechanism = L1 tree (§4.6). CLOSED.
- **Q7 — Success criteria.** Context-appropriate task allocation + correct processing + on-demand activation. CLOSED (validated by §4 + §5).
- **Q-R-B — Recursion bound.** (a) Yes; Rule 4 amendment + Permission Manager (§4.6, §6 tasks #2 + #8). CLOSED.
- **Q-F1F3 — Anti-leak surface.** (c) Both F1 + F3 (§4.7). CLOSED.
- **Q-V — Bypass exploration.** `RECURSIVE_FAIL_FINAL` for in-band Agent; `BYPASS_AVAILABLE_VIA_MCP` is architecturally L1 tree (§5.3). CLOSED.

**Resolved in r2 (post cross-LLM review):**

- **Q-OPEN-2 — Permission Manager capability granularity.** **RESOLVED** by §4.6.1 (capability ↔ CLI adapter table) + §4.6.2 (default role → capability table) at the minimum-viable level. Finer-grained refinements (per-MCP-server allowlists, per-domain network policy, per-path filesystem scoping) are tracked as **Q-OPEN-2-FOLLOWUP** below — they no longer block r2 acceptance but are explicitly **acceptance-blocking for hard-fail rollout** (Migration §6 task #11) per codex Issue 8.
- **Q-OPEN-4 — Spawn-path unification.** **RESOLVED** by §4.3 (three enforcement classes A / B / C) + Migration §6 task #15 (gate integration). The "single gate" framing of r1 is replaced by uniform G1–G6 invariants applied through per-class mechanisms. **Acceptance-blocking for hard-fail rollout** (Migration §6 task #11) per codex Issue 8 — the integration code (#15) must ship and the warn-mode audit (#9) must complete first.

**Deferred to follow-up ADRs:**

- **Q-OPEN-1 — Role catalog completeness.** Current sawp.md role table has 7 roles (orchestrator/builder/tester/logger/analyst/architect + project-implementer pattern). This ADR's resolver §4.4 + §4.6.2 anchor on that catalog. Are roles complete? (researcher/grader/security-reviewer additions probable.) Follow-up: extend sawp.md role table first, then add role-layer files.
- **Q-OPEN-2-FOLLOWUP — Capability-granularity refinements.** Per-MCP-server allowlists, per-domain network policy, per-path filesystem scoping. Beyond the §4.6.1 minimum table. Acceptance-blocking for #11 hard-fail (codex Issue 8).
- **Q-OPEN-3 — Limits and quotas. DEFERRED per explicit user lock (F11) — 2026-05-12.** Depth / fan-out / lifetime limits not introduced in this ADR. gemini suggested elevating this (gemini R1 finding 3 — Erlang/Akka supervision parallel), but the user lock takes precedence; the ADR must not introduce activation limits. To be added as Permission Manager extensions in a follow-up ADR once the system stabilizes. **r2 explicitly preserves the deferral** to honor the user instruction.
- **Q-OPEN-5 — Snapshot pruning / GC. ELEVATED to medium priority, pre-public-launch tracking (gemini-A).** Append-only state grows unbounded; Temporal / event-sourcing experience (gemini R1 finding 3 + R3 finding 1) shows retention + archival is mandatory before any non-trivial deployment. Not acceptance-blocking for r2 (single-user dykim today), but tracked as a fast-follow before any public deployment.
- **Q-OPEN-6 — Cross-CLI portability.** Resolver behavior under Codex / Gemini drivers unverified (referenced from `rules.md` Rule 4-A Q1+Q2 sub-ADR caveats). Migration §6 task #13 (per-CLI boot adapter) is the implementation surface; §6 task #10 includes per-CLI boot adapter conformance tests. The Codex/Gemini wrapper strategy is provisional until adapters are shipped and tested. Phase 7+ FU-4 / FU-5 follow-up retained.
- **Q-OPEN-7 — Multi-tenant isolation primitives.** Beyond `tenant_id` field (§4.2), what enforces isolation across tenants? Network, filesystem, capability cross-tenant denial — TBD.
- **Q-OPEN-8 — Telemetry cost / retention.** Warn-mode telemetry (§6 task #9) volume + retention policy TBD.

---

## 9. Cross-references

### 9.1 V1 ADR Q'''-bis

V1 ADR Q'''-bis (the L1 transport-layer ADR for telepty session orchestration — see `docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis-claude.md` + `…-codex.md` sibling files) is **orthogonal**. This ADR fixes per-session **identity** (SessionContext, role, immutable snapshot); V1 Q'''-bis fixes how L1 sessions **communicate** over telepty. This ADR consumes V1's verdict `RECURSIVE_FAIL_FINAL` (V1V4 report §V1) as a binding constraint (F5) — depth ≥ 3 lives in L1 tree, which is V1's domain. **Do not redesign V1 here.**

### 9.2 SPEC-C3 r1 (supervisor kill-gate)

Orthogonal. SPEC-C3 r1 specifies supervisor kill semantics for runaway sessions. This ADR's Permission Manager (§4.6) supplies the **capability** dimension for kill at spawn time; SPEC-C3 supplies the **runtime mechanism**. The two compose: a session whose capabilities are revoked by Permission Manager becomes a candidate for C3 kill. **Do not redesign C3 here.**

### 9.3 V4 cross-mesh sketch

The V4 cross-mesh sketch (referenced in dispatch §"Context") describes how L1 tree branches communicate laterally. This ADR fixes the **per-branch identity** (SessionContext.session_id, parent_session_id); the cross-mesh layer consumes those IDs as routing primitives. The cross-mesh sketch is a separate ADR; this ADR is its identity prerequisite.

### 9.4 Rules document (Rule 4 amendment, Rule 30 reference)

- **Rule 4** (current — `docs/rules.md`, `AGENTS.md` checklist row 1). Today's text says "구현, 분석, 리서치 모두 해당 세션에 위임. subagent 포함 직접 수행 금지". Under Q-R-B Yes, "직접 수행 금지" is preserved (the orchestrator still does not run code itself); what is relaxed is the implicit "only orchestrator may spawn" semantics. The amendment (§6 task #2) reframes the rule as: *spawning is a capability; capability assignment is governed by Permission Manager; orchestrator retains spawn capability by default; other roles may carry subset spawn capabilities as the role catalog evolves*. **Inline amendment to `docs/rules.md` is out of scope for this ADR per dispatch's scope discipline.**
- **Rule 30** (Operational Autonomy — `docs/rules.md` lines 388–428). Invariant. Spawn validation rejections (G1–G6) are operational issues handled by the orchestrator's autonomous self-correction loop; they are **not** user-prompt surfaces. User interaction is reserved for architecture / business / destructive action per Rule 30's table.

### 9.5 SAWP (`docs/sawp.md`)

The SAWP role separation table is the **source of truth** for the `role` enum in SessionContext (§4.2). `SessionContext.role` MUST be drawn from the sawp.md role catalog. Future role additions = update sawp.md first, then add the corresponding role-layer file under `instructions/roles/` (§4.4). The role-axis behavioral contract for builder / tester / logger / analyst / architect / orchestrator is anchored in sawp.md's "역할 분리 테이블" + "경계 원칙".

### 9.6 Constitution Articles

- **Article 1 (경량).** Compliant: contract-only ADR, no new framework, no over-engineering. The resolver is markdown concatenation + sha256, not a templating engine.
- **Article 3 (역할).** Enforced by §4.1 (three-axis separation) + §4.3 G1–G4 (role-explicit, override-explicit). cwd → role inference is structurally impossible under §4.5 + §4.7.
- **Article 17 (무의존).** Compliant: backing storage = markdown; resolver = local code; no external library required for the architecture. (Implementation may use any library; the *contract* is library-free.)

### 9.7 Deliberation 2026-05-11

Source: `state/aigentry-orchestrator/archive/deliberation-2026-05-11T1015-cwd-role-architecture-for-infi.md` + `.contract.json`. Session: `cwd-role-architectur-mp11lo7l28np`. Rounds: 3. Verdict: **UNANIMOUS [AGREE]** codex + gemini (claude self-skipped per orchestrator identity rule). Decisions 1–7 from the contract are the **binding starting point** for §4; today's Q-R-B + Q-F1F3 decisions + r2 codex/gemini review findings **extend** (do not override) them. Tasks 1–8 from the contract are inherited verbatim in §6, augmented with **seven new tasks** reflecting today's locks and r2 codex findings: #2 (Rule 4 amendment), #7 (dispatch prelude F1 template + lint), #8 (Permission Manager), #12 (AGENTS.md surface update), #13 (per-CLI boot adapter — r2), #14 (persistence locking / atomicity / canonicalization — r2), #15 (gate integration across Class A/B/C surfaces — r2).

### 9.8 V1+V4 verification report

Source: `/tmp/aigentry-v1v4-test/report.md` (session `E-tester-v1v4`, dated 2026-05-12). Verdicts consumed: V1 `RECURSIVE_FAIL_FINAL`, V4a `NOT_INHERITED`, V4b `NOT_INHERITED`, V4c `same` (INHERITED), V4d `subset` (MCP inherited, Agent excluded), Q-V-1/-2 `NO_BYPASS`, Q-V-3 `conditional` (MCP quasi-L3 = architecturally L1 tree). Cited throughout §1, §3, §4.5, §5.

### 9.9 AGENTS.md current text

Source: `/Users/duckyoungkim/projects/aigentry-orchestrator/AGENTS.md`. Checklist row 1 ("직접 수행 금지 (Rule 4, 21)") + Rule 4 reference at line 42 + delegation patterns at lines 64–84 are the surface most affected by this ADR. Surface update is §6 task #12; semantic change is §6 task #2.

---

## 10. Evolvability (1-person → public)

- **Single-user today (dykim, 2026-05-12).** Exactly one orchestrator-class L1 session. Permission Manager is trivial — orchestrator carries all capabilities; spawned children carry subsets per role defaults. `tenant_id` field present in schema but null.
- **Multi-user transition.** Add `tenant_id` population at session creation. Permission Manager extends to a per-tenant capability table. No architectural change required — `tenant_id` is a schema extension, not a contract change. Spawn API gate (§4.3) becomes the choke point for cross-tenant capability denial (Q-OPEN-7).
- **Public ecosystem.** Spawn API gate is also the rate-limit / quota choke point (Q-OPEN-3). Telemetry from warn-mode (§6 task #9) becomes capacity-planning signal in production. Snapshot append-only state becomes per-tenant audit log.
- **Backwards compatibility.** `schema_version` field in SessionContext (§4.2) enables migration without rewriting historical snapshots. Persistence layout (§4.8) is forward-compatible — fields can be added; semantics of existing fields cannot be changed without a new ADR.
- **The architecture does not assume a public deployment.** It also does not preclude one. The evolvability cost is bounded to schema extension + Permission Manager refinement + (eventual) limit-enforcement (Q-OPEN-3).

### 10.1 Anthropic Claude Code Agent View interop (gemini-C, 2026-05-11 release)

Anthropic released **Agent View** in Claude Code v2.1.139 (2026-05-11) — a flat dashboard for monitoring parallel agent sessions. gemini's industry comparison (review §"Anthropic Claude Code Agent View comparison") observes that aigentry's `~/.aigentry/sessions/index.json` + per-session `lineage.json` + L1 / L2 records (§4.8) are **already structured to act as a backend for such a dashboard**. The interop recommendation:

- **Aigentry as SSOT backend; Agent View as one visualization client.** Preserve the metadata-first architecture independently. Do not couple the schema to Agent View's data model — Agent View is one of potentially many clients (custom dashboards, CLI tools, MCP tools).
- **Adapter command.** Expose `aigentry sessions list --format=claude-agent-view` (or equivalent flag set) that projects aigentry's metadata into the shape Agent View consumes. Format mapping lives in the adapter, not in the snapshot schema.
- **Do not build a separate visualization layer in aigentry** unless required by a non-Anthropic client. The `~/.aigentry/sessions/` directory + `index.json` are already the audit-grade source; visualization is downstream.

Migration: not on the critical path for r2 acceptance. Captured here so the schema decisions in §4.2 / §4.8 explicitly leave room for the adapter — they do (the schema is self-describing JSON with `schema_version` for forward-compat).

---

## 11. Changelog

- **2026-05-12 — Initial draft (r1).** Author: E-architect-adr-mf (architect role, dispatched from orchestrator). Consumes:
  - Deliberation 2026-05-11T1015 synthesis (`structured_synthesis_hash: c261fd0d7f6599bfb4f1b05cd5fc8b9e769f5214`).
  - V1+V4 mechanism verification report (2026-05-12, `/tmp/aigentry-v1v4-test/report.md`).
  - Today's user-locked decisions: Q1–Q7, Q-R-B (a), Q-F1F3 (c), Q-V (a) RECURSIVE_FAIL_FINAL.
  - AGENTS.md + `docs/rules.md` + `docs/sawp.md` (current state as of 2026-05-12).
- **2026-05-12 — r2 (post cross-LLM review).** Author: E-architect-adr-mf. Reviewers: codex (`docs/reports/2026-05-12-adr-mf-codex-review-r1.md`, ACCEPT_WITH_MAJOR_FIXES, 9 binding issues) + gemini (`docs/reports/2026-05-12-adr-mf-gemini-review-r1.md`, ACCEPT_WITH_MINOR_FIXES, 3 industry-comparison additions). All 9 binding + 3 gemini additions addressed in this revision:
  - **Issue 1 (gate funnel):** §4.3 restructured into three enforcement classes (Class A L1 process spawn, Class B L2 native Agent prompt validator, Class C MCP/cmux external launcher adapter). Surface→class mapping table added.
  - **Issue 2 (per-CLI boot matrix):** §4.5.1 added with Claude `--bare`, Codex/Gemini wrapper strategy, global-MD policy decision, fail-closed startup self-test, version-drift behavior.
  - **Issue 3 (persistence protocol):** §4.8.2 added with canonical bytes (UTF-8/LF/NFC/sorted-keys), atomic write (tmp+fsync+rename), index lock (`flock`/`LockFileEx`), crash recovery, concurrent spawn race rule.
  - **Issue 4 (Permission Manager adapter table):** §4.6.1 capability ↔ CLI adapter table + §4.6.2 default role → capability table added.
  - **Issue 5 (storage location):** §4.8.1 switches to user-global `~/.aigentry/sessions/` + `~/.aigentry/instructions/` (was repo-local `state/sessions/`). All file paths in §6 updated.
  - **Issue 6 (spawn-snapshot contradiction):** §4.2.1 added — lightweight L2 `AgentRecord` (Option B). §5.2 rewritten to use it.
  - **Issue 7 (migration tasks #13/#14/#15 + ordering):** §6 expanded from 12 to 15 tasks; `blockedBy` column added; ordering notes (#5←#14, #6←#13, #2←#8, #11←Q-OPEN-2+4 acceptance) made explicit.
  - **Issue 8 (Q-OPEN-2 + Q-OPEN-4 acceptance-blocking):** §8 reorganized — Q-OPEN-2 and Q-OPEN-4 marked **RESOLVED** in r2; both noted as **acceptance-blocking for hard-fail rollout** (#11).
  - **Issue 9 (§5.3 MCP gate integration):** §5.3 expanded with Phase 1 (ungated transitional) + Phase 2 (SessionContext-required MCP server extension).
  - **gemini-A (Q-OPEN-5 elevate):** §4.8.3 + §8 elevate snapshot GC from "deferred follow-up" to "medium priority, pre-public-launch tracking".
  - **gemini-B (Q-OPEN-3 preserve DEFER):** §4.6 + §8 explicitly preserve the user lock on limits; gemini's elevation suggestion is acknowledged but the user instruction takes precedence.
  - **gemini-C (Anthropic Agent View interop):** §10.1 added — aigentry as SSOT backend, Agent View as one visualization client, adapter command via `aigentry sessions list --format=claude-agent-view`.
  - Additional r2 hygiene: §4.2 schema gains per-layer source identity (`source_path` + `content_sha256` + `read_at`) to fix codex's "files as backing storage" digest-fragility note; §4.4 gains explicit concatenation protocol (delimiter, newline normalization, missing-file behavior, conflict policy); §4.4.1 adds `project_id` derivation rule; §5.2 rewritten to use AgentRecord.
- **Status:** **proposed (r2)**. Awaiting orchestrator approval for commit (orchestrator handles commit + push per dispatch workflow step 6; no commit by author).
- **2026-05-12 — r2-patches (post r2 codex verification).** Author: E-architect-adr-mf. Reviewer: codex r2 verification (`docs/reports/2026-05-12-adr-mf-codex-review-r2.md`, ACCEPT_WITH_MINOR_FIXES — 9/9 binding + 3/3 gemini all confirmed FIXED). Six minor patches applied:
  - **1 new issue (Patch 1):** §4.5.1 scratch-cwd vs SessionContext.cwd two-axis separation + fail-closed `ERR_BOOT_ADAPTER_UNSUPPORTED` (new §4.5.1.1 sub-subsection).
  - **5 stale r1→r2 contradictions:** §3 F15 row (global = `common`-layer source, not ambient); §4.7 prelude bullet (global is snapshotted, not auto-loaded); §7.2 Permission Manager bullet (Q-OPEN-2 RESOLVED at minimum-viable; refinements acceptance-blocking for #11); §7.2 Spawn-path bullet (Q-OPEN-4 RESOLVED at design level; integration acceptance-blocking for #11); §9.7 migration task count corrected from "four" to "seven" with explicit list.
  - **Architecture untouched.** §4.1–§4.8 main bodies, §5 layer-aware, §6 migration table, §8 Q-OPEN resolutions, §10.1 Agent View interop are NOT modified.
  - **User lock preserved.** Q-OPEN-3 (limits DEFERRED) untouched.
  - **Status:** **proposed (r2-patched)**. Awaiting orchestrator commit (no commit by author).
- **2026-05-13 — §6 task #11 hard-fail flip (commit `<TBD-MF11>`).** Author: E-coder-mf11-hardfail. Migration COMPLETE: `DEFAULT_VALIDATION_MODE = 'hard-fail'` (`src/session/validate-spawn.ts:257`). The #9 warn-mode compatibility window opened by `c609e39` is hereby closed; every spawn surface that goes through `enforceSpawn()` (Class A telepty / cmux / cli_direct, Class B native Agent validator) is now fail-closed by default. Class C MCP adapter remains independently gated by `MCP_REQUIRE_SESSION_CONTEXT=1` (hard-codes its own modes — insensitive to `DEFAULT_VALIDATION_MODE`).
  - **Audit (per §6 task #11 pre-flip checklist; SPEC `docs/specs/2026-05-12-hard-fail-flip.md`):**
    - A.1 `npm test` under simulated `DEFAULT='hard-fail'` before commit: 168/171 pass with +1 expected failure on the constant-assertion test (`warn-mode.test.ts:37`) — rewritten in this commit (and superseded by the new `tests/session/hard-fail-flip.test.ts`). 0 warn-dependent behavior tests required explicit-mode fixture changes (all warn/hard-fail/off tests already pass `mode` explicitly through `enforceSpawn(...)` options).
    - A.2 #119 coverage 87.00% lines / 89.77% branches per `b6865c1` commit message. 6 sub-85% items categorized: 3 production-only adapter shims (`nodeFs`, `nodeSpawner`, `nodeBootFs`) + `types.ts` (TS interface declarations only) + `persist-context.ts` (Node 20.20.0 `--experimental-test-coverage` upstream bug; suite still runs 152/152 outside coverage) + zero genuine gaps — all acceptable per #119 mock strategy.
    - A.3 #104 boot-adapter 8 upstream gaps (3 MIN_VERSION TODOs in `claude.ts:6` / `codex.ts:5` / `gemini.ts:5` + 3 env-var TODOs/UPSTREAM-GAPs in `codex.ts:7,8` / `gemini.ts:7,8` + 1 contract UPSTREAM-GAP in `types.ts:53`) — all non-blocking for the constant flip. `CLI_VERSION_DRIFT` + `BOOT_TIMEOUT` + leak-marker self-test are the correct fail-closed outcomes under hard-fail; real-CLI `READY <digest>` handshake integration is separately tracked.
    - A.4 #121 MCP server-side wiring: Class C `gateMcpToolCall` hard-codes `mode: "warn"` (Phase 1 — default ungated transitional) and `mode: "hard-fail"` (Phase 2 — `MCP_REQUIRE_SESSION_CONTEXT=1`). The constant flip does not change MCP behavior. Defer MCP hard-fail enforcement to upstream wiring as planned.
    - A.5 Q-OPEN-4 ACCEPTED (§4.3 three-class design + #121 integration `11a0451` shipped). Q-OPEN-2 baseline ACCEPTED (§4.6.1 + §4.6.2 tables + #103 `3a13fb5` shipped). Q-OPEN-2-FOLLOWUP refinements (per-MCP allowlists, per-domain network, per-path FS scoping) deferred to Phase 2 per orchestrator decision: baseline §4.6.2 already enforces the subset invariant; refinements strictly shrink the allowed set further (cannot reduce safety); ADR §6 row 11 dependency list is the canonical task-tracker surface and refinements appear there as the FOLLOWUP work item, not a #11 prerequisite.
  - **Notes.** Pre-flip baseline 169/171 pass (2 pre-existing real-clock failures in `bin/spawn-telemetry-report.sh`-based tests — fixture timestamps anchored to `2026-05-12` while the script computes the 7-day lookback via host `date -u -v -Nd`; filed as a separate orchestrator-track follow-up task and **not introduced by this flip**).
  - **Remaining follow-ups (non-blocking; tracked).**
    - Snyk auth setup for orchestrator-driven scans (CLAUDE.md global rule).
    - MCP server-side wiring upstream (Class C Phase 2 enable).
    - GEMINI.md Rule 16 alignment with the hard-fail surface.
    - Q-OPEN-2-FOLLOWUP capability-granularity refinements (per ADR §8 — per-MCP allowlists, per-domain network policy, per-path FS scoping).
    - `bin/spawn-telemetry-report.sh` real-clock dependency in W4 + report.sh aggregation tests.
    - Boot-adapter empirical `MIN_VERSION` + upstream env-var name verification when real-CLI Class A integration ships.
  - **Cited dependency commits.** `d06e9cb` (#3/#99) · `3a13fb5` (#8/#103) · `28f94b0` (#4/#114) · `feda4b9` (#5/#115) · `c24647b` (#14/#101) · `426f3a9` (#13/#104) · `c609e39` (#9/#118) · `b6865c1` (#10/#119) · `11a0451` (#15/#121).
  - **Rollback procedure.** `git revert <TBD-MF11>` restores `DEFAULT_VALIDATION_MODE = 'warn'` and the previous `warn-mode.test.ts:37` assertions. The new `tests/session/hard-fail-flip.test.ts` is rollback-compatible: it asserts the *current* default, so reverting also reverts the test's expectations. No schema migrations, no persisted-state changes — the flip is a pure source constant. Rollback is safe at any time provided the revert lands before any downstream task assumes hard-fail semantics.
  - **Status:** ADR-MF §6 migration COMPLETE.

