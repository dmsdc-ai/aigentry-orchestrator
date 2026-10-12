# SPEC — ES-04 workspace capture / restore and runtime manifest (task #2026101204)

- Status: CONTRACT SPEC (architect, 2026-10-12). No code. Not an implementation, merge, release or
  install claim (Rule 45 §2, Rule 50 §2).
- Parent: task #2026101204; requirement `state/specs/2026-10-12-environment-sharing-release-requirements.md`
  acceptance criterion 4 (line 41), verification line 51; build-plan draft §3 ES-04 (lines 54–57).
- Owners (proposal): aigentry-devkit (CLI + manifest) + workspace owner; storage via aigentry-brain repo
  (§5) unless the user chooses otherwise.
- Depends on: ES-01 (user/device identity, device keys; the requirements on ES-01 are those of ES-02 §5.5) and the ES-03 §5.1
  lease keeper (sign and list operations). Trust, recipients, revocation, anchors and pushes follow the interface
  invariants I1–I12 of `docs/specs/2026-10-13-env-continuity-interface-invariants.md` (shared with ES-01 and ES-02).
  Optional link to ES-02 (`workspace_capture_id` in a checkpoint).
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
| brain's two push paths (P1 `GitBackend.push`, P2 `sync --tick` `git push origin main`) both push only `main`; neither pushes `refs/aigentry/*`, so brain never sends a capture ref; the user's own `git push --mirror` or `refs/*` refspec would send every local ref (git behaviour from knowledge, not run), which is why an unpushed capture stays outside `refs/` (§4 step 5) (interface invariants doc §A.1, measured 2026-10-13) | `GitBackend.ts:186-191`; `src/cli/seamless/SyncTick.ts:173` |
| brain encrypts with age to a recipient list; recipients grow by TOFU and a new device cannot decrypt older data until an existing device re-encrypts — on that device's next profile write, not merely by being online (early return when its own key is already a recipient); recipients are a union and never shrink | brain `src/backend/GitBackend.ts:104-175` (`:132`), `src/core/ProfileFormat.ts:256-277` |
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

Registry storage capacity/cost; Git-host retention and GC of deleted refs; whether the 50 MiB capture
cap (§3.2) fits the Git host's per-file and per-push limits; repository sizes typical for
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
  no cmux dependency; a copied log file or an SSH connection alone never claims completion. New proposal (needs
  review), applied here:
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
  "redaction": { "scanner_version", "findings_dropped": int },
  "integrity": { "alg": "sha256", "canonical": "jcs", "content_sha256", "bundle_sha256" },
  "signature": { "alg": "ed25519", "device_id", "sig" }
}
```
`content_sha256` covers the manifest without `integrity` and `signature`. `bundle_sha256` is over the
**plaintext** bundle bytes (before age encryption), so the signature binds the content, not one encryption of it. `sig` = the writer's ES-01 device
key over `"aigentry-capture-v1|" + user_id + "|" + capture_id + "|" + content_sha256 + "|" + bundle_sha256`
(writer authentication; `[DRAFT line 36]` device-key signing, binding new).

### 2.1 Repo
| Field | Rule |
|---|---|
| `path_rel` | path relative to the workspace root; absolute paths and home directories are never stored |
| `remote_url` | `origin` fetch URL with userinfo/credentials stripped; other remotes listed by name + stripped URL |
| `branch`, `head_sha`, `upstream`, `ahead`, `behind` | from git; detached HEAD recorded as `branch: null` |
| `unpushed_commits` | count + range `<base>..HEAD` (`base` = upstream, else §3.4); scanned (§3.4) and, only if the scan passes, included in the bundle (§5) because the target cannot fetch them; `base_source: "upstream"\|"merge_base_default"\|"user"`; `base_remote: {name, url (stripped)}` — the remote whose tracking ref contains `base`, which may differ from `origin` (checked in preview, §6.1) |
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
(asked at restore, written to a gitignored local file with mode 0600 on macOS/Linux and an owner-only ACL
on Windows, where 0600 has no meaning), `secret_manager_ref` (an opaque
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
- The manifest itself is scanned too: **every string value** of the canonical manifest (§2) — user/derived
  free text (`env[].note`, a `secret_manager_ref` supply value, `services[].how_to_recreate`,
  `nonportable[].detail`/`recreate_hint`, `config_schema[].ref`), URLs (`remote_url`, other remotes,
  `submodules[].url`) and every other string — before integrity, signing and encryption, with the same
  detector set. URL values have userinfo, query string and fragment stripped by default before the scan
  (keeping a query is a per-value user choice, still scanned). A hit in a free-text or URL value replaces the
  match with `[REDACTED:<detector>]` and is counted in `redaction: {scanner_version, findings_dropped}` (a
  manifest field); a hit in a path of a captured file excludes that file (`secret_suspected`); a hit in a
  key-forming identifier (`capture_id`, `user_id`, `device_id`) refuses the capture
  (`CAPTURE_SECRET_IN_IDENTIFIER`). Findings name the field and detector only.
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
  tree: (a) every path added or modified by any commit in the range — the union of `git log --format=
  --name-only --diff-merges=separate base..HEAD` (merge commits list their paths against each parent; the
  default prints none for merges. Measured on Git 2.43.0 with a merge fixture: `--diff-merges=separate` and `-m` print
  the same per-parent lists, and the default prints none. On a Git that rejects `--diff-merges` (2.31+ per the
  review, not measured here), `-m` is used. If neither form lists the paths of a probe merge, the scan fails closed,
  `CAPTURE_SCAN_UNAVAILABLE`) and the path names `git rev-list --objects base..HEAD` prints for every new
  blob, including paths deleted again by a later commit — their blobs are still in the bundle — against the
  §3.1 secret set; (b) every blob reachable from `HEAD` and not from `base` (`git rev-list
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

1. Preflight: ES-01 identity, the lease keeper's `sign` operation (ES-03 §5.1; interface invariant I12; this CLI never
   reads the key store, else `CAPTURE_IDENTITY_MISSING`), scanner, encryption key available; repo is a git work tree.
2. For each repo/worktree: collect §2.1 metadata; build a **shelf commit** without touching the user's
   index or working tree: `git stash create` semantics (tracked changes) plus a separate tree for
   untracked files (temporary index via `GIT_INDEX_FILE`), never `git stash push`.
3. Resolve `base` and scan `base..HEAD` (§3.4); on a refusal nothing of that repo is bundled. Otherwise build
   `git bundle` containing `base..HEAD` (unpushed commits) + the shelf commit(s).
4. Write manifest, scan every string value of it (§3.2), compute integrity, sign through the keeper (§2), encrypt bundle + manifest (age,
   recipients = the recipient set of ES-02 §5.6 / invariant I5 — trusted, active, confirmed, and `age_recipient_sig` verified
   against the pinned `public_key`; trusted alone is not enough; fail-closed — no plaintext fallback, cf. brain
   `ProfileFormat.ts:160-181` which does fall back).
5. Store (§5); print a summary: captured repos, excluded paths with reasons, non-portable items, size.
   Stored ≠ pushed (the analogue of ES-02 §5.1): the capture's local `sync_state` is `written` (`manifest.age` and
   `bundle.age` fsynced in the capture outbox `<aig>/capture-outbox/<capture_id>/` of the brain repo, i.e. inside its
   Git directory, so no `git add` can stage it and brain's ignore list needs no change; **no ref**) → `pushed` (the ref push succeeded and `git ls-remote` shows the ref at the same commit). The
   summary says "saved on this device" at `written` and "available on your other devices" only at `pushed`.
   `<aig>` = `$(git rev-parse --path-format=absolute --git-common-dir)/aigentry` run in the brain repo
   (`BRAIN_REPO_PATH`, default `~/.aigentry/repo`), the same from every linked work tree (interface invariants §B.1);
   the gate below checks it against the path brain prints.
   Before every push of a capture ref, the ES-02 §5.4 pre-push recipient gate runs (invariants I9, I10). The capture-ref
   push is ES-04's own; brain never pushes `refs/aigentry/*` (§0.1). The gate holds `<aig>/capture.lock` (the brain
   repo's Git directory, as the outbox) for the whole attempt, so two ES-04 runs never touch each other's ref. It:
   - asks **brain** to refresh the trust state: it runs `aigentry-brain trust refresh` (ES-02 §5.4; interface
     invariants BR-6), which fetches the list through the keeper, runs the ES-02 §5.4 re-evaluation, applies the
     approvals valid on this device, requests the ones that are due (ES-02 §5.6) and persists the result under brain's
     trust-state lock. ES-04 never writes the
     trust state (I3, I12). It then reads `trust-state.json` under the printed `aig` and uses it only if that `aig`
     equals its own `<aig>` and its `device_list.server_time` is **not earlier than** the printed `server_time` (a
     concurrent brain refresh can only have made it fresher). If brain is unavailable, the command fails, the paths
     differ or the stored time is earlier, the push is held (`CAPTURE_PUSH_HELD`, stays `written`, "saved on this
     device");
   - holds the push (`CAPTURE_PUSH_HELD`, reason `RECIPIENT_CHANGE_UNAPPROVED`, stays `written`) while that trust
     state has a trusted active device whose verified `age_recipient` differs from its pin, or has none (I5), and
     prints the notice with "approve request `<request_id>` in Kkoma, on the registry approval page, or with
     `aigentry-devkit approve <request_id>` on a device that can approve". Captures are never rekeyed (N-U5), so
     pushing without that device would lock it out of the capture for good;
   - holds the push the same way (`CAPTURE_PUSH_HELD`, reason `TRUST_BOOTSTRAP_REQUIRED`) while that trust state has no
     `root` anchor (the bootstrap is not approved, ES-02 §5.6), printing the same instruction for the `bootstrap`
     request. ES-04 never creates an approval and never calls the keeper's `approve` (interface invariants §B.1
     "Approval");
   - holds the capture (`CAPTURE_REFERENCE_HELD`, stays `written`) when its `checkpoint_id` names a checkpoint that is
     not `accepted` in that refreshed trust state (a checkpoint `ckpt_<this device_id>_…` that this device wrote counts
     as accepted), until it is accepted or the user confirms with the I9 disclosure;
   - re-encrypts `manifest.age` and `bundle.age` from the outbox to the refreshed trust state's `recipients` (ES-02
     §5.6 "Recipient", I5) every time; the signature is over plaintext hashes (§2), so it is unchanged;
   - only then creates the orphan commit and the local ref `refs/aigentry/ws/<device_id>/<capture_id>` and pushes
     it. If the push fails, it deletes the local ref (the capture stays `written` in the outbox; the orphan commit is
     unreachable and never sent). A capture is therefore in `refs/` only during a gated attempt or once `pushed`, so a
     user's `git push --mirror` or `refs/*` push finds no unpushed capture (invariant I10 (v)). After a crash inside
     an attempt, the next ES-04 run (under the lock) deletes the local ref of each of its own captures that is still
     `written` (outbox copy present) and that `git ls-remote` does not show, and keeps the outbox copy. Until that run
     the ref stays; captures are explicit commands, so this window can last days. A mirror push in it sends the
     capture wrapped to the recipients of the crashed attempt's own refresh (the I10 crash residual). The outbox copy
     is removed once the capture is `pushed`;
   - holds the push (`written`, `CAPTURE_PUSH_HELD`) if the refresh's list fetch fails (ADR D-8 (b), pending user
     decision; decision bundle 2g default "hold"), unless the user opted in to pushing with the cached set.

   Until brain provides `trust refresh` and keeps the trust state in the Git directory (interface invariants BR-5,
   BR-6), every capture push is held (`CAPTURE_PUSH_HELD`). Capture upload does not wait on brain's push gate (BR-1,
   BR-2; interface invariants §B.5).

The source working tree, index, stash list, branches and refs are unchanged by capture (tested, WS-08).

## 5. Storage (decision needed — Rule 47 cost / retention / privacy; ADR D-2, D-3, D-6)

| Option | Where | Cost | Retention control | Privacy | Notes |
|---|---|---|---|---|---|
| **S1 (recommended default)** encrypted bundle on a per-capture ref in the user's private brain repo | `refs/aigentry/ws/<device_id>/<capture_id>` → orphan commit holding `manifest.age` + `bundle.age` | user's Git host quota; no new aigentry infra | expiry pass deletes the ref; host GC timing not controlled (disclosed) | encrypted; per-user private repo (§0.1) | brain pulls only `main` (`GitBackend.ts:83`) and clones `--depth 1` (`:30`), so capture refs are not downloaded by normal brain sync; fetched on demand by capture id |
| S2 Git shelf branch/ref in the **project's own remote** | `refs/aigentry/shelf/...` on `origin` | none | ref delete; host GC | **unencrypted uncommitted work pushed to a remote that may be shared with collaborators or public** | rejected as default; not offered unless the user explicitly asks per repo |
| S3 registry artifact store | new object storage behind registry auth (ES-01) | new storage + egress cost (unmeasured) | real deletion + server TTL | server-side; needs encryption-at-rest decision | needs registry work, credentials/scopes and a cost approval; candidate for a later release |

Recommended default **S1** with: retention 14 days per capture, keep at most the newest 5 captures per
device, 50 MiB cap. Rationale: no new infrastructure or credentials (Article 1, 17), per-user isolation
already exists, data encrypted to the user's devices, cost borne by the user's existing Git host. Known
limits: deleted refs may persist on the host until GC; **captures are never rekeyed** (interface non-claim N-U5):
a capture is readable only by the devices that were in the recipient set when its gated push ran. A device that
registered or became trusted later gets `RESTORE_NOT_A_RECIPIENT`, which is terminal: it does not resolve when
another device comes online. The remedy is a new capture on a device that holds the work. ES-02 §5.3's rekey pass
applies to checkpoint files only. Reason (ADR A14): an automatic capture rekey would re-upload uncommitted code
without a capture command, which D-6 excludes, and it would add a second ref grammar, a content binding and a gate
path for an artefact kept 14 days. **Upload can wait indefinitely** (§4 step 5), and the D-6 consent text says so:
"a capture is uploaded only after you have approved this device once, and, after any of your devices is added or
rotates its key, only after you approve that change; there is no timeout. You approve in Kkoma, on the registry
approval page, or in a terminal on one of your trusted devices; a new device is approved from a device you already
trust. Kkoma can do that only if it is registered as a device and every device trusts it: register Kkoma first, or
approve Kkoma from a terminal on a computer you registered earlier (turn on approval for that computer in the
browser first if it is off); every computer you add before Kkoma is trusted also needs that terminal step, so register
Kkoma right after your first computer if you want only one; after that, Kkoma alone is enough. Before you approve a new
device, compare the fingerprint shown with the one that device prints (`aigentry-devkit login` or `aigentry-devkit
whoami` on it). A first computer set up without an interactive console is approved from Kkoma or the approval page (or
from its own terminal after you turn approval on for it). Only you should do this: brain cannot tell you from a program that drives your terminal or holds a device key,
so an agent must never approve or answer an approval. Until then the capture stays on this device." A device that
nobody approves for keeps waiting; it no longer needs a terminal of its own (interface invariants §B.1 "Channels").
The one terminal step that can remain, and the order that avoids it, are stated in interface invariants §B.1
"Product consequence" (decision bundle 2i). A
revoked device keeps Git access to the capture refs until the user revokes its GitHub credential — it can
fetch ciphertext (decrypting captures written before the revoke) and push refs, which readers reject (§6.1)
(ES-02 §5.3 known limit, ADR D-8).

## 6. Restore flow (preview → conflict detection → preserve copy → apply)

### 6.1 Preview (read-only; no writes)
Fetch and decrypt the capture, verify integrity and the writer signature with the same reader-side rules
as ES-02 §5.4 and the interface invariants I1–I8 (device in the authenticated, trusted list of the logged-in user; signature valid;
`user_id` match; a capture by a revoked device with `created_at ≥ revoked_at` → `RESTORE_DEVICE_REVOKED`;
an older one is anchored only if its seen ref's `first_seen_by` is earlier than `revoked_at` (I6; a checkpoint that names
the capture in `workspace_capture_id` anchors nothing), else
`RESTORE_REVOKED_WRITER_UNANCHORED` — shown only with a warning and an explicit user choice; a capture this device cannot
decrypt → `RESTORE_NOT_A_RECIPIENT` (terminal, §5, N-U5), with the message "this capture was encrypted before this
device could receive it and will not become readable here; capture again on `<writer device name>` (or on any device
that can open it, after restoring it there)", or, when `H` is empty (no non-revoked device other than this one,
`active` or `expired`, with a recipient, in the fresh list **or pinned and missing from it**; an `expired` device
re-binds with the same key; interface invariant I11) and the bootstrap is approved,
`RESTORE_UNRECOVERABLE_KEY` with the N-U1 message, which then stays for that capture; neither is ever reported as pending; the ref name
`refs/aigentry/ws/<device_id>/<capture_id>` must equal the manifest's `device_id` and `capture_id`, else
`RESTORE_PATH_MISMATCH`). Each device keeps a local list of capture refs it has seen, `<aig>/capture-seen.json` in the brain repo's Git
directory (never in a work tree; interface invariants §B.1 "Local state") (`capture_id` →
`{commit, first_seen_by, state}`, with `first_seen_by` the server-clock bound of ES-02 §4.2: the `server_time` printed
by the first successful `aigentry-brain trust refresh` that ES-04 started after the ref was fetched, bound to that
commit id; `null` = provisional). ES-04 is its only writer, under `<aig>/capture.lock`. That list is kept with the same
durability as ES-02's trust state (atomic write, never rebuilt; I3). The trust graph
itself (anchors, pins, endorsements, and so the trusted and recipient sets) is **not** kept by ES-04: it is read from
the device's single trust state, owned and written only by brain (ES-02 §4.2 `<aig>/trust-state.json`), after a
trust refresh ES-04 requested (as in §4 step 5, with the same `aig` and `server_time` checks). If the refresh fails,
preview uses the saved trust state and is labelled provisional (I7). So one device
never holds two pin sets. ES-04 cannot create that trust state. When it is missing or fails to parse, preview stops
before any decryption with `RESTORE_TRUST_STATE_MISSING` and the message "this device has no trust state yet; run
`aigentry-brain trust refresh` once, approve this device's `bootstrap` request from a device you trust (ES-02 §5.6
fresh-device bootstrap), then retry". When the trust state exists but has no `root` anchor (no valid `bootstrap`
approval applied yet), preview stops the same way with `TRUST_BOOTSTRAP_REQUIRED` and the request id. When it reports
`TRUST_ANCHOR_REQUIRED` (ES-02 §5.6), preview names the `anchor` request ids. Preview **reports and never
approves**: it pins, anchors and endorses nothing, whether or not it runs in a terminal (interface invariants §B.1
"Approval").
- A capture previewed under a stale list is labelled provisional.
- It is re-checked after every trust refresh ES-04 requests, with the ES-02 §5.4 re-evaluation rule. If it then fails, the
  seen-ref entry is demoted, not deleted.
- Any `restore-journal.json` that restored from it gets a `demoted: <code>` note, shown at the next CLI run.
  Files already restored are never removed automatically (G2).

A seen ref that disappears outside a retention pass, or now points to another commit (force push), is reported
(`CAPTURE_REF_CHANGED`) — detected, not prevented (§5 known limit). Then show
per repo: target path, clone needed or not,
branch/HEAD, unpushed commits to import, files to be written (staged / unstaged / untracked), excluded
items from capture, non-portable items, env names needing a supply path, toolchain version
differences (`required 20.x, found 18.19` / `missing`). The user confirms per repo; no default "yes".
Restore writes refs, worktrees and preserve directories in the user's project repos and home
(`~/.aigentry/workspace-preserve/`); that per-repo confirmation is the runtime consent for those writes and
is recorded in `restore-journal.json` (who/when/which repo). Nothing is written for an unconfirmed repo.

### 6.2 Conflict detection
| Conflict | Detection | Default handling |
|---|---|---|
| repo missing on target | path absent | clone from `remote_url` (user's own credentials) |
| different remote | `origin` URL differs after normalisation | stop for that repo (`RESTORE_REMOTE_MISMATCH`) |
| HEAD not reachable | `head_sha` not in remote and not in bundle | stop (`RESTORE_HEAD_UNAVAILABLE`) |
| bundle base not reachable | in preview, `git bundle verify` against the target repo reports missing prerequisites and `base_remote` ≠ `origin` | stop before any write (`RESTORE_BASE_UNAVAILABLE`), naming `base_remote` so the user can add and fetch it |
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
`CAPTURE_NOT_A_REPO`, `CAPTURE_SECRET_IN_UNPUSHED_COMMIT`, `CAPTURE_BASE_UNDEFINED`, `CAPTURE_SECRET_IN_IDENTIFIER`, `RESTORE_INTEGRITY_FAILED`, `RESTORE_USER_MISMATCH`, `RESTORE_NOT_A_RECIPIENT` (terminal, §5),
`RESTORE_REMOTE_MISMATCH`, `RESTORE_HEAD_UNAVAILABLE`, `RESTORE_PATCH_CONFLICT`,
`RESTORE_FS_INCOMPATIBLE`, `RESTORE_JOURNAL_PENDING`, `RESTORE_SIGNATURE_INVALID`, `RESTORE_WRITER_UNKNOWN`,
`RESTORE_DEVICE_REVOKED`, `RESTORE_PATH_MISMATCH`, `RESTORE_BASE_UNAVAILABLE`, `CAPTURE_REF_CHANGED`,
`RESTORE_REVOKED_WRITER_UNANCHORED`, `CAPTURE_REFERENCE_HELD` (informational, §4 step 5), `CAPTURE_PUSH_HELD`
(informational, §4 step 5: no refreshed trust state, the list fetch failed, `RECIPIENT_CHANGE_UNAPPROVED`, or `TRUST_BOOTSTRAP_REQUIRED`), `RESTORE_UNRECOVERABLE_KEY`
(§6.1, non-claim N-U1), `RESTORE_TRUST_STATE_MISSING` (§6.1); from brain's trust state, reported only:
`TRUST_BOOTSTRAP_REQUIRED` (§6.1; also a `CAPTURE_PUSH_HELD` reason, §4 step 5), `TRUST_ANCHOR_REQUIRED` (§6.1).

## 8. Acceptance criteria → test matrix

Columns: **Measures** = what a PASS of the row proves; **Does not measure** = what it does not prove;
**Runnable now** = `Linux fixture` (runs on the Linux host alone, with the local/stub dependencies named in
the row, once the implementation exists) or `BLOCKED`; **Blocked on** = the missing dependency. A BLOCKED
row is never reported as PASS (not as "skipped = pass", not by a Linux substitute). A Linux-fixture PASS
proves only its Measures column and is never a cross-platform or real-endpoint PASS (`[REQ line 52]`). No
row has been run; no implementation exists.
Every Linux-fixture row here uses a stub ES-01 identity (a local device list with generated keys), because
writes and reads require ES-01 (§4, §6.1); none of them measures the real ES-01 integration.

| ID | Criterion | Setup | Expected | Measures | Does not measure | Runnable now | Blocked on |
|---|---|---|---|---|---|---|---|
| WS-01 | `[REQ line 51]` Uncommitted conflict | target checkout has its own uncommitted edits to a file also changed in the capture | preview lists the conflict; preserve ref + copies created before any write; restore lands in a new worktree; target's original edits byte-identical afterwards | preserve-before-write, new-worktree default, originals byte-identical | macOS/Windows file systems; large repos | Linux fixture (two local clones) | — |
| WS-02 | `[REQ line 51]` Excluded files | source has `.env`, `id_ed25519`, a 6 MiB untracked file, a file with a synthetic AWS key, `node_modules/`; manifest inputs: a synthetic key in an `env[].note`, a synthetic token as a `secret_manager_ref` value, and a non-origin remote `https://u:synthpass@host/r.git?token=<synthetic>`; separately, a capture whose `device_id` fixture value carries a synthetic token | none of the files in the decrypted bundle; all listed in `excluded[]` with reasons; the manifest carries `[REDACTED:*]` in place of the note/ref secrets, the remote URL without userinfo and query, `redaction.findings_dropped` ≥ 2; tester greps the decrypted bundle **and** decrypted manifest (and logs) for the fixture secrets → 0 hits; the identifier case → `CAPTURE_SECRET_IN_IDENTIFIER`, nothing stored, field and detector named only | deny-list, size and detector exclusions in the working tree; every-string manifest scan and URL stripping | false negatives on real secrets | Linux fixture | — |
| WS-02b | `[REQ line 41, 49]` Secrets in unpushed commits; no upstream | repo R1: an unpushed commit adds a synthetic AWS key in `src/cfg.js`, a later unpushed commit deletes it; repo R2: committed `.env` in an unpushed commit; repo R3: branch with no upstream, remote default branch present; repo R4: no remote, no `--base`; repo R5: a `.env` (content matching no detector) introduced only in a merge resolution within the unpushed range | R5: `CAPTURE_SECRET_IN_UNPUSHED_COMMIT` by the path check (merge paths listed); R1, R2: `CAPTURE_SECRET_IN_UNPUSHED_COMMIT` with commit + path + detector, no R1/R2 object in the decrypted bundle (tester greps for the fixture secret → 0 hits, also in logs); R3: `base_source: merge_base_default`, bundle holds only commits after the merge-base; R4: `CAPTURE_BASE_UNDEFINED`, metadata only; other repos captured normally | unpushed-range scan, per-repo refusal, base resolution, no matched text in logs | false negatives; remote default-branch configurations beyond the fixture | Linux fixture (local bare remotes) | — |
| WS-03 | `[REQ line 51]` Non-portable manifest | source has an absolute path in config, a `.so` build output, a dev server listening on a port, CUDA in lock | each appears in `nonportable[]` with the right disposition; restore performs no port/process/GPU action and prints hints | detection and disposition of the listed non-portable kinds on Linux | macOS `lsof` / Windows `netstat` detection; real GPU runtimes | Linux fixture | per-OS variants: macOS/Windows runners |
| WS-04 | `[REQ line 51]` Restore failure preserves originals | inject failure after preserve and after the 2nd of 4 apply steps; also `kill -9` mid-apply | journal shows the failed step; originals unchanged; rollback returns the target to its pre-restore tree (hash of `git status` + file hashes equal) | journal, stop-on-failure, rollback to the pre-restore tree | power loss; Windows file locking | Linux fixture | — |
| WS-05 | Env without values | project with `.env.example` and code reading 3 env vars | `env[]` has names + required + supply path; the manifest schema has no value field; no value from the source environment appears anywhere in the capture | env names only; no value field, no value anywhere | code-scan recall for env names | Linux fixture | — |
| WS-06 | Unpushed commits + worktrees | 2 unpushed commits, 2 worktrees, detached HEAD in one | restored worktrees have the same HEADs; unpushed commits present via bundle | unpushed commits and worktrees reproduced | submodule/LFS content (not captured by design) | Linux fixture | — |
| WS-07 | Symlink policy | relative in-repo link, absolute link, link escaping root, symlinked dir | only the in-repo relative link is restored; others listed; escaping dir not traversed | symlink policy on Linux | Windows symlink permission (WS-12) | Linux fixture | — |
| WS-08 | Capture is read-only on source | snapshot of `git status`, index, stash list, refs before/after capture | identical | capture leaves source state unchanged | concurrent edits during capture | Linux fixture | — |
| WS-09 | Size limit | total > 50 MiB | `CAPTURE_TOO_LARGE`, nothing stored, largest items listed | cap enforced, nothing stored, largest items listed | Git-host per-file/push limits (not measured) | Linux fixture | — |
| WS-10 | Isolation + writer authentication (reader-side) | (a) user U2 fetches U1's capture ref by id; (b) U2, given push access, pushes a capture signed by U2's device into U1's repo; (c) revoked device B (keeping its Git credential, non-cooperating client) pushes a capture after `revoked_at`; (d) a capture whose manifest claims `device_id` = A but is signed by B; (e) revoked B pushes an endorsement, dated before `revoked_at`, of a device D registered after B's `revoked_at` (and a variant: registered before it, endorsed by no non-revoked device), then a capture signed by D; (f) root A revoked, writer B endorsed only by A, fresh reader C; (g) reader C with a list cache from before B's revoke at T, registry unreachable, fetches a capture B pushed after T but dated before T, previews and restores it, then the registry becomes reachable; (g) reference variant: after the refresh, non-revoked device A pushes a checkpoint whose `workspace_capture_id` names that backdated capture, and C syncs it; (h) ES-04 keeps no pins: brain's trust state (ES-02 §4.2) records a registry fault for writer B's pinned key, and in a variant `<aig>/trust-state.json` is deleted; in a second variant revoked B pushes a force-added `.aigentry/trust-state.json` that pins B's key as trusted and A pulls it (ES-02 CK-27 (a)) | (a) no access (repo ACL) or decrypt failure or `RESTORE_USER_MISMATCH`; (b) `RESTORE_WRITER_UNKNOWN`; (c) `RESTORE_DEVICE_REVOKED`; (d) `RESTORE_SIGNATURE_INVALID`; (e) endorsement void (`ENDORSEMENT_AFTER_REVOKE` / `ENDORSEMENT_REVOKED_ENDORSER_UNANCHORED`, ES-02 §5.6), D's capture `RESTORE_WRITER_UNKNOWN`, D not a recipient of the next capture; in (b)–(e) preview shows nothing to apply and nothing is written on the target; (f) B's capture is `RESTORE_WRITER_UNKNOWN` with `TRUST_ANCHOR_REQUIRED` and nothing is written; after the user pins B as a local anchor on C (ES-02 §5.6), preview verifies B's capture; (g) before the refresh: the preview is labelled provisional and the seen ref has `first_seen_by: null`; after the refresh: `RESTORE_REVOKED_WRITER_UNANCHORED`, the seen-ref entry is demoted (not deleted), the restore journal gets `demoted: RESTORE_REVOKED_WRITER_UNANCHORED`, restored files and preserve copies are untouched; (g) reference variant: A's checkpoint is accepted on C, and the capture stays `RESTORE_REVOKED_WRITER_UNANCHORED` (a reference anchors nothing, I6); (h) preview of B's capture follows brain's trust state with no ES-04 pin of its own (B's capture not verified while the fault stands); deleted variant: preview stops with `RESTORE_TRUST_STATE_MISSING` and the bootstrap-approval message, nothing decrypted or written; after the approved bootstrap, nothing is verified before the next successful list fetch; second variant: ES-04 reads only `<aig>/trust-state.json` (file-access audit), B's capture is still not verified | isolation and reader-side rejection of foreign, revoked and forged writers and of backdated endorsements; trust-anchor recovery (f); stale-cache re-evaluation and demotion (g); one trust state per device (h; invariant I3) | GitHub credential revocation (user step, D-8); the real ES-01 list | logic variant: Linux fixture (stub ES-01 lists for two users, local bare remotes, modified client for B); real-ES-01 variant: BLOCKED | real-ES-01 variant: ES-01 (two users, keys and list R1–R4) |
| WS-11 | Fresh device | third device C registers and is endorsed; (a) a capture writer A pushed **before** C entered R, previewed on C once with A offline and once with A and another device online; then A captures again; (b) a capture A pushed after C entered R; variant: first device revoked before C registers, the capture's writer B endorsed only by it, B's capture pushed before C was anchored; lone-survivor variant: the first device (the root) was the user's only device, wrote the capture, and is revoked before C registers; expired-peer variant: root A wrote the capture to {A, Mac B}, B is idle-`expired` (not revoked), A is revoked, fresh C previews; control: B revoked; pinned-but-missing variant: as the expired-peer variant on a reader that pinned unrevoked B at its bootstrap, with the stub registry then omitting B; MCP-only variant (ES-02 CK-03 (h) counterpart): fresh C on which brain ran only MCP sync passes (trust state present, no `root` anchor); ES-04 preview and a capture push run once with stderr not a terminal and once in a terminal; then the user approves C's `bootstrap` request on A; separately the variant's `TRUST_ANCHOR_REQUIRED` state. Every other variant has C's bootstrap approved first | (a) `RESTORE_NOT_A_RECIPIENT` with the §6.1 "capture again on `<A>`" message in **both** cases (another device being online changes nothing; never reported as pending); nothing is written on the target; the new capture from A restores on C; (b) succeeds after the writer signature verifies against the device list; variant: `TRUST_ANCHOR_REQUIRED` until the user pins B as a local anchor (ES-02 §5.6, CK-03 (d)), then B's earlier capture is `RESTORE_NOT_A_RECIPIENT` and a new capture by B (C now in B's R) restores; lone-survivor variant: **no** `TRUST_ANCHOR_REQUIRED`, the capture is `RESTORE_UNRECOVERABLE_KEY` with the N-U1 message, nothing is written on the target; expired-peer variant: `RESTORE_NOT_A_RECIPIENT`, never `RESTORE_UNRECOVERABLE_KEY`; control: `RESTORE_UNRECOVERABLE_KEY`; pinned-but-missing variant: `RESTORE_NOT_A_RECIPIENT`, never `RESTORE_UNRECOVERABLE_KEY`; MCP-only variant: both runs stop preview with `TRUST_BOOTSTRAP_REQUIRED` and the request id before any decryption, the capture push is `CAPTURE_PUSH_HELD` (`TRUST_BOOTSTRAP_REQUIRED`) and nothing is pushed, and ES-04 writes no trust-state byte, no pin or anchor and no approval in either run (file-access audit, keeper protocol capture); after A's approval and the next refresh, preview proceeds as in the other variants; the anchor state likewise only reports `TRUST_ANCHOR_REQUIRED` with the request ids and anchors nothing | captures are never rekeyed and the terminal `RESTORE_NOT_A_RECIPIENT` (N-U5); re-capture as the remedy; trust-anchor recovery; the lone-survivor outcome; an `expired` or pinned-but-missing peer never yields `RESTORE_UNRECOVERABLE_KEY` (invariant I11, non-claim N-U1); ES-04 reports and never confirms the bootstrap or an anchor (MCP-only variant; invariants I4, I5) | real install on another OS (ES-06) | BLOCKED | ES-01 (registration, `age_recipient`, endorsement) |
| WS-12 | Cross-OS file system (per OS runner; Linux fixture does not count) | case-collision files, long path, exec bit, CRLF repo restored on macOS and Windows | incompatibilities reported and skipped, not silently renamed; results recorded per OS | per-OS file-system incompatibility handling | — | BLOCKED | macOS/Windows runners (Mac offline, requirement line 60; no Windows runner) |
| WS-13 | Retention | fast-clock fixture | capture refs beyond 14 d / newest 5 removed; preserve copies on targets untouched | ref expiry and newest-5 rule; preserve copies untouched | Git-host GC of deleted refs | Linux fixture (fast clock) | — |
| WS-14 | `[REQ line 12]` No GUI / no cmux | cmux not installed, no GUI session (no `DISPLAY`/`WAYLAND_DISPLAY`); capture on A and preview + restore on B through the CLI only | same outcome as WS-06; the PASS evidence is only the verified manifest and the journal + hashes (G6); a log copy or an SSH-run listing is not accepted | no GUI/cmux needed; only manifest + journal + hashes count as evidence | real two hosts; macOS/Windows terminals | Linux fixture (single host, two device dirs, stub ES-01 list) | real two-host variant: ES-01 |
| WS-15 | `[REQ line 41]` Runtime / toolchain / lock / config-schema manifest | source project with `.nvmrc` (`20`) and `.python-version`, `package-lock.json` and `uv.lock`, a `config.schema.json` and a `.env.example`; target fixture whose `node --version` reports 18.x | manifest `toolchains[]` lists node and python with `pinned_by` and `detected_version`; `package_locks[]` lists both locks with `manager` and `sha256` equal to the files; `config_schema[]` lists both refs, no values; preview shows `node: required 20.x, found 18.x`; recreate commands (`npm ci`, `uv sync`, toolchain hint) are **printed, not executed**: no process spawned by the restore tool beyond `--version` probes and git (process audit of the fixture), no global install, no file written outside the restore worktree and the preserve/journal paths | §2.2 manifest content, §6.1 toolchain-difference preview, §6.4 print-not-run | real installs or rebuilds on any OS (ES-06); detector recall on ecosystems beyond the fixture | Linux fixture | — |
| WS-15b | `[REQ line 41, 52]` Runtime manifest per OS (macOS, Windows) | WS-15 project captured on Linux, previewed/restored on macOS and Windows targets | as WS-15 on each OS, plus `source.os` vs target differences shown in preview; results recorded per OS | per-OS toolchain detection and preview | real installs (ES-06) | BLOCKED | macOS/Windows runners (Mac offline, requirement line 60; no Windows runner) |
| WS-16 | Stored ≠ pushed; ref tampering; base on a non-origin upstream | (a) capture with the brain remote unreachable, later reachable; (b) a seen capture ref deleted, and another force-pushed to a different commit; (c) a capture ref renamed to another `capture_id`; (d) branch whose upstream is on remote `fork` ≠ `origin`, target cloned from `origin` only; (e) capture written while the brain remote is unreachable with B a recipient, B then revoked; push once (e1) registry and remote reachable, (e2) only the remote reachable; (f) the stub registry serves recipient B's `age_recipient` replaced by a fixture key with no valid `age_recipient_sig`; (g) a capture whose `checkpoint_id` names a checkpoint that is `DEMOTED` on this device; (h) the keeper is stopped and cannot be started; (i) as (e) with B still a recipient in the cache and the remote reachable, the user runs `git push --mirror` (and a variant `git push origin 'refs/*:refs/*'`) in the brain repo before ES-04 pushes; separately, the gate is killed after creating the local ref and before its push, and ES-04 runs again; and two ES-04 pushes start together; (j) B is revoked in the stub registry; B's checkpoint r, which the capture names in `checkpoint_id`, has `created_at` ≥ `revoked_at` and is `accepted` in brain's saved trust state; no brain pass runs before the ES-04 push; variant: B's `age_recipient` was validly rotated (seq 2) since the last refresh, and B is not revoked, and a brain MCP sync pass ran after the rotation and before ES-04; ES-04 runs once before and once after the user approves the `recipient_accept` request for (B, 2); second variant: `aigentry-brain` is not installed or exits non-zero | (a) `sync_state: written`, the capture only in the capture outbox and no local `refs/aigentry/ws/*` ref, summary "saved on this device" only; after the push `pushed` and only then "available on your other devices"; (b) `CAPTURE_REF_CHANGED` for both; (c) `RESTORE_PATH_MISMATCH`; (d) manifest `base_remote.name: fork`; preview stops with `RESTORE_BASE_UNAVAILABLE` naming `fork`, nothing written; (e1) the pushed ref's `manifest.age`/`bundle.age` do not decrypt with B's key and the signature verifies; (e2) push held, `sync_state: written`, nothing pushed; (f) B is not a recipient, a registry-fault notice is shown, the pushed capture does not decrypt with the fixture key; (g) `CAPTURE_REFERENCE_HELD`, nothing pushed until the user confirms with the I9 disclosure; after the confirmation the checkpoint stays demoted on every reader; (h) `CAPTURE_IDENTITY_MISSING`, nothing stored, nothing pushed; (i) the mirror push sends no `refs/aigentry/ws/*` ref and no object of the capture (`git ls-remote` and `git rev-list --objects --all` on the bare remote); after the killed attempt, the next run deletes the unpushed local ref, the capture is still `written` in the outbox, and its later gated push does not decrypt with a revoked B's key; the two concurrent pushes are serialized by `capture.lock` and neither deletes the other's ref; (j) the gate's `trust refresh` demotes r (`DEMOTED:CHECKPOINT_DEVICE_REVOKED`) in `<aig>/trust-state.json`, written by the brain process only (file-access audit: ES-04 opens it read-only), and the capture is `CAPTURE_REFERENCE_HELD`; variant: after the brain pass the change is still unapproved; the first run is `CAPTURE_PUSH_HELD` (`RECIPIENT_CHANGE_UNAPPROVED`) and pushes nothing, whether or not it has a terminal; in the run after the approval, the gate's refresh applies it, and the pushed capture decrypts with B's new key; second variant: `CAPTURE_PUSH_HELD`, nothing pushed, the capture stays `written` | `sync_state` wording, ref deletion/overwrite detection, ref ↔ manifest binding, base-remote preview check, pre-push recipient gate for capture refs (e); recipient condition incl. `age_recipient_sig` (f; I5); reference hold (g; I9); keeper-only signing (h; I12); unpushed captures outside `refs/` and the capture lock (i; I10 (v)); the gate judges references and recipients only on a trust state brain refreshed for this push (j; I3, I5, I9, BR-6) | prevention of ref deletion (only detected); Git-host GC; the real keeper (h uses a stub) | Linux fixture (local bare remotes, stub ES-01 list, stub keeper) | real-keeper variant of (h): ES-03 §5.1 keeper implementation; D-Q-9; (j) brain BR-5/BR-6 |
