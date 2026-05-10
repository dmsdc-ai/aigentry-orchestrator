---
multi_exec:
  enabled: true
  coder_session: E22-coder-294
  cleanup_on_success: true
  preserve_on_error: true
---

# Multi-Exec Phase 1 MVP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** orchestrator가 plan 파일 입력하면 coder 세션에 SAWP 자동 dispatch + REPORT 자동 파싱 + chunk gate 자동 처리 + 이벤트 로그 독점 실행하는 bash runner (Phase 1만, review loop 없음).

**Architecture:** `devkit/bin/multi-exec.sh` — 단일 bash 스크립트. plan frontmatter 파싱 → task 순차 dispatch → REPORT line-based 파싱 → chunk gate 사용자 승인 대기 → 완료. telepty/wtm-context/ctx-router 재활용.

**Tech Stack:** bash 4+ (brew install bash on macOS), jq, telepty, wtm-context. lockfile via flock.

**Spec reference:** `docs/superpowers/specs/2026-04-19-multi-exec-automation-design.md`

---

## File Structure

| 파일 | 유형 | 역할 | 크기 |
|------|------|------|------|
| `aigentry-devkit/bin/multi-exec.sh` | create | 러너 메인 스크립트 | ~300 LOC |
| `aigentry-devkit/bin/multi-exec-lib.sh` | create | 파서/로깅 헬퍼 (source용 library) | ~150 LOC |
| `aigentry-devkit/tests/multi-exec.bats` | create | unit + integration tests | ~200 LOC |
| `aigentry-devkit/tests/fixtures/multi-exec/plan-mini.md` | create | 5-task mini plan fixture | ~60 LOC |
| `aigentry-devkit/tests/fixtures/multi-exec/report-*.txt` | create | REPORT 샘플 5-7개 (real 2026-04-19 데이터 + synthetic) | ~50 LOC |
| `aigentry-devkit/docs/multi-exec.md` | create | 오퍼레이터 가이드 | ~80 LOC |

**총 신규 ~840 LOC (production ~450 + tests/fixtures ~310 + docs 80).**

---

## Chunk 1: Core parser + library (Task 1-3)

### Task 1: 스켈레톤 + frontmatter parse

**Files:**
- Create: `aigentry-devkit/bin/multi-exec.sh`
- Create: `aigentry-devkit/bin/multi-exec-lib.sh`
- Create: `aigentry-devkit/tests/multi-exec.bats`

- [ ] **Step 1.1: 라이브러리 스켈레톤 (multi-exec-lib.sh)**

`aigentry-devkit/bin/multi-exec-lib.sh`:
```bash
#!/usr/bin/env bash
# multi-exec-lib.sh — shared library (source'd by multi-exec.sh and bats tests)
# Spec: docs/superpowers/specs/2026-04-19-multi-exec-automation-design.md

MULTI_EXEC_VERSION="0.1.0"

# parse_frontmatter(plan-file) → stdout: JSON object of multi_exec block, or empty
# Returns non-zero if no multi_exec block.
# IMPORTANT (Rule 17 + spec "no new deps"): awk + jq only. No python3/yaml/yq.
# Our frontmatter schema is narrow (flat keys + simple chunk_gates list), so
# we hand-parse the multi_exec: subtree with awk state machine.
parse_frontmatter() {
  local plan="$1"
  [[ -f "$plan" ]] || { echo "plan file not found: $plan" >&2; return 2; }

  # Phase 1: extract multi_exec: block lines between first --- pair.
  # Phase 2: convert the narrow YAML shape to JSON via awk.
  awk '
    BEGIN { in_fm=0; in_me=0; indent=-1 }
    /^---$/ {
      if (in_fm) { exit } else { in_fm=1; next }
    }
    in_fm && /^multi_exec:/ { in_me=1; next }
    in_me {
      # Determine multi_exec indent from first child line, stop when dedent.
      line=$0
      # leading spaces count
      n=0; while (substr(line, n+1, 1) == " ") n++
      if (indent == -1) indent = n
      if (n < indent) { in_me=0; next }
      sub(/^ +/, "", line)
      if (line == "" || line ~ /^#/) next
      print line
    }
  ' "$plan" | _me_lines_to_json || return 1
}

# _me_lines_to_json(stdin) — narrow YAML → JSON for our fixed schema.
# Accepts lines like:
#   enabled: true
#   coder_session: ID
#   chunk_gates:
#     - after_chunk: 1
#       type: user_approval
_me_lines_to_json() {
  awk '
    BEGIN { print "{" ; first=1; in_cg=0; cg_open=0 }
    function comma() { if (!first) printf ","; first=0 }
    /^chunk_gates:/ { comma(); printf "\"chunk_gates\":["; in_cg=1; cg_first=1; next }
    in_cg && /^- after_chunk:/ {
      if (!cg_first) printf ",";
      cg_first=0
      gsub(/^- after_chunk:[[:space:]]*/, "", $0)
      ac=$0
      printf "{\"after_chunk\":%s", ac
      cg_open=1
      next
    }
    in_cg && /^  type:/ {
      gsub(/^  type:[[:space:]]*/, "", $0)
      tp=$0
      printf ",\"type\":\"%s\"}", tp
      cg_open=0
      next
    }
    /^[a-zA-Z_]+:/ {
      split($0, a, /:[[:space:]]*/)
      k=a[1]; v=a[2]
      comma()
      # Preserve true/false/numbers as-is, quote others.
      if (v ~ /^(true|false|[0-9]+)$/)
        printf "\"%s\":%s", k, v
      else
        printf "\"%s\":\"%s\"", k, v
    }
    END { if (cg_open) printf "}"; if (in_cg) printf "]"; print "}" }
  ' | jq -c . 2>/dev/null || return 1
  # If the block had zero multi_exec keys, upstream returned empty; enforce non-empty.
}

# parse_tasks(plan-file) → stdout: lines of "chunk_n<TAB>task_n<TAB>task_line_start"
# Portable awk (works on BSD awk + gawk). No 3-arg match().
parse_tasks() {
  local plan="$1"
  awk '
    /^## Chunk [0-9]+:/ {
      sub(/^## Chunk /, "", $0); sub(/:.*$/, "", $0); chunk=$0; next
    }
    /^### Task [0-9]+:/ {
      line=$0
      sub(/^### Task /, "", line); sub(/:.*$/, "", line); task=line
      print chunk "\t" task "\t" NR
    }
  ' "$plan"
}
```

- [ ] **Step 1.2: 러너 메인 스켈레톤 (multi-exec.sh)**

`aigentry-devkit/bin/multi-exec.sh`:
```bash
#!/usr/bin/env bash
# multi-exec.sh — Plan-driven orchestration runner (Phase 1)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./multi-exec-lib.sh
source "$SCRIPT_DIR/multi-exec-lib.sh"

usage() {
  cat <<'EOF'
Usage: multi-exec.sh <plan-file> [--strict] [--auto-trust]

Orchestrator runner for plans with `multi_exec:` frontmatter.
Phase 1: linear dispatch + chunk gate + event log ownership. No review loop.

Options:
  --strict       Reject plans without multi_exec: frontmatter.
  --auto-trust   Auto-run trust-path.sh on first inject (security: default off).
EOF
}

main() {
  local plan="${1:-}"
  [[ -z "$plan" || "$plan" == "-h" || "$plan" == "--help" ]] && { usage; exit 1; }

  shift
  local strict=0 auto_trust=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --strict)     strict=1; shift;;
      --auto-trust) auto_trust=1; shift;;
      *) echo "unknown flag: $1" >&2; exit 2;;
    esac
  done

  local fm
  if ! fm=$(parse_frontmatter "$plan"); then
    if [[ $strict -eq 1 ]]; then
      echo "multi_exec frontmatter missing — rejected (--strict)" >&2
      exit 3
    fi
    echo "no multi_exec: frontmatter in $plan — no-op exit" >&2
    exit 0
  fi

  # TODO(Task 4): actual dispatch loop
  echo "parsed frontmatter OK: $fm"
  echo "(Task 4 will add dispatch loop)"
}

main "$@"
```

- [ ] **Step 1.3: bats 스켈레톤**

`aigentry-devkit/tests/multi-exec.bats`:
```bash
#!/usr/bin/env bats
# Tests for multi-exec.sh + multi-exec-lib.sh

setup() {
  ME_BIN="$BATS_TEST_DIRNAME/../bin/multi-exec.sh"
  ME_LIB="$BATS_TEST_DIRNAME/../bin/multi-exec-lib.sh"
  # shellcheck source=../bin/multi-exec-lib.sh
  source "$ME_LIB"
  FIXTURES="$BATS_TEST_DIRNAME/fixtures/multi-exec"
  # SANDBOX HOME so lock/pidfile tests don't clobber real orchestrator state
  export HOME="$BATS_TMPDIR/multi-exec-$$"
  mkdir -p "$HOME/.telepty/shared" "$HOME/.wtm/contexts/orchestrator"
}
teardown() {
  rm -rf "$HOME"
}

@test "version returns 0.1.0" {
  source "$ME_LIB"
  [ "$MULTI_EXEC_VERSION" = "0.1.0" ]
}

@test "missing plan arg → usage exit 1" {
  run "$ME_BIN"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "no frontmatter + default → no-op exit 0" {
  local tmp
  tmp=$(mktemp)
  echo "# plain plan" > "$tmp"
  run "$ME_BIN" "$tmp"
  [ "$status" -eq 0 ]
  rm "$tmp"
}

@test "no frontmatter + --strict → exit 3" {
  local tmp
  tmp=$(mktemp)
  echo "# plain plan" > "$tmp"
  run "$ME_BIN" "$tmp" --strict
  [ "$status" -eq 3 ]
  rm "$tmp"
}
```

- [ ] **Step 1.4: 실행 권한 + bats run**

```bash
chmod +x aigentry-devkit/bin/multi-exec.sh
bats aigentry-devkit/tests/multi-exec.bats
# Expected: 4 pass, 0 fail
```

- [ ] **Step 1.5: Commit**

```bash
git -C aigentry-devkit add bin/multi-exec.sh bin/multi-exec-lib.sh tests/multi-exec.bats
git -C aigentry-devkit commit -m "feat(multi-exec): skeleton + frontmatter parse + bats harness (#298 Phase 1)"
```

---

### Task 2: REPORT parser (strict key:value + legacy fallback)

**Files:**
- Modify: `aigentry-devkit/bin/multi-exec-lib.sh` (add parse_report)
- Modify: `aigentry-devkit/tests/multi-exec.bats` (add parse_report tests)
- Create: `aigentry-devkit/tests/fixtures/multi-exec/report-strict.txt`
- Create: `aigentry-devkit/tests/fixtures/multi-exec/report-legacy.txt`

- [ ] **Step 2.1: parse_report 구현**

Append to `multi-exec-lib.sh`:
```bash
# parse_report(stdin) → emits JSON to stdout
# Supports two grammars:
#   strict: one "key: value" per line (files/tests/commits/issues/next + Task N header)
#   legacy: "REPORT: Task N complete | files: ... | tests: ... | commits: ..."
parse_report() {
  local text; text="$(cat)"
  local task commit files tests issues next

  # Extract Task number (both grammars start with REPORT: Task N)
  task=$(echo "$text" | head -1 | grep -oE 'Task\s+[0-9]+' | head -1 | grep -oE '[0-9]+')
  [[ -z "$task" ]] && { echo '{"error":"no task number in REPORT"}'; return 1; }

  # Try strict first: each line "key: value"
  # Use awk with /regex/ match + sub() (portable on BSD + gawk). NOT -F with anchors.
  if echo "$text" | grep -qE '^(files|tests|commits|issues|next):'; then
    files=$(echo   "$text" | awk '/^files:/   {sub(/^files:[[:space:]]*/,"");   print; exit}')
    tests=$(echo   "$text" | awk '/^tests:/   {sub(/^tests:[[:space:]]*/,"");   print; exit}')
    commit=$(echo  "$text" | awk '/^commits?:/ {sub(/^commits?:[[:space:]]*/,""); print; exit}')
    issues=$(echo  "$text" | awk '/^issues:/  {sub(/^issues:[[:space:]]*/,"");  print; exit}')
    next=$(echo    "$text" | awk '/^next:/    {sub(/^next:[[:space:]]*/,"");    print; exit}')
  else
    # Legacy fallback: split by " | ". Use sed -E for portable ERE.
    files=$(echo   "$text" | grep -oE 'files: [^|]+'    | sed -E 's/^files: //')
    tests=$(echo   "$text" | grep -oE 'tests: [^|]+'    | sed -E 's/^tests: //')
    commit=$(echo  "$text" | grep -oE 'commits?: [^|]+' | sed -E 's/^commits?: //')
    issues=$(echo  "$text" | grep -oE 'issues: [^|]+'   | sed -E 's/^issues: //')
    next=$(echo    "$text" | grep -oE 'next: [^|]+'     | sed -E 's/^next: //')
  fi

  jq -n \
    --arg task  "$task" \
    --arg files  "${files:-}" \
    --arg tests  "${tests:-}" \
    --arg commit "${commit:-}" \
    --arg issues "${issues:-none}" \
    --arg next   "${next:-}" \
    '{task: ($task|tonumber), files: $files, tests: $tests, commit: $commit, issues: $issues, next: $next}'
}
```

- [ ] **Step 2.2: Fixture 파일**

`aigentry-devkit/tests/fixtures/multi-exec/report-strict.txt`:
```
REPORT: Task 4 complete
files: devkit/bin/ctx-router.sh, devkit/tests/ctx-router.bats
tests: 14/14
commits: 3325b5b
issues: none
next: Task 5
```

`aigentry-devkit/tests/fixtures/multi-exec/report-legacy.txt`:
```
REPORT: Task 4 complete | files: devkit/bin/ctx-router.sh, devkit/tests/ctx-router.bats | tests: 14/14 | commits: 3325b5b | issues: none | next: Task 5
```

- [ ] **Step 2.3: Tests**

Append to `multi-exec.bats`:
```bash
@test "parse_report strict → JSON with task=4" {
  run bash -c "source '$ME_LIB' && parse_report < '$FIXTURES/report-strict.txt'"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.task == 4 and .commit == "3325b5b"'
}

@test "parse_report legacy → JSON with task=4" {
  run bash -c "source '$ME_LIB' && parse_report < '$FIXTURES/report-legacy.txt'"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.task == 4 and .commit == "3325b5b"'
}

@test "parse_report missing task number → error" {
  run bash -c "source '$ME_LIB' && echo 'no task here' | parse_report"
  echo "$output" | jq -e '.error'
}
```

- [ ] **Step 2.4: Run + commit**

```bash
bats aigentry-devkit/tests/multi-exec.bats
# Expected: 7 pass

git -C aigentry-devkit add bin/multi-exec-lib.sh tests/multi-exec.bats tests/fixtures/multi-exec/
git -C aigentry-devkit commit -m "feat(multi-exec): parse_report strict+legacy + fixtures (#298)"
```

---

### Task 3: Lockfile + event emitter + pid mutex

**Files:**
- Modify: `aigentry-devkit/bin/multi-exec-lib.sh`
- Modify: `aigentry-devkit/tests/multi-exec.bats`

- [ ] **Step 3.1: Lockfile helpers**

Append to `multi-exec-lib.sh`:
```bash
LOCKFILE_PATH=""  # set per-plan
PIDFILE_PATH="$HOME/.wtm/contexts/orchestrator/multi-exec.pid"

acquire_lock() {
  local plan="$1"
  LOCKFILE_PATH="${plan}.multi-exec.lock"
  # Prefer flock (atomic + auto-release on exit).
  # NOTE: fd 9 is RESERVED by this library for the lockfile — scripts that
  # source multi-exec-lib.sh must not use fd 9 for other purposes.
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCKFILE_PATH" || return 1
    flock -n 9 || { echo "lock held by another runner: $LOCKFILE_PATH" >&2; return 1; }
    return 0
  fi
  # Fallback: atomic mkdir + pid + liveness
  local lockdir="${LOCKFILE_PATH}.d"
  if mkdir "$lockdir" 2>/dev/null; then
    echo $$ > "$lockdir/pid"
    return 0
  fi
  # Stale detect
  local holder
  holder=$(cat "$lockdir/pid" 2>/dev/null || echo 0)
  if ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$lockdir"
    mkdir "$lockdir" && echo $$ > "$lockdir/pid" && return 0
  fi
  echo "lock held by live pid $holder" >&2
  return 1
}

release_lock() {
  if [[ -n "$LOCKFILE_PATH" ]]; then
    if command -v flock >/dev/null 2>&1; then
      exec 9>&- 2>/dev/null || true
    else
      rm -rf "${LOCKFILE_PATH}.d" 2>/dev/null || true
    fi
  fi
}

# Pid mutex (orchestrator manual log skip)
acquire_pid_mutex() {
  mkdir -p "$(dirname "$PIDFILE_PATH")"
  if [[ -f "$PIDFILE_PATH" ]]; then
    local holder; holder=$(cat "$PIDFILE_PATH" 2>/dev/null || echo 0)
    if kill -0 "$holder" 2>/dev/null; then
      echo "another multi-exec running (pid $holder)" >&2; return 1
    fi
    rm -f "$PIDFILE_PATH"
  fi
  echo $$ > "$PIDFILE_PATH"
}
release_pid_mutex() { rm -f "$PIDFILE_PATH" 2>/dev/null || true; }

# Event emitter — always uses wtm-context log
emit_event() {
  local event="$1" meta="${2:-'{}'}"  # default explicit JSON empty object (avoid brace expansion)
  [[ -z "$meta" ]] && meta='{}'
  if command -v wtm-context >/dev/null 2>&1; then
    wtm-context log orchestrator exec-event "$event" "$meta" 2>/dev/null || true
  elif [[ -x "$HOME/.wtm/bin/wtm-context" ]]; then
    "$HOME/.wtm/bin/wtm-context" log orchestrator exec-event "$event" "$meta" 2>/dev/null || true
  fi
}
```

- [ ] **Step 3.2: Trap wiring in multi-exec.sh main**

Add near top of `main()` (after arg parsing, before frontmatter):
```bash
  acquire_pid_mutex || exit 4
  acquire_lock "$plan" || { release_pid_mutex; exit 5; }
  trap 'release_lock; release_pid_mutex' EXIT
```

- [ ] **Step 3.3: Tests**

Append to `multi-exec.bats`:
```bash
@test "acquire_lock creates lockfile + releases on exit" {
  local tmp_plan; tmp_plan=$(mktemp)
  echo "# plan" > "$tmp_plan"
  run bash -c "source '$ME_LIB' && acquire_lock '$tmp_plan' && release_lock"
  [ "$status" -eq 0 ]
  rm "$tmp_plan"
}

@test "acquire_pid_mutex refuses when pid file has live process" {
  # simulate live holder
  mkdir -p "$(dirname "$PIDFILE_PATH")" 2>/dev/null || true
  echo $$ > "$HOME/.wtm/contexts/orchestrator/multi-exec.pid"
  run bash -c "source '$ME_LIB' && acquire_pid_mutex"
  [ "$status" -ne 0 ]
  rm -f "$HOME/.wtm/contexts/orchestrator/multi-exec.pid"
}

@test "emit_event does not error when wtm-context absent" {
  run env PATH=/usr/bin:/bin bash -c "source '$ME_LIB' && emit_event dispatch '{\"task\":1}'"
  [ "$status" -eq 0 ]
}
```

- [ ] **Step 3.4: Run + commit**

```bash
bats aigentry-devkit/tests/multi-exec.bats
# Expected: 10 pass

git -C aigentry-devkit add bin/multi-exec-lib.sh bin/multi-exec.sh tests/multi-exec.bats
git -C aigentry-devkit commit -m "feat(multi-exec): flock+pid mutex + emit_event helper (#298)"
```

---

## Chunk 1 Review Gate

Dispatch plan-document-reviewer for Chunk 1. Fix and re-dispatch until approved.

---

## Chunk 2: Dispatch loop + chunk gate + docs (Task 4-7)

### Task 4: Main dispatch loop (Phase 1)

**Files:**
- Modify: `aigentry-devkit/bin/multi-exec.sh`
- Create: `aigentry-devkit/tests/fixtures/multi-exec/plan-mini.md`

- [ ] **Step 4.1: Mini plan fixture**

`aigentry-devkit/tests/fixtures/multi-exec/plan-mini.md`:
```markdown
---
multi_exec:
  enabled: true
  coder_session: MINI-coder-test
  reviewer: subagent
  max_fix_iterations: 5
  chunk_gates:
    - after_chunk: 1
      type: auto_approved
---

# Mini Plan

## Chunk 1: Smoke

### Task 1: echo hello
- [ ] step 1: `echo hello`

### Task 2: echo world
- [ ] step 1: `echo world`
```

- [ ] **Step 4.2: Dispatch loop**

Replace the TODO in `multi-exec.sh main()`:
```bash
  # After acquire_lock + parse_frontmatter
  local coder_session
  coder_session=$(echo "$fm" | jq -r '.coder_session // empty')
  [[ -z "$coder_session" ]] && { echo "multi_exec.coder_session required" >&2; exit 6; }

  emit_event "runner_start" "$(jq -n --arg plan "$plan" '{plan:$plan}')"

  # Iterate tasks
  local prev_chunk=0
  while IFS=$'\t' read -r chunk task line; do
    if [[ "$chunk" != "$prev_chunk" && "$prev_chunk" != 0 ]]; then
      handle_chunk_gate "$fm" "$prev_chunk"
    fi
    prev_chunk="$chunk"

    dispatch_task "$coder_session" "$plan" "$chunk" "$task" "$line" "$auto_trust"
    await_task_report "$coder_session" "$task"
  done < <(parse_tasks "$plan")

  emit_event "runner_end" "$(jq -n --arg plan "$plan" '{plan:$plan}')"
```

Add helper functions above main:
```bash
dispatch_task() {
  local sid="$1" plan="$2" chunk="$3" task="$4" line="$5" auto_trust="$6"
  emit_event "dispatch" "$(jq -n --argjson c "$chunk" --argjson t "$task" '{chunk:$c, task:$t}')"

  if [[ "$auto_trust" -eq 1 && -x "$SCRIPT_DIR/trust-path.sh" ]]; then
    echo "[multi-exec] --auto-trust enabled (informational)" >&2
  fi

  # FULL SAWP envelope per aigentry-orchestrator/AGENTS.md Rule 17 (embed verbatim).
  local sawp_block='[SAWP] After completing this task:
- Code + compile check (cargo check / swift build), do NOT run app (builder handles app execution)
- Do NOT run tests (tester handles tests)
- If compile error → fix immediately, do NOT report "ready for builder" with broken code
- If stuck after 3 attempts → report STUCK with full error
- Never idle — report immediately when done
- Evidence only — no "should work" or "probably fixed"
- Preserve ALL existing fixes in modified files (check file invariants before reporting)'

  local msg="[IMPLEMENT APPROVED] ${sawp_block}

Plan file: $plan. Execute Chunk $chunk Task $task (starts line $line). Follow plan verbatim. INVARIANTS per plan §INVARIANTS section. 

REPORT format (strict, key:value per line):
REPORT: Task $task complete
files: <comma-separated>
tests: <pass>/<total>
commits: <sha>
issues: <text or none>
next: <Task N+1 | AWAIT <gate>>

Send via: telepty inject --ref --from $sid aigentry-orchestrator

⚠️ MANDATORY: Do NOT idle after completing. Report IS required before orchestrator continues to next task."

  telepty inject --ref <(echo "$msg") --from aigentry-orchestrator "$sid" "" >&2
  telepty enter "$sid" >&2 || true
}

# Prefer event-driven wait (fswatch -1 blocking) over timed polling when available.
# Fallback sleep-poll only if fswatch absent. Keeps "no polling" spirit.
await_task_report() {
  local sid="$1" task="$2"
  local timeout="${MULTI_EXEC_TIMEOUT:-600}"
  local deadline=$(( $(date +%s) + timeout ))
  local shared_dir="$HOME/.telepty/shared"
  mkdir -p "$shared_dir"
  local seen_file; seen_file=$(mktemp)
  ls "$shared_dir"/*.md 2>/dev/null > "$seen_file" || true

  _find_new_ref() {
    # List by mtime (newest first) so the "newest" ref by modification time wins.
    local now_list; now_list=$(ls -t "$shared_dir"/*.md 2>/dev/null || true)
    # Compare to previously-seen (also mtime-ordered); emit any refs in now_list
    # not in seen_file, picking the most recently modified.
    diff <(echo "$now_list") "$seen_file" 2>/dev/null \
      | awk '/^< / {sub(/^< /, ""); print; exit}'  # exit on first = newest by mtime
  }

  while [[ $(date +%s) -lt $deadline ]]; do
    local newest
    if command -v fswatch >/dev/null 2>&1; then
      # Event-driven: block on filesystem change (up to remaining seconds).
      local remaining=$(( deadline - $(date +%s) ))
      [[ $remaining -le 0 ]] && break
      fswatch -1 --event Created --event Updated --latency 0.5 \
        --timeout "${remaining}000" "$shared_dir" >/dev/null 2>&1 || true
    else
      sleep 5
    fi
    newest=$(_find_new_ref)
    if [[ -n "$newest" && -f "$newest" ]]; then
      local rep; rep=$(parse_report < "$newest" 2>/dev/null || echo '{}')
      local rep_task; rep_task=$(echo "$rep" | jq -r '.task // empty' 2>/dev/null)
      if [[ "$rep_task" == "$task" ]]; then
        emit_event "impl_done" "$rep"
        emit_event "review_skipped" "$(jq -n --argjson t "$task" '{task:$t, reason:"phase1-no-reviewer-bridge"}')"
        rm -f "$seen_file"
        return 0
      fi
      ls "$shared_dir"/*.md 2>/dev/null > "$seen_file" || true
    fi
  done

  rm -f "$seen_file"
  emit_event "stuck" "$(jq -n --argjson t "$task" --arg r "timeout" '{task:$t, reason:$r}')"
  echo "TIMEOUT waiting for Task $task REPORT" >&2
  exit 7
}

handle_chunk_gate() {
  local fm="$1" chunk="$2"
  local gate_type; gate_type=$(echo "$fm" | jq -r --argjson c "$chunk" '.chunk_gates[] | select(.after_chunk == $c) | .type // empty')
  if [[ "$gate_type" == "auto_approved" || -z "$gate_type" ]]; then
    emit_event "chunk_complete" "$(jq -n --argjson c "$chunk" --arg g auto '{chunk:$c, gate:$g}')"
    return
  fi
  # user_approval: wait for orchestrator to inject "CHUNK N APPROVED"
  emit_event "chunk_gate_waiting" "$(jq -n --argjson c "$chunk" '{chunk:$c}')"
  echo "[multi-exec] Awaiting [CHUNK $chunk APPROVED] inject from orchestrator..." >&2
  # TODO(Task 5): implement actual user-inject wait (stub for now — auto-approve)
  emit_event "chunk_complete" "$(jq -n --argjson c "$chunk" --arg g user '{chunk:$c, gate:$g}')"
}
```

- [ ] **Step 4.3: Test (mock telepty)**

Append to `multi-exec.bats`:
```bash
@test "parse_tasks extracts 2 tasks from mini plan" {
  run bash -c "source '$ME_LIB' && parse_tasks '$FIXTURES/plan-mini.md'"
  [ "$status" -eq 0 ]
  # Expect 2 lines, each with chunk=1 task=1 or 2
  [ $(echo "$output" | wc -l) -eq 2 ]
}

@test "runner rejects plan missing coder_session" {
  local tmp; tmp=$(mktemp)
  cat > "$tmp" <<'EOF'
---
multi_exec:
  enabled: true
---
# plan
EOF
  run "$ME_BIN" "$tmp"
  [ "$status" -eq 6 ]
  rm "$tmp"
}
```

- [ ] **Step 4.4: Run + commit**

```bash
bats aigentry-devkit/tests/multi-exec.bats
# Expected: 12 pass

git -C aigentry-devkit add bin/multi-exec.sh tests/multi-exec.bats tests/fixtures/multi-exec/plan-mini.md
git -C aigentry-devkit commit -m "feat(multi-exec): main dispatch loop + await REPORT + chunk gate stub (#298)"
```

---

### Task 5: Chunk gate user_approval 실제 구현

**Files:**
- Modify: `aigentry-devkit/bin/multi-exec.sh`

- [ ] **Step 5.1: user_approval wait**

`handle_chunk_gate` 의 user_approval 분기를 실제 구현:
```bash
  if [[ "$gate_type" == "user_approval" ]]; then
    emit_event "chunk_gate_waiting" "$(jq -n --argjson c "$chunk" '{chunk:$c}')"
    echo "[multi-exec] Awaiting [CHUNK $chunk APPROVED] inject from orchestrator..." >&2
    local timeout=${MULTI_EXEC_GATE_TIMEOUT:-3600}
    local deadline=$(( $(date +%s) + timeout ))
    local shared_dir="$HOME/.telepty/shared"
    mkdir -p "$shared_dir"
    local seen; seen=$(mktemp); ls "$shared_dir"/*.md 2>/dev/null > "$seen" || true

    # Strict marker + sender check. Require BRACKETED `[CHUNK N APPROVED]`
    # AND the ref's first non-blank line to not contain "REPORT:" (so a coder
    # session reporting "CHUNK N APPROVED" accidentally won't match).
    while [[ $(date +%s) -lt $deadline ]]; do
      if command -v fswatch >/dev/null 2>&1; then
        local rem=$(( deadline - $(date +%s) )); [[ $rem -le 0 ]] && break
        fswatch -1 --event Created --latency 0.5 --timeout "${rem}000" "$shared_dir" >/dev/null 2>&1 || true
      else
        sleep 10
      fi
      local now_list; now_list=$(ls "$shared_dir"/*.md 2>/dev/null || true)
      local newrefs; newrefs=$(diff <(echo "$now_list") "$seen" 2>/dev/null | awk '/^< /{sub(/^< /,""); print}')
      for r in $newrefs; do
        [[ -f "$r" ]] || continue
        if grep -qE "^\s*\[CHUNK\s+$chunk\s+APPROVED\]" "$r" && ! grep -q '^REPORT:' "$r"; then
          rm -f "$seen"
          emit_event "chunk_approved" "$(jq -n --argjson c "$chunk" --arg ref "$r" '{chunk:$c, ref:$ref}')"
          emit_event "chunk_complete" "$(jq -n --argjson c "$chunk" --arg g user '{chunk:$c, gate:$g}')"
          return 0
        fi
      done
      echo "$now_list" > "$seen"
    done
    rm -f "$seen"
    echo "[multi-exec] gate TIMEOUT for chunk $chunk" >&2
    emit_event "stuck" "$(jq -n --argjson c "$chunk" --arg r gate-timeout '{chunk:$c, reason:$r}')"
    exit 8
  fi
```

- [ ] **Step 5.2: Test with simulated approval**

```bash
@test "gate user_approval detects [CHUNK N APPROVED] bracketed marker" {
  # Seed fake ref with BRACKETED approval text (must match strict regex)
  local ref_dir="$HOME/.telepty/shared"
  mkdir -p "$ref_dir"
  local ref="$ref_dir/fake-approval-$$.md"
  echo "[CHUNK 1 APPROVED] from user inject" > "$ref"
  MULTI_EXEC_GATE_TIMEOUT=5 run bash -c "source '$ME_LIB' && handle_chunk_gate '{\"chunk_gates\":[{\"after_chunk\":1,\"type\":\"user_approval\"}]}' 1"
  rm "$ref"
  [ "$status" -eq 0 ]
}

@test "gate user_approval ignores REPORT containing CHUNK N APPROVED text" {
  local ref_dir="$HOME/.telepty/shared"
  mkdir -p "$ref_dir"
  local ref="$ref_dir/fake-report-$$.md"
  # Ref starts with REPORT: — should be filtered out by `grep -q '^REPORT:'` exclusion
  cat > "$ref" <<'EOF'
REPORT: Task 1 complete
notes: CHUNK 1 APPROVED was mentioned in discussion but this is NOT approval
EOF
  MULTI_EXEC_GATE_TIMEOUT=3 run bash -c "source '$ME_LIB' && handle_chunk_gate '{\"chunk_gates\":[{\"after_chunk\":1,\"type\":\"user_approval\"}]}' 1"
  rm "$ref"
  [ "$status" -ne 0 ]  # timeout because REPORT filtered
}
```

- [ ] **Step 5.3: Run + commit**

```bash
bats aigentry-devkit/tests/multi-exec.bats
# Expected: 13 pass

git -C aigentry-devkit add bin/multi-exec.sh tests/multi-exec.bats
git -C aigentry-devkit commit -m "feat(multi-exec): user_approval chunk gate with ref polling (#298)"
```

---

### Task 6: Stale-lock recovery + --dry-run preview

**Files:**
- Modify: `aigentry-devkit/bin/multi-exec.sh`

- [ ] **Step 6.1: --dry-run 플래그**

Add to usage + flag loop:
```bash
  --dry-run) dry_run=1; shift;;
```

Before dispatch loop:
```bash
  if [[ "${dry_run:-0}" -eq 1 ]]; then
    echo "=== Plan dispatch preview ==="
    while IFS=$'\t' read -r chunk task line; do
      echo "chunk=$chunk task=$task line=$line"
    done < <(parse_tasks "$plan")
    echo "=== coder_session: $coder_session ==="
    echo "=== chunk_gates: $(echo "$fm" | jq -c '.chunk_gates // []') ==="
    exit 0
  fi
```

- [ ] **Step 6.2: Stale-lock test**

```bash
@test "acquire_lock removes stale pid dir (flock absent)" {
  local tmp_plan; tmp_plan=$(mktemp)
  echo "# plan" > "$tmp_plan"
  local lockdir="${tmp_plan}.multi-exec.lock.d"
  mkdir "$lockdir" && echo 999999 > "$lockdir/pid"  # non-existent pid
  # Force flock absence with PATH
  run env PATH=/usr/bin:/bin bash -c "source '$ME_LIB' && acquire_lock '$tmp_plan' && release_lock"
  # May fail if PATH has flock via builtin; treat as skip on flock-builtin
  rm -rf "$lockdir" "$tmp_plan"
  [ "$status" -eq 0 ] || skip "flock builtin or other lock mechanism"
}

@test "--dry-run prints preview + exits 0" {
  run "$ME_BIN" "$FIXTURES/plan-mini.md" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"dispatch preview"* ]]
}
```

- [ ] **Step 6.3: Run + commit**

```bash
bats aigentry-devkit/tests/multi-exec.bats
# Expected: 15 pass (±skip)

git -C aigentry-devkit add bin/multi-exec.sh tests/multi-exec.bats
git -C aigentry-devkit commit -m "feat(multi-exec): --dry-run (beyond spec §6.1, operator UX) + stale lock recovery (#298)"
```

**Note**: `--dry-run` is a Phase 1 operator UX addition beyond spec §6.1. Low cost (~15 LOC), high preview value. Documented in commit message and §14 dependencies acknowledge the scope.

---

### Task 7: Operator docs

**Files:**
- Create: `aigentry-devkit/docs/multi-exec.md`

- [ ] **Step 7.1: 가이드 작성**

`aigentry-devkit/docs/multi-exec.md`:
````markdown
# multi-exec — Plan-driven Orchestration Runner

Spec: `aigentry-orchestrator/docs/superpowers/specs/2026-04-19-multi-exec-automation-design.md`
Phase: 1 MVP (review loop deferred to Phase 2)

## 사용

```bash
~/projects/aigentry-devkit/bin/multi-exec.sh <plan-file> [--strict] [--auto-trust] [--dry-run]
```

## Plan 파일 frontmatter

```yaml
---
multi_exec:
  enabled: true
  coder_session: E22-coder-294
  reviewer: subagent    # Phase 1은 무시, 로그만
  max_fix_iterations: 5 # Phase 1은 무시, 로그만
  chunk_gates:
    - after_chunk: 1
      type: user_approval   # 또는 auto_approved
---
```

## Phase 1 동작

1. frontmatter 파싱 (없으면 no-op, `--strict`시 reject)
2. lockfile 취득 (동일 plan 2 러너 방지)
3. pid mutex (orchestrator 수동 로깅 억제)
4. Task 순차 dispatch → SAWP inject via telepty → REPORT 대기
5. chunk 경계에서 gate 처리 (user_approval/auto_approved)
6. runner_end 이벤트 emit + 락 해제

## 환경 변수

- `MULTI_EXEC_TIMEOUT` — task REPORT 대기 초 (default 600)
- `MULTI_EXEC_GATE_TIMEOUT` — chunk gate 대기 초 (default 3600)

## REPORT grammar (권장, strict)

```
REPORT: Task <N> complete
files: <comma-separated>
tests: <pass>/<total>
commits: <sha>
issues: <text or "none">
next: <Task N+1 | AWAIT <gate>>
```

Legacy `REPORT: Task N complete | files: ... | tests: ...` 도 파싱 지원.

## 종료 코드

- 0: 성공
- 1: usage
- 2: bad flag
- 3: --strict + frontmatter 부재
- 4: pid mutex 실패
- 5: lockfile 실패
- 6: coder_session 미지정
- 7: task REPORT 타임아웃
- 8: chunk gate 타임아웃

## 이벤트 로그

`~/.wtm/contexts/orchestrator/journal.jsonl` 에 다음 이벤트 emit:
- runner_start / runner_end
- dispatch / impl_done / review_skipped / stuck
- chunk_gate_waiting / chunk_approved / chunk_complete
````

- [ ] **Step 7.2: Commit**

```bash
git -C aigentry-devkit add docs/multi-exec.md
git -C aigentry-devkit commit -m "docs(multi-exec): operator guide for Phase 1 runner (#298)"
```

---

## Chunk 2 Review Gate

Dispatch plan-document-reviewer for Chunk 2.

---

## Delegation Plan (오케스트레이터)

| 작업 | 위임 | 파일 소유권 |
|------|------|------------|
| Chunk 1 Task 1-3 | E22-coder-294 (재사용) | devkit/bin/multi-exec*.sh, tests/multi-exec.bats |
| Chunk 2 Task 4-7 | E22-coder-294 계속 | 동일 + docs/multi-exec.md |
| 최종 E2E smoke (수동) | builder 또는 orchestrator | actual mini plan 실행 |

각 inject에 SAWP envelope + MANDATORY report + INVARIANT 포함.

---

## Success Criteria

- [ ] 15+ bats unit/integration 전부 pass
- [ ] shellcheck clean on multi-exec.sh + multi-exec-lib.sh
- [ ] `multi-exec.sh plan-mini.md --dry-run` 출력 검증
- [ ] 기존 plan 파일 (예: 2026-04-19-context-compact-switching.md) — frontmatter 없어도 no-op 동작
- [ ] 수동 E2E: 실제 coder 세션 + mini plan → 끝까지 통과 (Phase 1 manual gate)

---

## Out-of-Scope (Phase 2-4 별도 sprint)

- subagent reviewer 자동 호출 (Phase 2 orchestrator-bridge)
- fix loop 실효화 (Phase 2)
- metrics aggregator CLI (Phase 4)
- multi-parallel coder sessions (Phase 3)
- JSONL REPORT option (Phase 2)
