# Windows gate control regressions

From the repository root, run:

```sh
node --test tests/packaging/windows-release-gates.test.mjs
```

Prerequisites: Node **20**, Ruby with Psych supporting `YAML.safe_load` (including
the `permitted_classes`, `permitted_symbols`, and `aliases` keywords), Bash,
and `cat`, `grep`, `tail`, `awk` on PATH. Psych must load with Ruby's
`--disable-gems` option (the parser does not use RubyGems startup hooks).
Supported hosts are POSIX systems with
executable files and symlinks, such as macOS and Linux. Native Windows is not a
supported harness host. No npm install, compiled application, network, provider,
or private report directory is required. Missing tools or YAML parser errors
fail the run; cases are never skipped for missing prerequisites.

Optional environment overrides (absolute paths; invalid overrides fail without
falling back to PATH):

| Variable | Meaning |
| --- | --- |
| `WINDOWS_GATE_RUBY` | Ruby executable |
| `WINDOWS_GATE_BASH` | Bash executable |
| `WINDOWS_GATE_UTILS` | Directory containing all four utilities |
| `WINDOWS_GATE_EVIDENCE` | Evidence output directory |

Without overrides, each tool is resolved independently through PATH. Symlinks
and PATH directories containing spaces are supported. The harness creates a
mode-0700 directory under Node's OS temp directory (honoring standard `TMPDIR`)
and stores default evidence there. The printed evidence path contains case
results, actual Bash/parser invocations, parsed commands, and before/after source
hashes. Files remain available after failures and successful runs. Use a fresh
optional evidence directory per run to retain earlier results.

The fake Node/npm scripts record exact arguments and replay fixture output;
only parsed workflow Bash and Ruby/Psych execute. Subprocess limits are 5000 ms
and individual case limits are 15000 ms. This does not exercise Windows, GitHub
Actions scheduling, actual npm installation, or the existing CI full-suite debt.

## Historical fixtures and shipping set

Ship this README and all three YAML files beside it, together with
`tests/packaging/windows-release-gates.test.mjs` and the normal repository source
tree. These are byte-identical public workflow snapshots from the task1167
Windows W0/W1 gate regression history; no private task/session data is included.

| File | Provenance | SHA256 |
| --- | --- | --- |
| `release.before.yml` | Release workflow before W0/W1 jobs and publish dependencies | `da142d4151f621b6b497c1a7d1814bb77e9eba2e6991f5f71df6b69405fa3011` |
| `rejected-release.yml` | Rejected release workflow with the legacy count reader | `8b4ad689397f4d0e2776794ed49f401e1f95216ddcea8bf9fd54bc9f6ff04933` |
| `ci.before-parity.yml` | CI workflow before corrected W1 reader parity | `10849b92e1421996998aedabacc84c191449deaa8baa632fb0da8a4b85ecddd1` |

The original 149 cases retain their names, categories, fixtures, and expectations
(identity mapping, old case name → identical new case name); 22 portable-path
cases follow them. Historical fixture hashes are pinned. Current product YAML
hashes are measured at runtime and checked for writes, not pinned to a release.
Semantic workflow mutations are still rejected, and CI's inverse-reader byte
comparison still preserves its existing full-suite behavior. Unrelated workflow
changes can therefore require deliberate test review; do not regenerate these
historical fixtures to silence a failure.

The normal `npm test` runner now invokes this explicit source harness after the
compiled suite succeeds on macOS/Linux, with a 180-second timeout. A compiled
failure prevents the harness from running; a harness failure fails the runner.
On Windows the runner preserves the compiled-suite result and prints a non-TAP
notice that this POSIX harness did not run. Native Windows W0/W1 jobs are separate.

An additional 33 caller cases preserve the original 171 cases: eight actual
subprocess fixtures and 25 constrained VM scenarios. They verify discovery,
ordering, failure propagation, unchanged stale-output rejection and exact spawn
arguments. Platform and timeout branches use exact-source VM mocks, not native
Windows execution or a measured 180-second wait. Fixtures use a sentinel in place
of this harness, so the caller regressions cannot recursively invoke themselves.
