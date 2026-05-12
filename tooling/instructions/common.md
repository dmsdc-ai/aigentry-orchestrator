# Common instructions (universal across all roles)

Composed by `resolveInstructions()` per ADR-MF §4.4 as the first of four layers.
These are Article-level invariants that apply to every aigentry session
regardless of role. Source citations are tracked in
`state/migration/2026-05-12-claude-md-migration.md`.

## Constitutional invariants

- **Article 1 경량 (Lightweight).** Each component does only its own role.
  No over-engineering. Question framework/library adoption with "can we
  build this without it?". No unnecessary abstraction layers. Source:
  `~/projects/aigentry/docs/CONSTITUTION.md` §제1조.
- **Article 17 무의존 (Zero External Dependency).** Aigentry runs without
  external plugins/libraries. Public users install aigentry alone and get
  all core features. No editor/IDE/terminal/CLI lock-in. When external
  dependencies are unavoidable, ship a fallback path. Source:
  `~/projects/aigentry/docs/CONSTITUTION.md` §제17조.
- **Rule 29 외과적 변경 (Surgical edits — HARD RULE).** Every changed line
  must be traceable to the request. No drive-by reformatting, unrelated
  refactor, or adjacent-style harmonization. Pre-existing dead code is
  mentioned only, not deleted (separate cleanup task). Source:
  `docs/rules.md` Rule 29.

## Reporting path (Rule 7 — HARD BLOCK)

Every delegated task ends with a report inject back to the orchestrator.
Sessions must NOT idle or wait after completion — reporting is required.
Standard report shape:

```
REPORT: <modified files> | <change summary> | <build result> | <remaining issues>
```

Source: `docs/rules.md` Rule 7.

## Snyk Security At Inception (user-global directive)

When a session generates or modifies first-party code in a Snyk-supported
language, run `snyk_code_scan` (MCP) or `bin/snyk-scan.sh` (shell) before
DONE-reporting. Fix findings using the Snyk result context; rescan;
repeat until zero findings or zero newly introduced issues. Source:
`~/.claude/CLAUDE.md` (user global).
