# Q'''-bis ADR Codex Cross-LLM Review (2026-05-10)

## §1 Verdict

**ACCEPT_WITH_FIXES**.

Top issue: the ADR direction is sound, but two binding acceptance clauses are internally inconsistent enough to mislead implementers: B3 requires `trace_id` on every inject/output while the wire schema makes it optional in Phase 1, and H1/M34 promise state recovery after killing the same process that owns the PTY.

Review basis: primary ADR `docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis.md` plus E3 amendment, bilingual ops report, synthesis report, source drafts, Constitution, AGENTS.md, and boundary ADR.

## §2 Locked decisions verification

Locked architecture is **consistent**: L1=Tailscale, L2=telepty, L3=AI CLI is explicit in §2.4 (`L1 machine : Tailscale`, `L2 session : telepty`, `L3 process : AI CLI`, lines 170-190). Daemon removal is locked in §1.1 and §3.2 (lines 58-64, 240-250). Per-session supervisor and per-host relay are locked at lines 60-61 and specified at lines 252-287. UDS/Named Pipe and TCP-loopback rejection are clear at lines 327-340. NDJSON is locked at lines 342-362. Phase 1 auth is POSIX/Windows owner controls plus OpenSSH over Tailscale, with no telepty token in Phase 1 (lines 364-373, 863-880).

## §3 r2 integration correctness (F1/F2/F3/F4)

**F1: PARTIAL.** The six named E3 locations are edited: §4.E (line 445), §10.1 (line 832), §10.3 (lines 851-853), §13.1 (line 1026), §14 (line 1096), §17.1 (line 1232). However, §13.1 still says the closure artifact is an amendment merged in `CONSTITUTION.md` (line 1024), while ADR-E3 explicitly says `CONSTITUTION.md` is not textually amended (E3 lines 16, 198, 239). Also, the final E3 row omits the amendment's explicit OS/no-WSL acceptance detail (E3 lines 97, 264), and Phase 0 still lists C1 as an open task (Q'''-bis lines 906-916) despite C1 being closed (line 1503).

**F2: PASS.** Path C disqualification matches the bilingual-ops source: Go `os/exec` cannot set required ConPTY process attributes, with #62708/#6271 cited (Q'''-bis lines 1117-1126; bilingual report lines 23, 162-171, 251-274).

**F3: PASS_WITH_CLARIFY.** §14 has the intended row (line 1093), but "Node maintain (FAIL C2)" should be reworded to "Node fallback if C2 FAILS" to avoid reading Node itself as failed. The bilingual report says C2 FAIL collapses to Path A/Node maintained (lines 10, 21, 263-267).

**F4: PASS.** M28 has the conditional Rust callout and Path A fallback (line 528).

## §4 31/39 requirements

The 31-label / 39-visible framing is correct and transparent (§1.5 lines 103-111). §4 enumerates A-K, including K1 at lines 488-494. Acceptance gates are grouped at lines 496-510.

Blocking defect: B3 says every inject and output carries `trace_id` (line 419), but §6.1 says `trace_id` is optional in Phase 1 (line 562), §6.2 does not require it on `output` (lines 571-572), and output examples omit it (lines 585, 1448, 1450, 1467, 1470). Pick one rule. My recommendation: preserve B3 and make `trace_id` required for `inject`/`output` in Phase 1.

## §5 19 mandates

All 19 mandates M22-M40 are present (lines 522-540), and M37'/M38' explicitly replace M37/M38 (lines 516-538). Most acceptance criteria are inherited from served requirements in §4.

Blocking defect: H1/M34 overpromise. H1 requires `kill -9 supervisor -> restart within 5 s with same id, manifest replays log offset` (line 468), and M34 repeats "state recovery" (line 534). But §3.3/§9.1 say the supervisor itself owns the PTY (lines 254-267, 790-794). If that process is killed, the PTY master FD is gone; live PTY recovery is not available without adding a second PTY-owning component, which contradicts the 1-process model. Fix by changing H1/M34 to crash detection plus manifest status/log recovery, not live PTY recovery.

## §6 Self-criticism integration

E3 closure is updated in §17.1 (line 1232). The constructive frame is present (line 1288).

But the ADR claims "13 sub-points" (line 1324, also line 1491), while §17 has only 12 numbered headings (lines 1228-1283) and an unnumbered constructive frame. The synthesis report says this was intended as "12 distinct + 1 constructive frame" (synthesis lines 116-132). Also, §17 does not label the LLM source per sub-point; the source mapping exists only in the synthesis report. Fix by either adding `§17.13 Constructive frame` and source tags, or changing all claims to "12 + constructive frame" and pointing to the synthesis mapping.

## §7 Constitutional alignment

The ADR covers Articles 1/2/3/5/7/9/13/15/17 in §18.6 (lines 1314-1327), and the role split matches the boundary ADR's telepty/devkit rule (boundary ADR lines 135-140).

No hard constitutional violation found, but there is one Article 17 risk. Constitution Article 17 requires fallback paths when external dependencies are needed (Constitution lines 220-227). Q'''-bis names Tailscale, SSH, and jemalloc (line 1304), but does not spell out fallback/degraded-mode behavior. Add a small dependency inventory: Tailscale absent -> local-only or explicit cross-machine unavailable; OpenSSH absent -> cross-machine unavailable; jemalloc unavailable -> E3 cannot be certified, fail Phase 1 perf gate.

## §8 Phase plan

Phases 0-4 have tasks and exits (lines 890-987), and migration ADR #379 is referenced for J3/0.3.x -> 1.0 (lines 486, 930, 1094, 1359-1365).

However, the gating matrix is inconsistent. §12.7 says C1-C4 gate Phase 1 entry (line 991), and §13 says Phase 1 entry is denied until all four close (line 1000). But C2 is titled and described as a Phase 2 entry prerequisite (lines 1028, 1045), while §12.7 also says Phase 1 -> Phase 2 depends on C2 (line 992). Fix the matrix: decide whether C2 is Phase 1 entry, Phase 2 entry, or both with different subcriteria.

## §9 Alternatives

Path C rejection is clear and placed acceptably after Q''' and before D (lines 1117-1128). The Go disqualification is well supported by the bilingual-ops report.

Minor r2 drift: adding Path C makes the alternative count stale. §17.8 says 13 entries (line 1265), and the self-check says §15 has 13 alternatives (line 1489), but §15 now has Q''', Path C, D, Q, I', Y, CC, N, O, plus five compact transport/cap variants (lines 1111-1178): 14 total if Path C is counted.

## §10 New issues / blind spots (codex unique view)

1. **Trace schema contradiction**: B3 vs §6/examples (lines 419, 562, 571-572, 585, 1448-1470).
2. **Impossible PTY crash recovery**: H1/M34 promise live state recovery after killing the PTY owner (lines 468, 534, 790-794).
3. **Gate ambiguity**: C2 is both Phase 1 and Phase 2 gating (lines 991-1000, 1028, 1045).
4. **E3 closure artifact mismatch**: Q'''-bis still says `CONSTITUTION.md` merge; E3 says Constitution untouched (Q'''-bis line 1024; E3 lines 16, 198, 239).
5. **Self-crit count/source mismatch**: 13 claimed, 12 headings visible, no per-point source tags (lines 1228-1288, 1324).
6. **Article 17 fallback gap**: dependencies named but fallback/degraded-mode behavior absent (Q'''-bis line 1304; Constitution lines 220-227).
7. **Rust bias leakage remains**: language is TBD (lines 126, 392, 1383) but manifest examples hard-code `"lang": "rust"` (lines 690, 1434), and multiple mandate examples assume tokio/jemalloc. Keep Rust as leading candidate, but mark examples "illustrative if Rust selected."

## §11 Required follow-up tasks

1. Update §6 schema and examples so `trace_id` is required for inject/output, or weaken B3 consistently.
2. Rewrite H1/M34/L3a wording to distinguish supervisor crash detection from live PTY recovery; do not promise same-PTY recovery after supervisor `kill -9`.
3. Normalize Phase 0/1/2 gate language for C1-C4, especially C1 closed and C2's entry point.
4. Fix §13.1 E3 closure artifact to "Q'''-bis ADR amendment; Constitution unchanged"; add the OS/no-WSL E3 acceptance wording.
5. Fix §17 count/source: add `§17.13` or change claims to "12 + constructive frame"; add source tags or a pointer to synthesis lines 116-132.
6. Update alternative counts after Path C insertion.
7. Add Article 17 dependency/fallback inventory for Tailscale, OpenSSH, jemalloc.
8. Mark Rust-specific examples as conditional until supervisor language is locked.

## §12 Final verdict justification

The ADR should proceed after fixes. The core locked architecture is internally coherent: daemon-zero, per-session supervisor, per-host relay, OS-native IPC, NDJSON, and small Phase 1 auth all align with the grill outcome and the Constitution's role separation. The required edits are not a redesign, but they are not cosmetic either: B3/trace, H1/recovery, and C2 gating affect implementer contracts. After those are corrected, I would move the ADR from proposed to accepted once the remaining C2-C4 gates close or are explicitly waived by successor ADR.
