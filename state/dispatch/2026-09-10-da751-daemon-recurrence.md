---
dispatch_kind: fresh-session
task: 751
---
# Dispatch - da751-analyst - Explain recurrent production telepty daemon outages

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. State/docs/bin paths are orchestrator metadata unless explicitly designated evidence/output. Role-sandbox is not target worktree. No prior chat assumed.

## Role
You are da751-analyst, runtime analyst. Worktree /Users/duckyoungkim/.aigentry/worktrees/da751, branch evidence/751-daemon-recurrence, base17a6681.
Only tracked output docs/reports/2026-09-10-daemon-recurrence.md <=200lines. No code/config/daemon-state changes, no tests/builds/installs, no kill/restart/cleanup/launchctl kickstart. No other sessions/subagents.
Read-only installed telepty source resolved from command path and sibling /Users/duckyoungkim/projects/aigentry-telepty. Sibling root files cli.js, daemon-control.js, daemon.js exist; do not assume src/cli.js.
UniversalD external_dispatch auto analyst; samevisiblecmux. Independent publicproposal1149 architect active, max2workers. User specifically asks WHY daemon problems keep occurring; do not substitute another generic observation audit.

## Observed incident starting evidence
2026-09-10 around11:31-11:44UTC, all local. These are orchestrator observations, not a proven root cause:
- qc1136b-coder and pd1148b-dustcraw had consumed exactrefs in nativecmux. pd dispatch successfulwrite then helper Rule33 didNOTverify despiteexit0.
- telepty list PID35793 ran>42s, auto-started daemon and spawned launchctl kickstart -k gui/501/com.aigentry.telepty. It reported3failedsupervisorattempts no-daemon-after-launchd-restart then exit0 "No active sessions found". Native workers remained active.
- Subsequent launchctlprint showed running daemon37572, lsof127.0.0.1:3848; log restoredorchestrator/qc1136b/pd1148b, re-register/owner reconnect. Freshlist thenall3CONNECTED. No orchestrator/worker bridge restart was requested.
- At~11:41-11:43UTC another short INFO inject to pi1149-architect auto-started daemon and failedexit1 "launchd restart failed: Command failed: launchctl kickstart -k gui/501/com.aigentry.telepty" / sessionnotfound. Atone lsofsample no3848listener, later47644listening. launchctlruns grew337to344 acrosssamples, notcauseattribution.
- pd1148b finalreportinject independently failed after1m21s, retry saidstale/awaitingcleanup. Native worker completed and preserved sandboxREPORT. No initial daemonexit/initiator event captured; concurrentauto-restarts may amplify downtime but this is HYPOTHESIS.
- Gate decision-reconciler-07ee3a9fd7ca created11:38:37Z thenagain11:40:42Z sameID: both approvedresume=none after native completed/activecorrection observation. Originalscreenerrortriggerunknown; no explicitreinject. Do not equate false/no-longer-current classifier with initialdaemoncause.
- Parentorchestrator codexPID77974 bridge77940 ancestors13759/13758/13732/1 PROTECTED. ExistingdaemonjobPID maychange; workershaveownbridges. Never kill/self-restart anything.

## Read-only evidence sources
/Users/duckyoungkim/Library/Logs/aigentry-orchestrator/telepty-daemon.log (tail has listener/restoration/inject but manylineslacktimestamps).
launchctl print gui/501/com.aigentry.telepty -> jobplist /Users/duckyoungkim/Library/LaunchAgents/com.aigentry.telepty.plist; executable ~/.nvm/versions/node/v20.20.0/bin/telepty daemon. Env TELEPTY_NO_TAILNET_AUTO=1, PATH includesHomebrew first. stdout/stderr daemonlog.
Orchestrator environment observed TELEPTY_HOST/PORT/API_URL/URL/BIND and PORT unset. Main helper falls back to barelocalorchestrator since tailnet100.72.155.21:3848 doesnotanswer. Loopbackonlylistener is configured; don't labelthatcausewithoutmatchingaddressprobes.
Historical docs/reports/2026-09-10-session-observation-gap.md records differentproblems: restoredringempty, VTstrip vsnative, falseconsumptionprobes; originalrestartcauseunmeasured. Build on it, don't repeatthewholeaudit.
Installed telepty then0.8.3; installed/sibling parity previously312files at997ea7c7, historicalnotcurrent. Recheck relevant running-startup source metadata; fileparity != alreadyresidentmoduleparity.
Relevant prior tests/docs discovered names: test/ensure-daemon-running.test.js, test/start-path-liveness-82.test.js, test/kickstart-race-738.test.js, test/supervisor-restart-757.test.js, test/daemon-shutdown-handlers-916.test.js, docs/reports/2026-07-26-738-kickstart-race-{repro,fix}.md. Startinglistonly, count/reachabilityfromactualsource. DO NOT RUN TESTS.

## Required answer and deliverable
[SPEC FIRST] Read-only diagnosis before permanentfix. Establish timestamped timeline of listener/PID/job/log facts, distinguish historicalunsequencedlog fromtimedobservations. Structuredparse whenavailable; don'tdumpsecrets/prompts/auth/statepayloads.
Separate A initial daemonexit/unresponsiveness, B automaticrestart attempts/arbitration/timeouts and overlap, C false sessionmissing/STALE/errorclassification. Rank hypotheses against explicit confirming/refuting/missingevidence; "unknown" acceptable, unsupported certainty not.
Inspect actual ensureDaemonRunning/isDaemonRunning/health path, supervisorrestart serialization/settling/readiness and external callers. Does failedprobe killalive/startingdaemon? Which codebranches, budgets, locks and loggedoutcomes? Correlate actualPID/launchdhistory onlywhenavailable.
Use targeted readonly ps/lsof/launchctlprint and bounded macOS log show (job-specific past30min) if needed, no broad user data. Avoid telepty list/session/inject while diagnosing if they trigger automaticdaemonrestart; don'tcauseanotherincidenttomeasureit.
Propose smallest evidence-backed immediate mitigation and permanentrootfix, but DO NOT actuate. Give exact isolatedfailing-first fixture andcounterpart toconfirmfor futuretester/coder. Existing#738/#757/#896 guards mayexist: identify provenregression/missingcase, no duplicatefixbyname.
One concise Korean-ready bottomline: whatisconfirmed, whatcausedwhat, whatremainsunknown, whyitrecurs ifproved, safestnextstep. No sleep/Nodeversion/transportblamewithoutmeasurement.
Coordinateexistingtask751; no broad audit or new framework. Allretainedraw paths/hashes andmeasuredsha/maincurrentness inreport. No tests/runtimefixcompleteclaims.

## Workflow and reporting
Singleboundeddiagnosticphase: collectreadonlyexistinglogs/source/currentstatus -> analyze -> writeone report -> commit -> realREPORT/HOLD. CommitWIP at everyphaseboundary; a sleep/APIcut losesatmostonephase.
Thirdfailedattempt=>STUCK with exacterror, no silentloops. No operationsshould restartdaemon. Reporting notification alone uses telepty atphaseend; durablefilefirst, onceonly plus oneboundedretry ifneeded. Ifdaemonunavailable preserveREPORT-da751.md and finishwithpath; orchestratorpullsnatively.
Use all relevant skills/tools/MCP/workflows fully with Read/rg/Bash/git/structuredparsing/Edit/apply_patch; no extraagents, no planmode.

## HOLD inject protocol
ACTUALLY execute at boundary/blocker aftercommit:
telepty inject --ref --submit --submit-force --from da751-analyst {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: da751 | task: #751 | phase: recurring daemon diagnosis | needs: evidence review or exact missing event; no production intervention performed"
Ifdeliveryfails, preserveREPORT-da751.md and do notblindlyretryorrestart. Silentmarkdownisnotdelivery.

## REPORT
MANDATORY aftercommit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from da751-analyst {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: da751-DIAGNOSIS | task: #751 | file: docs/reports/2026-09-10-daemon-recurrence.md | include SHA/main/runtime-currentness, timedfacts vs hypotheses, initialcause vs recoveryamplification, recommendedmitigation and exactisolatedreproduction; no fixes/tests/restarts performed"

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
SAWP envelope/roletable verbatim. Analyst interprets existingruntimeevidence/source, notcode/build/test/designimplementation. Allload-bearinglimitsinline.

## Snyk and boundary
N/A docs-only. No credentialreading, source/config/queue/auth mutation, productionfaultinjection, processkill/signals, launchd/jobchanges, livepackageexecution, paidmodels, push, or cleanup. Protectedorchestratorandancestorsneverterminated. Do not infer taskcompletionfromgitactivity or daemonprocessrunningfromjoblabelalone.

