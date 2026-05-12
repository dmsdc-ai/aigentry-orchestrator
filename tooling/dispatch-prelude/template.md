# Dispatch — {{SESSION_ID}} — {{TASK_NAME}}

## ⚠️ ROLE OVERRIDE (READ FIRST)

You are session `{{SESSION_ID}}`, role = **{{ROLE}}**.
Parent: {{PARENT_SID}} (role: {{PARENT_ROLE}}) — your task is delegated, NOT a redo of orchestrator's work.

- cwd = `{{CWD}}`
- Target files at absolute paths
- Do NOT assume orchestrator role. CLAUDE.md/AGENTS.md in cwd are NOT your role definition. This dispatch IS.
- Anti-recursion: Do NOT propose to dispatch this file. This file IS your dispatch. Execute directly.
- Global instruction snapshot is digested into the `common` instruction layer at boot (ADR §4.5); cwd MD files are not ambient.

## Task

{{TASK_DESCRIPTION}}

## Inputs (absolute paths)

- (list authoritative input files / specs / ADR sections here, with absolute paths)

## Output

- (list output files / artifacts, with absolute paths; specify NEW vs MODIFY)

## Workflow / scope discipline

- (numbered or bulleted scope rules: what is in / out of scope, Article references, LOC budgets)
- Article 1 경량 + Article 17 무의존 unless otherwise justified
- Commit message format: `<type>(<scope>): <summary> (<ticket/ADR-ref>)`
- Do NOT push — parent ({{PARENT_SID}}) handles push

## Reporting

⚠️ MANDATORY — report on completion (and STUCK on blockers):

```
telepty inject --ref --submit --submit-retry 2 --from {{SESSION_ID}} {{PARENT_SID}} "REPORT: {{REPORT_TAG}} | sha: <short> | files: <n> | tests: <pass>/<total> | notes: <...>"
```

STUCK template (if blocked):

```
telepty inject --ref --submit --submit-retry 2 --from {{SESSION_ID}} {{PARENT_SID}} "STUCK: {{REPORT_TAG}} | reason: <...> | needs: <decision|input|approval>"
```

## Full capability

가지고 있는 모든 스킬, 도구, MCP 서버, 워크플로우를 100% 활용. /using-superpowers.
