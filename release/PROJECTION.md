# `release/tasks.json` — public task-ID projection

Release admission (`scripts/release-admission.mjs`) needs to know which task IDs a
release group is permitted to name. It used to read `state/task-queue.json`, which is
`.gitignore`d, never shipped, and holds personal history — so admission could only pass
by publishing that queue. It now reads this committed projection instead.

## Schema

```json
{
  "schema_version": 1,
  "release_group": "release-1171",
  "tasks": [
    { "id": 1171, "release_component": "integrated-release" }
  ]
}
```

Keys are closed — any extra key at the top level or in a task entry is refused:

- `schema_version` — must be `1`.
- `release_group` — must equal `release_task`'s manifest `release_group`.
- `tasks` — nonempty; each entry is exactly `{ id, release_component }`.
  - `id` — positive safe integer, unique within the file.
  - `release_component` — slug of ≤80 bytes matching
    `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`. This bounds **syntax only**: paths, whitespace and
    control characters cannot pass, but a syntactically valid slug can still disclose
    something private. Every slug is public metadata and must be reviewed as such by
    the maintainer (see below) — the regex is not a privacy check.

Because the keys are closed, these are refused rather than merely omitted: `status`,
`state`, `done`, `completed_at`, `title`, `notes`, `prompt`, `dispatch`, `session`,
`sid`, `attempt`, `worker`, `role`, `owner`, any filesystem path, any environment
value, and any approval token or reviewer name.

When this file changes in a release, the planning manifest must name it under the
release task. A projection carried over unchanged from an earlier release is accepted
as-is. It is excluded from the security inventory and scan scope, so it can never be
enrolled as scanned source.

## Provenance and review

The private task queue remains the **sole authority** for task existence, ordering,
status, history, and every personal note. Nothing copies it: there is no generator, no
runtime pipeline, no daemon, no credential, and no automatic sync. This file is
hand-authored in the release commit by the release maintainer.

Reviewing it means two things:

1. **Comparing the exact ID membership in this file against the private authority by
   hand.** The release PR diff shows every added ID, and admission pins the committed
   bytes — but admission cannot tell whether the set is honest. Only that manual
   comparison can. Admission's silence is not an independence guarantee.
2. **Reading every `release_component` slug as published public metadata.** Admission
   checks slug syntax and nothing more; whether a given slug is safe to disclose is a
   judgement only the maintainer can make, and it must be made before the release
   commit.

## What this file does not prove

It does not assert that any listed task is done, verified, tested, reviewed, shipped,
installed, supported, or approved. It carries no completion, security, or policy
approval, and does not authorize publication. It does not attest that the code
implementing a task exists or works.

It states only: *these task IDs, with these neutral component slugs, are the public
membership of this release group; admission may not name an ID outside this set.*

Planning coverage lives in `release/<version>.json`; security adjudication lives in
`release/security/<version>/policy.json` behind its trust pin.

`release_component` is a historical identifier for the work item, not a status. For
example, a component slug ending in `-proposal` records what the task was originally
filed as; it says nothing about what was ultimately built or whether it shipped.
