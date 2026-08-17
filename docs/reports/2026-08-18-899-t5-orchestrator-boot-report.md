# #899 T5 report — `bin/orchestrator-boot.sh` → shim + `src/orchestrator-boot/cli.ts`

Track ob899. Branch `feat/899-t5-ob899` off `origin/main` @ b300875.
Disposition: `docs/reports/2026-08-18-899-t5-orchestrator-boot-disposition.md` (all five
§8 decisions answered GO, D4 overridden to a fix).

Nothing in this work ran either implementation for real. Every measurement below was
taken with `ps` / `kill` / `telepty` / `curl` recorder stubs. The live orchestrator's
bridge and the daemon on `:3848` were never contacted, never listed as a kill candidate
and never signalled; the only real pids that appear anywhere are the ones T131 block N
READS from `ps -o ppid=` to build its ancestry fixture, and the assertion on them is
that the guard REFUSES to kill them.

## 1. What landed

| file | what |
|---|---|
| `bin/orchestrator-boot.sh` | shim — **not** the usual `exec node …` one (§3) |
| `src/orchestrator-boot/cli.ts` | the port: reconcile, guard, argv, `__probe`. No `usage.ts` — the script has no `--help` and never had (`grep -n 'help\|usage'` on the original: no match) |
| `tests/dispatch/T40_…` | re-pointed from `source` onto `__probe`; blocks A–L unchanged |
| `tests/dispatch/T131_…parity.sh` | **new**, 14 blocks, re-runnable against the original |
| `tests/dispatch/T132_…workspace_shim.sh` | **new**, 5 blocks |
| `tests/dispatch/run-all.sh` | `EXPECTED_GUARDS` 126 → 128 |

`bin/init/manifest.mjs` untouched — no bin file was added. `bin/lib/workspace-host.sh`
untouched. `tests/dispatch/T87` untouched and still passing (§2).

## 2. Guard split and the doors

**Sourced by exactly one guard, and no production caller.** T40 did
`source "$BOOT"` and called `orchestrator_singleton_guard` /
`orchestrator_registry_reconcile` and read the `ORCH_EXEC_ARGV` array.
`grep -rnE '(^|[^a-z])(\.|source)[[:space:]]+[^[:space:]]*orchestrator-boot\.sh'` over
the tree matches documentation only. So sourceability is gone and T40 drives the three
`__probe` subcommands built for it — `singleton-guard`, `registry-reconcile`,
`exec-argv` — the T52 shape from tranche 2a. The shim routes `__probe` straight to node,
so a test seam can never reach the exec (T131 block Q, T132 block C both assert it).

**One sourced lib, one door.** `bin/lib/telepty-auth.sh` →
`bash -c '. "$1"; telepty_auth_token'`, the idiom `src/tracker/cli.ts` and
`src/cleanup/cli.ts` already use. Not re-implemented, so T87's "exactly one `authToken`
reader under `bin/`" stays literally true and its hardcoded call-site list needed no
edit. No `bin/wh-cli.sh` verb — there is no `lib/workspace-host.sh` here.

**Children, argv unchanged:** `ps -eo pid,ppid,command`, `kill -9 <pid>`,
`telepty list --json`, `curl -s -o /dev/null -w '%{http_code}' -H 'x-telepty-token: …'
-X DELETE http://127.0.0.1:<port>/api/sessions/<sid>`. **Absorbed:** `jq` ×4, `awk` ×2,
`grep`, `head` — how bash reached a JSON parser and a table scanner, never contracts.
Article 17 net: no new dependency, and `jq` stops being one (§5 D2).

## 3. The exec, and why this shim is different

The last thing this script does must be a **real process replacement**: the shell the
user's terminal launched has to *become* the bridge. That is half of #539's
self-protection (the guard runs strictly before the bridge exists) and it is what makes
"the user's terminal IS the bridge" true. Node has no `execve`, so a `telepty allow`
started from TypeScript would be a **child** and a node generation would sit in the
user's TTY forever.

So the work and the exec are split. `node dist/src/orchestrator-boot/cli.js` reconciles,
guards, logs to stderr as before, prints the exec argv on **stdout** one element per
line and exits; the shim reads it into a bash array and `exec`s it. Node is gone before
the bridge exists.

Verified on **bash 3.2.57** (macOS CI's bash): no `mapfile`/`readarray`, a here-string
read loop that runs in the shim's own shell, and `${#argv[@]}` on an empty array.

T131 block Q measures the replacement end to end rather than inspecting the source: a
wrapper records its own pid, `exec`s the boot script, and the `telepty` stub on PATH
records the pid it ends up running as. **They must be the same process** — and they are,
for both implementations.

Two consequences, both pinned:

* **stdout is a contract channel now.** No child may inherit it (`kill`, `ps`, `curl`,
  `telepty` and the credential door are all captured or ignored). T131 block R asserts
  the port's stdout is *exactly* the eight argv lines, and that the original's was
  empty. T132 block A asserts a workspace boot leaks nothing past the shim.
* **`SINGLETON_SELF_PID` default changes** from `$$` (the boot shell, which became the
  bridge) to `process.pid` (node, a child of the shim shell). The ppid walk therefore
  covers a **strict superset** of what bash protected — node plus everything above it.
  T131 block N proves it against real pids.

## 4. Contract table

| line / behaviour | pinned by |
|---|---|
| the boot ends in a real `exec` (same pid as the shell that ran it), argv `telepty allow --id <sid> --auto-restart claude --dangerously-skip-permissions --continue` | T131 **Q** |
| `--auto-restart` precedes the command word | T40 **L** |
| never kill self or any ancestor — **against real pids**, exact refusal line `skip self/ancestor bridge pid=<pid> (<sid>)` | T131 **N** |
| never kill self or any ancestor — fixture ancestry | T40 **A**, T131 **V** |
| SIGKILL only, never SIGTERM (recorder) | T40 **E** |
| SIGKILL only — static scan of the compiled implementation for signal literals and `process.kill` | T131 **P** |
| reconcile runs BEFORE the process guard | T131 **O** |
| reconcile always returns 0 — a failed pre-flight never blocks the boot | T40 **J**, T131 **X** |
| only `STALE` **and** `clients == 0` deletes; absent count ≠ zero; DISCONNECTED left alone | T40 **F–K**, T131 **X** |
| the five DELETE arms by their bytes (200 / 404 / 401 / 403 / 000 / other) | T131 **W** |
| the token is never logged (invariant 4) | T131 **W**, T132 **B** |
| `ps` / `kill` / `telepty list` / `curl` argv as argv, and `TELEPTY_PORT` honoured | T131 **Y** |
| stdout carries the argv and nothing else | T131 **R**, T132 **A** |
| jq is not a precondition for the #905 remediation | T131 **T** |
| a control-character sid is refused (D1) | T131 **S** |
| a sid metacharacter no longer over-kills (D3) | T131 **U** |
| a mention of the marker is not a bridge (D4) | T131 **V** |
| workspace layout: package dist + **workspace** credential lib + fail-loud | T132 **A/B/D/E** |
| `__probe` never reaches the exec | T131 **Q**, T132 **C** |

T131 is re-runnable against the original — the recipe is in its header, and the commit
is deliberately not referenced from the guard body (CI checks out at fetch-depth 1).
Measured both ways:

```
ORCH_BOOT_UNDER_TEST=…/.orchestrator-boot-original.sh ORCH_BOOT_PARITY_ORIGINAL=1  → T131 PASS
ORCH_BOOT_UNDER_TEST=…/.orchestrator-boot-original.sh                              → FAIL (RED)
(port, no flags)                                                                    → T131 PASS
```

## 5. Deviations and fixes (Rule 38)

**D1 — NEW REFUSAL.** `ORCHESTRATOR_SID` containing a control character exits 2 with one
stderr line naming the field, instead of booting. The argv crosses back to the shim as
newline-delimited text; a newline in the sid would split one element into two and the
shell would exec a corrupted command line. bash exec'd its own array and had no such
hazard and no such check. Exit 2 shares its code with `node-shim.sh`'s "dist not found";
the message is what tells them apart.

**D2 — DEVIATION, named.** `jq` is gone. Measured on the original with no `jq` on PATH
and a listing that was `STALE` with 0 clients: it printed *"registry reconcile SKIPPED —
the listing was not JSON (daemon/CLI version mismatch?)"* and issued **no DELETE** — the
#905 remediation was unavailable on that host, and the message blamed the daemon. The
port reconciles there. Four jq *semantics* are reproduced because they are behaviour,
not plumbing: a listing of literal `null`/`false` is "not JSON"; `.healthStatus //
.status` falls through on null **and** false; `tostring` renders a null client count as
the string `null` (an attached-client verdict, not an absent one); a non-array listing
yields "no record". All in T131 block X.

**D3 — FIXED.** The sid was a dynamic regex (`awk -v s="$ORCH_SID"` then
`$0 ~ ("telepty allow --id " s " ")`). Measured on the original: `orch.tor` SIGKILLed
**three** pids (`orchXtor`, `orch1tor` and a mention), and `orch[` died with
`awk: nonterminated character class` and then announced `singleton guard done: killed=0`
— the duplicate-bridge outcome #539 exists to prevent, reported as a success. Literal
token comparison now: 1 kill and 1 kill.

**D4 — FIXED, on the override.** The marker was a substring test over the whole
`pid ppid command` row, so any process whose command line *contained*
`telepty allow --id <sid> ` was SIGKILLed. Measured RED→GREEN on the exact scenario in
the GO:

```
fixture: 1111 ancestor bridge · 7777 real stale bridge · 8888 /bin/zsh -c pgrep -fl telepty allow --id orchestrator …
ORIGINAL: skip 1111 · SIGKILL 7777 · SIGKILL 8888  → killed=2
PORT:     skip 1111 · SIGKILL 7777                 → killed=1
```

`isOrchestratorBridge()` matches **argv shape**: the executable token must *be* telepty
(optionally behind a `node` interpreter token — `node /…/bin/telepty allow --id
orchestrator …` is the live bridge's measured shape), its first argument must be
`allow`, and `--id` must be followed by the sid as a whole token. Narrower in two
enumerated, safe-direction ways (an interpreter other than node — `env`/`sudo` — is not
recognised; `--id=<sid>` is not recognised, and bash did not match it either). Wider in
exactly one: `--id` need not sit immediately after `allow`, and the sid may be the final
token with no trailing space. **Scope is this kill path only** — the detect-only sites
that share the marker (`bin/session-reconciler.sh:415`, `src/bridge-auditor/cli.ts`,
where T127 block H pins the false positive) are unchanged and belong to **#931**.

**Not changed, on purpose:** the reconcile still returns success on every failure; every
UNKNOWN still resolves to "do not delete" (#835); DISCONNECTED is still left alone; the
reconcile still runs before the guard; a failed `ps` is still a silent `killed=0`; argv
is still ignored on the boot path (`orchestrator-boot.sh anything` still boots).

## 6. Platform branches

**Zero.** `grep -nE 'uname|OSTYPE|Darwin|Linux|sw_vers'` over the original matched
nothing at all — there was no OS arm to enumerate. `ps -eo pid,ppid,command` is the same
argv on BSD/macOS and GNU/Linux (`src/cleanup/cli.ts:301` already records it). The port
adds no `process.platform` branch. Both new guards are bash-3.2 clean and were developed
against `GNU bash 3.2.57 (arm64-apple-darwin25)`.

**PATH is deliberately not hardened** in this shim — the original never touched it, and
this is the script whose whole purpose is to exec `telepty`.
`bin/session-cleanup.sh:34-41` records what a hardcoded `/opt/homebrew/bin` prefix cost
in #400.

## 7. Rule 35 / 39

| | before (b300875) | after |
|---|---|---|
| `npm test` | 225/225 pass | 225/225 pass |
| `bash tests/dispatch/run-all.sh` | guards 126, passed 126, failed 0, skipped 3 (`T16 T48 T95`) | guards 128, passed 128, failed 0, skipped 3 (`T16 T48 T95`) |
| `npx tsc -p .` | clean | clean |
| Snyk `snyk_code_scan` (`src/orchestrator-boot`) | — | `issueCount: 0` |
| `tests/packaging/` T96 / T97 / smoke-init | — | pass (manifest 65, tarball 234; 10/10) |

Both new guards were also run under `/bin/bash` **3.2.57** explicitly, not just the
`env bash` on PATH.

**One thing CI caught that local ordering had not yet reached: `T69` §8.7** forbids
seeding the legacy registry root array anywhere in `tests/dispatch/`, and its scanner
matches the literal `printf '[]'`. T131 used that five times as a *telepty*
`list --json` fixture — a different registry entirely, but the scanner cannot tell them
apart and is right not to try. Those five sites now seed a listing holding an unrelated
worker record, which is the more realistic shape and exercises the reconcile's "no record
for this sid" arm on the way past. Fixed in `2cfcc59`; `T69` passes.

## 8. NOT checked (Rule 38)

* **Neither implementation was run against the real daemon.** The reconcile's live
  behaviour on `:3848` is untested by design: the current orchestrator was booted by the
  bash version and this task's hard constraint forbids exercising a real kill or a real
  DELETE. Every registry and process interaction here is a recorder seam.
* **Linux.** The guards are bash-3.2 clean and there is no OS branch to diverge, but
  they were run on macOS only; CI is the first Linux execution.
* **A `telepty` that is neither `telepty` nor `node …/telepty`** — a future packaging
  that invokes the bridge through `env`, `sudo` or a differently-named wrapper would not
  be recognised by the D4 shape check. Named above rather than guessed at.
* **The exec's failure code.** `exec`'s own 127 when `telepty` is missing from PATH is
  unchanged and unasserted; constructing it needs a controlled PATH that a host with a
  real `telepty` cannot be trusted to provide.
* **The parallel worker's script** in this tranche pair, and therefore the final guard
  count if that one lands second.
