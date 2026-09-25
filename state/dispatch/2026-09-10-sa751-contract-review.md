---
dispatch_kind: re-dispatch
task: 751
---
# Dispatch - sa751-architect - Correct recovery contract safety gaps

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC for one bounded revision. Carry-over from shared12b3d5dcac80d067d849543aeac5269c16e992bdbcca4178de4607f998d2ff53 consumed. Same worktree /Users/duckyoungkim/.aigentry/worktrees/sa751 and sole docs/specs/2026-09-10-telepty-recovery-contract.md, <=200lines. No source/code/tests/runtime changes.

## Review Findings
[SPEC FIRST] Draft has useful inventory but is NOT approved. Re-read actual predicates for these specific conflicts, then revise once:
1. I4 single recovery owner contradicts deliberate paths "break a foreign claim rather than wait". ALL destructive paths must respect a live owner and revalidate after wait. Explicit update/repair intent is preserved by eventual bounded execution or named busy/error, NOT stealing another in-flight owner. Do not offer unsafe absence-only vs live-claim-stealing as user preference.
2. O_EXCL+write has publication window, stale check/unlink races and unconditional release can unlink a successor claim. Age>budget does not prove live holder stopped (sleep/eventloopdelay); PIDreuse/EPERM/unknown/malformed/symlink/NFS matter. No live age-only steal. Specify ownership identity/release/reclaim safety or explicitly defer uncertain stale auto-reclaim to fail-closed. "$HOME local by construction" false, drop. "~35 lines" unmeasured estimate, drop. Do not rework mailbox lock unrelated to task.
3. Earlier ensure healthy does NOT authorize empty result if subsequent sessions fetch fails: TOCTOU. Empty may only mean current successful sessions response with validated[]; failures stay unavailable regardless previoushealthy. Specify explicit remotehost/remote-only/partialdiscovery semantics, exitcode and stdout exactly. Existing peerFailures marksfailure but liststillprints "No active sessions found" ifempty; cannot claim D2 suppressesthatlinewithoutcodebranchspec. ensure throwsabort is not "returnsundefined on everypath" contradiction.
4. Revalidation before cleanup alone leaves cleanup->kickstart window where supervisor/other owner becomeshealthy. Name exact per-step check and identity/intent guards. Keep deliberate version/capability intent without health200 blocking intendedupdate; clarify absence vsdeliberate. Revalidate fullpolicy for waitingjoiner, nothealth-onlypassedtopolicywhichneedmeta/caps.
5. 5->10s budgeting is not provenfix; multiple3attempt+defer+probenetworktimeouts canexceedouterbudget. Define one monotonic bounded overall deadline, remainingtime perprobe/action, settle window supported bymodel (notexact production10s guaranteeready). No timeoutincrease-only remedy claim; preserve prior error/refusal/port/noorphan guards.
6. TEST SAFETY: reviewer read test-support/block-signals.js: patches process.kill and cp.spawn only (blocks arg exactlydaemon), NOT execFileSync/execSync/spawnSync launchctl/systemctl/schtasks. setup-env isolates HOME, notUIDsupervisor. Proposed C can reachreal supervisor invocation. Must fail-closed all OS supervisor/process actuation and publicnetwork before any fixture run, preferably injected known seams and explicit runner harness interception; verify canaries without productionaction. TELEPTY_NO_SUPERVISOR_DEFER merelyskipsdeferwait, notsupervisorrestart. Distinguish expected BLOCKED-SPAWN from BLOCKED-SIGNAL; "emptyrecordlog" contradicts intendedblockedspawn negativefixture.
7. B with two concurrentcalls inoneprocess cannot prove CROSS-PROCESS lockexclusion. Add actualisolatedchildprocess sharedclaim/barriers andownercrash/release/contentioncases, realproductfunction seams; no ownhandrolledrecoveryalgorithm. Simulatedtimingmodel notincidentrootproof. No assumptionexactlaunchd37ms cause.
8. Fileownership table mustonefilepersession: two newtestfiles requireseparateowners (or one bounded singlefixture file), package.json iscodeowner notbuildermanualwrite. Code onlyAFTERred+exactcandidateconfirmation, so do NOT schedule helperproductioncoder inparallelbeforered. Scopecaller/readinventory "everydestructive" needexactmeasuredsourcecallers orweaken. No needbroaderresearch.
9. Activation: retainnoautomaticsymlinkmainmerge/restart/publication here, but don't claim successorsforeverforbiddenfromreleasedeploy (separateapprovedbuildergate needed). Report remaining materialbehaviorquestion only aftersafetyresolved; don't askuserpickunsafeconcurrency.

## Workflow and Report
One docs-only bounded revision, commit atboundary (WIPallowed); no implementation/testing. All source reads startingevidence mustrechecked; keep exactsha/currentness and unknownruntime. SnykN/A docs-only. Usealltools/skills/MCPwithinscope; noextraagents/planmode.
ACTUALLY execute aftercommit:
telepty inject --ref --submit --submit-force --from sa751-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: sa751 | task: #751 | phase: corrected recovery contract | needs: spec review before safe isolated reproduction; no live actions"
MANDATORY:
telepty inject --ref --submit --submit-force --submit-retry 2 --from sa751-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: sa751-SPEC-REVISED | task: #751 | file: docs/specs/2026-09-10-telepty-recovery-contract.md | includeSHA/maincurrentness, concurrency/failure/testisolation guarantees and remaining decisions; no code/tests"
Durable--reffirst, REPORT-sa751.md fallback ifdeliveryfails; no restartnotificationloop.

## [SAWP] Envelope
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

## Boundary
Same architect docs-only role. No product/source/livequeue/config/auth/daemon mutation, tests, builds, publication, processkill orsupervisorinvocation. Protectedorchestrator andancestors neverterminated. Sourcequalification notruntimeproof.

