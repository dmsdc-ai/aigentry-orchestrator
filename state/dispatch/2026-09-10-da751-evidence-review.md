---
dispatch_kind: re-dispatch
task: 751
---
# Dispatch - da751-analyst - Separate observed recurrence from unproven cause

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC for revision. Carry-over from shared4524618ffbaf04a9e0eea955202f147a897e4ac177ad99d72621270e619acbd8 consumed; sameworktree/sole docs/reports/2026-09-10-daemon-recurrence.md and readonlysource/runtime limits.

## Bounded evidence review
[SPEC FIRST] One report revision only, no newbroadresearch/productionintervention. f41bca2 contains usefultimeline/codefacts but overclaims causalconfirmation:
1. T SIGKILL record is11:47 while firstoutage11:32; no callerPID/signaltrace links initialevent to kickstart. "not crash", "serving daemon SIGKILL'd byCLI", "refutecrash/SIGTERM" and Korean bottomline certainty exceedevidence. InitialcauseUNKNOWN; rankhypotheses withmissingcorrelation. No shutdownmessage is notproof.
2. Rawdaemon-restart.log (reviewerread) hasattempt/reason/stopped but no callerPID/requestID. Interleavedattemptsequences support multipleinvocations, not exactlytwoCLIprocesses or eachdeathcausality. 37msdeath reason claim/EADDRINUSE/second-k remainsUNKNOWN. MarkB amplificationsupportedhypothesis, NOT confirmed untilcontrolledrepro orcorrelatedtimedproof. 5sbudget<10sthrottle issource/runtimefact, not "alwaysmisses": 1swait, calllatency, phasealignment matter.
3. probeDaemonHealth(...,probeTimeoutMs()*3) isONE request at3xdeadline, nothealthrequest×3. waitForDaemonHealth actuallypolls getDaemonMeta, notcheaphealth. Correctexactchannels/counts.
4. absenceVerdict livenessguard executesONCE beforeforloop, notbeforeeverystop; aftercleanup supervisorwaitHealth(1000) acceptsrequestedmeta. Includeboth actualguards, don'tomit. Othercallerpurposelyrestartsversion/capability mismatch, soabsencecausecan'tbeinferredfromabsenceofstop-refused.
5. "listenbeforeledgerrestore" isUNTESTEDarchitectureproposal, notsmallestprovenfix. Synchronousrestorewouldstillblockeventloop andearlyAPIservingmayexposeuninitializedledger/sessionstate. Do NOT recommendapp.listenreorderasapprovedremedy. Likewise flocknewdependency/crossOS needsarchitectcontract, notprescribedimplementation.
6. C sourcechainreviewed: failedensure returnsundefined, discoveryconnecttimeoutcatchswallowed, emptyexit0. Preserveclearfinding, but freshisolatedreprostillneeded. Distinguish localunavailable vslegitimatelocalempty vsremote-onlypartialdiscovery.
7. Preserve rawtimedlaunchd/restart excerpts with exactfilepaths andhashes inignored evidence beforecleanup; logfilesmutate. Don't leakauth/prompts. No newruntimeprobes needed just to weakenclaims.

## Workflow/report
Revise <=180lines, commit, realREPORT/HOLD. CommitWIP everyboundary. No tests/code/restarts/extraagents. Originalproposal remains evidencehistory; correctionmusttravelwithit. Narrowarchitecture/failing-first contract willbe anotherowner.
telepty inject --ref --submit --submit-force --from da751-analyst {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: da751 | task: #751 | phase: evidence qualification | needs: report review; initialcause remains unmeasured"
MANDATORY aftercommit:
telepty inject --ref --submit --submit-force --submit-retry 2 --from da751-analyst {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: da751-DIAGNOSIS-REVISED | task: #751 | file: docs/reports/2026-09-10-daemon-recurrence.md | includeSHA/maincurrentness, exactconfirmedfacts vs hypotheses andretainedrawpaths/hashes; no fixes/tests/restarts"
Durable --ref; ifdeliveryfailskeepREPORT-da751.md andfinishfornativepull, no blindrestart.

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

## Boundary and capability
Sameanalystrole, Read/Edit/apply_patch/git/logreview only. Fulltools/skills/MCPwithinthatscope, no planmode/additionalworkers. SnykN/A docs-only. No mutationofsource/config/auth/livequeue/services. Nouserpolicyquestionsintroduced.

