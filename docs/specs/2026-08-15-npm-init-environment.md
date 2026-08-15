# SPEC — `npm i -g` → `aigentry-orchestrator init` → the owner's orchestrator environment

- **Task**: #885 (track `sp885`)
- **Date**: 2026-08-15
- **Author**: architect session (`sp885-npm-init-spec`)
- **Status**: **APPROVED** 2026-08-15 — both open questions resolved by the owner (§9). Implementation authorized.
- **Target version**: 0.2.0 (minor). Published today: `@dmsdc-ai/aigentry-orchestrator@0.1.0`.
- **Scope discipline**: this spec proposes. It smuggles no implementation (Rule 29). Every count below
  was enumerated from source in this session, not inherited (Rule 39); deltas against the dispatch's
  figures are called out in §0.

---

## 0. Measurement deltas against the dispatch (Rule 39)

The dispatch supplied four counts. Three differ from what the tree actually contains.

| Claim in dispatch | Measured | Basis | Delta |
|---|---|---|---|
| "bin/ 스크립트 31개" | **35** files (29 top-level + 6 under `bin/lib/`) | `git ls-files bin \| wc -l` | **+4** |
| "roles/{orchestrator,coder,architect,analyst,builder,logger}.md 6종" | **9** role files: `analyst, architect, builder, coder, logger, orchestrator, researcher, reviewer, tester` | `git ls-files tooling/instructions/roles` — and independently `bin/install-instructions.sh:23` `ROLES=(…)` lists the same 9, sourced from the `#99` Role enum SSOT | **+3** |
| "CONSTITUTION.md" (implied: one document) | **Two different documents share the name.** `~/.aigentry/CONSTITUTION.md` (5,809 B) is a generic *Software Development Constitution* (SRP/DRY/KISS §1–§N). The document `tooling/instructions/common.md:13,18` actually cites — `~/projects/aigentry/docs/CONSTITUTION.md` (12,661 B) — is the *aigentry 헌법*, **제1조–제18조 + 최종조**, not 17 articles. | `diff -q` on the two paths; `grep -n '^#'` on each | **live file ≠ cited file** |
| "telepty ^0.8.0, published today" | confirmed — `@dmsdc-ai/aigentry-telepty@0.8.0`, bins `telepty`, `telepty-install`, `telepty-mcp`, `aigentry-telepty` | `npm view @dmsdc-ai/aigentry-telepty version bin` | none |

Three further gaps measured in this session that the dispatch did not name:

- **`gh` is used in zero shipping files.** `git grep -lw gh -- bin .claude tooling scripts` returns nothing.
  The dispatch's "jq/gh 감지" should be **jq/python3 detect**, not jq/gh. Measured external-tool usage
  across `bin/`: `telepty` 25 files, `python3` 17, `jq` 10, `node` 8, `curl` 5, `gh` 0.
- **`jq` is used unguarded.** `command -v jq` appears nowhere in `bin/` (`grep -rn "command -v jq" bin` = 0 hits)
  while 10 files invoke it. Absent `jq`, those scripts fail in whatever way `jq: command not found` happens to
  produce — the silent-degradation class this release theme exists to remove. init must check for it.
- **There is no build hook on publish.** `package.json` `files[]` ships `dist/src`, but `scripts` has only
  `build`/`test`/`test:adr-mf` — no `prepare`, `prepack`, or `prepublishOnly`. A publish from a clean checkout
  would ship a **missing or stale `dist/`**. 0.1.0 reached npm only because the publishing tree happened to be
  built locally. This is a release-pipeline defect, not a packaging preference (§7).

Current tarball, measured (`npm pack --dry-run --json`): **100 entries, 53,488 B packed / 206,794 B unpacked** —
`dist/` (96), `package.json`, `README.md`, `README.tmpl.md`, `LICENSE`. **Zero `bin/`, zero scaffold, zero skills.**
`README.tmpl.md` ships despite not being in `files[]` (npm always includes `README*`); harmless, noted so the
guard test in §3 does not flag it as a defect.

---

## 1. Premises (decided; stated, not reopened)

1. **Scope = the orchestrator stack.** Not a full-ecosystem bootstrap, not personal state.
2. **UX = one explicit `init` command.** No `postinstall` writes to `$HOME`.
3. **Personal data never ships**: `state/`, brain, logs, `activity.log`, telemetry, mailbox, sessions.
4. **Failures are loud and named.** No arm of `init` may skip silently. Where behaviour degrades, the
   degradation prints what was missing and what it costs.
5. **The terminal surface stays pluggable** (Constitution §2). cmux is detected and used when present;
   its absence falls through to the `headless` adapter, which already exists
   (`bin/lib/workspace-host.sh:12` — "auto: cmux if `cmux` on PATH, else headless"). init never requires cmux.
6. **Skill ownership follows ADR 2026-07-26.** Cross-cutting skills are devkit's; this package ships only
   what is coupled to this repo's `bin/`.
7. **Version 0.2.0, landed via PR, published through the pipeline** — no hand publish.

---

## 2. Architecture: where each layer lands, and why

### 2.1 The problem the design has to solve

`orchestrate-turn/SKILL.md` invokes `bin/dispatch.sh`, `bin/session-cleanup.sh`, `bin/tq-*.sh` **by relative
path**, and reads and writes **`state/task-queue.json`** and **`state/dispatch/`** — all relative to the
session's cwd. `CLAUDE.md`/`AGENTS.md` are loaded by Claude Code from the cwd. `.claude/settings.json` hooks
are per-directory. The owner's environment *is* a git clone of this repo, entered as cwd.

A global npm install therefore cannot be the runtime location: `/opt/homebrew/lib/node_modules/...` is not
where a user's mutable `state/` should live, and it is replaced wholesale on upgrade.

### 2.2 Decision — `init` materialises a **control workspace**

`init` copies the governance layer out of the installed package into a directory the user owns, in **the same
shape as this repo**, and creates the writable `state/` skeleton there. The layout the scripts already assume
is reproduced verbatim, so no script needs a path rewrite to work.

```
<workspace>/            default ~/aigentry/_orchestrator  (overridable: --workspace PATH)
  AGENTS.md  CLAUDE.md
  bin/**                             35 files, copied
  docs/rules.md
  docs/templates/dispatch-ref-{template,checklist}.md
  tooling/dispatch-prelude/**
  .agents/skills/orchestrate-turn/SKILL.md
  .claude/skills/orchestrate-turn/SKILL.md     ← COPY, not symlink (see 2.3)
  .claude/settings.json  .claude/hooks/post-dispatch-verify-reminder.sh
  git-hooks/pre-push
  state/                             created EMPTY (see 2.4)
  .aigentry-init.json                {version, installedAt, manifestDigest, workspace}
```

`~/.aigentry/` receives the scaffold layer (§2.5). The library payload (`dist/src`) stays in the global
package and is untouched by `init` — it is consumed by `import`, not by cwd.

**Upgrade path**: `aigentry-orchestrator init --upgrade` re-copies exactly the manifest set and **never**
touches `state/` or any file not in the manifest. `.aigentry-init.json` records the version and manifest
digest so `--upgrade` can name precisely what changed.

### 2.3 Copy, not symlink, for `.claude/skills/`

In this repo `.claude/skills/orchestrate-turn` is a git symlink (mode `120000` → `../../.agents/skills/orchestrate-turn`).
The package ships only the **real** file under `.agents/`; `init` writes a copy into `.claude/skills/`.
Reason: ADR 2026-07-26 §risks already records that a Windows clone with `core.symlinks=false` materialises repo
symlinks as text files, and npm's own symlink handling in tarballs is not something to bet a first-run install on.
A copy is one `cp`, has no platform caveat, and matches how devkit already delivers skills to users (`cp -R`).

### 2.4 `state/` is created empty, never shipped

`init` creates `state/`, `state/dispatch/`, `state/hitl/{pending,decided}/`, `state/telemetry/`,
`state/session-comms/`, `state/test-reports/` (enumeration basis: `grep -rhoE "state/[a-z-]+" bin | sort -u`),
and seeds `state/task-queue.json` as `{"tasks": [], "active_focus": null}`.

The owner's live queue is **534 KB / 896 tasks** and is the (c)-ranked exposure in the public-hygiene
inventory. It is not shipped and not templated — it is *absent*, and the empty seed is what makes
`bin/tq-status.sh` and step 5 of `orchestrate-turn` function on a fresh install rather than erroring.

### 2.5 `~/.aigentry` scaffold — reuse `bin/install-instructions.sh`, do not reimplement it

`bin/install-instructions.sh` already does this layer: it honours `$AIGENTRY_HOME`, creates
`instructions/{,roles/,projects/}`, copies `common.md` + the 9 role files, **preserves existing files by
default**, and overwrites only under `--force`. `init` **calls it**; it does not grow a second copy of the
same logic (Article 1; the ladder's "already in this codebase?" rung).

What `init` adds on top, because that script does not do it:

| Path | Action | Collision policy |
|---|---|---|
| `~/.aigentry/instructions/**` | delegate to `install-instructions.sh` | preserve existing; `--force` overwrites (its existing contract) |
| `~/.aigentry/CONSTITUTION.md` | write from the vendored copy (§4.3) | **prompt** — the file may already exist and hold a *different* document (§0). Never silently overwrite. |
| `~/.aigentry/config.json` | **merge**, key-wise | write `roles` and `defaults` only if absent; never touch `remoteUrl`, `remoteConsent*`, `authMethod`, `provider`, `repoName`, `deviceId`, `lastSyncAt` — measured: those 7 keys are written by *other* ecosystem components (`repoName` on this machine is `aigentry-brain-profile`). Print every key it declined to change. |
| `~/.aigentry/{role-sandbox,sessions,telemetry,warp-surfaces,dispatch-helper,git-hooks}/` | `mkdir -p` | idempotent; no content |

`~/.aigentry/{role-sandbox,sessions}` are additionally auto-created at boot by `bin/boot-prepare.mjs:500,520`,
so their creation here is belt, not the only path.

---

## 3. Inventory — the exact shipping set, with enumeration basis (Rule 38)

### 3.1 Layer ① repo governance — **48 files**

| Path | Files | Enumeration basis |
|---|---|---|
| `bin/**` | **35** | `git ls-files bin` (29 top-level + 6 `bin/lib/`) |
| `AGENTS.md`, `CLAUDE.md` | 2 | hand-list (named in the requirement) |
| `docs/rules.md` | 1 | hand-list |
| `docs/templates/dispatch-ref-{template,checklist}.md` | 2 | `git ls-files docs/templates` |
| `.agents/skills/orchestrate-turn/SKILL.md` | 1 | `git ls-files .agents` — and this is the whole of `.agents/`, which is ADR 2026-07-26 §M2's acceptance condition |
| `.claude/settings.json`, `.claude/hooks/post-dispatch-verify-reminder.sh` | 2 | `git ls-files .claude`, minus the `orchestrate-turn` symlink (§2.3) |
| `tooling/dispatch-prelude/**` | 4 | `git ls-files tooling/dispatch-prelude` |
| `git-hooks/pre-push` | 1 | `git ls-files git-hooks` |

Measured size of this set: **557,627 B** across 58 paths including layer ② below;
basis: `git ls-files <path> | xargs wc -c`.

### 3.2 Layer ② `~/.aigentry` scaffold source — **12 files** (10 existing + 2 new)

| Path | Files | Basis |
|---|---|---|
| `tooling/instructions/common.md` | 1 | `git ls-files tooling/instructions` |
| `tooling/instructions/roles/*.md` | **9** | same — `analyst, architect, builder, coder, logger, orchestrator, researcher, reviewer, tester` |
| `tooling/instructions/CONSTITUTION.md` | 1 | **NEW** — vendored copy, §4.3 |
| `tooling/instructions/config.template.json` | 1 | **NEW** — §4.2 |

### 3.3 Layer ③ telepty — 0 files

`"@dmsdc-ai/aigentry-telepty": "^0.8.0"` added to `dependencies`. Daemon setup is **delegated** to telepty's
own `telepty-install` bin; `init` never starts, stops, or configures the daemon itself.

### 3.4 Resulting `files[]`

```json
"files": [
  "dist/src", "bin", "tooling/instructions", "tooling/dispatch-prelude",
  ".agents/skills", ".claude/settings.json", ".claude/hooks",
  "docs/rules.md", "docs/templates", "git-hooks",
  "AGENTS.md", "CLAUDE.md", "README.md", "LICENSE"
]
```

**Known packing risk**: dot-directories (`.agents/`, `.claude/`) in `files[]` are includable but are the kind
of thing npm has historically been inconsistent about. The guard test below measures the **real tarball**, so
this either passes on evidence or fails loudly. Contingency if it fails: a `prepack` step stages those two
trees under a non-dot `scaffold/` directory and the init manifest reads from there — one mechanism, added only
if measurement demands it.

### 3.5 The guard test (Rule 38 — the whitelist is the known defect shape)

`package.json` `files[]` is hand-maintained, and so is any init manifest. Three lists must agree or the install
ships something init cannot find, or init copies something that is not in the tarball.

**`tests/packaging/T96_ship_set_agreement.sh`** — asserts three-way agreement between:

- **A** = the init manifest — the single literal path list in `bin/init/manifest.mjs`, which `init` iterates.
- **B** = the actual tarball contents — obtained by running `npm pack --dry-run --json` and reading
  `[0].files[].path`. **This is the measurement**: it is the bytes npm would publish, not a re-reading of the
  `files[]` whitelist that produced them.
- **C** = the tree — `git ls-files` over each manifest root.

Assertions, each failing with the offending paths named:

1. `A ⊆ B` — every file `init` promises to copy is in the tarball. *(Failure mode caught: someone adds a
   scaffold file to the manifest and forgets `files[]` → init crashes at first run on a user machine.)*
2. `(B ∩ governance-roots) ⊆ A` — nothing ships into the governance roots without init placing it.
   *(Failure mode caught: dead weight in the tarball that no install path ever uses.)*
3. `A ⊆ C` — no manifest entry is missing from the tree. *(Failure mode caught: a file deleted in a refactor
   while the manifest still names it.)*
4. `|A ∩ bin/**| == $(git ls-files bin | wc -l)` — the bin set is complete, not a subset someone trimmed.
5. `|A ∩ tooling/instructions/roles/**| == 9` and equals `bin/install-instructions.sh`'s `ROLES` array length —
   the role-file count has one SSOT, and this is the assertion that catches the "6 vs 9" drift in §0.

Exempt from assertion 2 by explicit allow-list: `README.tmpl.md`, `package.json`, `README.md`, `LICENSE`,
`dist/**` (library payload, not governance).

---

## 4. Template variables — every host-specific value in the shipping set

### 4.1 How this was measured

`git grep` over exactly the paths in §3.1–§3.2 (`bin tooling .agents AGENTS.md docs/rules.md docs/templates`)
for four classes. **Re-runnable verbatim:**

```bash
git grep -n "/Users/"                                       -- bin tooling .agents AGENTS.md docs/rules.md docs/templates
git grep -nE "\b100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b"  -- bin tooling .agents AGENTS.md docs/rules.md docs/templates
git grep -nEi "duckyoungkim|MacBookPro|banggayo3|ts\.net|tailnet" -- bin tooling .agents AGENTS.md docs/rules.md docs/templates
git grep -n "~/projects/\|\$HOME/projects/"                 -- bin tooling .agents AGENTS.md docs/rules.md docs/templates
git grep -nE '=\"orchestrator\"|:-orchestrator'             -- bin tooling .agents
```

> **zsh caveat for whoever re-runs this**: `git grep … -- $SET` with an unquoted variable does **not** word-split
> in zsh, and silently matches nothing. Pass the pathspecs literally. This produced a false "0 hits" on the first
> pass of this session; the numbers below are from the corrected run.

**Results**: 0 hits for `/Users/` in code paths, 0 for `100.x` tailnet addresses, 0 for the owner's machine name
or email, 0 in `AGENTS.md` for any class. The exposure is smaller than the dispatch assumed. Full findings:

### 4.2 The table

| # | File : line | Value found | Class | Variable / disposition | init prompt & default |
|---|---|---|---|---|---|
| 1 | `bin/tq-focus.sh:7` | `TQ="${TQ:-$HOME/projects/aigentry-orchestrator/state/task-queue.json}"` | owner repo path as default | **Not a template var — a defect.** Resolve from the script's own location: `"$(cd "$(dirname "$0")/.." && pwd)/state/task-queue.json"`. Correct on the owner's machine too. | — |
| 2 | `bin/tq-status.sh:4` | same | same | same fix | — |
| 3 | `bin/tq-track.sh:5` | same | same | same fix | — |
| 4 | `bin/open-session.sh:249` | `${CTX_ROUTER_PATH:-$HOME/projects/aigentry-devkit/bin/ctx-router.sh}` | sibling-repo path | Already env-overridable **and** guarded by `[ -x "$ctx_router" ]` → degrades correctly. **Keep**, but the degradation is currently silent; make it print once. | `CTX_ROUTER_PATH`, default unchanged |
| 5 | `bin/open-session.sh:113` | error text: `see $HOME/projects/aigentry-devkit/docs/session-conventions.md` | guidance pointing at a path users lack | Reword to the devkit npm package name. Cosmetic, but it is user-facing error text. | — |
| 6 | `tooling/instructions/common.md:13` | `~/projects/aigentry/docs/CONSTITUTION.md` §제1조 | citation to a repo users do not have | **`{{CONSTITUTION_PATH}}`** | substituted, no prompt → `~/.aigentry/CONSTITUTION.md` |
| 7 | `tooling/instructions/common.md:18` | same, §제17조 | same | **`{{CONSTITUTION_PATH}}`** | same |
| 8 | `tooling/instructions/roles/orchestrator.md:65` | `python3 ~/projects/aigentry-orchestrator/bin/session-layout.py` | owner repo path in a role contract | **`{{CONTROL_WORKSPACE}}`** | substituted from `--workspace`, default `~/aigentry/_orchestrator` |
| 9 | `bin/session-cleanup.sh:50` | `PROTECTED_SID="orchestrator"` | hardcoded sid — **the only literal one**. The 7 sibling assignment sites are all env-overridable, though across **three** different names: `ORCHESTRATOR_SID` (`dispatch-tracker.sh:36`, `hitl.sh:36`, `orchestrator-boot.sh:36`, `orchestrator-bridge-auditor.sh:45`), `AIGENTRY_ORCHESTRATOR_SID` (`orchestrator-report-target.sh:99`), `AIGENTRY_ORCHESTRATOR_SIDS` (`ask.sh:44`, `session-comms-auditor.sh:38`, plural, 2-value default). | **Not a template var — an inconsistency.** Read `${ORCHESTRATOR_SID:-orchestrator}` like its nearest siblings. The three-name spread is pre-existing and **out of scope** for this task — mentioned, not fixed (Rule 29). | `ORCHESTRATOR_SID`, default `orchestrator` |
| 10 | `docs/rules.md:427,488,522,553,616` (5 lines) | `~/.claude/projects/-Users-duckyoungkim-…/memory/*.md` | owner home path in rule-provenance footers | **Accept as-is.** These are inert citations; the repo has been public since 2026-06-13 and these exact lines are already on GitHub, so shipping them discloses nothing new (public-hygiene inventory §a.2 ranks this class ⚪ COSMETIC). Recorded as an optional tidy, not a blocker. | — |
| 11 | `docs/rules.md:298–301` | `~/projects/aigentry-sandbox/…`, `ATERM_TELEPTY_PORT=13848` | maintainer-only aterm sandbox procedure | **Accept as-is** — same reasoning as #10. | — |
| 12 | `~/.aigentry/config.json` `roles` (9 entries) | 9 absolute `/Users/duckyoungkim/projects/aigentry-*` paths | owner's per-role project map | **Never shipped.** `config.template.json` carries `roles: {}`. | — |
| 13 | `~/.aigentry/config.json` `deviceId` | `device-duckyoungkimui-MacBookPro.local` | machine name | **`{{DEVICE_ID}}`** — computed at init, and only when the key is absent (§2.5 merge policy) | `device-$(hostname)`, no prompt |
| 14 | `~/.aigentry/config.json` `createdAt` | ISO timestamp | — | **`{{CREATED_AT}}`** | init's own clock |

**Count: 14 host-specific values across 11 distinct files.** Of these, **5 become template variables**
(#6, #7, #8, #13, #14), **4 are code defects fixed rather than templated** (#1–#3, #9), **3 are accepted as-is
with a recorded reason** (#4/#5 cosmetic, #10, #11), and **1 is excluded from the package entirely** (#12).

Ports are *not* in this table: `3848` appears in 6 `bin/` files but always as `${TELEPTY_PORT:-3848}` — a
default, not a host-specific. No hardcoded port exists in the shipping set.

### 4.3 The two `CONSTITUTION.md` documents

`tooling/instructions/common.md` cites the **aigentry 헌법** (제1조–제18조 + 최종조, 12,661 B), which lives in a
*different repo* (`~/projects/aigentry`). The file currently sitting at `~/.aigentry/CONSTITUTION.md` on the
owner's machine is a **different document** — a generic *Software Development Constitution* — so the citation
in the shipped instructions resolves, on a user's machine, to whatever `init` puts there.

**Decision**: vendor the aigentry 헌법 at `tooling/instructions/CONSTITUTION.md` and have `init` write it to
`~/.aigentry/CONSTITUTION.md`, with `{{CONSTITUTION_PATH}}` pointing there. Vendoring a file across a repo
boundary drifts, so it gets its own guard:

**`tests/packaging/T97_constitution_vendor_current.sh`** — when `~/projects/aigentry/docs/CONSTITUTION.md`
exists (maintainer machine), assert byte-identity with the vendored copy and fail on drift. When it does not
exist (CI, contributor), **skip with a printed reason** — an announced skip, never a silent pass.

---

## 5. The `init` flow

`aigentry-orchestrator init [--workspace PATH] [--yes] [--dry-run] [--force] [--upgrade]`

New `package.json` field: `"bin": { "aigentry-orchestrator": "bin/init/cli.mjs" }`. Node ≥20 is already the
declared engine; the CLI is plain Node with no new dependency.

Every arm below states its exit code and its message. **No arm returns 0 without having done what it said.**

### Step 0 — Platform gate

- macOS / Linux → continue.
- `MINGW*|MSYS*|CYGWIN*|win32` → **exit 2**:
  `"aigentry-orchestrator does not support Windows natively. bin/lib/platform-windows.sh returns 'not implemented' for every primitive (#305) and bin/dispatch-registry.py locks the dispatch registry with fcntl.flock, which does not exist on Windows Python. Run init inside WSL2, where the Linux path is supported. Tracked at #663."`
- Anything else (`unknown` from `uname -s`) → **exit 2** with the same message plus the detected uname string.

### Step 1 — Dependency checks (detect only; install nothing)

| Dependency | Check | Absent → |
|---|---|---|
| `node >= 20` | `process.version` | **exit 3**, naming the found version |
| `jq` | `command -v jq` | **exit 3**: names the 10 `bin/` files that require it and the install command for the platform. **Hard fail, not a warning** — §0 measured that `jq` is invoked unguarded, so a warning here becomes a mystery failure later. |
| `python3` | `command -v python3` | **exit 3**: 17 `bin/` files require it, `bin/dispatch-registry.py` (the dispatch SSOT) among them |
| `telepty` | `command -v telepty` | **warn + continue**: `"telepty CLI not on PATH. It is a declared dependency of this package; if you installed globally it should be at <npm prefix>/bin/telepty. Run 'telepty-install' to set up the daemon. Dispatch will not function until it is reachable."` init **never** starts the daemon. |
| `claude` CLI | `command -v claude` | **warn + continue** with the install URL. Cannot be installed by us; this is detect-and-guide by design. |
| devkit skills | `~/.claude/skills/propose-next-task` and `~/.claude/skills/work-breakdown` exist? | **warn + continue**, naming them: `"orchestrate-turn steps 1-1 and 5 invoke the 'work-breakdown' and 'propose-next-task' skills, which are owned by aigentry-devkit (ADR 2026-07-26). Install with: npm i -g @dmsdc-ai/aigentry-devkit. Without them the orchestration loop runs with those two steps unassisted."` |
| workspace host | `command -v cmux` | **info, never a failure**: cmux found → "cmux adapter active"; absent → "headless adapter active; terminal workspaces will not be opened or closed automatically." Constitution §2 — a missing cmux is a supported configuration. |

`gh` is **not** checked: measured usage in the shipping set is zero (§0).

### Step 2 — Resolve and validate the workspace

1. `--workspace PATH`, else `$AIGENTRY_CONTROL_WORKSPACE`, else prompt with default `~/aigentry/_orchestrator`
   (`--yes` takes the default without prompting).
2. If the path contains `.git/` → **exit 4**:
   `"<path> is a git working tree. init writes a fresh control workspace and will not modify a clone; if this is the aigentry-orchestrator repo itself, you already have the environment init would create. Choose another path with --workspace."`
   *This is the owner-machine guard*: the owner's environment is a clone, so it always trips this arm and the
   live environment can never be clobbered.
3. If the path exists and is non-empty and lacks `.aigentry-init.json` → **exit 4**, naming the first three
   unexpected entries found.
4. If the path exists **with** `.aigentry-init.json` → this is a re-init. Without `--upgrade` or `--force`,
   **exit 4** telling the user which of the two they want and what each does.

### Step 3 — Copy the governance layer

Iterate `bin/init/manifest.mjs` (set **A** of §3.5). For each entry: create parent dirs, copy, preserve the
executable bit on `bin/**` and `git-hooks/pre-push`. Then write the `.claude/skills/orchestrate-turn/` copy (§2.3).

- A manifest entry missing from the installed package → **exit 5**, naming the path:
  `"<path> is in the init manifest but not in the installed package. This is a packaging defect (see tests/packaging/T96). Nothing was written; the workspace is unchanged."` Copy is staged and only committed once
  every entry is verified present, so a partial workspace is never left behind.
- A destination exists and differs, under `--upgrade` → overwrite and list it in the summary.
- `EACCES`/`EROFS` → **exit 5** naming the path and the errno.

### Step 4 — Create `state/`

`mkdir -p` the six directories of §2.4 and write the empty `state/task-queue.json`. Under `--upgrade`,
`state/` is **skipped entirely** and the summary says so explicitly.

### Step 5 — `~/.aigentry` scaffold

1. Exec `<workspace>/bin/install-instructions.sh` (passing `--force` only if `init --force`), streaming its
   output. Non-zero exit → **exit 6**, surfacing its stderr verbatim.
2. `CONSTITUTION.md`: absent → write. Present and byte-identical → report "unchanged". Present and different →
   **prompt** (`--yes` ⇒ preserve and warn, never overwrite):
   `"~/.aigentry/CONSTITUTION.md exists and differs from the one this package ships. [k]eep yours / [o]verwrite / [b]ackup-and-overwrite?"`
3. `config.json`: absent → write from `config.template.json` with `{{DEVICE_ID}}`/`{{CREATED_AT}}` substituted.
   Present → merge per §2.5 and print every key left untouched.
4. `mkdir -p` the six `~/.aigentry` runtime dirs.

### Step 6 — Substitution

Apply the five template variables of §4.2 to the copied files only — never to anything under `~/.aigentry`
that already existed. Substitution is a whole-file rewrite of the copy after it lands.

**Post-substitution assertion**: grep the workspace for any remaining `{{…}}` token. A survivor → **exit 7**
naming file and token. An unsubstituted variable that reaches a user's instruction file is exactly the
class of silent-wrongness this release theme removes.

### Step 7 — Post-init guidance (printed, and written to `<workspace>/GETTING-STARTED.md`)

```
Control workspace ready: <workspace>
  48 governance files, 12 scaffold files, state/ initialised empty.

Next:
  1. cd <workspace>
  2. telepty-install                # if the daemon is not yet running (telepty owns this)
  3. bin/orchestrator-boot.sh       # boots the orchestrator session

Do NOT boot with a bare `claude`. bin/orchestrator-boot.sh enforces the
singleton-at-boot guard (#539): a bare `telepty allow --id orchestrator` is
idempotent, so a second bare boot silently shares the session and a later
SIGTERM cascades a close to the live one.

Not installed by init: <the warn list from step 1, verbatim>
```

> **Correction against the dispatch's phrasing**, which said the acceptance path ends in "starts `claude`".
> Measured: `bin/orchestrator-boot.sh:1-31` is the documented standard boot wrapper and AGENTS.md points at it.
> A bare `claude` reaches an orchestrator prompt but skips the singleton guard. The guidance names the wrapper.

### Step 8 — Summary

Print counts of written / preserved / skipped / warned, and the `--dry-run` note if applicable.
`--dry-run` performs steps 0–2 and then prints every path it *would* touch with its disposition, writing nothing.

**Exit code map**: `0` success · `2` unsupported platform · `3` missing hard dependency · `4` workspace refused ·
`5` copy failure / packaging defect · `6` scaffold failure · `7` substitution failure.

---

## 6. Boundary decisions

### 6.1 Skill-ownership routing — ships exactly one skill

**Decision: `orchestrate-turn` only.** ADR 2026-07-26 §2 is binding and its test is a single question — *does
the skill invoke this repo's `bin/` by path?*

- **Ships here**: `orchestrate-turn`. Verified against the source, not the ADR's summary
  (`grep -oE "bin/[a-z-]+\.sh|bin/lib/[a-z-]+\.sh|state/[a-z-]+" SKILL.md | sort -u`): it names **eight**
  `bin/` paths — `dispatch.sh`, `dispatch-tracker.sh`, `open-session.sh`, `session-cleanup.sh`, `tq-focus.sh`,
  `tq-status.sh`, `tq-track.sh`, `lib/workspace-host.sh` — plus `state/task-queue.json` and `state/dispatch/`.
  Ten repo-path couplings; it cannot run outside a control workspace.
- **Devkit's** (do not duplicate): `work-breakdown`, `propose-next-task`, `session-create`, `deliberation`,
  `deliberation-executor`, `deliberation-gate`, `telepty-deliberate`, `workspace-lifecycle`, `npm-release`,
  `env-manager`, `context-manage`, `diagnose`, `caveman`, `grill-with-adr`, `sawe`, `auto-multi-llm-review`,
  `upsell-trigger`, `orchestrator-response-style`, `ambiguity-gate`. **How decided**: each names no path in
  this repo; each is useful to a session of any role in any project. Both halves of the ADR's test say devkit.
- **Independent confirmation** that the routing is already correct in the tree:
  `git ls-files .agents/skills | cut -d/ -f3 | sort -u` returns exactly `orchestrate-turn` — ADR §M2's
  acceptance metric, satisfied today. Shipping `.agents/skills/**` wholesale therefore ships exactly one skill,
  and stays correct automatically if the routing rule is applied to future skills.
- **The seam this creates**, named rather than hidden: `orchestrate-turn` steps 1-1 and 5 invoke two devkit
  skills by name. Step 1's devkit check exists precisely so a user learns this at install time instead of at
  step 5 of their first orchestration turn.

### 6.2 Windows — **explicit unsupported, with a message** (recommended)

Evidence, all measured this session:

- `bin/lib/platform-windows.sh` is a 15-line stub whose every function returns exit 3 with
  *"not yet implemented … Workaround: use WSL"* — the repo already **has** this stance in code, since #305.
- `bin/dispatch-registry.py:178,190` — the dispatch registry, the single-writer SSOT for every dispatch —
  serialises with `fcntl.flock`. `fcntl` does not exist in Windows Python. Same for `bin/ask.sh:198` and
  `bin/session-comms-auditor.sh:138`.
- Shebang census over all 35 `bin/` files (`git ls-files bin | while read f; do head -1 "$f"; done | sort | uniq -c`):
  **29 bash, 4 python3, 2 node**. There is no Windows-native interpreter for 33 of 35.
- #663's own note measures `install.ps1` at 499 lines and ~3 months / ~500 lines behind `install.sh`, with
  `orchestrator` appearing 27× in `install.sh` and 0× in `install.ps1`.

Porting is a project, not a packaging step, and doing it under this task would either delay 0.2.0 indefinitely
or ship a half-port that fails at first dispatch. WSL2 is a genuine supported path today. **Recommendation:
declare it, gate it at step 0 with the named message above, and add `"os": ["darwin", "linux"]` to
`package.json`** so `npm i -g` on Windows fails at install with npm's own `EBADPLATFORM` rather than at first
run. Keep #663 open for the port; this decision does not close it.

### 6.3 Coexisting with the owner's machine

Three independent guards, any one of which is sufficient:

1. **`.git` refusal** (step 2.2) — the owner's environment is a clone, so any attempt to init over it exits 4.
2. **Preserve-by-default scaffold** — `install-instructions.sh` already skips existing files without `--force`;
   `config.json` merges key-wise and never rewrites the 7 foreign-owned keys; `CONSTITUTION.md` prompts.
3. **Nothing daemon-side** — init never runs `telepty` start/stop/restart, never touches
   `~/.aigentry/{sessions,mailbox,telemetry,brain,activity.log}`, and never signals a process.

The owner can therefore run `init --workspace /tmp/x --dry-run` on the live machine at any time. That is the
smoke test's operating mode (§7) and it is why the smoke can run on a developer machine at all.

---

## 7. Verification plan

### 7.1 The acceptance smoke — `tests/packaging/smoke-init.sh`

Fully automated, hermetic, and it never touches the live daemon, the live `$HOME`, or the network beyond the
tarball it builds itself.

```
1. npm run build && npm pack                → the real tarball, the same bytes the pipeline publishes
2. TMP=$(mktemp -d); export HOME="$TMP/home"; mkdir -p "$HOME"
3. npm i -g --prefix "$TMP/npm" ./<tarball> → global install into a throwaway prefix
4. PATH="$TMP/npm/bin:$PATH" aigentry-orchestrator init --yes --workspace "$TMP/control"
5. assertions:
   a. exit 0
   b. every path in the init manifest exists under $TMP/control, and bin/** is executable
   c. count(bin/**)==35, count(~/.aigentry/instructions/roles/*.md)==9
   d. state/task-queue.json parses and has tasks==[]
   e. grep -r '{{' $TMP/control  → 0 hits          (substitution completed)
   f. grep -r '/Users/duckyoungkim' $TMP/control $HOME/.aigentry → 0 hits outside docs/rules.md's
      accepted citation lines (§4.2 #10/#11), which are asserted by exact line count, not absence
   g. bin/tq-status.sh exits 0 against the empty queue      (proves the §4.2 #1-#3 path fix)
   h. bin/dispatch.sh --help exits 0                        (proves bash+python3 wiring)
   i. re-run init without --upgrade → exit 4, and $TMP/control is byte-identical (idempotence)
   j. init --upgrade → exit 0 and state/task-queue.json is untouched (mtime + content)
6. rm -rf "$TMP"
```

CI: GitHub Actions, `matrix.os = [ubuntu-latest, macos-latest]`, node 20. **No windows leg** — per §6.2 the
package declares itself unsupported there, and a leg that only asserts `EBADPLATFORM` is added as a one-line
step on ubuntu instead, not a full matrix row.

### 7.2 What this smoke deliberately does **not** verify

Stated plainly so a green run is never read as more than it measured:

- **That `claude` boots as an orchestrator.** No Claude CLI, no credential, and no TTY exists in CI. The smoke
  proves the workspace `claude` would boot *into* is correct and complete; the boot itself is a **manual
  acceptance step** the owner runs once on a spare machine or a fresh user account before release.
- **Anything requiring the telepty daemon** — dispatch, inject, session lifecycle, report collection.
  The smoke asserts the CLI is present and `--help`-able; it starts no daemon.
- **cmux / terminal-adaptor behaviour.** The smoke runs under the headless adapter.
- **MCP servers** (deliberation, brain, snyk) — none are in this package's scope.
- **Correctness of the governance content.** The smoke measures that AGENTS.md and rules.md *arrive*, not that
  a model obeys them.
- **Upgrade from a hypothetical 0.1.x install** — 0.1.0 has no `init`, so there is no prior workspace to
  upgrade from. First relevant upgrade path is 0.2.0 → 0.2.1.

### 7.3 Release pipeline — in scope, and needed

This repo has **no** `release.yml` (only `readme-regen.yml`, whose header comment still asserts "orchestrator is
internal infra (not npm-published)" — stale since 0.1.0 shipped; fixing that comment is part of this work).

**Recommendation: add `.github/workflows/release.yml` modelled on telepty's**, which is the reference the
dispatch names and which exists precisely because a runbook once claimed a tag published something it did not.
Carried over verbatim in shape:

- tag-triggered (`v*`), `concurrency: queue, do not cancel` — a cancelled publish is a half-release;
- **Gate 1**: tag version must equal `package.json` version (never derive the version *from* the tag);
- **Gate 2**: `NPM_TOKEN` must be present — **absent is a failure, not a no-op**;
- **Gate 3**: the full suite, plus `tests/packaging/T96` and `smoke-init.sh`, on ubuntu + macOS;
- **publish**: run the build hook explicitly, `npm pack`, publish *that tarball*, then **read the shasum back
  from the registry and compare** — a local build agreeing with itself is not evidence.

Plus the §0 defect this must fix: add `"prepack": "npm run build"` so the tarball can never ship a stale or
missing `dist/`. `prepack` (not `prepublishOnly`) because `npm pack` — which both the guard test and the smoke
depend on — runs `prepack` but not `prepublishOnly`; using the latter would let the guard measure a different
tarball than the one published, which is the same class of defect as the whitelist drift it exists to catch.

### 7.4 Public-hygiene recheck against the 2026-06-13 inventory

| Inventory finding | Status for this package |
|---|---|
| (a.1) personal Gmail in commit `426f3a9` | **History-only; npm tarballs carry no git history.** Not shipped. Unaffected by this task; the owner's accept-vs-`filter-repo` decision stands open independently. |
| (a.2) 98 `/Users/duckyoungkim` strings in 17 tracked files | **5 of them are in the shipping set**, all in `docs/rules.md` provenance footers (§4.2 #10). The other ~93 are in `docs/reports/**`, which this package does not ship. |
| (a.3) example emails | None in the shipping set (measured: 0 hits). |
| (b) private-sibling refs | `dependencies` keeps `@dmsdc-ai/aigentry-{logger,ssot}` — both public on npm, so external install works. Adding `aigentry-telepty` (public repo + public npm) introduces no new asymmetry. The inventory's one high-value item, `docs/reports/2026-06-10-structure-audit.md`, is **not** in the shipping set. |
| (c) `state/task-queue.json` — 596 (now 896) tasks | **Not shipped, not templated, absent.** §2.4. This task materially *reduces* the exposure surface relative to the repo. |

Net: shipping this set adds **no new disclosure** beyond what has been public on GitHub since 2026-06-13, and
the one class it does carry (5 rules.md citation lines) is the inventory's ⚪ COSMETIC rank.

---

## 8. Alternatives rejected

| # | Alternative | Rejected because |
|---|---|---|
| 1 | **`postinstall` writes `$HOME`** | An install that mutates `$HOME` without being asked is unauditable, breaks `npm ci` in CI, and gives no place to put the prompts of §5 step 5. Owner already decided against it; recorded so the road is visible. |
| 2 | **devkit's scaffold does it** | devkit owns cross-cutting content and per-CLI integration (ADR 2026-05-05 §3.1); the orchestrator stack is repo-coupled and versions on its own cadence. Routing it through devkit would couple every orchestrator fix to a devkit release. |
| 3 | **Run from the global package dir; no control workspace** | `orchestrate-turn` and 7 `bin/` scripts resolve `bin/**` and `state/**` relative to cwd, and `state/` must be user-writable and survive `npm i -g` upgrades. The npm prefix is neither. |
| 4 | **`git clone` the repo instead of packaging it** | Requires git + network + a GitHub account for a *user*, ships the full history (including the a.1 identity finding) and the 534 KB task queue, and has no version pinning. npm already solves distribution (§17 무의존: the install path must not require a second toolchain). |
| 5 | **Symlink `.claude/skills/` → `.agents/` as in the repo** | npm tarball symlink handling plus the Windows `core.symlinks=false` failure mode recorded in ADR 2026-07-26; a copy costs one line and has no platform caveat. |
| 6 | **Ship every skill from `~/.claude/skills/`** | Direct violation of ADR 2026-07-26 §2: duplicate delivery of devkit-owned skills, two SSOTs, and divergent versions of the same skill on one machine. |
| 7 | **Derive `files[]` from the init manifest at pack time** | `files[]` must be literal JSON in `package.json`; generating it means a build step that rewrites the manifest npm reads. The §3.5 guard asserts agreement instead — same protection, no new mechanism (Article 1). |
| 8 | **Warn instead of fail when `jq` is missing** | Measured: `jq` is invoked unguarded in 10 files. A warning converts a clear install-time error into an opaque runtime one — the exact silent-skip defect class 0.8.0 was released to remove. |
| 9 | **Port Windows now** | §6.2 — `fcntl.flock` in the dispatch SSOT, 23 bash scripts, a 500-line-stale `install.ps1`. A project, not a packaging step; WSL2 is a real path today. |
| 10 | **Template the 5 `docs/rules.md` home paths** | They are inert citations already public on GitHub. A substitution mechanism for cosmetic strings buys nothing and adds a rewrite pass over a 72 KB doc (§4.2 #10). |
| 11 | **Publish by hand, land the pipeline later** | This is exactly what telepty's `release.yml` header documents as the failure that produced three hand-published versions and a release reported as shipped that npm had not received. |

---

## 9. Open questions — RESOLVED by the owner, 2026-08-15

1. **Control-workspace default path: `~/aigentry/_orchestrator`** (owner's own proposal, adopted over the
   spec's `~/aigentry-control`). Rationale recorded: `~/aigentry/` is an umbrella the user's own project
   directories join later — reproducing the owner's `~/projects/{aigentry-orchestrator, siblings…}` shape —
   and the underscore pins the control tower first in listings and marks it as not-a-project. The `.git`
   refusal applies to `_orchestrator` itself; sibling repos under the umbrella are untouched. Every
   occurrence of `~/aigentry-control` elsewhere in this spec reads as `~/aigentry/_orchestrator`.
2. **Full doctrine ships: YES** (owner-confirmed). `AGENTS.md` + `docs/rules.md` are packaged as specified.

---

## 10. Implementation checklist (for the *next* dispatch — not this one)

1. `bin/init/{cli.mjs,manifest.mjs}` — new.
2. `tooling/instructions/{CONSTITUTION.md,config.template.json}` — new (vendor + template).
3. `package.json` — `version` 0.2.0, `bin`, `files[]` (§3.4), `os: [darwin, linux]`,
   `dependencies += @dmsdc-ai/aigentry-telepty ^0.8.0`, `scripts.prepack`.
4. Path fixes: `bin/tq-{focus,status,track}.sh` (§4.2 #1–#3), `bin/session-cleanup.sh:50` (#9),
   `bin/open-session.sh:113,249` (#4, #5). **Six lines total** — surgical, Rule 29.
5. `tests/packaging/{T96_ship_set_agreement.sh,T97_constitution_vendor_current.sh,smoke-init.sh}` — new.
6. `.github/workflows/release.yml` — new; fix the stale "not npm-published" comment in `readme-regen.yml`.
7. `CHANGELOG.md` entry; PR; tag `v0.2.0` after merge.
