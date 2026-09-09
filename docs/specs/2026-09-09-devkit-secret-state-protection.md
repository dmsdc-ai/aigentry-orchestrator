# SPEC — devkit installer secret/state protection (#1142) — r4

Status: **Storage policy APPROVED (§9); design not approved. Nothing implemented, nothing executed.** sp1142-architect · worktree
`/Users/duckyoungkim/.aigentry/worktrees/sp1142` (`docs/1142-secret-spec`) · source READ ONLY
`/Users/duckyoungkim/projects/aigentry-devkit` @ `bb7876bcbe8f83c2d329b22f41751b2b07f1f61a`.
**Labels**: `[S]` source read this session · `[X]` measured elsewhere, cited · `[I]` inference from source + documented platform
behaviour, **not executed here** · `[A]` assumption · `[P]` proposal. **This session performed no runtime observation** — every mode,
umask, timing and visibility statement is `[I]`/`[A]`. r4 scopes §6.1 to installer-owned artifacts, names the realizable primitives
in §3.4 and isolates one **unresolved contract (C-B)** there, and adds the §7.1 N1 handoff. §11 records the history.

## 0. Provenance
- Base `bb7876b` (= repo HEAD), read `2026-09-09T09:50:17Z`. sha256 `[S]`: `install.sh` (951 L) `767c7a74985071520c9e5acebcdca23b3ec213d080afd94246e2701143e0de65`; `install.ps1` (453 L) `ddfca24c16e7562cddab98ab2006357b44ad859ebd52bd6a4590039150738188`.
- WT dirty (#1145 WIP) `[S]`: prefixes L1–271 / L1–186 identical, secret-writing lines outside every hunk — a delta at one instant, not a guarantee about future patches.
- **Signatures identify inputs; they certify nothing about behaviour or safety.** No line count, sha256 or equality result here is evidence that a code path is correct or secure.
- Method: `git show`/`git grep`/`diff`/`shasum`. No repository code executed, no installed user state read, no credential read.

## 1. Writers and readers `[S]`
| # | Writer | Location | Secret | Sink | Protection in source |
|---|--------|----------|--------|------|----------------------|
| W1 | `write_installer_state()` | sh 186–257 | `registry.api_key` L245 | `${XDG_CONFIG_HOME:-$HOME/.config}/aigentry-devkit/install-state.json` | none; no `chmod` for this path (only L269, L402, L443) |
| W2 | `write_env_fanout()` | sh 259–270 | `AIGENTRY_API_KEY` L265 | `…/aigentry-devkit/env.sh` | `chmod 600` **after** the redirect closes (L269) |
| W3 | dustcraw config | sh 600–615 | `registryApiKey` L615 | `mktemp "${TMPDIR:-/tmp}/dustcraw-config.XXXXXX"` | never removed; path stored as `dustcraw.config_path` L251 |
| W4 | `Write-InstallerState` | ps1 136–173 | `api_key` L163 | `$DevkitStateFile` (`Set-Content` L172) | none (`grep -nE 'Acl\|icacls'` → 0 matches) |
| W5 | `Write-EnvFanout` | ps1 175–185 | `AIGENTRY_API_KEY` L181 | `env.ps1` L184 | none |
| W6 | dustcraw config | ps1 345–348 | `registryApiKey` L347 | `GetTempPath()/dustcraw-config-<guid>.json` | none; never removed |
| W7 | `registry_smoke_test` | sh 658–665 (L663) | key in `-H` argument | **external `curl` argv** | POSIX only |
| W8 | Phase-8 state patch | sh 920 | rewrites whole file | same as W1 | `node -e` read-modify-write, no mode control, `2>/dev/null \|\| true` |

**W8 bypasses Phase 7.** `resolve_start_phase` accepts a bare integer (sh L277–280) `[S]`, so `AIGENTRY_INSTALL_RESUME=8` sets
`START_PHASE=8`: Phase 7 is skipped and W8 (sh L920, unconditional inside the `should_run_phase 8 && component_selected
"orchestrator-role"` block) still rewrites the state file, re-serialising whatever legacy `registry.api_key` it finds. **Any
protection scoped to Phase 7 is bypassable by construction.**
**W7 on Windows**: `Invoke-RegistrySmokeTest` (ps1 187–192) `[S]` passes the key via `-Headers` to `Invoke-RestMethod`, an in-process
cmdlet — no child process, no argv; Windows is unaffected. Readers `[S]` (exhaustive): `bin/aigentry-devkit.js:465`
(`.orchestrator.*`, `.components`), `skills/upsell-trigger/SKILL.md:54–58,83` (`.profile`), `tests/orchestrator-profile.test.js:286,331,360`.
A sweep of 22 local `aigentry-*` repos found no consumer of the key `[S]`; neither installer reads back its own `env.sh`/`env.ps1` `[S]`.

## 2. Defects
- **D1** `[S]` No mode/ACL is set on `install-state.json` by W1/W4/W8 — protection is whatever the umask or inherited ACL gives: sometimes adequate, never controlled.
- **D2** `[S]` W2 creates `env.sh` then narrows it (L268 → L269). `[I]` readable in between; interval not measured, no exploit shown.
- **D3** `[S]` W2 emits bash-only `printf %q` into a `#!/bin/sh` file; W5 interpolates the raw key into a PS single-quoted literal, so an embedded `'` terminates it — `[I]` injection into a file users are told to source.
- **D4** `[S]` No ACL anywhere in `install.ps1`. **D5** `[S]` W3/W6 leave a plaintext temp config and advertise its path.
- **D6** `[S]` POSIX `curl` receives the key in argv. **D7** `[S]` No writer is atomic; truncate-in-place keeps a prior mode.
- **D8** `[S]` No symlink or ancestor check precedes any write. **D9** `[S]` No mutual exclusion between concurrent writers.

## 3. Contract `[P]`
### 3.1 No-secret state, with a redaction rule that deletes no user data
`env.sh`/`env.ps1` remain the only sink for the key. The state document keeps `registry.mode`/`registry.api_url`, drops `api_key`, and
gains `api_key_source: "env-file" | "none"`. **Every** state writer — W1, W4 **and W8** — goes through the same module; W8 is otherwise
a second uncontrolled writer re-serialising legacy plaintext.
"Preserve every unknown key" and "no secret under any key" conflict; r2 asserted both. Three disjoint classes resolve it: (1) **owned
secret path** `registry.api_key` — removed; (2) **unknown keys** — preserved **semantically** (deep-equal across the round trip), never
deleted or rewritten; (3) **unknown key whose value matches a high-confidence secret shape** — the migration **aborts and writes
nothing**, naming the JSON path, never the value. Neither silent deletion of user data nor knowingly re-serialising a foreign secret is
permitted. The invariant is therefore precise: **this installer writes no secret into the state file and refuses to rewrite one that
appears to carry a foreign secret** — not a claim that the file is secret-free.

### 3.2 Storage — per-file protection; parent validated, never modified
- POSIX: create `O_CREAT|O_EXCL|O_NOFOLLOW` mode 0600, so the mode exists at creation. The parent is 0700 when the installer creates it; an **existing** parent is validated (§3.4), never re-chmodded.
- Windows: create the temp **empty**, apply an explicit file ACL (inheritance disabled, single ACE = current user, FullControl),
  **then** write the secret bytes — no byte reaches an object without its final ACL, and **no directory ACL is touched**. r2's blanket
  parent reset is withdrawn: it can revoke access other tools legitimately hold. If the file ACL cannot be applied, abort. Should the
  parent itself prove untrustworthy, the answer is a new secret-only child directory with its own ACL — never resetting an existing one.
- "0600" is POSIX terminology with no Windows meaning; each platform's requirement is stated in its own terms. Quoting on write: POSIX `export NAME='…'` with `'` → `'\''`; PowerShell `'…'` with `'` doubled. Neither ever emits `$'…'`.

### 3.3 Atomic replace, and the failure invariants it does not provide
Temp in the destination directory → write → `fsync` → `rename`. `rename(2)` does not follow a destination symlink; it replaces the entry.
**It is atomic per file only** — the secret file and the state file are two objects with no joint transaction. Ordering makes the
interrupted states safe, each named rather than assumed away: **1** acquire the lock (§3.5); **2** read legacy state, hold any extracted
key in memory; **3** write the secret file atomically; **4** write the sanitised state file atomically; **5** release.
- Crash between 3 and 4 → the secret is stored **and** the legacy state still holds the plaintext: not a regression (it was already
  there), re-running completes the migration, the key is never lost, and nothing has yet claimed it was removed. `api_key_source` is a
  property of the state document itself, so it cannot assert "stored elsewhere" for a file that was not written. **No step asserts "no
  secret present" until the state file has actually been rewritten.** A crash before 3 changes nothing; migration is idempotent and
  re-running is always the recovery path.

### 3.4 Symlink behaviour, ancestor validation, and one unresolved contract
Ordered contract: **(1)** a destination that is itself a symlink → **abort** (replacing it destroys a user object and signals
tampering), so rename is only ever reached for a non-symlink destination and r2's abort-vs-rename conflict is gone; **(2)** create the
temp `O_CREAT|O_EXCL|O_NOFOLLOW` with §3.2's mode/ACL, `fstat` the descriptor to confirm owner and mode, write, `fsync`, `rename`;
**(3)** best-effort ancestor validation first — no component is a symlink (POSIX) or reparse point/junction (Windows), each owned by
the effective user or root, none group- or other-writable — **failing closed** when it does not hold.

**Realizable primitives, named** — the handle-bound steps that genuinely bind protection to the object held: mode at creation via the
`mode` argument of `fs.openSync(path, O_CREAT|O_EXCL|O_NOFOLLOW|O_WRONLY, 0o600)`; verification via `fs.fstatSync(fd)`;
`fs.fchmodSync`/`fs.fchownSync` where needed; on Windows the ACL applied to the **open `FileStream`** via
`FileSystemAclExtensions.SetAccessControl(FileStream, FileSecurity)` `[I]`, not to a path, before any secret byte is written. Object
identity is compared by `fstat` `dev`+`ino` (POSIX) or `GetFileInformationByHandle` volume-serial + file-id (Windows) `[I]`, **never by
path string**. The coder verifies these surfaces on the pinned runtimes — they are documented, not measured here.

**What has no realizable primitive.** Every *namespace* operation stays path-based — create-by-name and `rename`. Node core exposes no
`openat`/`renameat`/`mkdirat` and no `dir_fd` option, and PowerShell/.NET expose no directory-handle-relative create or rename `[I]`;
`O_NOFOLLOW` constrains only the final component, never an ancestor. **A prior check on an opened parent descriptor therefore does not
constrain the later path-based create or rename — the kernel re-resolves the whole path.** r3 sequenced an `fstat`-verified parent open
before path-based calls and left the impression that this closed the gap; that implication is withdrawn. No descriptor-relative API is
invented here, and no race elimination is asserted from a prior check.

**Path aliasing defeats string-level validation** `[I]`: Windows 8.3 short names, `\\?\`/`\\.\`/UNC prefixes, alternate data streams,
case-insensitivity, trailing dots and spaces; macOS case-insensitive volumes and `/var`→`/private/var`; Linux bind mounts and
`/proc/self/fd`. Two strings can name one object; one string can name two objects over time. **Validation limits**: it cannot see an
ancestor replaced after the check, an alias reaching the same directory by another path, permissions or ACL inheritance changed after
the check, or anything on a filesystem lacking the queried attribute. It detects **misconfiguration and accidental symlinks — the
common real case — not a concurrent adversary.**

**Unresolved contract C-B, isolated.** Adversarial ancestor replacement between validation and the path-based create/rename has **no
bounded portable mitigation** under Article 17: the only real primitives are `openat`/`renameat`, absent from both runtimes. This SPEC
does not claim resistance to it, does not ask anyone to waive it, and **authorises no fix for it** — it carries an N1
negative-test-only handoff (§7.1). Everything else in §3 — mode/ACL at creation, atomicity, quoting, locking, migration, cleanup, W8 —
is contract **C-A**, independently implementable because none of it depends on C-B.

### 3.5 Lock protocol — every state writer, not one phase
Scoping the lock to Phase 7 (r2) leaves W8 and `resume=8` unserialised. Corrected: **every** state-file writer and the migration
acquire the same lock around read-modify-write, W8 included, and every one of them applies §3.1 sanitisation.
- Acquire: `O_EXCL` create of `install-state.lock` beside the state file, holding pid, an ISO-8601 UTC timestamp and a random token.
- Contention: bounded retry with backoff, then **fail closed** naming the lock path. Never block indefinitely.
- **Never steal a live lock, remove another process's lock, or inspect or signal a PID.** A crash leaves a stale lock, the next run fails
  closed, and a human removes it deliberately — no automatic staleness heuristic is safe. Release: unlink on success and error paths.
  `ponytail:` an advisory lock file is the cheapest correct answer; a crash-surviving recovery journal is #1147's problem, not this task's.

## 4. Legacy migration `[P]`
1. Under the lock, parse the existing state file. If `registry.api_key` is a non-empty string and no key is otherwise available, seed the secret file (§3.2–3.4) from it, then rewrite the state per §3.1.
2. **Never `source`/dot-source a legacy `env.sh`/`env.ps1`** — that executes attacker-controlled shell, which is D3 itself. Parse
   line-oriented assignments only, handling every form the shipped writers can produce: POSIX `'…'` with `'\''`; PowerShell `'…'` with
   `''`; unquoted words; and **bash `%q`, which for a value with control characters emits ANSI-C `$'…'`** `[I]`. `$'…'` is **rejected
   as un-migratable**, not decoded — hand-rolling an escape decoder for a credential is worse than asking for re-entry. Empty and
   absent are distinguished (absent → no legacy key; empty → no key, not an error).
3. **Fail closed on anything unparseable**: abort naming the variable and the reason — never the value, never a fragment, never at a log level that persists the line.
4. **Precedence**, first hit wins, never merged: process environment > existing secret file > legacy state JSON > legacy env file.
5. `dustcraw.config_path` is **left alone** — the legacy file is untrusted input, so deleting a path read from it is attacker-directed
   file deletion. A bounded warning names the path, **sanitised for display**: C0/C1 controls, `ESC`, `CR` and newlines escaped, length
   truncated, value quoted — an unsanitised path can rewrite the terminal. No file is deleted.
6. Rotation wording: the earlier file **may have been** readable by other local users, so the key **should be treated as possibly exposed** and rotated; disclosure is not proven.
7. **No `.bak`, no rollback copy** — a backup is itself a plaintext copy. Rollback is "re-run the installer" (§3.3 idempotence).

## 5. Platforms `[P]` — no coverage substitutions
Rows each needing their own verification: macOS (Darwin), Linux glibc, Linux musl, WSL2, Windows PowerShell 5.1, Windows PowerShell 7.
**WSL2 does not inherit Linux coverage; musl does not inherit glibc coverage.** Musl and WSL2 may instead be declared unsupported.
MSYS/MinGW/Cygwin: `install.sh` warns and defers to `install.ps1` (sh L309–312) `[S]` — out of scope; §3.4 fail-closed applies.
`.github/workflows/ci.yml` **declares** `matrix.os = [ubuntu-latest, macos-latest, windows-latest]` × node 18/20/22 `[S]`, with the single
step `node bin/aigentry-devkit.js --help`. That is a **configured** matrix — whether those runners are actually available, whether the
workflow executes, and its permissions or minutes are **unverified** `[A]`. r2 read the YAML as proof of Windows capacity; withdrawn,
and confirming it is a CI-operations task, not an architect claim.

## 6. Verification gate `[P]`
**Phase 7 is not isolable** `[S]`: `header "Phase 0. Prerequisites"` (sh L302, ps1 L209) sits outside every `should_run_phase` guard and
runs at any resume value — on POSIX with tmux absent it attempts `brew install tmux` or `sudo apt-get update && sudo apt-get install -y
tmux` (sh L315–350). The trailing block (sh L924–951, ps1 L430–453) is likewise ungated and runs `telepty --version`.
**A PATH allowlist is detection, not containment** — it cannot stop absolute-path execution, direct syscalls or Unix-socket connects. Two
sanctioned substrates, no fallback: **G-A**, a disposable VM/container for the target OS row with no host bind-mounts, sockets,
credentials or network, where the real installer runs end-to-end and the machine is destroyed — the only substrate in which the ungated
blocks may execute; and **G-B**, a narrowly audited seam invoking the writers directly, needing the seam to exist plus an audit that it
behaves as in-script — good for iteration, **not** the end-to-end proof. Absent both, **the gate does not run**; no live-machine install
is an acceptable fallback under any schedule pressure.

**Falsification, corrected.** D1's defect is that the mode is not *controlled*, not that it is bad: under a restrictive umask the legacy
file may already be 0600, and a gate failing that case would be wrong. The valid falsifier is the **`umask 022` / `umask 000` pair
showing the resulting mode tracks the umask**; a genuinely protected pre-existing legacy file must pass. D2's defect is ordering, which
the umask pair cannot see — `chmod 600` (L269) forces 600 either way `[S]`, so old code passes. Only observation of the creation boundary
falsifies D2, and **that instrument is per-OS**: Linux `strace`; Windows ETW/Process Monitor file events; macOS `fs_usage` or Endpoint
Security, both privileged. A Linux trace is Linux evidence only. **Where no boundary observation is achievable on a row, that row's D2
evidence is weaker and must be labelled so, never asserted.**

**Required cases beyond D1/D2**: destination symlink → abort; unsafe ancestor → fail closed; concurrent writer → lock refusal; stale lock
→ fail closed, nothing stolen; W8 via `resume=8` takes the lock and sanitises; quoting round-trip for POSIX, PowerShell, unquoted and
`$'…'`-rejection, plus embedded newline, empty and absent; unparseable legacy → abort with no value logged; foreign secret at an unknown
key → abort with nothing deleted; unknown keys preserved deep-equal; migration idempotent; crash between secret-write and state-write
leaves either state but never a false no-secret claim; temp cleanup on success, failure and interruption; sanitised display of a
control-character path; per-OS mode/ACL assertion. Dummy secret — an obviously fake literal exercising D3:
``sk-DUMMY-1142-a'b"c$d`e\f``, never a real key. Evidence under `state/evidence/1142/<UTC>/`: substrate identity and teardown proof;
command line; environment with the dummy redacted; stdout/stderr/exit code; per-artifact mode/ACL and sha256; file inventory;
boundary-observation output; sandbox-wide grep.

### 6.1 Secret-lifetime invariants — installer-owned artifacts, per operation
Every guarantee is scoped to **artifacts this installer owns and writes in this operation** — the state file, the secret file, and temps
this process created — never to the whole filesystem. §4.5 **deliberately preserves** legacy artifacts that may still contain the key, so
a global "the key exists in exactly one file" claim is false by construction; r2 and r3 both overreached, and both are corrected here.
- **Fresh install** (no pre-existing state, secret or legacy temp): after exit 0 having run Phase 7 the key is in the secret file and in no other installer-owned artifact — the strongest case, and still so scoped.
- **Migration** (legacy artifacts present): the key is in the secret file and the state file no longer carries it, while **preserved legacy
  artifacts may still contain it, deliberately**. Acceptance asserts the warning was emitted and sanitised and the file was **not**
  deleted; it must **not** assert the key is absent from disk — removing those files is the user's decision, informed by the warning.
- **Intermediate** (Phase 5 → Phase 7): the key may exist in the process's own temp, protected per §3.2. The secret file not existing yet is not a violation.
- **Interruption**: §3.3's crash states apply verbatim — after a crash between the secret write and the state write the state file still
  holds the plaintext **by design**, so acceptance checks that case for its *expected content*, never for absence. The installer removes
  its own temp on success and failure paths using the path held in a shell/PS variable, never re-read from JSON; under an uncatchable
  signal that temp can survive, so the invariant is "at most the installer-owned artifacts enumerated for the phase reached" — acknowledged, not claimed impossible.
- Cleanup is justified by the installer owning the file it created, never by what a consumer does with it. `[S]` at `aigentry-dustcraw`
  HEAD `c0af3c93` `cmdInit` reads `--config` once (`dustcrawCli.ts:454–463`) and `registryApiKey` appears only in a comment (L535) —
  **one local revision, not evidence about the shipped runtime** `[A]`; nothing here depends on it.

## 7. Work units `[P]` — negative evidence precedes the fix
**N1** *coder* — author the gate: G-A substrate, per-OS boundary instrumentation, the §6 case list, fixtures; no production change.
**N2** *tester* — execute N1 against unmodified `bb7876b`; must fail for D1 and D2 for the stated reasons; evidence retained.
**U1** *coder* — shared Node module: schema, §3.1 classification, §3.3 ordering, §3.4 validation, §3.5 lock, §4 parsers. **U2** *coder* —
`install.sh`: W1, W2, W3 cleanup, W7 key off argv, **and W8**. **U3** *coder* — `install.ps1`: W4, W5, W6 with per-file ACL.
**U4** *tester* — gate against the fix on every §5 row required. **U5** *tester* — existing suites vs. the #1143 baseline.
**U6** *builder* — `bash -n`, PowerShell parse check; **builder runs no tests**. **U7** *coder* — `snyk_code_scan`, fix, rescan to zero
new findings before DONE. Edges: `N1 → N2 → U1 → {U2,U3} → {U4,U5} → U6 → U7`; `U2 ∥ U3`. **N2 gates U1.**

### 7.1 N1 handoff — negative diagnostics only, no fix authorised
- **Artifact**: exactly one new file, `tests/secret-state/v1/negative-gate.mjs`, owned solely by N1. No other repository file is created
  or modified — not `package.json`, not CI config, not the installers. It is a standalone diagnostic script, not a wired-up suite
  (#1143 owns runner/CI wiring).
- **First substrate**: Linux glibc in a rootless container from a **digest-pinned** `node:20-bookworm-slim`, `--network none`, no bind
  mounts, no host sockets or credentials, non-root user, `strace` present in the image, destroyed after the run. Chosen because it is the
  one row where the D2 creation-boundary instrument is reproducible and cheap. **This is a diagnostic row, not release coverage** — it
  certifies no platform, and §5's matrix remains unapproved (§9 P-3).
- **Scope**: reproduce D1 (state-file mode tracks umask across the `022`/`000` pair) and D2 (a `chmod` follows a create whose mode is
  not 0600, in the strace of the exact production path), plus a **C-B demonstration** showing that ancestor replacement between
  validation and the path-based create/rename is observable. C-B is demonstrated, **not fixed**; this handoff authorises no production
  change for any contract.
- **Evidence** under `state/evidence/1142/<UTC>/`: image digest; container id and the `--network none` invocation; full argv; env with
  the dummy redacted; stdout, stderr and exit codes; `stat -c '%a %U %G %n'` and sha256 per artifact; the strace log filtered to the
  target paths; a sandbox-wide grep for the dummy; teardown proof.
- **Boundary**: N1 authors, N2 executes — a coder-run result is not accepted. U1–U3 stay unauthorised until N2's evidence exists.

**Runner coverage** `[S]`: `npm test` = `node bin/aigentry-devkit.js --help`, running no test file; four `test:*` scripts exist, nine
further suites have none. **Baseline already red** `[X]` (#1143 report, same `bb7876b`): `scaffold-install-hooks`,
`orchestrator-profile`, `open-session-codex-flag` FAIL, `wtm-test-lock` BLOCKED — so U5's criterion is **no new failure vs. that
baseline**. #1143 owns runner/CI wiring, #748 the version regex; this task fixes neither.

## 8. Coordination and architect-resolved items
Exported invariant only: **this installer writes no secret into `install-state.json`**, unknown keys are preserved semantically, and a
suspected foreign secret aborts rather than being rewritten (§3.1). Every writer shares the §3.5 lock. Schema ownership across
#1142/#1145/#1147 is an orchestrator question; no storage or journal design is prescribed for #1147.
**Resolved here, no longer user decisions**: shared-module boundary (Node module for schema/migration/atomic write, native per-file
ACL in PowerShell); legacy `dustcraw.config_path` → warn-and-leave, sanitised, never deleted; rotation wording → "possibly exposed";
gate substrate → containment or no run; W8 → same module, lock and sanitisation; parent-substitution race → validated directory or
fail closed, nothing pre-accepted; Windows parent ACL → never reset, per-file ACL before any secret byte.

## 9. Policy status
- **P-1 compatibility — APPROVED**: `registry.api_key` is **removed** from the state schema. The residual risk to unmeasured external
  keyed-mode readers is accepted by that decision and recorded here `[A]`, not re-litigated.
- **P-2 storage — APPROVED**: the key is stored on the existing protected `env.sh`/`env.ps1` surface. No keychain, no new dependency.
  P-1 and P-2 are settled; this SPEC does not raise them again.
- **P-3 release matrix and publication — NOT APPROVED, deferred.** §5 remains a requirements list, not a shipping commitment: no row is
  certified by this SPEC, and §7.1's first substrate is diagnostic only.

## 10. Acceptance criteria `[P]`
1. N2 ran on unmodified `bb7876b` in G-A/G-B and failed for D1 (mode tracks umask) and D2 (chmod after create) on each row where the boundary instrument exists; rows without one are labelled weaker, never passed by assertion.
2. A pre-existing legacy file already protected by a restrictive umask does **not** fail the gate.
3. After a fix is authorised, the gate passes on every §5 row later approved under P-3, including the full §6 case list. Unapproved rows are not claimed.
4. §6.1's invariants hold **as scoped to installer-owned artifacts**, each case asserting its own distinct condition. **No criterion
   asserts global absence of the key from disk** while §4.5 preserves legacy artifacts; the migration case asserts the sanitised warning and non-deletion instead.
5. `install-state.json` carries no substring of the dummy secret from W1, W4 **or W8**, including a `resume=8` run.
6. Migration removes only `registry.api_key`; unknown keys survive deep-equal; a planted foreign secret aborts with nothing deleted; an unparseable legacy value aborts with no value in any output.
7. A second concurrent writer is refused by the lock; a stale lock fails closed without being stolen or a PID signalled.
8. No new suite failure vs. the #1143 `bb7876b` baseline; `bash -n` and the PowerShell parse check clean; Snyk zero new findings.
9. C-B (§3.4) is **demonstrated** by N1 and remains unfixed; no criterion claims resistance to adversarial ancestor replacement.

## 11. Revision history, and still unmeasured
**r4**: §6.1 rescoped to installer-owned artifacts per operation, with distinct fresh-install / migration / intermediate / interruption
acceptance — no global one-file claim while §4.5 preserves legacy artifacts; §3.4 names the handle-bound primitives it can actually use,
states that create-by-name and `rename` remain path-based with no `openat`/`renameat` in either runtime, withdraws r3's implication that
a verified parent descriptor constrains them, records path-aliasing and validation limits, and isolates **C-B** as unresolved with no
fix authorised; §7.1 adds the one-file N1 handoff; §9 records the approved storage policy.
**r3** resolved five r2 contradictions: lock scope moved to every state writer including W8/`resume=8`; symlink abort and rename
reconciled, the parent-substitution race no longer pre-accepted, Windows parent-ACL reset replaced by a per-file ACL; unknown-key
preservation split into three disjoint classes; per-phase invariants; `windows-latest` relabelled configured-not-available, per-OS
boundary instruments, the D1 test corrected, signatures declared non-certifying.
**Still unmeasured, not claimed**: external readers of `registry.api_key`; the shipped `aigentry-dustcraw` runtime; actual CI runner
availability; any runtime mode, umask outcome, race interval or process visibility; the user's installed state (nothing under
`~/.config/aigentry-devkit` was read); and whether `bb7876b` is the integration base — it is the repro/spec reference, #593 still open.
