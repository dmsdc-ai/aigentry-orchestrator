# aigentry-orchestrator

**The orchestration layer for the [aigentry](https://github.com/dmsdc-ai) ecosystem** — spawns AI CLI sessions, routes work between them, and persists session state.

> ⚠️ **Internal infrastructure, not a public product.** This is the control tower that coordinates aigentry sessions. It is not published to npm and has no public install path. If you want to *use* aigentry, start with the [aigentry meta-installer](https://github.com/dmsdc-ai/aigentry) or [telepty](https://github.com/dmsdc-ai/aigentry-telepty).

## What it does

- **Spawn** — opens AI CLI sessions (orchestrator + worker roles) across terminals
- **Route** — dispatches tasks to sessions and collects their reports back
- **Persist** — tracks session state and hierarchy across a run

## Dispatch capacity

Dispatch applies **no implicit worker count cap**. A per-CLI quota exists only
where an operator sets `AIGENTRY_CLI_CAP_<CLI>`; unset, empty and `unlimited`
all mean no cap.

That is a *routing* default, not a resource decision. Removing the implicit
ceiling removed a guess — it did not add admission control: nothing here
observes or reserves CPU, memory, file descriptors or disk, nothing queues or
throttles work, and it makes no claim about provider-side concurrency limits.
With no quota set, the host and your provider are the only things bounding
concurrency.

See [docs/setup/dispatch-capacity.md](docs/setup/dispatch-capacity.md) for the
knob's semantics and how to measure a value for your own host.

## Release task projection

Release admission reads the committed public task-ID projection
`release/tasks.json`, not the private task queue. See
[release/PROJECTION.md](release/PROJECTION.md) for its schema, provenance, and what
it does and does not prove.

## Capture inventory (read-only, #1166 U1)

`node bin/request-capture-inventory.mjs --root ABS [--limit N]` lists the receipts of an
existing prompt-capture store as one JSON document. Exit 0 = complete, 3 = partial or
unavailable observation, 2 = invalid invocation, module or output failure.

- **Read-only.** It never creates, locks, syncs, repairs or deletes anything. It does not
  open or hash raw blobs, so `content_hash_verified` is always `false`: the digest is the one
  the receipt claims.
- **Not a queue.** A listed item means "captured, hook outcome unrecorded". The hook can
  block a prompt after its receipt is durable, so items are never admission or execution
  authority (`hook_outcome:"unrecorded"`, `execution_state:"unknown"`). Equal prompts stay
  distinct receipts (`dedupe:"unavailable"`).
- **Bounds.** `--limit` 1..1000 (default 100); at most 4096 entries per directory; receipts
  and the marker at most 64 KiB. Any truncation, lock, residue or anomaly gives
  `complete:false`. Order is observed `received_at` then `capture_id`, not commit order.
- **Output privacy.** Only IDs, timestamps, sizes, digests and anomaly codes. No metadata
  strings, paths, file names, error messages or prompt bytes.
- **Limits.** The scan is not atomic: it detects directory drift but does not protect
  against a hostile same-owner writer. Windows ACLs are not verified, so a win32 run never
  reports `complete:true`. It has not been verified on installed builds on all three OSes.

## Scope

Orchestration infra for the aigentry ecosystem — not a standalone tool, and intentionally minimal here. Session transport is [telepty](https://github.com/dmsdc-ai/aigentry-telepty); multi-AI debate is [deliberation](https://github.com/dmsdc-ai/aigentry-deliberation); developer tooling is [devkit](https://github.com/dmsdc-ai/aigentry-devkit).

## Optional: long-lived Claude token for workers (#652)

Status: opt-in **code path only**. It is compile-checked, and an independent tester owns the fake-fixture regression. It is not configured or adopted anywhere yet, and longitudinal stability (fewer forced re-logins) is **not verified**. Treat it as a temporary mitigation, not a guarantee.

By default each Claude worker gets a copy of the host Claude login (access + refresh token). With this opt-in, Claude workers instead use a long-lived `claude setup-token` token, and the host login is never read or copied for them.

- **Selector:** `AIGENTRY_CLAUDE_OAUTH_TOKEN` in the **controller** environment (the process running dispatch / `bin/boot-prepare.mjs`). Nonempty selects it for **Claude workers only**. Codex/Gemini/Grok are unaffected.
- **Unset or empty:** the old behavior, unchanged (including any inherited `CLAUDE_CODE_OAUTH_TOKEN` on the legacy path).
- **Set but invalid** (must be one line of printable ASCII, at most 4096 bytes): the launch is refused with a fixed error. There is **no fallback** to host credentials.
- The worker receives it as `CLAUDE_CODE_OAUTH_TOKEN`. Per the official docs ([authentication: generate a long-lived token](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token), [CLI reference](https://code.claude.com/docs/en/cli-reference)), `claude setup-token` issues a one-year subscription token that covers model requests, not Remote Control or connectors. Actual expiry behavior has not been measured here.

**Setup.**
1. In your own terminal (not a worker, not a chat), run `claude setup-token` and finish the browser flow.
2. In the terminal that will run the controller, export the token without leaking it to shell history, logs or `set -x`. For example, run `read -rs AIGENTRY_CLAUDE_OAUTH_TOKEN && export AIGENTRY_CLAUDE_OAUTH_TOKEN`, then paste and press Enter. Never paste it into a chat or a task file. aigentry never writes it to a shell profile.
3. From that **same** shell, start the controller with `bin/orchestrator-boot.sh` (no arguments), or restart it this way if one is already running. The script replaces that shell with the controller bridge, so the controller inherits the exported variable. Exporting it in any other terminal cannot change a controller that is already running.
4. Dispatch **new** workers. Running workers keep their old credentials.

To stop, restart the controller via `bin/orchestrator-boot.sh` from a shell where `AIGENTRY_CLAUDE_OAUTH_TOKEN` is unset, then dispatch new workers. Expiry, rotation and revocation are yours to manage. An expired or revoked token makes workers fail to authenticate, with no host-login fallback.

**Where the token goes.**
- **Confined workers** (dispatch → `prepareWorkerSandbox` → sandbox runner): the token is written once to `<sessions>/<sid>/sandbox/<attempt>/claude-oauth/token`. The directory is 0700, the file 0600, created exclusively, with content `<token>\n`. The sealed manifest stores only that path. The runner verifies owner, mode, link count, symlink, size and content, and reads the file only for the real worker spawn, never for the preflight. The sandbox HOME gets onboarding config but no `.credentials.json`.
- **Legacy unconfined launcher** (`boot-prepare.mjs` without `--confined`): the token goes to `<sessions>/<sid>/boot/claude-oauth-<uuid>/token` with the same modes. `launcher.sh` disables xtrace, then reads the file at launch time through the same bounded Node reader, captured over an internal pipe. On any failure it exits 78; otherwise it exports `CLAUDE_CODE_OAUTH_TOKEN`. The token is never inlined into the launcher, the stdout descriptor or argv.

**Known limits.**
- **Retention:** handoff files are not deleted automatically. They stay with their session/attempt directories so a relaunch works. Delete them yourself after rotating or revoking a token.
- **Child env visibility:** the worker and everything it spawns, including its Bash tool, can read `CLAUDE_CODE_OAUTH_TOKEN`. Same-user process inspection can show it too. Because the token is long-lived, this exposure is larger than with a short-lived access token.
- **Launcher ancestors:** the controller passes its environment, including `AIGENTRY_CLAUDE_OAUTH_TOKEN`, to `boot-prepare.mjs`, `open-session.sh` and the processes they start. The confined launcher's pane binder also inherits it, and the sandbox runner holds it until it clears its own environment before sandbox init; the legacy launcher unsets it just before exec. This is same-user inheritance, not a new authority.
- **Legacy path:** it keeps the real HOME, so the host Claude login stays reachable to that CLI. Only the confined path guarantees there is no host-credential copy. At launch the legacy path also needs the built `dist/` helper and the node binary that ran boot-prepare.

## Ecosystem

The orchestrator is internal infrastructure that drives the aigentry ecosystem via telepty — it is not published to npm. The published, independently useful modules:

| Module | Package | Version | Role | Maturity |
| --- | --- | --- | --- | --- |
| **telepty** | `@dmsdc-ai/aigentry-telepty` | 0.7.1 | Cross-terminal / cross-machine prompt transport (PTY daemon) | Shipping |
| **brain** | `@dmsdc-ai/aigentry-brain` | 0.3.1 | Persistent cross-session memory (MCP server) | Early |
| **deliberation** | `@dmsdc-ai/aigentry-deliberation` | 0.0.47 | Multi-AI structured debate + synthesis (MCP server) | Early |
| **devkit** | `@dmsdc-ai/aigentry-devkit` | 0.1.14 | Installer/scaffold for the AI dev environment | Early |
| **aterm** | `@dmsdc-ai/aterm` | 0.2.14 | Terminal launcher with native session IPC | Early |
| **orchestrator** | *(unpublished)* | — | Control tower that drives sessions via telepty | Internal |

> Licenses: all MIT except `@dmsdc-ai/aterm` (UNLICENSED).

## License

MIT
