---
dispatch_kind: re-dispatch
task: 1136
---
# Dispatch - qt1136b-tester - Confirm bounded correction strategy in disposable fixtures

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. Carry-over from 2026-09-10-qt1136b-boundary-runtime.md, whose exact ref3687f861 you consumed and completed as report616da2c. Same tester role/worktree/report ownership. Orchestrator state paths are metadata, not editable by you.

## Role and boundary
Continue qt1136b-tester in /Users/duckyoungkim/.aigentry/worktrees/qt1136b, branch test/1136-queue-boundary-runtime.
Exclusive tracked output remains docs/reports/2026-09-10-queue-boundary-test-runtime.md. Preserve its original run as historical evidence; append a clearly separate comparison section, whole report <=220lines.
Production bin/tq-write.py, test TS, current dist JS and all package/runner/config files are READ-ONLY. This is controlled fixture/strategy testing, NOT permission to implement or commit a helper fix.
You may create a DISPOSABLE SYNTHETIC execution tree under this worktree's ignored dist for controlled original-versus-candidate fixture comparison. No main or other worktree edits, no real queue, no path policy/default changes.

## Why this next phase
Original compiled run is confirmed: original helperd361397 + compiledJSd3ed307c... onNode20.20.0,56tests51pass5fail; no setup failure. Orchestrator reread full stdout.tap and independently counted actual result lines and failures, SHAde3337b9... .
This phase confirms whether the exact bounded remedy actually resolves those witnesses BEFORE a permanent code fix is dispatched. Do not merely rerun unchanged baseline or infer success from source inspection.
User approval of TQ containment is still pending and unrelated to this nonproduction comparison. No AIGENTRY_ROOT enforcement, security waiver, live caller wiring or release action.

## Candidate source proposals to validate, not facts
Coder qc1136b supplied these by inspection in ref5bccc9f3 and explicitly corrected all execution claims in refa65ed9a1. No proposed diff was applied or tested by coder.
1. apply_note_append: distinguish absent key from present null. Missing or empty string =>segmentalone; present null/list/number=>4; nonemptystring=>prior+" || "+segment. Replace the wrong161-null comment in a candidate only, not original source.
2. canonical_id integer match key: pass through binary64 float then existing _js_number_text, as for numeric JSON.parse; catch OverflowError/nonfinite=>4. Preserve the stored original integer value/type. Bool must stay unmatchable, not1. Multiple rows collapsing to one canonical requested text=>existing2 AMBIGUOUS_TASK, not guessed selection.
3. Numeric parsing: parse_float finite-check for ALL decoded fields, alongside existing parse_constant refusal; add allow_nan=False as serialization backstop. Reject unrelatedraw1e400=>4, never emitInfinity or coerce to null.
4. Serialization failures: catch UnicodeError/ValueError separately from OS errors, ensure own-temp cleanup and return4 before replacement. Preserve OSprecommit7 and postreplace directoryfsync8. Existing main catches only Refusal and staging catches onlyOSError, causing current uncaughtUnicodeEncodeError/leak.
These are a bounded starting recipe, not proven universal ECMA conformance. If an exact recipe is insufficient, report actual failure and HOLD instead of designing a broader production solution.

## Controlled comparison method
[SPEC FIRST] Authorized TEST-ONLY counterpart: copy exact original helper and exact compiledJS into a fresh synthetic execution tree, then apply ONLY the listed candidate transformations to the COPY via apply_patch. No committed production/test-source edit.
Record exact original/candidate helper hashes and a concise complete candidate diff in the owned report, so coder can reproduce the tested remedy later. Do not replace source with a reimplemented queue writer or monkeypatch away assertions.
Keep compiledJS byte-identical SHA256d3ed307c55796d45fb28052ae40df152b6f78188214be46b0dd3b22d60e0029f in both trees, with package ESM context copied byte-identically. REPO three-parent resolution must point to the respective synthetic tree and candidate helper there.
Use /Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/node explicitly, minimal synthetic HOME/TMPDIR/env, test-created syntheticTQ, outer90s and joined children. No npm/tsc/transpile/other suites/build.
Prior original full run can serve as baseline after verifying pins; run the candidate full compiled file and report actual TAP totals/failures. Do NOT label a candidate run as original or overwrite prior evidence.
Add only focused direct controls needed for candidate numeric change: two distinct huge integer literals mapping to the SAME JS-text must refuse2 unchanged; integer beyond binary64 range must refuse4 unchanged. Use Node JSON.parse(raw)/String as the oracle, same raw fixture in Python helper, and bounded isolated harnesses; report controls separately from56compiled counts.
If candidate passes all56 plus controls, it establishes only this exact strategy under these fixtures. No full finite-double formatting proof, race/caller integration, arbitrary input coverage, security approval or power-loss guarantee.

## Security and preservation
Candidate Python is changed first-party fixture code: scan isolated candidate copy with normal authenticated Snyk Code, preserving exact scope/results. Do not suppress or waive known original2LOW, alter root policy to chasezero, read credentials or reconfigure auth. If findings remain, report gate unmet; this evidence phase never claims code/securityDONE.
Any separately authored fixture harness must be scanned independently and named; report-only tracked file itself is not the Python scan.
Retain candidate fixture/diff and raw TAP in ignored local evidence directory until orchestrator preservation review. Clean only bounded runtime temp cases/processes you created; do not delete baseline evidence or candidate before handoff.
No live model/runtime/daemon/telepty from fixture processes; real telepty only for your reporting outside fixtures. No sessions/subagents or peer delegation.

## Workflow
One bounded comparison phase: verify original pins -> construct exact test-only counterpart -> execute candidate compiled suite+two direct controls -> isolated scan -> append exact evidence/diff -> commit report -> actual HOLD/REPORT.
Commit WIP at each phase boundary; at most3 attempts only with identified cause. No speculative expanding fixes; if recipe/contract needs expansion, actual HOLD. Every started process must end before reporting.
Use applicable test tools/skills/MCP fully within role. No plan mode, production edits or codecommit masquerading as evidence.

## HOLD inject protocol
ACTUALLY execute at blocker or completion:
telepty inject --ref --submit --submit-force --from qt1136b-tester {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qt1136b | task: #1136 | phase: isolated correction counterpart | needs: exact failed recipe or permanent-fix authorization after measured counterpart"
If inject fails preserve REPORT-qt1136b.md and retry once at next boundary. Inline markdown is not a notification.

## REPORT
MANDATORY after commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from qt1136b-tester {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qt1136b-STRATEGY | task: #1136 | file: docs/reports/2026-09-10-queue-boundary-test-runtime.md | include commit/currentness, exact candidate diff/hash, unchangedJS hash, candidate Node20 totals/results, two direct controls separately, actual scan scopes/results and preserved evidence paths | TEST-ONLY counterpart, no permanent code edits/security approval; parent incomplete"
A new candidate structured TEST_REPORT, if sent, MUST use a distinct suite name queue-writer-boundary-fixture-counterpart. Do not resubmit the original pinned-baseline totals or call candidate data a production result.

## [SAWP] envelope
# SAWP (Session Autonomous Workflow Protocol)

Rule 17 전문. 모든 위임 inject에 [SAWP] envelope 포함.

## Envelope (verbatim)

```
[SAWP] After completing this task:
- Code + compile check (cargo check / swift build), do NOT run app (builder handles app execution)
- Do NOT run tests (tester handles tests)
- If compile error → fix immediately, do NOT report "ready for builder" with broken code
- If stuck after 3 attempts → report STUCK with full error
- Never idle — report immediately when done
- Evidence only — no "should work" or "probably fixed"
- Preserve ALL existing fixes in modified files (check file invariants before reporting)
```

## 역할 분리 테이블

| 세션 유형 | 역할 | 빌드 | 테스트 | 로그 | runtime 분석 | 설계 분석 |
|----------|------|:----:|:------:|:----:|:------------:|:--------:|
| 코드 세션 | 코드 수정만 | ❌ | ❌ | ❌ | ❌ | ❌ |
| builder (aigentry-builder-*) | 빌드 + 앱 실행만 | ✓ | ❌ | ❌ | ❌ | ❌ |
| tester (aigentry-tester-*) | 테스트만 + TC 축적 | ❌ | ✓ | ❌ | ❌ | ❌ |
| logger (aigentry-logger-*) | 로그 수집 + 전달만 | ❌ | ❌ | ✓ | ❌ | ❌ |
| analyst (aigentry-analyst-*) | runtime 로그/데이터 분석 + 판단 | ❌ | ❌ | ❌ | ✓ | ❌ |
| architect (aigentry-architect-*) | 시스템 설계, 위헌 심사, 트레이드오프, 리팩토링 | ❌ | ❌ | ❌ | ❌ | ✓ |

## 파이프라인

**디버깅 (runtime 버그)**: builder(빌드+실행) → logger(로그 수집+전달) → analyst(runtime 분석+판단) → 오케스트레이터(위임 결정)

**설계 (구조/아키텍처 결정)**: 사용자/오케스트레이터(요구) → architect(설계 분석+제안) → 오케스트레이터(SPEC 위임) → 코드 세션(구현)

## 경계 원칙

- builder는 로그를 분석하지 않는다 — 실행만
- logger는 판단하지 않는다 — 캡처+전달만
- analyst는 코드를 수정하지 않는다 — runtime 분석+판단만 (로그/데이터 기반)
- architect는 코드를 수정하지 않는다 — 설계 분석+제안만 (구조/의존성/트레이드오프 기반)
- **analyst vs architect**: analyst는 **이미 발생한 일**(로그/데이터/버그)을 본다, architect는 **앞으로 만들 것**(설계/구조/리팩토링)을 본다
- 코드 세션은 빌드/테스트/로그/분석/설계하지 않는다 — 코드만

## Inline excerpts
Carry-over role remains tester; controlled synthetic fixture variants and their execution are test work. Committed production implementation belongs to the coder only AFTER confirmation. Full envelope and role table are verbatim above; all extra permissions and prohibitions for this comparison are inline.
