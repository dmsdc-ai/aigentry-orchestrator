# #899 T5 disposition — `bin/orchestrator-boot.sh` → exec shim + `src/orchestrator-boot/cli.ts`

Track ob899. Worktree `~/.aigentry/worktrees/ob899`, branch `feat/899-t5-ob899` off
`origin/main` @ b300875. `npx tsc -p .` clean, `npm test` 225/225 at baseline.

**Nothing has been implemented.** This is the Phase-1 disposition; §8 is the blocking
part.

The script is 222 lines: a registry reconcile (#905), a singleton SIGKILL guard (#539)
and an `exec` of `telepty allow`. It is the USER-RUN control tower boot. Every
measurement below was taken hermetically against the bash at b300875 with recorder
stubs — **no real pid was listed or signalled and no real DELETE was issued.**

## 1. Guard split — sourced vs invoked

| guard | how it reaches the script | `__probe` owed? |
|---|---|---|
| T40 `orchestrator_singleton_guard` | **`source "$BOOT"`** (:59), then calls `orchestrator_singleton_guard`, `orchestrator_registry_reconcile` and reads the `ORCH_EXEC_ARGV` array | **YES** |
| T87 single token resolver | static grep over `bin/` + a hardcoded 2-file call-site list | no |
| T98, T57, T127 | name the script in prose / alert text only | no |

`grep -rnE '(^|[^a-z])(\.|source)[[:space:]]+[^[:space:]]*orchestrator-boot\.sh'` over the
tree matches **nothing but documentation** — no production caller sources it either
(`bin/session-start.sh`, `bin/install-launchd.sh`, `bin/dispatch-tracker.sh`,
`bin/orchestrator-bridge-auditor.sh`, `bin/init/*` all only mention it). So exactly one
guard sources it, and this is the **T52 shape from tranche 2a**: sourceability goes, and
T40 is re-pointed at `__probe` subcommands so it measures the code production runs.

Three subcommands, mirroring what T40 uses today — internal surface, not flags, not in
any `--help` (there is none), no caller outside `tests/dispatch/`:

* `__probe singleton-guard` → runs the guard, exit 0
* `__probe registry-reconcile` → runs the reconcile, exit 0
* `__probe exec-argv` → prints the argv, one element per line (T40 block L)

**T40 is edited.** That is one existing guard file beyond the two new ones — §8 D5.

## 2. Sourced libs

One: `bin/lib/telepty-auth.sh` (:61), for `telepty_auth_token` in the DELETE header.
Becomes the **subprocess door**, byte-identical to `src/cleanup/cli.ts:129` and
`src/tracker/cli.ts`:

```ts
capture("bash", ["-c", '. "$1"; telepty_auth_token', "_", TELEPTY_AUTH_SH])
```

T87 needs **no edit**: its assertion (5) counts files under `bin/` that *extract*
`authToken` (still 1 — the lib), its definition check is unchanged, and its call-site
loop is a hardcoded 2-entry list that a third caller does not break. The lib's `python3`
stays inside the lib, where it already is.

`bin/wh-cli.sh` is not involved — no `lib/workspace-host.sh` here.

## 3. Subprocess children — argv unchanged

| child | argv | seam |
|---|---|---|
| process lister | `ps -eo pid,ppid,command` | `SINGLETON_PS_CMD` |
| killer | `kill -9 <pid>` | `KILL_CMD` |
| registry listing | `telepty list --json` | `TELEPTY` |
| registry DELETE | `curl -s -o /dev/null -w '%{http_code}' -H 'x-telepty-token: …' -X DELETE http://127.0.0.1:<port>/api/sessions/<sid>` | `CURL` |
| credential | `bash -c '. lib/telepty-auth.sh; telepty_auth_token'` | — |

**Absorbed, never contracts:** `jq` ×4, `awk` ×2 (the ancestry hop and the bridge
selector), `grep -qxF`, `head -1`. They were how bash reached a JSON parser and a table
scanner. Dropping `jq` has one measured behavioural consequence — §8 D2.

## 4. Env seams

`ORCHESTRATOR_SID` (default `orchestrator`), `KILL_CMD`, `SINGLETON_PS_CMD`,
`SINGLETON_SELF_PID`, `TELEPTY`, `CURL`, `TELEPTY_PORT` (default `3848`). All keep their
names and defaults.

`SINGLETON_SELF_PID` **changes default**: `$$` (the boot shell, which *becomes* the
bridge) → `process.pid` (the node child of the shim shell). The ancestry walk is
unaffected and strictly wider: node's ppid chain runs node → shim shell → the terminal
(→ the live orchestrator bridge, in the #539 self-restart case), so every pid the bash
protected is still protected, plus node's own. Pinned by T131 with a recorder `ps` stub
that derives the chain from its own real `$$` and marks a genuine ancestor as a bridge.

`TELEPTY_CMD` / `CURL_CMD` were shell-local variables T40 re-pinned after `source`; with
no source there is nothing to re-pin, so `__probe` is driven by the `TELEPTY` / `CURL`
env vars the script already reads.

## 5. Contract lines the port must keep byte-identical

| line | pinned by |
|---|---|
| every `[orchestrator-boot] …` line → **stderr**, prefix included (12 shapes) | T131 (T40 pins none of the text) |
| `exec <argv>` log line before the exec | T131 |
| argv `telepty allow --id <sid> --auto-restart claude --dangerously-skip-permissions --continue`, `--auto-restart` **before** the command word | T40 L (kept) |
| SIGKILL only — never `-TERM`/`-15`/`-SIGTERM` | T40 E (kept) + T131 static scan |
| never kill self **or any ancestor**; exact refusal line `skip self/ancestor bridge pid=<pid> (<sid>)` | T40 A (kept) + T131 real-ancestry block |
| reconcile **always returns 0** — a failed pre-flight never blocks the boot | T40 J (kept) |
| the 5 DELETE arms: `200` / `404` / `401\|403` / `000\|''` / `*` | T131 |
| `STALE` **and** `clients == 0` and nothing else deletes; absent count ≠ zero | T40 F–K (kept) |
| the credential header is present and the **token value is never logged** | T40 F (kept) + T131 |
| exit code: only the exec's (127 when `telepty` is missing); every other path 0 | T131 |
| **stdout was EMPTY** in bash; it now carries the argv — new channel, §8 D1 | T131 |

`--help` does not exist (`grep -n 'help\|usage' bin/orchestrator-boot.sh` → no match) and
argv is ignored entirely (`main "$@"` uses no positional). **No `usage.ts`** — measured,
per the dispatch.

## 6. Platform branches

**Zero.** No `uname`, no `OSTYPE`, no `case $(uname)` in the file. `ps -eo pid,ppid,command`
is the same argv on BSD/macOS and GNU/Linux — already asserted at `src/cleanup/cli.ts:301`
and `src/bridge-auditor/cli.ts`. Nothing for `lib/platform.sh` to abstract, and the port
adds no `process.platform` branch.

## 7. Latent defects — measured, hermetic

All four measured against the bash at b300875 with a `ps` fixture and a `kill` recorder.

**D-A — a sid with a regex metacharacter SIGKILLs unrelated processes.** `:122` builds a
dynamic ERE (`awk -v s="$ORCH_SID" '$0 ~ ("telepty allow --id " s " ")'`). With
`ORCHESTRATOR_SID=orch.tor` against a 4-row fixture the guard **SIGKILLed three pids**:
`orchXtor`, `orch1tor` and a `grep` process that merely *mentioned* the string. Same
class as bridge-auditor D4 — except there it emits a warning and here it is `kill -9`.

**D-B — a sid with an unbalanced `[` turns the guard into a silent no-op.**
`ORCHESTRATOR_SID='orch['` → `awk: nonterminated character class` on stderr, then
`singleton guard done: killed=0`. The script continues and execs. That is precisely the
duplicate-bridge outcome #539 exists to prevent, announced as a success.

**D-C — mention-is-a-bridge.** The marker is tested against the **whole `pid ppid command`
row**, so any process whose command line contains `telepty allow --id <sid> ` is SIGKILLed
even with a literal match. Reproduced as the `grep` row in D-A. This is the third site of
the shared marker (`bin/session-reconciler.sh:415`, `bin/orchestrator-bridge-auditor.sh`,
here) that `tests/dispatch/T127` block H already pins as needing its own ticket.

**D-D — `jq` absent ⇒ the reconcile is always skipped.** With a PATH containing no `jq`
and a listing that is `STALE`/0 clients, the bash prints *"registry reconcile SKIPPED —
the listing was not JSON (daemon/CLI version mismatch?)"* and issues **no DELETE**. The
`#905` remediation is unavailable on a `jq`-less host, and the message blames the daemon.

Three `jq` semantics that are behaviour, not plumbing, and that the port must reproduce
(all measured): a listing of literal `null` or `false` fails `jq -e .` and is reported as
"not JSON"; a non-array listing yields "no record"; `.healthStatus // .status` falls
through on **null *and* false**, not just absent; `active_clients: null` renders as the
string `null` and lands in the "N client(s) are attached — leaving it alone" arm.

Nothing here is a data-loss or security defect at an untrusted trust boundary —
`ORCHESTRATOR_SID` is operator-set env on the operator's own machine — so per the
dispatch all four are **reproduced, not fixed**, except where §8 asks otherwise.

## 8. Blocking — five decisions

**D1 — the exec shape (confirming the dispatch's prescription and one addition).**
Node has no `execve`, so the exec must stay in bash. Shape: TS does reconcile + guard,
logs to **stderr** as today, prints the argv to **stdout** one element per line and exits
0; the shim reads it into an array and `exec "${argv[@]}"`. The shim shell — the process
the user's terminal launched — replaces itself with `telepty allow`, so *the user's
terminal IS the bridge* exactly as today, with no node process left in the middle
(node has already exited). Verified on **bash 3.2.57** (macOS): `RAW="$(node …)"` under
`set -e`, `while IFS= read -r a; do argv+=("$a"); done <<< "$RAW"`, `${#argv[@]}` on an
empty array — all fine, no `mapfile`.
*The addition I need a call on:* newline-delimited argv means a sid containing a newline
would split into two argv elements. I propose the TS **refuses** such a sid (exit 2, one
stderr line) rather than silently corrupting the exec. That is a refusal the bash never
had. **Recommend: yes, refuse.**

**D2 — dropping `jq` changes when the destructive path runs (D-D).** On a host without
`jq` the original ALWAYS skips the reconcile; the port, parsing in-process, would perform
the DELETE. It is the improvement #905 wants — and it is still a change to the
precondition of a DELETE aimed at the orchestrator's own id.
**Recommend: accept, named in the shim header, both sides pinned in T131.**

**D3 — the sid match goes literal, which *fixes* D-A and D-B as a side effect.** A literal
`includes()` only ever matches NARROWER, and a real bridge carries its sid literally, so
no duplicate can be missed. Under it `orch.tor` kills only `orch.tor` and `orch[` is just
a sid instead of a dead guard. This is the tranche-2a / T5 precedent (`session-cleanup.sh`,
bridge-auditor D4) — but at those sites the consequence was an under-kill or a warning,
and here it is three unwanted `kill -9`s and a silently disarmed singleton.
**Recommend: accept the literal, declare it a FIX not a deviation, pin both sides in T131.**

**D4 — D-C (mention-is-a-bridge) reproduced, not fixed?** Rule 29 and T127 block H both
say reproduce: tightening the marker is a detection-policy change across three sites and
needs its own ticket. The counter-argument is that at *this* site the consequence is
`kill -9` against a process that was never a bridge, not a spurious HOLD.
**Recommend: REPRODUCE + pin in T131 + open the ticket** — but this is the one I most
want overridden if you disagree, because it is the only place in the pair where the
Rule-29 answer and the blast radius point in opposite directions.

**D5 — Rule 29 scope: T40 is edited.** The dispatch scopes me to the shim,
`src/orchestrator-boot/*`, **2** guards and the run-all count. T40 sources the bash and
cannot survive the port; the T52 precedent rewrites it onto `__probe`. Guard count still
goes 126 → **128** (T131 parity, T132 workspace-layout shim); T40 is edited, not added.
**Confirm that edit is in scope.**

## 9. Plan after GO

1. `src/orchestrator-boot/cli.ts` — reconcile, guard, argv, `__probe`; no `usage.ts`.
2. `bin/orchestrator-boot.sh` → shim: **no PATH hardening** (the original has none, and
   `bin/session-cleanup.sh:34-41` records what a hardcoded prefix cost in #400),
   `node-shim.sh` dist resolution, read argv, `exec`.
3. T40 re-pointed at `__probe` (A–L kept verbatim).
4. T131 parity — re-runnable against the original via
   `git show b300875:bin/orchestrator-boot.sh`, `ORCH_BOOT_PARITY_ORIGINAL=1` for the
   blocks that cannot pass against both; includes the real-ancestry block, the no-SIGTERM
   static scan, and the "no test touches a real pid" recorder discipline.
5. T132 workspace-layout shim (T128/T125 shape).
6. `EXPECTED_GUARDS` 126 → 128. Manifest untouched (no bin file added).
7. `npm test` + `bash tests/dispatch/run-all.sh` + `snyk_code_scan` → 0 new. PR, CI 4/4,
   **no merge**.

## 10. NOT checked yet (Rule 38)

The reconcile's live behaviour against the real daemon on `:3848` (deliberately — the
current orchestrator was booted by the bash version and neither implementation will be
run for real); the parallel worker's script in this pair, hence the final guard count if
I land second; `telepty` cli.js beyond the `--auto-restart` splice the bash header
already measured.
