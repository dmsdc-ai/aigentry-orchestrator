# #899 tranche 3 — `bin/lib/workspace-host.sh` + `bin/open-session.sh` → TypeScript: DISPOSITION + SEQUENCING SPEC

**Status:** SPEC ONLY. No code, no `bin/`/`src/` edit, no merge. The user reads this
and decides go/no-go; implementation is a later dispatch.

**Measured:** 2026-08-16 against `origin/main` @ `cf7c0ea`, in worktree
`~/.aigentry/worktrees/ws899` (branch `docs/899-t3-workspace-host-spec`). Every
number below is re-measured today (Rule 39), not carried from the dispatch.

**HARD constraints honoured:** no cmux/warp actuation run, `open-session.sh` never
executed, launchd/`:3848`/`orchestrator` untouched. The only thing run was the
subset of the guard suite that needs neither `dist/` nor a live surface (§3.5).

---

## 0. The measurement table (everything downstream rests on these)

| What | Measured | How |
|---|---|---|
| `bin/lib/workspace-host.sh` | **1000 lines total, 563 code lines, 437 comment/blank** | `grep -vcE '^\s*(#\|$)'` |
| Functions defined | **69** | `grep -cE '^[a-zA-Z_][a-zA-Z0-9_]*\(\)'` |
| `cmux` mentions | **100** (19 on code lines) | `grep -c cmux` |
| Adapter selection | `AIGENTRY_WORKSPACE_HOST=cmux\|warp\|headless` at `:8-11`, resolved at `:914-928` | read |
| Public verb surface | **10** (`wh_open lookup close alive list_ids focus prune_orphans set_status clear_status close_for_sid`) | `declare -F \| grep '^wh_'` |
| Files that **source** the lib | **11** — `bin/open-session.sh`, `bin/wh-cli.sh`, guards T23 T25 T27 T33 T53 T54 T55 T104, `tests/workspace-host/prune-status.sh` | grep, incl. `$LIB` indirection |
| Files that **mention** it | 46 (repo-wide, incl. docs) | grep |
| Bash under `bin/` | **31 files** — 24 top-level `*.sh` (5 of them exec shims) + 7 in `bin/lib/` | `find` |
| Reconciler tick interval | **60 s** (`RECONCILER_LOOP_INTERVAL` default, `src/reconciler/cli.ts:1194`) | read |
| Reconciler ticks logged | **35 039** (2026-05-28 → 2026-08-16) | `wc -l state/dispatch/reconciler.log` |
| Prune outcomes across those ticks | **16 362 × `pruned=0`, 1 × `pruned=3`, 1 × `pruned=1`** → **4 workspaces closed, ever** | grep |
| Spawns logged | **753** total (`~/.aigentry/open-session.log`, 2026-04-18 → 2026-08-16); 54 in Aug so far | `wc -l` |

### Code distribution inside the 1000 lines

| Block | Lines | **Code lines** |
|---|---|---|
| header / contract prose / re-source guard | 1–68 | 5 |
| cmux adapter | 69–346 | **157** |
| warp adapter | 348–710 | **230** |
| legacy terminals (aterm/tmux/wezterm/iterm + fallback) | 712–793 | 44 |
| headless adapter | 795–816 | 16 |
| registry + `detect_terminal` | 818–902 | 49 |
| dispatcher (the 10 public verbs) | 904–1000 | 62 |

**The headline the "1000 lines" framing hides: this is a 563-line port, and 387 of
those lines (69 %) are two adapters — cmux and warp.** The contract, registry and
dispatcher together are 116 code lines.

---

## 1. Adapter boundary — the 69 functions in three buckets

### (a) Pure state / ledger / dispatch logic → portable TS, no subprocess (**40** functions)

| Function(s) | # | Why portable |
|---|---:|---|
| `_wh_log` | 1 | `echo … >&2` |
| `_wh_registry` | 1 | a 7-row TSV heredoc — becomes a `const` array |
| `_wh_detect_match` | 1 | reads `CMUX_WORKSPACE_ID` / `ATERM_IPC_SOCKET` / `TMUX` / `TERM_PROGRAM` |
| `_wh_is_registered`, `detect_terminal`, `_wh_adapter` | 3 | table walks over the registry |
| `_wh_host_available` | 1 | `command -v` — a PATH probe, not an actuation |
| `wh_{open,lookup,close,alive,list_ids,focus,prune_orphans,set_status,clear_status}` | 9 | pure dispatch: resolve adapter name, forward argv |
| `wh_close_for_sid` | 1 | composite of two verbs |
| `_wh_headless_{lookup,close,alive,list_ids,focus,prune_orphans,set_status,clear_status}` | 8 | literal no-ops / constants |
| `_wh_warp_{prune_orphans,set_status,clear_status}` | 3 | literal no-ops |
| `_wh_{cmux,warp,aterm,tmux,wezterm,iterm,headless}_ready_attestation` | 7 | constants, except warp's which branches on two probes |
| `_wh_warp_sid_from_marker` | 1 | `${1#telepty::}` |
| `_wh_warp_tab_config_dir` | 1 | `uname` branch → a path string |
| `_wh_warp_write_tab_config` | 1 | writes a 6-line TOML |
| `_wh_warp_rm_tab_config` | 1 | `rm -f` |
| `_wh_warp_list_ids` | 1 | globs `~/.aigentry/warp-surfaces/*.live` |

Plus the part of `_wh_cmux_prune_orphans` that is not a `cmux` call: the seen-twice
debounce ledger, the live-ids / protected-refs CSV membership tests, and the
ownership gate on `$AIGENTRY_ROLE_SANDBOX_DIR` (`:215-249`). That is the single
densest piece of *decision* logic in the file — it decides whether an absence may
authorise a destruction — and it currently runs on `jq` round-trips per candidate
per tick. In TS it is `Map` operations and one `JSON.parse`/`stringify`.

### (b) Adapter actuation — shells to an OS tool, stays a subprocess *inside* TS (**29** functions)

The OS tool is the primitive; TS is the driver. No re-implementation of cmux or
AppleScript is proposed or acceptable.

| Group | Functions | # | External primitive |
|---|---|---:|---|
| cmux lifecycle | `_wh_cmux_{lookup,close,alive,list_ids,list_titles,set_status,clear_status,focus}` | 8 | `cmux` CLI (+ `telepty list --json`, `jq`) |
| cmux spawn | `_wh_cmux_{wait_ready,open}` | 2 | `cmux new-workspace / rename-workspace / list-workspaces / surface-health / read-screen / close-workspace` |
| cmux prune | `_wh_cmux_prune_orphans` (the actuating half) | 1 | `cmux` via `list_titles` + `_wh_cmux_close` |
| warp UI-scripting | `_wh_warp_{can_uiscript,app_running,raise_window,send_cmd_key,read_screen}` | 5 | `osascript` (5 sites), `pgrep` (4 sites), `uname` |
| warp lifecycle | `_wh_warp_{lookup,close,alive,focus,deeplink_open,wait_ready,open}` | 7 | `telepty`, `open`/`xdg-open`, the osascript group |
| legacy spawn | `_wh_{aterm,tmux,wezterm,iterm}_open`, `_wh_fallback_spawn` | 5 | `aterm`, `wezterm`, `telepty spawn`, `platform::spawn_tmux_window`, `platform::spawn_iterm_tab` |
| headless spawn | `_wh_headless_open` | 1 | `telepty spawn` |

**40 + 29 + 0 = 69.** `_wh_cmux_prune_orphans` is counted once, in (b); its pure half
is described below.

The five AppleScript heredocs (`:389-409`, `:416-421`, `:587-604`) are **AppleScript
source, not bash**. They move verbatim as string constants piped to `osascript -`
with the marker still passed on `argv` — the injection-safety property at `:386` and
`:584` is a property of `osascript - "$marker"`, not of bash, and must be preserved
by construction (`spawnSync("osascript", ["-", marker], {input: OSA_RAISE})`).

### (c) Still bash by necessity — **zero functions**

No function in this file requires a bash interpreter for its own sake. Three
(`_wh_fallback_spawn`, `_wh_tmux_open`, `_wh_iterm_open`) call `platform::*`, which
is a **sourced bash lib** (`bin/lib/platform.sh` → `platform-unix.sh` /
`platform-windows.sh`). Those need a door, and the door already exists and is in
production: `src/reconciler/cli.ts:24-28` reaches `platform::host_power_state`,
`platform::lid_closed` and `platform::session_pid` as
`bash -c '. <lib>; <fn> "$2"'`. Same idiom, three more call sites. **This is not a
reason to keep workspace-host in bash; it is one line of precedent per call.**

### Module placement — `src/workspace-host/`, NOT `src/platform/terminal.ts`

**Measured first:** `src/platform/` does **not exist** in the working tree, in
`origin/main`, or in any of the 30+ remote branches (`git ls-tree -r` over every
`origin/*` ref → zero hits for `^src/platform/`). The cross-platform ADR the
dispatch cites is not in this repo at `cf7c0ea`. The recommendation below therefore
rests on the two ADRs that *are* here, and the user should treat "does it map onto
`terminal.ts`" as answered on those grounds, not against a document I could not read
(§8 NOT-CHECKED).

**Recommendation: its own module, `src/workspace-host/`.** Three measured reasons:

1. **It is a consumer of platform, not a peer.** `_wh_tmux_open` and `_wh_iterm_open`
   *call* `platform::spawn_*`. Making workspace-host a file inside the platform
   module makes the module import itself.
2. **They answer different questions.** `platform.sh` answers *"what does this OS
   call this primitive"* (Rule 26 — `pmset` vs `/proc`, `ps` column sets). Its
   dispatcher is `uname`-keyed (`platform.sh:16-27`). `workspace-host.sh` answers
   *"which surface host am I driving"* — a registry keyed on env and PATH, with a
   deliberate constitutional history (ADR 2026-05-30 §4: surface-driving =
   orchestrator; ADR 2026-06-13 §D2: one registry). Folding them collapses two
   distinct ownership boundaries into one file name.
3. **The blast radii differ by three orders of magnitude.** platform primitives are
   read-mostly queries; workspace-host destroys UI surfaces. They should not share a
   revert.

Proposed shape (7 files, mirroring the measured block structure):

```
src/workspace-host/
  cli.ts        # the 11 verbs — bin/wh-cli.sh's exec target
  registry.ts   # _wh_registry, _wh_detect_match, _wh_host_available,
                #   _wh_is_registered, detect_terminal, _wh_adapter   (49 code lines)
  types.ts      # the Adapter interface: 9 verbs + ready_attestation field
  cmux.ts       # 157 code lines
  warp.ts       # 230 code lines
  legacy.ts     # aterm/tmux/wezterm/iterm + _wh_fallback_spawn (44)
  headless.ts   # 16
```

The 9-verb boundary + `ready_attestation`-as-a-field (ADR 2026-06-13 §12 BC2) becomes
a TS `interface` — which is the one thing the port genuinely *buys*: today the
contract is enforced by a guard string comparison (`T53:124`, `T54:176`, `T55:183`
each hard-code the same `want=` verb list); in TS the compiler enforces it and the
three duplicated string literals collapse to one type.

---

## 2. `bin/open-session.sh` — sequencing recommendation

### What it actually touches

`bin/open-session.sh` is **288 lines**. It sources two libs and reaches exactly
**three** symbols of workspace-host:

| Symbol | Call sites | Already a `wh-cli.sh` verb? |
|---|---|---|
| `detect_terminal` | `:201`, `:272` | yes — `detect-terminal` (the 11th verb exists *for this*, `wh-cli.sh:42-48`) |
| `wh_open` | `:231` | yes — `open` |
| `wh_set_status` | `:239` | yes — `set-status` |

From `platform.sh` it reaches `platform::hold_awake` and `platform::session_pid`
(`:283-285`). `_wh_adapter` and `_wh_fallback_spawn` appear only in comments
(`:141-144`), as `wh-cli.sh:46-47` already documented and T104 part F pins.

### The three options, with measured blast radius

| Option | Diff | Blast radius on merge |
|---|---|---|
| **(i) T3a = open-session first**, calling `wh-cli.sh`; adapter stays bash | 288-line port + 3 door-walks. Adapter untouched. | **Spawn path only.** Close/prune/status/alive paths are byte-identical to production. |
| (ii) workspace-host first, give open-session a door | 563-line adapter port **and** the same 3 door-walks in open-session, in one merge | Spawn **and** close **and** prune **and** status, simultaneously |
| (iii) both in one tranche | 851 code lines | Everything. The largest single live deploy in #899. |

### Which failure is worse for the operator

**A broken spawn path is worse — and the measurements say so unambiguously.**

- **Spawn** is 100 % of delegation. `bin/dispatch.sh --spawn-and-dispatch` →
  `boot-prepare` → `open-session.sh`. If it breaks, no worker starts. But it fails
  **loudly and synchronously**: the dispatching turn sees a non-zero exit in the same
  turn it issued. Measured rate: 753 spawns in 120 days (~6/day) — every one of them
  an attended, orchestrator-initiated action.
- **Close/prune** is the quiet path — and it is nearly cold. Across **16 364**
  prune-reporting ticks, the prune verb closed **4 workspaces total** (one tick
  closed 3, one closed 1, the other 16 362 closed nothing). A broken close therefore
  costs, in the observed regime, a handful of cosmetic orphan tabs the operator
  closes by hand. The destructive inverse (over-closing) is triple-gated —
  `title ∉ live_ids` **and** `cwd` under the role sandbox **and** `ref ∉ protected`
  **and** seen on the previous tick — so a false close needs all four to be wrong
  simultaneously for **two consecutive 60 s ticks** before the first destruction.
  INV-17 independently refuses `surface_gone` as a sole teardown authority.

So the sequencing principle is: **put the loud, total-loss path in its own smallest
possible tranche, and give the quiet destructive path a tranche where the whole
debounce window fits inside the revert window.** Both point to the same answer.

### **RECOMMENDATION: option (i).**

T3a ports `open-session.sh` alone and walks through the door that
`bin/wh-cli.sh` was built for (c83ebc4, pre-T2). It is not a port of the adapter —
it is three `spawnSync` calls replacing three sourced-function calls, against a door
whose equivalence is already pinned by T104. The adapter stays bash and in
production, unchanged, while the spawn path lands.

Two things T3a must not break, both measured:

- **`AIGENTRY_WH_LEGACY_SPAWN=1`** (`open-session.sh:204-225`) is the existing
  per-invocation revert of the cmux spawn arm — an inline byte-for-byte copy of the
  devkit original that needs no rebuild. It is the *only* rollback lever on this path
  that works without a toolchain. T3a preserves it verbatim, including
  `_cmux_wait_ready` (`:165-189`), which exists solely to serve it. Deleting it as
  "duplicate code" would be exactly the kind of drive-by Rule 29 forbids, and would
  remove the cheapest rollback in the system.
- **`eval cwd="$cwd"`** at `:118` and the unquoted `bash -c 'cd $cwd && …'` at
  `:212` are pre-existing injection sites already recorded as `[MEDIUM] G` in
  `docs/reports/2026-07-02-ecosystem-deep-analysis.md:87`. T3a is a port, not a fix:
  reproduce them, note them, and open a separate ticket. Fixing them inside the port
  makes the parity guard unprovable (the whole point of the guard is that old and new
  produce identical bytes).

---

## 3. Guards — the full inventory, and which seams die

### 3.1 Every test that touches the lib, by mechanism

| Guard | LOC | Mechanism | Survives a TS lib? |
|---|---|---|---|
| **T23** `workspace_host_adapter` | 117 | **sources** the lib (4×), calls `wh_*` + `_wh_adapter` | ✗ — must be re-expressed |
| **T25** `warp_adapter_degrade` | 187 | **sources** (11×) — calls `_wh_warp_close/_focus/_alive`, `_wh_adapter` | ✗ — tests **internals** |
| **T27** `sole_close_idempotent` | 112 | **sources** (3×) `wh_close`; also drives `session-cleanup.sh` | partly ✗ |
| **T33** `orphan_lookup_by_title` | 71 | **sources** (2×) `wh_lookup` fallback-by-title | ✗ |
| **T53** `wh_cmux_open_contract` | 129 | **sources** (4×) `wh_open`/`wh_lookup`, `declare -F` verb-set | ✗ |
| **T54** `wh_warp_open_contract` | 181 | **sources** (5×) + `_wh_warp_ready_attestation`, verb-set | ✗ |
| **T55** `wh_legacy_terminal_open_contract` | 188 | **sources** (6×) + `_wh_<t>_ready_attestation`, `_wh_adapter`, verb-set | ✗ |
| **T104** `wh_cli_conformance` | 245 | **both halves**: `. $LIB; fn` **vs** `wh-cli.sh verb`, asserts equal | ✗ — see 3.3 |
| **prune-status.sh** (`tests/workspace-host/`) | 202 | **sources**; needs **live cmux**; **not in CI** | ✗ — see §4 |
| **T32** `cleanup_orphan_terminal` | 73 | `export -f wh_close_for_sid` + `WORKSPACE_HOST_SH_LOADED=1` | ✗ — see 3.2 |
| **T86** `cleanup_delete_sends_token` | 145 | same `export -f` seam | ✗ (**silently**) |
| **T89** `empty_list_cannot_authorize_teardown` | 208 | same seam, 3 functions | ✗ (**silently**) |
| **T106** `cleanup_cli_contract` | 265 | same seam, 3 functions | ✗ (**silently**) |
| **T105** `cleanup_workspace_shim` | 133 | **substitutes the file** `$WS/bin/wh-cli.sh` | ✓ |
| **T111** `reconciler_workspace_shim` | 163 | **substitutes the file** `$WS/bin/wh-cli.sh` | ✓ |
| **T112** `reconciler_exported_seams` | 201 | **substitutes** `$WS/bin/lib/workspace-host.sh` with a bash recorder | ✗ — retarget to `wh-cli.sh` |
| **T26** `reconciler_inv17_surface_gone` | 151 | env only (`AIGENTRY_WORKSPACE_HOST=cmux` + PATH `cmux` stub) | ✓ |
| **T56** `open_session_sidebar_status` | 97 | env only + `CMUX` seam; drives `open-session.sh` end-to-end | ✓ (T3a must keep it green) |
| **T90** `reconciler_refusal_is_not_absence` | 177 | env only (`AIGENTRY_WORKSPACE_HOST=headless`) | ✓ |
| **T110** `reconciler_cli_contract` | 245 | env only | ✓ |

Totals: **8 guards source the lib** (+1 live-cmux script), **4 guards stub via
`export -f`**, **3 substitute a file**, **4 are env-only**.

### 3.2 Does the `export -f` + `WORKSPACE_HOST_SH_LOADED=1` seam survive? — **No.**

The seam works today because of two facts that a TS port removes together:

1. `bin/wh-cli.sh` is **bash**, so an exported bash function reaches it through the
   process boundary (`export -f` puts it in the child's environment, and the child is
   a bash);
2. `bin/lib/workspace-host.sh:60-63` early-returns when `WORKSPACE_HOST_SH_LOADED=1`,
   so the real adapter never overwrites the exported stub.

A node process inherits neither. **Worse than "it breaks" — it breaks
asymmetrically:**

- **T32** asserts a close **was** invoked. With the stub inert, the real adapter runs;
  on a CI runner without cmux `_wh_adapter` → `headless`, whose `wh_lookup` returns
  empty, so `wh_close_for_sid` returns 0 without closing. `CLOSE_LOG` stays empty and
  **T32 fails loudly.** Good.
- **T86, T89, T106** assert that destructive actions were **not** taken. With the stub
  inert, the headless adapter also takes no action — so they **pass vacuously**,
  having tested nothing. **This is the dangerous half, and it is silent.** T89 is
  literally the guard named *"an empty list cannot authorize teardown"*; a version of
  it that passes because nothing was wired is worse than no guard.

**Replacement — use the seam that already survives.** T105 and T111 substitute the
*file* `$WS/bin/wh-cli.sh` in a copied workspace and assert the consumer reached it.
That works today, works after the port, and needs no new mechanism, because
`bin/wh-cli.sh` **must remain an executable file at that path** for the same reason
`bin/hitl.sh` must (`bin/hitl.sh:12-19`, ADR amendment invariant 9): it is a literal
entry in `bin/init/manifest.mjs:62` that `tests/packaging/T96_ship_set_agreement.sh`
holds against both the real tarball and `git ls-files`.

Concretely, T3b migrates T32/T86/T89/T106 from

```bash
wh_close_for_sid() { …; }; export -f wh_close_for_sid
export WORKSPACE_HOST_SH_LOADED=1
```

to the T105 idiom: write a recorder at `$WS/bin/wh-cli.sh`, run the consumer with
`AIGENTRY_SHIM_SCRIPT_DIR=$WS/bin`. **Recommended additional seam:** make the two TS
consumers read `env.AIGENTRY_WH_CLI || path.join(SCRIPT_DIR, "wh-cli.sh")`
(`src/cleanup/cli.ts:68`, `src/reconciler/cli.ts:113`) — one `||` per file, matching
the `CLEANUP_SH` / `TRACKER_SH` / `POLICY_PY` / `SESSION_PROBE_PY` env-seam
convention those files already use for every other subprocess child. That lets a
guard point at a recorder without copying `bin/` at all.

### 3.3 T104 cannot survive, and its replacement **is** the parity guard

T104's part A is `run_sourced()` vs `run_cli()` — it asserts CLI exit code + stdout
equals the sourced function's, for all 11 verbs, on two adapters. After the port
**there is no sourced half.** Part F (`declare -F | grep '^wh_'` vs the CLI's arm
list) also dies with bash.

Replacement, and this is the T3b parity guard the tranche pattern requires:

1. On the T3b branch, **before any implementation**, record the 11 verbs × the three
   adapters (cmux-stub / warp-stub / headless) — `(argv, exit, stdout, stderr)` —
   into `tests/fixtures/wh-golden.jsonl`, produced by the **original bash lib**.
   Separate commit, no implementation change.
2. The TS `wh-cli.sh` must reproduce that fixture byte-for-byte. That is the same
   discipline every prior tranche used ("a parity guard that passes against the
   ORIGINAL bash"), expressed as a recorded artifact because the live half is going
   away.
3. Part F becomes a TS type: the `Adapter` interface, with a runtime assertion in
   `cli.ts` that the verb-arm table and the interface keys agree.

### 3.4 The seven internal-function guards — the honest cost

T23/T25/T27/T33/T53/T54/T55 test `_wh_*` **internals** that `wh-cli.sh` does not
expose: `_wh_warp_close`, `_wh_warp_alive`, `_wh_adapter`, `_wh_<term>_ready_attestation`,
the by-title lookup fallback. **They cannot all be re-expressed through the 11
public verbs.** Disposition:

- Pure ones (registry / detect / attestation / marker parsing) → **TS unit tests**
  under `tests/workspace-host/`, testing the exported functions directly. Cheaper and
  stronger than today's `bash -c` subshell round-trips.
- Actuation ones (T25 warp degrade, T53/T54 open contracts) → keep driving
  `bin/wh-cli.sh` as a subprocess with the recorded stubs from §4, plus one new verb
  or a `--json` capability report if `ready_attestation` must stay externally
  assertable. **Adding a verb is a contract change** (the 9-verb boundary is declared
  invariant in ADR 2026-06-13 §12 BC2) — prefer the TS unit test and leave the CLI at
  11 verbs.

Budget honestly: **~1 500 lines of guard code are rewritten or retargeted** to port
563 lines of implementation. That ratio is the real cost of this tranche and the
main reason it was left last.

### 3.5 Baseline run (what I actually executed)

The worktree has no `dist/` and no `node_modules`, so every guard routed through an
exec shim would fail on "compiled implementation not found" — those were not run.
The six that need only bash + the lib were run in the worktree and **all pass against
the original bash**:

```
T23_workspace_host_adapter              rc=0 T23 PASS
T25_warp_adapter_degrade                rc=0 T25 PASS
T33_orphan_lookup_by_title              rc=0 T33 PASS
T53_wh_cmux_open_contract               rc=0 T53 PASS
T54_wh_warp_open_contract               rc=0 T54 PASS
T55_wh_legacy_terminal_open_contract    rc=0 T55 PASS
```

T56 was **deliberately not run** — it executes `bin/open-session.sh` end-to-end, and
the dispatch forbids running open-session.

---

## 4. Proving adapter parity without a live surface

### The measured problem

**The `$CMUX` injection seam covers only 3 of 9 cmux entry points.**

| Injectable via `${CMUX:-cmux}` / `$cmux_bin` | PATH-shadow only (bare `cmux`) |
|---|---|
| `_wh_cmux_open` (`:331`), `_wh_cmux_wait_ready` (`:291`, arg 2), `_wh_cmux_set_status` (`:170`) | `_wh_cmux_close` `:92` · `_wh_cmux_alive` `:134` · `_wh_cmux_list_ids` `:149` · `_wh_cmux_list_titles` `:158` · `_wh_cmux_clear_status` `:189` · `_wh_cmux_focus` `:258` |

`tests/workspace-host/prune-status.sh` is **not in CI**: `tests/dispatch/run-all.sh:82`
globs `"$HERE"/T*.sh` only, and the script self-skips with
`1..0 # SKIP cmux not on PATH` when cmux is absent. Its coverage of `wh_prune_orphans`
/ `wh_set_status` / `wh_clear_status` against a real cmux is therefore **manual, on
one machine, on demand.**

And there is direct evidence this gap has already cost real correctness. The #835
comment block at `:110-116` records that the `Error:`-detection arm of `_wh_cmux_alive`
**never matched the real binary** for months, because real cmux 0.64.20 prints
`Error: ERROR: Tab not found` on **stderr** while the hand-written stubs printed it on
**stdout**: *"Only the stub fixtures ever took the Error path."* A hand-written stub
that drifts from the real binary manufactured a fabricated "gone" verdict into a
corroboration set.

### Proposal — record the real binary once, replay it forever (the `TELEPTY` pattern)

`telepty` is stubbed by copying a fixture binary into `$STUB_BIN` on `PATH` **and**
exporting `TELEPTY=$STUB_BIN/telepty` (`tests/dispatch/lib.sh:40-45`). cmux gets the
same treatment, upgraded from hand-written to **recorded**:

- **Step 0 (bash, pre-port — T3b-0).** Widen the seam: route the six bare-`cmux`
  sites through `${CMUX:-cmux}`, identically to the three that already do. This is a
  behaviour-preserving edit to the **bash** file, landed while T104's sourced-vs-CLI
  equivalence is still alive to prove zero drift. It is the one edit to the doomed
  file that earns its keep: without it, half the adapter is untestable in TS too.
- **Step 1 — record.** With a live cmux, run `tests/workspace-host/prune-status.sh`
  and the cmux arms of T23/T27/T53 under `CMUX=<tee-wrapper>` that appends
  `{argv, exit, stdout, stderr}` to `tests/fixtures/cmux-transcript.jsonl`. This is
  the **only** artifact anyone needs from a live surface, and it is produced by the
  operator, once, on the macOS host — never in CI.
- **Step 2 — replay.** A fixture-driven `cmux` stub answers from the JSONL, matched
  on argv, and **fails on an unrecorded argv** rather than inventing an answer. Every
  cmux-arm guard then runs in CI with no live surface, and the stub cannot drift from
  the binary because it *is* the binary's recorded output — including the
  stdout-vs-stderr distinction that #835 turned on.
- **Step 3 — staleness is declared, not hidden.** A `--record` mode the operator
  re-runs after a cmux upgrade, and the fixture carries the recorded `cmux --version`.
  A guard asserts the installed version matches when cmux is present, and **skips
  loudly** when it is not.

**What this does not prove, stated plainly (§13):** replay proves the adapter's
*reaction* to cmux's answers, never that today's cmux still gives those answers. That
residual is irreducible without a live surface, and it is exactly the residual
`prune-status.sh` covers manually today. The proposal does not eliminate the live
test — it shrinks it to "re-record after a cmux upgrade."

**Warp is harder and should be declared, not solved.** `osascript` + System Events +
AX permission cannot be recorded meaningfully (the transcript is a permission state,
not a data stream). T25 already proves the *degradation* arms hermetically by making
`osascript` absent from a curated `PATH`. Keep exactly that scope: warp's
**degraded** paths are CI-testable, its **AX-successful** paths are not, and the
`ready_attestation` field (`surface`/`process`/`none`) is already the honest,
declared expression of that limit (ADR §12 BC6). Do not manufacture confidence there.

---

## 5. Tranche split, parity guards, rollback

### Proposed sequence

| Tranche | Scope | Code lines | Parity guard | Rollback |
|---|---|---|---|---|
| **T3a** | `bin/open-session.sh` → `src/session/open-session/cli.ts`; shim at `bin/open-session.sh`. Reaches `detect-terminal`/`open`/`set-status` via `bin/wh-cli.sh`; `platform::hold_awake`/`session_pid` via the existing `bash -c '. platform.sh; …'` door. **Adapter untouched.** | 288 | New guard: same cmux stub, same argv → assert identical stdout ref, identical `~/.aigentry/open-session.log` line shape, identical exit codes on the 2/3/64 arms, `AIGENTRY_WH_LEGACY_SPAWN=1` still takes the inline path. **T56 unedited.** | `AIGENTRY_WH_LEGACY_SPAWN=1` (no rebuild) **or** `git revert` + build |
| **T3b-0** | Widen the `$CMUX` seam over the six bare sites, **in bash** | ~6 | **T104 as it exists today** (sourced == CLI) proves zero drift | trivial revert |
| **T3b-1** | Record `tests/fixtures/wh-golden.jsonl` (11 verbs × 3 adapters) and `cmux-transcript.jsonl` from the **original bash** | 0 impl | n/a — this **is** the reference | n/a |
| **T3b-2** | `src/workspace-host/` (7 files); `bin/wh-cli.sh` → exec shim onto `dist/src/workspace-host/cli.js`; delete `bin/lib/workspace-host.sh`; update `bin/init/manifest.mjs:40` **and** `tests/packaging/T96_ship_set_agreement.sh` in the same commit | 563 | the golden fixture, byte-for-byte | `git revert` + `npm run build`, **~60 s tick window** |
| **T3b-3** | Guard migration: T32/T86/T89/T106 `export -f` → file substitution; T112 retarget from lib-file to `wh-cli.sh`; T23/T25/T33/T53/T54/T55 → TS unit tests + CLI-driven arms; T104 → golden | ~1 500 test lines | the suite itself | n/a |

Splitting T3b-2 and T3b-3 into separate **commits on one branch** (not separate
merges) is deliberate: the guards must be migrated before the merge, but the diff
must be reviewable as "implementation" and "guards" separately. **One merge for all
of T3b.** A merge that lands the implementation with the old guards still in place
would land a suite that passes vacuously (§3.2).

### Rollback

The measured window is **60 s** — `src/reconciler/cli.ts:1194`,
`RECONCILER_LOOP_INTERVAL` default `60`, re-exec'ing a fresh `--once` tick each
cycle. `git revert <merge> && npm run build` lands inside one tick, so at most one
sweep runs on the reverted-from code. That is the same lever every prior #899 tranche
used, and 2 465 ticks were logged in the last 24 h, so the cadence is confirmed live.

**Recommendation: do NOT build a `AIGENTRY_WH_LEGACY_LIB=1` escape hatch that keeps
the bash lib alive alongside the TS one.** It is tempting (it would make T3b's
rollback a `export`, not a rebuild), but it ships **two implementations of the surface
close path** — precisely the duplication `CONSTITUTION.md:74` forbids and precisely
the defect ADR 2026-05-30 §"literal duplication" cites as the reason the telepty-side
copy was removed. Article 1 says the same thing more briefly. T3a's lever is free
because it already exists; T3b's lever is `git revert` + build, and the mitigation is
scheduling, not code: **land T3b with the operator present**, not from an unattended
tick.

If the user disagrees and wants the hatch, say so — it is a 6-line arm in the shim
and I will spec it. It is a deliberate constitutional trade, not an oversight.

### The one live-deploy hazard specific to this tranche

Every prior tranche ported a script that is *invoked*. T3b changes a lib that
`bin/open-session.sh` **sources**. If T3a has not landed first, T3b must change
`open-session.sh` too — which is option (ii), and is exactly the coupling the
recommended sequence avoids. **T3a is a hard prerequisite of T3b.** If the user
approves only one, approve T3a.

---

## 6. Residue table — the 19 non-shim bash scripts under `bin/`

24 top-level `bin/*.sh`; 5 are exec shims (`dispatch.sh`, `dispatch-tracker.sh`,
`session-cleanup.sh`, `session-reconciler.sh`, `hitl.sh`). The other 19:

| Script | LOC | src/ | bin/ | tests | Disposition | Reason |
|---|---:|---:|---:|---:|---|---|
| `open-session.sh` | 288 | 3 | 6 | 12 | **PORT — T3a** | §2 |
| `wh-cli.sh` | 112 | 2 | 3 | 4 | **PORT — T3b-2** (becomes the shim) | §5 |
| `telepty-bus-bridge.sh` | 366 | 1 | 1 | 2 | **PORT — T4** | largest remaining; a long-lived bus consumer, node's natural shape |
| `dispatch-cleanup-scheduler.sh` | 231 | 3 | 3 | 6 | **PORT — T4** | 3 src consumers already reach it as a subprocess; the door is free |
| `session-comms-auditor.sh` | 226 | 1 | 2 | 4 | **PORT — T4** | JSON/log analysis; jq-heavy |
| `orchestrator-boot.sh` | 222 | 2 | 6 | 3 | **PORT — T5** | 6 in-repo callers; port late, it is a boot path |
| `inject-handler.sh` | 193 | 0 | 2 | 4 | **PORT — T5** | parsing logic; no src consumer yet |
| `orchestrator-report-target.sh` | 137 | 1 | 2 | 2 | **PORT — T5** | routing logic |
| `orchestrator-bridge-auditor.sh` | 129 | 1 | 2 | 1 | **PORT — T5** | audit logic |
| `ask.sh` | 288 | 0 | 3 | 3 | **KEEP BASH** | interactive terminal UX (prompt/tty). Art. 17: must work with node absent |
| `session-start.sh` | 148 | 0 | 2 | 0 | **KEEP BASH** | shell-entry ergonomics; a node hop would add startup latency to every session |
| `install-launchd.sh` | 86 | 0 | 2 | 2 | **KEEP BASH** | writes launchd plists; runs **before** anything is installed. Art. 17 bootstrap |
| `install-instructions.sh` | 75 | 0 | 3 | 3 | **KEEP BASH** | same bootstrap class; 3 manifest entries |
| `snyk-scan.sh` | 86 | 0 | 1 | 0 | **KEEP BASH** | thin wrapper over an external CLI. Art. 1: porting adds nothing |
| `trust-path.sh` | 33 | 0 | 3 | 0 | **KEEP BASH** | 33 lines of `jq` on `~/.claude.json`. Art. 1 |
| `tq-track.sh` | 41 | 0 | 1 | 0 | **KEEP BASH** | 41-line `jq` reader |
| `tq-status.sh` | 40 | 0 | 1 | 1 | **KEEP BASH** | 40-line `jq` reader |
| `tq-focus.sh` | 44 | 0 | 1 | 0 | **KEEP BASH** | 44-line `jq` reader |
| `dispatch-verify.sh` | 84 | 1 | 1 | 0 | **DELETE CANDIDATE** | 84 lines, 1 src + 1 bin caller, **0 tests**. Verify it is still reachable before porting anything; if it is dead, deleting beats porting |

Plus `bin/lib/` (7 files, not top-level scripts):

| Lib | LOC | Disposition |
|---|---:|---|
| `workspace-host.sh` | 1000 | **PORT — T3b** |
| `platform-unix.sh` | 197 | **KEEP BASH** — Rule 26 home of the OS primitive. `docs/reports/2026-07-26-ecosystem-cleanup-audit.md:288` already records 6 unused primitives (~126 LOC) as a **separate cleanup**, not this ticket |
| `platform.sh` | 49 | **KEEP BASH** — the `uname` dispatcher |
| `platform-windows.sh` | 25 | **KEEP BASH** — stub arms, #305 |
| `telepty-listing.sh` | 99 | **KEEP BASH** — the #835 three-valued liveness verdict; already reached by 3 TS consumers through the `bash -c '. lib; fn'` door. One copy, one place |
| `telepty-auth.sh` | 56 | **KEEP BASH** — same door pattern |
| `node-shim.sh` | 45 | **KEEP BASH BY DEFINITION** — it is what finds node |

**#899's visible end state after T3a+T3b+T4+T5: of the 24 top-level scripts, 14 are
exec shims (5 today + `open-session` + `wh-cli` + 3 in T4 + 4 in T5), 9 stay bash
forever, 1 is a delete candidate; of the 7 libs, 1 is ported and 6 stay bash.** The
bash that remains is exactly
the bootstrap layer (Art. 17: it must run before node exists), the interactive-tty
layer, and the OS-primitive/`jq`-one-liner layer where porting would add a process
without removing a line.

### Two dead verbs, noted not deleted (Rule 29)

`wh_list_ids` and `wh_clear_status` have **zero production callers**. Every hit is
`bin/wh-cli.sh`'s own arm, a guard's verb-set assertion, or `prune-status.sh`. They
are part of the declared 9-verb contract (ADR 2026-06-13 §12 BC2) and the port
reproduces them. Removing them is a **contract amendment**, i.e. a separate ticket —
mentioned here so the end state is visible, not proposed.

---

## 7. Windows — what the port actually buys (honestly: nothing observable)

**Measured.** On win32, `_wh_detect_match` (`:850-861`) can only match `headless`:
`cmux` needs `CMUX_WORKSPACE_ID`, `aterm` needs `ATERM_IPC_SOCKET`, `tmux` needs
`$TMUX`, `wezterm`/`iterm` need `TERM_PROGRAM`, and `warp` explicitly `return 1`
(never auto-detected). `_wh_adapter` (`:914-928`) only auto-selects
`auto_detectable=yes` rows — `cmux` (gated on `command -v cmux`, a macOS-only binary)
and `headless`. So on win32 the resolved adapter is **`headless`, always**, and
`_wh_headless_open` is `telepty spawn` — a node daemon PTY with no visible surface.

**Therefore the TS port changes nothing a Windows user can observe.** Same adapter,
same daemon spawn, same eight no-ops. Anyone selling this tranche as Windows progress
is wrong, and the PR must not say it.

What it does do is remove **one** bash requirement from a chain that still has
several. `#901` measured the actual Windows state on a real runner: **225 tests, 192
pass, 33 fail, 0 skip**, and the largest failing family is *"21 boot-prepare launcher
tests that generate and exec a `launcher.SH`"*. The spawn chain on win32 is
`dispatch → boot-prepare → launcher.sh → open-session.sh → workspace-host` — T3a+T3b
removes the last two hops; the `launcher.sh` hop is untouched and is the one 21 tests
are failing on.

**And there is a real anti-benefit to name.** `_wh_fallback_spawn`, `_wh_tmux_open`
and `_wh_iterm_open` call `platform::*`. If workspace-host becomes TS while
`platform.sh` stays bash, those three paths gain a **bash → node → bash** hop. On
macOS/Linux that costs one `spawnSync` (the reconciler already pays it three times
per tick without issue). On win32, `platform-windows.sh` answers all three spawn
primitives with `return 3` and a "#305, use WSL" message — so the extra hop is on a
path that is already refused. It costs nothing today, but it is debt the eventual
`platform` port has to unwind, and it should be written down now rather than
discovered later.

**Verdict for the user: do not weigh Windows in this decision.** The case for T3a/T3b
is single-language maintenance of the spawn/close primitive and a compiler-enforced
adapter contract. Windows is neutral-to-slightly-negative and stays that way until
`#305` and the `launcher.sh` generator move.

---

## 8. NOT CHECKED / NOT PROVEN (Rule 38)

1. **The cross-platform ADR proposing `src/platform/{proc,service,terminal}.ts` was
   not found.** `src/platform/` exists in no branch (`git ls-tree -r` over every
   `origin/*` ref) and no doc under `docs/` names those three files. §1's placement
   recommendation therefore rests on ADR 2026-05-30 and ADR 2026-06-13, which are in
   the tree, **not** on that ADR. If it exists outside this repo, §1 should be
   re-read against it before approval.
2. **The guard suite was not run in full.** No `dist/`, no `node_modules` in the
   worktree; only the 6 lib-sourcing guards were executed (§3.5, all PASS). Every
   shim-routed guard (T27/T32/T86/T89/T104/T105/T106/T110/T111/T112) is
   **unverified in this worktree** — they pass on `main` per the T2d merge, but I did
   not re-run them.
3. **`tests/workspace-host/prune-status.sh` was not run.** It requires live cmux and
   creates/closes real workspaces. Forbidden by the dispatch's HARD constraints.
4. **T56 was not run** — it executes `bin/open-session.sh`.
5. **No `osascript`, `cmux`, `warp` or `open-session` actuation of any kind was
   performed.** All warp claims are read from source; the AX/permission behaviour is
   unverified by me.
6. **The LOC and effort figures for T3a are structural, not empirical.** 288 lines in,
   an unknown number out; the ~1 500-line guard-migration figure is the sum of the
   affected guards' current LOC, i.e. an upper bound on what gets *touched*, not an
   estimate of what gets *written*.
7. **`bin/dispatch-verify.sh` "delete candidate" is a flag, not a finding.** It has 2
   callers and 0 tests; I did not trace whether those callers are live paths.
8. **The `[MEDIUM] G` injection sites** (`open-session.sh:118` `eval cwd`,
   `workspace-host.sh:333` unquoted `bash -c`) are reported from
   `docs/reports/2026-07-02-ecosystem-deep-analysis.md:87` and confirmed present by
   reading; **I did not attempt to exploit or reproduce them**, and §2 deliberately
   proposes reproducing rather than fixing them inside a port.

---

## 9. The decision in front of the user

**Approve T3a alone** (port `open-session.sh`, adapter stays bash) if the appetite is
one small tranche: 288 lines, three door-walks through a door T104 already pins, a
rollback lever that needs no rebuild, and it is a hard prerequisite for anything else.

**Approve T3a + T3b** for #899's stated end state, accepting: 563 implementation lines
against ~1 500 lines of guard migration, the loss of T104's sourced-vs-CLI
equivalence (replaced by a recorded golden fixture), one operator-run cmux recording
session, and a rollback that is `git revert` + build inside the measured 60 s tick.

**Decline both** and `bin/lib/workspace-host.sh` stays the last bash lib, reached by
every TS consumer through `bin/wh-cli.sh` exactly as it is today. That is a coherent
end state — the door works, T104 pins it, and nothing is broken. #899 would then be
"every *invoked* script is TS; the terminal-adapter lib is deliberately bash." It
should be recorded as a decision, not left as an unfinished item.
