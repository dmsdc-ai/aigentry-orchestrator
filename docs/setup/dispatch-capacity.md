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
