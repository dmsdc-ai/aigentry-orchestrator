# #899 T5 disposition — `bin/orchestrator-report-target.sh` → exec shim + `src/report-target/cli.ts`

Track `rt899`. Worktree `~/.aigentry/worktrees/rt899`, branch `feat/899-t5-rt899`, base
`b300875`. Nothing implemented yet — this is the Phase-1 measurement, per the [SAWP]
envelope. **Two decisions are blocking (§8); both are "reproduce or fix", and my
recommendation on both is REPRODUCE, so a plain GO is a real answer.**

Baseline BEFORE (this worktree, unmodified): `npx tsc -p .` clean, `npm test`
**225/225 pass, 0 fail**. `tests/dispatch/run-all.sh` still running at write time;
recorded in the report.

**Guard count is measured, not assumed**: `ls tests/dispatch/T*.sh | wc -l` = **126** on
`b300875`, `EXPECTED_GUARDS=126` (`tests/dispatch/run-all.sh:25`) — they agree. Highest
existing number is **T128**, so T129/T130 are free, as dispatched.

---

## 1. Guard split — sourced vs invoked

`grep -rnE '^[[:space:]]*(\.|source)[[:space:]].*orchestrator-report-target' .` →
**zero matches**, repo-wide. **So there is NO `__probe` surface** — same as tranches 4
and the other two T5 ports.

Every consumer is a subprocess:

| consumer | shape |
|---|---|
| `src/dispatch/cli.ts:595-597` | **production, the only one.** `isExecutable(REPORT_TARGET_SH)` then `capture(REPORT_TARGET_SH, [])` — **no argv**, needs `status === 0` **and** non-empty stdout, else refuses the dispatch (#690 fail-closed) |
| `tests/dispatch/T67:36,40` | `"$RESOLVER"` direct, with `CURL` stubbed |
| `tests/dispatch/T92:73,123` | `env … bash "$RESOLVER"` — note it invokes through `bash`, which an exec shim still satisfies |
| `bin/init/manifest.mjs:44` | ships the file into a control workspace |

Nothing under `bin/` invokes it (`bin/dispatch-tracker.sh:14` only *names* it in a
comment). `bin/lib/workspace-host.sh` is untouched, as dispatched.

**`isExecutable` is a hard constraint on the port**: the shim must stay mode 755, or
`prepare_effective_ref` skips the resolver entirely and every dispatch carrying
`{{ORCHESTRATOR_REPORT_TARGET}}` fails closed.

## 2. Sourced libs → doors

The script sources **nothing** (zero `.`/`source` lines). So, as in tranches 4/5: no
`bash -c '. "$1"; fn "$2"'` door, no `bin/wh-cli.sh` verb. Nothing to open.

## 3. Subprocess children

**Stay children, byte-identical argv:**

| child | argv | why it stays |
|---|---|---|
| `$CURL` (`:90-92`) | `-s -o /dev/null -w %{http_code} --connect-timeout 1 --max-time 2 http://<h>:<port>/api/meta` | `CURL` is the documented seam, precedent `src/tracker/cli.ts:56,604` (`env.CURL \|\| "curl"` + `capture`). Node has no HTTP client that reproduces "any answer counts, including a TCP-level refusal" as cheaply, and the 1s connect ceiling is a stated cost property |
| `$REPORT_TARGET_IFACE_CMD` (`:107`) | none — invoked as a bare command word | the T92 seam. Bash runs it **unquoted-single-word**: a value with a space is *not* split into cmd+args, it is looked up as one filename and fails. Measured (§7 D3) |
| `ifconfig` (`:108`) | none | see below |
| `ip` (`:108`) | `-o -4 addr show` | see below |

**Nothing is absorbed in-process.** There is no `python3`, no `node -e`, no `date`, no
`mktemp` here. `grep -Eo` / `head -n1` / `command -v` become in-process string work
(they were how bash reached a regex, never a contract).

### The one judgement call: `ifconfig`/`ip` stay subprocesses, `os.networkInterfaces()` is NOT used

Node ships a native interface lister, so the ponytail ladder says use it. **I am not**,
and the reason is the seam, not nostalgia:

`REPORT_TARGET_IFACE_CMD` must keep accepting an arbitrary executable whose **stdout is
parsed** — that is the only way T92 pins address selection hermetically. If the default
path used `os.networkInterfaces()` while the seam path used the text parser, there would
be **two selection algorithms**, and every guard would exercise the one production never
runs. A test that cannot fail for the production path is worse than no test. So: one
algorithm, text in, first CGNAT match out, and the seam substitutes the *source* of that
text — exactly as bash does.

Consequence to name: the port runs `ifconfig` **and** `ip -o -4 addr show`
unconditionally when the seam is unset, on every platform, on every dispatch — two spawns
whose stderr is discarded and whose absence is silently empty. That is bash's behaviour,
byte for byte, and I measured that errexit does **not** stop `ip` after `ifconfig` exits
non-zero (the whole group is the left operand of `|| true`, which suppresses `set -e`
inside it). On this machine: `ifconfig` present, `ip` absent.

## 4. Env seams

| var | default | who sets it today |
|---|---|---|
| `AIGENTRY_ORCHESTRATOR_SID` | `orchestrator` | operator only — **no repo caller** |
| `AIGENTRY_ORCHESTRATOR_HOST` | *(empty ⇒ auto-detect)* | operator only — **no repo caller**; grepped the whole tree |
| `TELEPTY_PORT` | `3848` | fleet-wide; used in the probe URL **and inside both note texts** |
| `CURL` | `curl` | T67:33, T92:72 |
| `REPORT_TARGET_IFACE_CMD` | *(empty ⇒ `ifconfig` + `ip`)* | T92:72 |

All five survive with identical defaults. **No seam disappears** — unlike inject-handler,
nothing here pointed at a JS path, so there is no `INJECT_PARSER_JS`-shaped deviation.
`${TELEPTY_PORT:-3848}` ⇒ `env.TELEPTY_PORT || "3848"` is exact: measured that an
**empty** `TELEPTY_PORT` falls back to 3848, which `||` reproduces and `??` would not.
Same for `AIGENTRY_ORCHESTRATOR_HOST=` (empty) ⇒ auto-detect branch, measured.

## 5. Contract lines (what the port must keep byte-identical)

**`rc` is 0 on every path.** There is no error arm at all. T92's `run()` fails the whole
guard on any non-zero, because `src/dispatch/cli.ts:597` treats non-zero as unresolvable
and blocks the dispatch.

**stdout is exactly one line**, one of two forms: `<sid>` or `<sid>@<host>`.

| # | condition | stdout | stderr | pinned by |
|---|---|---|---|---|
| 1 | explicit host, answers | `<sid>@<host>` | *(empty)* | T92 (4), T67 (1) |
| 2 | explicit host, silent | `<sid>@<host>` | `…HOST=<h> does not answer on port <p>; honouring it because you set it explicitly, but reports sent there will go nowhere until the daemon listens on it.` | T92 (3) |
| 3 | explicit host, cannot probe | `<sid>@<host>` | `cannot probe …` | **nothing** → T129 |
| 4 | auto CGNAT, answers | `<sid>@<ip>` | *(empty)* | T92 (1) |
| 5 | auto CGNAT, silent | `<sid>` | `auto-detected tailnet address <h> does not answer on port <p> — falling back to the bare '<sid>', which resolves locally. Cross-machine workers have no working report target while that listener is down.` | T92 (2) |
| 6 | auto CGNAT, cannot probe | `<sid>@<ip>` | `cannot probe <h> (no '<CURL>' available) — keeping the tailnet form unverified; an absent measurement is not a negative one.` | T92 (5) |
| 7 | no candidate | `<sid>` | *(empty)*, **and zero probes** | T92 (6) |
| 8 | any HTTP code = answered (401/403/500) | `<sid>@<ip>` | — | T92 (7) |
| 9 | stdout single clean line, no space, no `orchestrator-report-target:` prefix leak | — | — | T92 (8) |

Every note is prefixed `orchestrator-report-target: ` (`:74`) and goes to **stderr only**
— measured, and it matters: `src/dispatch/cli.ts` seds stdout straight into a ref.

**No `--help`, and no argv handling at all.** Measured:
`bin/orchestrator-report-target.sh --help --nonsense foo` resolves the target and exits 0.
There is nothing to slice with `sed -n`, no flag parser, no `unknown flag` arm. **So there
is NO `src/report-target/usage.ts`** — the dispatch's "only if the script has `--help`
(measure)" measures to *no*.

### What T129 must add (unpinned today, so a port could drop it in silence)

* the curl **argv itself** — T92's stub appends `"$*"` to a log but only ever counts the
  log's lines; flags, timeouts and the `/api/meta` path are all free to change unnoticed,
  and the connect ceiling is the script's stated cost contract;
* **exactly one probe, no retry** (T92 asserts `≥1` and `==0`, never `==1`);
* the default sid `orchestrator` (both guards always override it);
* `TELEPTY_PORT` honoured in the URL **and in both note texts**;
* row 3 — explicit host + unprobeable (T92 (5) covers the auto path only);
* argv is ignored entirely;
* `AIGENTRY_ORCHESTRATOR_HOST=` (empty) selects auto-detect, not the explicit branch;
* the dual-lister scan: seam unset ⇒ `ifconfig` **then** `ip -o -4 addr show`, both run,
  stderr suppressed, one failing does not stop the other;
* the CGNAT bounds: `100.63.x.x` rejected, `100.64` / `100.127` accepted, `100.128`
  rejected, and **first match wins** across multiple candidates.

## 6. Platform branches

The bash has **zero** OS arms — no `uname`, no `$OSTYPE`, no darwin/linux fork
(enumerated: the only OS-adaptivity is running both listers and letting the absent one
produce nothing). So the port carries **zero** `process.platform` branches.

## 7. Latent defects (measured, reproduced)

**D1 — the CGNAT regex is unanchored, so a longer digit run can synthesise an address
that is on no interface.** `grep -Eo '100\.(6[4-9]|…|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}'`
has no boundary assertion at either end. REPRODUCED: a scan line
`inet6 fe80::9100.72.1.1234` yields **`100.72.1.123`** — a host that exists nowhere.
Self-limiting in practice, because the probe then almost certainly says `silent` and the
auto path falls back to the bare sid; it only bites if the synthesised address happens to
answer on 3848. **Reproduce, name for a ticket** — it is not data-loss and not a trust
boundary (the input is this machine's own `ifconfig`).

**D2 — a newline in either override makes stdout multi-line, and the extra line lands in
every worker's ref.** REPRODUCED: `AIGENTRY_ORCHESTRATOR_HOST=$'1.2.3.4\nEVIL-LINE'` →
two lines, `sid@1.2.3.4` / `EVIL-LINE`; `AIGENTRY_ORCHESTRATOR_SID=$'sid\nEVIL'` likewise.
`src/dispatch/cli.ts:597` strips **trailing** newlines only
(`r.stdout.replace(/\n+$/,"")`), so an embedded one survives into the substituted ref —
and this value is the address every dispatched worker is told to report to, so a
corrupted one misroutes the whole fleet, which is exactly the failure mode #690 exists to
prevent. **Not a trust boundary**: I grepped the tree and *nothing* sets either var — they
are operator-only, same trust level as the operator. T92 (8) already forbids this shape
for the auto path; the explicit path is simply unguarded. See §8a.

**D3 — the interface seam cannot carry arguments.** `"$IFACE_CMD" 2>/dev/null` is one
quoted word, so `REPORT_TARGET_IFACE_CMD="/path/lister extra-arg"` is looked up as a
single filename, fails, and the scan comes back empty ⇒ bare sid. REPRODUCED. This is
correct-by-construction for a seam (no word splitting) and I will reproduce it exactly —
naming it because a TS port using `spawnSync(cmd, {shell:true})` or splitting on spaces
would quietly *add* an argument-injection surface that bash does not have.

**D4 — the stderr notes reach nobody in production.** `capture()`
(`src/dispatch/cli.ts:54-61`) uses `spawnSync` defaults, i.e. stderr is **piped and never
read**. So "cross-machine workers have no working report target while that listener is
down" — the entire point of the #835 fix, and the thing T92 (2) exists to protect — is
swallowed by the only production caller. The measurement is right and its report goes
into a void. **Fixing it means editing `src/dispatch/cli.ts`, which is outside this
task's Rule 29 scope.** See §8b.

**D5 — `command -v` gates the probe, and a non-executable `$CURL` counts as absent.**
Measured: `command -v <non-executable path>` → not found → the `unknown` arm. The port
maps any `spawnSync` `error` (ENOENT **or** EACCES) to `unknown`, which is the same
observable behaviour; the only divergence is that bash never attempts the exec and the
port does, which produces no output, no side effect and no probe-log entry. Named, not a
defect.

## 8. Blocking — two decisions

**(a) D2: reproduce the multi-line output, or refuse it?**
The standing rule sends data-loss/security-at-a-trust-boundary to a fix and everything
else to a reproduction. D2 is **not** at a trust boundary — nothing but an operator can
set those vars — so by the rule it reproduces. But the consequence is fleet-wide report
misrouting, and the cost of refusing is one line.

* **Recommendation: REPRODUCE**, and name it in the shim header. An operator who types a
  newline into `AIGENTRY_ORCHESTRATOR_HOST` has bigger problems, and "the operator stated
  the fact, we honour it loudly" is this script's whole documented posture (`:33-40`) —
  silently rewriting their value would contradict the behaviour T92 (3) protects.
* If you prefer the belt: refuse a sid/host containing a newline, space or NUL — one
  stderr note, **exit 0 with the bare `<sid>`** for the auto path, and for the explicit
  path exit **non-zero** so dispatch fails closed rather than injecting a corrupt target.
  That is a contract change (a new non-zero arm on a script that has none), so T129 would
  need the `REPORT_TARGET_PARITY_ORIGINAL=1` flag for that block. Say the word and I do it.

**(b) D4: file it, or widen scope by one line into `src/dispatch/cli.ts`?**
The fix is `capture()` → `stdio: ["ignore","pipe","inherit"]` for this one call (the
`captureOut` helper at `cli.ts:64` already exists and does exactly that), so the resolver's
note reaches the dispatching operator's terminal. Two lines, one existing helper, no new
code.

* **Recommendation: FILE IT, do not widen.** `src/dispatch/cli.ts` is not in my Rule 29
  scope, it is a live path with its own guards, and a parallel worker is in this tranche.
  I will name it in the shim header and in the report as a ticket.
* If you GO the widening instead, I will add it with a T129 block that asserts the note
  reaches dispatch's stderr, and list the file in the report's scope table.

**Neither decision changes the port's shape.** As proposed (reproduce both), the port has
**zero behaviour changes**, so T129 is a pure characterization guard that passes against
the ORIGINAL bash at `b300875` and against the port with **no parity flag at all** — the
flag only appears if you GO (a).

## 9. Plan after GO

`bin/orchestrator-report-target.sh` → exec shim over `bin/lib/node-shim.sh` (mode 755
preserved); `src/report-target/cli.ts`; **no `usage.ts`** (§5). **T129** parity/
characterization (`REPORT_TARGET_UNDER_TEST` seam so it re-runs against the original
bash, T127's shape), **T130** workspace-layout shim (T125's shape); `EXPECTED_GUARDS`
126 → 128 in `tests/dispatch/run-all.sh`. **No manifest change** — no bin file is added,
and `bin/lib/node-shim.sh` (`manifest.mjs:34`) plus
`bin/orchestrator-report-target.sh` (`:44`) are both already shipped.
T67 and T92 stay untouched and must keep passing against the port.
Guards must run on bash 3.2 — no arrays, no `${x^^}`, no `mapfile`.
