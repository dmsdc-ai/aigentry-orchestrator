# Runtime model routing for dispatch (#1083)

Status: accepted. Profile data is owned separately by #1082.

## Decision

Fresh `dispatch.sh --spawn-and-dispatch` calls default to `--cli auto`.
After task validation and the read-only dedup check, `bin/model-router.mjs`
selects one `(cli, model)` using the profile body, a fixed rubric, the role,
and the first 4096 bytes of the task ref. The only default classifier call is:

```sh
claude -p --model claude-haiku-4-5-20251001 --output-format json --max-turns 1
```

The prompt is supplied on stdin. Direct JSON and Claude's JSON `result`
envelope are accepted. A label must appear in the profile's `models` list;
the classifier cannot supply an executable or an arbitrary model identifier.
Reason must be a nonempty string and confidence a finite number in `[0,1]`.
Task text is framed as data, and the rubric instructs the classifier not to use tools.
No new package dependencies, cache, or second-model review are introduced.

The profile is `docs/model-profiles/model-routing-profile.md`. The supported
front matter is deliberately narrow: `measured_at`, a list of inline flat
model maps, and one inline `default_table` map. The production profile is not
created by this task; tests use `tests/dispatch/fixtures/model-routing-profile.md`.

## Fallback and overrides

- A classifier timeout (15 seconds, SIGKILL), nonzero exit, invalid response,
  or disallowed label returns `default_table[role]`, then `fable-5.1`.
- A missing or invalid profile returns the fixed emergency choice
  `fable-5.1 / claude / claude-fable-5-1[1m]`. There is no second role table in code.
- Each failure emits one warning line; the router emits one JSON line and exits 0.
  Dispatch additionally bounds the router process to 16 seconds and uses the
  same emergency choice if the executable itself fails.
- A router call without `--ref` uses the table without calling a classifier.
  Dispatch retains its existing required `--ref` contract.
- An explicit CLI bypasses the router and profile entirely. Its existing model
  environment knob still applies; its audit decision is `explicit`.
- `--target` injects into the observed existing worker and never classifies.
  Deduplicated fresh attempts also do not classify again. Their decision is
  `existing`. Telepty currently reports a command, often a launcher path, but
  no model field: the audit records that command and `model=unknown`, rather
  than claiming that an inherited environment default is the worker's model.

`AIGENTRY_ROUTER_PROFILE` or router `--profile` selects another profile.
`AIGENTRY_ROUTER_CLASSIFIER` (env only; an argv form would let a command-line value
reach `spawnSync`, Snyk CWE-78) selects an executable (a path or a name on PATH),
invoked without arguments with the prompt on stdin. It is not a shell command
string. These seams allow hermetic classifier stubs.

The selected model is applied only to the spawn child through the matching
`AIGENTRY_CLAUDE_MODEL`, `AIGENTRY_CODEX_MODEL`, `AIGENTRY_GROK_MODEL`, or
`AIGENTRY_GEMINI_MODEL`. The launcher exports it because terminal hosts can
drop the initiating process's environment. Role boot preparation receives the
same child environment. Model values are shell-quoted when generating launchers.
Dispatch's environment used for telemetry and injection is not mutated.

`dispatch_start` adds `route: {label, decided_by, reason}`. The existing task
ledger writer appends `cli=<cli>/<model> by=<llm|table|explicit|existing>` to
its `dispatched … sid=… ref=… track=…` segment.

## CLI measurements and integration

Measured on this host on 2026-09-05 from `/tmp`, with a 30-second subprocess
timeout and closed stdin. These were single headless probes, not worker spawns:

| Command | Observation |
| --- | --- |
| `grok -p 'Reply exactly GROK-OK and your model id. Do not use tools.' --always-approve --output-format plain --max-turns 1 --cwd /tmp` | Exit 0 in 6.8s; `GROK-OK`, `Grok 4.6` |
| `gemini -p 'Reply exactly GEMINI-OK. Do not use tools.'` | Timed out at 30s; OAuth browser confirmation prompt |
| `agy -p 'Reply exactly AGY-OK. Do not use tools.'` | Exit 0 in 14.0s; `AGY-OK` |

`grok --version` reported 0.2.93. Its `--help` documents
`--always-approve`, `-m`, and additive `--rules`. Grok's role launcher passes
the complete staged role and session contract through `--rules`.

The `gemini` kind chooses `agy` when present on PATH, otherwise `gemini`.
`AIGENTRY_GEMINI_BINARY=agy|gemini` overrides selection. No new CLI kind is
needed, and Gemini CLI remains the fallback when Antigravity is absent.
`agy --help` exposes `--model`, `--dangerously-skip-permissions`, and
`--prompt-interactive`. Its adapter uses those flags and passes the staged
role/session contract as the initial interactive prompt. It does not claim
Gemini CLI's `GEMINI.md` or `GEMINI_CLI_HOME` isolation behavior.

`agy version` is unsupported; its adapter checks required `--help` capabilities
with a five-second timeout instead of inventing a numeric version.
`agy models` listed `gemini-3.8-flash-high` and `gemini-3.1-pro-high`, among
others. The default agy model is `gemini-3.8-flash-high`; the Gemini CLI fallback
keeps its existing `gemini-2.5-flash` default. A profile-selected model overrides
these defaults. Availability of that model on a different binary/account is
not probed by the router.

Codex's ordinary and role launchers now include `-m gpt-6-astra` by default.
Grok includes `--always-approve -m grok-4.6`. Existing boot adapters and the
direct open-session default switch are extended; workspace-host remains CLI-agnostic.

## Rejected alternatives and limits

A static role table alone cannot respond to task-specific requirements; it is
the fallback. A per-task two-model pipeline increases cost and coordination
without evidence that every dispatch needs a second call. A YAML dependency
or configuration framework would exceed the limited front-matter contract.

The expected classifier cost is one call and roughly 1–3 seconds, not a
measured latency guarantee. The hard classifier ceiling is 15 seconds.
Classification accuracy, production-profile behavior, actual Haiku response
latency, interactive Grok/agy readiness and role receipt, remote terminals,
and fallback account/model availability were not measured here. Only the
first 4KB of a task are visible to the classifier, and profile quality/staleness
directly affects its choices. Router fallback does not install a missing CLI.

Tests T138–T141 compile from `tests/dispatch/*.test.ts` into `dist/tests` for
the unchanged test runner. They exercise failure paths, label mappings,
classifier call counts, audit records, child environment, deduplication, and
generated role/plain launchers. They do not execute workers.
