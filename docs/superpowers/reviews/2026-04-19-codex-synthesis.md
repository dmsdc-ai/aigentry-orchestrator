---
date: 2026-04-19
reviewers: codex × 4 parallel (platform / runner / glue / docs)
aggregated_by: aigentry-orchestrator
verdicts: [fixes, fixes, REVISION, fixes]
---

# 2026-04-19 Codex Deep-Review Synthesis

## TL;DR

오늘 shipped 18 commits (devkit) + 5 (orchestrator), 70/70 bats green — 그러나 **4 parallel codex reviewer가 실측 재현 기반으로 🔴 6 critical + 🟡 12 high + 🟡 4 medium 발견**. 테스트 통과 ≠ 실 동작 보장. 특히 **Plan A의 핵심 promise (PreCompact → SessionStart restore)가 schema 불일치로 production에서 broken** 상태.

## 1. Verdicts

| 스코프 | 🔴 | 🟡 high | 🟡 med | Verdict |
|------|:-:|:-:|:-:|:---:|
| Platform abstraction + session-cleanup | 2 | 4 | — | fixes |
| Runner (multi-exec) + open-session | 1 | 4 | 1 | **REVISION** |
| Glue (ctx-router + hooks + wtm) | 3 | — | 2 | fixes |
| Specs/Plans/Docs alignment | — | 2 | 4 | fixes |
| **총계** | **6** | **10** | **7** | 2 fixes + 1 revision + 1 fixes |

## 2. 🔴 Critical Issues (즉시 수정 권장)

### C-1: `platform::kill_pid 0` → 프로세스 그룹 SIGTERM (platform review)
- `bin/lib/platform-unix.sh:6/19/26` — empty check만 있고 0/negative/non-numeric 검증 없음
- Local repro: `platform::is_alive 0` returned success → `kill_pid 0` sends SIGTERM to current process group
- **Fix**: strict "positive decimal PID only" gate before any signal call

### C-2: `session-cleanup.sh` 404 failure + JSON fallback errexit crash (platform review)
- `bin/session-cleanup.sh:47/57/82` — 404를 "already gone success" 아닌 exit 9 처리. `set -euo pipefail` 하에 malformed JSON이 전체 script kill (exit 5)
- Spec §4.3/§8 idempotency 위반
- **Fix**: 404 → success 처리 + JSON fallback `|| true` fence

### C-3: `save_handoff` vs `restore_handoff` schema 불일치 (glue review)
- `tools/wtm/lib/context.sh:198-237` writes top-level `data[sid]`
- `tools/wtm/lib/context.sh:265-268` reads nested `data.sessions[sid]` preferentially
- Live repro: `on-precompact demo:coder` → top-level write → `restore demo:coder` → "Session not found"
- **Plan A 핵심 promise 완전 broken**. `tests/ctx-e2e.bats:87-89`가 string 존재만 확인해서 false green.
- **Fix**: save_handoff을 nested schema로 migrate + E2E 테스트 강화

### C-4: Claude hook 템플릿 malformed stdin → exit 5 (glue review)
- `templates/claude-hooks/pre-compact.sh:4-14` + `session-start.sh:4-21` — `set -euo pipefail` + raw `jq` parse
- Repro: `printf 'not-json' | bash pre-compact.sh` → exit 5
- **Fix**: `|| true` fence + fallback echo '{}' 명시

### C-5: `ctx-router` uses `brain` but devkit installs `aigentry-brain` (glue review)
- `bin/ctx-router.sh:76-88/173-177` — `command -v brain` check만
- 정상 install path 제공하는 `aigentry-brain`은 무시 → 모든 long-term persist 경로 silent degradation
- **Fix**: prefer `aigentry-brain`, fallback `brain`

### C-6: `open-session.sh eval cwd="$cwd"` 는 shell execution (runner review)
- `bin/open-session.sh:92` — `eval` 이 path 확장 아닌 command execution
- Repro: `--cwd '/tmp/a b'` → `b: command not found`
- cmux/aterm wrapper들에서 raw `$cwd` 삽입 (:155/164 + `platform-unix.sh:160` AppleScript) → injection surface
- **Fix**: `eval`을 proper path expansion (`${cwd/#\~/$HOME}`)으로 교체 + printf %q로 escape

## 3. 🟡 High Priority (같은 sprint 내 수정 권장)

| # | 이슈 | 파일 | 영향 |
|:-:|------|-----|------|
| H-1 | mkdir file_lock stale pid 파일 부재 시 영구 실패 | `platform-unix.sh:55-66` | 락 시스템 deadlock |
| H-2 | bg fswatch 크래시가 성공으로 보고 | `platform-unix.sh:104-117` | event_wait false success |
| H-3 | session-cleanup raw `$sid` URL+regex injection | `session-cleanup.sh:47/71` | wrong-target 위험 |
| H-4 | Rule 26 guard coverage 불완전 | `check-platform-usage.sh:13/21` | install.sh/hooks 미검사 |
| H-5 | `await_task_report` lossy + sid-blind | `multi-exec-lib.sh:265-304` | false timeout + cross-session 오염 |
| H-6 | `parse_frontmatter` YAML subset 파싱 실패 | `multi-exec-lib.sh:23-80` | multiple gates/colon/blank line 모두 broken |
| H-7 | `user_approval` gate grep 전파일 scan | `multi-exec-lib.sh:323-366` | 임의 ref로 gate 우회 |
| H-8 | `open-session.sh` EXIT trap 정상 spawn 시에도 발화 | `open-session.sh:202-217` | 살아있는 세션에 session-end |
| H-9 | `#294` tq transition producer 미연결 | `tq-status.sh`/`tq-focus.sh` | spec §5.4 dead handler 확정 |
| H-10 | `#294` crash recovery 자동 X manual만 | `ctx-router.sh:103-120/169-186` | Plan A 자동복구 promise 미이행 |

## 4. 🟡 Medium (다음 sprint)

1. 16KB truncation이 char-count (multibyte overflow) — `ctx-router.sh:110-117`
2. on-precompact payload 불완전 (open-files/pending-tasks 미캡처) — `ctx-router.sh:95-100`
3. cleanup_on_success가 무관 과거 stuck event에 triggered — `multi-exec.sh:96-109`
4. ecosystem-contract.md가 `tq-focus.sh read-only` 거짓 주장 — lines 85-93
5. multi-exec.md가 cleanup_on_success/preserve_on_error 미문서화 — lines 20-35
6. #297 maintainer-review 반영 commit 누락 + `⚠️ 확인 필요` 1건 잔존
7. #304 platform doc이 Phase 1.5 spawn_* API 미반영

## 5. Architectural 함의

### 5.1 telepty shared-ref 근본 한계 (runner review)
- Shared refs에 **sender metadata 없음** → REPORT 수신 인증 불가 + user_approval gate 권위성 없음
- 다음 단계: **aigentry-telepty upstream PR** — sender field 추가
- 현 임시책: REPORT 파일 내에 `--from` 정보 포함 강제 (spec 갱신)

### 5.2 테스트 품질 — false green pattern
Multiple critical bugs에서 green 테스트지만 real broken:
- ctx-e2e.bats는 handoff string 존재만 확인 → schema mismatch 감지 못 함
- platform.bats는 kill_pid 0 edge case 테스트 없음
- multi-exec.bats는 shared-ref race 테스트 없음

→ **테스트 전략 자체 재검토 필요**: "실 사용 시나리오 verbatim" 테스트 추가

### 5.3 Plan drift 체계화
3 reviews (runner/glue/docs) 가 공통 지적: **Plan Task 매핑이 최종 implementation과 drift**. 
- Task 7.3 tq-*.sh: 스킵이 실은 잘못된 판단 (tq-focus.sh IS mutating)
- Task 8 자동 crash recovery: 수동 recovery tool로 대체됨
- #297 maintainer review closeout: 미이행

→ **#298 Phase 2+에 spec drift 자동 감지** 기능 (spec-code alignment matrix auto-generator) 필요

## 6. 제안 follow-up 태스크 (신규 등록)

| # | P | 요약 |
|:-:|:-:|------|
| 313 | P0 | 🔴 C-1/C-6 safety fixes: kill_pid PID validation + open-session.sh eval 제거 |
| 314 | P0 | 🔴 C-3 schema migration: save_handoff/init_context → nested + E2E 실증 테스트 |
| 315 | P0 | 🔴 C-4 hook fail-soft: pre-compact.sh/session-start.sh malformed stdin handling |
| 316 | P0 | 🔴 C-5 brain binary name: aigentry-brain 우선 + fallback brain |
| 317 | P0 | 🔴 C-2 session-cleanup 404/500/JSON fallback idempotency |
| 318 | P1 | 🟡 H-8 open-session EXIT trap: 성공/실패 분기 |
| 319 | P1 | 🟡 H-9 tq-focus.sh에 ctx-router transition call 추가 |
| 320 | P1 | 🟡 H-6 parse_frontmatter 완전 YAML subset 재작성 |
| 321 | P1 | 🟡 H-5/H-7 telepty shared-ref provenance (sender metadata) — upstream PR #322 |
| 322 | P2 | aigentry-telepty: shared-ref에 `--from` 메타데이터 저장 + read API |
| 323 | P2 | 🟡 H-1~H-3 platform/cleanup edge case 강화 + test |
| 324 | P2 | docs 정합성 (5개 medium 항목 통합 PR) |

## 7. 최종 권고

### 긴급 (내일 착수 권장)
- **#313~#317 P0 묶음** (6 critical 전부) — 오늘 shipped 코드가 production에서 실제 기능 못 함. 특히 C-3 (Plan A 핵심 promise)는 이번 주 안에 수정 필요.

### 중요
- **#318~#321 P1** — runner revision + 실제 동작 회복

### 구조적
- **#322 telepty shared-ref metadata** — provenance 부재가 미래 운영 위험 증가

### 긍정적 평가
- 전체 아키텍처 방향은 정당
- Platform 추상화 + #312 HTTP DELETE fix는 sound
- open-session.sh 7 terminal branch + ecosystem-contract 283줄 docs는 quality high
- Windows stub messaging + PLATFORM_OVERRIDE test seam은 모범적

### 핵심 교훈
> **테스트 green = 기능 동작 아님. 실 사용 시나리오 verbatim 테스트 + dogfood가 유일한 검증.**

오늘 codex 병렬 리뷰가 이를 증명. **이 리뷰 패턴 자체가 #298 Phase 2에 자동화 candidate** (각 구현 직후 병렬 critical review).
