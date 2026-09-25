---
dispatch_kind: fresh-session
task: 1136
---
# Dispatch - qc1136b-coder - Apply the exact tested queue-boundary correction

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. Context was cleared before dispatch. State/docs/bin paths are orchestrator metadata unless designated owned output or read-only evidence below. Your role-sandbox is not the worktree; no prior chat is needed.

## Role
You are qc1136b-coder, coder. Worktree /Users/duckyoungkim/.aigentry/worktrees/qc1136, branch work/1136-queue-writer-core, expected HEAD d361397a6b3a75e7aa98c2612726ecbef9911cf2, clean.
Only owned tracked output: bin/tq-write.py. Python standard library only. No tests, manifests, caller wiring, docs, configuration or dependency changes. No other sessions/subagents.
Mode: Universal D external_dispatch outside Claude-only chain scope; existing explicitly selected Claude worker retained after operational /clear, not a routing-policy change.

## Background and approval boundary
[SPEC FIRST] This is authorization for the SAME approved queue contract's narrowly reproduced failures only. Do not implement a new policy. Permanent-fix Track A is selected because tester measured both original failures AND the exact fixture-only remedy.
Original helper SHA2567e6e6dd1ebe210d1a772e382234be4d31d4939e62db5512b3a70a4304a4de417. Actual unchanged compiled JS d3ed307c55796d45fb28052ae40df152b6f78188214be46b0dd3b22d60e0029f on Node20.20.0: original56/51/5, candidate56/56, two separately measured numeric controls2/2. These are tester executions, not your execution.
Original five witnesses: present-null note incorrectly writes; integer literal1e21 requested as JS1e+21 misses; 9007199254740993 requested as JS9007199254740992 misses; unrelated overflow1e400 publishes invalid JSON; lone surrogate raises UnicodeEncodeError and leaks own temp.
Test-only candidate SHA25612bce41dc9a5901c08e134235d3ce1008d1aa1a7ed8a34ab82ad8332abfccdca corrects those cases. All existing concurrency, lock, mode, foreign-temp and pre/post-commit fault controls passed. No universal numeric or live integration proof.
Final report original commit b4ad7814fdad85a6b371e4d0ae379fccd4c06f70 preserved main c59b916. Read-only evidence root /Users/duckyoungkim/.aigentry/worktrees/qt1136b/dist/queue-boundary-counterpart contains candidate.diff, candidate/bin/tq-write.py and evidence/. Tester process has finished; artifacts remain.
These counts and file inventories are a starting set derived from raw TAP/JSON/hash review, not authority: recheck the exact source/diff/hashes before editing. If missing or divergent, HOLD; do not reconstruct a different remedy.

## Goal
Apply only the four exact tested transformations below with apply_patch to your owned source, then verify resulting SHA256 equals12bce41dc9a5901c08e134235d3ce1008d1aa1a7ed8a34ab82ad8332abfccdca.
Preserve unrelated code and all existing fixes. Do not copy over the entire file blindly or add refactors.
Commit exact source correction, perform isolated authenticated Snyk scan, report actual security result and retained artifacts. Tests/compilation are NOT authorized in this coder phase. A separate tester will execute committed-source acceptance after review.

## Exact transformations
1. Insert _finite_float(text) immediately before load: value=float(text); if not math.isfinite(value), raise ValueError("non-finite JSON number %s" % text); return value. Pass parse_float=_finite_float alongside existing parse_constant=_reject_constant to json.loads.
2. Pass allow_nan=False in existing indent2/ensure_ascii=False json.dump. Before existing OSError catch in commit staging, catch (UnicodeError, ValueError), call _unlink(tmp), then raise Refusal(4, "MALFORMED_QUEUE", "unrepresentable queue: %s" % exc). Leave OS7 and post-replace8 branches unchanged.
3. In canonical_id int branch replace str(value) and stale exactness comment with try value=float(value) (match JS text without changing stored row); except OverflowError raise Refusal(4, "MALFORMED_QUEUE", "tasks[%d].id exceeds binary64 range" % index). Fall through existing finite-float canonicalization, preserving bool exclusion, ambiguity detection and stored values.
4. Replace prior=row.get("note") and None special-case with prior=row.get("note", "") and if not isinstance(prior,str): existing malformed refusal. Replace false161-null comment with "Only an absent note defaults to empty; present values must be strings."
Use retained candidate.diff SHA25652b5ecb03f3531512e6cc294742cc92e37026f643e7f28b88803f2b276390cf1 for exact whitespace/placement; final source hash above is the identity check. This is a read-only artifact, not missing policy context.

## Invariants and lessons
Only verbs note-append --task ID --segment TEXT --op-id ID; status --task ID --status VALUE --if-current VALUE; focus TRACK.
Resolve TQ/default repo queue once; stable sibling .lock created0600, fcntl exclusive before read through validation/replace; fixed monotonic10s timeout, no knobs. Preserve unrelated fields, ID types/values, queue mode. Same-dir unique temp; fsync, replace, dir fsync; clean only own temp.
Exit0 success/exact no-write replay;2 usage/ambiguous;3 unknown;4 malformed;5 stale CAS;6 op-id payload conflict;7 precommit I/O/lock timeout;8 post-replace COMMIT_DURABILITY_UNKNOWN. Never call8 an unchanged refusal or rollback. Existing parsed payload digest/per-row op-id ledger and focus/status scope unchanged.
Missing note defaults empty; present null/list/number malformed. Never use historical "161 null" claim: direct remeasurement found161 missing keys,0 presentnull. Registry path waiver explicitly excludes operator-supplied filename and is NOT precedent here.
Original TS-only Snyk0 and helper Python2LOW concern different files, not a same-file discrepancy. Candidate helper scan2LOW remains unmet; test56green cannot imply security approval. Counts are measured fixture results, not exhaustive semantic proof.

## Workflow
One bounded code phase: verify base/source/evidence -> exact edit -> diff/hash review -> isolated scan -> commit -> real REPORT and HOLD. No intermediate design round is requested; HOLD immediately if contract/diff deviates.
MANDATORY: commit (WIP allowed) at every phase boundary; a sleep/API cut then loses at most one phase. No uncommitted work at HOLD.
No npm/tsc/py_compile/test/helper/application/live-queue commands. Builder/tester own execution. Security scan below is explicitly authorized. Read/git/hash operations allowed. No self-cleanup.
Third failed attempt => STUCK with exact error, no silent loop. Do not independently solve the root-policy question or waive scanner findings.

## Snyk
Applicable: run snyk_code_scan MCP or normal already-authenticated Snyk CLI (existing bin/snyk-scan.sh wrapper allowed) on a verified isolated directory containing only an exact copy of your owned Python file. Never scan whole HOME/repo or read/print/copy auth secrets; no auth/config/ignore mutation.
Candidate measured SnykCode1.1304.3 exit1 two python/PT LOW at open151/replace192; separate harness scan0 does not clear Python. Fresh corrected-source scan still required; report tool version, exact command/scope/hash, exit, count/locations, retained output.
Findings must reach0 before any code DONE/security gate. Fix-rescan only inside authorized/reproduced scope. If the known TQ findings remain, stop with CODE evidence + HOLD, not DONE; no repeated identical scan or unapproved root restriction. User has NOT approved containing TQ to realpath(AIGENTRY_ROOT)/repo root; external paths remain unchanged.
No runtime/publication/live activation claim even if scanner changes result.

## HOLD inject protocol
ACTUALLY execute at every blocker or completed phase after commit:
telepty inject --ref --submit --submit-force --from qc1136b-coder {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qc1136 | task: #1136 | phase: exact boundary correction | needs: code review and committed-source tester, plus any unresolved security gate"
A markdown HOLD is not a notification. Every HOLD/REPORT must be durable via --ref. If delivery errors, preserve same content in REPORT-qc1136.md and retry once at next phase boundary.

## REPORT
MANDATORY after commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from qc1136b-coder {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qc1136-CORRECTION-CODE | task: #1136 | file: bin/tq-write.py | include exact commit/base/main currentness, source/diff hashes and candidate identity, scan scope/result/artifacts; tests/build NOT RUN by coder; no root policy/callers/manifest changes; security and parent incomplete"
Do not use DONE if Snyk findings remain. Your report is evidence, not release permission.

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
The SAWP envelope and role separation table above are verbatim. Role-specific boundary here authorizes source edits and security scanning only; builder/tester execute compile/runtime. All load-bearing contract and phase decisions are inline.

## Boundary and full capability
No changes outside owned Python; no production runs, remote push, merge to main, release, npm install, policy/default change, auth/config, test assertion weakening, extra worker spawning or destructive operations. HOLD before any needed departure.
Use all relevant skills, tools, MCP servers and workflows at full capability for this bounded task. Read/Edit/apply_patch/Bash/git/hash and Snyk MCP/CLI permitted; no requirement to find an unavailable plugin. No plan mode in this worker.

