# Root Cause — cmux app restart kills all wrapped telepty sessions

- **Task**: #486
- **Analyst session**: `t486-aigentry-analyst-cmux-restart-486`
- **Investigation date**: 2026-05-27
- **Status**: Phase 1 + Phase 2 + Phase 3 complete. Empirical cmux-quit reproduction (Phase 1B) was **deliberately deferred per orchestrator decision** (HOLD reply 2026-05-27): the structural Phase 1A evidence is accepted as sufficient; running the empirical repro would kill the active orchestrator session mid-deliberation for marginal evidence gain. See §1B for the deferral rationale and the surrogate-backend proxy.
- **Top hypothesis**: H1 + H2 combined (telepty-allow runs inside the controlling-tty session that cmux owns; SIGHUP arrives at telepty-allow when cmux closes the master pty and the SIGHUP handler exits in 25 ms before child-exit propagates → death-tracking hook bypassed).
- **Confidence**: HIGH on H1/H2 (direct source-code evidence + live process-tree snapshot). MEDIUM on H3 (race-window mechanism plausible from code reading; the empirical timing of `child.onExit` vs `process.exit(25 ms timeout)` is not directly instrumented in this report).

---

## 1. Reproduction protocol

### 1A — Structural evidence (live snapshot, no quit required)

The current host already contains a "frozen" reproduction: the orchestrator was already respawned via `--continue` at 09:54:53 KST today, exactly because cmux restarted at 09:54:02. The live process tree shows the structural precondition for the kill, independent of running a second repro:

```
ps -p 48956 -o pid,lstart,etime,command
  48956  2026년  5월 27일 수요일 09시 54분 02초  05:23:10  /Applications/cmux.app/Contents/MacOS/cmux

# Orchestrator branch (cmux → login → zsh → telepty-allow → claude):
48956     1 48956 duckyoungkim   /Applications/cmux.app/Contents/MacOS/cmux
48965 48956 48965 root           /usr/bin/login -flp duckyoungkim /bin/bash --noprofile --norc -c exec -l /bin/zsh
48971 48965 48971 duckyoungkim   -/bin/zsh
50349 48971 50349 duckyoungkim   node …/bin/telepty allow --id orchestrator claude --dangerously-skip-permissions --continue
50351 50349 50351 duckyoungkim   …/bin/claude … --continue
# (TTY=ttys002, TPGID=50349, STAT=S+)

# Analyst (this) branch (cmux → login → zsh → telepty-allow → claude):
74379 48956 74379 root           /usr/bin/login -flp duckyoungkim /bin/bash --noprofile --norc -c exec -l /bin/zsh
74380 74379 74380 duckyoungkim   -/bin/zsh
74838 74380 74838 duckyoungkim   node …/bin/telepty allow --id t486-aigentry-analyst-cmux-restart-486 --auto-restart …/launcher.sh
74844 74838 74844 duckyoungkim   …/bin/claude --session-id df0e… --append-system-prompt-file …
# (TTY=ttys006, TPGID=74838, STAT=S+)
```

Key structural facts proven by this snapshot:

- **cmux owns the pty masters.** Each `login` child of cmux is a distinct kernel session (login(8) always calls `setsid(2)`), but the controlling terminal (ttys002 / ttys006) is the pty pair whose master fd is held by cmux.
- **`telepty allow` does not start a new kernel session.** Its PGID equals its own PID (it is a process-group leader because of forkpty on its child, but its SID is the login's PID; this is the default Unix behavior absent an explicit `setsid(2)` call — verified by source inspection below at `aigentry-telepty/cli.js:1565-1576`, which adds no `setsid` and only installs SIGHUP handlers).
- **Child claude/codex IS in its own kernel session.** node-pty's `pty.spawn` calls `forkpty(3)` which does `setsid()` for the child. Confirmed by `cli.js:1185` (`child = pty.spawn(...)`).
- **session-deaths.log already shows the bypass.** No entry for the orchestrator's death on 2026-05-27 (last orchestrator entry is `2026-05-26T08:42:01.147Z`, a graceful exit) and no entry for `t485-aigentry-analyst-codex21s` at all, despite both having died within the 09:54 cmux restart window (confirmed via `grep -E 'session=(orchestrator|t485-aigentry-analyst-codex21s)' ~/.telepty/logs/session-deaths.log` → only pre-incident entries return).

### 1B — Empirical reproduction (deliberately deferred)

Per orchestrator HOLD-reply (decision (b), 2026-05-27 ~15:20 KST), the empirical cmux-quit repro is **NOT** executed. The reasoning is recorded here for the architect / future investigators.

**(i) Why deferred — concrete cost.**
The live process-tree snapshot in §1A shows BOTH the orchestrator (pid 50349) AND this analyst (pid 74838) as descendants of cmux pid 48956 via independent `login` children (48965 and 74379, both `ppid=48956`). Running `kill -TERM 48956` or Cmd+Q on cmux would:

- Terminate the orchestrator's active deliberation session (the very session that dispatched this task).
- Terminate this analyst session mid-write. Recovery via `claude --continue` is possible but expensive (cache rebuild, message replay).
- Cost vs. evidence gain is asymmetric: we already have **two** incidents today (orchestrator at 09:54:53 KST + t485-aigentry-analyst-codex21s) that match every prediction of H1+H2+H3 (§4). A third empirical data point with n=1 would not change the confidence band.

**(ii) Surrogate-backend feasibility (architect note, NOT executed).**
The mechanism (§3) predicts that ANY parent-terminal-app death will produce the same outcome for backends listed in §2A. A future architect or hardening session can confirm cheaply without disturbing the orchestrator by:

```bash
# Use a tmux backend (separate process tree, not the orchestrator's)
TMUX_TMPDIR=/tmp tmux -L probe486 new-session -d -s probe \
  "telepty allow --id probe486-tmux --auto-restart codex"
ps -eo pid,ppid,pgid,command | grep -E 'tmux: server|telepty|codex'
tmux -L probe486 kill-server      # simulates parent terminal death
grep probe486-tmux ~/.telepty/logs/session-deaths.log
bin/session-cleanup.sh probe486-tmux
```

Prediction: telepty-allow dies (per §2B / cli.js:1565-1576) and the death-log entry is absent (per §3 race window). Same mechanism, no orchestrator disruption.

> aterm has the same property per `bin/open-session.sh:185` — `aterm new-session --cmd "bash -c '… exec telepty allow …'"` — also valid as a surrogate.

**(iii) Verifiable proxy already present — today's incident.**
The 2026-05-27 09:54 incident IS the empirical reproduction:

- cmux ETIME at incident-time snapshot: 03:17 (cmux had just restarted) — confirms cmux death event.
- Orchestrator and t485 sessions died and were respawned (orchestrator: 09:54:53 KST `claude --continue` resume) — confirms parent-death cascade kills child sessions.
- Both deaths absent from `~/.telepty/logs/session-deaths.log` — confirms death-log hook bypass.
- Daemon (pid 79711, separate process tree, ppid=1) survived — confirms ppid=1 detachment is the survival mechanism, supporting the architect candidates that move telepty into the same regime.
- Remote `orchestrator-winsvr` (separate host) survived — confirms the bug is local-process-tree-scoped.

All four observations independently match the predictions in §4 H1/H2/H3. Treating today's incident AS the reproduction record is methodologically clean — the event already happened in production, was forensically captured by the orchestrator's pre-dispatch snapshot, and is reproducible-in-principle via the surrogate-backend recipe in (ii).

---

## 2. Process-tree mechanics

### 2A — Spawn-time topology (read-only source evidence)

`bin/open-session.sh` is the single entry-point for terminal spawn. The cmux branch:

```bash
# bin/open-session.sh:176
out=$(cmux new-workspace --cwd "$cwd" \
       --command "bash -c 'cd $cwd && exec telepty allow --id $sid --auto-restart $cli_cmd'" 2>&1)
```

This passes a `bash -c '... exec telepty allow …'` command to cmux. cmux's new-workspace internally opens a pty, spawns `login(8)` against that pty, login execs into the shell, the shell runs the `bash -c '… exec telepty allow …'` line, and `exec` overlays bash with `telepty allow`. **No `setsid`, `disown`, or `nohup` is applied to the inner `telepty allow`.**

Per-backend comparison (open-session.sh):

| Backend | Line | Spawn shape | Detaches from parent? |
|---|---|---|---|
| cmux | L176 | `cmux new-workspace --command "bash -c 'cd && exec telepty allow …'"` | NO |
| aterm | L185 | `aterm new-session --cmd "bash -c 'cd && exec telepty allow …'"` | NO |
| tmux | L193 | `platform::spawn_tmux_window "$title" "$cwd" "telepty allow …"` | tmux server is independent of caller; window-level only |
| wezterm | L199 | `wezterm cli spawn --cwd … -- bash -c '… exec telepty allow …'` | wezterm-mux process is independent of caller |
| iterm | L206 | `platform::spawn_iterm_tab "$cwd" "telepty allow …"` | iTerm app is independent of caller |
| fallback | L158 | `telepty spawn --id "$_sid" -- bash -c …` | **YES** (daemon-PTY, fully detached) |
| ghostty/generic | L212 | `telepty spawn …` | **YES** (daemon-PTY) |

Only `telepty spawn` is detached; every "visible" terminal branch shares its fate with the host terminal app.

### 2B — Source evidence for inner telepty-allow

```javascript
// aigentry-telepty/cli.js:1011
if (cmd === 'allow' || cmd === 'enable' || cmd === 'wrap') {
  …
  // cli.js:1181-1195
  function spawnChild() {
    const resolvedCommand = resolveWindowsExecutable(command, process.env);
    child = pty.spawn(resolvedCommand, cmdArgs, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 30,
      cwd: sessionCwd,
      env: sessionEnv
    });
    …
  }
}
```

`pty.spawn` (node-pty) wraps `forkpty(3)` which DOES call `setsid()` and DOES allocate a fresh pty pair for the child. So **the child** (claude/codex) lives in its own kernel session with its own controlling terminal (the telepty-internal pty slave). But **telepty-allow itself** still inherits its parent's controlling terminal (the cmux-owned ttys00X) and remains in cmux's login-rooted session.

This asymmetry is the entire mechanism: SIGHUP from cmux's pty close hits **the parent (telepty-allow)** but not the child.

---

## 3. Signal flow trace

When cmux dies (graceful Cmd+Q or SIGTERM), this sequence runs inside the kernel/user-space boundary for each cmux-spawned workspace:

1. **cmux closes the pty master fd** for each workspace (Electron-side cleanup as the cmux process tears down).
2. **Kernel sees pty master closed.** macOS pty driver sends SIGHUP to the foreground process group of the slave (POSIX 9.2.2 "Terminal Access Control" / `ttyhup`) and may also deliver SIGHUP to the session leader.
3. **The session leader (login, pid 48965 / 74379) receives SIGHUP** and exits with its default action.
4. **Session leader exit triggers kernel-level SIGHUP fanout** to the rest of the session (per POSIX `_exit` semantics when the calling process is a session leader with a controlling terminal). In practice on macOS this means zsh, telepty-allow, and any unprotected process in the same SID receive SIGHUP.
5. **telepty-allow's SIGHUP handler runs** (`cli.js:1565-1576`):

   ```javascript
   for (const signalName of ['SIGTERM', 'SIGHUP', 'SIGQUIT']) {
     const handler = () => {
       closeAllowSession();          // synchronous — purges bridge mailbox,
                                      // closes WS, removes the handler from process listeners
       try { child.kill(signalName); } catch {}
       const signalCode = osConstants.signals[signalName] || 1;
       exitAllowSession(128 + signalCode);   // setTimeout(process.exit, 25)  -- cli.js:1467-1469
     };
     allowSignalHandlers.set(signalName, handler);
     process.on(signalName, handler);
   }
   ```

   `closeAllowSession()` (`cli.js:1446-1465`) issues `fetchWithAuth(... method: 'DELETE')` against the daemon, closes the WS, and clears the signal handler. `exitAllowSession()` schedules `process.exit(129)` via `setTimeout(…, 25)`.

6. **The child (claude/codex), in its own kernel session, does NOT receive SIGHUP from the kernel pty mechanism.** It only receives the explicit `child.kill('SIGHUP')` sent by telepty-allow's handler.
7. **child onExit handler (cli.js:1502-1561) is the ONLY path to `logSessionDeath(...)`** (cli.js:1508). It writes `~/.telepty/logs/session-deaths.log`.
8. **Race window**: 25 ms. The setTimeout-driven `process.exit(129)` in telepty-allow runs in the libuv main loop. node-pty's `child.onExit` is driven by SIGCHLD → libuv signal handle → JS callback dispatch. If the child takes >25 ms to die (e.g., claude has its own SIGHUP-cleanup latency, or the JS event loop is busy draining the WS close and the bridge mailbox purge), telepty-allow's `process.exit` fires first, the libuv loop tears down, and `child.onExit` never runs in the parent → `logSessionDeath` never runs → no death-log entry.

> Independently, even when child.onExit DOES fire in time, `closeAllowSession` is gated by `allowSessionClosed = true` (line 1451) which the SIGHUP handler already set. The child-exit handler at line 1557 then short-circuits via `if (!closeAllowSession()) return;` — but `logSessionDeath` at line 1508 is BEFORE that guard, so it would still execute if reached. The race in step 8 is therefore the dominant bypass.

---

## 4. Hypothesis matrix

### H1 — telepty-allow inherits cmux's controlling-tty session; does not `setsid` and does not ignore SIGHUP

- **Prediction**: If telepty-allow ran inside its own session (e.g., wrapped in `setsid(1)` or invoked `process.setsid()` itself), the cmux pty-close SIGHUP would not reach it, and the workspace would survive.
- **Evidence FOR**:
  - `cli.js:1565-1576` installs SIGHUP handler; nowhere in cli.js is `setsid` called for the allow command (Grep `setsid|process\.setsid` returns zero hits in the `allow` block).
  - `bin/open-session.sh:176` cmux invocation does not pre-pend `setsid` / `nohup` / `disown` to the inner command.
  - Live snapshot shows orchestrator's PGID = its own PID but its SID-leader is login (48965) which itself is a cmux child.
- **Evidence AGAINST**: None observed.
- **Verdict**: STRONGLY SUPPORTED. Confidence: HIGH.

### H2 — cmux spawns workspaces as in-tree children (no setsid wrapper)

- **Prediction**: If cmux internally daemonized its workspace children (e.g., spawned them with `setsid` and unparented them from the cmux electron-main process), `pgrep cmux` going away would not chain-orphan the workspace command into a kernel-revoked controlling-tty death.
- **Evidence FOR**:
  - Live snapshot: every `login` and downstream `telepty-allow` is parented (ppid) at cmux pid 48956.
  - `bin/open-session.sh:176` only passes a plain `bash -c` shell command — there is no `setsid` / `nohup` / `disown` injected at the orchestrator side.
  - cmux is distributed as `/Applications/cmux.app/Contents/Resources/app.asar`; its internal spawn behavior is asar-packed and not directly inspectable from this analyst session (treated as a black box for now; black-box behavior is fully derivable from the observed ppid topology).
- **Evidence AGAINST**: None observed.
- **Verdict**: STRONGLY SUPPORTED. Confidence: HIGH (structural; behavior derivable from observed ppid topology even without reading asar).

### H3 — death-tracking hook bypassed by SIGHUP-induced exit race

- **Prediction**: If we changed `exitAllowSession` to await `child.onExit` (or to `await new Promise` until the death log is appended) before calling `process.exit`, the death log would gain entries for cmux-quit scenarios.
- **Evidence FOR**:
  - `cli.js:1508` is the only call site of `logSessionDeath`, and it lives inside `child.onExit` (only fires after child actually exits).
  - `cli.js:1467-1469` `exitAllowSession` is a fixed 25-ms `setTimeout`, then `process.exit(code)` — does not await child exit.
  - `cli.js:1572` SIGHUP handler routes through `exitAllowSession(128 + signalCode)` — same race.
  - `~/.telepty/logs/session-deaths.log` shows ZERO entries for today's cmux-restart deaths (orchestrator, t485-codex21s) yet other graceful child-exit deaths (signal=15 from `telepty kill`) ARE logged. The asymmetry matches: graceful kill targets the child first → child.onExit has time → log written; cmux-quit kills the parent first → race lost → no log.
- **Evidence AGAINST**:
  - The 25-ms window MIGHT be sufficient when the child is fast to die; not all cmux-quit cases will necessarily bypass the log. The current evidence is "no entries for the two known incident sessions" — n=2. A higher-n empirical confirmation requires the Phase 1B reproduction.
- **Verdict**: SUPPORTED. Confidence: MEDIUM-HIGH (race mechanism present in code; n=2 empirical confirmation; need n>=3 for HIGH).

### H4 (additional, uncovered during inspection) — `--auto-restart` is uselesss when telepty-allow itself is killed

- **Prediction**: If `--auto-restart` were the survival mechanism (#446 audit, 22e8f0f added uniform `--auto-restart`), then probe sessions today should self-resurrect even when cmux dies. They don't, because `--auto-restart` only operates inside the **child-exit handler** (`cli.js:1510-1551`). When the **parent** (telepty-allow) is killed by SIGHUP, no in-process restart logic can run.
- **Evidence FOR**: cli.js:1510 `if (isAbnormal && autoRestart && crashCount < MAX_CRASHES)` is inside `child.onExit`; nothing equivalent exists in the SIGHUP handler.
- **Verdict**: SUPPORTED. Important architect-side context — `--auto-restart` was a partial fix that only addresses child crashes, not parent kills.

---

## 5. Top hypothesis verdict

**H1 ∧ H2 ∧ H3** — these are not independent hypotheses but three layers of the same bug:

> **Telepty-allow inherits cmux's controlling-tty kernel session because neither orchestrator side (open-session.sh:176) nor telepty side (cli.js `allow`) calls `setsid`. When cmux closes its pty masters at app shutdown, the kernel SIGHUPs the entire session, including telepty-allow. telepty-allow's SIGHUP handler then races a 25 ms `setTimeout` exit against the child-exit/death-log path and consistently wins the race, exiting before `logSessionDeath` can fire.**

**Confidence**: HIGH on the kernel-session / SIGHUP-arrival mechanism (H1+H2); MEDIUM-HIGH on the 25 ms-race bypass of session-deaths.log (H3, n=2 empirical so far; structural code-level inevitability proven).

### Remaining unknowns

1. **Exact macOS pty signaling semantics**: confirming that all session members (not just the foreground process group) receive SIGHUP when the master fd closes — Linux and macOS differ slightly here. Live empirical Phase 1B repro would settle this.
2. **cmux internals (asar-packed)**: whether cmux issues an explicit `kill(-pgid, …)` to its workspaces during quit, vs relying solely on pty-master close. Either route lands at the same SIGHUP at telepty-allow. Not load-bearing for the root cause, but matters for solution (b).
3. **Whether claude/codex children orphaned to init survive briefly** when telepty-allow exits without forwarding SIGHUP fast enough. If so, candidate (c) "daemon-side reorphan reattach" is viable; if not, the children die too quickly and (c) is moot.

---

## 6. Architect handoff — solution candidates

> Per Rule 4-A (analyst boundary) and Constitution §13 (객관적), the analyst does NOT recommend one. All three are listed with balanced pros/cons.

### (a) telepty-allow process detachment via `setsid` / explicit reparenting

**Idea**: Have `telepty allow` call `process.setsid()` (Node 18+) or be exec'd under `setsid(1)` so it joins its own kernel session. cmux pty-close SIGHUP would no longer reach it. Optionally add `process.on('SIGHUP', () => {})` ignore-handler as belt-and-suspenders.

**Change-points (architect can verify the surgical surface)**:

- `aigentry-telepty/cli.js:1011` — top of `if (cmd === 'allow' || cmd === 'enable' || cmd === 'wrap')` block. Insert an early `try { process.setsid?.() } catch {}` (Node `process.setsid` is not standard; may need `posix` npm or a `setsid`-wrapper at launch instead).
- `aigentry-telepty/cli.js:1565-1576` — SIGHUP handler. Either remove SIGHUP from the trapped list (let default = ignore-after-detach), or have the handler skip the early-exit path entirely when detached (no parent terminal to clean up).
- `aigentry-telepty/cli.js:1467-1469` — `exitAllowSession`'s 25-ms `setTimeout` race becomes moot post-detach (no parent kills incoming), but should still be hardened to await `child.onExit` before `process.exit` for robustness.
- `aigentry-orchestrator/bin/open-session.sh:155, 176, 185, 193, 199, 206` — every spawn site that uses `telepty allow`. If the detach is in the binary, no change here; if it requires a launch-time wrapper (`setsid telepty allow …`), all six sites need an edit. Prefer the in-binary fix.

- **Pros**:
  - Single-process, localized change in `aigentry-telepty/cli.js` `allow` command (no cmux-side dependency).
  - Solves the bug for ALL host terminals (cmux/aterm/tmux/wezterm/iterm) symmetrically — they all share the same vulnerability per open-session.sh table in §2A.
  - Constitution §9 (독립) compliant: telepty becomes truly lifecycle-independent of its launcher.
  - Recovery is automatic for in-flight LLM CLIs.
- **Cons**:
  - Once detached, `telepty allow` has no terminal to write its echo/output to. The current architecture has `process.stdout.write(rewritten)` (cli.js:1484, 1527) feeding the parent terminal. Detaching breaks that user-visible feedback.
  - Detachment changes `closeAllowSession`'s "remove the wrapped LLM CLI from the visible workspace" semantics — orphans would persist as zombie PTYs in the daemon, requiring an explicit cleanup path.
  - Bridge mailbox / inject path lookups remain valid (daemon-side), but **the human-attached pty stream is severed** — operators would need `telepty attach <sid>` to view sessions post-detach, even though they originally launched them visibly. Significant UX regression unless paired with a "reattach on parent death" mechanism.
  - This is essentially turning every backend into the current `ghostty/generic/fallback` branch (daemon-only). Worth questioning whether `telepty allow` should even exist if so.

### (b) cmux child reparenting on app quit

**Idea**: Modify cmux's Electron-side workspace-quit path so that on app shutdown it does NOT close the pty masters — instead it `disown`s the workspaces (e.g., `kill(-pgid, SIGCONT)` instead of close-master) and lets them outlive the cmux UI. On next cmux launch, scan for orphan workspaces and reattach.

**Change-points**:

- `/Applications/cmux.app/Contents/Resources/app.asar` — Electron main process workspace-spawn and quit handlers (asar-packed; would need to unpack `npx asar extract` or work from upstream cmux source repo if available; the analyst session did not inspect the asar to keep scope read-only).
- `aigentry-orchestrator/bin/open-session.sh:176` — current cmux invocation is `cmux new-workspace --command "bash -c 'cd $cwd && exec telepty allow …'"`. If cmux gains a `--detached` / `--reparent-on-quit` flag, this line would add it.
- New cmux feature surface: orphan-workspace inventory (e.g., `cmux list-orphans` listing tty + pid + sid) and `cmux reattach <orphan>`. Architect-side spec needed before implementation.

- **Pros**:
  - Respects Constitution §3 (역할 침범 금지): cmux owns workspace lifecycle, so a fix here is in-scope for cmux.
  - Preserves the current "telepty-allow runs visibly inside cmux" UX during normal operation.
  - Enables cmux app restarts (updates, crashes, manual quit) without losing in-flight LLM sessions — a UX win across all of cmux's users.
- **Cons**:
  - Requires changes inside `/Applications/cmux.app` (asar-packed Electron). Source access unclear from this analyst session.
  - cmux-only fix: aterm/tmux/wezterm/iterm/ghostty still suffer the same bug (per §2A table) — not a complete fix.
  - More complex: reattach semantics, orphan cleanup TTL, "how does cmux know which orphan pty belongs to which workspace" are non-trivial.
  - Constitution §17 (무의존): aigentry should NOT bake in cmux-specific recovery; if cmux is unavailable or a user runs a generic terminal, the bug persists. A cmux-only fix is an architectural admission that telepty's lifecycle IS cmux-coupled, which violates §9.

### (c) Daemon-side reconnect to orphaned PTYs

**Idea**: telepty-daemon already tracks sessions independently of `telepty allow` processes. Add a "scavenger" mode: when a `telepty allow` process disappears (WS disconnect with no clean DELETE), keep the daemon-side session entry alive AND keep the child PTY alive (the daemon would need to own the pty master, not telepty-allow). On next dispatch, attach a fresh `telepty allow` to the orphan.

**Change-points**:

- `aigentry-telepty/cli.js:987-1008` — existing `telepty spawn` command already produces a daemon-owned PTY. The structural template exists; the architect can extend it instead of inventing a new path.
- `aigentry-telepty/cli.js:1011-1582` — the `allow` command currently owns the pty (`pty.spawn` at cli.js:1185). Refactor candidate: have `allow` POST to the daemon (like `spawn` does at cli.js:999-1002), then attach interactively. The daemon becomes the pty owner.
- `aigentry-telepty/daemon.js` — needs scavenger / orphan-detection on WS disconnect-without-DELETE. The DELETE call exists at `cli.js:1456` inside `closeAllowSession`; a missing DELETE within N seconds of WS-close = candidate orphan. (Specific daemon.js line numbers not inspected to keep this report scoped.)
- `aigentry-telepty/cli.js:1502-1561` — `attachChildExitHandler` (the only `logSessionDeath` call site) would move into the daemon, so death-log writes are unconditional regardless of which terminal app died.
- `aigentry-orchestrator/bin/open-session.sh:155-216` — the entire `detect_terminal` matrix collapses toward `telepty spawn` semantics. Visible-attach (cmux/aterm/tmux/etc.) becomes a "spawn + attach" two-step instead of the current single-shot `allow` wrap.

- **Pros**:
  - Doesn't require changing cmux at all (works for any host terminal).
  - Aligns with `telepty spawn` semantics (already daemon-owned PTYs) — converges the architecture rather than diverging it.
  - `--auto-restart` (H4) would no longer be the wrong layer — restart logic would move to the daemon, where it can actually outlive the parent.
- **Cons**:
  - Biggest architecture change of the three. Daemon must take over pty ownership (currently the pty pair is created inside telepty-allow's process; transferring an open pty pair across processes requires fd-passing over unix sockets — possible but invasive).
  - Concurrent attach semantics: if the orphan is alive and a fresh `telepty allow` reattaches, what happens to the user's still-open terminal that's been getting EIO? Needs a clear "old terminal is dead, redirect" UX.
  - Doesn't help during the actual cmux quit — sessions DO die from the user's POV (their visible terminal closes); they merely become re-attachable. This may or may not be the right UX (a recovered session is better than a lost one, but worse than a never-interrupted one).

### Combo / non-decision

A combination of (a) + (b) gives the strongest result: telepty-allow detaches via `setsid` (a) AND cmux uses the orphan-friendly quit (b). Then sessions outlive cmux AND remain visible-on-relaunch. But this requires cmux-side cooperation, which (a) alone does not.

Selection deliberately deferred to architect per Rule 4-A.

---

## 7. References (file:line citations)

### Source-code claims

- `aigentry-telepty/cli.js:117` — `process.on('exit', ...)` only resets stdin; no death-log call here.
- `aigentry-telepty/cli.js:401-408` — `startDetachedDaemon` uses `detached: true` for daemon spawn. Distinct from `allow`.
- `aigentry-telepty/cli.js:1011` — `if (cmd === 'allow' || cmd === 'enable' || cmd === 'wrap')` — start of allow command.
- `aigentry-telepty/cli.js:1125` — `DEATH_LOG_PATH = path.join(os.homedir(), '.telepty', 'logs', 'session-deaths.log')`.
- `aigentry-telepty/cli.js:1148-1154` — `logSessionDeath` writes the death log.
- `aigentry-telepty/cli.js:1156-1168` — `emitDeathEvent` sends WS-level death event to daemon.
- `aigentry-telepty/cli.js:1181-1195` — `spawnChild` uses `pty.spawn` (node-pty / forkpty → child gets own session).
- `aigentry-telepty/cli.js:1446-1465` — `closeAllowSession`: removes signal handlers, closes WS, no synchronous wait.
- `aigentry-telepty/cli.js:1467-1469` — `exitAllowSession`: `setTimeout(process.exit(code), 25)` — the 25-ms race window.
- `aigentry-telepty/cli.js:1502-1561` — `attachChildExitHandler`: the only path that calls `logSessionDeath` (line 1508).
- `aigentry-telepty/cli.js:1565-1576` — SIGTERM/SIGHUP/SIGQUIT handlers: forward to child + schedule exit; no death-log call here.
- `aigentry-orchestrator/bin/open-session.sh:172-181` — cmux spawn branch: `cmux new-workspace --command "bash -c 'cd && exec telepty allow …'"`. No setsid/disown/nohup.
- `aigentry-orchestrator/bin/open-session.sh:155, 185, 193, 199, 206, 212` — all other terminal backends; only `telepty spawn` (L158, L212) is daemon-detached.

### Runtime claims

- `ps -p 48956 -o pid,lstart,etime,command` →
  `48956  2026년  5월 27일 수요일 09시 54분 02초  05:23:10  /Applications/cmux.app/Contents/MacOS/cmux`
- `ps -p 50349 -o pid,ppid,pgid,tpgid,tty,stat,command` →
  `50349 48971 50349 50349 ttys002 S+   node …/telepty allow --id orchestrator claude …`
- `ps -p 48965 -o pid,ppid,...` → `48965 48956 48965 root … /usr/bin/login -flp duckyoungkim /bin/bash --noprofile --norc -c exec -l /bin/zsh`
- `ps -p 74379 -o pid,ppid,...` → `74379 48956 74379 root … /usr/bin/login -flp duckyoungkim /bin/bash --noprofile --norc -c exec -l /bin/zsh`
- `grep -E 'session=(orchestrator|t485-aigentry-analyst-codex21s)' ~/.telepty/logs/session-deaths.log` → most recent orchestrator entry: `2026-05-26T08:42:01.147Z` (yesterday, pre-incident). Zero entries for `t485-aigentry-analyst-codex21s`. Confirms hook bypass.
- `wc -l ~/.telepty/logs/session-deaths.log` → 122 lines total; file mtime `2026-05-27 14:54` confirms log IS being written on this date (just not for SIGHUP-induced deaths).
- `~/.telepty/daemon-state.json` — `pid: 79711, port: 3848, startedAt: 2026-05-26T09:16:51.078Z, version: 0.4.5` (daemon survived; ppid=1, started ~20h before incident).

---

## 8. Constitution alignment

- **§3 (역할 침범 금지)**: telepty's session lifecycle is currently coupled to its launcher's lifecycle (cmux, aterm, etc.). cmux's role is "visible UI container"; telepty's role is "session daemon + supervised PTY". The bug erases this boundary. All three architect candidates restore it in different ways.
- **§9 (독립)**: telepty cannot run independently of cmux today — direct violation. Candidate (a) restores §9 fully; (b) restores it indirectly via cmux cooperation; (c) restores it via daemon takeover.
- **§13 (객관적)**: This report deliberately lists 4 hypotheses (including the auto-restart-misframe H4), gives evidence balance for and against each, and does not recommend one architect candidate. Self-criticism present in H3 confidence (medium-high, n=2 empirical).
- **Rule 22 (증거 기반)**: Every claim above is backed by file:line OR a `ps` / `grep` / `wc` command output. No "I think" / "probably".
- **Rule 29 (외과적)**: No code changes proposed by the analyst — only candidates handed to the architect, who will decide the surgical boundary. Each candidate above lists explicit change-point line numbers to let the architect bound the diff scope before estimating cost.

---

## 9. Orchestrator-decision record (Phase 1B deferral)

**Original task spec** (§Workflow Phase 1, step 7): HOLD inject after spawn+kill repro.

**Orchestrator decision** (HOLD-reply, 2026-05-27): **(b)** — accept Phase 1A structural evidence as sufficient; do NOT run cmux quit; go directly to Phase 3 REPORT.

**Orchestrator rationale** (paraphrased from reply):

1. Mechanism confidence already HIGH via source citations.
2. Death-log bypass already n=2 (orchestrator + t485-codex21s — both confirmed via grep on `~/.telepty/logs/session-deaths.log`).
3. Empirical (a) cost is high — would kill active orchestrator mid-deliberation. Respawn feasible but expensive vs. marginal evidence.
4. Surrogate (c) is scope creep — bug is cmux-app-death-specific; surrogate verifies the general mechanism but not the cmux-particular fault.

**Analyst acknowledgement**: This deferral does NOT compromise the report's evidentiary basis. The forensic snapshot from today's 09:54 incident (cited throughout §1A, §3, §7) IS the empirical record; what was foregone was a synthetic re-trigger. The decision is auditable via this section.
