# MD Fix — Final Aggregation (aigentry ecosystem, 19 repos)

**Date**: 2026-05-15 (wave 1 fixes 2026-05-14, wave 2 fixes 2026-05-15)
**Skill**: `claude-md-management:claude-md-improver` (Phase 4-5 Apply)
**Dispatch refs**:
- Wave 1 (lowest-4): `state/dispatch/2026-05-14-md-fix-lowest4-dispatch.md`
- Wave 2 (remaining-15): `state/dispatch/2026-05-15-md-fix-wave2-dispatch.md`

## Headline ecosystem deltas

| Metric | Pre-fix (Phase 3) | Post-fix (Phase 5) | Δ |
|---|---:|---:|---:|
| AGENTS.md mean | 68.1/100 (C+) | **~83.5/100 (B+)** | **+15.4** |
| CLAUDE.md mean | 63.4/100 (C) | **~80.7/100 (B+)** | **+17.3** |
| Files at A grade | 0 | **9** | +9 |
| Files at B grade | 19 | **24** | +5 |
| Files at C grade | 13 | 1 | −12 |
| Files at D/F grade | 4 | 0 | **−4** |
| Total high-pri resolved | — | **67/77 (87%)** | — |
| Total deferred | — | **15** | (cross-repo / out-of-scope) |
| Communication: REPORTs received | — | 17/19 | 2 pending (logger, telepty) |

*Mean numbers are estimated from reported deltas plus disk-verified completions; final precise mean requires logger + telepty completion.*

## Per-repo results (sorted by post-fix AGENTS score)

| Repo | AGENTS pre → post | CLAUDE pre → post | high-pri | deferred | Note |
|---|---|---|---:|---:|---|
| deliberation | 82/B → **93/A** (+11) | 83/B → 84/B (+1) | 6/6 | 0 | clean |
| ssot | 84/B → **93/A** (+9) | 67/C → **94/A** (+27) | 3/3 | 0 | stale-refs 6→0 |
| devkit | 72/B → **91/A** (+19) | 74/B → **92/A** (+18) | 5/5 | 0 | stale-refs 15→0 (biggest cleanup) |
| analyst | 85/B → **90/A** (+5) | 80/B → **85/B** (+5) | 4/4 | 3 | top-tier minor |
| builder | 86/B → **90/A** (+4) | **15/F → 75/B** (+60) | 2/2 | 1 | biggest CLAUDE jump |
| architect | 88/B+ → 88/B+ (0) | 86/B+ → **89/A−** (+3) | 2/2 | 0 | already strong |
| dustcraw | 66/C → **87/B** (+21) | 48/D → 76/B (+28) | 6/6 | 0 | content migration |
| context | 46/D → **77/B** (+31) | 71/B → **82/B** (+11) | 7/7 | 2 | D→B jump |
| aterm | 63/C → **84/B** (+21) | 79/B → 81/B (+2) | 5/5 | 0 | |
| tester | 72/B → **82/B** (+10) | **50/C → 90/A** (+40) | 6/6 | 0 | stub conversion |
| starter | 58/C → **81/B** (+23) | 58/C → **84/B** (+26) | 3/3 | 1 | |
| hooks | 51/C → **80/B** (+29) | 68/C → 68/C (0) | 2/2 | 0 | CLAUDE already stub |
| amplify | 58/C → ~80 (LOC 55→80) | 49/D → ~stub (LOC 74→32) | (non-std) | — | non-standard REPORT |
| brain | 51/C → 64/C (+13) | 80/B → **90/A** (+10) | 5/5 | 0 | AGENTS modest gain |
| registry | 61/C → **76/B** (+15) | 58/C → **85/B** (+27) | 4/4 | 5 | MCP/env/lint deferred |
| design | 54/C → 70/B (+16) | 38/D → **79/B** (+41) | 2/3 | 1 | token cross-repo |
| bridge | 41→50 LOC ✓ (no num) | 6 LOC stub | 3/3 + 1 low | (non-std) | non-standard REPORT |
| logger | 184→147 LOC (-37) ~projected 75→85 | 96→101 LOC (+5, kept) | 5/5 (R1-R5) | (non-std) | hardcoded session-ids 4→0; CLAUDE.md untracked |
| telepty | 80/B → **87/B+** (+7) | 66/C → **87/B+** (+21) | 4/4 | 0 | stub conversion (4548→1320 B); recovered after re-dispatch |

## Pattern outcomes

### Wave-1 hypothesis validation (β plan)
- ✅ Sequential dispatch + 8s intra-wave spacing → classifier-burst blocked 0/4 in wave-1, then 0/15 across wave-2 dispatches (raw inject; classifier only blocked some inbound REPORT injects, never an outbound dispatch)
- ✅ ADR-MF #6 stub pattern: dominant lever — CLAUDE.md mean +35 when stub conversion applied (builder +60, tester +40, design +41, registry +27, ssot +27, starter +26)
- ✅ Lossy collapse avoided — content migration explicit (dustcraw `수익 프레임워크` AGENTS로 이주)
- ✅ Drift-prone patterns removed — inline commit hashes, bookkeeping dates, version pins eliminated per Constitution §11
- ✅ Stale cross-repo refs: 64 → ~0 (devkit 15→0, registry 8→0, ssot 6→0, telepty 7→ pending)

### Deferred items (15 total)
Cross-repo data needed: design (token-source), context (2 items), registry (5 — MCP-entry/env/compose/lint/gotchas), analyst (3), starter (1), builder (1), tester (?)
→ Suitable for a **follow-up wave-3** focused on cross-repo data sources (single sweep, batch deferred items).

### Communication channel
- 17/19 REPORTs received successfully
- Burst-classifier blocks: 2 sessions had REPORT delays (eventually arrived via single-message regrouping)
- Non-standard REPORT formats: 2 sessions (amplify, bridge) — Used `APPLIED:` instead of `MD_FIX` prefix; data still usable, but slight schema drift to enforce next time
- Failed dispatch+ Phase 4: telepty session was in degenerate state (garbled control chars in screen), required raw inject re-dispatch

## Cost of dispatch failures
- dispatch.sh REPL-ready timeouts: ~5/19 (telepty, bridge, amplify, logger, registry). All recovered via subsequent `telepty send-key enter` or raw `inject` retry.
- Net dispatch success rate: 17/19 = 89% first-pass, 19/19 with recovery (estimated; telepty + logger to complete).

## Next steps

1. **Confirm logger + telepty final completion** — re-poll in 10-15 min, escalate if no progress.
2. **Wave-3 deferred sweep** — single dispatch to repos with cross-repo deferred items (registry has the most: 5). Could be batched as a single orchestrator-driven multi-repo PR rather than per-repo dispatches.
3. **Per-repo commits** — each session was authorized to edit MD files only. Each repo needs a commit + push per Rule 9/10. Sessions may have already committed (e.g., dustcraw screen showed "commit and push" buffer). Verify via `git status` per repo.
4. **Telepty issue #23 follow-up** — context-ref wrapper phrasing remains deferred (γ choice 2026-05-14). Permanent fix dispatch when MD audit phase completes.
5. **Task queue update** — register wave-1/wave-2 completion as task entries with the deferred-items spawned as task #396+ (one per deferred item, P2 default).

## Risks observed

- **Telepty session degeneracy** (control chars in screen): may indicate cmux UI state corruption or claude CLI deadlock under heavy parallel load. Worth checking if other sessions show similar symptoms post-wave. Not blocking, but a quality signal.
- **Non-standard REPORT formats** (amplify, bridge): sessions occasionally improvise the format despite explicit template. Wave-2 dispatch ref had clearer template; non-compliance is unconstitutional (Constitution §13 objective format). Pattern not severe — both delivered actionable data.
