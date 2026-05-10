---
status: draft
date: 2026-04-19
topic: context-compact-switching
track: E-eco-sync (#294)
related: [#297 ecosystem-contract-doc, #295 cancelled — MCP contract unification]
---

# Context Compact & Switching — Design Spec (L1 Glue-only)

## §1 Goal

CLI(claude/codex/gemini)의 컨텍스트 윈도우가 가득찰 때 **자연스럽고 유기적이고 효율적**으로 compact + context switching 수행. 기존 aigentry 인프라 재활용만. 새 storage/daemon 0.

## §2 Constraints (사용자 명시)

1. **zero polling** — 리소스 점유 금지
2. **zero 주기적 토큰 소모** — 주기 LLM self-report 금지
3. **no reinvention** — 기존 brain/wtm-context/task-queue 재사용
4. **no overengineering** — 새 storage/스키마/데몬 불가
5. **모든 CLI 지원** — claude/codex/gemini (단, Phase 1은 CLI별 차등, §5.6 참조)

## §3 Non-Goals

- 새 context management 프로토콜 제정 (MCP/telepty/bash 기존 유지)
- 외부 퍼블릭 라이브러리 의존 (Rule 17 무의존)
- `.omc/` 정리 (#296 별도 태스크)
- **Phase 1 codex/gemini compact-event parity** (네이티브 compact hook 없음 — §5.6 차등 지원)
- brain entry TTL/retention 정책 (brain 자체 기능. 현재 미지원 시 별도 task, 이 스펙 범위 밖)

## §4 Architecture (3-Layer + Glue)

```
EVENT SOURCES (재사용)
  - Claude PreCompact hook
  - Claude SessionStart:compact hook
  - git post-commit hook (devkit 템플릿)
  - task-queue transition (tq-* 내부 추가 라인)
  - session lifecycle (telepty/cmux close)

GLUE LAYER (신규)
  - ctx-router.sh: classify(event, payload) → destination
  - pre-compact.sh, session-start.sh: CLI hook handlers
  - ctx-install.sh: 일괄 설치/업데이트

STORAGE LAYER (재사용, 0 변경)
  - brain MCP (long-term: summary/decision/learning)
  - wtm-context (ephemeral: journal/handoff)
  - task-queue.json resume_context
```

## §5 Event Handlers

### 5.1 Claude PreCompact
- **Trigger**: `/compact` 실행 또는 auto-compact
- **Classify**: dual (ephemeral + long-term)
- **Action**:
  - `wtm context handoff $SID "auto-compact"` + open files + pending tasks
  - `brain_append scope=session:$SID category=summary content=<session summary>`

### 5.2 Claude SessionStart:compact
- **Trigger**: 세션 재개 시 trigger=compact
- **Classify**: restore
- **Action**:
  - `wtm context resume $SID` → recent journal + handoff
  - `brain_query scope=session:$SID slot=conversation_summary`
  - merge → `hookSpecificOutput.additionalContext`

### 5.3 git post-commit
- **Trigger**: 커밋 완료
- **Classify**: long-term milestone
- **Action**:
  - `brain_append scope=app:$PROJ category=decision content=<commit msg>`
  - `wtm context log $SID milestone "commit $SHA"`

### 5.4 Task-queue transition
- **Trigger mechanism**: `tq-status.sh`/`tq-focus.sh` 스크립트 **내부에 직접 라인 추가** (wrapper/polling 아님). status 변경 분기 끝에 `ctx-router.sh on-tq-transition ...` 호출. 폴링/파일 watch 금지.
- **Classify**: ephemeral + selective promote
- **Action**:
  - `wtm context log $SID milestone "task $ID: $OLD → $NEW"`
  - status=done 시 `brain_append category=summary`

### 5.5 Session lifecycle end/kill
- **Trigger mechanism**:
  - **telepty**: session termination 시 emit 되는 기존 close signal 활용. 미지원 시 `trap ... EXIT` in `open-session.sh`의 shell wrapper (no new subsystem). (telepty/cmux 수정 **없음**.)
  - **cmux**: workspace kill 전 cleanup hook 포인트가 없으면 shell EXIT trap으로 fallback.
  - 구현 불가 CLI는 session end 이벤트 미지원 — §5.6 coverage 표에 표기.
- **Classify**: ephemeral final + learning promote
- **Action**:
  - `wtm context handoff $SID "session-end-auto"`
  - Journal `LEARNING:` 마커 → `brain_append category=learning`

### 5.6 CLI Coverage Matrix (Phase 1 & 차등 지원)

| 이벤트 | claude | codex | gemini |
|-------|:------:|:-----:|:------:|
| 5.1 PreCompact (auto-snapshot) | ✅ native hook | ❌ 미지원 (compact 네이티브 없음) | ❌ 미지원 |
| 5.2 SessionStart:compact (auto-restore) | ✅ native hook | ❌ 미지원 | ❌ 미지원 |
| 5.3 git post-commit | ✅ | ✅ | ✅ (CLI 무관) |
| 5.4 task-queue transition | ✅ | ✅ | ✅ (CLI 무관) |
| 5.5 session lifecycle (EXIT trap or telepty close) | ✅ | ✅ | ✅ (CLI 무관) |
| 수동 `ctx save/restore` 커맨드 | ✅ | ✅ | ✅ |

**Phase 1 정의**: claude는 풀 지원. codex/gemini는 git + task + lifecycle + 수동 (compact-event 자동화는 해당 CLI가 PreCompact 유사 hook 제공 시 Phase 2에 추가).
**호환 보장**: CLI 무관 이벤트(5.3/5.4/5.5/수동)는 어느 CLI에서도 동일 동작. 이로써 cross-CLI 기본 가치 확보.

## §6 Data Flow

### Capture
```
Event → hook script → ctx-router.classify()
  → wtm context {handoff|log|ref}
  → brain_append(category, scope, content)
```

### Restore
```
SessionStart:compact → session-start.sh → ctx-router.restore($SID)
  → wtm context resume + brain_query slot=conversation_summary
  → merge → hookSpecificOutput.additionalContext
```

### Switch
```
Source end: handoff + brain promote learnings
Target start: Restore Flow 자동 실행
```

### Cross-session learning promote
```
journal `LEARNING:` → session end → brain scope=app:{project} category=learning
```

## §7 File Layout

```
~/.claude/hooks/
  pre-compact.sh            (~30줄, Event 5.1)
  session-start.sh          (~30줄, Event 5.2)

aigentry-devkit/
  bin/
    ctx-router.sh           (~80줄, 공통 classify + routing)
    ctx-install.sh          (~40줄, 일괄 설치 스크립트)
  templates/git-hooks/
    post-commit             (~20줄, Event 5.3 템플릿)
```

**총 ~200줄**. 새 storage/schema/daemon 0.

## §8 Error Handling

| 시나리오 | 대응 |
|---------|------|
| brain MCP 미설치/응답 없음 | wtm-only degraded. warning log. |
| wtm 실패 | brain-only fallback. 복원 시 summary만. |
| 세션 crash (hook 미실행) | 다음 세션 SessionStart에서 cwd 기준 최신 wtm journal 엔트리를 읽어 inferred state 생성. (신규 `wtm context orphan-check` 서브커맨드 도입 — wtm 기존 journal_tail + handoff read만 조합하는 thin wrapper, 새 storage 0. 필요 시 이 서브커맨드 PR이 이 spec의 일부로 포함) |
| hookSpecificOutput 용량 초과 | truncate + `wtm context resume $SID` 링크 첨부 |
| PreCompact 동시 발화 | wtm-context의 기존 file lock 활용 |
| Session ID 소실 | **fail loud 원칙**. fallback ID 생성 금지 (brain scope 파편화 방지). 대신 오류 메시지: "session id 소실됨 → `wtm context resume <known-id>` 또는 `ctx rebind <cwd>` 수동 실행" 안내. 사용자 명시 rebind 시 기존 brain scope 유지. |
| git hook 실행 실패 | 알림만. compact/switching 영향 없음 |

## §9 Testing Plan

모든 테스트 `aigentry-tester-*` 세션 위임.

| 유형 | 범위 | 검증 |
|------|------|------|
| Unit | ctx-router.classify() | bash + fixture payload |
| Integration | PreCompact 실제 발화 | sandbox `/compact` → wtm journal + brain entry 검증 |
| Integration | SessionStart:compact 복원 | 새 세션 → additionalContext 확인 |
| Integration | git post-commit | commit 후 `brain_query scope=app:X` |
| E2E | crash 복구 | kill -9 → orphan-check → inferred restore |
| Regression | brain-off degradation | MCP disable → wtm-only 동작 |
| Load | 장시간 journal rotate | 1000+ entries → rotate --keep 500 |

## §10 Risks

| 리스크 | 완화 |
|-------|------|
| brain entry 과다 축적 (session summary 많이 쌓임) | 본 스펙 범위 밖. brain 자체의 retention 정책(별도 task). 현 스펙은 `scope=session:$SID` 일관성만 담보. |
| hookSpecificOutput 형식 변경 (Claude Code 업데이트) | Claude Code 공식 스펙 참조 + 변경 모니터링 |
| codex/gemini compact-event 미지원 → 반쪽 기능 | §5.6 coverage 표로 명시적 차등. CLI 무관 이벤트(5.3/5.4/5.5/수동)로 기본 가치 확보. 가능한 hook 발견 시 Phase 2 확장 |
| wtm-context rotate 중 race | 기존 file lock 재사용 (§Inv.3 무의존 준수) |
| `wtm context orphan-check` 신규 서브커맨드 필요 | 기존 `journal_tail + handoff read` thin wrapper로 구현. 새 storage/스키마 0. 이 spec 범위 내 PR 포함 |

## §11 Migration

- Phase 1: `~/.claude/hooks/pre-compact.sh` + `session-start.sh` 설치 (claude 한정, 1일)
- Phase 2: ctx-router.sh + ctx-install.sh (1-2일)
- Phase 3: git post-commit 템플릿 배포 + task-queue/session-lifecycle hook (1-2일)
- Phase 4: 테스트 + 문서화 (1일)

총 4-6일 (혼자 작업 기준). 각 phase는 coder 세션 위임.

## §12 Success Metrics

**측정 방법**: 모든 metric은 **이벤트 시점 1회 측정** (폴링/주기 아님). ctx-router.sh 실행 끝에 `wtm context log $SID ctx-event {result, duration_ms}` 1라인 append. 이후 `wtm context journal` 읽어 집계 (수동/분석 세션 위임).

| Metric | 목표 | 측정 |
|-------|------|------|
| PreCompact 발화 후 복원 성공률 | > 95% | restore 이벤트 결과 (OK/FAIL) 집계 |
| 세션 crash 후 inferred restore 성공률 | > 80% | orphan-check 결과 집계 |
| ctx-router 호출당 평균 지연 | < 500ms | log에 duration_ms 기록 |
| 신규 리소스 (CPU/RAM) 점유 | 0 | 정성 검증 (아키텍처상 데몬/폴링 없음) |
| 신규 주기 토큰 소모 | 0 | 정성 검증 (이벤트 시점 1회만 LLM 호출 없음) |

**Aspirational metrics** (정확한 수치는 실측 후 조정): 복원율, inferred restore 성공률 목표는 Phase 4 테스트 종료 시 재보정.

## §13 Out-of-Scope (차후 별도 태스크)

- brain entry 검색 UX (brain 자체 책임)
- 세션 간 명시적 context transfer UI (aterm 명령어로 구현 가능)
- compact 내용 자체의 LLM 요약 품질 (Claude Code 네이티브 `/compact` 동작)

## §14 Dependencies

- brain MCP 서버 설치됨 (현재 claude에 등록됨)
- wtm-context CLI 설치됨 (devkit install)
- Claude Code hook 시스템 (내장)
- git (표준)
