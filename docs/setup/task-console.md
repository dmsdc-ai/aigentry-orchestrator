# Read-only Task Console

The Console extends the existing packaged HITL web service. It reads configured task-queue files and displays recorded statuses. It cannot run commands, decide approvals, activate a Loop, or establish task/product acceptance. The listener stays on `127.0.0.1` with exact `https://localhost:<port>` Host/Origin and RP ID `localhost`. Forwarding headers confer no trust. Remote proxy, mobile network access, and actual Fold7 operation are unavailable and unverified in this slice.

## Installed entrypoint and setup

The Console web modules, including the task table described below, are not in the currently published `0.2.1` tarball; they reach an installed package only after this change is built and published in a later release. Until then the commands in this section apply to a locally built package, and nothing here should be read as a released capability.

Use a built, installed `@dmsdc-ai/aigentry-orchestrator` package on its declared macOS/Linux platforms with Node >=20.11. The compiled CLI and embedded assets are included under `dist/src/hitl/web`; no development checkout is needed. There is no new initializer subcommand. Set `AIGENTRY_PACKAGE` below to the absolute installed package directory, not the checkout. These are operator commands, not commands executed by the Console:

```sh
node "$AIGENTRY_PACKAGE/dist/src/hitl/web/cli.js" provision-owner \
  --auth-root /absolute/private/auth \
  --invitation-path /absolute/private/owner-invitation

node "$AIGENTRY_PACKAGE/dist/src/hitl/web/cli.js" serve \
  --hitl-root /absolute/private/hitl \
  --auth-root /absolute/private/auth \
  --tls-key /absolute/private/localhost-key.pem \
  --tls-cert /absolute/private/localhost-cert.pem \
  --console-config /absolute/private/console.json \
  --port 8787
```

Prepare owner-only auth directories and a trusted localhost certificate/key using existing operator provisioning. The unchanged auth adapter enforces its ownership, directory, dependency-verification, invitation-expiration and passkey rules. Open `https://localhost:8787`, expand **Enroll owner**, and enter the single-use invitation. Later use **Sign in with passkey**. A reload asks for sign-in again so the CSRF token remains in memory; the underlying session rules are unchanged. Sign out uses the existing CSRF-protected endpoint. No credentials or invitations belong in console configuration or queue summaries. Do not expose invitation files through a web server.

`--console-config` requires TLS key, certificate, and auth root. Omitting it preserves the legacy approval inbox and `/api/requests` API. That API retains its existing authenticated owner authority and unbound records; it is not a project-scoped API. Do not treat a console project grant as authority to publish a shared legacy HITL root. The built-in principal is `inbox-owner`; a caller supplying another verified AuthPort must configure its exact principal IDs.

## Explicit access configuration

The JSON configuration supplies both source locations and operator-owned task membership. No path is inferred from cwd, home, a checkout, query parameters, notes, or task titles. For example:

```json
{
  "projects": [
    {
      "id": "sample",
      "taskQueue": "/absolute/private/task-queue.json",
      "taskIds": ["1177", "1178"]
    }
  ],
  "grants": [
    { "principalId": "inbox-owner", "projects": ["sample"] }
  ]
}
```

Only list task IDs the operator has verified belong to the project. An empty task list intentionally grants no task membership. A missing principal grant denies every project read. Configuration is validated, copied and frozen at startup; restart the service after grant or membership changes, closing old sessions/listeners. Sharing a queue across projects is supported through disjoint explicit membership; sharing an ID deliberately grants that record to both projects. Configuration is security-sensitive and must be writable only by the trusted operator.

IDs use 1–80 ASCII letters, digits, underscores or hyphens, starting with a letter/digit. Paths must be normalized absolute paths without symlink components. Configuration is limited to 1 MiB, 32 projects, 128 principal grants, and 10,000 total configured task memberships. Duplicate projects, principals, memberships, JSON keys, and nesting beyond 32 levels are rejected. Sources/configuration must be local regular files with one hard link; no devices, FIFOs, source symlinks or network-filesystem guarantees are supported. Parent components and file descriptor identities are checked around reads. Source owners should publish by atomic rename; mutation detected during a read makes that source unavailable.

## Read semantics and limits

The queue adapter recognizes existing `tasks` and optional `completed` arrays, numeric/string `id`, allowlisted `status`, and validated `updated_at`. Each read is bounded to 4 MiB and 10,000 total queue records. A configured task absent from both arrays makes coverage partial. Conflicting IDs are omitted with a partial-coverage reason. Unknown statuses remain `unknown`; archive membership is separate. Only exact non-archived `pending` and `queued` statuses yield those lifecycle labels. `delegated`, `in_progress`, `done`, and `completed` do not prove execution or acceptance.

Task titles and free-text notes are not exposed: no accepted redacted-summary or execution-observation contract is supplied. Requested and observed model/effort, SID/attempt/operation, phase, blockers/resume owners, obligations, artifacts and releases remain null with reasons. `updatedAt` is a recorded update, not an observation; `observedAt` is null and currentness stays `unknown`. A successful HTTP fetch never makes execution current. Advisor default-on is shown separately from unknown operation; Loop activation is unverified.

Authenticated routes:

| GET route | Result |
| --- | --- |
| `/api/console/v1/projects` | Only projects granted to the principal |
| `/api/console/v1/tasks?project=sample` | Authorized recorded-task page |
| `/api/console/v1/tasks/1177?project=sample` | Same projection/ACL, filtered to one task |
| `/api/console/v1/requests?project=sample` | Unavailable: intake/clauses contract absent |
| `/api/console/v1/releases?project=sample` | Unavailable: release evidence contract absent |
| `/api/console/v1/approvals?project=sample` | Unavailable: legacy approvals are unbound |
| `/api/console/v1/evidence/ID?project=sample` | Unavailable: evidence contract absent; never resolves a filesystem path |

Console routes reject writes. Existing `/api/requests` reads and decisions-disabled responses remain unchanged. Source failures return an unavailable envelope with HTTP 503, null total, and a reason; partial coverage returns HTTP 200 with warnings. Complete means the configured queue membership was read, not that execution or acceptance evidence is complete. Unknown/ungranted projects return the same 403. A missing task returns 404 only with complete queue coverage; otherwise 503.

Task filters are `status` (allowlisted recorded status) and `q` (task-ID substring only). `limit` defaults to 25 and caps at 100; page JSON caps at 256 KiB. Filters precede counts/pagination. HMAC-authenticated cursors bind principal, project, view, filters, page size, optional detail ID, projection revision and a 60-second expiry. Changed projections or expired cursors return 409 `cursor_expired`; restart without the cursor. Tampered or differently scoped cursors fail. Revisions hash authorized projected fields only; unrelated projects' rows/notes and raw-file digests are not disclosed.

Each project retains one bounded snapshot for 15 seconds. Refreshes coalesce; at most two source refreshes run concurrently, with the existing server request/connections limits unchanged. Parsing/read steps have a 2-second cooperative deadline; the existing 15-second request timeout bounds the HTTP exchange. OS-level filesystem calls cannot be forcibly interrupted, which is why only trusted local filesystems are supported. Cached row count is bounded by the 10,000 configured memberships; source buffers are bounded by the two refresh slots. Source failures replace prior success with explicit unavailability, not an empty successful snapshot.

The browser polls visible tabs every 15 seconds plus up to 1.5 seconds jitter, pauses hidden tabs, allows one outstanding operation, and backs off to 60 seconds plus jitter. It honors bounded `Retry-After`. Pages replace prior pages, bounding browser memory. Loading/offline/error states label any retained view; forbidden/session-expired responses erase private rows. Deep links encode only project/view/task IDs. Messages and details use text nodes, never HTML/Markdown execution, arbitrary links, external fetches or shell actions.

## Task table

The `tasks` view lists authorized recorded tasks as a native HTML table with a caption and column headers: **Task ID**, **Recorded status**, **Execution evidence**, and **Source updated**. Each row uses the task ID as its row header, and that header holds the button that opens the existing read-only detail panel, so the detail command is reachable by keyboard and by screen reader row context. Rows keep the existing ID ordering; there is no sort control and no new API parameter.

The columns report only what the projection already supplies. **Recorded status** is the allowlisted queue status, never an execution or acceptance claim. **Execution evidence** stays `unknown until observed` because no observation contract is supplied, so `done`, `completed` and `in_progress` rows show it too. **Source updated** repeats the recorded `updated_at`, or `unknown` when the source has none. Titles, notes and prompts are still not exposed, and no field is added to the projection.

Scope is the tasks configured for the selected project and granted to the signed-in principal; the caption states that scope generically. Neither the caption nor any row states or implies the existence or number of records outside it. Changing the project selector re-scopes the table. Existing `status` and task-ID `q` filters, the 25-row page size, `Next page` pagination and deep links are unchanged.

The legacy approval inbox keeps its list layout and disabled decisions, and the `requests`, `releases` and `approvals` console views keep their existing empty, unavailable states rather than an empty table. Sign-out, a forbidden or session-expired response, a project change and a view change all clear the table and the legacy list together. Loading, offline, stale, error and no-match states are reported in the existing status and coverage lines; the table is not shown when there are no matching rows.

The table keeps native table semantics at every width, including narrow phones. When the columns cannot fit, the table scrolls horizontally inside its own bounded, keyboard-focusable region instead of overflowing the page. No library, icon font or network asset was added. Rendered layout, zoom and physical-device behavior remain unverified here; see the gates below.

## Remaining acceptance gates

The implementation requires independent source mutation/ACL/cursor checks, legacy compatibility and authentication testing, malicious-text checks, security scanning, browser screenshots at 320/390/768/1440 CSS pixels and 200% zoom, packed-install execution without checkout access, and actual device validation before those capabilities can be claimed. Compilation is not any of these gates. This file documents the repository setup; the existing package allowlist declares the compiled CLI/assets and selected docs for packaging, including `docs/setup/task-console.md` itself, rather than all of `docs/setup`. That declaration is not proof of an actual packed or installed file; packed-install verification remains one of the gates above.
