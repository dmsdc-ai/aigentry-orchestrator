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

### Confined worker report (mandatory, #1170)

If `$AIGENTRY_REPORT_OUTBOX` is set you are a confined worker and the two templates above cannot leave your sandbox:

- This sandbox cannot reach telepty. Never run `telepty` (inject, list or any other command); report only through `$AIGENTRY_REPORT_OUTBOX`.
- Your dispatch file ends with `<!-- aigentry-report v1 -->` and a line `REPORT_ENVELOPE request_id=<R> challenge=<C> …`. Use the LAST such line of the newest dispatch you were handed; never reuse an older dispatch's envelope.
- Write `<KIND>-<n>.md` in `$AIGENTRY_REPORT_OUTBOX/<R>/` (`mkdir -p` it): KIND `REPORT` when done, `HOLD` when blocked or asking. n = 1, 2, … up to 32; never overwrite or reuse a number — a correction or a later answer is the next n.
- First line exactly `AIGENTRY_REPORT v1 request_id=<R> challenge=<C> kind=<KIND> seq=<n>`; last line exactly `AIGENTRY_REPORT_END <R> <KIND>-<n>`; your report in between; at most 64 KiB in total.
- Write it as `<KIND>-<n>.md.tmp`, then `mv` it to `<KIND>-<n>.md`. Writing the file is your report, not task completion: the orchestrator reviews it.

## Full capability

가지고 있는 모든 스킬, 도구, MCP 서버, 워크플로우를 100% 활용. /using-superpowers.
