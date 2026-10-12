# SPEC — ES-04 workspace capture / restore and runtime manifest (task #2026101204)

- Status: CONTRACT SPEC (architect, 2026-10-12). No code. Not an implementation, merge, release or
  install claim (Rule 45 §2, Rule 50 §2).
- Parent: task #2026101204; requirement `state/specs/2026-10-12-environment-sharing-release-requirements.md`
  acceptance criterion 4 (line 41), verification line 51; build-plan draft §3 ES-04 (lines 54–57).
- Owners (proposal): aigentry-devkit (CLI + manifest) + workspace owner; storage via aigentry-brain repo
  (§5) unless the user chooses otherwise.
- Depends on: ES-01 (user/device identity, device keys; the requirements on ES-01 are those of ES-02 §5.5). Optional link to ES-02 (`workspace_capture_id`
  in a checkpoint).
- ADR: `docs/adr/2026-10-12-env-continuity-context-and-workspace.md`.

**Reading convention (orchestrator guardrail 2026-10-12 13:59Z).** Part A contains only FINDINGS.
Part B contains only PROPOSALS. Every rule in Part B is a **proposal requiring user review** unless
tagged `[REQ]` (restates the requirement doc, line cited), `[DRAFT]` (from the build-plan draft
`state/draft/2026-10-12-environment-sharing-build-plan-proposal.md`, line cited — shown to the user but
still a proposal) or `[EXISTING]` (behaviour already in a cited file). Untagged = new proposal.

# PART A — FINDINGS

## 0.1 Exists (measured 2026-10-12)

| Fact | Source |
|---|---|
| devkit `lib/workspace-init.js` is an 8-line re-export of the project scaffold (`workspaceInitCompat`); it scaffolds instruction files, it does not capture or restore repository state | aigentry-devkit `lib/workspace-init.js:1-8` |
| devkit OS detection: `uname -s` → `macos` / `windows` (MINGW/MSYS/CYGWIN) / … | devkit `bin/lib/platform.sh:21-24` |
| devkit installer manifest v1 declares component compatibility (node ≥18, telepty target, brain optional "latest-compatible", registry_api optional contract `2026-03-14`) and install profiles | devkit `config/installer-manifest.json:1-40` |
| devkit 604f2b5 "snapshot restore" restores a local `.context-snapshot.md` text file after compaction; no files, diffs or runtime are captured | devkit `hooks/post-compact-restore.sh:1-16` |
| brain Git backend pulls/pushes only branch `main`; first clone is `--depth 1` (single default branch) | aigentry-brain `src/backend/GitBackend.ts:19`, `:30`, `:83`, `:188` |
| brain encrypts with age to a recipient list; recipients grow by TOFU and a new device cannot decrypt older data until an existing device re-encrypts | brain `src/backend/GitBackend.ts:104-175` |
| brain remote is the user's private GitHub repo, opt-in | brain `src/cli/SetupWizard.ts:54`, `:146-213` |
| Requirement: env shared as name / required / safe supply path only; no automatic secret copy; native lib/GPU/OS path/port/running process marked unsupported or recreate | requirement line 41 |
| Requirement: verify uncommitted conflict, excluded files, non-portable manifest, restore failure with no loss of originals | requirement line 51 |

## 0.2 Searched for and not found

- No capture/restore implementation for repositories, worktrees or uncommitted changes in devkit
  (`git ls-files` filtered for snapshot/restore/workspace/manifest returned only scaffold templates,
  the installer manifest, `lib/workspace-init.js`, `skills/workspace-lifecycle/*`, the compaction hook).
- No runtime/toolchain manifest format in devkit or brain (the installer manifest describes aigentry
  components, not a user project's toolchain).
- No artifact store for user workspace data in the repositories read. The registry was **not read**
  in this dispatch, so "registry artifact store" is an option, not a found capability.
- No secret scanner in brain or devkit for file contents (brain: only `capture-tool.ts:38-56` allowlist).

## 0.3 Not measured

Registry storage capacity/cost; Git-host retention and GC of deleted refs; repository sizes typical for
the user; macOS/Windows file-system behaviour (case folding, symlinks, path length, exec bit) — listed in
§8 as test rows only; `git bundle` performance on large repos. No tests were run (SAWP).

# PART B — PROPOSALS (each requires user review unless tagged)

## 1. Guarantees and non-claims

- G1. `[REQ line 41]` Capture never copies secret values; env is shared as name, required flag and safe
  supply path only.
- G2. `[REQ line 51]` `[DRAFT line 57]` A restore never loses original data on the target device:
  anything it would overwrite is preserved first (§6.3). New proposal (needs review): the default restore
  writes into a **new worktree** (§6.4).
- G3. `[REQ line 42]` Runtime state is recreated, never migrated: running processes, open ports, GPU
  contexts and in-memory state are not transferred.
- G4. A capture is a point-in-time copy; it is not a live mirror and is not continuously synced.
- G5. `[REQ line 52]` Linux-only fixture PASS is not reported as cross-platform PASS.
- G6. `[REQ line 12]` `[DRAFT line 9, 27]` Works from any terminal on the telepty daemon; no GUI typing,
  no cmux dependency; a copied log file or an SSH connection alone never claims completion. Applied here:
  capture, preview and restore are CLI commands (or telepty-daemon-delivered invocations of them); nothing
  types into a GUI, reads a cmux pane or scrapes a screen. Evidence of a completed capture is the
  reader-verified manifest (`capture_id`, `content_sha256`, `bundle_sha256`, signature §4); evidence of a
  completed restore is the `restore-journal.json` with every step `done` plus the restored HEAD/file hashes;
  a log copy or an SSH-run listing is not evidence.

## 2. Capture manifest (`workspace_capture`, schema_version 1)

```
{
  "schema": "aigentry-workspace-capture", "schema_version": 1,
  "capture_id": "wsc_<device_id>_<seq>", "user_id", "device_id", "created_at",
  "checkpoint_id": null | "<ES-02 id>",
  "source": { "os": "linux|macos|windows", "os_version", "arch", "fs_case_sensitive": bool,
              "line_endings": "lf|crlf", "workspace_root_key": "<sha256[:16] of abs root>" },
  "repos": [ Repo ],
  "runtime": Runtime,
  "nonportable": [ NonPortable ],
  "limits": { "max_file_bytes", "max_total_bytes", "applied": bool },
  "integrity": { "alg": "sha256", "canonical": "jcs", "content_sha256", "bundle_sha256" },
  "signature": { "alg": "ed25519", "device_id", "sig" }
}
```
`content_sha256` covers the manifest without `integrity` and `signature`. `sig` = the writer's ES-01 device
key over `"aigentry-capture-v1|" + user_id + "|" + capture_id + "|" + content_sha256 + "|" + bundle_sha256`
(writer authentication; `[DRAFT line 36]` device-key signing, binding new).

### 2.1 Repo
| Field | Rule |
|---|---|
| `path_rel` | path relative to the workspace root; absolute paths and home directories are never stored |
| `remote_url` | `origin` fetch URL with userinfo/credentials stripped; other remotes listed by name + stripped URL |
| `branch`, `head_sha`, `upstream`, `ahead`, `behind` | from git; detached HEAD recorded as `branch: null` |
| `unpushed_commits` | count + range `<base>..HEAD` (`base` = upstream, else §3.4); scanned (§3.4) and, only if the scan passes, included in the bundle (§5) because the target cannot fetch them; `base_source: "upstream"\|"merge_base_default"\|"user"` |
| `refused` | `null` \| `{code, hits: [{commit, path, detector}]}` — set when the repo's bundle is refused (§3.4); hits never contain matched text |
| `worktrees[]` | `{path_rel, branch, head_sha, locked: bool}` from `git worktree list --porcelain`; each worktree is captured as its own working-tree state |
| `staged_patch`, `unstaged_patch` | `{sha256, bytes, files: n, binary_files: [path]}`; produced with `git diff --binary --cached` / `git diff --binary`; stored in the bundle, not in the manifest |
| `untracked[]` | `{path, bytes, sha256, mode}` from `git ls-files --others --exclude-standard` (ignored files are never captured) |
| `symlinks[]` | `{path, target, disposition}` (§3.3) |
| `excluded[]` | `{path, reason: "deny_list"|"size"|"secret_suspected"|"outside_root"|"gitignored"|"submodule", bytes?}` — recorded so the user sees what is missing |
| `submodules[]` | `{path, url (stripped), sha}`; contents not captured (recreated by `git submodule update`) |
| `lfs` | `{used: bool, pointers: n}`; LFS objects not captured (fetched from the LFS remote) |

### 2.2 Runtime manifest
| Field | Content |
|---|---|
| `toolchains[]` | `{name: node|python|rust|go|java|…, version, pinned_by: ".nvmrc"|".python-version"|"rust-toolchain.toml"|".tool-versions"|"engines"|null, detected_version}` — detected by running the tool's `--version`, never installing |
| `package_locks[]` | `{path_rel, manager: npm|pnpm|yarn|pip|poetry|uv|cargo|go|bundler|…, sha256}` — the lock file itself is in the repo/patch; manifest stores identity only |
| `config_schema[]` | `{path_rel, kind: "json-schema"|"example-file"|"documented", ref}` — e.g. `.env.example`, `config.schema.json`; values are never read into the manifest |
| `env[]` | `{name, required: bool, source: "env.example"|"code_scan"|"user", supply: SupplyPath, note?}` — **no value field exists in the schema** |
| `services[]` | `{name, kind: "db"|"queue"|"cache"|"other", how_to_recreate?}` from docker-compose / Procfile names only; informational |

`SupplyPath` ∈ `os_keychain` (macOS Keychain / Windows Credential Manager / libsecret), `user_prompt`
(asked at restore, written to a gitignored local file with 0600), `secret_manager_ref` (an opaque
reference string such as a vault path — never a credential), `existing_local` (already present on the
target), `none_known`. Supplying values is always done by the user on the target device.

### 2.3 Non-portable items
`{kind: native_lib|gpu|os_specific_path|port|running_process|service|filesystem|toolchain_missing,
detail, disposition: "unsupported"|"recreate", recreate_hint?}` `[REQ line 41]` for the first five kinds.

| Kind | Detection (capture side) | Disposition |
|---|---|---|
| native_lib | untracked/ignored build outputs `*.so`, `*.dylib`, `*.dll`, `*.node`, `*.a` are excluded; native deps in locks (e.g. node-gyp, cffi, `-sys` crates) flagged | recreate (rebuild on target) |
| gpu | CUDA/ROCm/Metal versions referenced in locks or config | unsupported if target lacks a matching runtime; else recreate |
| os_specific_path | absolute paths in tracked config files that point outside the repo (`/home/`, `/Users/`, `C:\`) | unsupported until the user edits; listed with file:line |
| port | listening ports owned by processes whose cwd is inside the workspace (informational, Linux `ss`/macOS `lsof`/Windows `netstat`) | recreate hint only; ports are never reserved |
| running_process | processes with cwd inside the workspace (dev servers, watchers) | not transferred; recreate hint = the script name if known |
| filesystem | case-only path collisions, paths > 260 chars, exec-bit files, symlinks, CRLF/LF mismatch vs `.gitattributes` | checked at **restore** against the target (§6.2) |

## 3. Capture policy

### 3.1 Exclusion paths (default deny-list, extendable per project, never shrinkable below the secret set)
Secret set: `.env`, `.env.*` (except `*.example`, `*.sample`, `*.template`), `*.pem`, `*.key`, `*.p12`,
`*.pfx`, `id_rsa*`, `id_ed25519*`, `*.keystore`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`,
`credentials*`, `secrets.*`, `.aws/`, `.ssh/`, `.gnupg/`, `.docker/config.json`, `*.tfstate*`,
`kubeconfig*`. Bulk set: `node_modules/`, `.venv/`, `venv/`, `target/`, `dist/`, `build/`,
`__pycache__/`, `.gradle/`, `.next/`, `.DS_Store`. Ignored files are never captured (§2.1).
Tracked files matching the secret set are still captured only as part of the committed history the
target already gets from the remote; their **uncommitted** modifications are excluded
(`reason: deny_list`) and listed.

### 3.2 Content scan and size limits
- Every untracked file and every hunk of the staged/unstaged patch is scanned with the same detector
  set as ES-02 §3.2. A finding excludes the whole file (`secret_suspected`) — no partial redaction of
  code (a redacted source file would restore as broken code). The user can override per file only by
  adding it to a project allow-list, which is itself recorded in the manifest.
- Scanner unavailable → capture fails closed (`CAPTURE_SCAN_UNAVAILABLE`).
- Defaults: `max_file_bytes` 5 MiB, `max_total_bytes` 50 MiB per capture (bundle after compression).
  Files over the per-file limit are excluded (`size`); if the total is exceeded the capture stops with
  `CAPTURE_TOO_LARGE` and a list of the largest items — it never silently drops files to fit.
- The unpushed commit range is scanned too (§3.4).

### 3.3 Symlinks
Never followed. Recorded as `{path, target}`. `disposition`: `in_repo_relative` (restored as a symlink),
`absolute_or_escaping` (target outside the repo root: not restored, listed as `os_specific_path`),
`windows_unsupported` (decided at restore when symlink creation is not permitted on the target).
Symlinked directories are never traversed (prevents capturing outside the root).

### 3.4 Unpushed commits (`[REQ line 41, 49]` no automatic secret copy — base rule, scan and refusal are new proposals)
- **Base.** `base` = the upstream tip when the branch has an upstream. Without an upstream: `git merge-base
  HEAD <remote>/<default>` where `<default>` is read from `refs/remotes/<remote>/HEAD`. If that ref is absent
  or the repo has no remote, the user names a base (`--base <ref>`), which must be contained in a
  remote-tracking ref (`git branch -r --contains`). With none of these the repo is not bundled
  (`CAPTURE_BASE_UNDEFINED`; metadata only, listed in the summary). The whole history is never bundled
  implicitly.
- **Scan.** Before the bundle is built, the range `base..HEAD` is checked with the same rules as the working
  tree: (a) every path added or modified by any commit in the range (`git log --format= --name-only
  base..HEAD`, including paths deleted again by a later commit — their blobs are still in the bundle)
  against the §3.1 secret set; (b) every blob reachable from `HEAD` and not from `base` (`git rev-list
  --objects base..HEAD`, blobs only) with the §3.2 detector set; (c) the commit messages of the range with
  the detector set. Blobs count against the §3.2 size limits.
- **Refusal.** Commits cannot be partially redacted (a rewrite changes their ids and the user's branch). On
  any hit the bundle for that repo is refused (`CAPTURE_SECRET_IN_UNPUSHED_COMMIT`): the repo entry keeps its
  metadata with `refused: {code, hits[{commit, path, detector}]}`, nothing from that repo (unpushed commits
  or shelf) is stored, and the other repos of the capture continue. Capture never rewrites history; the
  remedy (amend/rebase/drop the commit) is the user's.
- Scanner findings, error messages and logs name the commit, path and detector only; they never carry the
  matched text (requirement line 49 "로그").

## 4. Capture flow

1. Preflight: ES-01 identity, scanner, encryption key available; repo is a git work tree.
2. For each repo/worktree: collect §2.1 metadata; build a **shelf commit** without touching the user's
   index or working tree: `git stash create` semantics (tracked changes) plus a separate tree for
   untracked files (temporary index via `GIT_INDEX_FILE`), never `git stash push`.
3. Resolve `base` and scan `base..HEAD` (§3.4); on a refusal nothing of that repo is bundled. Otherwise build
   `git bundle` containing `base..HEAD` (unpushed commits) + the shelf commit(s).
4. Write manifest, compute integrity, sign (§2), encrypt bundle + manifest (age, recipients = user's
   active, trusted devices per ES-02 §5.5, fail-closed — no plaintext fallback, cf. brain
   `ProfileFormat.ts:160-181` which does fall back).
5. Store (§5); print a summary: captured repos, excluded paths with reasons, non-portable items, size.

The source working tree, index, stash list, branches and refs are unchanged by capture (tested, WS-08).

## 5. Storage (decision needed — Rule 47 cost / retention / privacy)

| Option | Where | Cost | Retention control | Privacy | Notes |
|---|---|---|---|---|---|
| **S1 (recommended default)** encrypted bundle on a per-capture ref in the user's private brain repo | `refs/aigentry/ws/<device_id>/<capture_id>` → orphan commit holding `manifest.age` + `bundle.age` | user's Git host quota; no new aigentry infra | expiry pass deletes the ref; host GC timing not controlled (disclosed) | encrypted; per-user private repo (§0.1) | brain pulls only `main` (`GitBackend.ts:83`) and clones `--depth 1` (`:30`), so capture refs are not downloaded by normal brain sync; fetched on demand by capture id |
| S2 Git shelf branch/ref in the **project's own remote** | `refs/aigentry/shelf/...` on `origin` | none | ref delete; host GC | **unencrypted uncommitted work pushed to a remote that may be shared with collaborators or public** | rejected as default; not offered unless the user explicitly asks per repo |
| S3 registry artifact store | new object storage behind registry auth (ES-01) | new storage + egress cost (unmeasured) | real deletion + server TTL | server-side; needs encryption-at-rest decision | needs registry work, credentials/scopes and a cost approval; candidate for a later release |

Recommended default **S1** with: retention 14 days per capture, keep at most the newest 5 captures per
device, 50 MiB cap. Rationale: no new infrastructure or credentials (Article 1, 17), per-user isolation
already exists, data encrypted to the user's devices, cost borne by the user's existing Git host. Known
limits: deleted refs may persist on the host until GC; the fresh-device key gap applies (ES-02 §5.3); a
revoked device keeps Git access to the capture refs until the user revokes its GitHub credential — it can
fetch ciphertext (decrypting captures written before the revoke) and push refs, which readers reject (§6.1)
(ES-02 §5.3 known limit, ADR D-8).

## 6. Restore flow (preview → conflict detection → preserve copy → apply)

### 6.1 Preview (read-only; no writes)
Fetch and decrypt the capture, verify integrity and the writer signature with the same reader-side rules
as ES-02 §5.4 (device in the authenticated, trusted list of the logged-in user; signature valid;
`user_id` match; a capture by a revoked device with `created_at ≥ revoked_at` → `RESTORE_DEVICE_REVOKED`,
older but first seen after the revoke → shown only with a warning and an explicit user choice), then show
per repo: target path, clone needed or not,
branch/HEAD, unpushed commits to import, files to be written (staged / unstaged / untracked), excluded
items from capture, non-portable items, env names needing a supply path, toolchain version
differences (`required 20.x, found 18.19` / `missing`). The user confirms per repo; no default "yes".

### 6.2 Conflict detection
| Conflict | Detection | Default handling |
|---|---|---|
| repo missing on target | path absent | clone from `remote_url` (user's own credentials) |
| different remote | `origin` URL differs after normalisation | stop for that repo (`RESTORE_REMOTE_MISMATCH`) |
| HEAD not reachable | `head_sha` not in remote and not in bundle | stop (`RESTORE_HEAD_UNAVAILABLE`) |
| target has local uncommitted changes | `git status --porcelain` non-empty | preserve (§6.3) then restore into a new worktree (§6.4) |
| target branch diverged | branch exists with different tip | new branch `aigentry/restore/<capture_id>` |
| file collision (untracked) | path exists with different sha256 | preserve original; captured file written into the new worktree only |
| patch does not apply | `git apply --check --3way` fails | stop for that repo, keep preserve copy, report hunks |
| filesystem incompatibility | case-folding collision, path length, symlink permission, exec bit, CRLF per `.gitattributes` | listed; affected files skipped and reported, never renamed silently |

### 6.3 Preserve copy (before any write)
For each target repo touched: create `refs/aigentry/preserve/<restore_id>` = a stash-like commit of the
current tracked + untracked state (same no-touch technique as §4 step 2) and copy any file that
would be overwritten outside git to `~/.aigentry/workspace-preserve/<restore_id>/<repo_key>/…` (0700).
Write a journal `restore-journal.json` (atomic tmp → fsync → rename) listing every planned and
completed step. Preserve copies are never deleted automatically by restore; they expire only by an
explicit user command or a retention the user set.

### 6.4 Apply
Default: `git worktree add <root>/.aigentry-restore/<capture_id> <head_sha>` (or a sibling path chosen
by the user), import unpushed commits from the bundle, apply staged then unstaged patch (`--3way`),
write untracked files, recreate in-repo relative symlinks. In-place apply into the existing checkout is
allowed only when the target tree is clean and the user chooses it explicitly.
Runtime recreate: print (not run) the commands implied by the manifest (`npm ci`, `uv sync`, `cargo
fetch`, toolchain install hints); running them is a separate user confirmation. No global installs, no
service starts, no port binding by the restore tool.

### 6.5 Failure handling (no original loss)
Any failure stops the restore for that repo, marks the journal step `failed`, leaves the preserve ref
and copies in place and prints the rollback: remove the restore worktree/branch, `git stash apply
refs/aigentry/preserve/<restore_id>` semantics for in-place mode. Crash/kill mid-restore: on next run
the journal is detected and the tool offers resume or rollback; it never re-applies a completed step.

## 7. Error codes
`CAPTURE_IDENTITY_MISSING`, `CAPTURE_SCAN_UNAVAILABLE`, `CAPTURE_ENCRYPTION_FAILED`, `CAPTURE_TOO_LARGE`,
`CAPTURE_NOT_A_REPO`, `CAPTURE_SECRET_IN_UNPUSHED_COMMIT`, `CAPTURE_BASE_UNDEFINED`, `RESTORE_INTEGRITY_FAILED`, `RESTORE_USER_MISMATCH`, `RESTORE_PENDING_KEY`,
`RESTORE_REMOTE_MISMATCH`, `RESTORE_HEAD_UNAVAILABLE`, `RESTORE_PATCH_CONFLICT`,
`RESTORE_FS_INCOMPATIBLE`, `RESTORE_JOURNAL_PENDING`, `RESTORE_SIGNATURE_INVALID`, `RESTORE_WRITER_UNKNOWN`,
`RESTORE_DEVICE_REVOKED`.

## 8. Acceptance criteria → test matrix

| ID | Criterion | Setup | Expected |
|---|---|---|---|
| WS-01 | `[REQ line 51]` Uncommitted conflict | target checkout has its own uncommitted edits to a file also changed in the capture | preview lists the conflict; preserve ref + copies created before any write; restore lands in a new worktree; target's original edits byte-identical afterwards |
| WS-02 | `[REQ line 51]` Excluded files | source has `.env`, `id_ed25519`, a 6 MiB untracked file, a file with a synthetic AWS key, `node_modules/` | none of them in the decrypted bundle; all listed in `excluded[]` with reasons; tester greps bundle for the fixture secrets → 0 hits |
| WS-02b | `[REQ line 41, 49]` Secrets in unpushed commits; no upstream | repo R1: an unpushed commit adds a synthetic AWS key in `src/cfg.js`, a later unpushed commit deletes it; repo R2: committed `.env` in an unpushed commit; repo R3: branch with no upstream, remote default branch present; repo R4: no remote, no `--base` | R1, R2: `CAPTURE_SECRET_IN_UNPUSHED_COMMIT` with commit + path + detector, no R1/R2 object in the decrypted bundle (tester greps for the fixture secret → 0 hits, also in logs); R3: `base_source: merge_base_default`, bundle holds only commits after the merge-base; R4: `CAPTURE_BASE_UNDEFINED`, metadata only; other repos captured normally |
| WS-03 | `[REQ line 51]` Non-portable manifest | source has an absolute path in config, a `.so` build output, a dev server listening on a port, CUDA in lock | each appears in `nonportable[]` with the right disposition; restore performs no port/process/GPU action and prints hints |
| WS-04 | `[REQ line 51]` Restore failure preserves originals | inject failure after preserve and after the 2nd of 4 apply steps; also `kill -9` mid-apply | journal shows the failed step; originals unchanged; rollback returns the target to its pre-restore tree (hash of `git status` + file hashes equal) |
| WS-05 | Env without values | project with `.env.example` and code reading 3 env vars | `env[]` has names + required + supply path; the manifest schema has no value field; no value from the source environment appears anywhere in the capture |
| WS-06 | Unpushed commits + worktrees | 2 unpushed commits, 2 worktrees, detached HEAD in one | restored worktrees have the same HEADs; unpushed commits present via bundle |
| WS-07 | Symlink policy | relative in-repo link, absolute link, link escaping root, symlinked dir | only the in-repo relative link is restored; others listed; escaping dir not traversed |
| WS-08 | Capture is read-only on source | snapshot of `git status`, index, stash list, refs before/after capture | identical |
| WS-09 | Size limit | total > 50 MiB | `CAPTURE_TOO_LARGE`, nothing stored, largest items listed |
| WS-10 | Isolation + writer authentication (reader-side) | (a) user U2 fetches U1's capture ref by id; (b) U2, given push access, pushes a capture signed by U2's device into U1's repo; (c) revoked device B (keeping its Git credential, non-cooperating client) pushes a capture after `revoked_at`; (d) a capture whose manifest claims `device_id` = A but is signed by B | (a) no access (repo ACL) or decrypt failure or `RESTORE_USER_MISMATCH`; (b) `RESTORE_WRITER_UNKNOWN`; (c) `RESTORE_DEVICE_REVOKED`; (d) `RESTORE_SIGNATURE_INVALID`; in (b)–(d) preview shows nothing to apply and nothing is written on the target |
| WS-11 | Fresh device | third device restores a capture written before it registered with/without another device online | succeeds (after the writer signature verifies against the device list) or `RESTORE_PENDING_KEY` (same rule as ES-02 CK-03) |
| WS-12 | Cross-OS file system (per OS runner; Linux fixture does not count) | case-collision files, long path, exec bit, CRLF repo restored on macOS and Windows | incompatibilities reported and skipped, not silently renamed; results recorded per OS |
| WS-13 | Retention | fast-clock fixture | capture refs beyond 14 d / newest 5 removed; preserve copies on targets untouched |
| WS-14 | `[REQ line 12]` No GUI / no cmux | cmux not installed, no GUI session (no `DISPLAY`/`WAYLAND_DISPLAY`); capture on A and preview + restore on B through the CLI only | same outcome as WS-06; the PASS evidence is only the verified manifest and the journal + hashes (G6); a log copy or an SSH-run listing is not accepted |
