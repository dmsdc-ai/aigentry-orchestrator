#!/usr/bin/env bash
# PostToolUse/Bash hook — Rule 33 (위임 후 세션 시작 검증) reminder.
#
# Emits a verify reminder ONLY when the just-run Bash command was a task-bearing
# dispatch/inject. Silent otherwise (no noise on ordinary bash). Excludes the
# verify call itself and the allowed raw-telepty exceptions (send-key/broadcast).
#
# Reads PostToolUse hook JSON on stdin; reminder text goes to stdout (surfaced
# to the orchestrator as additional context).
input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | python3 -c 'import json,sys
try:
    print((json.load(sys.stdin).get("tool_input") or {}).get("command",""))
except Exception:
    pass' 2>/dev/null || true)

case "$cmd" in
  *dispatch-verify.sh*) exit 0 ;;          # the verify itself — no reminder
  *"send-key"*|*broadcast*) exit 0 ;;       # allowed raw-telepty exceptions (Rule 33 scope-out)
esac

if printf '%s' "$cmd" | grep -qE 'dispatch\.sh|telepty[[:space:]]+inject'; then
  if printf '%s' "$cmd" | grep -q 'dispatch\.sh'; then
    echo 'RULE 33 (위임 후 검증): dispatch.sh는 auto-verify(default ON) — 위 출력에서 VERIFIED/SUSPECT 판정을 반드시 읽어라. SUSPECT면 surface 해소(read-screen / modal 응답 / thinking-block #502는 즉시 respawn) 전 "워커 진행 중" 발화 금지.'
  else
    echo 'RULE 33 (위임 후 검증): raw telepty inject로 task 위임함 → 수동으로 `bin/dispatch-verify.sh <sid>` 호출해 started-working(CONNECTED+ready+clean+moving) 검증하라. garbled 화면+plan echo만 보고 started 판단 금지(추측=Rule 22/25 위반).'
  fi
fi
exit 0
