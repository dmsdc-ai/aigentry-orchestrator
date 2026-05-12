# `tooling/dispatch-prelude/` — dispatch ROLE-OVERRIDE prelude tooling

Implements **ADR-MF §4.7 F1** (dispatch prelude template) — see
[`docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md`](../../docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md).

Three artifacts:

| File | Purpose |
|---|---|
| `template.md` | Canonical ROLE OVERRIDE + SessionContext-style header with `{{PLACEHOLDER}}` slots. |
| `generator.sh` | Substitutes args into the template → dispatch starter (stdout or `--out`). |
| `lint.sh` | Validates an existing dispatch file carries the required prelude + reporting markers. |

## Why this exists

Per ADR §4.7, F1 (dispatch prelude) + F3 (CLAUDE.md split) together close the
cwd-leak: when the harness auto-loads MD from cwd, the only thing keeping a
child session in its role is the dispatch prelude itself. Hand-writing the
prelude is error-prone; this tooling makes it deterministic.

## `generator.sh`

```sh
tooling/dispatch-prelude/generator.sh \
  --role architect \
  --task "ADR-X §Y — design widget A" \
  --cwd /tmp/aigentry-widget-a/ \
  --parent orchestrator \
  [--session E-architect-widget-a] \
  [--parent-role orchestrator] \
  [--task-name "ADR-X widget A design"] \
  [--report-tag WIDGET_A_DONE] \
  [--out state/dispatch/2026-05-12-E-architect-widget-a-dispatch.md]
```

Validated:

- `--role` ∈ {orchestrator, architect, coder, implementer, tester, builder, analyst, researcher, reviewer, grader, logger, security-reviewer}
- `--cwd` must be absolute
- Pass `--task -` to read the task body from stdin (multi-line).

Override template path with `DISPATCH_PRELUDE_TEMPLATE=/path/to/template.md`.

## `lint.sh`

```sh
tooling/dispatch-prelude/lint.sh state/dispatch/<file>.md
```

Exit codes: `0` pass, `1` lint failure, `2` usage/IO error.

Checks:

| ID | Severity | Rule |
|---|---|---|
| E1 | error | `## ROLE OVERRIDE` section header present |
| E2 | error | Anti-orchestrator clause present (`Do NOT assume orchestrator role` or `You are NOT (the) orchestrator`) |
| E3 | error | `cwd = \`...\`` declaration in prelude |
| E4 | error | `## Reporting` section with `MANDATORY` marker |
| E5 | error | `telepty inject ... --from <sid>` template present |
| W1 | warn | `Article 1` or `Article 17` reference (경량/무의존) |
| W2 | warn | `/using-superpowers` reference in Full capability |

Flags:

- `--quiet` — suppress per-line diagnostics; only return exit code.
- `--warn-as-error` — count warnings toward exit 1.

## Workflow integration

- New dispatches: pipe `generator.sh` output to `state/dispatch/<date>-<sid>-dispatch.md`, then fill in Inputs/Output/Workflow.
- Pre-dispatch: `lint.sh state/dispatch/<file>.md` before injecting via telepty.
- CI suggestion: loop `lint.sh` over `state/dispatch/*.md` in a smoke job (not enforced by this commit — pure tooling).

## Constraints honored

- POSIX `bash` only (`set -euo pipefail`, awk/grep/coreutils).
- No external dependencies (Article 17 무의존).
- ≤ 150 LOC per script (current: generator 112, lint 110).
- Tested on macOS (Darwin) — portable to Linux.
