# devkit WIP baseline — evidence for #1142 / #1143 / #1145 (task #593)

- **Measured (UTC)**: 2026-09-09T09:32:33Z — 09:41Z. Author: `ec593-ec593-architect` (architect, read-only on sources).
- **Report worktree**: `/Users/duckyoungkim/.aigentry/worktrees/ec593`, branch `docs/593-devkit-baseline`, base SHA `509fb4e19f8f2d834bc0aa0d934933ff469c7bc0`.
- **Source under measurement**: `/Users/duckyoungkim/projects/aigentry-devkit`, branch `main`, HEAD `bb7876bcbe8f83c2d329b22f41751b2b07f1f61a` (= `origin/main`, committed 2026-07-26T23:12:38+09:00).
- **Nothing was staged, stashed, reset, cleaned or discarded.** All commands were read-only (`git status/diff/show/log/rev-parse/hash-object/ls-files/for-each-ref/check-ignore`, `grep`, `sed -n`, `cat`); all exited 0 except `git check-ignore` (exit 1 = not ignored, expected).

## 1. Dirty-state inventory — explicit predicate

Predicate: `git status --porcelain=v1 --untracked-files=all` in the devkit repo at HEAD `bb7876b`. **84 entries total** = 16 `M` (tracked, modified, unstaged) + 68 `??` (untracked). Index is empty (no `A`/`M ` staged entries). `git stash list` → empty. Tracked diff vs HEAD: **16 files, +349 / −161**.

Untracked splits into **34 first-party files** and **34 orphaned `tests/exec-mode/__pycache__/*.pyc`**.

> Prior task-note count ("17 modified + 38 untracked", 2026-06-10) does **not** reproduce. Current measurement is authoritative for this report; the delta is unexplained and no evidence was found that would attribute it.

## 2. Per-file HEAD vs working-tree blob IDs (16 modified)

| path | HEAD blob | WT blob | bytes HEAD→WT |
|---|---|---|---|
| AGENTS.md | 58a7f47 | a141d66 | 4445→5817 |
| CLAUDE.md | 0c42bb9 | cf37016 | 5168→995 |
| bin/aigentry-devkit.js | fab424d | 5b3c54e | 28829→30746 |
| config/module-adapter.schema.json | 732d653 | 524892d | 2821→3654 |
| config/modules/amplify.adapter.json | a653edc | b6f752c | 502→740 |
| config/modules/brain.adapter.json | 3745e33 | 6586356 | 631→1024 |
| config/modules/bridge.adapter.json | 99b113e | 6aaf5df | 526→655 |
| config/modules/deliberation.adapter.json | 43e38a2 | 31e7e02 | 612→880 |
| config/modules/dustcraw.adapter.json | 75d3c98 | 047b1e6 | 619→856 |
| config/modules/registry.adapter.json | 5ebae2d | 288558e | 550→686 |
| config/modules/telepty.adapter.json | 615b268 | 82f66c9 | 583→720 |
| docs/session-conventions.md | e61526d | 58e3811 | 5172→7193 |
| install.ps1 | 5e9ec13 | 0ce5971 | 20839→22966 |
| install.sh | 650c987 | 9963ead | 37976→40733 |
| templates/aigentry-architect/CLAUDE.md | fdcf7b0 | 883162f | 4622→4119 |
| templates/workspace/GEMINI.md | 563122c | fbad766 | 2223→2500 |

Key untracked blobs (`git hash-object`, content **not** disclosed beyond installer/test code needed here):
`lib/install-fallback.js` 360b78c (25065 B) · `tests/install-fallback.test.js` 1aa6e12 (1436 B) · `bin/aigentry-brain-stub.mjs` 81b2dc3 (3946 B) · `docs/brain-install-fallback-spec.md` 582ed1f (16217 B) · `docs/reports/brain-install-fallback-impl.md` 607f7bc (8582 B) · `docs/specs/2026-06-06-profile-orchestrator.md` ccb09ba (31249 B). Remaining 28 first-party untracked files are `docs/reports/*` and `docs/reviews/*` (2026-04-19 → 2026-06-07) — names/hashes captured, contents not read.

## 3. Provenance — what is proven, inferred, unknown

- **UNKNOWN — authorship/ownership of every WIP item.** Evidence checked and negative: no commit touches these paths on any ref (`git log --all -- <paths>` empty); each of `lib/install-fallback.js`, `tests/install-fallback.test.js`, `bin/aigentry-brain-stub.mjs`, `docs/brain-install-fallback-spec.md`, `docs/specs/2026-06-06-profile-orchestrator.md` is **absent from all 9 local + 5 remote refs**; `git stash list` empty; `git reflog -12` shows only ecosystem-table commits and merges, no WIP-bearing entry. mtime was deliberately not used. **No attribution can be made.**
- **INFERRED (strong, by reference closure — not authorship).** The WIP is one coherent feature, "install fallback chain": WT `install.sh:272-316` defines `run_install_fallback` → `lib/install-fallback.js`; the 7 adapter JSONs each gain an `install.fallback` array; `config/module-adapter.schema.json` gains exactly the matching `kind` enum `["npm-global","npm-ephemeral","stub","skip"]`; `brain.adapter.json` names `aigentry-brain-stub.mjs`, which exists untracked; `docs/brain-install-fallback-spec.md` + `docs/reports/brain-install-fallback-impl.md` describe it. `bin/aigentry-devkit.js` (+51) adds `--verbose/--quiet/--install-timeout/--fallback-mode` that propagate as `AIGENTRY_*` env into the same helper. These references prove the files belong to one change set; they do **not** prove who wrote it.
- **PROVEN — the 34 `.pyc` are orphans.** `tests/exec-mode/*.py` sources were deleted in `28c674b` ("#769 Phase C, #773"); `ls tests/exec-mode/` now shows only `__pycache__`; `git ls-files 'tests/exec-mode/**' | grep -c 'test_.*\.py$'` = **0**. `.gitignore` has no `__pycache__`/`*.pyc` rule (`git check-ignore` exit 1). These are build residue of deleted sources, carrying no first-party content.
- **PROVEN — `CLAUDE.md` WIP is a large deletion** (5168→995 B, −112/+0 net per diffstat). Any preservation step must not silently lose it, and any discard decision must be explicit.

## 4. Related local branches / tasks

`main bb7876b` (=origin) · `wt/wave1-fix-devkit b9692e8` (#589, blocked on this WIP per #593 note) · `fix/cleanup-devkit 9bc8775` · `feat/739-skills-promotion 42fab3a` · `feat/759-ambiguity-gate-skill 2dd6a25` · `fix/749-skill-portable-paths c620726` · `ci/readme-regen ab8969a` · `docs/readme-latest db11cca` · `docs/readme-nanochat-devkit b1159ba`. None contains any WIP path.

Queue (`state/task-queue.json`, this worktree): **#593** `awaiting-user` P1 (this WIP) · **#1142** `pending` P1, parent #526 · **#1143** `pending` P1, parent #526 · **#1145** `pending` P2, parent #526. All three children are marked "Analysis only, implementation NOT dispatched".

## 5. Safe base per follow-up

### #1142 — secret state protection → **safe base: `main` @ `bb7876b`. WIP not required.**
Committed-source writers/readers of the secret:

- **Writer (POSIX)** `install.sh` `write_installer_state()` L186-257 → `$DEVKIT_STATE_FILE` = `${XDG_CONFIG_HOME:-$HOME/.config}/aigentry-devkit/install-state.json`. **L245 writes the field `registry.api_key` with the live value.** No `chmod` is applied to this file — `grep -n chmod` on HEAD `install.sh` returns exactly L269 (`$DEVKIT_ENV_FILE` 600), L402, L443 (both `chmod +x`). So `env.sh` is protected and `install-state.json` is not, at default umask.
- **Writer (POSIX, second copy)** `write_env_fanout()` L259-269 → `$DEVKIT_ENV_FILE` (`env.sh`), field `AIGENTRY_API_KEY` via `printf %q`; this one is `chmod 600`.
- **Writer (POSIX, third copy)** `install.sh` L603-615 → dustcraw config at `mktemp`, field `registryApiKey`; that path is then persisted as `dustcraw.config_path` in state and never removed.
- **Writer (Windows)** `install.ps1` L163/L172 field `api_key` → `$DevkitStateFile` via `Set-Content`; L181/L184 `$env:AIGENTRY_API_KEY` → `env.ps1`; L348 `registryApiKey`. `grep -nE 'Acl|icacls'` on HEAD `install.ps1` → **no matches**: no ACL is set on either file.
- **Sources of the value**: `AIGENTRY_API_KEY` env (L39), `prompt_secret` (L670/L700), or the self-hosted bootstrap response field `raw_key` (L693).
- **Readers of `install-state.json`** (`git grep` over tracked files, full list): `bin/aigentry-devkit.js:499`; `skills/upsell-trigger/SKILL.md:54-58,83` (`jq -r '.profile'`); `tests/orchestrator-profile.test.js:286,331,360`. Stale doc reference to a different path `~/.aigentry/install-state.json` in `docs/plans/2026-03-14-integrated-installer-design.md:434,451`. **No tracked reader consumes `registry.api_key`** — so removing the duplicate from state has no proven in-repo consumer; out-of-repo/legacy consumers are **unmeasured** (see gaps).
- **Field names only are listed above; no state file on this machine was opened and no value was read.**
- **Conflict risk: low, and proven.** `install.sh` lines **1-270 are byte-identical** between HEAD and WT (first divergence at L271/272); `install.ps1` lines **1-186 are byte-identical**. Both entire secret-handling regions are untouched by the WIP, so a #1142 fix on `main` will not collide with the WIP and vice versa.
- **Exact reproduction from committed source alone: YES.** All four writer sites, both file paths, the absent `chmod`/ACL and the field names exist at `bb7876b`.

### #1143 — CI / test wiring → **safe base: `main` @ `bb7876b`. WIP not required (one caveat).**
- `.github/workflows/ci.yml` has one job whose only test step is `node bin/aigentry-devkit.js --help` (matrix 3 OS × 3 Node = 9 runs of a help print).
- `package.json` `"test"` is also `node bin/aigentry-devkit.js --help`. The four real scripts — `test:scaffold-project`, `test:scaffold-install-hooks`, `test:logger-emit`, `test:skills-drift` — are **invoked by nothing in `.github/workflows/`**.
- Tracked test files (`git ls-files 'tests/**'` filtered to `*.test.js|*.spec.js|*.bats|*.test.sh|test_*.py`): **23**. Covered by the four scripts: 9 + 5 + 1 + 1 = **16**. Uncovered by any script: **7** = `ctx-e2e.bats`, `ctx-router.bats`, `open-session.bats`, `platform.bats`, `session-cleanup.bats`, `open-session-codex-flag.test.sh`, `orchestrator-profile.test.js`. Runtime totals were **not** measured (no tests executed — architect role).
- Caveat: `tests/install-fallback.test.js` is untracked WIP, so whether #1143's collected list includes it depends on #593's disposition.

### #1145 — installer plan/log consistency → **BLOCKED on #593 disposition.**
- At `bb7876b`, `printInstallPlan()` (`bin/aigentry-devkit.js:296-317`) prints only manifest path, profile, component names + phase labels, optional components. It surfaces **no** execution chain and **no** log location, and `install.sh` at HEAD contains **no** `--dry-run`/plan code at all (`grep -n 'dry.run\|DRY_RUN'` → no matches) — the plan is computed entirely in JS and the shell never re-states it.
- The "adapter 실행 체인 · 표시 로그" that #1145's description targets exists **only in the WIP**: the `install.fallback` chain (schema + 7 adapters), the per-stage log file `~/.config/aigentry-devkit/logs/install-<UTCstamp>-<component>.log` (`lib/install-fallback.js:86-115`), and the `INSTALL_FALLBACK_RESULT component= entry= kind= status=` stdout contract (`:731`) parsed back into `AIGENTRY_LAST_FALLBACK_{ENTRY,KIND,STATUS}` (`install.sh:308-312`).
- Consequence: scoping #1145 against `main` measures a plan surface that the WIP would replace. **This is the one follow-up whose base cannot be chosen before #593 is decided.**

## 6. Blocking decisions (orchestrator's, not taken here)

1. **#593 disposition** — commit the fallback-chain WIP to a branch, or discard. Required before #1145 can be scoped; **not** required for #1142 or #1143.
2. **`CLAUDE.md` −4173 B deletion** — intended or accidental? Must be answered inside decision 1, not folded into a bulk commit.
3. **34 orphaned `.pyc`** — delete + add a `__pycache__/` `.gitignore` rule (separate cleanup task, Rule 29), or leave. Not part of the WIP.
4. **#1143 bats in CI** — the 5 `.bats` + 1 `.test.sh` need a `bats` runner that is not a declared dependency. Adding one is a dependency decision (§17 무의존): decide runner vs. exclude-and-document. Nothing was installed.
5. **#1142 legacy consumers** — no tracked reader uses `registry.api_key`; approving removal still needs a call on unmeasured out-of-repo consumers.

## 7. Proposed preservation/integration procedure — **NOT PERFORMED**

Recommended order, for orchestrator approval. Every step is reversible and none is executed by this report.

1. **Freeze evidence first**: `git -C <devkit> stash push --include-untracked --keep-index -m "task593 baseline bb7876b"` is *not* recommended (it mutates the tree). Prefer non-destructive capture: `git diff HEAD > /tmp/593-tracked.patch` and `tar -czf /tmp/593-untracked.tgz $(git ls-files -o --exclude-standard | grep -v __pycache__)`, then verify the 16 WT blob IDs in §2 still match.
2. **Branch, don't commit to main**: `git switch -c wip/593-install-fallback bb7876b` — this carries the dirty tree onto the new branch without touching `main`.
3. **Commit in three separated commits**, so a later reviewer can accept or drop each independently: (a) fallback chain — `lib/install-fallback.js`, `bin/aigentry-brain-stub.mjs`, `tests/install-fallback.test.js`, schema + 7 adapters, `install.sh`, `install.ps1`, `bin/aigentry-devkit.js`; (b) docs/spec — `docs/brain-install-fallback-spec.md`, `docs/specs/*`, `docs/reports/*`, `docs/reviews/*`, `docs/session-conventions.md`; (c) governance-doc drift — `AGENTS.md`, `CLAUDE.md`, `templates/**` — **held for explicit review** because of the `CLAUDE.md` deletion.
4. **Exclude the 34 `.pyc` from all three** and handle them in the separate cleanup task (item 3 in §6).
5. **Only after `main` is clean**, land `#589` (`wt/wave1-fix-devkit b9692e8`), which #593's note records as blocked by this WIP.
6. `#1142` and `#1143` may branch from `bb7876b` **in parallel with all of the above** — §5 proves their regions do not overlap the WIP.

## 8. Gaps — explicitly unmeasured

- **Authorship of the WIP: unknown.** Every non-mtime evidence source was checked and came back negative (§3).
- **No file contents were read** for the 28 untracked `docs/reports|reviews` files or any `.pyc`; names + SHA-1 + byte size only.
- **No test was executed**; no runtime pass/fail total exists in this report. The 23/16/7 figures are static `git ls-files` counts, not run evidence.
- **No installed state file was opened** (`~/.config/aigentry-devkit/install-state.json`); the §5 field names come from installer source, and no real secret value was read, copied or displayed.
- **Out-of-repo consumers of `install-state.json`** (other ecosystem repos, published npm artifacts, user machines) were not searched — out of the authorized read scope.
- The discrepancy between the 2026-06-10 note ("17+38") and today's 16+68 is **unexplained**; no evidence was found that resolves it.
