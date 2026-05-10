# Q'''-bis ADR r4 Codex Final Review (2026-05-10)

## §1 Verdict
**ACCEPT_WITH_MINOR_FIXES**

## §2 r3 8 edits verification
| Edit | Status | Note |
|---|---|---|
| E1 | PARTIAL | §4 gate, §6.1, §6.2, and §21 examples are fixed, but 3 remaining `inject`/`output` examples still omit `trace_id`: §3.8 lines 347-348 and §6.5 line 610. |
| E2 | PASS | H1/M34/L3a now say crash detection + audit/log preservation, fresh PTY/child, and no live PTY or in-flight SSH recovery. |
| E3 | PASS | §12.7.1 clearly separates Phase 1 entry, Phase 2 entry, and Phase 4; §12.2 marks C1 closed; §13 mirrors the matrix. |
| E4 | PASS | §13.1 now says Q'''-bis ADR amendment, `CONSTITUTION.md` untouched, and inlines macOS/Linux/no-WSL/Windows-pending E3 scope. |
| E5 | PASS | §17.1-§17.13 are numbered; all 13 headings include source mapping. |
| E6 | PASS | §15 intro, §17.8, and §22 consistently use 14 alternatives including Path C. |
| E7 | PASS | §18.7 inventories Tailscale/OpenSSH/jemalloc with fallback paths and Phase 1 dependency checks. |
| E8 | PASS | §7.2 and §21.1 mark `"lang": "rust"` examples conditional; §5.1 flags M24/M27/M28/M31 as Rust-conditional. |

## §3 New issues (post-r3)
1. E1 leakage remains: three `inject`/`output` examples without `trace_id` contradict B3 and §6.
2. E3 stale text remains: §9.2 line 802 still says "E3 caps at 10 MB; C1 amendment process to 15 MB available", while E3 is already closed at ≤15 MB.
3. §20.2 line 1429 still lists "E3 10 MB vs 15 MB target" as an explicit TBD, contradicting §13.1/§14 closure.

## §4 Constitutional re-check
Articles 1/2/3/5/7/9 remain PASS: the architecture is still lightweight, cross-OS/cross-machine, role-clean, best-first, interoperable, and independently operable. Article 13 PASS: §17 is stronger after r3, including trace-cost self-criticism. Article 15 remains PENDING by design for Phase 1 SSOT registration; no new violation. Article 17 PASS: §18.7 now gives fallback inventory and degraded-mode behavior.

## §5 Required minor fixes
1. Add `trace_id` to §3.8 lines 347-348 and §6.5 line 610.
2. Rewrite §9.2 line 802 to: target 5-8 MB, binding E3 ceiling ≤15 MB per ADR-E3-r1; future Phase 4 may tighten to ≤10 MB by follow-up ADR.
3. Remove the E3 row from §20.2 or mark it closed, and adjust the explicit TBD count if needed.

## §6 Final verdict
The r3 architecture is acceptable after the minor textual fixes above. No redesign or r5 debate is needed, but I would not final-commit the ADR until these contract-consistency edits land.

## §7 Suggested next step
- Orchestrator: apply the 3 minor edits, then ADR commit + Phase 0 task tracking.
