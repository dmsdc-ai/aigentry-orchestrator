# SPEC — Orchestrator Dispatch Health-Check & Auto Re-Dispatch

- Date: 2026-05-12 · Author session: `E-coder-dispatch-healthcheck` (coder)
- Trigger: Task #113. 7-track wave at 10:19–10:20 left 4 sessions
  (`mf-types`, `mf-prelude`, `mf-rule4`, `snyk`) stuck at the claude welcome
  for ~25 min with no REPORT. Operator surfaced the failure manually.
- Mandate: Rule 32 영구 fix · Scope: orch-side only (Rule 29) · No
  telepty/cmux changes · Article 17 stdlib only.
- Article 1 caps (post-§E): SPEC ≤ 300 lines, impl ≤ 500 LOC, tests ≤ 350.

## 0. Root causes (task #113)

1. No orch-side dispatch tracking → no timeout alarm.
2. `dispatch.sh` ready-probe misclassifies post-welcome `❯ Try "<hint>"`
   placeholder. Cause: `read-screen --lines 80` matches
   `Tips for getting started` that lingers in scrollback after the
   banner is dismissed → false timeout (no inject ever happens).
3. `dispatch.sh` dedup is ref-hash only — no inject-delivered check.
4. Wave operator used raw `telepty inject` for some legs (Rule 32).

## 1. Deliverables (A–E)

| ID | Artifact | Purpose |
|----|----------|---------|
| A  | `state/dispatch/active.json` + `bin/dispatch-tracker.sh` | Track each dispatch; alert on missed REPORT |
| B  | `bin/dispatch.sh` patch | Ready-detection fix + `--verify-delivered` flag |
| C  | `AGENTS.md` row strengthening | Codify dispatch.sh-only mandate (Rule 32) |
| D  | `tests/dispatch/*.sh` | 6+ scenario coverage |
| E  | `dispatch-tracker.sh` pull mode | Auto-detect work from `read-screen` + `git log`; emit `AUTO_REPORT` |

---

## 2. §A — Orchestrator-side tracking

### 2.1 State file: `state/dispatch/active.json`

JSON array. Per-entry fields:

```
sid, ref_hash, ref_path, dispatched_at, expected_report_by, last_seen_at,
status (in_flight|reported|stuck_welcome|stuck_error|auto_reported
        |re_dispatched|delivery_failed),
classification_history[{at, class}], cwd, from_sid, re_dispatch_count
```

Concurrency: `flock` via `python3 -c 'import fcntl; …'` (dispatch.sh +
tracker may write concurrently). Prune entries with
`status=reported AND last_seen_at > 24h ago` on every `check`.

### 2.2 `dispatch.sh` integration

After successful inject, append entry with `status=in_flight`,
`expected_report_by = dispatched_at + 30m`.

### 2.3 `bin/dispatch-tracker.sh` (new)

```
dispatch-tracker.sh check                # one-shot scan
dispatch-tracker.sh mark-reported <sid>  # orchestrator helper hook
dispatch-tracker.sh status [<sid>]       # human-readable view
dispatch-tracker.sh prune                # drop reported/stale entries
```

`check` per entry where `status ∈ {in_flight, re_dispatched}`:

1. If `now ≤ expected_report_by` → skip.
2. `telepty read-screen <sid> --lines 60` → `screen`.
3. Classify via §2.4. Append history; update `last_seen_at`.
4. Action by class:
   - `welcome` → status=`stuck_welcome`, alert. Re-dispatch gated to §5.4.
   - `error`   → status=`stuck_error`, alert. Never auto-retry.
   - `active`  → `expected_report_by += 15m`. No state change.
   - `done`    → keep `in_flight`; §E git poll may convert to auto-report.
5. Alerts: append to `state/dispatch/alerts.log` AND stdout.
6. read-screen error / DISCONNECTED → `class=unreachable`, no state
   change, alert logged.

### 2.4 Classification rules (last 60 lines; first match wins)

| Class | Detection |
|-------|-----------|
| `error`   | `(?i)error:|traceback|panic:|command not found|killed:|exited \d+` in last 20 lines |
| `welcome` | `Welcome back\|Tips for getting started\|Trust this folder\|Press Enter to continue` AND tail line is bare prompt or `❯ Try "..."` placeholder |
| `active`  | spinner glyphs `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` OR `(esc to interrupt)` OR token-counter `⏵ \d+s` |
| `done`    | tail prompt `❯`/`›` AND no spinner AND no error AND no welcome |

---

## 3. §B — `dispatch.sh` ready-detection patch

### 3.1 Bug

`is_ready()` greps `read-screen --lines 80` for welcome strings. After
dismiss, `Tips for getting started` lingers in scrollback for many
lines, so `grep -qE` keeps matching → `is_ready` never returns 0 →
`wait_for_ready` times out before inject.

### 3.2 Fix (claude / codex / gemini)

1. `screen = read-screen --lines 60`; `tail = last 20 non-empty lines`.
2. Welcome present ⟺ banner regex matches **tail only** (not full
   scrollback).
3. Prompt present ⟺ `tail` last 3 lines contain CLI prompt symbol as
   the leftmost printable char (a line that is otherwise the input box).
4. Placeholder allowed: `❯\s+Try "[^"]+"` ⇒ ready (key fix).
5. Ready ⟺ (prompt present) ∧ ¬(welcome in tail).

### 3.3 `--verify-delivered` (opt-in)

After inject, sleep 5 s, `read-screen --lines 30 → post`. If
`tail(post)` still matches `❯\s+Try ".*"` AND the first line of the
payload is absent → `DELIVERY_FAILED` (stderr + exit 5). Tracker
entry → `status=delivery_failed`. Omitting the flag keeps current
behavior (no extra reads, backwards compat).

### 3.4 Exit codes

`0` OK · `1` ready-timeout · `2` spawn failed · `3` inject failed ·
`4` usage · `5` delivery failed (new).

---

## 4. §C — `AGENTS.md` row

Replace the existing Rule-32 dispatch-helper row with strengthened text:

> - [ ] **dispatch helper 강제 (Rule 32 — HARD, 2026-05-12 후 revision)**:
>   세션 첫 dispatch뿐 아니라 **모든 wave dispatch**는 `bin/dispatch.sh
>   --target <sid> --ref <ref> [--verify-delivered]` 또는
>   `--spawn-and-dispatch` 경유. raw `telepty inject` (긴 ref 페이로드)
>   는 (a) 대화형 1라인 ack/follow-up, (b) `telepty send-key`,
>   (c) `telepty broadcast`로 한정. 위반 시 즉시 wave abort + #113 재현
>   리포트. telepty#18 daemon-side handshake land 후 본 row 완화 검토.

Cross-reference: insert pointer to `docs/specs/2026-05-12-dispatch-healthcheck.md`
beside the existing Rule-32 row pointer block.

---

## 5. §E — Pull-based REPORT auto-detect (SCOPE EXPANSION, ACK'd 2026-05-12)

ACK reasoning: today's wave proved push-only REPORT is unreliable
(4/7 sessions silent). Pull adds defense-in-depth; matches Rule 30
(operational autonomy — orchestrator self-recovers without escalating
to the user).

### 5.1 Trigger

Inside `dispatch-tracker.sh check`, for any entry whose
`last_seen_at` shows idle ≥ 5 min (no screen-content change between
two successive reads — diff via `sha256(screen)`) AND status is
`in_flight | re_dispatched`.

### 5.2 Decision tree

```
read-screen → class (§2.4)
  ├── welcome
  │     └── git_check (5.3) — usually no commit → re_dispatch (5.4)
  ├── error
  │     └── user_alert  (no auto-recovery)
  ├── active
  │     └── bump expected_report_by += 15m; do nothing
  └── done
        └── git_check (5.3)
              ├── new commit since dispatched_at → auto_report (5.5)
              └── no new commit                  → user_alert
```

### 5.3 Git polling

If `entry.cwd` exists AND `git -C "$cwd" rev-parse --git-dir` succeeds:

```
git -C "$cwd" log --since="$dispatched_at" \
    --pretty=format:'%H%x09%s%x09%an' HEAD
```

A "new commit" qualifies iff its author email matches
`git -C cwd config user.email`, OR the commit body contains a
`Co-Authored-By:` line that includes `Claude` (case-insensitive).
For non-git cwd, skip 5.3 and fall through to plain alert.

### 5.4 Re-dispatch policy

- Only `class=welcome` AND no new commits qualifies.
- Backoff: at most 1 auto re-dispatch per entry (`re_dispatch_count`
  field, capped at 1). Second consecutive `stuck_welcome` → user alert,
  no further auto-retry.
- Re-dispatch invokes `bin/dispatch.sh --target <sid> --ref <ref_path>
  --verify-delivered`. Tracker updates entry status to
  `re_dispatched`, resets `expected_report_by`.

### 5.5 Auto-generated REPORT (idempotent per `(sid, head_sha)`)

One JSON line per emission into `state/dispatch/auto-reports.log`:

```
{kind:"AUTO_REPORT", sid, emitted_at, head_sha, files_changed,
 loc_added, loc_removed, test_signal, review_required:true}
```

- LOC: parse `git diff --shortstat <pre_sha>..HEAD` in Python
  (Article 17 — no `tokei`).
- `test_signal`: regex match on screen tail for `passed|failed|FAIL|ok N tests`.
- After emit: `status=auto_reported`. Tracker also injects a single line
  to the orchestrator session (`AUTO_REPORT sid=... sha=... — review
  required`) so operator surfaces it. **Does NOT mark `reported`** —
  only an explicit push REPORT (`mark-reported`) does.

### 5.6 Idempotency

- `state/dispatch/auto-reports.seen` — one `(sid, head_sha)` per line.
- Re-dispatch cap = 1 (`re_dispatch_count` on entry).
- Same `flock` as §2.1 → re-entrant safe.

---

## 6. §D — Test plan

`bash -euo pipefail`. Fake `telepty` / `git` via PATH-shadowed stubs
reading fixtures under `tests/dispatch/fixtures/`. Python stdlib only.

| # | Test | Subject | Pass condition |
|---|------|---------|----------------|
| T1 | `tracker_check_welcome.sh`    | §A/§2.4 welcome classification on fixture screen     | exit 0, alert log contains `STUCK_WELCOME` |
| T2 | `tracker_check_error.sh`      | §A/§2.4 error classification                          | alert log contains `STUCK_ERROR` |
| T3 | `tracker_check_active.sh`     | §A/§2.4 active path bumps expected_report_by          | active entry's `expected_report_by` increased by 15m |
| T4 | `dispatch_ready_postwelcome.sh` | §B/3.2 placeholder accepted                         | `is_ready` returns 0 on fixture w/ `❯ Try "..."` |
| T5 | `dispatch_ready_scrollback.sh` | §B/3.2 stale welcome in scrollback ignored          | `is_ready` returns 0 when only old `Tips` in scrollback |
| T6 | `dispatch_verify_delivered_ok.sh`   | §B/3.3 happy path                              | exit 0, no `DELIVERY_FAILED` line |
| T7 | `dispatch_verify_delivered_fail.sh` | §B/3.3 placeholder untouched after inject      | exit 5, stderr contains `DELIVERY_FAILED` |
| T8 | `tracker_pull_auto_report.sh` | §E/5.5 new-commit-no-REPORT path                      | one JSON line in `auto-reports.log`, status `auto_reported` |
| T9 | `tracker_pull_re_dispatch.sh` | §E/5.4 welcome+no-commit → re-dispatch + cap          | re_dispatch_count=1 after first run; 2nd run skips |
| T10 | `tracker_pull_idempotent.sh` | §E/5.6 re-running with same head_sha is no-op        | `auto-reports.log` length unchanged on 2nd run |

Fixtures ≤ 30 lines each. Tests + harness `tests/dispatch/lib.sh` ≤ 350 LOC.

---

## 7. LOC estimate

| Artifact | LOC |
|----------|-----|
| `bin/dispatch-tracker.sh` (incl. §E) | ≈ 320 |
| `bin/dispatch.sh` patch | ≈ 70 |
| `AGENTS.md` row edit | ≈ 10 |
| state seed files | ≈ 2 |
| **Impl total** | **≈ 402** (cap 500) |
| Tests (T1–T10 + harness + fixtures) | ≈ 320 (cap 350) |

---

## 8. Approved decisions (orchestrator, 2026-05-12)

1. **Re-dispatch cap = 1**, then user gate. Rule 30 autonomy first
   attempt; Rule 6 safety after.
2. **Git author filter (§5.3)** — match `git -C cwd config user.email`
   OR a `Co-Authored-By: Claude` line in the commit body. Precision
   over recall (false-negative auto-REPORT acceptable; false-positive
   duplicate REPORT is not).
3. **AUTO_REPORT push** = both channels: file-log (audit) + single
   `telepty inject orchestrator ...` line prefixed `AUTO_REPORT`.
4. **§2.4 `active` fallback** — braille glyphs primary; text
   substring fallback on `thinking with xhigh effort` or
   `esc to interrupt`.
5. **DISCONNECTED** entries — skip `check` loop; append to
   `state/dispatch/disconnected.log` (audit only, no re-dispatch).
   telepty#17 fix lands separately.

## 9. Out of scope

telepty / cmux modifications (Rule 29; deferred to telepty#17, #18);
Windows (Article 2 — WSL fallback handled separately); deliberation
MCP path; wave-level scheduling/queue rework.

## 10. References

`docs/rules.md` Rule 29/30/32 · CONSTITUTION Article 1/2/17 ·
`bin/dispatch.sh` · `bin/session-cleanup.sh` · telepty#17/#18 ·
Task #113.
