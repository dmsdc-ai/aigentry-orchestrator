---
date: 2026-05-24
reviewer: aigentry-architect-phase5a-rereview (codex, round 2)
target: state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md
prior_review: docs/reports/2026-05-24-phase5-spec-codex-review.md
verdict: REJECT_AND_REVISE
---

# Phase 5a Dispatch Spec — Codex Re-Review

## Verdict

REJECT_AND_REVISE. Revision 2 is a substantial improvement: the cli.js contradiction is removed, SSH stays on the JS path, most acceptance gaps are covered, and the phase split is directionally right. It is not ready for live dispatch because one prior BLOCKER is only partially resolved and revision 2 introduces two new BLOCKERs: the standalone binary has no durable owner for the outbox drain worker, and the new G7 stdout contract contradicts several human-output subcommands.

## Pass 1 — Prior finding resolution (all 25)

### Axis A (3 findings from prior review)

- **[BLOCKER prior: cli.js contradiction]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:20`, `:26`, `:29`, `:181`, `:188-192`, `:426-433`
  - Verification: 5a is now a standalone binary only. It explicitly forbids cli.js and cross-machine.js edits, removes the old "CLI dispatches via Rust" acceptance, and defers CLI routing to Phase 5b.

- **[BLOCKER prior: SSH parity omission]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:20`, `:30`, `:70`, `:178-180`, `:192-194`
  - Verification: 5a explicitly excludes SSH, forbids a Rust SSH module, keeps `cross-machine.js` untouched, and makes `npm test` plus `test/cross-machine-ssh-routing.test.js` the regression gate. This preserves the existing JS SSH behavior verified at `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:100-289` and `/Users/duckyoungkim/projects/aigentry-telepty/test/cross-machine-ssh-routing.test.js:44-120`.

- **[CONFIRMED prior: crate boundary is right]** → **N/A (CONFIRMED carries over)**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:18-20`, `:216-240`, `:354`
  - Verification: `crates/telepty-cross-machine/` remains a cohesive telepty mechanism-layer crate; the spec still avoids premature outbox/peer-store split.

### Axis B (4 findings from prior review)

- **[MAJOR prior: Condvar wrong for tokio outbox]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:84`, `:292-297`
  - Verification: The worker now uses `tokio::sync::Notify` and `tokio::time::sleep_until`, matching the async-first direction.

- **[MAJOR prior: outbox filename/idempotency race]** → **PARTIALLY_RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:80-83`, `:94-95`
  - Verification: The final filename is now keyed by `msg_id`, and a multiprocess idempotency test is required.
  - Remaining gap: The specified algorithm uses shared `<msg_id>.json.tmp` with `create_new(true)` before rename. A second process racing while the first is writing sees tmp-exists while final does not yet exist; a crash can leave a stale tmp that blocks future same-`msg_id` enqueue. The public `inject-peer` signature also has no `--msg-id`/idempotency-key input, so the subprocess contract cannot exercise "same msg_id" idempotency without an unstated hidden API.

- **[MINOR prior: cite telepty fsync-backed atomic write]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:101-109`
  - Verification: G5 now cites and mandates the in-repo `tmp + fsync(tmp) + rename + fsync(parent_dir)` pattern, which matches `/Users/duckyoungkim/projects/aigentry-telepty/crates/telepty-supervisor-core/src/manifest.rs:117-131`.

- **[CONFIRMED prior: HTTP dependency direction]** → **N/A (CONFIRMED carries over)**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:56`, `:197`
  - Verification: The spec keeps cross-machine client-only and bans new server crates.

### Axis C (2 findings from prior review)

- **[MAJOR prior: estimate/scope unrealistic after hidden parity]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:6`, `:24-33`, `:426-435`
  - Verification: The bridge, cli.js routing, and JS deletion are split into Phase 5b. 5a is now bounded to crate + binary + packaging contract.

- **[CONFIRMED prior: narrowed HTTP steps are realistic]** → **N/A (CONFIRMED carries over)**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:58-70`, `:279-290`
  - Verification: The HTTP path remains compact and maps cleanly to the proposed Rust modules.

### Axis D (4 findings from prior review)

- **[BLOCKER prior: binary resolution/distribution undefined]** → **PARTIALLY_RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:146-174`
  - Verification: G8 now defines env override, repo-relative release/debug, PATH fallback, `ERR_BIN_NOT_FOUND`, and per-platform npm packages.
  - Remaining gap: The npm distribution contract is still under-specified for real installs: no explicit `os`/`cpu` metadata requirement for platform packages, no unsupported-platform no-op requirement for Windows, no root `files` allowlist update for a new postinstall script, and hardcoded `0.0.1` optionalDependency examples that do not match the current telepty package version at `/Users/duckyoungkim/projects/aigentry-telepty/package.json:2-3`. See NEW MAJOR below.

- **[MAJOR prior: stdout protocol fragile]** → **PARTIALLY_RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:126-144`, `:253-254`
  - Verification: G7 defines exit codes, a stdout envelope, diagnostics on stderr, and contract tests.
  - Remaining gap: The contract conflicts with `list-peers [--json]`, `outbox-status [--json]`, `tailscale-discover` human output, and clap help/version behavior. See NEW BLOCKER and NEW MAJOR below.

- **[MAJOR prior: subprocess-per-inject latency]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:20`, `:181`, `:426-433`
  - Verification: 5a does not route the CLI hot path through a subprocess. Phase 5b owns routing and explicitly calls for a latency regression test.

- **[MAJOR prior: activePeers/process-local state mismatch]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:20`, `:70`, `:188-194`, `:426-435`
  - Verification: Existing JS stateful SSH behavior remains untouched in 5a; the state migration problem is deferred to 5b.

### Axis E (5 findings from prior review)

- **[MAJOR prior: HTTP auth/token parity missing]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:60-66`
  - Verification: `connect-http --token` persists tokens, `/api/meta` is auth-gated and non-fatal, and list/inject use stored token.

- **[MAJOR prior: peers.json schema migration unspecified]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:72-79`
  - Verification: Missing `transport` defaults to SSH, HTTP operations on SSH peers return `WrongTransport`, and legacy fixture tests are required. This matches `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:13-16`.

- **[MAJOR prior: outbox no cap/operator policy]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:86-99`
  - Verification: G4 now specifies per-peer/global caps, env knobs, `outbox-status`, tracing events, and cap/status tests.

- **[MINOR prior: host parser parity tests needed]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:206`, `:236`, `:242`
  - Verification: `addressing_parse.rs` is required to mirror `host-spec.test.js`, including URL stripping, IPv6, and no-double-port cases from `/Users/duckyoungkim/projects/aigentry-telepty/test/host-spec.test.js:25-75`.

- **[MINOR prior: list --peer wording names non-existent CLI]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:65`
  - Verification: The surface is now the standalone `list-peer-sessions <peer-name>` subcommand, not a public `telepty list --peer` flag.

### Axis F (4 findings from prior review)

- **[CONFIRMED prior: telepty mechanism boundary]** → **N/A (CONFIRMED carries over)**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:410-412`
  - Verification: The ADR still assigns cross-host addressing and cross-machine peer registry to telepty at `docs/adr/2026-05-05-telepty-devkit-boundary.md:135` and `:357-364`.

- **[MINOR prior: Constitution excerpts marked verbatim are paraphrases]** → **PARTIALLY_RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:341-397`
  - Verification: Articles 1, 5, and 17 are now accurate against `/Users/duckyoungkim/projects/aigentry/docs/CONSTITUTION.md:21-30`, `:78-87`, and `:220-227`.
  - Remaining gap: Article 9 is still not verbatim. Revision 2 quotes generic independence bullets at `:370-379`, but the source Article 9 is the ecosystem-specific text at `/Users/duckyoungkim/projects/aigentry/docs/CONSTITUTION.md:125-132`. Article 13 is also labeled "verbatim" at `:382-383` while telling the coder to read the source rather than quoting `/Users/duckyoungkim/projects/aigentry/docs/CONSTITUTION.md:174-182`.

- **[CONFIRMED prior: standalone crate aligns with Article 9]** → **N/A (CONFIRMED carries over)**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:52-56`, `:380`
  - Verification: The independence gate remains a hard acceptance criterion.

- **[CONFIRMED prior: Snyk final gate]** → **N/A (CONFIRMED carries over)**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:176-181`, `:414-416`
  - Verification: Snyk remains a final hard requirement after the crate stabilizes.

### Axis G (3 findings from prior review)

- **[CONFIRMED prior: defer Tailscale auto-population]** → **N/A (CONFIRMED carries over)**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:111-125`
  - Verification: 5a only prints discovery results and does not mutate `peers.json`.

- **[MAJOR prior: Windows no-op must not regress Windows-addressed SSH peers]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:30`, `:70`, `:171`, `:178-180`, `:196`
  - Verification: Existing SSH peer records, including Windows-targeted SSH aliases, stay in JS and are protected by the SSH routing test.

- **[MINOR prior: Phase 5b handoff trigger missing]** → **RESOLVED**
  - Evidence in revision 2: `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:114-125`, `:426-435`
  - Verification: G6 defines `TailscalePeer`, forbids persistence in 5a, and the Phase 5b preview identifies the consuming bridge/CLI work.

### Resolution summary table

| Severity | Total | Resolved | Partially | Not |
|----------|-------|----------|-----------|-----|
| BLOCKER  | 3     | 2        | 1         | 0   |
| MAJOR    | 10    | 8        | 2         | 0   |
| MINOR    | 5     | 4        | 1         | 0   |

Confirmed findings: 7/7 still carry over.

## Pass 2 — New findings (revision 2 only)

### NEW BLOCKERs

- **[BLOCKER NEW] G4 defines a drain worker but 5a has no process owner for it**
  - Evidence: 5a scope is a standalone crate/binary only at `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:20`; JS bridge, cli.js, daemon.js, and cross-machine.js are all out of scope at `:188-192`; G4 requires a `tokio::sync::Notify` drain worker and backoff at `:84-85`; the proposed subcommand list has `outbox_status.rs` but no `outbox_drain.rs` or daemon/worker owner at `:224-232`.
  - Why: A one-shot CLI process exits after enqueue. Once it exits, no `Notify` receiver, retry timer, or dead-letter mover exists. Tests can instantiate a worker in-process, but production queued messages will not drain unless a later command happens to run a worker.
  - Suggested fix: Choose one lifecycle explicitly. Either add a foreground `outbox-drain --once|--watch` subcommand and acceptance tests for restart recovery, or narrow 5a to durable enqueue + `drain_once` library behavior and defer the background worker to 5b/daemon ownership.

- **[BLOCKER NEW] G7's universal stdout envelope contradicts human-output subcommands**
  - Evidence: `list-peers [--json]` is specified as a human/JSON listing at `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:68`; `outbox-status [--peer NAME] [--json]` prints status at `:91`; `tailscale-discover [--dry-run]` only prints discovered peers at `:124`; G7 then says stdout is "always exactly ONE JSON object per invocation" at `:139-144`.
  - Why: The implementer cannot satisfy both contracts. If every invocation emits an envelope, the `--json` flags and human listing language are wrong. If plain output is allowed, 5b cannot rely on the locked JSON subprocess protocol. G7 also weakens itself by allowing stdout to "MAY have partial envelope" on generic errors at `:129`, contradicting "always exactly one JSON object."
  - Suggested fix: Define two modes. Recommended: default human output for human subcommands, plus `--format envelope` or `--bridge-json` that every 5b bridge call uses. Alternatively, make every subcommand envelope-only and delete all `[--json]`/plain-print wording.

### NEW MAJORs

- **[MAJOR NEW] G4 names `msg_id` but no public API supplies it, and the tmp-file algorithm is not crash-safe**
  - Evidence: `inject-peer` accepts only `<peer-name> <sid> [--text TEXT | --stdin]` at `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:66`; G4 stores files by `<msg_id>.json` and tests same-`msg_id` multiprocess enqueue at `:81-83`, `:94-95`; the enqueue algorithm writes shared `<msg_id>.json.tmp` with `create_new(true)` at `:82`.
  - Why: Without `--msg-id` or `--idempotency-key`, external subprocess callers cannot intentionally retry the same operation idempotently. With a shared tmp path, a crashed writer can strand `<msg_id>.json.tmp` and block future attempts while no final message exists.
  - Suggested fix: Add `--msg-id <id>` to `inject-peer` or define a stable idempotency key derivation that cannot collapse distinct identical messages. Use a crash-safe reservation pattern: unique tmp name plus atomic final creation/link/lock semantics, with stale tmp cleanup rules and tests for writer crash.

- **[MAJOR NEW] G7 assigns clap help/version to exit 127, which conflicts with standard process semantics**
  - Evidence: G7 maps `2` to clap parse errors and `127` to clap help/version at `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:127-138`.
  - Why: Clap help/version normally exit successfully and print to stdout; exit 127 conventionally means command not found when a shell cannot execute a program. The current mapping will confuse 5b diagnostics and can mask binary-resolution failures.
  - Suggested fix: Keep clap parse errors as exit 2. Treat `--help`/`--version` as ordinary exit 0 outside the bridge envelope contract, or override clap explicitly and test it. Reserve binary-not-found for the JS resolver's `ERR_BIN_NOT_FOUND`, not a Rust exit code.

- **[MAJOR NEW] G8 npm packaging contract is missing the install-time details that make optionalDependencies safe**
  - Evidence: G8 lists four platform packages and root `optionalDependencies` at `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:155-174`; current telepty `package.json` has no postinstall, no optionalDependencies, and a restrictive `files` allowlist that excludes `scripts/` at `/Users/duckyoungkim/projects/aigentry-telepty/package.json:11-39`; aterm's actual platform packages declare `os`/`cpu` at `/Users/duckyoungkim/projects/aigentry-aterm/npm/aterm-darwin-arm64/package.json:13-18`, and its postinstall no-ops on unsupported platforms at `/Users/duckyoungkim/projects/aigentry-aterm/npm/aterm/scripts/postinstall.js:116-123`.
  - Why: Windows and unsupported platforms are supposed to keep using the JS path, but G8 does not require platform package `os`/`cpu` filters or an unsupported-platform no-op. If 5a adds `scripts/postinstall.js` without updating `files`, the published root package can omit the script. The example versions are hardcoded to `0.0.1` while telepty is currently `0.4.3`, unlike aterm's version-pinned optional dependency at `/Users/duckyoungkim/projects/aigentry-aterm/npm/aterm/package.json:19-20`.
  - Suggested fix: Require each platform package to include `package.json` with `os`, `cpu`, `bin`, `files`, and `publishConfig`. Require root package `files` to include the resolver/postinstall script. Require postinstall to no-op on unsupported platforms, especially Windows. Replace `0.0.1` with the current root package version or an explicit release-version placeholder, and make `scripts/test-distribution.sh` install from `npm pack` output.

### NEW MINORs

- **[MINOR NEW] `atomic_write.rs` "OR re-export" option undercuts the standalone-crate gate**
  - Evidence: G1 requires `cargo build -p telepty-cross-machine` without supervisor-core at `state/dispatch/2026-05-24-telepty-phase5a-cross-machine-rust-crate-dispatch.md:55`; the architecture says `atomic_write.rs` may copy the pattern "OR re-export if feasible" at `:238`.
  - Why: Re-exporting from supervisor-core creates exactly the crate dependency G1 is trying to avoid.
  - Suggested fix: Delete the re-export option. Copy the small fsync-backed helper or extract only in a later phase after an explicit shared-crate decision.

## Pass 2 — New finding count

| Severity | Count |
|----------|-------|
| NEW BLOCKER | 2 |
| NEW MAJOR   | 3 |
| NEW MINOR   | 1 |

## Final verdict basis

REJECT_AND_REVISE.

Top 3 fatal issues:

1. G4's outbox worker has no long-lived process owner in Phase 5a, so queued messages have no reliable production drain path.
2. G7's "always one JSON object" contract contradicts the subcommands that still promise human output and `--json` toggles.
3. The prior D1 distribution blocker is only partially fixed; G8 needs safe npm optionalDependency details for unsupported platforms and published package contents.

Recommended path: keep the 5a/5b split, but patch only the contract text. Do not rewrite the whole dispatch. Add an explicit outbox lifecycle, split human output from bridge envelope output, and tighten npm packaging requirements against the actual telepty and aterm package shapes.

## Reviewer notes

Revision 2 correctly follows the "smallest safe dispatch" direction for bridge/CLI risk, but it moved enough contract detail into 5a that the contract now needs the same rigor as code. The repeated weakness is not Rust module design; it is lifecycle and distribution semantics around a binary that is meant to be consumed later by JS. If the next revision still misses the same G7/G8 contract class, Article 5's "3회 실패 시 다른 LLM 위임" should be applied before live dispatch.
