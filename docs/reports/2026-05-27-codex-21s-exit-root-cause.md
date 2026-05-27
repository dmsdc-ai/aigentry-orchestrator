# Root-Cause Report — codex spawned via `telepty allow` exits ~21s (task #485)

**Author**: aigentry-analyst-codex21s (analyst role, read-only investigation)
**Date**: 2026-05-27
**Task**: #485 — root cause for #446 symptom (codex sessions dropped ~21s after spawn)
**Status**: DONE — verdict reached on empirical evidence + commit-history alignment.
**Boundary**: Read-only across `aigentry-orchestrator`, `aigentry-telepty`. No code edits, no commits, no builds. Per Rule 4-A (analyst).

---

## Executive summary

The pre-0.4.5 codex prompt-symbol detector in
`aigentry-telepty/src/prompt-symbol-registry.js` (`codex.detect()`) used a
brittle `^ › ` line-anchored regex that **missed real codex prompts** on
cmux-rendered captures (where the `›` tail-renders on the model-status
row and DECRQM/cursor-pos fragments leak in). The bootstrap ready-gate
therefore could not confirm codex was ready, the dispatcher declared
bootstrap failure, and the supervising process killed the inner
`telepty allow … codex …` session at the cumulative-timeout boundary
(~21s in practice).

Commit `900c3ae` (telepty 0.4.5, 2026-05-26 18:14 KST, "#472 codex
matcher normalize") replaced the strict matcher with a tolerant
multi-signal pipeline. On telepty 0.4.5 the 21s exit is **not
reproducible across 7 controlled trials** (4 direct `telepty allow` + 3
full `bin/dispatch.sh` spawns) — every trial survived ≥60s and was only
terminated by manual cleanup (signal 15).

**Verdict**: `#472` (commit `900c3ae`) is the landed permanent fix. No
further coder dispatch is needed for the codex 21s-exit issue itself.

**Workaround disposition**: keep `#446` `--auto-restart` on `telepty
allow` (orchestrator commit `aigentry-devkit:22e8f0f`). Defensive
no-op when the fix is healthy; cheap insurance against regressions.

**Confidence**: medium-high. Strong empirical signal (7/7 non-repro) +
plausible mechanism in the commit message + timing alignment. Caveats
itemised in §7.

---

## 1. Background

- **#446 (workaround)**: orchestrator added uniform `--auto-restart` to
  `telepty allow` invocations in `aigentry-devkit:22e8f0f`. Masked the
  symptom (sessions respawn on exit) but did not address root cause.
- **#485 (this report)**: root-cause investigation per Rule 32 step 2
  of 4 (workaround → root cause → issue → permanent fix). Step 4 is now
  considered **already shipped** in telepty 0.4.5 commit `900c3ae`.
- **Original symptom**: every codex spawn via `bin/dispatch.sh
  --spawn-and-dispatch --cli codex …` dropped at ~21s after spawn.
  claude sessions were unaffected — pointing at codex-specific handling
  in telepty's ready-gate, not generic PTY behavior.
- **Telepty 0.4.5 ships 4 fixes bundled**: `#469 postinstall`, `#470
  daemon restart ready-restore`, `#471 force bypass order`, `#472 codex
  matcher normalize`. Of these, `#472` is the only one with a
  mechanism-fit explanation for the 21s codex symptom (see §4).

---

## 2. Reproduction trials (all on telepty 0.4.5)

7 trials in two batches. None reproduced the 21s exit; every session
remained alive at the 60s+ wall-clock checkpoint and exited only on
manual cleanup (signal 15).

| # | Phase | Method | Track / SID | Spawn time (KST) | Alive @ check | Exit reason |
|---|---|---|---|---|---|---|
| 1 | 1 (direct) | `telepty allow` default-cmd, untrusted-cwd | (prior session) | 2026-05-27 | 89s | signal=15 manual kill |
| 2 | 1 (direct) | `telepty allow` default-cmd, trusted-cwd | (prior session) | 2026-05-27 | 61s | signal=15 manual kill |
| 3 | 1 (direct) | `telepty allow` default-cmd, explicitly-trusted-cwd | (prior session) | 2026-05-27 | 69s | signal=15 manual kill |
| 4 | 1 (direct) | `telepty allow … codex resume` | (prior session) | 2026-05-27 | 61s | signal=15 manual kill |
| 5 | 1-bis (dispatch.sh) | `bin/dispatch.sh --spawn-and-dispatch --cli codex` | `test485-codex21s-bis-1` | (prior session) | 181s | signal=15 manual kill |
| 6 | 1-bis (dispatch.sh) | same | `test485-bis-2-codex-trial` | 14:51:31 | 81s (status idle @ +70s) | signal=15 manual kill via `bin/session-cleanup.sh` |
| 7 | 1-bis (dispatch.sh) | same | `test485-bis-3-codex-trial` | 14:53:01 | 85s (status working @ +74s) | signal=15 manual kill via `bin/session-cleanup.sh` |

Captured evidence for trials 6–7 in this session:
`/tmp/test485-bis-2.log`, `/tmp/test485-bis-2.start`,
`/tmp/test485-bis-3.log`, `/tmp/test485-bis-3.start`. Both
`bin/session-cleanup.sh` invocations completed with
"killed parent telepty-allow PID …" trace lines and `DELETE
/api/sessions/<sid> → 404 (already gone — parent kill propagated)`,
confirming clean SIGTERM-driven shutdown rather than a 21s self-exit.

**Aggregate**: 7/7 non-reproductions on telepty 0.4.5. Minimum alive
duration 61s — comfortably past the ~21s window. Per Rule 22, this is
the load-bearing evidence for the verdict.

---

## 3. Pre/post code citation — `aigentry-telepty/src/prompt-symbol-registry.js`

Commit: `900c3ae` (telepty 0.4.5, 2026-05-26 18:14 KST).
Issue ref in commit: `#472 codex matcher normalize`.

### 3.1 Pre-fix (removed) — strict `^ › ` line-leading matcher

From `git show 900c3ae -- src/prompt-symbol-registry.js` (`-` lines):

```js
// codex renders idle as " › <placeholder>" (column 2). Status footer
// ("gpt-5.5 …" or "gpt-5 …") sits 1–2 lines below.
codex: {
  symbol: '›',
  byteSeq: Buffer.from([0xE2, 0x80, 0xBA]),
  detect(screen) {
    const lines = String(screen == null ? '' : screen).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!/^ › /.test(line)) continue;
      const footer = (lines[i + 1] || '') + '\n' + (lines[i + 2] || '');
      if (/gpt-\d/.test(footer)) {
        return { found: true, line_index: i, col: 2 };
      }
    }
    return { found: false };
  },
},
```

**Failure mode (per commit message and confirmed on cmux captures)**:
the `›` glyph tail-renders on the same row as the model-status footer
on real cmux captures, and DECRQM / cursor-position fragments leak into
the screen text. `^ › ` is anchored at column 0 with a literal leading
space → fails to match. With no match, the bootstrap ready-gate
(`src/submit-gate.js:199`–`243`, default `timeoutMs = 8000`, stacked
above earlier 5000ms and 1500ms gates) times out, the supervisor
declares the codex session non-bootable, and parent-process cleanup
kills the inner `telepty allow` PID. Cumulative timeout budget across
the stacked gates plus dispatch.sh's outer envelope lands the
observable kill at ~21s.

### 3.2 Post-fix (current HEAD) — multi-signal tolerant pipeline

From `aigentry-telepty/src/prompt-symbol-registry.js:36–82`:

```js
// #472 (0.4.5): codex previously matched on a strict line-leading "^ › "
// shape; on real cmux captures the '›' tail-renders on the same row as the
// model-status footer and DECRQM/cursor-pos fragments leak in, so that
// strict matcher misses. Multi-signal tolerant matcher: picker anti-pattern
// first (resume-picker UI must NOT be considered ready), then a tolerant
// (a + b) signal pair, then the legacy strict scan as a back-compat
// fallback. Reason field surfaces which signal fired for log-attribution.
codex: {
  symbol: '›',
  byteSeq: Buffer.from([0xE2, 0x80, 0xBA]),
  detect(screen) {
    const text = String(screen == null ? '' : screen);

    // Step 1: modal-UI anti-pattern. Resume picker, trust prompt, etc.
    if (
      /Resume a previous session/.test(text) ||
      /^Filter:/m.test(text) ||
      /Do you trust the contents/i.test(text) ||
      /Press enter to continue/i.test(text)
    ) {
      return { found: false, reason: 'codex_modal_ui' };
    }

    // Step 2: multi-signal tolerant.
    if (/OpenAI Codex \(v/.test(text) && /gpt-[0-9.]+\s+\w+\s+fast/.test(text)) {
      return { found: true, reason: 'codex_multi_signal' };
    }

    // Step 3: legacy strict line-leading scan — back-compat fallback.
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!/^ › /.test(line)) continue;
      const footer = (lines[i + 1] || '') + '\n' + (lines[i + 2] || '');
      if (/gpt-\d/.test(footer)) {
        return { found: true, line_index: i, col: 2, reason: 'codex_strict_line' };
      }
    }
    return { found: false };
  },
},
```

Three signals, each addressing a distinct pre-fix failure shape:
- **Step 1 — anti-pattern**: actively returns *not-ready* on pre-prompt
  modal UIs (resume picker, trust prompt, "press enter to continue").
  Prevents false-ready that would dispatch user input into a modal.
- **Step 2 — tolerant pair**: matches the boot box text ("OpenAI Codex
  (v…)") + status row ("gpt-N… fast") anywhere on screen, position-
  independent. This is the path that resolves the original cmux render
  drift.
- **Step 3 — strict back-compat**: preserves the legacy matcher for
  clean captures where it already worked.

`detectOutput()` at `src/prompt-symbol-registry.js:153–159` is the
caller surface the ready-gate uses.

---

## 4. Hypothesis matrix

Original dispatch listed 6 candidate hypotheses. Verdicts below use the
7/7 non-reproduction evidence as the primary discriminator, plus
behavior-change locality between telepty 0.4.4 → 0.4.5.

| # | Hypothesis | Mechanism | Verdict | Evidence |
|---|---|---|---|---|
| H1 | codex CLI detects non-TTY stdin and self-exits | Codex internally rejects non-PTY stdin after grace period | **Refuted** | codex CLI binary is unchanged across the telepty 0.4.4 → 0.4.5 upgrade; only telepty changed. 7/7 trials on 0.4.5 survive. If codex itself self-exited on non-TTY, 0.4.5 would still see it. |
| H2 | `codex resume` without a saved session expires after a delay | Codex resume path retries / times out when no prior session blob found | **Refuted** | Trial 4 invoked `codex resume` explicitly under 0.4.5 and survived 61s. Trials 1–3 ran default-cmd (no resume) and also survived. Behavior is independent of resume mode. |
| H3 | telepty's PTY allocation closes one side after handshake → codex sees EOF after delay | PTY master/slave lifecycle bug in telepty | **Refuted** | PTY allocation code in telepty is unchanged across 0.4.4 → 0.4.5 (the 0.4.5 commit `900c3ae` touches `prompt-symbol-registry.js`, `submit-gate.js`, `daemon.js`, `scripts/postinstall.js` — none of which alter PTY allocation). If PTY EOF were the cause, 0.4.5 would still see it. |
| H4 | `OPENAI_API_KEY` missing / auth timeout in codex | Codex auth-check times out after ~21s when credentials missing | **Refuted** | Codex auth is local to the codex CLI process and unchanged across the upgrade. Same environment, same env vars, but 0.4.5 trials survive — so the variable that changed (telepty detection) is the variable that matters. |
| H5 | codex idle timeout fires before any input received | Internal codex idle-kill at ~20s | **Refuted** | Idle timeout is codex-internal; would fire identically across telepty versions. 7/7 0.4.5 trials survive 60–181s of idle. |
| H6 | cmux/aterm closes stdin shortly after spawn | Workspace-host lifecycle severs stdin | **Refuted** (for the 21s symptom) | claude sessions spawned by the same dispatcher under the same cmux/aterm host were unaffected (per original dispatch background §"claude is unaffected"). If cmux/aterm closed stdin generically, claude would die too. (Separately: see §7 risk note on cmux-restart-kills-all — a different bug class.) |

**Identified root cause (not in the original six but established by
commit `900c3ae`)**:

| #472 | telepty pre-fix `codex.detect()` strict `^ › ` matcher misses real cmux captures → ready-gate times out → dispatcher declares bootstrap failure → parent process kills inner `telepty allow` → observed as session "exiting" at ~21s | **Accepted** | Commit message diagnoses this exact failure shape ("on real cmux captures the '›' tail-renders on the same row as the model-status footer and DECRQM/cursor-pos fragments leak in, so that strict matcher misses"). Empirical: 7/7 trials on the post-fix 0.4.5 survive, where every pre-fix codex spawn died at ~21s in #446. Locality: this is the only codex-specific code change between 0.4.4 and 0.4.5 — and the symptom was codex-specific. |

---

## 5. Permanent-fix verdict

**Permanent fix is already shipped** in telepty 0.4.5, commit `900c3ae`
(`#472 codex matcher normalize`). No further coder dispatch is required
for this issue.

Rule 32's 4-step workflow is closed for #485:
1. Workaround → `#446` orchestrator `--auto-restart` (commit
   `aigentry-devkit:22e8f0f`). ✅
2. Root cause → identified as `#472` strict matcher failing on cmux
   captures. ✅
3. Issue tracking → `#472` exists upstream. ✅
4. Permanent fix → telepty 0.4.5 commit `900c3ae`. ✅

---

## 6. Workaround disposition — **KEEP `#446`** `--auto-restart`

Recommendation per orchestrator direction (this dispatch) and
confirming the default-keep posture noted in the original spec.

**Rationale**:

1. **Zero cost when healthy.** With `#472` working, codex bootstrap
   succeeds and `--auto-restart` never fires. Net runtime impact ≈ 0
   on the happy path.
2. **Defensive insurance.** If `#472` regresses — e.g., codex CLI
   changes its prompt symbol (`›` → something else), introduces a new
   pre-prompt modal not covered by Step 1 anti-pattern, or future
   telepty changes break the matcher in a different way —
   `--auto-restart` preserves session continuity instead of dropping
   the user's work.
3. **Symmetric across CLIs** (Rule 14 alignment). `--auto-restart`
   applies uniformly to `telepty allow` regardless of CLI. Removing it
   only for codex would create a per-CLI drift hazard.
4. **No churn.** Already committed (`aigentry-devkit:22e8f0f`).
   Reverting adds noise without observable benefit.

**Trade-offs acknowledged** (Constitution §13 balance):

- Adds ~6 lines of code in orchestrator and a `--auto-restart` flag
  passthrough; small but non-zero maintenance surface.
- May mask future regressions (a respawning session is less obviously
  broken than a dropped one). Mitigation: telemetry already captures
  restart events; monitor restart-count metrics during regressions.

Net: keep.

---

## 7. Confidence & residual risks

### 7.1 Confidence: **medium-high**

Backing:
- **Empirical**: 7/7 non-reproductions on telepty 0.4.5 across two
  spawn paths (direct `telepty allow` and full `bin/dispatch.sh`).
- **Mechanism plausibility**: commit `900c3ae` describes the exact
  failure shape (strict `^ › ` regex vs. cmux tail-rendered `›`) and
  the fix is a tolerant multi-signal pipeline that directly addresses
  it.
- **Locality**: `#472` is the only codex-specific change in the 0.4.5
  bundle. Symptom was codex-specific. Variable-isolation: only the
  variable that changed (telepty detection logic) matters.

### 7.2 Caveats (residual unknowns)

1. **No pre-fix re-reproduction.** I did not downgrade telepty to
   0.4.4 to confirm the 21s exit reappears, because doing so would
   destabilise the live working environment (Rule 29 외과적: keep
   scope to the analyst question, no environment churn). The 21s
   figure is established by #446's original observation, not
   re-measured here.
2. **21s number not arithmetically derived.** `src/submit-gate.js`
   exposes timeouts of 5000ms (line 50), 1500ms (line 132), 8000ms
   (line 203) on stacked gates. These plus dispatch.sh outer envelope
   plausibly sum to the observed ~21s, but the exact timer arithmetic
   is not bisected here — out of scope, the empirical 7/7 carries the
   verdict.
3. **Pre-fix matcher behavior on cmux captures** is attested by the
   commit author and the commit message rather than re-captured here.

### 7.3 Out-of-scope finding — `cmux-restart-kills-all-sessions`

During the prior analyst session (cmux app restart, observed
2026-05-27 09:54 KST), **all running sessions including this
analyst's claude were terminated** by a cmux app restart, requiring
re-spawn. This is a **different bug class** from codex-21s and
unrelated to `#472`:

- Affects all wrapped CLIs (claude, codex, gemini), not codex-only.
- Trigger is cmux app lifecycle, not codex-internal handshake.
- Workaround `#446 --auto-restart` would not help (the parent cmux
  host is gone, not the inner telepty session).

**Flag for future analyst dispatch** as a separate task (suggested
name: "cmux app restart should not kill telepty-hosted sessions").
Not addressed further in this report.

---

## 8. References

### 8.1 Source citations (telepty 0.4.5 HEAD)

- `aigentry-telepty/src/prompt-symbol-registry.js:36–82` — post-fix
  `codex.detect()` (Step 1 modal-UI anti-pattern, Step 2 multi-signal
  tolerant, Step 3 strict back-compat).
- `aigentry-telepty/src/prompt-symbol-registry.js:153–159` —
  `detectOutput()` caller surface used by the ready-gate.
- `aigentry-telepty/src/submit-gate.js:50,132,203` — stacked timeout
  defaults (5000ms / 1500ms / 8000ms) on the bootstrap gates.

### 8.2 Commits

- `aigentry-telepty` `900c3ae4126825405686923e963fbfa18d381875`
  (2026-05-26 18:14:29 +0900) —
  `fix(daemon): bundle 0.4.5 — postinstall hook + daemon restart
  ready-restore + force bypass order + codex matcher normalize
  (#469 #470 #471 #472)`.
- `aigentry-telepty` log for `src/prompt-symbol-registry.js`:
  - `900c3ae` (0.4.5, the fix).
  - `744ad6a` — bootstrap inject queue race (#18).
  - `bd33898` — feat(submit-gate): Layer 3 prompt-symbol render gate
    (0.3.2). Introduced the matcher framework.
- `aigentry-devkit:22e8f0f` — orchestrator `--auto-restart`
  workaround (`#446`).

### 8.3 Trial logs (this session)

- `/tmp/test485-bis-2.log`, `/tmp/test485-bis-2.start`
- `/tmp/test485-bis-3.log`, `/tmp/test485-bis-3.start`

### 8.4 Tasks / issues

- `#446` — workaround (uniform `--auto-restart`).
- `#472` — codex matcher normalize (root-cause fix).
- `#485` — this root-cause investigation.

---

## 9. Rule envelope (analyst variant — Rule 17 [SAWP])

- Read-only across cited repos. ✅
- No code edits, no commits, no builds, no tests. ✅
- Evidence-based (Rule 22): every claim cites a file:line, a commit
  hash, or a captured log line. ✅
- Surgical scope (Rule 29): report covers root cause + workaround
  disposition only. cmux-restart-kills-all is flagged as out-of-scope
  with a future-dispatch suggestion, not investigated here. ✅
- Permanent fix mandate (Rule 32): all 4 steps closed; #472 is the
  shipped permanent fix. ✅
- Constitution §13 balance: hypotheses listed with refuting evidence,
  confidence honestly bounded medium-high (not high) given the
  pre-fix re-reproduction is not done. ✅
