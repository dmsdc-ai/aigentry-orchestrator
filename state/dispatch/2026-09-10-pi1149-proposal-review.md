---
dispatch_kind: re-dispatch
task: 1149
---
# Dispatch - pi1149-architect - Correct public proposal evidence and safety claims

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC for this revision. Carry-over from consumed sharedffbec99b1607eed25f4d1d0bc749873032e2ca149c6ffd2bffbf5f307cd33188; same worktree/sole output and no-install/no-code boundaries. State paths orchestrator metadata.

## Role and output
Same pi1149-architect, /Users/duckyoungkim/.aigentry/worktrees/pi1149, branch docs/1149-public-onboarding, originalffdbd1d.
Only docs/proposals/2026-09-10-public-install-onboarding.md. Bounded revision, <=190lines, no broad new research or execution.

## Review corrections
[SPEC FIRST] Proposal only; no implementation approval. Correct these technical/evidence issues before acceptance:
1. Registry range presence does NOT prove npm installation succeeds. You didn't run install and logger/ssot/aterm/transitive closure is UNKNOWN. Replace all "succeeds"/automatic-on-PATH/support language with source/metadata-qualified claims. Do not assert exact resolver outcome from versionpresence withoutactualresolution.
2. Tests/workflow files existing is not a measured green CI/install run. "proved by", "CI-proves", "supported macOS/Linux", WSL2tested/onlyready => accurately distinguish source testintent, declaredOS, documentedhint and actual unmeasuredexecution. No CI run was fetched.
3. You say all facts committed-only, but cite devkit/lib/install-fallback.js and setup--resume: earlier task593/1145 records that path as UNTRACKEDWIP. Verify each cited risky source via git ls-tree/show atbb7876b; if absent mark WIP-only or remove implementedclaim. Do not reclassify userWIP as shipped behavior. Your51dirty vs earlier84 may be normaluntracked-directory collapse: report statuscommand/count semantics, not a source cleanup assertion.
4. "aigentry stores no provider credential" is NOT established and conflicts with unresolved1142 credential-state copying. Make it proposed authpolicy (reuse one existing CLI login; no new credential copying), name current unverified/protection gap; never claim absence byomission.
5. Step1 installs meta with brain/aterm dependencies; "steps1-7 work withoutbrain/aterm" is a PROPOSED minimaldependency-contract change, notcurrent. Movingdeliberationprofilefieldalone doesn'tremove npm dependency closure orallrequiredconsumers. Explicitly gate optionalization on actualconsumer/dependencyproof, no one-linefix claim.
6. Node20 onlyneededatstep8 contradicts transport/brain20. State proposedvalidated publicbaseline consistently, qualify current mixeddeclaredranges; actualNode18install/runtimefailureunmeasured.
7. CI must verify the approved compatible RELEASE SET and tested tarball identity, NOT equality to current npm latest. Remove "CI fails if not registrylatest" and "status version same as npx fetches". Newregistrylatest is notcompatibilityproof and shouldnotbreaksupportedpinnedrelease.
8. "Don't run step8" is not a stop switch for already-runningautomation. Require explicit supported pause/stop/drain/abort and budget/approval contract asPROPOSED ifunimplemented. Existing1136/1148 alreadyownapproval/cost/retrywork; "noowner" iswrong. Do not implyinit startsautomation ifitonlyscaffolds.
9. Internal-only does NOT requireunpublishing. Deleteunpublish-as-necessary claim; packagevisibility/supportlevel aredifferent. Useralreadyrequests publicinstallation, recommendadvancedopt-in not reaskpublicvsinternal as ifnointent.
10. LatestUSER requires ALL executable work task-bound and allchangesproduction-ready. Separate task1150 owns enforcementcontract. Add firsttask/bindingbeforeaction, immutableattempt/artifactprovenance, task-boundretry/recovery andproductionacceptance tojourney; no duplicatedesign. ShortINFOcarryingthiscontextfailedbeforeinject, so thisrefisactualhandoff.
11. Do not prescribe "~40lines"/adoptsametestswithoutcheckingconsumerinterfaces orassertstrictsequencingwhereparallel-safe. Give conservativeboundedownership andprerequisites; no cost/timeengineeringestimateasfact.

## Workflow
Singleboundedrevision: verify namedcommitted-vs-WIP sources -> editsoleproposal -> inspectdiff/caps -> commit -> REPORT/HOLD. No installation, liveauth/defaultchanges, newgenericregistryround or changingotherfiles.
Commit(WIPallowed)at everyboundary. Thirdfailedattempt=>STUCK. Everyinventory is startingevidence; remeasurethe relevantproducerbeforeclaim. Preserveoriginaltimestamped6GETattribution; no fabricatedruntimeornewfetch.

## HOLD inject protocol
ACTUALLY execute aftercommit orblocker:
telepty inject --ref --submit --submit-force --from pi1149-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: pi1149 | task: #1149 | phase: proposal correction | needs: bounded review, no implementation approval"
Durable --ref mandatory; ifunavailablekeepREPORT-pi1149.md andreportpath, noblindrestarts/resends.

## REPORT
MANDATORY aftercommit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from pi1149-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: pi1149-PROPOSAL-REVISED | task: #1149 | file: docs/proposals/2026-09-10-public-install-onboarding.md | includeSHA/maincurrentness, correctedsource/WIP/registry/runtimeboundaries, task1150bindingjourney andvalidatedrelease-setpolicy; no install/test/releaseperformed"

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
Samearchitectdesign-only role, noadditionalworkers/subagents/planmode. Read/Edit/apply_patch/git/structuredJSON permitted. No code/config/privateauthmutation, packageexecution, tests/builds, releases, daemon/sessioncleanup. SnykN/A docs-only. Useallrelevanttools/skills/MCPwithinthisboundedtask. No externalrulelookuprequired.

