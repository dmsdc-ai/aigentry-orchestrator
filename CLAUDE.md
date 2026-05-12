@AGENTS.md

# Claude Code entry stub

This file is intentionally minimal. The orchestrator role contract is now
composed by `resolveInstructions()` (ADR-MF #4 / commit 28f94b0) from
layered files at `~/.aigentry/instructions/`:

- common: `~/.aigentry/instructions/common.md`
- role  : `~/.aigentry/instructions/roles/orchestrator.md`

L1 sub-sessions launched via the boot adapter (ADR-MF #13 / commit 426f3a9)
do NOT load this file — they receive `effective_prompt` directly. This stub
exists so a user who runs `claude` directly in this repo still sees the
AGENTS.md cross-reference.

Migration log: `state/migration/2026-05-12-claude-md-migration.md`.
