#!/usr/bin/env bash
# ADR-MF #6 — bash test scenarios for CLAUDE.md → layered migration.
# Hermetic: every test uses a fresh $AIGENTRY_HOME under mktemp -d.
set -euo pipefail

THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$THIS_DIR/../.." && pwd -P)"
INSTALLER="$REPO_ROOT/bin/install-instructions.sh"
SRC_COMMON="$REPO_ROOT/tooling/instructions/common.md"
SRC_ORCH="$REPO_ROOT/tooling/instructions/roles/orchestrator.md"
CLAUDE_MD="$REPO_ROOT/CLAUDE.md"

PASS=0
FAIL=0

check() {
  local name="$1"; shift
  if "$@"; then
    printf '  PASS  %s\n' "$name"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %s\n' "$name"
    FAIL=$((FAIL + 1))
  fi
}

# T1: post-migration CLAUDE.md size < 30 lines.
t1_size() { [ "$(wc -l < "$CLAUDE_MD")" -lt 30 ]; }
check "T1 CLAUDE.md <30 lines" t1_size

# T2: no role-heavy markers remain in CLAUDE.md.
t2_no_leak() {
  ! grep -qE 'telepty inject|session-layout|dustcraw 태스크|submit-retry' "$CLAUDE_MD"
}
check "T2 no role-heavy markers in CLAUDE.md" t2_no_leak

# T3: CLAUDE.md still references AGENTS.md + new layered files.
t3_pointers() {
  grep -q '@AGENTS.md' "$CLAUDE_MD" \
    && grep -q 'common.md' "$CLAUDE_MD" \
    && grep -q 'roles/orchestrator.md' "$CLAUDE_MD"
}
check "T3 stub keeps @AGENTS.md + layered pointers" t3_pointers

# T4: installer fresh-install creates orchestrator.md with §4.1 markers.
t4_fresh() {
  local home; home=$(mktemp -d)
  AIGENTRY_HOME="$home" "$INSTALLER" >/dev/null
  grep -q '^# Role: orchestrator' "$home/instructions/roles/orchestrator.md" \
    && grep -q 'Hard rule — no direct execution' "$home/instructions/roles/orchestrator.md" \
    && grep -q 'Rule 16' "$home/instructions/roles/orchestrator.md"
  local rc=$?
  rm -rf "$home"
  return $rc
}
check "T4 installer fresh-install creates orchestrator.md content" t4_fresh

# T5: installer is idempotent (second run reports 'exists file').
t5_idempotent() {
  local home; home=$(mktemp -d)
  AIGENTRY_HOME="$home" "$INSTALLER" >/dev/null
  local out
  out=$(AIGENTRY_HOME="$home" "$INSTALLER")
  echo "$out" | grep -q 'exists file : .*roles/orchestrator.md'
  local rc=$?
  rm -rf "$home"
  return $rc
}
check "T5 installer idempotent" t5_idempotent

# T6: installer --force overwrites existing files.
t6_force() {
  local home; home=$(mktemp -d)
  mkdir -p "$home/instructions/roles"
  printf 'SENTINEL\n' > "$home/instructions/roles/orchestrator.md"
  local out
  out=$(AIGENTRY_HOME="$home" "$INSTALLER" --force)
  local rc=0
  echo "$out" | grep -q 'updated file: .*roles/orchestrator.md' || rc=1
  grep -q 'SENTINEL' "$home/instructions/roles/orchestrator.md" && rc=1
  grep -q '^# Role: orchestrator' "$home/instructions/roles/orchestrator.md" || rc=1
  rm -rf "$home"
  return $rc
}
check "T6 installer --force overwrites" t6_force

# T7: no symlinks under installed instructions tree pointing back to CLAUDE.md.
t7_no_symlink() {
  local home; home=$(mktemp -d)
  AIGENTRY_HOME="$home" "$INSTALLER" >/dev/null
  local n
  n=$(find "$home/instructions" -type l 2>/dev/null | wc -l | tr -d ' ')
  rm -rf "$home"
  [ "$n" = "0" ]
}
check "T7 anti-leak: no symlinks in installed tree" t7_no_symlink

# T8: source files do not link back to CLAUDE.md / AGENTS.md.
t8_src_no_loopback() {
  ! grep -qiE '@AGENTS\.md|@CLAUDE\.md' "$SRC_COMMON" "$SRC_ORCH"
}
check "T8 anti-leak: src content has no @CLAUDE.md / @AGENTS.md autoload" t8_src_no_loopback

# T9: audit-completeness — installer creates all 9 role files + common.md.
t9_full_install() {
  local home; home=$(mktemp -d)
  AIGENTRY_HOME="$home" "$INSTALLER" >/dev/null
  local rc=0
  [ -f "$home/instructions/common.md" ] || rc=1
  for r in orchestrator architect coder tester builder analyst researcher reviewer logger; do
    [ -f "$home/instructions/roles/$r.md" ] || rc=1
  done
  rm -rf "$home"
  return $rc
}
check "T9 installer creates common.md + 9 role files" t9_full_install

# T10: byte-equivalence between repo src and installed dst for orchestrator + common.
t10_byte_equal() {
  local home; home=$(mktemp -d)
  AIGENTRY_HOME="$home" "$INSTALLER" >/dev/null
  local rc=0
  cmp -s "$SRC_COMMON" "$home/instructions/common.md" || rc=1
  cmp -s "$SRC_ORCH" "$home/instructions/roles/orchestrator.md" || rc=1
  rm -rf "$home"
  return $rc
}
check "T10 installed files byte-equal to repo src" t10_byte_equal

printf '\nmigration tests: %d pass / %d fail\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
