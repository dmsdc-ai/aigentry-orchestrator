---
status: draft (data-gathered, not yet reviewed)
date: 2026-04-19
topic: multi-exec-automation
track: E-eco-sync (#298)
data_source: ~/.wtm/contexts/aigentry-orchestrator/exec-events/2026-04-19.jsonl (40 events) + ~/.telepty/shared/*.md (131 refs) + today's execution logs
---

# Multi-Exec Automation — Design Spec (#298 — data-gathered draft)

## §1 Goal

오케스트레이터가 plan 파일을 입력하면 coder/tester 세션 자동 dispatch + subagent reviewer 자동 호출 + fix loop + chunk gate 처리까지 수행하는 자동화 runner 구현.

## §2 Evidence Base (2026-04-19 실측)

오늘 Plan A (#294) + Plan B (#297) + #299 + #296 + #300/#301 수동 실행 데이터:

| Metric | 값 | 시사 |
|--------|---|-----|
| Plan A 전체 wall time | ~30분 | 12 tasks + chunk gate + review |
| Plan A 평균 task cycle | 2.5 min | median 1.5min, max 5.7min |
| Plan B 전체 wall time | ~5분 | docs-only 더 빠름 |
| 자율 adaptation 비율 | 2/18 tasks (11%) | 수동 가이드 없이 INVARIANT만으로 처리 가능 |
| Plan drift 발견 비율 | 2/18 tasks (11%) | 스펙 소스 검증 부족 |
| 첫 inject 소비 버그 | 1 세션 (trust dialog) | pre-setup 필요 |
| Review 호출 | 1회 (Task 1) | hybrid 패턴 부분 적용 |
| Manual instrumentation overhead | 오케스트레이터 side 매 단계 bash 1-2줄 | 자동화 가치 높음 |

## §3 Constraints

1. **폴링/데몬 금지** (Rule 17 + 사용자 명시)
2. **기존 인프라 재활용** (telepty, wtm-context, ctx-router, brain)
3. **Rule 4 준수**: coder 세션이 구현, subagent는 검증만
4. **범용 크로스-CLI for the infra layer** (Rule 2/14). **러너 자체는 bash 4+/jq 필요** — macOS 기본 3.2는 `brew install bash` prerequisite. 범용성은 telepty/wtm/ctx-router 레벨이 책임, 러너는 오케스트레이터 머신 한정.
5. **실패 시 fail-loud** (Rule 22 증거 기반)

## §4 Architecture (3-layer)

```
LAYER 1: multi-exec 러너 (신규, ~300 LOC bash + jq)
  - devkit/bin/multi-exec.sh <plan-file>
  - plan 파싱 → Task 리스트 추출
  - 각 Task: inject → await REPORT → review subagent → fix loop → next

LAYER 2: 이벤트 버스 (재사용)
  - telepty inject --ref (이미 사용 중)
  - wtm context log exec-event (이미 로깅 규약 정립됨)

LAYER 3: 세션 (재사용)
  - coder 세션: open-session.sh로 오픈 (#299 완료)
  - subagent reviewer: Agent tool (general-purpose)
```

## §5 Task 파싱 — Plan 파일 스키마 확장

기존 plan 구조 (checkbox 기반)에 선택적 frontmatter:

```yaml
---
multi_exec:
  enabled: true
  coder_session: E22-coder-294  # 또는 auto_spawn: true
  reviewer: subagent  # 또는 role session id (Phase 2+)
  max_fix_iterations: 5
  chunk_gates:
    - after_chunk: 1
      type: user_approval  # 또는 auto_approved
---
```

**Backward compatibility** (HARD RULE):
- Frontmatter의 `multi_exec:` 블록이 **없거나 `enabled: false`** 이면 러너는 **no-op** (plan 파일 그대로 두고 exit 0). 기존 plan은 영향 없음.
- `multi-exec.sh --strict` 옵션 시에만 `multi_exec:` 부재 플랜을 reject.

Task 1/2/... 본문은 기존 그대로. multi-exec가 각 `### Task N:` 헤더 + `## Chunk N:` 경계 + `## Chunk Review Gate` 마커 파싱.

## §6 Runner 동작 플로우

두 phase로 분기. Phase 1은 review 없이 linear dispatch, Phase 2부터 review loop.

### §6.1 Phase 1 플로우 (review 없이)
```
parse_plan(plan_file) → tasks[], chunks[]
acquire_lockfile(plan_file + ".multi-exec.lock")  # mutex

for chunk in chunks:
  for task in chunk.tasks:
    inject_sawp_spec(coder_session, task)
    log_event(dispatch, task)
    
    report = await_report(coder_session, timeout=$MULTI_EXEC_TIMEOUT)  # default 10min, configurable
    if report.timeout:
      escalate_stuck(task); exit 2
    log_event(impl_done, task)
    log_event(review_skipped, task, reason="phase1-no-reviewer-bridge")  # audit trail
  
  if chunk.gate == "user_approval":
    await_user_inject("CHUNK N APPROVED", timeout=none)
  elif chunk.gate == "auto_approved":
    continue

release_lockfile()
```

### §6.2 Phase 2 플로우 (review loop 포함)
```
// §6.1 base와 동일 + review 단계 주입
...
for task:
  ... impl_done 까지 동일 ...
  iter = 0
  while iter < max_fix_iterations:
    review = orchestrator_bridge_review(task.files, task.commit)  # §8 참조
    log_event(review, task, iter)
    if review.approved: log_event(approved, task); break
    inject_fix(coder_session, review.issues)
    await_report(coder_session, timeout); log_event(fix_done, task, iter+1)
    iter++
  if iter == max_fix_iterations: escalate_stuck(task)
```

두 phase의 플로우가 명확히 분리되어 §8 ambiguity 해소.

## §7 REPORT 파싱 — 엄격 key:value grammar

freeform regex는 drift-fail 위험 (오늘 실측 REPORT들도 필드 순서 변이 있었음). 엄격 line-based grammar 도입.

### §7.1 필수 REPORT grammar (SAWP envelope에 명시)

```
REPORT: Task <N> complete
files: <comma-separated paths>
tests: <pass_count>/<total_count>
commits: <sha>[, <sha>...]
issues: <short text or "none">
next: <Task N+1 | AWAIT <gate>>
```

각 필드 **한 줄 하나**, `key: value` 형식. 러너가 `grep -E "^key:\s*"` + `cut` 로 robust 파싱.

### §7.2 Backward compat

기존 plan의 "REPORT: | separator" 형식도 파싱 가능하도록 fallback 파서 유지 (Phase 1). 단 SAWP envelope 갱신 시 §7.1 grammar로 통일.

### §7.3 Phase 2: jsonl 옵션

`REPORT_JSONL=1` 환경 시 coder 세션이 `REPORT: {...json...}` 형태로 emit 옵션. 더 robust.

## §8 Subagent Review 자동화

```bash
# multi-exec.sh 내부
dispatch_subagent_review() {
  local task_id="$1"
  local files="$2"
  local commit="$3"
  # Agent tool API가 bash에서 호출 가능해야 — 현재는 불가
  # 대안: orchestrator 세션에 inject → orchestrator가 Agent tool 호출 → 결과 inject 반환
}
```

**한계**: bash 러너에서 Claude Code Agent tool 직접 호출 불가. 방법:
(a) 오케스트레이터 세션이 중개 — 러너가 오케스트레이터에 inject → 오케 Agent 실행 → 결과 응답
(b) subagent 자체도 telepty 세션으로 만들고 bash에서 제어
(c) review를 manual 단계로 두고, 러너는 coder 세션 제어만

Phase 1: (c) 선택 (review 단계만 수동). Phase 2: (a)로 확장.

## §9 Instrumentation 자동화

이미 사용 중인 event 7종 (`dispatch/spec_reply/impl_done/review/fix_done/approved/observation`) + 러너 전용 `review_skipped` → 러너가 각 phase에서 자동 append:
```bash
wtm context log orchestrator exec-event "event_name" '{"task":N,...}'
```

### §9.1 Ownership rule (HARD RULE — 중복 방지)

**multi-exec.sh가 실행되는 동안 오케스트레이터는 exec-events.jsonl에 수동 로깅 금지**. 러너가 이벤트 emission 독점. 러너 시작 시 pid 파일(`~/.wtm/contexts/orchestrator/multi-exec.pid`) 생성, 오케 이벤트 로그 스크립트는 pid 존재 시 skip + warning log.

종료 후 pid 파일 자동 삭제. Phase 1에 pid 기반 mutex 포함.

### §9.2 Phase 2: metrics aggregator CLI

`multi-exec stats [--since DATE] [--plan FILE]` — avg cycle, review hit rate, fix iterations 집계.

## §10 Fallback & Error handling

| 시나리오 | 대응 |
|---------|------|
| coder 세션 ID 모름 / 세션 없음 | `open-session.sh --auto-spawn` 호출 |
| REPORT timeout | retry 1회 → STUCK escalation |
| Trust dialog 첫 inject 소비 | `--auto-trust` 플래그 명시 시에만 `trust-path.sh` 자동 호출. 기본값은 warning 후 사용자 수동 처리 (security footgun 방지) |
| Fix loop 5회 초과 | STUCK + 오케스트레이터에 inject |
| Subagent 불가 | review 단계 skip 모드 (warning log) |
| telepty daemon down | fail-loud, 시작 불가 |

## §11 Migration

- Phase 1 (MVP, ~1일): Single coder session + freeform REPORT parsing + manual review + auto chunk gate
- Phase 2 (~2일): Auto subagent review via orchestrator bridge + jsonl REPORT option
- Phase 3 (~1일): Multi-parallel coder sessions (file ownership awareness)
- Phase 4 (~1일): Metrics aggregator CLI (`multi-exec stats`)

## §12 Success Metrics (실측 재정렬 — 정확도 개선)

### §12.1 Today's baseline (2026-04-19 실측 재계산)

- **총 Task**: 18 (Plan A 12 + Plan B 5 + Plan B 5-expand)
- **Plan drift 감지**: 2/18 (11%) — source 검증 gap
- **자율 adaptation**: 2/18 (11%) — INVARIANT 기반 scope 확장
- **Inter-task autonomy**: **0%** — 모든 Task 전환이 오케스트레이터 수동 inject 필요 (엄밀)
- **Intra-task autonomy**: ~89% — 한 inject 내에서 대부분 자율 실행

이전 §12 "autonomy ~70%" 수치는 모호했음. 정확 수치로 대체.

### §12.2 Phase별 목표

| Metric | Baseline (2026-04-19) | Phase 1 | Phase 2 |
|-------|:--------------------:|:-------:|:-------:|
| Orchestrator manual overhead (bash lines/task) | 5-10 | **0** | 0 |
| Average task cycle | 2.5 min | 동일 ±10% | +review 포함 3 min |
| Fix iteration bound | manual judgment | 5 hard limit (dead-code until P2) | 실효 |
| **Inter-task autonomy** | **0%** | **>95%** (핵심 가치) | >95% |
| **Plan drift detection** | 사후 coder 보고 | 러너 pre-flight source diff (선택) | 자동 플래깅 |

## §13 Out-of-Scope (Phase 5+)

- Cross-machine orchestration (telepty 원격 연동은 별도)
- Non-bash 러너 (Python/Go 포팅 고려 시)
- GUI 대시보드
- LLM 자체 의사결정 (예: plan drift 감지 시 자동 spec 수정) — 너무 위험

## §14 Dependencies

- `telepty` (이미 설치됨)
- `wtm-context` (이미 설치됨, #300 fix 반영)
- `jq`
- **`bash 4+`** — macOS 기본 3.2에서는 `brew install bash` 필수 (§3 constraint 4 참조)
- `flock` (또는 mkdir atomic)로 lockfile — 대부분 Unix-like 기본 포함
- Claude Code hooks/Agent (Phase 2+ orchestrator bridge에서만, Phase 1 불필요)

## §15a Testing Strategy (신규)

- **Unit**: `bats` — plan 파서, REPORT 파서, event emit, lockfile 취득/해제 각각
- **Integration**: mock telepty (shim `telepty` to echo-log args) + fixture plan + synthetic REPORTs → 전체 flow
- **Regression**: 오늘 `.telepty/shared/*.md` 131개 중 REPORT 18개를 test fixture로 저장 → 파서 호환성 검증
- **E2E smoke** (manual/nightly, NOT CI-blocking due to actual-session flakiness): actual coder session + 5-task mini plan (no review) → 끝까지 통과 확인. `make e2e-manual` 태그로 분리.

## §15b Concurrency Safeguards

- **Plan file lock**: runner 시작 시 `<plan-file>.multi-exec.lock` 생성. **flock 우선 사용** (자동 해제). atomic mkdir fallback은 stale lock 감지 필요 — `.lock` 내부에 pid 기록 + `kill -0 <pid>` liveness check로 stale 제거. SIGKILL 내성 확보.
- **Event log ownership**: §9.1 pid file 기반 mutex
- **Timeout configurable**: `MULTI_EXEC_TIMEOUT` 환경 변수 (기본 600초). 오늘 실측 max cycle 5.7min → 10min 여유

## §15 Next

1. 본 스펙 spec-document-reviewer 호출 (iter-2까지)
2. 승인 시 writing-plans 스킬 호출 → implementation plan
3. **Phase 1 MVP만 implementation** (Phase 2-5는 별도 sprint)

## §16 Today's data references

- Events log: `~/.wtm/contexts/aigentry-orchestrator/exec-events/2026-04-19.jsonl`
- Telepty refs: `~/.telepty/shared/*.md` (131 files)
- Plan A/B/#299 실측 참조: 커밋 `2eeb526..2452ad4` + `c3fc632` + `e592453` + `46bff5b`

이 데이터는 Phase 2+에서 Aggregator CLI 개발 시 fixture로 재사용 가능.
