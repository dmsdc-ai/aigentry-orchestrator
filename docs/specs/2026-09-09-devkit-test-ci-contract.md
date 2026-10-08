# devkit test / CI / release contract — #1143 SPEC (+ #748 prerequisite)

- **Author**: `sp1143-architect` (architect; design only, no source mutation).
- **Revision 5 (UTC)**: 2026-09-09 — **FROZEN**. Approved policy recorded (§11); P-SEC downgraded to a bounded observation (§8); host-run escape hatch removed (§9 S-4b); minimal harness-only first handoff fixed (§10.1); unresolved operational prerequisites listed (§13). **R4**: `4f77ebd` · **R3**: `dbf445e` · **R2**: `ba9b454` · **R1**: `5245347`.
- **Report worktree**: `/Users/duckyoungkim/.aigentry/worktrees/sp1143`, branch `docs/1143-ci-spec`.
- **Source under design (READ ONLY)**: `/Users/duckyoungkim/projects/aigentry-devkit`, `main`, HEAD `bb7876bcbe8f83c2d329b22f41751b2b07f1f61a`. Dirty set re-measured every revision: **16 `M` + 68 `??`**, unchanged; `package.json` and `.github/workflows/**` are not in it.
- **Tags**: `[M]` measured against source · `[H]` historical (task-132; evidence, not proof) · `[D]` decision · `[A]` assumption · `[P]` proposed. **Nothing executed, installed, or modified in any revision. No test has been run.**

## 0. Revision history — withdrawals

**R2 withdrawals (W1–W12)** stand as recorded: the suite-id-matching canary, the ownership/canary contradiction, shell-string parsing, the Windows `npm test` inconsistency, the "bats are hermetic" claim, S-2's named variable drops, universal-teardown framing, the vacuous forward-compat loop claim, `existsSync` for the symlink assertion, the PID footnote, an invented bats pin, and "new WTM task" asserted without an owner search.

**R3 withdrawals and corrections:**

| # | R2 claim | Status in R3 |
|---|---|---|
| X1 | S-3a fix: signal a harness-spawned **reaped** PID; "residual PID-reuse race acknowledged" | **Withdrawn.** A reaped PID can be reused by a foreign process; acknowledging that does not make signalling it safe. Split into an **inert** missing-PID test and a **live owned child** test with **no post-reap signal** (§9 S-3, U2b). |
| X2 | "macOS caps `pid_max` at 99999, Linux defaults to 4194304" tagged `[M]` | **Retracted to `[A]`.** Neither `kern.maxproc` nor `/proc/sys/kernel/pid_max` was read. The hazard argument no longer rests on either number — X1's redesign removes the hazard regardless of the limit. |
| X3 | `copy-mutate` canary for `bash-script` suites | **Withdrawn as unsound `[M]`.** Appending after a script's exit path is unreachable, and relocation breaks relative resolution: `check-platform-usage.sh:10-18` derives `BIN_DIR`/`DEVKIT_ROOT` from `BASH_SOURCE[0]`, so a copy scans non-existent directories, matches nothing, and reports **"clean"** — a false-green baseline. Replaced by a dispatcher-boundary canary (§7). |
| X4 | Gate fixtures live in `tests/_gate/**`, excluded from inventory | **Narrowed.** A blanket-ignored directory would hide a newly added test. The registry now enumerates the three fixture paths, and the drift guard **fails** on any other file under `tests/_gate/` (§6). |
| X5 | One exclusions ledger holding files, platform skips, and `install.sh:825-831` | **Split.** Two typed, separately validated records; the source-branch entry is **removed from the ledger entirely** — a source line is not a file exclusion (§6, §3.1). |
| X6 | Registration guard "skips itself if `git` is unavailable" | **Corrected.** Missing or malformed `git` inventory **fails**; the only skip is an explicitly supported tarball mode (no `.git`). No skip-on-error green (§6). |
| X7 | S-3 "audited seam (a single spawn wrapper all suites route through)"; S-5 pgid + Windows Job Object teardown | **Withdrawn.** A top-level wrapper cannot constrain a descendant's shell builtins, absolute-path calls, or network, and inventing a cross-OS process framework is disproportionate to a CI wiring task. Replaced by **venue-based containment** (§9 S-4/S-5). The env allowlist survives as hygiene, explicitly **not** a containment claim. |
| X8 | D-6: product override seam `AIGENTRY_ORCH_ADAPTER` proposed as the way to cover `install.sh:825-831` | **Withdrawn `[M]`.** The hardcoded path is not proof that an env override is the only seam: `install.sh:12` derives `DEVKIT_DIR` from `dirname "$0"`, so an isolated **fixture checkout** can seed its own adapter with no production API change. D-6 is dropped; the gap is left honestly as out-of-scope (§3.1). |
| X9 | D-7 framed as a user numbering request; "attach to #314" recommended | **Corrected.** Task assignment and IDs are **orchestrator administration**. R3 supplies the owner-search evidence and recommends **no** target; #314 is not broadened without its own contract review (§4, §11 D-7). |
| X10 | `run-suite.mjs` "~60-line dispatcher" | **Withdrawn** — an unsupported estimate. R3 states the artifact path and owner; size is the coder's to determine (§5.1). |
| X11 | R2 §0: the `../../../package.json` premise | **Kept explicit, no fault assigned.** The reviewer independently confirmed via `path.resolve` that it resolves the repo root. Recorded as a shared correction of the record; the fix still routes through `helpers.js`'s `repoRoot` export so no hand-counted path remains (§2). |

**R4 withdrawals and corrections** (platform classification and venue enforcement):

| # | R3 claim | Status in R4 |
|---|---|---|
| Y1 | §5.2 registered `orchestrator-profile` on **all** platforms because its runner is `node-test` | **Withdrawn `[M]`.** The runner label is not the platform contract. `tests/orchestrator-profile.test.js:211` invokes `execFileSync("bash", [INSTALL_SH])`, `:55` invokes `git init`, `:52-54` sets POSIX mode bits, `:252` asserts a symlink, and `:271`/`:276` branch darwin/linux with **no** win32 branch. **POSIX-only.** |
| Y2 | "Windows runs the `node-test` suites, requiring neither bash nor bats" | **Withdrawn.** Node-authored ≠ Windows-capable. Every suite is now classified by its **measured subprocess and filesystem dependencies** (§5.2); only 1 of the 6 pre-existing suites is measurably Windows-capable. |
| Y3 | One universal S-2 env allowlist for all platforms | **Withdrawn `[A]`.** A POSIX-shaped allowlist is insufficient on Windows (`SystemRoot`, `COMSPEC`, `PATHEXT`, `TEMP`, `SystemDrive`, …). The allowlist is now platform-conditional, its Windows list is **unverified**, and a missing required variable **fails closed** rather than spawning with a broken environment (§9 S-2). |
| Y4 | S-4 venue `vm-only` with the GitHub hosted runner "satisfying" it | **Narrowed.** A hosted-runner **label does not prove** no reachable credentials. R4 splits the two properties, makes the gate **fail-closed before the first child spawn**, and enumerates what is verified by provisioning versus assumed (§9 S-4, S-4a). |
| Y5 | §8 raw unfiltered artifacts published under a "secret-free venue" precondition asserted in prose | **Corrected.** Publication is now gated on **measured** P-SEC checks; when they fail the artifacts are **withheld** and the unmet gate is reported (§8, §9 S-4a). |
| Y6 | Local `npm test` behaviour left unspecified | **Specified.** With no venue attestation, every `vm-only` suite is refused **before any spawn** and the dispatcher exits non-zero naming the refusal. The only escape is an explicit flag that CI rejects and that stamps the record `containment=UNVERIFIED` → D-8 (§9 S-4b). **Superseded by Z3: the flag is removed.** |


**R5 withdrawals and corrections (freeze):**

| # | R4 claim | Status in R5 |
|---|---|---|
| Z1 | "P-SEC **verifies**"; V1–V4 passing gates raw artifacts **open** for publication | **Downgraded `[A]`.** V1–V4 are **bounded observations over an enumerated scope**, never proof that no reachable secret exists. Passing them authorises nothing; only failing them blocks. Raw logs are **non-public by default** (§8). |
| Z2 | Artifact gating considered uploaded artifacts only | **Widened.** The **CI console/stdout is itself published** to anyone with repo read access, so suite output is redirected to a file and only a sanitized status reaches the console (§8). |
| Z3 | S-4b `--allow-host-run` escape hatch | **Removed** (approved policy). Local refusal is unconditional and has no override; a suite becomes locally runnable only by **bounded audit evidence** reclassifying it `pure`, never by a policy grant (§9 S-4b). |
| Z4 | §5.2 tagged the (not-yet-written) `registration` suite's platform basis `[M]` | **Corrected to `[P]`.** It is proposed code; no classification of it is measured, and nothing about it has been executed. |
| Z5 | §8/§9 implied `permissions: {}` is simply adoptable | **Reduced to a feasibility check.** Whether `permissions: {}` can run checkout, artifact upload and the bats provisioning step is **unverified**; U9 must check it and document the minimum viable permission set if not (§13 OP4). |
| Z6 | D-1…D-9 presented as open decisions | **Nine of ten resolved and recorded as policy** (§11); only the WTM owner assignment remains, and it is orchestrator administration. No new decisions are raised. |


## 1. Measured baseline `[M]`

| Fact | Predicate / location |
|---|---|
| 23 tracked test files under `tests/` | `git ls-tree -r --name-only HEAD -- tests \| grep -E '\.(test\|spec)\.(c\|m)?js$\|\.bats$\|\.test\.sh$\|(^\|/)test_[^/]*\.py$'` |
| 16 covered by the 4 `test:*` scripts; **7 covered by nothing** | uncovered: `ctx-e2e.bats`, `ctx-router.bats`, `open-session.bats`, `platform.bats`, `session-cleanup.bats`, `open-session-codex-flag.test.sh`, `orchestrator-profile.test.js` |
| `npm test`, `ci.yml`, `release.yml` all gate on `node bin/aigentry-devkit.js --help` | `package.json:scripts.test`; `ci.yml` *Validate CLI*; `release.yml` job `validate` |
| The 4 real `test:*` scripts are invoked by nothing in CI | `git grep -n 'npm run test' HEAD -- .github` → no match |
| `package-lock.json` tracked; version `0.1.14` | `npm ci` in both workflows is sound |
| `../../../package.json` from the hooks test dir → **repo root** | `path.resolve` verified; same depth as that file's existing `:7` require |
| `existsSync(dangling symlink)` → `false`; `lstatSync(…,{throwIfNoEntry:false})` → defined | Node 20.20.0 semantics probe in a temp dir |
| `platform-unix.sh` calls `kill` **bare** — no `command`/`builtin`/absolute path | `:9`, `:19`, `:26` → a shell function `kill()` defined before `source` shadows it (§9 S-3 seam) |
| `platform::kill_pid` returns 0 early when `is_alive` is false; `is_alive` is `kill -0` | `platform-unix.sh:6-26` |
| `check-platform-usage.sh` resolves its scan roots from `BASH_SOURCE[0]`, and its clean path is a fall-through exit 0 | `:10-18`, `:31-37`, tail — relocation ⇒ empty scan ⇒ false "clean" (X3) |
| `install.sh:12` `DEVKIT_DIR="$(cd "$(dirname "$0")" && pwd)"`; `:731` adapter path is built from it | a fixture checkout controls its own adapter without a product change (X8) |
| `orchestrator-profile` needs `bash` **and** `git` and POSIX modes/symlinks | `:211` `execFileSync("bash",[INSTALL_SH])`; `:55` `execFileSync("git",["init","-q"])`; `:52-54` `chmodSync(0o755)`; `:252` symlink assert; `:271`/`:276` darwin/linux branches, **no win32 branch** |
| `skills-drift` depends on `fs.symlinkSync` | `tests/skills-drift/v1/skills-drift.test.js:81` — `[A]` on Windows this needs Developer Mode or elevation |
| `logger-emit` has **no** child process, chmod, symlink or platform branch | grep for `spawnSync\|execFileSync\|execSync\|chmod\|symlink\|process.platform` over `tests/logger-emit` + `lib/logger-emit.js` → no match |
| `scaffold-install-hooks` fixture is a `#!/usr/bin/env sh` shim + `chmod 0o755` on `PATH` | `helpers.js:14-21`; **no** test asserts the shim's version or the resulting diagnostics (`0.4.0` appears only as the factory default) |
| The CLI under test probes external binaries | `bin/aigentry-devkit.js:16-22` `spawnSync("which", …)` (**not** win32-aware; contrast `:75-78` `commandExists`, which is); `lib/scaffold/project/generate.js:76` `spawnSync("aterm", …)`; `lib/scaffold/install-hooks/claude.js:26` `spawnSync("telepty", …)` |

## 2. #748 — smallest correct fix (`tests/scaffold-install-hooks/v1/claude-version-bump.test.js`)

**Root cause `[M]`.** `lib/scaffold/install-hooks/claude.js:16-18` reads `package.json.version` **at runtime** and stamps it via `templates/scaffold/hooks/claude/context-ref.sh:5`. Replacement is decided by **content inequality** (`claude.js:150-153`), not semver ordering — so `0.0.20` at `:27` is only a "different content" marker, and the test name's word "older" carries no product meaning. The literal `0.0.21` at `:37` broke at `22ec044` (2026-07-05) and would break at every future release.

**Fix `[P]` — through the existing helper export, no hand-counted paths.** `helpers.js:7,43-50` already exports `repoRoot`, and this test already imports from that module:

```js
const { makeTeleptyShim, mkScope, runCli, repoRoot } = require("./helpers");           // + repoRoot
const DEVKIT_VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const STALE_VERSION  = "0.0.0-stale-fixture";                  // + never a published version
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");   // +
assert.notEqual(STALE_VERSION, DEVKIT_VERSION);                // + guard: fixture can never go vacuous
:27  renderWithDevkitVersion(current, STALE_VERSION)
:29  assert.match(..., new RegExp(`^# devkit version: ${esc(STALE_VERSION)}$`, "m"))
:37  assert.match(..., new RegExp(`^# devkit version: ${esc(DEVKIT_VERSION)}$`, "m"))
```

**Strictness preserved — nothing deleted:** exit 0 on both runs (`:23`, `:35`); stdout matches `/replaced .+aigentry-context-ref-v1\.sh/` (`:36`); exactly one `.bak.` backup (`:39-40`); the version line stays **anchored exact-match** (`^…$`, `m`), never `includes`; `:29` still proves the stale render landed, so `:37` proves a *transition*, not a static read. **Not a tautology**: the assertion still fails if the producer drops the line, stamps the wrong slot (`MIN_TELEPTY_VERSION`), loses the `{{DEVKIT_VERSION}}` placeholder, or fails to replace the stale file. It deliberately stops asserting *which* number is current — release metadata, not a hook contract.

## 3. Rot reconciliation against the product contract

Both are **stale test expectations, not product defects** `[M]`.

### 3.1 `tests/orchestrator-profile.test.js:251-255`
Contract at HEAD: `config/modules/orchestrator-role.adapter.json:37` → `"self_symlink_repoint": []`; the `install.sh:825-831` loop is a declared no-op; `install.sh:820-824` states *"#613 A2: open-session.sh is NO LONGER repointed"*; commits `ba879d9` (#613 A2), `378882d` (#614). The fixture `tests/fixtures/fake-orchestrator/bin/` ships only `dispatch.sh`, `install-instructions.sh`, `session-reconciler.sh`. The test asserts the **pre-#613** contract.

**Correction `[P]`:**
```js
assert.equal(
  fs.lstatSync(path.join(orchDir, "bin", "open-session.sh"), { throwIfNoEntry: false }), undefined,
  "#613 A2: installer must not create or repoint open-session.sh (no entry of any kind, incl. dangling symlink)");
```
`lstat` does not follow the link, so a wrongly-created **dangling** symlink fails; `existsSync` would silently pass it `[M]`.

**Coverage gap, left honest and out of scope (X8).** `install.sh:825-831` stays **uncovered**, and R3 proposes nothing to change that. R2's product-override proposal is withdrawn: `install.sh:12` derives `DEVKIT_DIR` from `dirname "$0"`, so an isolated fixture checkout could seed a non-empty `self_symlink_repoint` **without any production API change** `[M]` — a viable future route, deliberately **not** scoped into #1143 (a full fixture checkout of the installer is a materially larger test than this task's wiring). Recorded here in prose; **not** an entry in the §6 ledger, which holds file exclusions only (X5).

### 3.2 `tests/open-session-codex-flag.test.sh:33-37`
Contract at HEAD, `bin/open-session.sh:131-133` — `claude` → `--permission-mode bypassPermissions`; `codex` → `-c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox`; `gemini` → `-m ${AIGENTRY_GEMINI_MODEL:-gemini-2.5-flash} --approval-mode yolo`. The gemini `-m` default came from `b1dc3cd` (2026-06-07, #553); the test greps **whole-line literals**, so a spec'd addition reads as a regression `[M]`.

**Correction `[P]`.** Keep three per-CLI checks; assert *invariant tokens* on the extracted `<cli>)` case line, and make explicit the guard the literal only encoded by accident: every case still carries `[ -z "$extra_flags" ]` (user `--extra-flags` must win — `:73`, `:127-128`); plus each CLI's tokens above, with `gemini` requiring `--approval-mode yolo` **and** `-m ` **and** `AIGENTRY_GEMINI_MODEL` defaulting to `gemini-2.5-flash`. Failure output keeps printing the actual case lines (`:28`).

## 4. Scope boundary — WTM suites vs devkit suites

`[M]` **All 13 `tools/wtm/tests/test-*.sh` reference `$HOME`/`${HOME}`.** `test-lock.sh:6-7` sources `${HOME}/.wtm/lib/{common,atomic}.sh`; `test-runner.sh:111` globs `"${HOME}/.wtm/tests"/test-*.sh`; `test-runner.sh:14` hardcodes `mktemp -d /tmp/…`, ignoring `TMPDIR`. Their system under test is an **installed** WTM at `~/.wtm`, not this checkout — a declared scope boundary, **not** excluding a red suite to get green.

`[M]` **Runner defect.** `test-runner.sh` skips itself only on the default-discovery branch (`:112`); the argv branch (`:107-108`) has none, so `bash test-runner.sh tools/wtm/tests/test-*.sh` `source`s the runner into itself → unbounded recursion. Reproduces `[H]` the task-107 incident.

**Owner-search evidence `[M]`** (over `state/task-queue.json`, 1147 tasks, worktree base `89c40e6` — a historical snapshot, not live queue state): `tools/wtm/tests` → none; `test-runner.sh` → none; self-source/recursion → only #871 (`pending`, repo-symlink deploy runbook — unrelated); wtm+harness → none; every task whose `desc` mentions `wtm` → #295 `cancelled`, #297/#300/#301/#307 `done`, #314 `pending`, #589 `blocked`. Devkit history for the file: one commit, `e3e4617` (initial vendoring); no devkit doc mentions `test-runner.sh`. **No existing owner found under those predicates.** R3 **recommends no target and proposes no ID** — assignment is orchestrator administration (§11 D-7). #314 is noted as the only *live* WTM task but is **not** proposed as a home; broadening it would need its own contract review.

**Devkit `tests/*.bats` — what was actually measured (W5 stands).** `[M]` Each `setup()` **assigns** `HOME` into `$BATS_TMPDIR` (`platform.bats:6`, `session-cleanup.bats:6`, `ctx-e2e.bats:9-11`), **writes** stub `telepty`/`brain`/`curl` onto a sandbox `PATH`, uses `PLATFORM_OVERRIDE`, and `teardown()` removes the sandbox `HOME`. `[A]` **That is source reading, not containment** — not verified: that every code path honours the assigned `HOME`, that no descendant re-reads the real environment, or that nothing reaches a host socket. These suites are proposed for registration and are **not** certified safe to run on a developer host (§9).

## 5. Registration `[P]`

### 5.1 One structured registry — `tests/suites.json`
Single source of truth; nothing parses shell strings. Each entry: `{ id, runner: "node-test"|"bats"|"bash-script", files[]|command, platforms[], group, venue }`. Plus a top-level `gateFixtures` map (§7) and `schemaVersion`.

Consumed by exactly three artifacts: **`tests/run-suite.mjs`** (dispatcher the npm scripts call — **owner: coder, U5**), `.github/workflows/*.yml` (via `node tests/run-suite.mjs --list --json`), and `tests/registration.test.js` (§6). **Runtime-additions rubric:** it is **not** a test framework — `node:test` and `bats` remain the runners; it is a dispatcher over `node:fs` + `node:child_process`, dev-only, excluded from `package.json:files[]`, zero new dependencies. It exists because the alternative — duplicating file lists across `package.json`, two workflows and the drift guard, then parsing shell strings to reconcile them — is the failure mode the review named. **No size estimate is given (X10);** the coder determines it.

### 5.2 Platform classification — by measured dependency, never by runner label (Y1, Y2)

A suite's `platforms` value is derived from the **subprocess, filesystem and OS-branch dependencies it actually exercises**, not from the language its entrypoint is written in. `node-test` is a runner, not a portability claim.

| id | runner | platforms | basis |
|---|---|---|---|
| `logger-emit` | `node-test` | **all** | `[M]` no child process, no chmod, no symlink, no platform branch |
| `registration` (new) | `node-test` | **all** `[P]` | **Proposed, not measured (Z4)** — this code does not exist yet. Designed to spawn only `git ls-files`; `[A]` `git` is present on all three hosted runners. Nothing about it has been executed. |
| `skills-drift` | `node-test` | **posix (v1)** | `[M]` `fs.symlinkSync` at `skills-drift.test.js:81`; `[A]` Windows needs Developer Mode or elevation |
| `scaffold-install-hooks` | `node-test` | **posix (v1)** | `[M]` fixture is a `#!/usr/bin/env sh` shim on `PATH` + `chmod 0o755` (`helpers.js:14-21`); Windows mode/exec semantics differ |
| `scaffold-project` | `node-test` | **posix (v1)** | `[M]` the CLI under test probes `which`/`aterm`; `bin/aigentry-devkit.js:16-22` is not win32-aware. Windows viability **unproven** |
| `orchestrator-profile` | `node-test` | **posix** | `[M]` requires `bash` (`:211`) and `git` (`:55`), POSIX modes/symlinks, darwin/linux-only assertion branches |
| `bats-suites` (5 `.bats`) | `bats` | posix | `[M]` bats + bash |
| `codex-flag` · `platform-usage` | `bash-script` | posix | `[M]` bash |
| WTM (13 files) | — | **not registered** | §4 |

**Consequence, stated plainly:** on `windows-latest` v1 would run **`logger-emit`, plus `registration` if that suite is built as specified** — 1 of the 6 pre-existing suites is measurably Windows-capable. **No Windows suite has been run and no Windows result is claimed** (Z4). That is the honest coverage figure; inflating it by trusting the runner label is what Y1/Y2 withdraw. The four `posix (v1)` entries are marked so **pending a separately approved port** (§11 P3), not permanently. Each carries its basis in `platformSkips[].reason`, so §6 fails CI if a suite is neither run nor declared.

`run-suite.mjs` filters by `process.platform`, prints declared skips with their reason, and on posix treats a missing `bats` as a **hard error, never a skip**. `npm test` and CI share the one filter, so they cannot disagree.

`"test": "node tests/run-suite.mjs --all"`. The four existing `test:*` names are kept as thin aliases (`--suite <id>`). **Globs are removed**: `node --test <glob>` depends on the invoking shell expanding it and `npm run` uses `cmd.exe` on Windows; explicit registry lists make the command deterministic everywhere, and §6 makes a stale list a hard failure.

**CI** (`ci.yml`): 3 OS × 3 Node; each cell runs `node tests/run-suite.mjs --all`, the registry deciding what that means per OS. **Release** (`release.yml`): job `validate` runs the same command on ubuntu + Node 20 — sequenced after bats provisioning, the log path, and a demonstrated-sensitive gate (§10, U13 ← U9, U12).

## 6. Deterministic omission detection `[P]` — `tests/registration.test.js`

**Inventory vs fixtures (X4).** *Test inventory* = units of execution; each must have **exactly one** owning suite. *Shared files* — `tests/fixtures/**`, `helpers.js`, `helper.js`, `tests/suites.json`, `tests/run-suite.mjs` — are never inventoried and may be referenced by many suites. **Gate fixtures are enumerated, not ignored**: the guard reads `gateFixtures` and **fails** if any file under `tests/_gate/` is not exactly one of those three declared paths, so a new test dropped there is caught rather than hidden.

**Two typed records, separately validated (X5)** — `tests/registration-exclusions.json`:
- `unregisteredFiles[]` = `{ path, reason, owner }` — **file inventory only**. v1: the 13 WTM files (*"tests an installed `~/.wtm`, not this checkout"*).
- `platformSkips[]` = `{ suiteId, platforms[], reason }` — suite-level, **never** a file path.

Each record type has its own schema check; a value of one shape appearing in the other list **fails**. `install.sh:825-831` is **not** in this file — a source-branch coverage gap is not a file exclusion; it lives in §3.1 prose (X5).

**Inventory source and failure modes (X6).** Inventory comes from `git ls-files -- tests tools/wtm/tests`. If `.git` is present, a `git` failure or unparseable output **fails the test** — never a skip. The **only** skip is the explicitly supported tarball mode (no `.git` present), which reports its reason. There is no skip-on-error path.

The guard **fails** when: an inventory file is claimed by zero suites and absent from `unregisteredFiles`; claimed by two or more suites; named in the registry but missing on disk; listed as unregistered while no longer existing; a shared file is claimed as inventory; or an undeclared file exists under `tests/_gate/`. **WIP-safe**: tracked-only inventory means untracked WIP (`tests/install-fallback.test.js`, `tests/exec-mode/`) never fails the gate and **no one must delete untracked source to run tests**; matches are printed as an informational notice.

## 7. Per-suite gate-sensitivity `[P]` — dispatcher-boundary canaries (X3)

Three enumerated fixtures, each valid for exactly one runner: `tests/_gate/canary.test.js` (`node-test`), `tests/_gate/canary.bats` (`bats`), `tests/_gate/canary.sh` (`bash-script`). Each fails unconditionally when invoked and prints the unique marker `AIGENTRY_GATE_CANARY_TRIPPED`. **No suite-id matching inside a canary** — arming is positional, done by the dispatcher. **Nothing is copied, relocated, or appended to any existing script.**

| runner | injection | assertions (runner-specific) |
|---|---|---|
| `node-test` | dispatcher adds `canary.test.js` to that suite's file list — no relocation | exit ≠ 0 · marker exactly once · TAP `# fail` = baseline + 1 |
| `bats` | dispatcher adds `canary.bats` to that suite's file list | exit ≠ 0 · marker exactly once · `not ok` count = baseline + 1 |
| `bash-script` | dispatcher invokes `canary.sh` **as a `bash-script`-kind suite** through the identical dispatcher path — the real suite is untouched | exit ≠ 0 · marker exactly once · **no count delta** (a bash script emits no TAP totals) |

**Stated limit, not papered over.** For `bash-script` suites this proves that a non-zero exit propagates dispatcher → npm script → CI step — the whole distance between the script's exit code and the gate. It does **not** prove a mutation *inside* a specific bash script; that is unreachable without the relocation X3 disproved, and a script's exit code is its contract.

**Procedure per suite id** — a pre-existing failure must never be read as gate sensitivity:
1. **Clean baseline** through the real gate command, canary absent: require exit 0 **and** marker absent, recording the runner-specific counts. A red baseline makes that suite's selftest **BLOCKED and reported** — never skipped, never counted as passing.
2. **Armed run** through the same real gate command: the assertions above, plus stderr free of unrelated-error signatures (`ENOENT`, `command not found`, `SyntaxError`, `Cannot find module`).
3. Retain both raw logs (§8).

**Proof at the real boundary.** Assertions are on the **npm script's** exit status, and for at least one suite per runner kind on the **workflow step outcome**: a `gate-selftest` job arms the step with `continue-on-error: true`, and a following step fails unless `steps.<id>.outcome == 'failure'`. On `windows-latest` the selftest covers only the suites that actually run there (`logger-emit`, `registration`) — §5.2, not every `node-test` suite.

## 8. Runtime totals, logs, and output handling `[P]` (Z1, Z2)

**Raw output is non-public by default.** Not because a check failed, but because no check available here can establish that it is safe to share.

- **P-SEC is a bounded observation, not proof (Z1).** V1–V4 (§9 S-4a) examine an **enumerated scope**: environment-variable **names** in the dispatcher's own process at start; two files, `.git/config` and `.git/config.worktree`, in the checkout; four named GitHub Actions variables; and `.npmrc` at enumerated paths. **Passing them authorises nothing** — they can only ever *fail* a run. Absence of matching text is not evidence of absence of a secret.
- **Unmeasured channels, named rather than implied:** variable **values** (a credential in a variable whose name matches no pattern); every credential file outside the four enumerated paths (other git configs, git credential helpers, `~/.config/gh/hosts.yml`, `~/.aws`, `~/.docker/config.json`, OS keychains); network-reachable OIDC and instance-metadata endpoints; anything a suite fetches at runtime; and anything a descendant emits **after** the checks ran. None of these is scanned, and R5 deliberately does **not** add a credential scanner or any security framework.
- **Default handling.** Suite stdout/stderr is redirected to a file in the job workspace and **not uploaded**. Only a **sanitized status** — suite id, exit code, duration, runner-specific counts, pass/fail — reaches the CI console and `$GITHUB_STEP_SUMMARY`. This covers **both** channels: a GitHub Actions **console log is itself published** to anyone with repository read access (Z2), so redirecting output is what makes the sanitized-status rule meaningful; gating uploads alone would not.
- **Retention and sharing of raw logs require an explicit evidence review** against a provisioned fixture set, establishing what may be retained and by whom (§13 OP2). Until that review exists, raw logs are retained only inside the ephemeral job and are discarded with it; a failing run publishes the sanitized status plus the named unmet gate, never raw output.
- `tee` must not swallow the exit: `set -o pipefail` (or `${PIPESTATUS[0]}`) on every teed invocation; the dispatcher asserts the recorded exit equals the runner's exit.
- The CI test job consumes **no** repository secrets; `NPM_TOKEN` stays scoped to `release.yml`'s `publish` job. Whether the job can additionally run under `permissions: {}` is a **feasibility check, not a promise** (§13 OP4).

## 9. Safety contract — **binding before any run** `[P]`

- **S-1 source-side-effect preflight.** Statically enumerate every child spawn and parent-env spread and prove each re-points `HOME`, `TMPDIR`, `XDG_*` into a sandbox. Known spread sites `[M]`: `tests/orchestrator-profile.test.js:42`, `:213`; `tests/scaffold-project/v1/helper.js:31`; `tests/scaffold-install-hooks/v1/helpers.js:27` — all four spread `...process.env` today.
- **S-2 env allowlist — platform-conditional hygiene, explicitly not containment (X7, Y3).** The dispatcher builds `env` from a fixed allowlist; everything unlisted is dropped **by construction**, so no variable family is named and R4 asserts nothing about any parent environment's contents. **POSIX:** `PATH`, `HOME`→sandbox, `TMPDIR`→sandbox, `XDG_{CONFIG,DATA,CACHE}_HOME`→sandbox, `USER`, `LOGNAME`, `LANG`, `CI`. **Windows `[A]` — unverified:** `Path`, `USERPROFILE`→sandbox, `TEMP`/`TMP`→sandbox, `SystemRoot`, `windir`, `SystemDrive`, `COMSPEC`, `PATHEXT`, `APPDATA`/`LOCALAPPDATA`→sandbox, `ProgramData`, `ProgramFiles`, `CI` (names are case-insensitive on Windows). A POSIX-shaped list is **not** sufficient there — without `SystemRoot` and `COMSPEC` process creation and many Win32 APIs fail. **Fail-closed:** if a required variable for the host platform is absent from the parent environment the dispatcher **errors instead of spawning** with a broken environment. The Windows list is unmeasured and must be validated on a Windows runner (U11) before any Windows leg is trusted. **This constrains what children inherit — it does not constrain what they do.**
- **S-3 inert primitives for missing-resource contracts (X1, X2).** A contract about a *dead or missing* PID is tested by **shadowing the primitive, never performing it**. Verified seam `[M]`: `platform-unix.sh` calls `kill` bare at `:9`, `:19`, `:26`, so a shell function `kill() { return 1; }` defined before `source` shadows it for that shell. **U2b replaces both hardcoded `999999` calls with:**
  - **(a) missing-PID, inert** — shim `kill`, and additionally pass a **non-numeric** token (`not-a-pid`) so that even if the shim were bypassed no real process could be signalled. Assert `platform::is_alive` non-zero and `platform::kill_pid` → 0 (the early-return at `platform-unix.sh:17`). Belt and braces: two independent reasons no signal reaches a real process.
  - **(b) live owned child** — spawn `sleep`, capture `$!`; assert `platform::is_alive` → 0 (a `kill -0` probe on our own child delivers no signal); assert `platform::kill_pid` → 0 and the child terminates; then `wait` to reap. **Nothing is called on that PID after reaping** — no stale-PID operation exists anywhere in the suite.
  - The empty-argument contract (`kill_pid` → exit 2) needs no PID and is kept.
  - **No hardcoded, foreign, or reaped PID is ever signalled.** `[A]` The R2 `pid_max` figures are retracted (X2); the redesign does not depend on any OS limit.
- **S-4 two independent properties, never conflated (Y4).** A dispatcher-level wrapper cannot constrain a descendant's shell builtins, absolute-path calls, or network — R4 does not claim it can. Instead two *separate* properties are tracked, because a host can have either without the other:
  - **P-ISO (host isolation)** — the host tolerates arbitrary side effects. **Not measurable from inside the job.** Established only by provisioning: a disposable OS VM with no host filesystem mounts, no host sockets and no host credentials.
  - **P-SEC (secret-free evidence)** — no credential is reachable, so raw logs are safe to publish. **Measurable in-process** (S-4a).
  A developer host can satisfy P-SEC while failing P-ISO; a CI runner can satisfy P-ISO while failing P-SEC (a credential-persisting checkout). Each suite carries `venue: "vm-only" | "pure"`. **`[A]` Every suite is `vm-only` today** — none has been audited; `pure` is earned by U11 evidence, never asserted here.
- **S-4a fail-closed gate, evaluated before the first child spawn (Y4, Y5, Y6).** `run-suite.mjs` computes the venue record and decides **before** spawning anything. A `vm-only` suite runs only if **P-ISO is attested** and **P-SEC verifies**; otherwise it is refused, unspawned, and named in a non-zero exit.
  - **P-SEC — four bounded observations, not a verification (Z1).** V1: no variable in the **parent** environment has a name matching `/(TOKEN|SECRET|_KEY|PASSWORD|CREDENTIAL)/i` (the parent, not the filtered child — the question is what is *reachable*, not what was forwarded). V2: neither `.git/config` nor `.git/config.worktree` in the checkout contains an `extraheader` / `AUTHORIZATION` entry — `[A]` `actions/checkout` persists a credential there **by default**, so the workflow must set `persist-credentials: false`, and V2 observes whether it did. V3: `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_URL`, `GITHUB_TOKEN` are absent (named explicitly because they are auto-injected). V4: no `.npmrc` at the enumerated paths contains `_authToken`. **A failure blocks the run; a pass authorises nothing** — the evaluated scope and the unmeasured channels are listed in §8, and raw output stays non-public regardless.
  - **P-ISO — attested, not detected, and honestly so.** `CI=true`, or any variable a user can set, is **not** isolation proof and is not accepted. The gate requires a `venueAttestation` written by an explicit **provisioning step** in the workflow (`{ venue, workflow, runId, runnerEnvironment }`), plus `RUNNER_ENVIRONMENT === "github-hosted"` used **only as a negative filter** to rule out self-hosted runners. **P-ISO cannot be proven from inside the job.** What the gate buys is that the assertion is explicit, reviewable in the workflow diff, and **absent by default**, so it can never be satisfied accidentally on a developer host. A missing or malformed attestation is **fail-closed**: no spawn, non-zero exit, reason named. It is never inferred from a label alone.
- **S-4b default local `npm test` — unconditional refusal, no override (Z3, approved policy).** On a developer host there is no attestation, so every `vm-only` suite — today, all of them — is **refused before any spawn**, and the dispatcher exits non-zero listing what was refused and why. **There is no escape flag.** R4's `--allow-host-run` is removed; the approved policy is that a developer host is simply not a venue for `vm-only` suites.
  **The honest consequence:** until at least one suite is reclassified, `npm test` on a developer host runs nothing and fails. That is the correct behaviour, not a gap to be patched with a flag.
  **The only path to local admission is evidence, not permission.** A suite becomes `pure` — and therefore locally runnable — when a **bounded per-suite audit** shows it exercises no OS primitive outside the audited inert seam: no child process, no write outside its sandbox, no chmod/symlink dependency, no network. `logger-emit` is the obvious first candidate (`[M]` today: no child process, chmod, symlink or platform branch). The audit is U11 work reviewed as evidence; **no policy grant can substitute for it**, and this spec grants none.
- **S-5 bounding, not a process framework (X7).** R2's pgid/Job-Object teardown design stays withdrawn as disproportionate to a CI wiring task. Bounding is: a dispatcher per-suite timeout (proposal: 300 s); on a disposable VM residue dies with the VM; on a developer host `vm-only` suites do not run. Residue observed is **reported as residue** — R4 makes **no** claim of universal reaping on any host.
- **S-5a what is verified vs assumed (required disclosure).**

  | Property | How established | Status |
  |---|---|---|
  | P-SEC V1–V4 | observed in-process by the dispatcher at start, over the §8 enumerated scope | **bounded observation — can fail a run, never authorises one** |
  | `persist-credentials: false`; no secrets in the test job | declared in the workflow, reviewed in the diff; V2/V3 observe the effect | **verified by trusted provisioning** |
  | `permissions: {}` on the test job | — | **`[A]` feasibility unverified** — may break checkout / artifact upload / bats provisioning; U9 must check and document the minimum viable set (OP4) |
  | Credential channels outside the §8 enumerated scope | — | **`[A]` unmeasured; the reason raw output is non-public by default** |
  | Runner is GitHub-hosted, not self-hosted | `RUNNER_ENVIRONMENT` negative filter | **weak signal** — rules out, does not prove |
  | Runner VM is disposable, with no host mounts/sockets/credentials | documented Actions behaviour | **`[A]` assumed, unmeasured, unmeasurable from inside the job** |
  | Suites do not reach the network or escape the sandbox | — | **`[A]` unmeasured; the reason every suite is `vm-only`** |
  | Windows env allowlist sufficiency | — | **`[A]` unmeasured; U11 must validate before a Windows leg is trusted** |
- **S-6 evidence retention.** Raw stdout/stderr verbatim, dispatcher source, `git rev-parse HEAD`, `git status --porcelain` before **and** after, UTC start/end. No `rm -rf` of the evidence directory before the report is written `[H]` (task-132's ephemeral dir was deleted at 09:21:14Z; its raw files are gone).
- **S-7 standing withdrawal.** `[H]` A preliminary WTM check ran with the **real** `HOME`; the blanket "no side effects" claim is withdrawn and causation for the 09:22:55Z / 09:23:33Z telepty daemon outages is **UNKNOWN**. No WTM suite may be re-run by anyone until S-1…S-4b hold.
- **S-8 first-run gate.** No suite is certified safe by source reading (§4). Before any first execution, S-1…S-3 must be implemented and reviewed, and the S-4a gate must pass in a `vm-only` venue. **This revision executes nothing.**

## 10. Ordered work units — one owner per file, no same-file parallelism `[P]`

### 10.1 First handoff **H1 — harness only** (exact scope)

The first coder dispatch delivers the substrate and **nothing else**: no test-content change, no CI change, no canaries, no registration guard. Three files, one owner each, no same-file parallelism:

| artifact | new? | owner | contents |
|---|---|---|---|
| `tests/suites.json` | new | coder | registry data only: `schemaVersion`, one entry per suite (`id`, `runner`, `files[]`/`command`, `platforms[]`, `group`, `venue`), and `gateFixtures` paths **declared but not yet created** |
| `tests/run-suite.mjs` | new | coder | dispatcher: registry load + schema validation · platform filter (§5.2) · platform-conditional env allowlist (S-2) · **fail-closed venue gate evaluated before any spawn** (S-4a) · unconditional local refusal (S-4b) · per-suite timeout · output-to-file with sanitized console status (§8) · exit propagation |
| `package.json` | modified | coder | `"test"` → `node tests/run-suite.mjs --all`; the four existing `test:*` names kept as `--suite <id>` aliases |

H1 is exactly units **U4, U5, U6** of the table below, in that order.

**Executable-safe substrate prerequisite.** No venue exists yet, so H1 must be acceptable **without running any suite**. It is: the only code path reachable before a venue is provisioned is the gate's **refusal** path, which spawns nothing. H1's acceptance check is therefore zero-spawn — on a developer host, `npm test` must refuse every `vm-only` suite, name each refusal and its reason, spawn no child, and exit non-zero. **Nothing else in H1 may be executed**, and no suite result may be claimed from it.

**H1 explicitly excludes** — each is a later handoff, after a venue exists: the §3 test corrections (U1–U3), the S-3 PID fixtures (U2b), the registration guard and ledger (U7), the canaries (U8), and both workflows (U9, U13). Everything H1 produces is `[P]` **proposed code with no runtime evidence** (Z4).


| # | role | file / artifact | depends on |
|---|---|---|---|
| U1 | coder | `tests/scaffold-install-hooks/v1/claude-version-bump.test.js` (§2, #748) | — |
| U2a | coder | `tests/orchestrator-profile.test.js` (§3.1) | — |
| U2b | coder | `tests/platform.bats` — S-3 inert + owned-child fixtures (**safety-blocking**) | — |
| U3 | coder | `tests/open-session-codex-flag.test.sh` (§3.2) | — |
| U4 | coder | `tests/suites.json` (new, §5.1) | U1–U3 |
| U5 | coder | `tests/run-suite.mjs` (new — dispatcher, platform filter, **platform-conditional allowlist**, **S-4a fail-closed venue gate**, timeout, tee/pipefail, canary injection) | U4 |
| U6 | coder | `package.json` scripts → dispatcher (§5.2) | U5 |
| U7 | coder | `tests/registration-exclusions.json` + `tests/registration.test.js` (new, §6) | U4 |
| U8 | coder | `tests/_gate/canary.test.js` · `canary.bats` · `canary.sh` (new, §7) | U5 |
| U9 | coder | `.github/workflows/ci.yml` — matrix, bats provisioning (D-3), `permissions: {}`, `persist-credentials: false`, venue attestation step, P-SEC-gated artifacts (§8), `gate-selftest` | U6, U7, U8 |
| U10 | coder | S-1 preflight report + S-6 evidence capture wired into `run-suite.mjs` | U5 |
| U11 | tester | **first authorized execution** behind a passing S-4a gate; validate the **Windows allowlist** on a Windows runner; produce the audit evidence that could reclassify a suite `pure` | U10, U2b |
| U12 | tester | §7 gate-sensitivity: baseline → armed → runner-specific assertions, per suite | U8, U11 |
| U13 | coder | `.github/workflows/release.yml` — `validate` → dispatcher | **U9, U12** |
| U14 | coder | `snyk_code_scan` over all new/modified JS, fix from result context, **rescan until clean** | U13 |

U1, U2a, U2b, U3 are independent. The safety-bearing code (U5, U10) is **coder-authored and reviewed before** the tester's first execution (U11); the tester authors no harness. `[M]` None of these paths appear in the source repo's 16 `M` / 68 `??` dirty set, so no WIP needs staging or copying — integration must still re-measure drift, since post-2026-09-09 edits are unmeasurable from here.

## 11. Approved policy — recorded, not re-opened

User-approved at the R5 boundary. **These are settled; this spec does not re-ask them and raises no new decisions.**

| ref | policy | effect in this spec |
|---|---|---|
| P1 (was D-2) | **Include** the stale test-expectation corrections in #1143 | §3.1, §3.2 are in scope as **test-only** changes (U1–U3) |
| P2 (was D-3) | **CI-only pinned Bats** | §5.2 / U9: `bats-core` checkout pinned by release tag **and** commit SHA, on `PATH`, never in `package.json` / `package-lock.json` / `files[]`. **No tag or SHA is proposed here** — the pin comes from primary upstream evidence at implementation time (§13 OP3) |
| P3 (was D-4 + D-9) | **Explicit Windows exclusions; port is a separate task** | §5.2 `posix (v1)` classifications recorded in `platformSkips[].reason`; the port of `scaffold-project`, `scaffold-install-hooks`, `skills-drift`, `orchestrator-profile` is **out of #1143** |
| P4 (was D-6) | **Leave `install.sh:825-831` outside this scope** | §3.1 records it as an uncovered branch in prose; it is **not** a ledger entry and no product change is proposed |
| P5 (was D-8) | **Omit `--allow-host-run`** — no escape hatch | §9 S-4b: local refusal is unconditional; local admission comes only from bounded audit evidence reclassifying a suite `pure` |
| P6 (was D-5) | **#748 owns its fix; #1143 depends on it** | U1 lands under #748; #1143 declares a hard dependency and is **not** recorded as having fixed #748 |
| P7 | **Release / publication remains separate** | `release.yml` (U13) stays behind U9 and U12 and is not part of the H1 handoff |
| P8 (was D-1) | Dispatcher + registry is the `npm test` mechanism | §5.1, §5.2, §10.1 |

**One administrative item remains open, and it is not a design question:** the owner for the WTM `test-runner.sh` argv self-exclusion defect (§4). R3's owner-search evidence stands; **no target is recommended and no ID is proposed** — assignment is orchestrator administration (§13 OP8).

## 12. Assumptions, gates, and what is **not** measured `[A]`

- **P-ISO is unmeasurable from inside the job** and is assumed from provisioning; the disposability of a hosted runner, its lack of host mounts/sockets/credentials, and `actions/checkout`'s default credential persistence are all `[A]` documented Actions behaviour, unverified here by execution.
- **The Windows env allowlist is unmeasured `[A]`** — composed from documented Windows process-creation requirements, not from a run. U11 must validate it on a Windows runner before any Windows leg is trusted.
- **Windows viability of `scaffold-project` was not proven either way** — it is marked `posix (v1)` because the CLI it drives probes external binaries via a non-win32-aware `which` (`bin/aigentry-devkit.js:16-22`), not because a Windows failure was observed.
- **No suite is certified safe to run.** §4's bats finding is source reading, not containment; every suite is `vm-only` until U11 produces bounded audit evidence. **Nothing has been executed in any revision, on any platform.** No suite result — Windows or otherwise — is claimed anywhere in this spec.
- **OS PID limits were never read** (X2) — `kern.maxproc` / `/proc/sys/kernel/pid_max` unmeasured, and the S-3 design does not depend on them.
- **The `kill`-shadowing seam is measured at the call sites** (`platform-unix.sh:9,19,26` are bare `kill`) but **its behaviour under bats `run bash -c` was not executed** — U2b must demonstrate it.
- **Node's directory-discovery patterns for `*.spec.js` on Node 18/20 were not measured**; the explicit registry removes any dependence on the answer.
- Every pass/fail/duration figure is `[H]` from the task-132 single serial run (15 commands, 4 exit-1) — single-run evidence with acknowledged isolation gaps, **not** proof.
- **Remote GitHub Actions run history was not inspected**; both workflows were read from `HEAD` as static manifests. `[A]` `steps.<id>.outcome`, `actions/upload-artifact@v4`, and the hosted runner's disposability (no host mounts/sockets/credentials) follow documented Actions semantics, unverified here by execution.
- **`state/task-queue.json` was read at worktree base `89c40e6`** — a historical snapshot; live queue state was not queried, so §4's owner search is only as current as that file.
- **Untracked WIP** (`tests/install-fallback.test.js`, `tests/exec-mode/`) is not registered; disposition belongs to #593. §6 reports it informationally and never blocks.
- **Every artifact this spec proposes is `[P]` design, not evidence** (Z4): `tests/suites.json`, `tests/run-suite.mjs`, `tests/registration.test.js`, the exclusions ledger and the three canaries do not exist. Their platform classifications, behaviour and pass/fail status are unverified by construction.
- **Snyk**: this deliverable is docs-only (N/A). The code H1 and later handoffs introduce **must** pass scan → fix → rescan before any DONE report (U14).

## 13. Frozen — unresolved operational prerequisites

The design is frozen at R5. Nothing below is a new decision; each is an operational precondition that must be satisfied by provisioning or by evidence before the work it gates can proceed.

| id | prerequisite | gates | owner |
|---|---|---|---|
| OP1 | A disposable-VM venue with its provisioning attestation step exists (§9 S-4a). Absent it, the gate refuses everything. | any suite execution | provisioning / U9 |
| OP2 | An evidence review against a provisioned fixture set establishing what raw output may be retained and shared (§8). Until then raw logs stay non-public and job-local. | raw-log retention or upload | review |
| OP3 | The `bats-core` pin — release tag **and** commit SHA — taken from primary upstream evidence and recorded with it (P2). | U9 bats provisioning | coder at U9 |
| OP4 | Feasibility of `permissions: {}` for `actions/checkout`, artifact upload and bats provisioning; if infeasible, the **minimum viable permission set** documented and re-reviewed (Z5). | U9 workflow | coder at U9 |
| OP5 | The Windows env allowlist validated on a Windows runner (§9 S-2). It is composed from documented requirements, never measured. | trusting any Windows leg | U11 |
| OP6 | The `kill`-shadowing seam demonstrated under `bats run bash -c` (§9 S-3). Measured at the call sites only. | U2b acceptance | U2b / U11 |
| OP7 | Bounded per-suite audit evidence for any `pure` reclassification (§9 S-4b). Without it `npm test` on a developer host correctly runs nothing. | a locally usable `npm test` | U11 |
| OP8 | Owner assignment for the WTM `test-runner.sh` argv self-exclusion defect (§4). | that repair | orchestrator administration |

**Freeze conditions.** No further broad audit is proposed. No new user decision is raised. The next artifact is **H1 (§10.1) — harness only, three files, zero-spawn acceptance**; every subsequent handoff waits on OP1.
