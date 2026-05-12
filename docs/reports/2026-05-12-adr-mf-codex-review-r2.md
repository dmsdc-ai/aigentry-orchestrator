# ADR Metadata-first r2 - codex r2 verification

## Verdict

ACCEPT_WITH_MINOR_FIXES

r2 resolves the architectural/protocol gaps from codex r1: the gate is split by enforceable surface, L2 Agent calls now have AgentRecord lineage, persistence has an atomic protocol, and the storage location is user-global. I count 9/9 binding issues fixed at the ADR level and 3/3 gemini additions folded in. Before commit, patch the stale r1 wording listed below and clarify the Codex/Gemini scratch-cwd boot fallback so it cannot mutate the cwd/code-scope axis.

## 9 binding - r2 fix status

| # | Issue | Status | Evidence (line ref) |
|---|---|---|---|
| 1 | Gate "all paths funnel" not implementable. | FIXED | §4.3 replaces the single-gate framing with three enforcement classes and states why the r1 framing was not implementable (144-152). The surface-to-class mapping covers telepty, cmux, cli_direct, agent_tool, and mcp_deliberation (154-162). Class B also states the parent-side trust/lint caveat explicitly (175). |
| 2 | Ambient autoload OFF needed concrete boot contract. | FIXED | §4.5 makes global instruction files auditable rather than ambient (210-215). §4.5.1 adds a per-CLI matrix: Claude `--bare --system-prompt-file <effective_prompt> ...` (221-223), Codex/Gemini wrapper strategy plus same digest self-test (224-225), and fail-closed version-drift behavior (227). Minor wording issue remains for scratch cwd; see "New issues". |
| 3 | Atomic persistence protocol missing. | FIXED | §4.8.2 defines canonical UTF-8/LF/NFC/sorted-key digest bytes (319-325), POSIX temp+fsync+rename+dir-fsync (326-332), Windows fallback (334), index locking with `flock`/`LockFileEx` (336-340), crash cleanup (342-345), and concurrent-spawn serialization/idempotency (347-351). |
| 4 | Permission Manager vague. | FIXED | §4.6 defines the minimum binding capability set and cycle-read dependence on the index lock (238-243). §4.6.1 maps capabilities to Claude/Codex/Gemini adapter primitives (245-260). §4.6.2 adds the starting default role table (262-275). |
| 5 | Storage location mismatch. | FIXED | §4.8.1 explicitly chooses user-global `~/.aigentry/`, explains why repo-local storage is wrong for global sessions, and lists `~/.aigentry/sessions/` plus `~/.aigentry/instructions/` (300-313). Migration paths now use those locations (418-420, 422). |
| 6 | §5.2 spawn-snapshot contradiction. | FIXED | §4.2 defines both L1 process spawn and L2 Agent call as spawn types and says both produce SessionContext-class records (84-90). §4.2.1 defines AgentRecord (118-140). §5.2 rewrites L2 around AgentRecord and Class B validation (374-390). |
| 7 | Missing migration tasks and ordering. | FIXED | §6 expands migration to 15 tasks with `blockedBy` (411-429). New tasks #13 boot adapter, #14 persistence, and #15 gate integration are present (427-429). Ordering notes make #5 depend on #14, #6 on #13, #2 hard enforcement on #8, and #11 on Q-OPEN-2/4 acceptance (431-438). |
| 8 | Q-OPEN-2/Q-OPEN-4 acceptance-blocking. | FIXED | §8 marks Q-OPEN-2 resolved by §4.6.1/§4.6.2 and Q-OPEN-4 resolved by §4.3 + task #15, with both acceptance-blocking for hard-fail rollout (494-498). Task #11 carries the same block (425, 436). |
| 9 | §5.3 MCP gate integration missing. | FIXED | §5.3 now defines MCP as L1 tree initiated from L2 and adds Phase 1 degraded ungated metadata plus Phase 2 SessionContext-required MCP server validation (392-405). |

## 3 gemini additions status

| | Addition | Status | Evidence |
|---|---|---|---|
| A | Q-OPEN-5 GC elevated. | FIXED | §4.8.3 says GC/pruning is medium priority, pre-public-launch (355-358). §8 repeats Q-OPEN-5 as elevated, not r2-blocking but required before public launch (504). |
| B | Q-OPEN-3 limits DEFERRED preserved. | FIXED | §4.6 states practical limits remain deferred per explicit user instruction (277). §8 Q-OPEN-3 says limits are not introduced in this ADR and the user lock takes precedence (503). |
| C | Anthropic Agent View interop. | FIXED | §10.1 adds Agent View interop and recommends `aigentry sessions list --format=claude-agent-view` as an adapter while keeping aigentry metadata as SSOT (562-570). |

## Lower-severity / hygiene additions (per-layer identity, concatenation, project_id) - spot check

- Per-layer source identity: FIXED. L1 schema makes `instruction_layers` entries carry `{ source_path, content_sha256, read_at }` (106), and the follow-up paragraph explains this protects digest audits after file edits (116).
- Concatenation protocol: FIXED. §4.4 specifies delimiter, LF/NFC/no-BOM normalization, missing-file fail-closed behavior, and no automatic markdown override semantics (188-193).
- `project_id` derivation: FIXED. §4.4.1 defines parent walking, `.aigentry/project.json` authority, basename fallback, and `project_id = "none"` behavior (195-204).
- Global instruction channel: FIXED in the binding section. §4.5 decides global `~/.claude/CLAUDE.md` is snapshotted into common-layer source identity instead of ambient/out-of-scope (213).
- Changelog traceability: FIXED. §11 enumerates all 9 codex issues and 3 gemini additions addressed in r2 (581-594).

## New issues introduced in r2 (if any)

- **Codex/Gemini scratch-cwd boot fallback can violate cwd/code-scope semantics.** §4.5.1 proposes launching Codex/Gemini from a scratch cwd when no `--bare` equivalent exists (224-225). That can change the `cwd` axis from "where code lives" (§4.1, 74-80; schema canonical cwd at 100) into an adapter implementation detail. Minor patch: state that scratch cwd is only a control cwd; the original code cwd remains the SessionContext `cwd` and must be mounted/allowed via CLI-native include-dir/add-dir mechanisms, or the adapter must fail closed until that is possible.

## C3-style stale text contradictions (typical r1->r2 artifact)

- §3 F15 still says global `~/.claude/CLAUDE.md` is out of scope (66), but §4.5 now says leaving it out of scope reintroduces the leak and requires snapshotting it into the common layer (213). Patch F15 to match §4.5.
- §4.7 dispatch prelude still says global `~/.claude/CLAUDE.md` auto-loads and is acceptable (288). Under r2, global content should be described as snapshotted/prepended by the adapter, not ambient autoload.
- §7.2 still says Permission Manager schema is not yet defined and Q-OPEN-2 remains open (459), but §4.6.1/§4.6.2 define the minimum schema and §8 marks Q-OPEN-2 resolved (496). Rewrite as "fine-grained refinements remain open."
- §7.2 still says spawn-path unification is Q-OPEN-4 (460), but §8 marks Q-OPEN-4 resolved by the three-class split plus task #15 (497). Rewrite as "implementation is non-trivial and blocks hard-fail rollout."
- §9.7 still says the inherited tasks are augmented with four new tasks #2/#7/#8/#12 (542), but r2 §6 says seven new tasks and includes #13/#14/#15 (411, 427-429). Patch the cross-reference.

## Commit recommendation

NEEDS_MINOR_PATCHES_FIRST

No r3 architecture pass is needed. Patch the stale contradictions and the scratch-cwd wording, then r2 is ready for commit.
