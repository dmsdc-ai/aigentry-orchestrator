# Central environment settings (task1233 S1)

The S1 candidate manages registered nonsecret settings. Secret delivery and grants
remain S2 work; remaining readers remain S3 work; native, installation, recovery,
security and release acceptance remain S4 gates. Configuration never establishes
authentication, account eligibility or subscription billing support.

`AIGENTRY_HOME`, when supplied, must be an absolute path. Otherwise the root is
the OS user's home plus `.aigentry`. The canonical document is
`environment/config.json` under that root. No dotenv search or shell evaluation
is performed. Metadata commands create nothing and read no provider auth store.

```sh
aigentry-orchestrator env locate
aigentry-orchestrator env list --json
aigentry-orchestrator env explain claude.model
aigentry-orchestrator env doctor --json
aigentry-orchestrator env set claude.model claude-opus-5-5 --expected-revision 0
aigentry-orchestrator env set claude.effort high --profile work --expected-revision 1
aigentry-orchestrator env profile select work --expected-revision 2
aigentry-orchestrator env unset claude.model --expected-revision 3
```

Read the current revision before each mutation. `set --profile NAME` creates a
profile; `profile select` requires an existing profile. `--project ABS` targets
an existing canonical directory and cannot be combined with `--profile`.
Project overrides live only in protected central state, keyed by the real target
root. They are nonsecret settings; this is not S2 project enrollment or authority.

The version 1 document has exactly `version`, `revision`, `selectedProfile`
(name or null), `settings`, `profiles` and `projects`. The latter three contain
registered setting IDs with string values (profiles/projects contain setting
maps). `{}` and absence use existing caller defaults. Unknown/duplicate/prototype
keys, malformed UTF-8/JSON, input above 128 KiB, depth above 16, over 32 profiles
or 64 projects, and invalid setting values refuse. Registered empty env values
are invalid; remove an alias to request fallback.

Precedence is invocation flag, registered env alias, central project override,
selected profile, central baseline `settings`, owned legacy role/default fields,
then the caller's shipped defaults. Invalid higher-priority env values refuse
even if a flag is supplied; conflicting aliases in one layer refuse. The selected
legacy role contributes only `cli`, `model`, `effort` and an opaque `cli_flags`
conflict check. Other legacy fields and the legacy document are preserved.
Opaque flags are never shell-parsed or migrated by this resolver. Typed
model/effort settings conflicting with model/effort options in opaque flags refuse.

Registered S1 IDs: `boot.cli`, `boot.sid`, `boot.model`, `boot.effort`,
`dispatch.cli`, `control.workspace`; `claude` and `codex` each have `.model`,
`.effort`, `.executable`, `.version`; `gemini` has `.model`, `.effort`, `.binary`;
`grok` has `.model`, `.effort`; `router.profile`; and `catalog.metadata`,
`catalog.deadlineMs`, `catalog.maxBytes`, `catalog.maxRedirects`. Executable,
workspace and router profile paths must be absolute. Executable versions use the
identity-bound declaration below. Catalog
budgets only tighten existing bounds; `catalog.metadata=off` disables its public
metadata fetch. Gemini effort is available only on the agy path.

`claude.version` and `codex.version`, their registered
`AIGENTRY_CLAUDE_EXECUTABLE_VERSION` / `AIGENTRY_CODEX_EXECUTABLE_VERSION` aliases,
and `--executable-version` accept a string containing compact JSON with exactly
five fields: `version`, `dev`, `ino`, `size`, `mtimeMs`. For example, the shape is
`{"version":"2.1.283","dev":1,"ino":123,"size":456,"mtimeMs":1700000000000.25}`;
these example identity numbers must be replaced with the recorded stat of the
actual declared executable's realpath. Set `.executable` to its absolute path
(basename `claude` or `codex`) separately. Quote the JSON as one CLI argument:

```sh
aigentry-orchestrator env set claude.version '{"version":"2.1.283","dev":1,"ino":123,"size":456,"mtimeMs":1700000000000.25}' --expected-revision 4
```

Declarations are bounded to 1024 UTF-8 bytes with no control characters.
`version` has three numeric components of 1–8 digits and an optional `-` suffix
of 1–32 ASCII letters, digits, dots or hyphens. `dev`, `ino` and `size` must be
nonnegative safe integers; `mtimeMs` must be a finite nonnegative number at most
`Number.MAX_SAFE_INTEGER` (fractional milliseconds are retained). Missing,
extra, duplicate/escaped duplicate and prototype keys, strings in numeric fields
and malformed JSON refuse. Values are never coerced or repaired.

A bare version such as `100.0.0` is refused before config mutation or managed
model effects. Existing bare-version settings require explicit operator repair:
remove or replace the invalid value in the protected config through an
operator-reviewed offline edit before using revisioned commands again. Normal
`set`/`unset` also refuse to read an invalid stored document; metadata/launch may
refuse until it is repaired. Keep the config's private ownership and permissions,
and preserve unrelated fields. No automatic migration or binding to a
PATH hit occurs. Valid existing identity JSON keeps its original string through
projection. A stale identity remains unknown and can cause compatibility
refusal; it is never rebound to a replacement executable. Matching npm package
metadata retains precedence. `operator-declared` means an operator supplied a
version for that file identity, not authenticated publisher/version evidence or
an observed provider claim. No provider is executed to obtain or verify it.

The boot selection is a hint in the interactive provider menu. Persisted
model/effort settings do not count as fresh invocation plan fields: bare terminal
boot reaches the wizard, and cancellation keeps stdout empty and causes no boot
effects. Enter at the model/effort prompts uses applicable configured settings
after provider validation. Boot hints apply to their suggested provider; changing
provider uses that provider's typed defaults rather than carrying foreign effort.
Fresh invocation model/effort/permission/history/ack fields still refuse without
`AIGENTRY_BOOT_PLAN=1`, even when their bytes equal a persisted suggestion.
Noninteractive boot still requires the existing complete invocation plan,
permission/history choices and any risk acknowledgement. Those approvals,
worker identities, scope/grants and secret destinations are not persistent
settings. Dispatch accepts `--cli`, `--model`, `--effort`, `--executable` and
`--executable-version`; typed tuple flags require an explicit supported CLI.
`dispatch.cli` supplies the selection when `--cli` is absent. Dispatch parses its
invocation once for bootstrap and execution. Repeated `--cli`, `--cwd`, `--role`,
`--model`, `--effort`, `--executable` or `--executable-version` refuse with
`ENV_DUPLICATE_OPTION` before helper, resolver, terminal or worker effects.
Missing, empty or flag-looking values for these options refuse with
`ENV_OPTION_VALUE_REQUIRED`; diagnostics name the option without echoing its
value. Help stops at its normal parser boundary, and option values and internal
probe payloads are not scanned as additional flags. A single tuple retains its
exact validated values and flag provenance at the managed resolver boundary.

Init resolves settings against the canonical directory from which it is invoked.
Its explicit `--workspace` wins over the invocation env, matching project
`control.workspace`, selected profile and global settings, in that order. Init
does not register that project or write central config as a side effect.

The package entrypoint and installed/copied shims use the same compiled resolver.
Evidence's synchronous pure parser/collector exports also work without that
runtime. The identity declaration grammar has one implementation in
`bin/lib/executable-version.mjs`, copied by init and re-exported with explicit
types by the compiled environment module. Importing evidence performs no ambient
PATH/config runtime discovery.

Managed evidence selects runtime from its explicit caller environment within the
configuration refusal boundary. A complete colocated package takes precedence;
otherwise registered installed entrypoints on the supplied absolute PATH select
their package root. The first valid registered package owns the invocation;
incomplete updates refuse rather than mixing with a later or ambient runtime.
Missing/incomplete runtime returns code 4 / `ENV_CONFIGURATION_REFUSED` through
managed resolver, router and boot handlers, without module-loader stacks.

Copied routers load the declared `cross-spawn` from that selected installed
package's dependency locations (including containing npm `node_modules` when
hoisted). Init does not provision copied-workspace dependencies. A missing owned
dependency refuses by name before model effects; no native-spawn substitute or
global dependency search is used. The two shared bin helpers are shipped through
the existing package `bin` membership and are included in init's 85-member list.
These source/fixture contracts do not establish native global install/update
acceptance.

Cold boot reports revision, source labels and capabilities on stderr. Its stdout
remains one exec argument per line; when necessary an `env` exec prefix carries
the resolved nonsecret settings into the shell's real invocation. Every nonempty
boot argv mode remains no-exec. Model evidence and dispatch's actual decision
retain central request provenance; adapter LaunchConfig v2 env labels describe
the projected alias consumed by the adapter, with original source labels in the
separate redacted awareness summary.

Mutations require POSIX private, user-owned roots/files, no symlinks, one-link
regular files, a pinned private parent and an exclusive writer lock. A second
writer receives `ENV_WRITER_LOCKED` or `ENV_REVISION_CONFLICT`; unverifiable stale
locks are never removed automatically. New init roots are private; existing root
permissions are never silently changed. Native Windows mutations refuse with
`ENV_PROTECTION_UNAVAILABLE` pending ACL/atomic-replacement acceptance. Absent
metadata remains available there, including bounded strict reads of an existing
legacy `config.json`. Legacy reads do not invoke POSIX protected storage guards;
malformed/duplicate/prototype JSON, invalid UTF-8 and oversized input still refuse.
Existing central protected storage continues to fail closed on unsupported
platforms. Simulated win32 caller tests do not establish native Windows
ACL, filesystem or launch acceptance. Atomic rename and fsync establish the config
commit; failure after rename reports `ENV_COMMIT_OUTCOME_UNKNOWN` and requires
authoritative rereading. No history, rollback or vault is claimed. Same-user
unconstrained filesystem/memory manipulation and total ancestor race elimination
are outside the Node guarantee.

Doctor/boot awareness includes no setting values, credentials, hashes, lengths
or account data. Codex has a known app-server external ChatGPT-token interface;
ordinary TUI delivery, token supplier and billing eligibility remain unverified.
The S2 managed path accepts only a fresh invocation-owned Claude OAuth input for
an enrolled target and an enabled `claude.worker.oauth` binding. An operator
explicitly upgrades protected config with `env schema upgrade --expected-revision
N`, then enrolls a canonical project and creates an identity-bound binding.
`env run --binding ID [--input-fd FD] -- dispatch --spawn-and-dispatch --cli
claude ...` owns and closes the input pipe before package imports; a compatibility
value is removed from the parent environment at that same boundary. The descriptor catalog and
`env grants inspect --json` expose metadata only. Input is one 1–4096-byte
printable ASCII payload with one LF and EOF on FD3–63, or an explicit fresh
compatibility value; it never persists in config or a manifest. A grant is
prepared under the shared writer lock, claimed once after confinement preflight,
and durably spent before payload delivery. Managed launch policy is `restart:
never` throughout the terminal adapters. The explicit unconfined Claude handoff
also requires config v2 and uses a distinct one-shot receipt; old handoffs
cannot relaunch. Its claim checks the fixed protected receipt record, and its
provider child receives a positive runtime environment. Unset input keeps the
existing native-only path. Direct native-only calls with a generated sandbox
launcher are refused before terminal effects.

`env grants rotate --expected-revision N --expected-generation G` increments
the authorization generation and denies outstanding old-generation claims.
`env grants reclaim --expected-revision N --expected-generation G --limit L`
removes at most 128 owned records after that fence; current-generation records
also require terminal denial and revoked binding or project authority.
`env grants abort --id ID`, `env grants abort-explicit --sid SID --attempt ID`,
and `env grants reap --limit L` durably deny unclaimed current-generation
attempts before detaching their launch pointer and payload. Reap treats an
unverifiable clock as a denial. The combined
physical grant/explicit-receipt limit remains 1024 until reclaim finishes.
Fullness never rotates automatically. A conflicting or unverifiable writer lock
refuses; PID or age is never proof of stale ownership. `env grants recover-lock`
uses the protected boot identity and recovery journal; same-boot or missing
identity needs a separately proven offline-quiescence adapter and refuses by
default. A commit whose durability
is uncertain refuses subsequent issuance and claim. Rotation does not stop an
already running provider or remove a token already delivered to its memory.

At managed boot, a missing instructions tree invokes the pinned installer through
a pinned absolute `bash` with `HOME`, `PATH`, locale and `AIGENTRY_HOME` projected
from the captured helper context. Unrelated terminal, control, credential and
preload variables are excluded from that child. Existing instructions request no
installer child. Legacy boot outside managed authority retains its native caller
environment. The confined runner checks its required arguments, sealed manifest,
executable identity and metadata canaries before replacing its inherited
environment with the manifest environment. The runner evaluates inert first-party
sealed-manifest validation dependencies before that replacement. It loads SRT and
the first-party claim and runtime helpers after projection. The sealed environment
supplies the worker settings; the native OS user home still anchors the later
controller claim. This ordering does not control arbitrary preloads, native
descendants or installer subtools, and does not establish native SRT confinement
or provider behavior.

This source candidate does not establish native filesystem durability, supported
stale-lock recovery, wrapper/provider behavior, installed-package acceptance,
or public activation. S2 fake tests and the configured security scan remain
independent gates. It adds no provider token mint, account/billing action,
native auth migration, or TLS change.

## Fresh selection and delivery in 0.3.0

A fresh Claude launch uses a nonempty explicit input first; invalid selected input refuses. With no selected input, the original fixed private store is read with owner, mode, ACL and content checks, then checked again immediately before preparation. Empty compatibility environment input is absent. Explicit Codex, help and probes do not acquire Claude credentials.

Selection does not grant delivery authority: current v2 configuration, project enrollment and executable binding remain prerequisites. Existing producers prepare a new bound single-use grant or explicit handoff. Preflight runs without the secret; claiming spends the grant before reading its payload. Failed managed input, spent grants and legacy v1 secret manifests never trigger store fallback or automatic renewal/restart. Use an explicitly approved new dispatch after completing the supported configuration/enrollment/binding commands. No host-login copying or automatic migration occurs.

Native platform and installed-package acceptance remain separate verification gates.
