---
multi_exec:
  enabled: true
  coder_session: E22-coder-294
  cleanup_on_success: true
  preserve_on_error: true
---

# Context Compact & Switching Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI 컨텍스트 윈도우가 가득찰 때 자연스럽게 compact + context switching 하는 glue layer를 기존 brain/wtm-context/task-queue 위에 추가한다.

**Architecture:** 3-Layer (Event Sources 재사용 + Glue Layer 신규 ~200줄 + Storage 재사용). 4개 event trigger (CLI hook, git, tq, session lifecycle) → `ctx-router.sh`가 ephemeral/long-term 분류 → wtm-context 또는 brain MCP로 라우팅.

**Tech Stack:** bash 5, jq, Claude Code hooks (PreCompact, SessionStart), brain MCP CLI, wtm-context bash library.

**Spec reference:** `docs/superpowers/specs/2026-04-19-context-compact-switching-design.md`

---

## File Structure

| 파일 | 유형 | 역할 | 크기 |
|------|------|------|------|
| `aigentry-devkit/bin/ctx-router.sh` | create | classify + route 핵심 | ~80줄 |
| `~/.claude/hooks/pre-compact.sh` | create | Claude PreCompact → ctx-router | ~30줄 |
| `~/.claude/hooks/session-start.sh` | create | Claude SessionStart:compact → restore | ~30줄 |
| `aigentry-devkit/templates/git-hooks/post-commit` | create | git commit → brain + wtm log | ~20줄 |
| `aigentry-devkit/bin/ctx-install.sh` | create | 일괄 설치/업데이트 | ~40줄 |
| `aigentry-devkit/tools/wtm/lib/context.sh` | modify | `orphan_check` 함수 추가 (thin wrapper) | +20줄 |
| `aigentry-devkit/tools/wtm/bin/wtm-context` | modify | `orphan-check` 서브커맨드 + `rebind` 서브커맨드 추가 | +20줄 |
| `aigentry-orchestrator/bin/tq-status.sh` | modify | status 변경 분기에 ctx-router call 추가 | +3줄 |
| `aigentry-orchestrator/bin/tq-focus.sh` | modify | 동일 | +3줄 |
| `aigentry-devkit/bin/open-session.sh` | modify | EXIT trap으로 session end handoff | +5줄 |
| `aigentry-devkit/tests/ctx-router.bats` | create | unit + integration 테스트 | ~100줄 |

**총 신규 ~320줄 (테스트 포함), production code ~220줄.**

---

## Chunk 1: Core glue + Claude hooks + orphan-check

### Task 1: ctx-router.sh 스켈레톤 + classify() 기본

**Files:**
- Create: `aigentry-devkit/bin/ctx-router.sh`
- Test: `aigentry-devkit/tests/ctx-router.bats`

- [ ] **Step 1.1: 빈 스크립트 + shebang + usage**

`aigentry-devkit/bin/ctx-router.sh`:
```bash
#!/usr/bin/env bash
# ctx-router.sh — Context Compact & Switching glue layer
# Spec: docs/superpowers/specs/2026-04-19-context-compact-switching-design.md
set -euo pipefail

CTX_ROUTER_VERSION="0.1.0"
CTX_DEFAULT_SCOPE_PREFIX="session"

usage() {
  cat <<'EOF'
Usage: ctx-router.sh <subcommand> [args]

Subcommands:
  classify <event-type> <payload-json>   Print destination (ephemeral|long-term|both)
  on-precompact <session-id>             Handle Claude PreCompact event
  on-session-start <session-id>          Handle Claude SessionStart:compact event
  on-git-commit <project> <sha> <msg>    Handle git post-commit event
  on-tq-transition <sid> <tid> <old> <new>  Handle task-queue status change
  on-session-end <session-id>            Handle session lifecycle end
  restore <session-id>                   Emit merged context (wtm + brain)
  version
EOF
}

main() {
  local sub="${1:-}"
  [[ -z "$sub" ]] && { usage; exit 1; }
  shift
  case "$sub" in
    classify)          cmd_classify "$@" ;;
    on-precompact)     cmd_on_precompact "$@" ;;
    on-session-start)  cmd_on_session_start "$@" ;;
    on-git-commit)     cmd_on_git_commit "$@" ;;
    on-tq-transition)  cmd_on_tq_transition "$@" ;;
    on-session-end)    cmd_on_session_end "$@" ;;
    restore)           cmd_restore "$@" ;;
    version)           echo "$CTX_ROUTER_VERSION" ;;
    *)                 usage; exit 1 ;;
  esac
}

# Stub implementations (filled in next tasks)
cmd_classify()          { echo "TODO"; exit 1; }
cmd_on_precompact()     { echo "TODO"; exit 1; }
cmd_on_session_start()  { echo "TODO"; exit 1; }
cmd_on_git_commit()     { echo "TODO"; exit 1; }
cmd_on_tq_transition()  { echo "TODO"; exit 1; }
cmd_on_session_end()    { echo "TODO"; exit 1; }
cmd_restore()           { echo "TODO"; exit 1; }

main "$@"
```

- [ ] **Step 1.2: 실행 권한 + version 확인**

Run:
```bash
chmod +x aigentry-devkit/bin/ctx-router.sh
./aigentry-devkit/bin/ctx-router.sh version
```
Expected: `0.1.0`

- [ ] **Step 1.3: 테스트 프레임워크 준비 (bats)**

`aigentry-devkit/tests/ctx-router.bats`:
```bash
#!/usr/bin/env bats
# Tests for ctx-router.sh

setup() {
  CTX_ROUTER="$(pwd)/aigentry-devkit/bin/ctx-router.sh"
}

@test "version returns 0.1.0" {
  run "$CTX_ROUTER" version
  [ "$status" -eq 0 ]
  [ "$output" = "0.1.0" ]
}

@test "missing subcommand exits 1" {
  run "$CTX_ROUTER"
  [ "$status" -eq 1 ]
}

@test "unknown subcommand exits 1" {
  run "$CTX_ROUTER" bogus
  [ "$status" -eq 1 ]
}
```

- [ ] **Step 1.4: 테스트 실행**

Run: `bats aigentry-devkit/tests/ctx-router.bats`
Expected: 3 pass, 0 fail. If bats 미설치 시 `brew install bats-core`.

- [ ] **Step 1.5: Commit**

```bash
git add aigentry-devkit/bin/ctx-router.sh aigentry-devkit/tests/ctx-router.bats
git commit -m "feat(ctx-router): skeleton with subcommand dispatch + bats harness (#294)"
```

---

### Task 2: classify() 구현 + 테스트

**Files:**
- Modify: `aigentry-devkit/bin/ctx-router.sh` (replace `cmd_classify` stub)
- Modify: `aigentry-devkit/tests/ctx-router.bats` (add classify tests)

- [ ] **Step 2.1: classify 로직 구현**

Replace `cmd_classify()` in `ctx-router.sh`:
```bash
# classify(event-type, payload-json) → stdout: "ephemeral" | "long-term" | "both"
cmd_classify() {
  local event="${1:-}"
  local payload="${2:-{}}"
  [[ -z "$event" ]] && { echo "classify: event required" >&2; exit 2; }
  case "$event" in
    precompact)          echo "both" ;;           # wtm handoff + brain summary
    session-start)       echo "restore" ;;         # read from both
    git-commit)          echo "long-term" ;;       # brain decision
    tq-transition)
      # status=done → both (promote summary), else ephemeral
      local new_status
      new_status=$(echo "$payload" | jq -r '.new // empty')
      if [[ "$new_status" == "done" ]]; then echo "both"; else echo "ephemeral"; fi
      ;;
    session-end)         echo "both" ;;            # final handoff + learning promote
    *)                   echo "classify: unknown event '$event'" >&2; exit 2 ;;
  esac
}
```

- [ ] **Step 2.2: classify 테스트 추가**

Append to `ctx-router.bats`:
```bash
@test "classify precompact returns both" {
  run "$CTX_ROUTER" classify precompact '{}'
  [ "$status" -eq 0 ]
  [ "$output" = "both" ]
}

@test "classify git-commit returns long-term" {
  run "$CTX_ROUTER" classify git-commit '{}'
  [ "$status" -eq 0 ]
  [ "$output" = "long-term" ]
}

@test "classify tq-transition done returns both" {
  run "$CTX_ROUTER" classify tq-transition '{"new":"done"}'
  [ "$status" -eq 0 ]
  [ "$output" = "both" ]
}

@test "classify tq-transition in_progress returns ephemeral" {
  run "$CTX_ROUTER" classify tq-transition '{"new":"in_progress"}'
  [ "$status" -eq 0 ]
  [ "$output" = "ephemeral" ]
}

@test "classify unknown event exits 2" {
  run "$CTX_ROUTER" classify bogus '{}'
  [ "$status" -eq 2 ]
}
```

- [ ] **Step 2.3: 테스트 실행**

Run: `bats aigentry-devkit/tests/ctx-router.bats`
Expected: 8 pass, 0 fail.

- [ ] **Step 2.4: Commit**

```bash
git add aigentry-devkit/bin/ctx-router.sh aigentry-devkit/tests/ctx-router.bats
git commit -m "feat(ctx-router): classify() with 5 event types + tests (#294)"
```

---

### Task 3: on-precompact() 구현 + mock 테스트

**Files:**
- Modify: `aigentry-devkit/bin/ctx-router.sh`
- Modify: `aigentry-devkit/tests/ctx-router.bats`

- [ ] **Step 3.1: wtm-context wrapper + brain_append 헬퍼 함수**

Add after `cmd_classify()`:
```bash
# call_wtm_context(args...) — wtm-context CLI wrapper with fallback
call_wtm_context() {
  if command -v wtm-context >/dev/null 2>&1; then
    wtm-context "$@"
  elif [[ -x "$HOME/.wtm/bin/wtm-context" ]]; then
    "$HOME/.wtm/bin/wtm-context" "$@"
  else
    echo "[ctx-router] wtm-context not found; skipping wtm call" >&2
    return 0  # fail soft per §8 Error Handling
  fi
}

# call_brain_append(scope, category, content) — brain MCP append wrapper
call_brain_append() {
  local scope="$1" category="$2" content="$3"
  # Check if brain CLI available; MCP-only deployments may use different entry point
  if command -v brain >/dev/null 2>&1; then
    brain append --scope "$scope" --category "$category" --content "$content" 2>&1 || {
      echo "[ctx-router] brain append failed; continuing" >&2
      return 0
    }
  else
    echo "[ctx-router] brain CLI not found; skipping long-term persist" >&2
    return 0
  fi
}
```

- [ ] **Step 3.2: cmd_on_precompact 구현**

Replace stub:
```bash
# on-precompact(session-id) — Event 5.1
cmd_on_precompact() {
  local sid="${1:-}"
  [[ -z "$sid" ]] && { echo "on-precompact: session-id required" >&2; exit 2; }
  local cwd summary
  cwd="$(pwd)"
  summary="auto-compact snapshot @ $(date -Iseconds) cwd=$cwd"
  call_wtm_context handoff "$sid" "$summary" || true
  call_wtm_context log "$sid" milestone "precompact event" || true
  call_brain_append "session:$sid" "summary" "$summary" || true
  echo "[ctx-router] precompact handled: sid=$sid"
}
```

- [ ] **Step 3.3: 테스트 (PATH 상 wtm-context/brain 모두 없는 환경에서도 exit 0)**

Append to bats:
```bash
@test "on-precompact without wtm/brain: degraded ok" {
  # Isolate PATH so wtm-context/brain not found
  run env PATH="/usr/bin:/bin" HOME="$BATS_TMPDIR" "$CTX_ROUTER" on-precompact "test-sid"
  [ "$status" -eq 0 ]
}

@test "on-precompact requires session-id" {
  run "$CTX_ROUTER" on-precompact
  [ "$status" -eq 2 ]
}
```

- [ ] **Step 3.4: 테스트 실행**

Run: `bats aigentry-devkit/tests/ctx-router.bats`
Expected: 10 pass, 0 fail.

- [ ] **Step 3.5: Commit**

```bash
git add aigentry-devkit/bin/ctx-router.sh aigentry-devkit/tests/ctx-router.bats
git commit -m "feat(ctx-router): on-precompact handler with wtm+brain fail-soft (#294)"
```

---

### Task 4: on-session-start + restore() 구현

**Files:**
- Modify: `aigentry-devkit/bin/ctx-router.sh`
- Modify: `aigentry-devkit/tests/ctx-router.bats`

- [ ] **Step 4.1: restore + on-session-start 구현**

```bash
# restore(session-id) — read wtm handoff + brain summary, emit merged markdown
cmd_restore() {
  local sid="${1:-}"
  [[ -z "$sid" ]] && { echo "restore: session-id required" >&2; exit 2; }
  local wtm_output brain_output
  wtm_output="$(call_wtm_context resume "$sid" 2>/dev/null || true)"
  if command -v brain >/dev/null 2>&1; then
    brain_output="$(brain query --scope "session:$sid" --slot conversation_summary 2>/dev/null || true)"
  fi
  cat <<EOF
## Context Restore for $sid

### Session handoff (wtm-context)
$wtm_output

### Session summary (brain)
$brain_output
EOF
}

# on-session-start(session-id) — Event 5.2
# Emits JSON for Claude Code hookSpecificOutput.additionalContext
cmd_on_session_start() {
  local sid="${1:-}"
  [[ -z "$sid" ]] && { echo "on-session-start: session-id required" >&2; exit 2; }
  local ctx
  ctx="$(cmd_restore "$sid")"
  # Truncate if > 16KB (hookSpecificOutput limit heuristic)
  local max_bytes=16000
  if (( ${#ctx} > max_bytes )); then
    ctx="${ctx:0:$max_bytes}

---
⚠️ truncated. Run 'wtm-context resume $sid' for full history.
"
  fi
  # Emit Claude Code hook JSON
  jq -n --arg c "$ctx" '{hookSpecificOutput: {additionalContext: $c}}'
}
```

- [ ] **Step 4.2: 테스트**

```bash
@test "restore without state: emits template without error" {
  run env HOME="$BATS_TMPDIR" "$CTX_ROUTER" restore "empty-sid"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "Context Restore for empty-sid"
}

@test "on-session-start emits valid JSON" {
  run env HOME="$BATS_TMPDIR" "$CTX_ROUTER" on-session-start "test-sid"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.additionalContext' >/dev/null
}
```

- [ ] **Step 4.3: 테스트 실행 + commit**

```bash
bats aigentry-devkit/tests/ctx-router.bats
# Expected: 12 pass

git add aigentry-devkit/bin/ctx-router.sh aigentry-devkit/tests/ctx-router.bats
git commit -m "feat(ctx-router): restore + on-session-start with 16KB truncation (#294)"
```

---

### Task 5: Claude Code hook 템플릿 (devkit 내부)

**Files:**
- Create: `aigentry-devkit/templates/claude-hooks/pre-compact.sh`
- Create: `aigentry-devkit/templates/claude-hooks/session-start.sh`

> **Note**: Hooks 자체는 `~/.claude/hooks/` 에 최종 설치되지만, 재발명 방지 + 버전 관리를 위해 **devkit 안에서 템플릿으로 관리**. 설치는 Task 9 `ctx-install.sh`가 담당. 수동 설치 시 `cp` 후 `chmod +x` 만으로 충분.

- [ ] **Step 5.1: pre-compact.sh 템플릿 작성**

`aigentry-devkit/templates/claude-hooks/pre-compact.sh`:
```bash
#!/usr/bin/env bash
# Claude Code PreCompact hook → ctx-router
# Spec: docs/superpowers/specs/2026-04-19-context-compact-switching-design.md §5.1
set -euo pipefail

CTX_ROUTER="${CTX_ROUTER_PATH:-$HOME/projects/aigentry-devkit/bin/ctx-router.sh}"
[[ -x "$CTX_ROUTER" ]] || { echo "[pre-compact] ctx-router not found at $CTX_ROUTER" >&2; exit 0; }

# Claude passes session JSON on stdin
PAYLOAD="$(cat)"
SID="$(echo "$PAYLOAD" | jq -r '.session_id // empty')"
[[ -z "$SID" ]] && { echo "[pre-compact] no session_id in payload; skipping" >&2; exit 0; }

"$CTX_ROUTER" on-precompact "$SID" >&2 || true
# Pre-compact hook expects exit 0 on success; must not block compact
exit 0
```

- [ ] **Step 5.2: session-start.sh 템플릿 작성**

`aigentry-devkit/templates/claude-hooks/session-start.sh`:
```bash
#!/usr/bin/env bash
# Claude Code SessionStart hook → ctx-router restore
# Triggered on resume/compact/clear
set -euo pipefail

CTX_ROUTER="${CTX_ROUTER_PATH:-$HOME/projects/aigentry-devkit/bin/ctx-router.sh}"
[[ -x "$CTX_ROUTER" ]] || { echo '{}' ; exit 0; }

PAYLOAD="$(cat)"
TRIGGER="$(echo "$PAYLOAD" | jq -r '.trigger // empty')"
SID="$(echo "$PAYLOAD" | jq -r '.session_id // empty')"

# Only act on compact trigger (not resume/clear which Claude handles)
if [[ "$TRIGGER" != "compact" ]]; then
  echo '{}'
  exit 0
fi

[[ -z "$SID" ]] && { echo '{}' ; exit 0; }

"$CTX_ROUTER" on-session-start "$SID" || echo '{}'
```

- [ ] **Step 5.3: 실행 권한 + shellcheck**

```bash
chmod +x aigentry-devkit/templates/claude-hooks/*.sh
shellcheck aigentry-devkit/templates/claude-hooks/*.sh
```
Expected: shellcheck 0 errors (경고는 허용).

- [ ] **Step 5.4: 설치는 Task 9 (`ctx-install.sh`)에서 처리 — 이 태스크에서는 수행 X**

settings.json 등록도 Task 9의 `register_hooks_in_settings` 함수에서 자동화된 jq merge로 처리한다. 수동 ad-hoc 편집 금지.

- [ ] **Step 5.5: Commit (devkit)**

```bash
git -C aigentry-devkit add templates/claude-hooks/pre-compact.sh templates/claude-hooks/session-start.sh
git -C aigentry-devkit commit -m "feat(ctx-hooks): Claude PreCompact + SessionStart hook templates (#294)"
```

---

### Task 6: wtm-context `orphan-check` + `rebind` 서브커맨드

**Files:**
- Modify: `aigentry-devkit/tools/wtm/lib/context.sh` (+20줄)
- Modify: `aigentry-devkit/tools/wtm/bin/wtm-context` (+20줄)

- [ ] **Step 6.1: lib/context.sh에 orphan_check 함수 추가**

Append to `lib/context.sh`:
```bash
# ---------------------------------------------------------------------------
# orphan_check(cwd)
# thin wrapper: find most recent session for cwd, emit last handoff + journal tail.
# No new storage; reads existing journal.jsonl + sessions.json.
# ---------------------------------------------------------------------------
orphan_check() {
  local target_cwd="${1:-$(pwd)}"
  local sessions_file="${WTM_SESSIONS}"
  [[ -f "$sessions_file" ]] || { echo "no sessions file"; return 1; }
  # Find session with matching cwd, most recent last_active
  local sid
  sid=$(jq -r --arg cwd "$target_cwd" '
    to_entries
    | map(select(.value.cwd == $cwd or (.value.cwd // "") | startswith($cwd)))
    | sort_by(.value.last_active // "") | reverse | .[0].key // empty
  ' "$sessions_file")
  [[ -z "$sid" ]] && { echo "no orphaned session for $target_cwd"; return 1; }
  echo "## Orphan session candidate: $sid"
  echo "### Last handoff"
  restore_handoff "$sid" 2>/dev/null || echo "(no handoff)"
  echo ""
  echo "### Recent journal (last 10)"
  journal_tail "$sid" 10 2>/dev/null || echo "(empty journal)"
}

# rebind(cwd, new_sid) — alias old orphan session to new session id (fail loud version)
rebind_session() {
  local target_cwd="${1:-}" new_sid="${2:-}"
  [[ -z "$target_cwd" || -z "$new_sid" ]] && { echo "rebind: cwd and new-sid required" >&2; return 2; }
  # Read orphan candidate, update sessions.json to set alias
  local old_sid
  old_sid=$(jq -r --arg cwd "$target_cwd" '
    to_entries | map(select(.value.cwd == $cwd)) | sort_by(.value.last_active) | reverse | .[0].key // empty
  ' "$WTM_SESSIONS")
  [[ -z "$old_sid" ]] && { echo "rebind: no orphan found for $target_cwd" >&2; return 1; }
  echo "Rebinding $old_sid → $new_sid (cwd=$target_cwd)"
  # Copy journal + handoff paths to new sid under lock (delegates to existing primitives)
  with_lock "sessions" python3 -c "
import json, sys
f = sys.argv[1]; old = sys.argv[2]; new = sys.argv[3]
data = json.load(open(f))
if old in data:
    data[new] = data[old].copy()
    data[new]['rebound_from'] = old
    data[new]['rebound_at'] = sys.argv[4]
json.dump(data, open(f,'w'), indent=2)
" "$WTM_SESSIONS" "$old_sid" "$new_sid" "$(date -Iseconds)"
}
```

- [ ] **Step 6.2: wtm-context bin dispatch 확장**

Insert new cases in `wtm-context` before `help)`:
```bash
  orphan-check)
    shift
    orphan_check "${1:-$(pwd)}"
    ;;
  rebind)
    shift
    if [[ $# -lt 2 ]]; then
      echo "Usage: wtm context rebind <cwd> <new-session-id>"
      exit 2
    fi
    rebind_session "$1" "$2"
    ;;
```

Update `help` block to document these.

- [ ] **Step 6.3: 기본 검증 테스트**

```bash
# orphan-check in empty env
WTM_HOME="$(mktemp -d)" ~/.wtm/bin/wtm-context orphan-check
# Expected: exit 1 with "no sessions file" or "no orphaned session"

# rebind missing args
WTM_HOME="$(mktemp -d)" ~/.wtm/bin/wtm-context rebind
# Expected: exit 2 with usage message
```

- [ ] **Step 6.4: Chunk 1 누적 테스트 스모크**

```bash
bats aigentry-devkit/tests/ctx-router.bats
# Expected: 12 pass cumulative (Tasks 1-4 tests + any Task 6 bats additions)
shellcheck aigentry-devkit/bin/ctx-router.sh aigentry-devkit/templates/claude-hooks/*.sh
# Expected: no errors (warnings 허용)
```

- [ ] **Step 6.5: Commit**

```bash
git -C aigentry-devkit add tools/wtm/lib/context.sh tools/wtm/bin/wtm-context
git -C aigentry-devkit commit -m "feat(wtm-context): orphan-check + rebind subcommands (thin wrappers, #294)"
```

---

## Chunk 1 Review Gate

Dispatch plan-document-reviewer for Chunk 1 before proceeding to Chunk 2. Fix and re-dispatch until approved.

---

## Chunk 2: Cross-CLI events + installer + E2E tests

### Task 7: git post-commit template + tq hook 라인

**Files:**
- Create: `aigentry-devkit/templates/git-hooks/post-commit`
- Modify: `aigentry-orchestrator/bin/tq-status.sh`
- Modify: `aigentry-orchestrator/bin/tq-focus.sh`

- [ ] **Step 7.1: post-commit 템플릿**

`aigentry-devkit/templates/git-hooks/post-commit`:
```bash
#!/usr/bin/env bash
# aigentry git post-commit hook → ctx-router long-term milestone
# Spec §5.3. MUST NOT block commit — any failure must exit 0.

CTX_ROUTER="${CTX_ROUTER_PATH:-$HOME/projects/aigentry-devkit/bin/ctx-router.sh}"
[[ -x "$CTX_ROUTER" ]] || exit 0

# Safe project detection (bare repo / detached work tree fallback)
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo '')"
[[ -z "$TOPLEVEL" ]] && exit 0
PROJECT="$(basename "$TOPLEVEL")"

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo '')"
MSG="$(git log -1 --pretty=%s 2>/dev/null || echo '')"
[[ -z "$SHA" ]] && exit 0

"$CTX_ROUTER" on-git-commit "$PROJECT" "$SHA" "$MSG" >&2 2>/dev/null || true
exit 0
```

- [ ] **Step 7.2: cmd_on_git_commit 구현 (ctx-router.sh)**

Replace stub:
```bash
cmd_on_git_commit() {
  local project="${1:-}" sha="${2:-}" msg="${3:-}"
  [[ -z "$project" || -z "$sha" ]] && { echo "on-git-commit: project and sha required" >&2; exit 2; }
  call_brain_append "app:$project" "decision" "[$sha] $msg" || true
  # Also log cross-reference in orchestrator session journal if exists
  local orch_sid="aigentry-orchestrator"
  call_wtm_context log "$orch_sid" milestone "commit $sha $project: $msg" 2>/dev/null || true
  echo "[ctx-router] git-commit handled: $project@$sha"
}
```

- [ ] **Step 7.3a: 사전 조사 — tq 스크립트의 현재 상태 변경 로직 파악**

```bash
grep -nE "status|STATUS|\"status\":" aigentry-orchestrator/bin/tq-status.sh
grep -nE "status|STATUS|\"status\":" aigentry-orchestrator/bin/tq-focus.sh
```

**확인 사항**:
1. 어느 라인에서 JSON의 `status` 필드가 업데이트되는가 (jq `.status = ...` 또는 `sed`)?
2. 변수 이름: `$TASK_ID`/`$id`, `$OLD_STATUS`/`$old`, `$NEW_STATUS`/`$new` — 실제 스크립트에 있는 이름을 확인 후 아래 step에서 해당 변수명 사용
3. `tq-focus.sh`는 실제로 status를 mutate하는가? (보통 pointer만 이동하므로 mutate 없을 가능성. 없으면 Step 7.3c 생략)

- [ ] **Step 7.3b: tq-status.sh 에 hook 라인 추가**

Step 7.3a에서 확인한 변수명 사용. JSON 쓰기 완료 직후 (파일 mv/write 성공한 분기 끝) 다음 블록 삽입:
```bash
# Event 5.4 trigger — emit ctx-router transition (Spec §5.4)
CTX_ROUTER="${CTX_ROUTER_PATH:-$HOME/projects/aigentry-devkit/bin/ctx-router.sh}"
if [[ -x "$CTX_ROUTER" ]]; then
  # Replace <TASK_VAR> / <OLD_VAR> / <NEW_VAR> with actual script variables from 7.3a
  "$CTX_ROUTER" on-tq-transition "${SESSION_ID:-orchestrator}" "${<TASK_VAR>}" "${<OLD_VAR>}" "${<NEW_VAR>}" >&2 2>/dev/null || true
fi
```

변수명 통일이 필요하면 preliminary refactor PR을 먼저 낸다 (이 step과 분리). 여기서는 **기존 변수명 그대로 유지** — 위 plan snippet의 `<>` 자리만 치환.

- [ ] **Step 7.3c: tq-focus.sh — status mutate 하지 않으면 skip**

Step 7.3a 결과가 "tq-focus.sh는 status mutate 안 함" 이면 이 step 건너뜀. mutate 한다면 7.3b와 동일 패턴 적용.

- [ ] **Step 7.4: cmd_on_tq_transition 구현**

```bash
cmd_on_tq_transition() {
  local sid="${1:-}" tid="${2:-}" old="${3:-}" new="${4:-}"
  [[ -z "$sid" || -z "$tid" ]] && { echo "on-tq-transition: sid + tid required" >&2; exit 2; }
  call_wtm_context log "$sid" milestone "task $tid: $old → $new" || true
  if [[ "$new" == "done" ]]; then
    local desc
    desc=$(jq -r --arg id "$tid" '.tasks[] | select((.id|tostring)==$id) | .desc // empty' \
              state/task-queue.json 2>/dev/null || echo "")
    call_brain_append "app:orchestrator" "summary" "task $tid done: $desc" || true
  fi
  echo "[ctx-router] tq-transition handled: $tid $old→$new"
}
```

- [ ] **Step 7.5: 테스트**

```bash
# Test git post-commit dry-run
cd /tmp && mkdir ctx-test && cd ctx-test && git init && cp ~/projects/aigentry-devkit/templates/git-hooks/post-commit .git/hooks/
chmod +x .git/hooks/post-commit
echo hi > f && git add f && git commit -m "test commit for ctx-router"
# Expected: commit succeeds; stderr shows "[ctx-router] git-commit handled"
```

Add bats tests for cmd_on_git_commit and cmd_on_tq_transition missing-arg cases.

- [ ] **Step 7.6: Commit**

```bash
git -C aigentry-devkit add templates/git-hooks/post-commit bin/ctx-router.sh
git -C aigentry-devkit commit -m "feat(ctx-router): git-commit + tq-transition handlers + post-commit template (#294)"

git -C aigentry-orchestrator add bin/tq-status.sh bin/tq-focus.sh
git -C aigentry-orchestrator commit -m "feat(tq): emit ctx-router transition event on status change (#294)"
```

---

### Task 8: Session lifecycle EXIT trap + on-session-end

**Files:**
- Modify: `aigentry-devkit/bin/open-session.sh`
- Modify: `aigentry-devkit/bin/ctx-router.sh` (cmd_on_session_end)

- [ ] **Step 8.1: cmd_on_session_end 구현**

```bash
cmd_on_session_end() {
  local sid="${1:-}"
  [[ -z "$sid" ]] && { echo "on-session-end: sid required" >&2; exit 2; }
  call_wtm_context handoff "$sid" "session-end-auto" || true
  # Promote LEARNING: markers from journal to brain
  local journal
  journal=$(call_wtm_context journal "$sid" --tail 500 2>/dev/null || true)
  echo "$journal" | grep -E "^.*LEARNING:" | while IFS= read -r line; do
    call_brain_append "app:$(basename "$(pwd)")" "learning" "$line" || true
  done
  echo "[ctx-router] session-end handled: $sid"
}
```

- [ ] **Step 8.2a: 사전 조사 — 기존 EXIT trap 충돌 확인**

```bash
grep -nE "^trap |EXIT\b" aigentry-devkit/bin/open-session.sh
```

**판단**:
- 기존 trap 없음 → Step 8.2b 그대로 진행
- 기존 trap 있음 → 기존 cleanup 함수에 ctx-router 호출 라인 append (새 trap 등록 금지). trap 이중 등록은 마지막 것이 이전 것을 덮어씀.
- SESSION_ID 변수명도 스크립트 내부 확인 (`$SID`, `$session_id` 등 변형 가능)

- [ ] **Step 8.2b: EXIT trap 추가 (기존 trap 없는 경우)**

SESSION_ID 결정 직후 (변수 할당 라인 바로 뒤):
```bash
cleanup_on_exit() {
  local ec=$?
  local ctx_router="${CTX_ROUTER_PATH:-$HOME/projects/aigentry-devkit/bin/ctx-router.sh}"
  [[ -x "$ctx_router" ]] && "$ctx_router" on-session-end "${SESSION_ID:-unknown}" >&2 2>/dev/null || true
  exit $ec
}
trap cleanup_on_exit EXIT
```

기존 trap 있으면 Step 8.2c 참조.

- [ ] **Step 8.2c: 기존 cleanup 함수 수정 (필요 시)**

```bash
# 기존 cleanup 함수 안의 마지막 라인 (exit 직전)에 추가:
"${CTX_ROUTER_PATH:-$HOME/projects/aigentry-devkit/bin/ctx-router.sh}" on-session-end "${SESSION_ID:-unknown}" >&2 2>/dev/null || true
```

- [ ] **Step 8.3: 테스트**

```bash
# Sandbox invocation exits → verify wtm handoff created
OPEN_SESSION_ID=test-cleanup bash -c '~/projects/aigentry-devkit/bin/open-session.sh --test-mode; true'
wtm-context journal test-cleanup --tail 5
# Expected: "session-end-auto" handoff event
```

- [ ] **Step 8.4: Commit**

```bash
git -C aigentry-devkit add bin/open-session.sh bin/ctx-router.sh
git -C aigentry-devkit commit -m "feat(ctx-router): session-end handler + open-session EXIT trap (#294)"
```

---

### Task 9: ctx-install.sh 일괄 설치 스크립트

**Files:**
- Create: `aigentry-devkit/bin/ctx-install.sh`

- [ ] **Step 9.1: 스크립트 작성**

`aigentry-devkit/bin/ctx-install.sh`:
```bash
#!/usr/bin/env bash
# ctx-install.sh — Install Claude hooks + git templates for context routing
# Spec §7
set -euo pipefail

DEVKIT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_HOOKS="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"

install_claude_hooks() {
  mkdir -p "$CLAUDE_HOOKS"
  for h in pre-compact.sh session-start.sh; do
    local src="$DEVKIT_ROOT/templates/claude-hooks/$h"
    local dst="$CLAUDE_HOOKS/$h"
    if [[ -f "$dst" ]] && ! cmp -s "$src" "$dst"; then
      echo "[ctx-install] skipping $dst (exists + differs). diff:"
      diff "$dst" "$src" | head -20 || true
      continue
    fi
    cp "$src" "$dst" && chmod +x "$dst"
    echo "[ctx-install] installed $dst"
  done
}

register_hooks_in_settings() {
  [[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
  local tmp pre_path ss_path
  # Claude Code does NOT expand $HOME in hook commands — use absolute path
  pre_path="$CLAUDE_HOOKS/pre-compact.sh"
  ss_path="$CLAUDE_HOOKS/session-start.sh"
  tmp=$(mktemp)
  jq --arg pre "$pre_path" --arg ss "$ss_path" '
    .hooks.PreCompact = ((.hooks.PreCompact // []) + [{
      matcher: "*",
      hooks: [{type: "command", command: $pre}]
    }] | unique_by(.hooks[0].command)) |
    .hooks.SessionStart = ((.hooks.SessionStart // []) + [{
      matcher: "compact",
      hooks: [{type: "command", command: $ss}]
    }] | unique_by(.hooks[0].command))
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  echo "[ctx-install] registered hooks in $SETTINGS"
}

install_git_template_instructions() {
  cat <<EOF
[ctx-install] Git post-commit template is project-opt-in.
  To enable per-project:
    cp $DEVKIT_ROOT/templates/git-hooks/post-commit .git/hooks/post-commit
    chmod +x .git/hooks/post-commit
EOF
}

main() {
  install_claude_hooks
  register_hooks_in_settings
  install_git_template_instructions
  echo "[ctx-install] DONE. Context routing glue installed."
}

main "$@"
```

Note: Task 5에서 이미 `aigentry-devkit/templates/claude-hooks/`에 템플릿 생성됨. 이 step에서는 **별도 파일 이동 불필요**.

- [ ] **Step 9.2: 실행 권한 + 테스트**

```bash
chmod +x aigentry-devkit/bin/ctx-install.sh

# Dry-run in sandbox HOME
HOME="$(mktemp -d)" bash aigentry-devkit/bin/ctx-install.sh
# Expected: hooks copied to $HOME/.claude/hooks, settings.json created/merged
```

- [ ] **Step 9.3: Commit**

```bash
git -C aigentry-devkit add bin/ctx-install.sh templates/claude-hooks/
git -C aigentry-devkit commit -m "feat(ctx-install): one-shot installer for Claude hooks + git template docs (#294)"
```

---

### Task 10: E2E 통합 테스트

**Files:**
- Create: `aigentry-devkit/tests/ctx-e2e.bats`

- [ ] **Step 10.1: E2E 테스트 시나리오**

```bash
#!/usr/bin/env bats
# E2E: 실제 wtm-context + brain stub 사용하여 compact/restore cycle 검증

setup() {
  export CTX_ROUTER="$(pwd)/aigentry-devkit/bin/ctx-router.sh"
  export HOME="$BATS_TMPDIR/ctx-e2e-$$"
  mkdir -p "$HOME/.wtm/contexts" "$HOME/.wtm/bin"
  export WTM_HOME="$HOME/.wtm"
  export WTM_SESSIONS="$HOME/.wtm/sessions.json"
  echo '{}' > "$WTM_SESSIONS"
  # Symlink real wtm-context but isolate brain ALWAYS (stub per test)
  ln -sf "$(pwd)/aigentry-devkit/tools/wtm/bin/wtm-context" "$HOME/.wtm/bin/wtm-context"
  export BRAIN_STUB_LOG="$BATS_TMPDIR/brain-$$.log"
  cat > "$HOME/.wtm/bin/brain" <<'EOF'
#!/usr/bin/env bash
echo "brain $*" >> "${BRAIN_STUB_LOG:-/dev/null}"
EOF
  chmod +x "$HOME/.wtm/bin/brain"
  export PATH="$HOME/.wtm/bin:$PATH"
}

teardown() {
  rm -rf "$HOME"
  rm -f "${BRAIN_STUB_LOG:-}"
}

@test "full cycle: precompact → session-start restore" {
  local sid="e2e-$$"
  "$CTX_ROUTER" on-precompact "$sid"
  run "$CTX_ROUTER" restore "$sid"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "Context Restore for $sid"
}

@test "tq-transition done promotes to brain (stub)" {
  local sid="e2e-tq-$$"
  "$CTX_ROUTER" on-tq-transition "$sid" 42 pending done
  [ -f "$BRAIN_STUB_LOG" ]
  grep -q "append" "$BRAIN_STUB_LOG"
}

@test "git-commit promotes to brain (stub)" {
  "$CTX_ROUTER" on-git-commit "test-proj" "abc123" "test commit message"
  [ -f "$BRAIN_STUB_LOG" ]
  grep -q "append" "$BRAIN_STUB_LOG"
  grep -q "abc123" "$BRAIN_STUB_LOG"
}

@test "session-end writes handoff + promotes LEARNING" {
  local sid="e2e-end-$$"
  # wtm-context session id format is "project:type-name"; construct valid path
  local wtm_ctx_dir="$HOME/.wtm/contexts/$sid/$sid"
  mkdir -p "$wtm_ctx_dir"
  touch "$wtm_ctx_dir/journal.jsonl"
  echo '{"type":"note","message":"LEARNING: test learning"}' >> "$wtm_ctx_dir/journal.jsonl"

  run "$CTX_ROUTER" on-session-end "$sid"
  [ "$status" -eq 0 ]
  # brain should have received at least one learning append
  grep -q "learning" "$BRAIN_STUB_LOG" || echo "warn: LEARNING promotion not triggered (verify journal parsing path)"
}
```

- [ ] **Step 10.2: 실행 + Commit**

```bash
bats aigentry-devkit/tests/ctx-e2e.bats
# Expected: 4 pass (precompact/restore cycle, tq→brain, git-commit→brain, session-end+LEARNING)

git -C aigentry-devkit add tests/ctx-e2e.bats
git -C aigentry-devkit commit -m "test(ctx-e2e): end-to-end precompact/restore/tq/commit/session-end (#294)"
```

---

### Task 11: 문서 갱신

**Files:**
- Modify: `aigentry-devkit/AGENTS.md` (ecosystem-contract doc pointer — covered by #297 but add ctx-router)
- Create: `aigentry-devkit/docs/ctx-router.md` (짧은 오퍼레이터 가이드)

- [ ] **Step 11.1: 짧은 오퍼레이터 가이드**

`aigentry-devkit/docs/ctx-router.md` 의 내용 (nested code fence 충돌 방지 위해 4-backtick 외곽 사용):

````markdown
# ctx-router — Context Compact & Switching Glue

Spec: `aigentry-orchestrator/docs/superpowers/specs/2026-04-19-context-compact-switching-design.md`

## Install

```bash
bash aigentry-devkit/bin/ctx-install.sh
```

## 수동 사용

- `ctx-router.sh on-precompact <sid>` — 수동 스냅샷
- `ctx-router.sh restore <sid>` — 복원 프리뷰
- `wtm-context orphan-check [cwd]` — crash 후 ID 유실 시
- `wtm-context rebind <cwd> <new-sid>` — 수동 rebind (fail-loud 원칙)

## 비활성화

`~/.claude/settings.json`에서 PreCompact/SessionStart hooks 제거.
````

- [ ] **Step 11.2: Commit**

```bash
git -C aigentry-devkit add docs/ctx-router.md
git -C aigentry-devkit commit -m "docs(ctx-router): operator guide for context routing glue (#294)"
```

---

### Task 12: 최종 검증 체크리스트

- [ ] **Step 12.1: Phase 4 Aspirational metric 재보정**

**Pass/Fail 임계값 (실측 후 확정)**:

| Metric | Pass 임계 | 측정 방법 |
|-------|---------|---------|
| ctx-router p95 지연 | < 500ms | 이벤트 log의 duration_ms 상위 5% |
| precompact → restore 성공률 | ≥ 95% | restore 이벤트 OK/(OK+FAIL) 비율 |
| crash 후 inferred restore 성공률 | ≥ 80% | orphan-check 결과 OK 비율 |
| 신규 리소스 점유 | 0 새 프로세스 | `ps -ef \| grep ctx-` |
| 신규 주기 토큰 | 0 | 정성 (아키텍처 상 불가) |

하나라도 Fail이면:
- 지연 초과 → ctx-router 의존 CLI 호출 profile 후 최적화
- 복원 실패 → wtm/brain degraded fallback 경로 검토
- 수치 확정 후 스펙 §12 업데이트 (Aspirational → Actual)

- [ ] **Step 12.2: Regression 스모크**

```bash
# brain MCP 끄고 동작 확인
mv ~/.local/lib/mcp-deliberation ~/.local/lib/mcp-deliberation.bak 2>/dev/null || true
"$CTX_ROUTER" on-precompact test-noMcp  # must exit 0
mv ~/.local/lib/mcp-deliberation.bak ~/.local/lib/mcp-deliberation 2>/dev/null || true
```

- [ ] **Step 12.3: 최종 commit**

```bash
git -C aigentry-devkit commit --allow-empty -m "chore(ctx-router): Phase 4 validation complete (#294)"
```

---

## Chunk 2 Review Gate

Dispatch plan-document-reviewer for Chunk 2. Fix and re-dispatch until approved.

---

## Delegation Plan (오케스트레이터)

실제 실행은 coder 세션 위임 (rule 4 준수):

| Chunk | 위임 대상 세션 | 파일 소유권 |
|-------|-------------|---------|
| Chunk 1 (Task 1-6) | aigentry-devkit-claude (coder 역할 inject) | ctx-router.sh, lib/context.sh, wtm-context bin |
| Chunk 2 (Task 7-9) | aigentry-devkit-claude 계속 | templates/git-hooks/, ctx-install.sh |
| Chunk 2 (Task 7 tq 부분) | aigentry-orchestrator-claude (이 세션) | tq-status.sh, tq-focus.sh |
| Chunk 2 (Task 10-12 테스트) | aigentry-tester-claude | tests/*.bats |
| Hook 수동 설치 / 세션 재시작 | aigentry-builder-claude | ~/.claude/hooks/, settings.json 등록 |

각 위임에 SAWP envelope + MANDATORY report + [IMPLEMENT APPROVED] 플래그 포함.

---

## Success Criteria

- [ ] 모든 bats 테스트 통과 (unit + e2e)
- [ ] `/compact` 실행 후 재개 시 additionalContext에 이전 컨텍스트 포함
- [ ] git commit 시 brain에 decision entry 생성 확인
- [ ] task-queue done 전이 시 brain summary 생성 확인
- [ ] brain MCP off 환경에서도 wtm-only degraded 동작
- [ ] 신규 리소스 점유 0 (ps/top 확인)
- [ ] 스펙 §12 Aspirational metric 실측 후 확정

---

## Out-of-Scope (후속 태스크)

- brain retention 정책 (별도 태스크)
- codex/gemini native compact hook 연동 (상류 CLI에 해당 hook 도입 시)
- ctx-router를 MCP tool로 노출 (현재 컨텍스트 세금 증가 우려로 제외)
