# Dispatch capacity — configuring per-CLI worker quotas

How `dispatch` decides whether a provider CLI is allowed to take another
auto-routed worker, and how to configure that with
`AIGENTRY_CLI_CAP_<CLI>`.

Since #1148 there is **no implicit worker count cap**. A quota exists only
where an operator sets one. This page documents the knob's semantics and how
to measure a value for your own host; it deliberately does **not** recommend a
worker count.

## The knob

```
AIGENTRY_CLI_CAP_<CLI>=<count|unlimited>
```

`<CLI>` is the upper-cased CLI name as dispatch classifies it — `CLAUDE`,
`CODEX`, `GROK`, `GEMINI`. For example:

```bash
export AIGENTRY_CLI_CAP_CODEX=4      # auto-route at most 4 concurrent codex workers
export AIGENTRY_CLI_CAP_CLAUDE=unlimited
```

The quota is a **count of live sessions**, not a rate, a memory budget or a
provider-side limit.

## Values

| value | meaning |
|---|---|
| unset / absent | **no cap** |
| empty (`""`) | **no cap** |
| whitespace only (`" "`, `"\t"`) | **no cap** |
| `unlimited` (any casing, surrounding whitespace ignored) | **no cap** |
| a finite number (`0`, `3`, `8`, `2.5`, `1e1`) | **cap at that number** |
| anything else (`abc`, `null`, `2.5.1`, `one`, `12abc`, `Infinity`) | **no cap**, warned once |

The value is trimmed before it is interpreted, so `"  unlimited  "` and
`" 4 "` both work.

### No implicit ceiling

Absent, empty and whitespace-only all mean *the operator did not configure a
quota*, and dispatch applies none. Before #1148 a built-in table capped
`codex` at 2 and `claude` at 4 even on hosts that had never set the knob, so
the 5th concurrent claude worker was silently auto-routed to a different
provider. That table is gone. A host that sets nothing now gets no count
ceiling from dispatch at all.

`unlimited` is the explicit way to lift a quota that an **inherited**
environment still sets, without having to unset the variable — useful when a
parent process or profile exports `AIGENTRY_CLI_CAP_CODEX` and you cannot edit
it.

### Finite numbers keep their old meaning

A finite number is an explicit opt-in and behaves exactly as it did before
#1148. Dispatch caps when `live >= quota`.

- `0` means **never auto-route to this CLI**, even with zero live sessions.
- Negative values (`-1`) are finite numbers, so they also cap unconditionally
  and behave like `0`. This is unchanged legacy behaviour and is *not* a
  spelling of "unlimited" — use `unlimited` for that.
- Non-integer values (`2.5`, `1e1`) are accepted and compared numerically;
  `2.5` first caps at 3 live sessions. Prefer whole numbers.

### Malformed values never become a quota

A value that is neither a finite number nor `unlimited` is a typo, not a
limit. Dispatch applies **no ceiling** and emits one warning per knob per run:

```
dispatch.sh: WARNING AIGENTRY_CLI_CAP_CODEX is set to an invalid value (not a count, not 'unlimited'); ignored, no cap applied
```

The warning **names the knob but never echoes its value**. An environment
value is untrusted input and this stream is an operator terminal and a log, so
a mis-set secret is not replayed and a terminal escape or embedded newline
cannot rewrite the terminal or forge a log line. To see what the variable
actually holds, inspect it yourself.

Note that `Infinity` is **not** a recognised token — it takes the malformed
path. The outcome is the one you probably wanted (no ceiling), but it warns,
because the supported literal is `unlimited`.

## When the cap is consulted

The quota governs **automatic routing on a fresh spawn only**.

- **Auto-routed spawn.** A routed CLI that is at its quota falls through to
  the next candidate the router offered; the audited decision records
  `decided_by: "<original>-capped"` and `capped_cli: "<the capped CLI>"`.
- **Explicit `--cli <name>`.** Your choice is honoured. Dispatch warns once
  and spawns the CLI anyway; the decision stays `decided_by: "explicit"` and
  is not marked capped. This is unchanged.
- **Existing target (`--target <sid>`).** Exempt. Delivering to a session that
  is already running creates no new worker, so no quota applies at any live
  count.

## Measuring a value for your host

There is no recommended or default worker count — the right number depends on
your hardware, your workload and your provider plan, and dispatch cannot
observe any of those. Measure, then opt in:

1. **Establish the live count source.** Dispatch counts live sessions from the
   session inventory (`telepty list --json`), classifying each row by its command —
   a bare provider CLI, or a guard launcher's `exec -a <cli>` line. Rows that
   are neither (for example a plain `bash`) count toward nothing.
2. **Run your real workload** with no quota set, increasing concurrency step
   by step.
3. **Watch the host**, not dispatch: memory and swap pressure, CPU saturation,
   file-descriptor limits, and whether your provider starts returning
   rate-limit or capacity errors.
4. **Set the knob just below the first level that degraded**, for that CLI
   only. Leave the other CLIs unset.

Re-measure after a hardware, plan or model change. A quota that was right for
one machine is not evidence about another.

## What this knob is not

Removing the implicit ceiling removed a guess; it did not add a scheduler.
Specifically, `AIGENTRY_CLI_CAP_<CLI>`:

- is **not a resource scheduler** — it does not observe or reserve CPU,
  memory, file descriptors or disk, and it does not queue, throttle or defer
  work that exceeds the quota;
- is **not permission enforcement** — it is an operator convenience for
  routing, not a security control, and it does not restrict what a worker may
  do;
- does **not activate or install** anything, and says nothing about whether a
  given CLI is installed or usable on this host;
- makes **no claim about provider quota**. No cap in dispatch does not mean
  your provider will accept unlimited concurrent sessions; provider-side rate
  and concurrency limits are enforced by the provider and are unaffected by
  this setting;
- carries **no implicit ceiling to fall back on**. If you want a limit, set
  one — unset means unlimited as far as dispatch is concerned, and the host is
  then the only thing bounding concurrency.

## Declared worker inputs (#1172)

`bin/worker-inputs.mjs` stages the exact files a worker or a bounded retest
needs from an explicit plan (`{"version":1,"files":[{path,sha256,mode}],
"tests":[...]}`), so a missing input fails at staging instead of minutes into
a test run. Run it locally with `node`; `--help` documents the schema:

```bash
node bin/worker-inputs.mjs stage  --source REPO --plan plan.json --dest SNAP   # SNAP must not exist
node bin/worker-inputs.mjs verify --root SNAP/repo --manifest SNAP/manifest.json --sha256 <manifestSha256>
node bin/worker-inputs.mjs test   --root SNAP/repo --manifest SNAP/manifest.json --sha256 <manifestSha256>
```

`test` runs only the plan's listed `.test.mjs`/`.test.js` files with
`node --test` and exits with their status — never the whole suite, never a
retry, and nothing is compiled. Passing the same triple to dispatch as
`--input-root/--input-manifest/--input-sha256` verifies the snapshot before any
routing or spawn. Coverage is `declared-inputs-only`: a hand-written plan does
not prove it lists every dependency, and a verify is a point-in-time check,
not a lock or a permission. Symlinks are refused for the snapshot/source root
itself and for every directory and file inside it; the root's host ancestors
(for example macOS `/var` -> `/private/var`) resolve normally and are not
confined by this check. On Windows the snapshot's read-only POSIX modes are
not observable, so the mode check reports `skipped-win32`.

## Confined Claude worker authentication (#652, #1232)

A confined Claude worker authenticates **only** with an automation token that
you mint and supply yourself. Dispatch's confined path never copies your own
interactive Claude login (`~/.claude/.credentials.json` or the macOS Keychain
item) into a worker.

### Breaking change

Before #1232, when `AIGENTRY_CLAUDE_OAUTH_TOKEN` was unset or empty, every
confined Claude spawn silently copied the host's interactive login record,
including its refresh token, into the worker's private home. Every worker then
held its own copy of that one interactive lineage. That fallback is gone. Without
the opt-in, a confined Claude spawn now refuses:

```
dispatch.sh: SANDBOX_AUTH_WORKER_TOKEN_REQUIRED: confined Claude workers authenticate only with an approved automation token (claude setup-token) supplied as AIGENTRY_CLAUDE_OAUTH_TOKEN in the dispatcher environment; the host login is never copied; see docs/setup/dispatch-capacity.md; nothing was spawned (exit 78)
```

The refusal comes after routing and the spawn decision have been made and
before anything is staged. No boot preparation runs, no git guard is
installed, no terminal opens and no sandbox is prepared. The message names the
variable and never echoes a value.

The library entry point (`prepareWorkerSandbox`) refuses with the same fixed
code before any staging write.

Not changed by this:

- **Codex and Gemini workers.** No change.
- **`--target` delivery** to a session that is already running. No change.
- **The legacy unconfined boot path.** No change.
- **Routing.** Automatic routing counts Claude as available in three cases:
  - the opt-in variable is set;
  - the host is macOS (always, whether or not anyone is logged in);
  - `~/.claude/.credentials.json` exists.

  That selection logic is unchanged. An automatically routed spawn can
  therefore still choose Claude and then stop with the refusal above, before
  anything is spawned. It is not silently re-routed to another provider or
  billing path.
- **Workers already running.** They keep whatever they were started with.
  Nothing is restarted or cleaned up.

### Supported path

1. **Mint the token yourself.** In your own terminal, run `claude setup-token`
   and complete the browser authorization. Never paste the value into a chat,
   an agent prompt, a report, a dispatch file, or a command whose output is
   captured.
2. **Store it where you choose.** Use a secret store of your choice. Aigentry
   adds no token storage.
3. **Export it to the dispatcher.** Set it as `AIGENTRY_CLAUDE_OAUTH_TOKEN` in
   the environment that launches the orchestrator/dispatcher. A process reads
   its environment once, at start, so an orchestrator that is already running
   needs a restart that you initiate.

For each confined Claude attempt, dispatch checks the value's syntax and then
writes it to a private handoff file outside the worker's home. The runner
places it only in the worker child's environment, as `CLAUDE_CODE_OAUTH_TOKEN`.
It never enters the sealed manifest, the argv or the launcher. When the runner
relaunches the worker, it re-reads the same per-attempt handoff.

**Known limitation (follow-up).** A non-empty value that fails the syntax check
is not refused up front with exit 78. It is refused later, during sandbox
preparation, with `CLAUDE_OAUTH_TOKEN_INVALID`. By then boot staging and the git
guard have already run. The value is never echoed.

### Official references

Anthropic's current documentation:

- authentication and `claude setup-token`:
  <https://code.claude.com/docs/en/iam>
- Claude Code environment variables:
  <https://code.claude.com/docs/en/env-vars>

Those pages, not this one, describe the token and how the CLI reads its
environment. Nothing in this repository has measured what the *installed*
Claude CLI actually does with a setup token. Its acceptance, its lifetime and
which account features it lacks are all unmeasured here.

### What is and is not validated

**Validated locally:**

- one line of printable ASCII, at most 4096 bytes;
- private ownership, mode, link count, size and no symlinks on the handoff
  directory and file;
- the handoff path is the exact one sealed for the attempt;
- the token is injected into the child only.

All errors are fixed strings: `CLAUDE_OAUTH_TOKEN_INVALID`,
`CLAUDE_OAUTH_HANDOFF_WRITE`, `CLAUDE_OAUTH_HANDOFF_INVALID`,
`SANDBOX_AUTH_WORKER_TOKEN_REQUIRED`.

**Not validated:**

- provider validity;
- expiry (dispatch has no expiry information for the token);
- revocation;
- account, plan or scopes;
- whether the value really is a setup token.

Checking any of these before launch would need a provider request or a CLI
run, and dispatch does neither. So:

- **A token that is already invalid at launch** (expired, revoked or wrong)
  fails at the worker's first request.
- **A token that is valid at launch but expires or is revoked later** fails at
  the next request after that. This can happen in the middle of a task.

Nothing here guarantees that authentication lasts for any given time.

### Expiry, rotation and revocation

A setup token **can expire and can be revoked**, and dispatch cannot renew it.
The token's real lifetime has not been measured here.

When the token expires or you revoke it:

1. mint a new one;
2. update the exported variable;
3. restart the orchestrator.

New attempts use the new token. Running attempts keep the token in their
per-attempt handoff until they end, and fail at their next request once it is
no longer accepted.

Dispatch no longer copies your login into workers. Whether provider-side token
rotation or revocation caused earlier login losses has not been measured.

### Authority boundaries and residual exposure

- **Minting and storage are yours.** Aigentry does not mint, store, refresh or
  validate the token with the provider. It adds no broker, no shared auth store
  and no configuration knob.
- **The variable is visible to same-user processes.** Same-user ancestors and
  children of the dispatcher inherit it until the sandbox runner clears its own
  environment. That includes the orchestrator's own shell tool, if you launched
  the orchestrator with it.
- **The worker holds a long-lived bearer token.** It sits in the worker child's
  environment, so a worker shell can read it. Egress is configured to the
  sealed `allowedDomains`. The blast radius is larger than for a short-lived
  access token, and revocation is under your control.
- **Handoff files are retained per attempt.** Each confined Claude attempt
  keeps one private (0600) copy of the token in its attempt directory, so that
  the runner can relaunch the worker. This release has no automatic removal
  path for these files. They stay until something outside dispatch removes
  them. A retention policy is a separate follow-up.
- **The confined path never reads your login.** Dispatch's confined path does
  not read your own interactive login for a Claude worker. The legacy unconfined
  path is a different scope and is unchanged.
