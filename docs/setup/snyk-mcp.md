# Snyk MCP — install + scan workflow

**Status**: installed at user scope (`~/.claude.json`), MCP health green, **auth pending (user action)**.
**Mandate**: `~/.claude/CLAUDE.md` global rule — *Snyk Security At Inception* — and orchestrator Rule 32 (permanent fix discipline).

## What this enables

After `snyk auth`, every Claude Code session inherits the `snyk` MCP server and exposes 12 Snyk tools. The directly relevant one for the global rule is:

- `snyk_code_scan` — SAST (Static Application Security Testing) on newly written / modified first-party code.

Other registered tools: `snyk_sca_scan`, `snyk_iac_scan`, `snyk_container_scan`, `snyk_sbom_scan`, `snyk_secret_scan` (experimental), `snyk_aibom`, `snyk_package_health_check`, `snyk_trust`, `snyk_auth`, `snyk_logout`, `snyk_auth_status`, `snyk_version`.

## Why this package (Article 17 — 무의존, official-first)

Official sources (no third-party wrappers):

- Snyk MCP server is shipped **inside the Snyk CLI** (`snyk mcp` subcommand). Repo: [`snyk/studio-mcp`](https://github.com/snyk/studio-mcp).
- Anthropic MCP Marketplace manifest: [`snyk/agentic-integration-wrappers`](https://github.com/snyk/agentic-integration-wrappers) (`server.json`, MCP name `io.snyk/mcp`, npm package `snyk`, transport `stdio`, args `mcp -t stdio`).
- No standalone `snyk-mcp` / `@snyk/mcp-server` npm package exists (verified `npm view` → 404). All other `*-snyk-mcp` repos on GitHub are third-party / archived and are rejected per Article 17.

## Install (already done — for reproducibility)

```bash
# 1. Snyk CLI globally (host-level dev tool, NOT a runtime dep of any project)
npm install -g snyk

# 2. Register MCP server at *user* scope so every Claude Code session inherits it
claude mcp add snyk -s user -- snyk mcp -t stdio

# 3. Verify
claude mcp list | grep -E '^snyk:'
# Expected: snyk: snyk mcp -t stdio - ✓ Connected
```

## Auth (USER ACTION REQUIRED)

The Snyk CLI scans require an authenticated Snyk account. Until this is done, `snyk_code_scan` and friends will fail (typically with `authentication required`).

```bash
# Option A — OAuth (default since CLI 1.1293, recommended)
snyk auth
# Opens a browser. Log in (Snyk free tier is sufficient for personal/OSS use; check pricing if commercial).

# Option B — API token (CI / non-interactive)
snyk auth <SNYK_API_TOKEN> --auth-type=token
#   or
export SNYK_TOKEN=<token>

# Verify auth
snyk config get api   # should print a value, not blank
```

**Free tier limits**: 100 SAST tests/month (Snyk Code), 200 open-source tests/month. Enough for personal/OSS work; for the orchestrator project's commit cadence this is adequate. Upgrade only if rate-limited.

## Scan workflow — "snyk_code_scan after new code commits"

Per global CLAUDE.md rule + Rule 32:

1. **Trigger**: after any commit that introduces new first-party code in a Snyk-supported language (TS/JS, Python, Go, Java, Rust, C/C++, C#, PHP, Ruby, Kotlin, Swift, etc.).
2. **Scope**: prefer scoping the scan to changed files. Default tool call (within an MCP-enabled Claude session):

   ```text
   snyk_code_scan path=/abs/path/to/project
   ```

   For a narrower scope, pass a subdirectory or a specific file path.
3. **Result handling**:
   - 0 issues → done.
   - Issues found → attempt to fix using Snyk's result context, re-run `snyk_code_scan`, repeat until clean (per global rule).
   - If a finding is a false positive, file an exception with justification — do not silently ignore.
4. **Trust prompt**: first scan in a new directory may require `snyk_trust path=...` consent. This is a one-time per-folder gate.

### Helper: `bin/snyk-scan.sh`

A thin wrapper that runs `snyk code test` from the CLI (not via MCP — useful for shell / pre-commit hooks / dispatched coder sessions that don't have an MCP-enabled host):

```bash
# Scan all changes in the current commit:
bin/snyk-scan.sh                 # last commit
bin/snyk-scan.sh HEAD~3..HEAD    # range
bin/snyk-scan.sh --all           # full repo
```

See `bin/snyk-scan.sh --help`.

## When Claude itself should call `snyk_code_scan`

| Scenario                                                            | Action                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Session just generated/modified first-party code in supported lang  | Call `snyk_code_scan` on the changed paths **before reporting DONE**.                   |
| Session only edited docs / markdown / config                        | Skip.                                                                                   |
| Session edited dependency manifests (`package.json`, `Cargo.toml`)  | Call `snyk_sca_scan` instead (or in addition).                                          |
| Session edited IaC (terraform, k8s, dockerfile)                     | Call `snyk_iac_scan`.                                                                   |
| MCP not available in session (no Snyk tools listed)                 | Fall back to `bin/snyk-scan.sh` via Bash. Document MCP unavailability in DONE report.   |

## Troubleshooting

- **`snyk: command not found`**: re-run `npm install -g snyk`; check `which snyk` and `$PATH`.
- **`claude mcp list` doesn't show snyk**: re-run `claude mcp add snyk -s user -- snyk mcp -t stdio` and restart the session.
- **`snyk_code_scan` returns auth error**: run `snyk auth` (one-time).
- **Rate-limited (`429` / `quota exceeded`)**: free-tier limit reached; either wait for next billing cycle or upgrade plan.

## References

- Official manifest: <https://github.com/snyk/agentic-integration-wrappers/blob/main/server.json>
- Snyk MCP repo: <https://github.com/snyk/studio-mcp>
- MCP registry entry: `io.snyk/mcp` on <https://modelcontextprotocol.io>
- Snyk CLI docs: <https://docs.snyk.io/snyk-cli>
- Global rule: `~/.claude/CLAUDE.md` (Snyk Security At Inception)
- Project rules: `docs/rules.md` Rule 32 (permanent fix discipline)
