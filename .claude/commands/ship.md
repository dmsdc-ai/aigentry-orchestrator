# ship

Automate git commit → push → publish for aigentry ecosystem projects.

## Instructions

Parse `$ARGUMENTS` to extract target session(s). If empty, ask user which session(s) to ship.

### Project Registry

| Project | Type | Package | Publish Command |
|---------|------|---------|-----------------|
| aigentry-telepty | npm | @dmsdc-ai/aigentry-telepty | npm publish --access public |
| aigentry-brain | npm | @dmsdc-ai/aigentry-brain | npm publish --access public |
| aigentry-devkit | npm | @dmsdc-ai/aigentry-devkit | npm publish --access public |
| aigentry-deliberation | npm | @dmsdc-ai/aigentry-deliberation | npm publish --access public |
| aigentry-amplify | npm | @dmsdc-ai/aigentry-amplify | npm publish --access public |
| aigentry-dustcraw | npm | @dmsdc-ai/aigentry-dustcraw | npm publish --access public |
| aigentry-aterm | cargo | aterm | cargo publish |
| aigentry-registry | python | aigentry-registry | pip publish (twine upload) |
| aigentry-orchestrator | none | - | git push only (no publish) |
| aigentry-analyst | none | - | git push only |
| aigentry-design | none | - | git push only |
| aigentry-forum | none | - | git push only |
| aigentry-logger | none | - | git push only |
| aigentry-ssot | none | - | git push only |
| aigentry-starter | none | - | git push only |
| aigentry-tester | none | - | git push only |

### Workflow

1. **Identify target**: Match session ID to project from registry above
2. **Determine project type**: npm / cargo / python / none
3. **Self-ship check**: If target is `aigentry-orchestrator-claude` (self), execute directly instead of inject:
   - Run git commands directly in `~/projects/aigentry-orchestrator/`
   - No telepty inject needed
   - Follow the same commit/push/publish steps for the project type
4. **Build inject prompt** (ALWAYS in English, skip if self-ship):

For **npm** projects:
```
Ship task: commit, push, and publish. Execute immediately without asking for confirmation.
1. git add -A && git status (review changes)
2. git commit with conventional commit message summarizing changes
3. npm version patch (or minor/major if breaking changes)
4. git push origin main
5. npm publish --access public
6. Report result to orchestrator: telepty inject --ref --from {session-id} aigentry-orchestrator-claude "ship report"
Do NOT ask for user confirmation. Execute all steps directly.
```

For **cargo** projects:
```
Ship task: commit, push, and publish. Execute immediately without asking for confirmation.
1. git add -A && git status (review changes)
2. git commit with conventional commit message
3. Update version in Cargo.toml if needed
4. cargo check && cargo test
5. git push origin main
6. cargo publish
7. Report result to orchestrator: telepty inject --ref --from {session-id} aigentry-orchestrator-claude "ship report"
Do NOT ask for user confirmation. Execute all steps directly.
```

For **python** projects:
```
Ship task: commit, push, and publish. Execute immediately without asking for confirmation.
1. git add -A && git status (review changes)
2. git commit with conventional commit message
3. Update version in pyproject.toml if needed
4. git push origin main
5. python -m build && twine upload dist/*
6. Report result to orchestrator: telepty inject --ref --from {session-id} aigentry-orchestrator-claude "ship report"
Do NOT ask for user confirmation. Execute all steps directly.
```

For **none** (no publish) projects:
```
Ship task: commit and push. Execute immediately without asking for confirmation.
1. git add -A && git status (review changes)
2. git commit with conventional commit message
3. git push origin main
4. Report result to orchestrator: telepty inject --ref --from {session-id} aigentry-orchestrator-claude "ship report"
Do NOT ask for user confirmation. Execute all steps directly.
```

4. **Confirm with user** before sending inject:
   - Show: target session, project type, publish command
   - Ask: "Ship {project} via {session-id}? (y/n)"

5. **Send inject** via telepty inject (use --ref for long prompts, --from aigentry-orchestrator-claude)

6. **Wait for report** from target session

### Multi-ship (broadcast)

If argument is "all" or multiple sessions:
- Iterate through each target
- Confirm each one
- Send injects sequentially (avoid race conditions on shared deps)

### Safety Rules

- NEVER publish without user confirmation
- NEVER force push (--force)
- ALWAYS use conventional commits
- ALWAYS run tests/check before publish (npm test, cargo test, pytest)
- If uncommitted changes exist, show diff summary before committing
- If version bump is needed, suggest patch/minor/major based on changes
