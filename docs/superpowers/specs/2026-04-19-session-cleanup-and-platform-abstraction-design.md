---
status: draft
date: 2026-04-19
topic: session-cleanup-and-platform-abstraction
track: E-eco-sync (#304, blocks #307)
related: [#294 Plan A, #298 multi-exec, #299 open-session]
---

# Session Cleanup + Cross-OS Platform Abstraction — Design Spec

## §1 Goal (두 goal)

1. **Immediate**: 위임된 coder/analyst/reviewer 세션을 작업 완료 + REPORT 수신 확인 시 자동 종료. 오늘 E22/E27 같은 "세션 유기" 재발 방지.

2. **Structural**: Cross-OS 추상화 layer 도입. 신규 bash 코드가 `flock`/`fswatch`/`kill -TERM` 직접 호출 대신 platform API 경유. 미래 Windows 지원 시 migration cost 선형 유지.

## §2 Evidence (2026-04-19 세션 말미 발견)

- Plan A + B + #298 Phase 1 + #299 + #296 + #300/301 완료. 그러나 **E22-coder-294 + E27-coder-299 영속** — 수동 kill 안 함.
- 이유: runner/script 모두 cleanup primitive 없음. AGENTS.md에도 cleanup 규칙 없음.
- 헌법 Rule 2 (크로스) / Rule 14 (범용 블로킹 금지) 위반 — Windows 사용자 완전 차단.

## §3 Non-Goals

- Windows native 구현 (structural readiness만 — stub + 명확한 에러 메시지).
- 기존 ctx-router/multi-exec/wtm-context 전체 migration (→ #307, refactor-on-touch).
- aterm/brain/deliberation 같은 non-bash 컴포넌트 (inherently cross-platform).

## §4 Architecture

### §4.1 Abstraction layer (3-file)

```
aigentry-devkit/bin/lib/
├── platform.sh            # API dispatcher — detects OS + sources backend
├── platform-unix.sh       # macOS + Linux 구현
└── platform-windows.sh    # stub — echo + exit "not yet supported"
```

### §4.2 Abstract API (stable contract)

```bash
# Source via: source "$(dirname "$0")/lib/platform.sh"
# After source, these functions available:

platform::os_type()              # echoes: macos|linux|windows|unknown
                                 # honors $PLATFORM_OVERRIDE env (test injection),
                                 # else uname -s parse
platform::kill_pid(pid)          # SIGTERM + grace + SIGKILL fallback
platform::file_lock(path, fn)    # acquire lock for path, run fn, release
platform::file_unlock(path)      # explicit release
platform::event_wait(dir, timeout_sec)  # block until dir change or timeout
platform::is_alive(pid)          # 0 if alive, non-0 otherwise
platform::pid_exists(pidfile)    # parse file + is_alive
```

### §4.3 session-cleanup.sh flow

```bash
session-cleanup.sh <session-id>

1. platform::os_type → dispatch
2. Detect session source:
   a. telepty session info $sid → get pid + type (spawned/allowed)
   b. cmux list-workspaces | grep $sid → workspace ref (if any)
3. Cleanup state (먼저, 세션이 kill 되기 전 state flush):
   a. wtm-context handoff $sid "cleanup-complete"
   b. ctx-router.sh on-session-end $sid (LEARNING promote)
4. Terminate:
   a. platform::kill_pid $telepty_pid → SIGTERM + 5s grace + SIGKILL
      (fake signal inject 제거: claude CLI는 custom 문자열 handler 없음.
       SIGTERM grace로 OS-level cleanup만 제공)
   b. cmux close-workspace --workspace $ref (if exists)
5. Remove trace:
   a. Remove lockfiles / pidfiles related to $sid
```

Fail-soft: 없는 세션, 죽은 pid, 부재 wtm-context 모두 warning + exit 0.

### §4.4 multi-exec.sh 통합

Frontmatter 확장:
```yaml
multi_exec:
  ...
  cleanup_on_success: true   # default false (opt-in, 안전)
  preserve_on_error: true    # default true (drift/stuck 시 세션 유지)
```

Runner 종료 시:
- 모든 Task approved + chunk 완료 → `cleanup_on_success: true`면 `session-cleanup.sh $coder_session` 호출
- stuck/drift 감지 → preserve (디버깅용, `preserve_on_error: true` default)

### §4.5 open-session.sh EXIT trap

옵션 `--auto-cleanup-on-exit`: shell EXIT trap에 `session-cleanup.sh` 추가. 수동 세션 종료 시 trace 청소.

### §4.6 Platform backend 구현 매트릭스

| API | Unix (macOS+Linux) | Windows stub |
|-----|-------------------|--------------|
| `os_type` | `uname -s` 파싱 | "windows" 반환 |
| `kill_pid` | `kill -TERM` → wait 5s → `kill -9` | stub: "not yet" 에러 |
| `file_lock` | `flock` 있으면 flock, 없으면 mkdir + pid + liveness | stub |
| `event_wait` | `fswatch -1` (있으면), 없으면 sleep-poll | stub |
| `is_alive` | `kill -0 $pid` | stub (future: `tasklist \| findstr $pid`) |

## §5 Constraints

1. **Rule 17 무의존 strict**: bash 4+ / jq / flock / fswatch만. PowerShell/기타 추가 금지 (Windows는 future).
2. **BSD/macOS 호환**: portable awk/sed (Plan A/#298 경험 재사용).
3. **No reinvention**: 기존 `acquire_lock` / `emit_event` / wtm-context / ctx-router 활용.
4. **Fail-soft**: 없는 세션 → warning + exit 0. Blocking 금지.
5. **Backwards compat**: 기존 scripts (ctx-router 등) 즉시 migration 강제 X. #307에서 점진.
6. **Security**: `cleanup_on_success`는 opt-in. 기본값 false (drift 시 context preserve).

## §6 Non-functional

- Cleanup 속도: 1 session < 3초 (graceful + force)
- 병렬 cleanup: 여러 session 동시 처리 가능 (백그라운드 &)
- 멱등성: 같은 세션 중복 cleanup 호출 시 2회부터 noop
- Observability: 모든 단계 wtm context log

## §7 Testing Strategy

### §7.1 Unit (bats)
- platform::os_type 반환 값 검증 (shim uname)
- platform::kill_pid 죽은/없는 pid 처리
- platform::file_lock 동시 acquire 실패 검증
- platform::event_wait 타임아웃 처리

### §7.2 Integration
- session-cleanup.sh on non-existent session → exit 0 + warning
- session-cleanup.sh on telepty spawn session → 실제 kill 검증
- multi-exec.sh + cleanup_on_success → Plan 완료 후 coder 세션 사라짐

### §7.3 Windows stub 테스트
- platform.sh 를 `PLATFORM_OVERRIDE=windows` 로 강제 → stub 경로 진입 + 에러 메시지 명확

### §7.4 Regression
- 기존 ctx-router.bats + ctx-e2e.bats + multi-exec.bats + wtm test-context.sh 54/54 유지

## §8 Error Handling

| 시나리오 | 대응 |
|---------|------|
| `session-cleanup.sh` on unknown session | warning + exit 0 |
| `platform::kill_pid` pid already dead | warning + success |
| `platform::file_lock` held by live process | exit 1 + clear error |
| `platform::event_wait` timeout | return 1 + log timeout |
| `platform-windows.sh` 호출 | exit 3 + "Windows not yet supported, track #305" |
| multi-exec cleanup failed | warning + log `cleanup_failed` event, runner 자체는 exit 0 (실패가 cascading 방지) |

## §9 File Layout

```
aigentry-devkit/bin/
├── lib/
│   ├── platform.sh           (신규, ~60줄)
│   ├── platform-unix.sh      (신규, ~120줄)
│   └── platform-windows.sh   (신규, ~20줄 stub)
├── session-cleanup.sh        (신규, ~80줄)
├── multi-exec.sh             (+20줄 cleanup_on_success)
├── multi-exec-lib.sh         (platform API로 점진 migration — 이번 PR에서 file_lock/event_wait만)
└── open-session.sh           (+10줄 --auto-cleanup-on-exit)

aigentry-devkit/tests/
├── platform.bats             (신규, ~100줄)
├── session-cleanup.bats      (신규, ~80줄)
└── multi-exec.bats           (+10줄 cleanup 테스트)

aigentry-devkit/docs/
└── platform-abstraction.md   (신규, ~100줄 — API reference + backend guide)
```

총 신규 ~470 LOC production + ~180 LOC tests + 100 docs = ~750 LOC.

## §10 Migration plan

### Phase 1 (이번 #304, ~3-4시간)
- lib/platform*.sh 3개 파일 제작
- session-cleanup.sh 신규
- multi-exec.sh cleanup_on_success 추가
- multi-exec-lib.sh의 acquire_lock/await_task_report를 platform API로 재작성 (migration 시작)
- open-session.sh --auto-cleanup-on-exit 플래그
- 테스트 + 문서

### Phase 2 (#307, 별도 sprint)
- ctx-router.sh의 직접 `call_wtm_context` / `brain_append` / `flock` 호출을 platform API 경유로 이전 (필요 시만)
- wtm-context의 `with_lock` 함수 → platform::file_lock 위임 (선택)
- 각 touch 시 점진 migration

### Phase 3 (미래, Windows 사용자 등장 시)
- platform-windows.ps1 네이티브 구현
- open-session.sh Windows Terminal / cmd.exe 분기

## §11 AGENTS.md rule 추가 + interim CI guard

### §11.1 AGENTS.md Rule 26

```markdown
### Rule 26 — Cross-OS abstraction 준수 (HARD RULE)

신규 bash 코드는 `lib/platform.sh` abstract API 경유. 직접 `flock`/`fswatch`/`kill -TERM`/`kill -9` 등 OS-specific 호출 금지.

- 위반 예: `kill -TERM $pid` (platform-specific)
- 준수 예: `platform::kill_pid $pid` (abstract)

기존 코드는 refactor-on-touch (#307). 새 파일/기능은 예외 없이 준수.
```

### §11.2 Interim CI guard (Phase 1에 포함, pre-commit hook 전까지 임시)

`bin/check-platform-usage.sh` (새 파일, ~30 LOC):
```bash
# grep for OS-specific calls outside lib/platform-*.sh
VIOLATIONS=$(grep -rnE 'kill -(TERM|9)|\bflock\b|\bfswatch\b' \
  aigentry-devkit/bin/ 2>/dev/null \
  | grep -vE '^[^:]+/lib/platform-(unix|windows)\.sh:' \
  | grep -v '^[^:]+\.md:')

[[ -n "$VIOLATIONS" ]] && {
  echo "Rule 26 violation — direct OS-specific call found:" >&2
  echo "$VIOLATIONS" >&2
  exit 1
}
```

`make rule26-check` 또는 `devkit/bin/check-platform-usage.sh` — bats suite 실행 전 수동/CI에서 호출. Phase 2에서 pre-commit hook으로 자동화.

## §12 Success Metrics

- [ ] 명시적으로 3개 plan 파일 frontmatter에 `cleanup_on_success: true` 추가:
  - `docs/superpowers/plans/2026-04-19-context-compact-switching.md` (#294)
  - `docs/superpowers/plans/2026-04-19-ecosystem-contract-doc.md` (#297)
  - `docs/superpowers/plans/2026-04-19-multi-exec-phase1.md` (#298)
  → 플래그 적용 후 실제 session 자동 종료 확인
- [ ] 54/54 기존 bats + 신규 platform/cleanup bats 전부 pass
- [ ] shellcheck clean on new files
- [ ] `PLATFORM_OVERRIDE=windows session-cleanup.sh fake-sid` → 명확한 에러 exit 3
- [ ] session-cleanup.sh 단일 session 처리 < 3초 (실측)
- [ ] AGENTS.md Rule 26 추가 + 위반 시 pre-commit hook fail (future enhancement)

## §13 Risks

| 리스크 | 완화 |
|-------|------|
| Abstraction overhead | Unix backend은 thin wrapper, 성능 손실 무시 수준 |
| Over-abstraction (YAGNI) | API 7개만, 실제 호출되는 것만 정의. 추측 미래 API 금지 |
| Windows stub이 조용한 실패 유도 | stub exit 3 + stderr 명확한 메시지 강제 |
| #307 migration 영영 안 됨 | refactor-on-touch 원칙 + 분기별 audit |

## §14 Dependencies

- 기존: bash 4+ / jq / flock / fswatch (optional) / wtm-context / telepty
- 새 dep 0

## §15 Next

1. spec-document-reviewer iter
2. writing-plans 스킬 호출
3. implementation dispatch (E22-coder-294 재사용 또는 새 세션)
4. Phase 2/3는 별도 태스크로 track
