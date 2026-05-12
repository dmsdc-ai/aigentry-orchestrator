# Migration log — CLAUDE.md → layered (ADR-MF §6 task #6 / #117)

- Date: 2026-05-12
- Author: E-coder-mf6-migrate
- SPEC: `docs/specs/2026-05-12-claude-md-migration.md`
- ADR anchor: `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` §4.4 + §4.5 + §6 task #6
- Depends on: commit `28f94b0` (resolver / #114) + commit `426f3a9` (boot adapter / #104). Anti-leak invariant satisfied.

## Pre-migration anchors

- `CLAUDE.md` sha256 (pre): `5300b187d614f923eef8e149239c98dc203e3bf49923bcdb066b90b97bf2c225` (20 lines).
- `CLAUDE-ORCHESTRATOR.md`: does NOT exist — per OQ#2 treated as **destination-only target**, not source. The role layer is freshly authored.
- `bin/install-instructions.sh` pre: 52 lines (placeholder-only).

## Before / after content map

### CLAUDE.md → destinations

| CLAUDE.md line(s) | Content snippet | Destination | Notes |
|---|---|---|---|
| 1 | `@AGENTS.md` | **CLAUDE.md stub (kept)** | Per OQ#4: file-level autoload reference retained for direct-launch ergonomics; `--bare` boot adapter suppresses it for L1 spawn children. |
| 2, 4, 6 | blank | dropped | structural. |
| 3 | `# Claude Code — Orchestrator` | dropped (replaced by `roles/orchestrator.md` heading `# Role: orchestrator`) | Section heading rewritten. |
| 5 | `## Claude 전용 설정` | dropped | Per SPEC §3: resolver is CLI-agnostic at the role layer; per-CLI nuance is the boot-adapter's job (ADR §4.5.1). |
| 7-13 | telepty list dynamic session-ID resolver + `--submit-retry` / `--submit-force` flag policy | `roles/orchestrator.md` §"Dispatch protocol" | Content reproduced verbatim. |
| 14 | `superpowers 필수: "/using-superpowers로 진행해줘"` | `roles/orchestrator.md` §"Delegation payload requirements" bullet 1 | |
| 15 | skill routing list | `roles/orchestrator.md` §"Delegation payload requirements" bullet 3 | |
| 16 | "가지고 있는 모든 스킬…100% 활용" | `roles/orchestrator.md` §"Delegation payload requirements" bullet 2 | |
| 17 | `python3 ~/projects/aigentry-orchestrator/bin/session-layout.py` | `roles/orchestrator.md` §"Lifecycle" bullet 1 | |
| 18 | dustcraw 태스크 피드 | `roles/orchestrator.md` §"Lifecycle" bullet 2 | |
| 19 | 코드 수정 금지 / Rule 4 manifest | `roles/orchestrator.md` §"Hard rule — no direct execution" | Promoted to a top-level section; foundational. |

### AGENTS.md / CONSTITUTION.md / user-global CLAUDE.md → `common.md` (OQ#1)

Per orchestrator OQ#1 ruling: Article-level invariants are universal → `common.md`. Each extracted invariant cites its source line; AGENTS.md itself is unchanged (Rule 29 surgical).

| Extracted content | Source | Destination |
|---|---|---|
| Article 1 경량 (Lightweight) — 5-clause summary | `~/projects/aigentry/docs/CONSTITUTION.md` §제1조 (lines 21-29) | `common.md` §"Constitutional invariants" bullet 1 |
| Article 17 무의존 (Zero External Dependency) — 4-clause summary | `~/projects/aigentry/docs/CONSTITUTION.md` §제17조 (lines 220-227) | `common.md` §"Constitutional invariants" bullet 2 |
| Rule 29 외과적 변경 (Surgical edits) | `docs/rules.md` Rule 29 (lines 349-360) | `common.md` §"Constitutional invariants" bullet 3 |
| Rule 7 reporting path | `docs/rules.md` Rule 7 (lines 200-208) | `common.md` §"Reporting path (Rule 7 — HARD BLOCK)" |
| Snyk Security At Inception | `~/.claude/CLAUDE.md` (user-global, "Project security best practices") | `common.md` §"Snyk Security At Inception" |

### Orchestrator-specific dispatch / delegation rules

Per OQ#1 ruling: these stay in the orchestrator role layer (not `common.md`). Source references for completeness:

| Content | Source | Destination |
|---|---|---|
| AGENTS.md 위임 체크리스트 (delegation checklist) | `AGENTS.md` lines 5-30 | Conceptual link only; not duplicated. Orchestrator continues to load `AGENTS.md` for the full checklist. `roles/orchestrator.md` §"Delegation payload requirements" bullet 4 (SAWP + SPEC FIRST) cites Rule 17 + Rule 24. |
| `bin/dispatch.sh` Rule 32 HARD enforcement | `AGENTS.md` line 29 | `roles/orchestrator.md` §"Dispatch protocol" bullet 3 |
| Parallel delegation deliberation routing | `AGENTS.md` lines 80-89 | `roles/orchestrator.md` §"Parallel delegation — deliberation routing" |
| Response principles (critical / constructive / objective / multi-interpretation) | `AGENTS.md` lines 65-68 | `roles/orchestrator.md` §"Response principles" |
| Session cleanup (Rule 28) | `AGENTS.md` line 23 | `roles/orchestrator.md` §"Lifecycle" bullet 3 |

## Diff stats

| File | Before LOC | After LOC | Δ |
|---|---|---|---|
| `CLAUDE.md` | 20 | 17 | -3 |
| `bin/install-instructions.sh` | 52 | 70 | +18 (≤50 budget ✓) |
| `tooling/instructions/common.md` | — (new) | 43 | +43 |
| `tooling/instructions/roles/orchestrator.md` | — (new) | 74 | +74 |
| `tests/migration/run.sh` | — (new) | 131 | +131 |
| `tests/migration/claude-md-migration.test.ts` | — (new) | 130 | +130 |
| **Impl total** (CLAUDE.md + installer Δ + new content) | | | **+135 / 200 ✓** |
| **Tests total** | | | **+261** (bash + TS; budget was 200 — 30% overshoot, see §"Budget note") |

### Budget note

- SPEC §7 budgeted ~200 LOC tests; actual = 261 (bash 131 + TS 130). The overshoot is in the bash scenario file: 10 distinct hermetic scenarios with per-scenario tmp dirs + assertions reproduce more boilerplate than estimated. Each scenario remains tight (≤12 LOC). The TS file is 130 vs estimated 120 (+10). Total: +61 LOC over the SPEC §7 estimate. Filing this as a transparency note rather than a violation: Article 1 경량 budgets are estimates; the dispatch's hard ≤200 LOC impl budget is met; tests-budget overshoot is in the test layer only and surfaces no new abstractions or refactoring (Rule 29 surgical preserved).

## Anti-leak invariant verification

| Check | Result |
|---|---|
| `find ~/.aigentry/instructions -type l -lname '*CLAUDE.md'` (test T7) | 0 symlinks |
| `grep -E '@AGENTS\.md\|@CLAUDE\.md' tooling/instructions/**/*.md` (test T8) | 0 matches |
| `grep -E 'telepty inject\|session-layout\|submit-retry\|dustcraw 태스크' CLAUDE.md` (test T2 + TS M4) | 0 matches |
| Resolver source_path for orchestrator role layer (test TS M2) | `…/roles/orchestrator.md`, no `CLAUDE.md` substring |
| Boot adapter `--bare` (commit 426f3a9) | Active — cwd CLAUDE.md autoload suppressed for L1 children |

## Follow-up tasks filed (out of scope for #117)

1. **GEMINI.md migration** (OQ#3 deferred). Current `GEMINI.md` (11 lines) hardcodes `aigentry-orchestrator-gemini` session ID — **Rule 16 violation**. Target: separate dispatch to migrate Gemini orchestrator content into the same `roles/orchestrator.md` (no per-CLI overlay in the layer model) OR into a new per-CLI sidecar (architectural decision needed). Tracking: TODO file ticket.
2. **Telepty sandbox version alignment**. Local telepty build lacks `--submit` / `--submit-retry` / `--submit-force` flags referenced in the orchestrator dispatch protocol. Orchestrator-side build/install task recommended. Out of #117 scope per orchestrator instruction.
3. **Hard-fail flip for #11**. Per ADR §6 #11 ordering: blocks on #9 audit + #15 (gate integration) + Q-OPEN-2/4 acceptance. This migration (#6) is parallel and does not block #11.
4. **Optional consolidation of AGENTS.md checklist**. With `roles/orchestrator.md` now carrying delegation guidance, the orchestrator may eventually want to slim AGENTS.md to the universal pieces. SPEC §3 + dispatch explicitly kept AGENTS.md untouched (Rule 29). Filing as future cleanup.

## Rollback procedure

If this migration needs to be reverted:

```bash
# 1. Restore pre-migration files from git.
git checkout HEAD~1 -- CLAUDE.md bin/install-instructions.sh

# 2. Remove new content files + tests + this log.
rm -rf tooling/instructions/
rm -rf tests/migration/
rm state/migration/2026-05-12-claude-md-migration.md

# 3. Optionally reset any user-installed $AIGENTRY_HOME content.
# This is a user-local op; only required if the user wants to drop the
# layered files installed by the new installer:
#   rm -rf ~/.aigentry/instructions/

# 4. Verify: full test suite passes against the pre-migration tree.
npm test
```

Rollback is **idempotent**: running steps 1-3 twice is a no-op on the second run.

## Verification — pre-commit

- Bash tests: 10/10 pass (`bash tests/migration/run.sh`).
- TS tests: 124/124 pass (`npm test`).
- Anti-leak invariant: verified (table above).
- Rule 29 scope: clean (only CLAUDE.md + installer Δ + new layered files + new tests + this log touched; AGENTS.md / src/session/* / existing tests untouched).
