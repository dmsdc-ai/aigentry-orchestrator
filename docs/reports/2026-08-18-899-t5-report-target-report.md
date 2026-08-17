# #899 tranche 5 — `bin/orchestrator-report-target.sh` → TypeScript: REPORT

Track `rt899`. Branch `feat/899-t5-rt899` off `origin/main` @ `b300875`, worktree
`~/.aigentry/worktrees/rt899`. Disposition (Phase 1, GO'd):
`docs/reports/2026-08-18-899-t5-report-target-disposition.md`.

Commits: `9812da4` disposition · `545c2b1` the port + T129/T130 · this report.

The GO was: **(a) D2 reproduce and name** (operator-only vars, not a trust boundary),
**(b) D4 file the ticket, do not widen — with the exact diff carried in this report**,
**zero behaviour changes, T129/T130**. All three are done.

137 lines of bash → an 87-line shim (78 of them the Rule 38 header) + 227 lines of
TypeScript + **no usage.ts**. Two guards, 415 lines.

---

## 1. Guard split — sourced vs invoked

| consumer | how it reaches the script | `__probe` |
|---|---|---|
| `src/dispatch/cli.ts:595-597` | **invoked** — `capture(REPORT_TARGET_SH, [])` behind `isExecutable()`, **no argv**; needs rc 0 **and** non-empty stdout | no |
| `tests/dispatch/T67:36,40` | **invoked**, `"$RESOLVER"` direct | no |
| `tests/dispatch/T92:73,123` | **invoked**, `env … bash "$RESOLVER"` | no |
| `tests/dispatch/T129` (new) | **invoked**, via `$REPORT_TARGET_UNDER_TEST` | no |
| `tests/dispatch/T130` (new) | **invoked**, from a workspace copy of `bin/` | no |
| `bin/init/manifest.mjs:44` | ships the file into a control workspace | — |
| anything under `bin/` | **nothing invokes it**; `bin/dispatch-tracker.sh:14` is a comment | — |

`grep -rnE '^\s*(\.|source)\s.*orchestrator-report-target'` over the repo matches
**nothing**, and the script itself sourced **zero** libs. **So there is no `__probe`
surface, no `bash -c '. lib; fn'` door and no `bin/wh-cli.sh` verb.**
`bin/lib/workspace-host.sh` is untouched, as dispatched.

T67 and T92 are unchanged and still pass against the port.

## 2. Doors

Children, all keeping IDENTICAL argv:

| child | argv | why it stays |
|---|---|---|
| `$CURL` | `-s -o /dev/null -w %{http_code} --connect-timeout 1 --max-time 2 http://<h>:<port>/api/meta` | the documented seam (precedent `src/tracker/cli.ts:56,604`). **T129 block A asserts it as ARGV**, one element per line, so a word-split host cannot hide inside `$*` |
| `$REPORT_TARGET_IFACE_CMD` | **none** — one filename, no arguments, no shell | the T92/T129 seam. T129 block I asserts both halves |
| `ifconfig` | none | seam-unset default |
| `ip` | `-o -4 addr show` | seam-unset default |

Gone (node-internal now): `grep -Eo`, `head -n1`, `command -v`. They were how bash
reached a regex and a PATH lookup, never a contract. **No `python3`, no `node -e`, no
`date`, no `mktemp` existed here to remove** — this was already the smallest script in
the tranche.

**`os.networkInterfaces()` is deliberately NOT used**, though it is less code and would
have removed two spawns per dispatch. `REPORT_TARGET_IFACE_CMD` must keep accepting an
arbitrary executable whose **stdout is parsed**; a native lister on the default path plus
a text parser on the seam path would be two selection algorithms, and every guard would
exercise the one production never runs. One algorithm, text in, first CGNAT match out.

## 3. Contract table — `pinned by`, before and after

All 9 disposition rows re-verified against the port, plus the seam/default rows. Nothing
is marked "changed" because **nothing changed**.

| # | condition | before | after | pinned by |
|---|---|---|---|---|
| 1 | explicit host, answers | `<sid>@<host>`, silent stderr, rc 0 | same | T92 (4), T67 (1) |
| 2 | explicit host, silent | `<sid>@<host>` + `honouring it because you set it explicitly` | same, byte for byte | T92 (3), **T129 C** |
| 3 | explicit host, cannot probe | `<sid>@<host>` + `cannot probe` | same | **T129 D** (was unpinned) |
| 4 | auto CGNAT, answers | `<sid>@<ip>` | same | T92 (1), **T129 A** |
| 5 | auto CGNAT, silent | bare `<sid>` + the two-sentence note naming the cost | same | T92 (2), **T129 C** |
| 6 | auto CGNAT, cannot probe | `<sid>@<ip>` + `cannot probe` | same | T92 (5) |
| 7 | no candidate | bare `<sid>`, **zero probes** | same | T92 (6) |
| 8 | HTTP 401/403/500 | answered | same | T92 (7) |
| 9 | stdout one clean line | — | same, now asserted on **every** arm | T92 (8), **T129 A/D/E/H** |
| 10 | default sid | `orchestrator` | same | **T129 B** (was unpinned) |
| 11 | `TELEPTY_PORT` | URL **and** both note texts; empty ⇒ 3848 | same | **T129 C** (was unpinned) |
| 12 | argv | **ignored entirely**; no `--help` | same | **T129 E** (was unpinned) |
| 13 | `AIGENTRY_ORCHESTRATOR_HOST=` empty | ⇒ auto-detect | same | **T129 F** (was unpinned) |
| 14 | probe count | exactly 1, no retry | same | **T129 A** (T92 only asserted ≥1) |
| 15 | status read | trailing newlines stripped only | same | **T129 A** (was unpinned) |
| 16 | scan, seam unset | `ifconfig` then `ip -o -4 addr show`, both run, one failing does not stop the other | same | **T129 G** (was unpinned) |
| 17 | CGNAT bounds | 100.63 out / 100.64 in / 100.127 in / 100.128 out, first match wins | same | **T129 H** (was unpinned) |
| 18 | seam with a space / metachars | one filename; no split, no shell | same | **T129 I** (was unpinned) |
| 19 | exit code | **0 on every path** | same | T92 `run()`, **T129 `run()`** |

Verified row by row against the original bash extracted from `b300875` — 23 side-by-side
cases including stdout, stderr, rc and probe count, plus the **real** dual-lister scan on
the port host (both produce `…@100.72.155.21`).

## 4. Platform branches

**Zero.** Enumerated on the bash: `grep -nE 'uname|OSTYPE|Darwin|Linux|sw_vers'` matches
nothing. The only OS-adaptivity is running both listers and letting the absent one
contribute nothing, which is not a branch and is reproduced as such. So the port carries
**zero** `process.platform` branches.

## 5. Latent defects — reproduced, named, not fixed

| # | defect | reproduction | disposition |
|---|---|---|---|
| D1 | the CGNAT regex is unanchored | `inet6 fe80::9100.72.1.1234` → `100.72.1.123`, a host on no interface | reproduced; self-limiting (the probe then says silent) — **ticket** |
| D2 | a newline in `AIGENTRY_ORCHESTRATOR_SID`/`_HOST` makes stdout multi-line, and `src/dispatch/cli.ts:597` strips **trailing** newlines only, so the extra line lands in the ref | `HOST=$'1.2.3.4\nEVIL'` → 2 lines; same for the sid | reproduced per GO (a) — operator-only vars, **nothing in the tree sets either**, so not a trust boundary — **ticket** |
| D3 | the interface seam cannot carry arguments | `IFACE_CMD="$stub extra"` → empty scan → bare sid | reproduced **deliberately**: splitting on spaces or using a shell would ADD an injection surface. Now pinned by T129 I |
| D4 | the stderr notes reach nobody in production | `capture()` pipes this process's stderr into a string it never reads | **ticket, with the diff in §6** |
| D5 | `command -v` gate ⇒ spawn-error gate | non-executable `$CURL`: bash's `command -v` also reports NOT FOUND | the one deviation; **not observable** (no output, no side effect, no probe-log entry) |

## 6. The D4 ticket, with its diff

**The resolver's warnings are discarded by the only caller that could act on them.**
`src/dispatch/cli.ts:596` calls `capture()`, which uses `spawnSync`'s defaults — stderr is
piped into `r.stderr` and never read. So when the tailnet listener is down, the resolver
correctly measures it, correctly falls back to the bare sid, correctly writes *"Cross-machine
workers have no working report target while that listener is down"* — and that sentence
goes into a string that is dropped on the floor. The #835 fix measures the right thing and
reports it to nobody.

**It is ONE line, not two** (I estimated two in the disposition; `captureOut` at
`src/dispatch/cli.ts:64` already exists, already inherits stderr, has the identical return
shape, is already used at `:249` and `:790`, and the resolver call site passes no
`extraEnv`):

```diff
--- a/src/dispatch/cli.ts
+++ b/src/dispatch/cli.ts
@@ -593,7 +593,7 @@ function prepareEffectiveRef(o: Opts, d: Delivery): boolean {
   let targetAddr = "";
   if (isExecutable(REPORT_TARGET_SH)) {
-    const r = capture(REPORT_TARGET_SH, []);
+    const r = captureOut(REPORT_TARGET_SH, []);
     if (r.status === 0) targetAddr = r.stdout.replace(/\n+$/, "");
   }
```

Not applied here: `src/dispatch/cli.ts` is outside this task's Rule 29 scope, it is a live
path with its own guards, and a parallel worker is in this tranche. Whoever takes the
ticket should add the assertion too — nothing currently checks that a degraded resolve is
visible to the operator running the dispatch.

## 7. Guards

**T129 `report_target_parity`** — characterization, blocks A-I. Seam
`REPORT_TARGET_UNDER_TEST`. **It passes against the ORIGINAL bash at `b300875` as well as
against the port**, and carries **no `*_PARITY_ORIGINAL` flag**, because the port changed
no behaviour and there is nothing for a flag to select:

```
git show b300875:bin/orchestrator-report-target.sh > /tmp/rt-orig.sh && chmod +x /tmp/rt-orig.sh
REPORT_TARGET_UNDER_TEST=/tmp/rt-orig.sh bash tests/dispatch/T129_report_target_parity.sh
→ T129 PASS resolver=/tmp/rt-orig.sh blocks=A-I
```

**Non-vacuous: 17 of 17 mutations caught.** Every block was verified to fail against a
targeted mutation of the compiled implementation — probe argv (timeout, endpoint), probe
count, padded-status read, default sid, `||`→`??` on `TELEPTY_PORT`, `Boolean()`→
`!== undefined` on the host, all three CGNAT alternation bounds, dropping/reordering the
listers, ignoring the seam, `shell: true` on the seam, splitting the seam on spaces,
adding a `--help` arm, collapsing `unknown` into `silent`, `silent` into `answered`,
swapping the explicit/auto notes, dropping the trailing newline, and writing notes to
stdout.

Two mutations initially survived and each produced a new assertion rather than a shrug:
`||`→`??` (block C now covers an **empty** `TELEPTY_PORT`, not only a set one) and
`shell: true` (block I, which pins the seam as a filename and plants a canary to prove no
shell interprets it).

**T130 `report_target_workspace_shim`** — the eleventh shim's workspace-layout guard.
Unlike its siblings this script resolves no `bin/` helper and no state root, so instead of
cross-checkout state it asserts the two opposite failures that matter to `dispatch.sh`:
a resolvable shim must produce the **real** answer (not merely exit 0), and an
unresolvable one must fail **loudly** (non-zero, empty stdout, node-shim's diagnostic) so
the #690 fail-closed arm fires. Plus block D, the mode bit `isExecutable()` gates on.
**3 of 3 mutations caught** (wrong dist path, exits-0-prints-nothing, lost `+x`).

`EXPECTED_GUARDS` **126 → 128**, counted (`ls tests/dispatch/T*.sh | wc -l`), not assumed.
Highest number is now T130.

## 8. Rule 35 / 39 — before and after

| | before (`b300875`, unmodified worktree) | after |
|---|---|---|
| `npx tsc -p .` | clean | clean |
| `npm test` | **225 pass / 0 fail** | **225 pass / 0 fail** |
| `tests/dispatch/run-all.sh` | **126/126 pass, 0 fail**, skipped `T16 T48 T95` | **128/128 pass, 0 fail**, skipped `T16 T48 T95` |
| Snyk `snyk_code_scan` | 2 Low Path-Traversal in `src/hitl/cli.ts` (pre-existing) | **`src/report-target` = 0 issues**; the same 2 pre-existing in `src/hitl/cli.ts`, untouched by this change → **0 new** |

## 9. Scope (Rule 29)

Five files, exactly as dispatched:

```
bin/orchestrator-report-target.sh          (shim, mode 755 preserved)
src/report-target/cli.ts                   (new)
tests/dispatch/T129_report_target_parity.sh          (new)
tests/dispatch/T130_report_target_workspace_shim.sh  (new)
tests/dispatch/run-all.sh                  (EXPECTED_GUARDS only)
```

**No manifest change** — no bin file is added, and both `bin/lib/node-shim.sh`
(`manifest.mjs:34`) and `bin/orchestrator-report-target.sh` (`:44`) were already listed.
`bin/lib/workspace-host.sh` untouched. No production daemon, no `~/.telepty/config.json`,
no real pid, no `kill` anywhere in this change — the guards use recorder seams only.

## 10. NOT checked (Rule 38)

* **The real network path.** Every probe in every guard goes to a `curl` stub. Nothing
  here proves the daemon actually answers `/api/meta` on the tailnet, only that an
  answering endpoint is read as answering. That was already true of T92 and is the correct
  hermetic boundary, but it means the endpoint URL is pinned as a *string*, never
  exercised.
* **Linux.** Both guards ran on macOS/bash 3.2 only. Block G's lister stubs are reachable
  because no `ifconfig`/`ip` sits in the resolver's hardcoded PATH prefix on this host;
  on an image where one does (homebrew's iproute2mac installs `/opt/homebrew/bin/ip`),
  **block G does not assert** and prints a NOTE to stderr saying so. It is announced, not
  silent, but it is a real coverage hole on such a host.
* **`bash 3.2` was assumed from the shell, not from a second interpreter.** No arrays,
  `mapfile`, `${x^^}` or `$'…'` in argv positions are used in either guard, and both run
  under the system `/bin/bash` (3.2) here, but I did not run them under a *different*
  bash to differential-test.
* **The `explicit + answers` and `explicit + cannot probe` arms with a HOSTNAME rather
  than an IP.** Everything uses dotted quads. A hostname would exercise the same code, but
  I did not measure it.
* **`src/dispatch/cli.ts`'s side of D4** — I read `capture()` and confirmed stderr is
  piped and unread, but I did not run a dispatch end-to-end to observe the note
  disappearing, and I did not apply or test the §6 diff.
* **D1's blast radius in the wild.** I reproduced the unanchored-regex match with a
  synthetic scan line; I did not survey real `ifconfig`/`ip` output across hosts to
  establish whether any produces one naturally.
