# Booting the orchestrator: the boot wizard and the explicit boot plan

`bin/orchestrator-boot.sh` boots the control tower (orchestrator) bridge. Task #1181 added a
question in front of it: on a terminal, a bare invocation now **asks** before it acts.

This page is the contract. Everything in it was read off `--help`/`--version` output captured
once, at the versions named below; nothing was inferred from a vendor blog, a benchmark or
another provider's flags.

---

## 1. What a bare invocation does

```sh
bin/orchestrator-boot.sh          # a terminal → the wizard; no terminal → a complete plan (§3) or exit 2
bin/orchestrator-boot.sh --help   # this contract in short, plus every env var. Acts on nothing.
bin/orchestrator-boot.sh --dry-run    # the read-only half. No DELETE, no kill, no exec, no prompt.
bin/orchestrator-boot.sh --wizard-plan  # run the wizard, print the env a script can reuse.
```

`--wizard-plan` is the one mode whose **stdout is data**, and the contract has two halves:

- **on success (exit 0)** — `NAME=value` assignments and nothing else;
- **on any refusal or cancellation (non-zero)** — stdout is **empty**. The wizard screens, the
  closing `[orchestrator-boot] plan printed; …` note and *every* diagnostic (including the
  refusal for a control character in `ORCHESTRATOR_SID`) go to stderr.

So capture it, **check the exit code**, and read what you got before anything consumes it:

```sh
if bin/orchestrator-boot.sh --wizard-plan > plan.env; then
  cat plan.env          # review the assignments you just approved on the review screen
else
  rm -f plan.env        # non-zero: the capture is empty, and nothing was acted on
fi
```

Review, then reuse deliberately — commit the reviewed assignments to the caller's config, or
`set -a; . ./plan.env; set +a` once you have read the file. Do **not** pipe this straight into
`eval`: an unchecked `eval "$(…)"` runs on the failure path too, where it silently evaluates an
empty string and leaves you booting with whatever the environment already had.

`--help` and `--dry-run` are different on purpose: those *are* reports, so each keeps its whole
output on stdout in one ordered stream.

Booting still requires an **empty argv** (#934): any argument at all takes a path that cannot
`exec`. The wizard is therefore *not* a flag — it runs on the empty-argv boot path, which is
possible because the shim's boot line is a command substitution:

```sh
ORCH_BOOT_ARGV_RAW="$(node "$AIGENTRY_SHIM_JS")"
```

A command substitution captures **stdout only**. So fd 0 and fd 2 are still your terminal: the
wizard reads stdin, draws on stderr, and only the agreed argv goes to stdout, where the shell
`exec`s it. `bin/orchestrator-boot.sh` itself is unchanged.

### The steps

1. **Provider** — `claude`, `codex`, `gemini`, `grok`. Availability is decided by looking for
   an executable file on `PATH`; the provider is never run to find out. One that is missing is
   listed as unavailable and is not selectable. Nothing is installed for you, and no provider
   is ever substituted for another.
2. **Model** — the provider's own default, or one validated identifier you type. No model
   catalogue is pinned in the wizard, so nothing there claims to be "the latest", and nothing
   can promise your account may use what you name — the provider answers that at boot.
   "Provider default" means *whatever that install is configured to use*, which is **not** a
   claim that it is the newest model available. Shared fresh-model discovery and selection is
   #1148's to supply; when it lands this step calls it. It will not gain a second catalogue.
3. **Effort** — only where there is evidence (§2). Where there is none the step says so
   instead of showing a default.
4. **Permissions** — the chosen provider's **own** axes, one screen each. Claude has one
   axis (approval); codex, gemini and grok have two (approval and sandbox). Defaults are the
   most restrictive value with evidence. An elevated or bypass value is never pre-selected
   and requires typing `ACCEPT <value>` — not a `y`.
5. **History** — a **new** conversation by default. Resuming is explicit, is the provider's
   own native resume, and stays inside that provider's cwd and configuration. Native resume
   is **not** a context handoff: the provider reopens its own session, nothing is injected.
6. **Important supported options** — what the chosen provider supports, the version it was
   measured at, and the **inherited cwd** (display only — see §5).
7. **Review** — the full plan, what the boot will do, the exact argv one element per line, and
   a confirmation whose default is **no**. Only a typed `YES` boots.

**The confirmation, exactly.** The answer is compared case-insensitively against the whole
word, so it is an affirmative word that boots and nothing weaker:

| You type | Result |
|---|---|
| `YES`, `yes`, `Yes`, `yEs` | **boots** |
| Enter (nothing), `y`, `Y`, `ye`, `no` | cancels |
| `YES!`, `yes please`, or any other trailing text | cancels |
| `q`, Ctrl-C, EOF | cancels |

Every cancelling answer is identical in effect to `q`: non-zero exit, **empty stdout**, nothing
read, signalled, deleted or exec'd. The case-insensitivity is deliberate and is the documented
behaviour — it is not a bypass, because a single `y`, an abbreviation and an empty line all
still cancel, and `b` at this screen goes back rather than confirming.

`b` goes back a step. `q`, Ctrl-C and EOF cancel: the process exits non-zero with an **empty
stdout**, the shim's `set -e` aborts at the command substitution and its `exec` is never
reached. At that point nothing has been read from the daemon, nothing has been SIGKILLed,
nothing has been DELETEd, no credential has been resolved and no provider has been run —
because the plan is resolved **before** the capture validation, the registry reconcile and the
singleton guard, not after them.

---

## 2. What each provider actually supports

Measured versions: `claude 2.1.283`, `codex-cli 0.157.1`, `gemini 0.53.0`,
`grok 1.0.25 (f7e67d6988e2)`. Source: the pinned `--help`/`--version` capture for task #1181,
plus vendor pages for Grok's two unprinted value sets.

| Axis | claude | codex | gemini | grok |
|---|---|---|---|---|
| Model | `--model` | `--model` | `--model` | `--model` |
| Effort | `--effort low\|medium\|high\|xhigh\|max` | **recorded gap** — no flag | **absent** | `--reasoning-effort`, **value set not printed** |
| Approval | `--permission-mode manual\|plan\|acceptEdits\|auto\|dontAsk\|bypassPermissions` (+ `--dangerously-skip-permissions`) | `--ask-for-approval on-request\|never` (+ the combined bypass) | `--approval-mode default\|plan\|auto_edit\|yolo` | `--permission-mode default\|plan\|acceptEdits\|auto\|dontAsk\|bypassPermissions` |
| Sandbox | **none at the CLI** | `--sandbox read-only\|workspace-write\|danger-full-access` | `--sandbox` (boolean) | `--sandbox off\|workspace\|devbox\|read-only\|strict` |
| New | `claude` | `codex` | `gemini` | `grok` |
| Last | `--continue` | `resume --last` | `--resume latest` | `--continue` |
| Selected | `--resume <uuid>` | `resume <uuid\|name>` | `--resume <latest\|index>` | `--resume <uuid\|title>` |

Four consequences the implementation encodes rather than remembers:

- **Similar names are not shared policy.** Claude and grok both spell `--permission-mode` and
  print overlapping tokens. Grok's own docs define its modes differently and do not document
  that flag at all. Every value carries its own argv; there is no cross-provider mapping.
  One letter down, the same trap: `-s` is `--sandbox` on codex and `--session-id` on grok.
- **Unknown stays unknown.** Grok's effort flag takes one bounded literal you type, carried
  with an unverified-value warning. Codex's effort is a **gap**: the config-key route is not
  corroborated by this capture, so setting it is refused rather than guessed. Gemini's is
  measured absent. None of the three is filled in from claude's enum.
- **Claude has no sandbox axis.** It is not given one because three other providers have one.
- **Provenance is unverified for all four.** The staged bytes were hashed, not code-signed. No
  publisher signature was checked, and the wizard prints that word.

The registry is `src/orchestrator-boot/provider-capabilities.ts` — a frozen compile-time
literal, keyed on the executable. **Extending it is appending one entry**, with its
`measuredVersion` and per-value evidence. There is no plugin loader and no runtime override
file: a registry that could execute an operator-supplied command would put an arbitrary-exec
hole on the one script whose successor becomes your shell.

---

## 3. No terminal: the explicit boot plan

A cron job, a CI step or a supervisor cannot be prompted, so it states its choices and they
are validated **before any effect**. Opt in with `AIGENTRY_BOOT_PLAN=1` and set:

| Variable | Required | Value |
|---|---|---|
| `AIGENTRY_BOOT_PLAN` | yes | exactly `1`. Any other non-empty value is refused. |
| `ORCHESTRATOR_CLI` | yes | a registered provider: `claude`, `codex`, `gemini`, `grok`. |
| `ORCHESTRATOR_SID` | yes | the bridge id. Explicit — no silent default in a plan. |
| `AIGENTRY_BOOT_PERMISSION` | yes | `axis=value` pairs joined by `;`, one entry per axis the provider **has**. |
| `AIGENTRY_BOOT_HISTORY` | yes | `new`, `last`, or `selected=<selector>`. |
| `AIGENTRY_BOOT_MODEL` | no | a validated identifier; unset = the provider's default. |
| `AIGENTRY_BOOT_EFFORT` | no | only where there is evidence (§2); unset = the provider's default. |
| `AIGENTRY_BOOT_RISK_ACK` | only if elevated | the exact phrase the refusal prints. |

```sh
AIGENTRY_BOOT_PLAN=1 \
ORCHESTRATOR_CLI=codex ORCHESTRATOR_SID=orchestrator \
AIGENTRY_BOOT_PERMISSION='approval=on-request;sandbox=read-only' \
AIGENTRY_BOOT_HISTORY=last \
bin/orchestrator-boot.sh
```

Rules, all of them fail-closed:

- **Semicolons, not commas, and no aliases.** One deterministic spelling per field: a
  comma-joined string cannot say whether `a,b` is two axes or one value containing a comma.
- **Absent is never permissive.** A missing axis or a missing history choice is `exit 2` with
  the field named. There is no default permission, no implicit resume, and **no fallback to
  the legacy bypass argv**.
- **Every field is refused** if it contains NUL, a newline, a control character or a leading
  `-` (the argv crosses back to the shim as newline-delimited text, and a leading `-` would
  reach the provider as an option). A history selector must additionally match the provider's
  measured form and may not look like a path.
- **Elevated needs an acknowledgement.** The required phrase is derived from the selections,
  so a deployment script cannot set it once and keep authorising a later, different elevation.
- **A plan field set without `AIGENTRY_BOOT_PLAN=1` is refused**, so an explicit plan can never
  be silently ignored.

`bin/orchestrator-boot.sh --wizard-plan` prints exactly this environment after a human has
reviewed it, which is the intended way to produce one.

### What was removed, and how to migrate

Before #1181, a non-interactive boot with only `ORCHESTRATOR_CLI` set produced a hardcoded
argv:

```
claude --dangerously-skip-permissions --continue
codex resume --last --dangerously-bypass-approvals-and-sandbox
```

Both chose a **permission bypass** and a **session resume** on your behalf, from a variable
that names neither, on the process that becomes the control tower. **Those tails are gone.**
No code path can produce them unless an operator names each part and — for the bypass — types
an acknowledgement for it. A non-TTY boot without a complete plan now exits 2 and prints which
field is missing; nothing is reconciled, signalled or exec'd on the way to that refusal.

To migrate a caller:

1. run `bin/orchestrator-boot.sh --wizard-plan` on a terminal and make the choices
   deliberately — in particular, decide whether that caller really needs a bypass and whether
   it really means to resume the previous conversation;
2. copy the printed `AIGENTRY_BOOT_*` lines into the caller's environment — or capture stdout to
   a file, check the exit code and read the assignments before reusing them (§1);
3. check it with `bin/orchestrator-boot.sh --dry-run`, which validates the same plan and acts
   on nothing.

`--dry-run` and `__probe` require a complete plan too: they report the plan the environment
states, and a dry run that invented the missing fields would be describing a boot that could
not happen.

The **stdout-argv contract** is unchanged in what it *is* — the final validated command,
serialized one element per line for the shell to `exec`. It was never a promise that a
particular risky default would keep appearing on it.

---

## 4. What is unchanged, deliberately

`bin/orchestrator-boot.sh` itself, and every invariant it carries:

- the **#934 gate** — booting requires an empty argv, and the wizard adds no flag to the boot
  path;
- the **real process replacement** — your shell becomes the bridge, so the singleton guard
  still runs strictly before the bridge exists;
- **SIGKILL only, never SIGTERM**; **never self or any ancestor** (#539);
- the **#905 registry reconcile** and all six of its verdicts, still running before the guard;
- the **one sanctioned credential resolver**, and the token still never logged;
- the fixed argv head `telepty allow --id <sid> --auto-restart` — a plan composes only the
  tail after it, so `--auto-restart`'s measured pre-command position, telepty's lifecycle and
  the guard's match token are identical on every path;
- `--dry-run` and `__probe` remain read-only, and `--dry-run` never prompts, so it produces
  the same bytes from a script, a pipe and a terminal.

---

## 5. cwd is displayed, not changed

The wizard shows the cwd the bridge will run in and offers no way to change it. That is not an
omission:

- the shell `exec`s the bridge and **keeps its own cwd**;
- this code runs inside that shell's command substitution, so a Node `chdir` here moves only a
  short-lived child — it cannot move the parent shell;
- codex (`-C, --cd`) and grok (`--cwd`) do have cwd flags, and passing one would make the
  review screen disagree with where the session actually runs. Claude and gemini have none at
  all.

If the cwd is wrong: cancel, `cd`, and boot again.

---

## 6. Not proven here

- **Windows.** Windows is supported (see README Platforms); this capture is macOS arm64
  only, so nothing on this page is a Windows boot measurement.
- **Provenance.** Hashes bind copied bytes, not signatures. No codesign/notarization or
  publisher check was performed for any of the four executables.
- **Codex effort**, **grok effort values**, and grok's sandbox profile enum as printed by the
  CLI: still owed, and recorded as gaps rather than filled in.
- **Model availability per account**, for every provider: not probed, and not probeable
  without auth.
- **Whether the orchestrator's own doctrine** (skills, hooks, `AGENTS.md`/`CLAUDE.md`
  discovery) functions under `gemini` or `grok`. Those providers are selectable when installed
  because the wizard can compose their argv from measured flags; that is not the same claim as
  "the orchestrator role works under them".
