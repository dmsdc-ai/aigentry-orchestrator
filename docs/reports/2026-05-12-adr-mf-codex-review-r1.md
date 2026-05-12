# ADR Metadata-first — codex review r1 (implementer perspective)

## Verdict

ACCEPT_WITH_MAJOR_FIXES

The ADR has the right architectural direction: cwd/role/task separation is explicit, V1/V4 evidence is consumed correctly, and limits are kept deferred. It is not yet protocol-grade for implementation because several binding claims are stated without enforceable mechanics. The most important gaps are spawn-gate reachability across native Agent/MCP paths, process boot autoload suppression, and crash-safe persistence/concurrency.

## Top 3 most important issues

1. **"All paths funnel through the gate" is not implementable as stated.** §4.3 says telepty, native `Agent`, MCP-deliberation, cmux, and direct CLI all pass through one gate (111), but V1 proves native Agent calls expose no `tools=` bypass and no recursive dispatch primitive (V1 report 68-76, 100-103). §5.2 then says L2 has no separate snapshot and only serializes fields into the prompt string (217-219). That means G1-G6 cannot literally gate native Agent calls unless the ADR narrows the invariant to L1/external process spawns and defines L2 as parent-side prompt validation/lint.
2. **Ambient cwd markdown autoload OFF needs a concrete boot contract.** §4.5 requires cwd `CLAUDE.md` / `AGENTS.md` auto-discovery disabled at process boot (137-141), but the ADR does not name the CLI flags/wrapper behavior. Current local Claude help exposes `--bare`, which disables CLAUDE.md auto-discovery, but it also skips global CLAUDE.md unless explicitly reintroduced. Codex/Gemini help inspected locally did not show an equivalent one-flag "bare" mode. This needs per-CLI adapter rules, not a declarative sentence.
3. **Immutable persistence is missing the atomic write, lock, and canonicalization protocol.** §4.2 requires precommit digest + persisted snapshot before launch (107, 118), and §4.8 introduces `state/sessions/index.json` as the session SSOT (182-185). There is no temp-file/fsync/rename protocol, no index lock, no crash recovery for half-written snapshots, no deterministic JSON/newline/path canonicalization, and no race rule for rapid concurrent spawns.

## Section-by-section findings

### §1 Context

- Good: the incident is concrete and matches the problem statement: cwd-local `CLAUDE.md` / `AGENTS.md` caused role inference (12).
- Good: V1/V4 evidence is represented accurately. The referenced report says L2 does not inherit cwd markdown, does inherit cwd, and lacks native recursive Agent (V1 report 27-43, 45-52, 100-103).
- Issue: the context says `~/.claude/CLAUDE.md` global is inherited and treated as outer-common/out of scope (16, 65). If global instructions can carry role or spawn policy, leaving them "out of scope" is a residual ambient-context channel. The boot contract must either snapshot global-common explicitly or prove it cannot carry role semantics.

### §2 Problem statement

- Good: the three failures are correctly framed: cwd role inference, parent-role inheritance, and no native recursion (30-35).
- Issue: "every context element must be explicitly serialized into the spawn payload" (34) is stronger than the later schema. The schema has no `spawn_chain` field, no per-layer source revision/digest, and L2 explicitly has no separate snapshot (217). The ADR should define what is serialized for L1, L2, and MCP-initiated quasi-L3 separately.

### §3 Forces and constraints

- Good: Article 3 alignment is explicit: cwd must never imply role (51, 57).
- Issue: F4 says validation runs inside L1 launchers, not an orchestrator-side service (54), but §4.3 includes native `Agent` in the same gate (111). Native Agent is not an L1 launcher. This is the first place the ADR should split "process spawn gate" from "parent-side Agent prompt validator".
- Issue: F11 correctly defers depth/fan-out/lifetime limits (61). The ADR mostly honors this; cycle detection is not a quota, so it does not violate the deferral.

### §4 Decision (4.1-4.8)

- §4.1: The three-axis separation is clear and testable at the SessionContext level (71-80). Implementation reality: cwd remains ambient for L2 (V1 report 39-43), so the invariant can only be enforced by prompt metadata and parent validation there, not by process isolation.
- §4.2: The schema is directionally implementable, but under-specified. `cwd` needs canonical path rules; `effective_prompt_digest` needs byte-level rules; `created_at` needs timestamp precision; `project_id` needs derivation; and `session_id` needs collision behavior (85-104). The dispatch asked to check `spawn_chain`; the ADR only has `parent_session_id` and a later `lineage.json` file (89, 184), so bounded chain materialization is not part of the immutable snapshot.
- §4.3: G1-G4 are implementable for a JSON-like SpawnRequest. G5 is only implementable after §4.6 defines a concrete capability table and CLI adapter mapping. G6 is implementable only after §4.8 defines atomic persistence (113-118).
- §4.4: The ordering is concrete, but "concatenation" lacks delimiters, duplicate/conflicting instruction behavior, missing-file behavior, and canonical newline encoding (124-133). For markdown layers, duplicate-key collision translates to conflicting policy text; the ADR should define later-layer override, fail-closed conflict detection, or "no override, all text applies."
- §4.5: Mechanism gap. The clause is essential, but it needs a per-CLI boot matrix. For Claude, current local help suggests `--bare --system-prompt-file/--system-prompt` as the likely path; for Codex/Gemini, the ADR needs an explicit wrapper strategy or a documented "not yet supported" gate.
- §4.6: Permission Manager is too vague for enforcement. The minimum capabilities (`spawn_l1`, `spawn_l2`, `read_fs`, `write_fs`, `network`, `mcp_deliberation`) are named (154), but no denial mechanism maps those to Claude `--tools`/settings, Codex sandbox/approval, Gemini policy, or MCP server allowlists. Prompt-only denial is not a permission manager.
- §4.6: Cycle detection says walk `parent_session_id` and reject if the proposed child appears in the chain or active descendants (155). That requires a globally consistent active-session index and a lock; otherwise two rapid spawns can observe stale state and both pass.
- §4.7: F1+F3 is coherent (163-176). Risk: task #6 proposes backwards-compatible symlinks (240); symlinking `CLAUDE.md` back to role-heavy content would reintroduce the autoload leak unless §4.5 boot suppression is already enforced.
- §4.8: The review dispatch called out `~/.aigentry/sessions/` vs `~/.aigentry/instructions/`, but the ADR specifies repo-local `state/sessions/` and repo-root instruction files (126-129, 182-185). If the intended contract is user-global SessionContext storage, this is a mismatch. If repo-local storage is intended, multi-repo and multi-tenant semantics need to be stated.

### §5 Layer-aware application

- Good: §5.3 correctly consumes V1 `RECURSIVE_FAIL_FINAL`; depth >= 3 is L1 tree, not native Agent recursion (221-225; V1 report 57-63, 100-103).
- Issue: §4.2 says "Every spawn produces exactly one SessionContext snapshot" (83), but §5.2 says L2 has no separate snapshot and borrows the parent's snapshot with task replaced (217). This is a normative contradiction. Either L2 Agent calls are not "spawns" for this ADR, or they need a lightweight child record.
- Issue: MCP-mediated quasi-L3 is classified as L1 tree (223-225), but there is no concrete gate integration with the deliberation MCP server. V1 report caveat says MCP participants do not preserve SessionContext automatically and metadata must be passed through deliberation context fields (94-98).

### §6 Migration path

- Good: the migration is staged and includes warn-mode before hard-fail (231-248), matching the deliberation contract tasks (contract 71-99).
- Issue: the section says it inherits 8 tasks and adds four, but now lists 12 tasks (231-247). That is explainable, but task dependencies are incomplete.
- Missing task: implement per-CLI boot adapters for ambient autoload OFF. Without this, §4.5 is not actionable.
- Missing task: implement persistence locking/atomicity/canonicalization before task #5 can satisfy G6.
- Missing task: integrate the gate with telepty/cmux/MCP/direct CLI entry points. Q-OPEN-4 defers this (309), but §4.3 treats it as already binding.
- Ordering issue: task #2 amends Rule 4 before Permission Manager task #8 exists (236, 242). The policy can be drafted early, but hard enforcement should be explicitly blocked on task #8.

### §7 Consequences

- Good: negative consequences name migration cost, limits risk, Permission Manager incompleteness, spawn-path unification, and cross-CLI uncertainty (267-273).
- Issue: the negative section understates the severity of boot-mode/version drift. If a future Claude/Codex/Gemini version changes instruction loading, the invariant fails unless the spawn adapter has a startup self-test.
- Constitution alignment: Article 1 is mostly satisfied because the architecture is markdown + local code, but the "single gate across five spawn surfaces" risks becoming over-complex unless split by layer. Article 3 is the core win. Article 17 is acceptable only if native CLI behavior is treated as an external dependency with explicit fallback/fail-closed behavior.

### §8 Open questions

- Good: limits/quotas stay deferred in Q-OPEN-3 (308), so the ADR does not violate the user lock.
- Issue: Q-OPEN-2 and Q-OPEN-4 are not merely follow-up polish. Permission granularity and spawn-path unification are required before G5 and "all paths funnel through the gate" can be true (307, 309).
- Issue: Q-OPEN-6 cross-CLI portability remains open (311), but the ADR makes cross-CLI claims in §4.3 and §4.5. Those claims should be scoped to Claude-first until Codex/Gemini boot and policy adapters are verified.

## Anti-patterns / hidden assumptions

- "Files are backing storage, not architecture" is true conceptually, but implementers still need source identity: absolute path, content hash, and read timestamp per layer, otherwise digest audits are fragile after file edits.
- `state/sessions/index.json` is mutable while snapshots are append-only. That is fine, but the ADR calls it SSOT without a lock or recovery journal (185).
- Global `~/.claude/CLAUDE.md` is treated as harmless outer-common, but it is still an ambient instruction channel unless the resolver snapshots it explicitly (139, 65).
- Backwards-compatible symlinks can preserve old behavior too well. If symlinks keep role-heavy content reachable as cwd `CLAUDE.md`, §4.5 must already be enforced before rollout.
- Capability subset enforcement assumes CLIs expose compatible permission primitives. Local help inspection shows they expose different surfaces: Claude has `--bare`, `--tools`, `--allowedTools`, `--settings`; Codex has sandbox/approval/config; Gemini has policy/approval/extension flags. The ADR needs an adapter table.
- Unbounded depth with cycle detection requires a strongly consistent lineage read. Plain parent-chain walks over files fail under concurrent writers unless there is a lock.

## Specific to implementability

- Claude CLI ambient md autoload disable mechanism: **found, but not in ADR**. Current local `claude --help` shows `--bare`, described as skipping CLAUDE.md auto-discovery. The ADR should mandate the exact invocation shape, probably `claude --bare --system-prompt-file <effective_prompt>` plus explicit settings/MCP/plugin inputs. It must also decide whether global `~/.claude/CLAUDE.md` is snapshotted or intentionally excluded.
- L1 tree recursion permission cascade: **vague**. The subset rule is clear (117, 153), but capability definitions, default role table, per-CLI enforcement, MCP allowlist enforcement, and denial audit format are deferred or absent.
- Cross-CLI spawn API: **partial**. L1 telepty/direct CLI can be gated with wrapper code. Native Agent cannot be gated as a child process; it can only be validated by the parent before the Agent call. MCP-deliberation can be gated only if the MCP server is modified to require SessionContext metadata before launching participants.

## Recommendation for next rev

- Produce r2 with a narrow implementation contract, not a redesign.
- Split spawn surfaces into three enforcement classes: L1 process spawn gate, L2 native Agent prompt validator, and MCP/cmux external launcher adapter.
- Add a boot-mode matrix for Claude/Codex/Gemini with exact flags, fail-closed startup self-tests, and version-drift behavior.
- Add persistence protocol: canonical bytes for digest; temp file + fsync + atomic rename; index lock; crash recovery; duplicate session-id handling; lineage read/write rules.
- Add Permission Manager minimum viable table and adapter mapping for tools, filesystem, network, MCP, and spawn capabilities.
- Either change §4.8 to the intended `~/.aigentry/sessions/` / `~/.aigentry/instructions/` split or explain why repo-local `state/sessions/` is the real contract.
- Mark Q-OPEN-2 and Q-OPEN-4 as acceptance-blocking for hard-fail rollout, even if the detailed refinements can continue later.
