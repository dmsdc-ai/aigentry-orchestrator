# #899 tranche 4 — `bin/session-comms-auditor.sh` → TypeScript: DISPOSITION

Phase 1 deliverable (ca899). Nothing is implemented yet; this is the measured plan
the implementation is held to. Every row was read out of the file or executed
against it at 31384e7, not out of prose (Rule 39).

Target re-measured — **226 lines, ONE function, ZERO sourced libs, ZERO argv
handling**. The spec's row
(`docs/specs/2026-08-16-workspace-host-port.md:501`: `226 | 1 | 2 | 4`) survives on
LOC and `src/` consumers; the other two counts and its one-word characterisation
do not:

| spec column | spec says | measured | evidence |
|---|---|---|---|
| LOC | 226 | **226** ✓ | `wc -l` |
| `src/` consumers | 1 | **1** ✓ | `src/reconciler/cli.ts:79,1292-1293` (step 0c). Prose only: `:575` |
| `bin/` consumers | 2 | **0 real** (1 comment-only) | `bin/orchestrator-bridge-auditor.sh:25` names it in a comment; nothing under `bin/` invokes it |
| tests | 4 | **2 real** + 2 comment-only | real: T45, T91. Prose: `T102:133`, `T57:11` |
| (functions) | — | **1** | `now_iso` |
| (sourced libs) | — | **0** | `grep -nE '^[[:space:]]*(\.|source)[[:space:]]'` matches nothing |
| ("jq-heavy") | jq-heavy | **zero `jq`** | one `python3` heredoc (`:56-194`) + one `python3 -c` (`:42`). The classifier is python, not jq |

Two consequences of the zeros:

* **no `bash -c '. lib; fn'` door and no `bin/wh-cli.sh` verb** — the only door is
  the `telepty` subprocess (§1);
* **the dispatch's "+usage.ts" does not survive measurement.** This script has no
  `usage()`, no `sed -n '2,Np'`, and never reads `$1`/`$@`/`$#` —
  `grep -nE '\$[1-9]|\$@|\$\*|\$#|getopts|case "\$'` matches **nothing**. `--help`
  and `bogus --x` both run a full audit pass (contract rows 15-16). There is no
  `--help` surface to move, so **no `src/comms-auditor/usage.ts` is created**, and
  none is added either — inventing a `--help` would be a contract change Rule 29
  does not license.

Dispositions, as the dispatch fixed them: **(a)** stays a subprocess, identical
argv · **(b)** subprocess door for a sourced bash lib · **(c)** in-process TS.

---

## 1. Subprocess children — `child | today | after T4 | why`

| child | today (line) | after T4 | why |
|---|---|---|---|
| `TELEPTY` (default literal `telepty`) | `:213` `"$TELEPTY" inject --submit "$orch_sid" "HOLD: …"`, both stdio to `/dev/null`, non-zero counted | **(a)** `spawnSync` identical argv (`inject`, `--submit`, `<sid>`, `<one text arg>`), stdout+stderr `ignore`, non-zero counted the same | the transport. The HOLD text stays ONE argv element, so an attacker-controlled excerpt can never become a flag or a word split |
| `python3` heredoc (`:56-194`) + `python3 -c` (`:42`) | classify · reconcile · telemetry · cursor · `now_iso` | **(c)** in-process TS | the auditor's OWN logic — regex, JSON, byte cursor, clock. Exactly the class reserved for (c). **python3 stops being a dependency of this script entirely** (unlike the scheduler, nothing here keeps it transitively: no `.py` child) |
| `mkdir -p "$SESSION_COMMS_DIR"` (`:48`) | shell | **(c)** `fs.mkdirSync(…, {recursive:true})` | shell plumbing. Its failure arm is contract — see row 27 |
| `fcntl.flock` inside the heredoc (`:138`) | claimed "flock-atomic, matching ask.sh" (`:51`) | **see D3 — this is a HOLD item** | measured NON-exclusive. §7 |

Nothing else is spawned. No `jq`, no `curl`, no `mv`, no `mktemp`, no `.py` child,
no sourced lib.

## 2. Sourced-lib functions

**NONE.** Zero `.`/`source` lines. `bin/lib/platform.sh` is not used (no `uname`
arm exists to need it — §6). T87's "exactly one `authToken` reader under `bin/`" is
untouched: this script resolves no credential.

## 3. The 2 guards — sourced vs invoked

**SOURCED: ZERO.** Measured exactly as the dispatch prescribed:

```
grep -rn '^[[:space:]]*\(\.\|source\)[[:space:]].*session-comms-auditor\.sh' tests/   → no match
```

**Consequence: T4 needs NO `__probe` subcommands** (T2c/sc899 precedent). Adding
one would also be the only argv this script has ever read.

**INVOKED as a subprocess (2)** — both keep working through the shim unchanged:

| guard | how it invokes | what it pins |
|---|---|---|
| T45 `peer_delegation_flagged` | `"$AUDITOR"` (no args), `TELEPTY` from `lib.sh:45` | 2 out-of-policy events for (raw work-order, envelope missing thread/round); HOLD text contains `orchestrator`/`HOLD`/both sids; orch-lane line NOT classified; in-policy fenced ask-request reconciled into `<pairkey>__<thread>.json`; the peer-inject log **not consumed** |
| T91 `escalations_state_only_what_they_measured` block (6) | `TELEPTY="$STUB_BIN/telepty" "$AUDITOR"` with an `inject`-always-fails stub | rc **non-zero** and stderr contains `UNDELIVERED` (#835 — an undelivered HOLD is not a clean pass) |

**Static-text assertions against the file: ZERO** (`grep -rn 'session-comms-auditor' tests/`
piped through `grep -E 'grep|wc |sed |head |awk'` → no match). Unlike T2c's
`prune-status.sh:171` `grep -q 'HOME:='`, nothing pins the shim's text, so the
`PATH` line stays in the shim for a runtime reason only (§4), not to keep a guard
green.

**Guards I expect to touch:** neither of the 2. Adds
`tests/dispatch/T122_comms_auditor_parity.sh` (new; every block re-runnable against
the ORIGINAL bash at 31384e7) and `tests/dispatch/T123_comms_auditor_workspace_shim.sh`
(new; T99/T100/T105/T111/T114/T117/T121-style two-layout dist resolution), plus
`run-all.sh` `EXPECTED_GUARDS` **120 → 122**. Counted, not trusted:
`ls tests/dispatch/T*.sh | wc -l` = **120** and the file declares **120** at
`:25` — the dispatch's correction to 120 is what is on main, so 122 is the target
and T122/T123 are free numbers.

## 4. Env seams

| seam | default | driven by | disposition |
|---|---|---|---|
| `SESSION_COMMS_DIR` | `$REPO_DIR/state/session-comms` | T45 T91 | (c). `TELE = <dir>/telemetry.jsonl`, `CURSOR = <dir>/.audit-cursor` |
| `AIGENTRY_PEER_INJECT_LOG` | `$REPO_DIR/state/dispatch/peer-injects.jsonl` | T45 T91 | (c) |
| `AUDITOR_NOW` | live UTC via `python3` | T45 T91 | (c) returned **verbatim**, no parse/reformat. Unset ⇒ `toISOString()` truncated to seconds + `Z` (measured `2026-08-17T14:41:10Z`) |
| `PEER_ROUND_CAP` | `3` | **no guard** (row 19 pins it) | (c) `int()`; used both as the `round ≤ cap` predicate and as the increment ceiling |
| `AIGENTRY_ORCHESTRATOR_SIDS` | `orchestrator aigentry-orchestrator-claude` | **no guard** (rows 20-21) | (c) whitespace-split ⇒ the ignored lane; **`${ORCH_SIDS%% *}` = first word only ⇒ the inject target** |
| `TELEPTY` | literal `telepty` | T91 (T45 via `lib.sh:45`) | (a) subprocess |
| `SCRIPT_DIR`/`REPO_DIR` | `$(dirname $BASH_SOURCE)` / `..` | every guard implicitly | `AIGENTRY_SHIM_SCRIPT_DIR`, `REPO_DIR = <that>/..`. **Load-bearing for the workspace layout**: in a control workspace `bin/` is copied out and `dist/` stays in the package, so a port that derived `REPO_DIR` from `dist/` would audit the PACKAGE's `state/`, not the workspace's. T123 pins it |
| `PATH` | hardened `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH` (`:28`) | no guard | **stays in the shim, in bash**, byte-identical (Rule 29 + dispatch.sh precedent). It is what resolves the default literal `telepty` for the node process's child, and launchd → `session-reconciler.sh` → this script runs with a minimal inherited PATH. **Named tension (Rule 38):** `bin/session-cleanup.sh:34-41` says a hardcoded `/opt/homebrew/bin` prefix here is exactly what made #400 pick a stale homebrew `telepty` against an older daemon. This script has carried that prefix and does run `telepty` — pre-existing, mentioned not changed. Both guards are immune because `lib.sh:45` exports an absolute `TELEPTY`, which wins over PATH |

Side effects that are *observable and therefore contract*, both measured:

* `[ -f "$PEER_INJECT_LOG" ] || exit 0` is at `:47`, **before** `mkdir -p` at `:48`.
  So with no peer-inject log the script exits 0 and **creates nothing** — no comms
  dir, no cursor (row 1). This is the opposite of the scheduler, whose seed ran
  before argv was looked at.
* A log path that is a **directory** fails `[ -f ]` ⇒ the same silent exit 0 (row 36).

## 5. Entrypoint contract — measured, with `pinned by`

Executed against the original bash at 31384e7 with a recording `telepty` stub;
`rc`, stdout, stderr, telemetry, state and cursor are byte-exact. `A` = the raw
work-order line `{"from":"peer-A","to":"peer-B","body":"go implement X and push"}`.
Stdout is **empty in every row** — this script's only stdout is the python `HOLD\t…`
lines, which are captured by `holds=$(…)` and never reach the terminal.

| # | invocation / input | rc | stderr | telemetry `reason` | side effect | pinned by |
|---|---|---:|---|---|---|---|
| 1 | peer-inject log absent | 0 | — | — | **nothing created** (no comms dir, no cursor) | **nothing** → T122 |
| 2 | log present, empty | 0 | — | — | comms dir + cursor `0` | **nothing** → T122 |
| 3 | `A` (inject rc 0) | 0 | — | `peer_inject_out_of_policy` | 1 HOLD: `inject --submit orchestrator "HOLD: peer-lane out-of-policy inject \| from: peer-A \| to: peer-B \| excerpt: go implement X and push"`; cursor 74 | T45 (partial) |
| 4 | `A`, inject rc 1 | **5** | `HOLD UNDELIVERED to 'orchestrator' (from=peer-A to=peer-B) — …` + `1 escalation(s) undelivered` | as above | cursor **still 74** | **T91** |
| 5 | in-policy fenced JSON ask-request | 0 | — | `peer_ask_reconciled` | `peer-A__peer-B__th1.json` `rounds:1`, `parties` sorted, `status:open`, `escalated:false`, `last_kind:"ask-request(reconciled)"`, `last_round_at:<NOW>`; **no HOLD** | T45 (file exists only) → fields T122 |
| 6 | `from: orchestrator` | 0 | — | **no telemetry at all** | cursor advanced only | T45 (negative) |
| 7 | tick twice over the same log | 0 | — | no second event | cursor idempotence | **nothing** → T122 |
| 8 | log shrank between ticks (rotation) | 0 | — | re-classified from byte 0 | `start > size ⇒ start = 0` | **nothing** → T122 |
| 9 | markdown `ASK_REQUEST: … \| round: 2 \| q: …` | 0 | — | `peer_ask_reconciled` | thread `th9`, `rounds:1` (**the +1 is 0→1, not to the envelope's `round`**) | **nothing** → T122 |
| 10 | markdown `ASK_REPLY:` | 0 | — | `peer_ask_reconciled` | `rounds:0`, `last_kind:"ask-reply(reconciled)"` | **nothing** → T122 |
| 11 | `round: 4` with cap 3 | 0 | — | `peer_inject_out_of_policy` | HOLD excerpt is the whole raw JSON body | **nothing** → T122 |
| 12 | `not json` + blank + `   ` + `A` | 0 | — | one event (for `A`) | the 3 junk lines skipped | **nothing** → T122 |
| 13 | record with **no** `from`/`to` | 0 | — | `…out_of_policy` with `from:""`, `to:""`, `pairkey:""` | **HOLD text is GARBLED** — see D2 | **nothing** → T122 |
| 14 | `body` is a JSON **object** | 0 | — | excerpt `{'kind': 'ask-request'}` (python `str(dict)`) | HOLD sent | **nothing** → T122, D4 |
| 15 | `--help` | 0 | — | full audit pass | argv ignored | **nothing** → T122 |
| 16 | `bogus --x` | 0 | — | full audit pass | argv ignored | **nothing** → T122 |
| 17 | two in-policy requests, same thread | 0 | — | 2 × `peer_ask_reconciled` | `rounds:2` | **nothing** → T122 |
| 18 | in-policy `ask-reply` | 0 | — | `peer_ask_reconciled` | `rounds` **not** incremented | **nothing** → T122 |
| 19 | `PEER_ROUND_CAP=1`, two requests | 0 | — | 2 events | `rounds` stops at **1** (`st["rounds"] < cap` ceiling) | **nothing** → T122 |
| 20 | `AIGENTRY_ORCHESTRATOR_SIDS="boss backup"` | 0 | — | `…out_of_policy` | inject target is **`boss`** (first word) | **nothing** → T122 |
| 21 | `from: aigentry-orchestrator-claude` | 0 | — | none | second default orch sid is also the ignored lane | **nothing** → T122 |
| 22 | body `"A\tB\n\n  C " + "x"×200` | 0 | — | excerpt `A B C xxx…` | whitespace collapsed then **truncated to 120 chars**, in that order | **nothing** → T122 |
| 23 | two out-of-policy, both refused | **5** | 2 × `HOLD UNDELIVERED` + `2 escalation(s) undelivered` | 2 events | both HOLDs attempted | T91 (count: T122) |
| 24 | last line has no trailing `\n` | 0 | — | 1 event | cursor 73 = full size | **nothing** → T122 |
| 25 | cursor file contains `garbage` | 0 | — | 1 event | `except ⇒ start = 0` | **nothing** → T122 |
| 26 | per-thread state file contains `not json` | 0 | — | `peer_ask_reconciled` | **silently replaced** with a fresh `rounds:1` record — fail-OPEN | **nothing** → T122, §7 note |
| 27 | `SESSION_COMMS_DIR` under a regular file | **1** | `mkdir: …: Not a directory` | — | nothing written | **nothing** → T122 (rc + non-empty stderr only; the message is `mkdir`'s and localizable — T116/sc899 row 6 precedent) |
| 28 | `TELEPTY` points at a missing binary | **5** | `HOLD UNDELIVERED …` | 1 event | cursor advanced | **nothing** → T122 |
| 29 | envelope `from` ≠ record `from` | 0 | — | `…out_of_policy` | the §2.3 identity check | **nothing** → T122 |
| 30 | `"round":"1"` (string) | 0 | — | `…out_of_policy` | `isinstance(rnd, int)` | **nothing** → T122 |
| 31 | `"thread_id":"899/t4"` | **1** | python `FileNotFoundError` traceback | 1 event flushed, then **abort** | **cursor NEVER written** — see **D1** | **nothing** → T122 |
| 32 | `"round":0` | 0 | — | `…out_of_policy` | `rnd < 1` | **nothing** → T122 |
| 33 | `"round":true` | 0 | — | **`peer_ask_reconciled`** | `isinstance(True, int)` is True in python and `1 ≤ 1 ≤ 3`, so a boolean round is IN policy | **nothing** → T122 |
| 34 | line is a JSON **array** | **1** | python `AttributeError: 'list' object has no attribute 'get'` | none | **cursor NEVER written** — see **D1** | **nothing** → T122 |
| 35 | `AUDITOR_NOW` unset | 0 | — | `ts` = live UTC, seconds precision, `Z` | — | **nothing** → T122 |
| 36 | log path is a **directory** | 0 | — | — | nothing created | **nothing** → T122 |

Ordering that is contract: the pass **classifies every line, writes the cursor,
then prints the holds**; the shell delivers HOLDs afterwards. So every telemetry
line and the cursor are committed *before* the first inject is attempted, which is
precisely why an undelivered HOLD is unrecoverable (`:201-207`, #835) and why rc 5
is the only surviving signal.

**33 of 36 rows are pinned by NOTHING today.** Both existing guards together assert
one HOLD's substrings, two telemetry reasons, one state file's existence and one
non-zero rc. T122 is where the rest becomes contract.

## 6. Platform branches

**Zero `process.platform` branches planned.**
`grep -nE 'uname|os_type|Darwin|Linux|pmset|ioreg|platform\.sh|sw_vers'` over the
file matches **nothing** — it has no OS arm to enumerate. Candidates and where each
actually lives: `mkdir -p` → `fs.mkdirSync({recursive:true})` (same on both) ·
`os.replace` → `fs.renameSync` · UTC clock → `toISOString()` · byte offsets →
`fs.statSync().size` (no text-mode translation on POSIX; the file is opened as
bytes) · `fcntl.flock` → §7 D3 · the hardcoded `/opt/homebrew/bin` prefix is a
macOS-shaped *string*, not a branch, and stays in the shim byte-identical. Rule 26
holds with no branch to name, same as T1/T1b/T2a/T2c/T3a/T4.

## 7. Latent defects — this is the HOLD

All four were executed against the ORIGINAL bash at 31384e7. All four are
pre-existing; none is caused by the port. Rule 29 says reproduce and report — for
D1 and D3 "reproduce" has a cost I will not decide alone.

### D1 — ONE untrusted log line permanently disables the guardrail and turns it into a HOLD spam loop **(security / availability, trust boundary)**

Fixture: a real violation, then one poison line, then a second violation. Three
consecutive ticks, then a fresh violation appended:

```
tick 1: rc=1  cursor=ABSENT/151  telemetry_lines=1
tick 2: rc=1  cursor=ABSENT/151  telemetry_lines=2
tick 3: rc=1  cursor=ABSENT/151  telemetry_lines=3
AttributeError: 'list' object has no attribute 'get'      # <stdin> line 115
--- was the violation AFTER the poison ever audited? --- 0
--- a brand-new violation, appended, one tick later ---   rc=1  audited: 0
```

Two independent poison shapes reproduce it, both reachable from the peer-inject
log without authentication:

* **a line that is valid JSON but not an object** — `json.loads` succeeds, so the
  `try/except` at `:167-170` (which exists precisely to skip bad lines) does not
  fire; `rec.get` raises one line later (`:171`);
* **`thread_id` containing `/`** — `reconcile()` builds
  `os.path.join(comms_dir, "%s__%s.json" % (pairkey, thread))` (`:135`) from the
  envelope, so `"899/t4"` becomes
  `…/session-comms/p-A__p-B__899/t4.json` and `os.open` raises `FileNotFoundError`.
  `bin/ask.sh:179` builds the same path from an unvalidated `--thread`, so a
  human typing a slashed thread name is enough.

Because the traceback escapes the heredoc, `holds=$(…)` fails under `set -e` and
the script dies **before `:189` writes the cursor**. The consequences compound:

1. **the guardrail is permanently dead** — every later peer→peer inject, in-policy
   or not, is never classified, never counted, never escalated. Forever, until a
   human notices;
2. **the pre-poison violation is re-escalated on every tick** — 1 duplicate
   telemetry line and 1 duplicate HOLD inject into the orchestrator inbox **every
   60 s**, indefinitely (telemetry grew 1→2→3 above). The inbox the entire HOLD
   mechanism depends on is the thing that gets flooded;
3. **nothing says so.** `src/reconciler/cli.ts:1293` calls it through `runQuiet`
   (stdout+stderr `ignore`) and folds any non-zero into one
   `ERR comms-auditor non-zero (continuing)` line in the reconciler log.

So one malformed line, or one slash in a thread name, silently converts the
peer-lane guardrail from "watching" to "dead and paging you about the same stale
violation once a minute". An attacker who wants an unaudited peer lane needs one
inject to get it.

* **(i) reproduce it** — port the crash: a non-object line and a slashed
  `thread_id` must still abort the pass and leave the cursor unwritten.
* **(ii) fault-isolate the per-record loop** (**my recommendation**) — wrap each
  record's classify+reconcile in a `try/catch`; on an unexpected throw emit one
  telemetry line naming the skip (`reason:"peer_audit_record_skipped"`) and
  continue; **the cursor still advances at the end of the pass**. Plus one line in
  `in_policy`: a `thread_id` containing `/` (or equal to `.`/`..`) is **not a valid
  thread_id**, so the record is out-of-policy → telemetry + a HOLD naming it. That
  second half is not belt-and-braces — it makes the state path structurally unable
  to leave `SESSION_COMMS_DIR`, and it is semantically *right*: an envelope whose
  thread id would escape the state dir is exactly the malformed envelope this
  auditor exists to flag. Nothing is taken away, because that input crashes today.
  Rows 1-30 and 32-36 of §5 are unchanged; rows 31 and 34 become `rc 0` + a
  recorded skip / a HOLD.
* (iii) validate the whole log line-by-line up front and refuse the pass — rejected:
  same permanent stall, just louder.

Reasoning for (ii): Rule 29 protects behaviour a caller may depend on. No caller
depends on the auditor dying; `src/reconciler/cli.ts:1293` is written to *tolerate*
non-zero, which is the opposite of depending on it. And the dispatch's own "shim
fails loud, never half-works" points the same way — a warn-mode auditor that
silently stops warning is the half-working state. Deliberately re-implementing a
remote kill switch in new code is the kind of scope call the envelope reserves for
you.

### D2 — an empty `from` or `to` shifts the HOLD's fields, so the HOLD names the wrong thing

Row 13, measured:

```
telemetry: {… "from": "", "to": "", "pairkey": "", "excerpt": "orphan body"}
inject:    HOLD: peer-lane out-of-policy inject | from: orphan body | to:  | excerpt:
```

`holds` lines are `"\t".join(["HOLD", rec_from, rec_to, excerpt])` (`:187`) and are
read back with `IFS=$'\t' read -r _tag h_from h_to h_excerpt` (`:211`). **Tab is an
IFS *whitespace* character, so consecutive tabs collapse into one delimiter** —
with an empty `from` and `to`, four fields arrive as two and the excerpt lands in
`from`. Telemetry is correct; only the operator-facing HOLD is wrong. No data loss,
no security exposure, nothing crashes.

**REPRODUCED, not fixed** (Rule 29) — T122 pins the garbled text verbatim, and the
shim header names it. Fixing it means changing the HOLD wire text, which is
`bin/session-comms-auditor.sh`'s contract with a human reader, and the
`from`-less record it needs is not a shape telepty's log is known to write.

### D3 — the `flock` is decorative: it serialises and still loses the update **(HOLD item — it decides the port's locking)**

`:51` claims "flock-atomic, matching ask.sh". Measured against the original bash,
3/3 identical runs — a peer writer holding the lock for 2 s, the auditor ticking
0.5 s in, each doing exactly one `rounds += 1`:

```
auditor rc=0  blocked_for=1.53s        # it DID wait on the lock
final state:  "rounds": 1              # expected 2; "writer":"peer" is GONE
```

Mechanism: both sides `os.open` the state file, `flock(LOCK_EX)` it, read, write a
tmpfile, then `os.replace(tmp, path)` (`:136-157`, and `bin/ask.sh:196-248` is the
same shape). **`os.replace` swaps the inode.** The waiter is queued on the *old*
inode, so when the holder releases, the waiter reads the now-orphaned file — the
pre-increment content — and its own `os.replace` overwrites the committed update.
The lock buys a 1.5 s wait and no exclusion. The property the comment claims does
not exist, on either side.

This matters for the port because **node core has no `flock(2)`** — the repo's
documented answer is already written down at
`src/session/persistence/index-lock.ts:1-6` ("Node.js core lacks fs.flock(2);
Article 17 무의존 wins over a precise flock(2) match").

* **(i) keep a `python3 -` subprocess door for `reconcile()` only** — faithfully
  reproduces a lock that measurably does not work, and keeps python3 as a runtime
  dependency of a script that would otherwise shed it.
* **(ii) in-process TS, tmp + `renameSync`, no lock** (**my recommendation**) —
  identical observable behaviour (same file bytes, same fields, same ordering, same
  narrow lost-update window), one less dependency, and the `blocked_for` wait is
  unobservable to every caller. The shim header names the deviation and points at
  the real fix.
* (iii) add a *correct* sidecar `<state>.lock` (`O_EXCL`, the `index-lock.ts`
  pattern) in the TS port — **rejected, and this is the interesting one.** It would
  exclude concurrent auditor passes (there is one tick at a time, so: nothing) and
  would **not** exclude `bin/ask.sh`, which locks the state file itself. A correct
  lock on one side of a two-writer race buys zero and reads like a fix. The real
  fix is one ticket that changes `bin/ask.sh` and the auditor **together** — either
  lock a sidecar on both sides, or lock-then-write-in-place on both. `bin/ask.sh`
  is outside this task's Rule 29 surface.

### Not a separate defect, same family, **no change proposed**

`reconcile()`'s `except Exception: st = {}` (`:140-141`) means a hand-corrupted
`<pairkey>__<thread>.json` is **silently replaced** with a fresh `rounds:1` record
(row 26) — the fail-OPEN that T76 forbids for `active.json`, here resetting a round
counter that exists to cap peer traffic. Reproduced as-is; noted for D3's ticket,
since the same `except` is in `bin/ask.sh:200-201` and fixing one side alone just
moves which process resets the counter.

### D4 — not a defect, a NAMED DEVIATION (Rule 38): the excerpt of a **non-string** body

Row 14: `body` is a JSON object, and `" ".join(str(body).split())` renders python's
`repr` — `{'kind': 'ask-request'}`, single quotes. JS cannot reproduce that class in
general: `JSON.parse` collapses `1.0` and `1` to the same number, so `str()`'s
`"1.0"` is unrecoverable, and faking the dict/`True`/`None` cases while silently
missing floats would be a worse lie than one documented line.

**Disposition: string bodies — the only shape telepty's log is known to write, and
every shape both guards and rows 3-13/15-36 exercise — are byte-identical. A
non-string body is rendered `JSON.stringify`-style (`{"kind":"ask-request"}`)
instead of python-repr.** Named in the shim header; T122 pins the string cases
exactly and pins the non-string case to the TS form with the reason inline. Flagged
here rather than asked, because it changes no reachable behaviour — say the word if
you want it reproduced instead and I will emulate `repr` for everything except
integral floats.

## 8. Deliverable file list (Rule 29 surface)

`bin/session-comms-auditor.sh` (→ exec shim over `bin/lib/node-shim.sh`) ·
`src/comms-auditor/cli.ts` (new; **no `usage.ts`** — §0) ·
`tests/dispatch/T122_comms_auditor_parity.sh` + `T123_comms_auditor_workspace_shim.sh` (new) ·
`tests/dispatch/run-all.sh` (`EXPECTED_GUARDS` 120 → 122) ·
`.github/workflows/ci.yml:70` (`timeout-minutes: 4` → `8`, that step only, the one
authorised extra) · this file.

**No manifest change**: `bin/init/manifest.mjs:47` already ships
`bin/session-comms-auditor.sh` and no bin file is added.
**NOT touched**: `bin/lib/workspace-host.sh` (T3b declined) · `bin/ask.sh` (D3's and
the fail-OPEN's other half belong to their own ticket) ·
`src/reconciler/cli.ts` (argv and env are unchanged, so step 0c needs no edit) ·
`bin/orchestrator-bridge-auditor.sh` (comment-only reference).

## 9. HARD constraints acknowledged

Worktree only (`~/.aigentry/worktrees/ca899`, `feat/899-t4-ca899`, branched from
`origin/main` @ 31384e7). Merge is a live deploy: `src/reconciler/cli.ts:1292-1293`
runs this script every 60 s from launchd against the main checkout, with `TELEPTY`
in the child env and no argv. The production daemon on :3848,
`~/.telepty/config.json`, the `orchestrator` session and launchd are untouched.
This script **does** contact the daemon (unlike the scheduler), so hp899's leak
class is live here — both new guards therefore use `lib.sh`'s temp state dir and
its absolute-path `TELEPTY` recorder stub (`lib.sh:45`), which is also what keeps
the shim's hardened `/opt/homebrew/bin` prefix (§4) from reaching the real
`/opt/homebrew/bin/telepty` that exists on this machine. Branch + PR, CI 4/4, **no
merge**.

## 10. Baseline BEFORE (Rule 35)

`npm test` → **225 pass / 0 fail**. `bash tests/dispatch/run-all.sh` →
**guards 120, passed 120, failed 0, skipped 3 (T16 T48 T95)**, 10m54s wall on this
loaded workstation. `npx tsc -p .` → clean. Target after: **122/122**, skips
unchanged.
