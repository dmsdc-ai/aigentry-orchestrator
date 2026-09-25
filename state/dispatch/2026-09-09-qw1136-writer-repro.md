---
dispatch_kind: fresh-session
task: 1136
---
# Dispatch - qw1136-tester - Queue writer core reproduction and tests

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC for this delegation. Orchestrator state/docs/bin paths are metadata unless explicitly listed as read-only source or your exclusive output. Your role-sandbox cwd is not the target worktree; use the explicit path below.

## Role
You are qw1136-tester, tester. Worktree /Users/duckyoungkim/.aigentry/worktrees/qw1136, branch test/1136-queue-writer-core.
Only repository output: tests/dispatch/workflow-task-writer.test.ts (reserved descriptive path, no T-number). Read current production code but do NOT modify it, manifest, other tests, helpers, dist, dependencies, global config or live queue. No new worker/subagent, no CLI/daemon/session spawn or restart except bounded subprocesses in isolated test fixtures. Builder owns TypeScript build, no tsc/npm build/npm test here.

## Background
User approved production autonomous loop and its six safety improvements. Task1136 holds that work. Source-only revised spec c95b7cc is retained in main as4ff94cd; docs/specs/2026-09-08-workflow-production.md is available READ-ONLY CONTEXT, not fully accepted. First bounded P1-base scope is only its independent queue transaction core (sections1/6). Full grants/claim/action/receipt/reap/loop activation remain unapproved pending corrected safety contracts; do NOT test an invented completion of those features.
Current source read: bin/tq-focus.sh uses TQ override, jq reads queue then mktemp/mv writes whole snapshot with no lock. src/dispatch/cli.ts taskLedgerUpdate also read-modify-renames without a shared lock. These are STARTING source observations, not runtime reproduction. Remeasure exact source and main/branch SHA before relying on them.
A missing bin/tq-write.py alone is not a reproduction of lost updates. Need deterministic source-derived current-writer interleaving with exact observed lost field, then retain red acceptance for the transaction helper. Main queue and user worktrees must remain untouched.

## Goal and isolated execution boundary
Produce one registered-by-discovery Node test file (.test.ts compiled by normal builder later), plus a durable REPORT naming authoring vs actually executed diagnostic. Author fixtures entirely in fresh temporary directory with synthetic minimal queue; TQ, HOME, TMPDIR and any AIGENTRY path must point there. No live task-queue read needed for test data, no actual telepty/cmux/network/model/credential call.
First reproduce current bin/tq-focus.sh read-before-replace loss using its real source and TQ override, deterministic barrier around read/replace and a synthetic unrelated queue mutation. Record pinned source hash, exact interleaving, expected and actual preserved/missing segment. A setup failure, missing binary, or missing new helper is NOT the lost-update reproduction. If no safe deterministic source-faithful fixture exists, HOLD with exact gap rather than simulate a different algorithm and call it production evidence.
You MAY execute a bounded standalone diagnostic against the unmodified focus script inside that fixture before a builder exists; tester execution is authorized, production build is not. Do not execute the TS suite by inventing a transpilation path or new dependency. After test-file authoring, report suite NOT RUN until builder compiles it. Baseline reproduction and future suite are distinct evidence.
Keep synthetic fixture-only writes/test subprocesses, timeouts and cleanup bounded; no broad environment inheritance. All barrier processes must be joined or terminated before report. No sleep-only probabilistic race as the only evidence.

## P1-base target test contract
The future helper is bin/tq-write.py, Python3 stdlib, one same-dir temp/fsync/replace transaction under bounded sidecar flock, with the queue selected by TQ (existing focus contract). Helpers and real caller wiring are NOT present yet.
Frozen test scope: note-append --task ID --segment TEXT --op-id ID; status --task ID --status VALUE --if-current VALUE; focus TRACK. Unknown task3, malformed queue4, stale status5, same op-id different canonical command/payload6, usage2; success0. Note appends exactly ' || '+segment preserving old text. Identical same-id command/payload is no-op with no file rewrite/mtime change; op-id lookalike inside note prose is not dedup evidence. Canonical digest covers parsed operation/payload, not incidental argv order. These explicit flag spellings are the bounded first-slice handoff, not a claim the broader architect prose already implements them.
Test parallel note appends on same/different rows, focus+note, compare-and-set status races, lock timeout/no partial state, malformed/unknown/refused inputs byte-unchanged, immutable prior fields/non-ASCII and one trailing newline, string and numeric task IDs preserved without conflating distinct IDs, old note_op_ids absent allowed and malformed structure refused without rewriting. Preserve unrelated top-level/task fields and no-op bytes. Avoid flaky mtime-resolution assumptions; prove no rewrite with stable bytes/inode/mtime where portable and disclose limits.
No claim/receipt/grant/release/dispatch-stamp/owner lifecycle implementation in this slice. Core tests must not pretend it fixes W1/W2 live races until their callers are wired through the helper. No skip-for-missing-helper that goes green: desired-helper tests must be RED before implementation, and failure classification names missing helper separately from baseline race.

## Workflow
[SPEC FIRST] The independent core direction above is approved for test authoring/reproduction, NOT production code. One phase: inspect source, isolate and measure exact baseline if possible, author only the test file, syntax/static inspection only, commit, send REPORT/HOLD. Commit WIP at every phase boundary so interrupted work survives.
Next phase is builder compilation, then your compiled tests; don't run build or self-promote. Future coder starts only after baseline reproduction + exact test contract review. Test discovery: scripts/run-tests.mjs recurses dist/tests for .test.js; confirm this source file will compile there, do not edit the runner or claim it already ran.
Snyk supported first-party test code: run snyk_code_scan or bin/snyk-scan.sh with ONLY owned test path, fix/rescan findings before authored-code DONE; report raw evidence and any unavailable scan, not invented zero. No production code is authorized.

## HOLD inject protocol
At real blocker or phase boundary, commit available output and ACTUALLY execute:
telepty inject --ref --submit --submit-force --from qw1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qw1136 | task: #1136 | phase: reproduction/test-author | needs: exact blocker or builder compilation"
Silent waiting forbidden. --ref notification is durable. If command fails retain REPORT-qw1136.md in your worktree and retry once at next boundary. After three failed attempts send STUCK with command/error.

## REPORT
MANDATORY after commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from qw1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qw1136-TEST-AUTHORED | task: #1136 | file: tests/dispatch/workflow-task-writer.test.ts | include SHA, measured source/main currentness, exact baseline command/interleaving/result, tests authored vs actually executed, Snyk evidence, no live side effects | needs: review and builder compile; parent incomplete"
For any executed test suite also report structured totals total=passed+failed+skipped and measured scope. Standalone diagnostic is not a full suite or a green release. Retain failure evidence; do not self-cleanup.

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

## Inline excerpts and full capability
Envelope/table above are verbatim. Role application: tester may author and execute tests in isolated fixtures; coder alone edits production; builder compiles/runs/releases; architect designs. Use all relevant skills/tools/MCP fully within that scope. Read/Grep/Glob/Git and exclusive test edit/commit plus synthetic fixture execution authorized; unavailable plugins not blockers.
Do not touch main or unrelated worktrees, original user WIP, credentials, external services, real queue/dispatch ledger, terminal/bridge processes or global install. Do not widen scope to solve shared loop architecture. Evidence claims must distinguish source inspection, actual diagnostic execution and future compiled suite; old enumerations are starting sets, not verified counts.
