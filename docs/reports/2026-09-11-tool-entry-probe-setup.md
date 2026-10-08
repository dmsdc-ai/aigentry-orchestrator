# Task #1151: tool-entry probe setup

Status: READY / HOLD pending a separate controlled second-turn dispatch. No measured second turn has run.

## Own-thread binding and source

- Session: `ib1151-builder`; installed executable: `/opt/homebrew/bin/codex`.
- `CODEX_THREAD_ID`: `01a08e00-2b54-7f73-a1d7-8dd3695f569a`.
- Exact rollout: `/Users/duckyoungkim/.codex/sessions/2026/09/11/rollout-2026-09-11T10-06-10-01a08e00-2b54-7f73-a1d7-8dd3695f569a.jsonl`.
- Binding: first rollout record is `session_meta`, with matching `payload.id`, cwd `/Users/duckyoungkim/.aigentry/role-sandbox/builder-ib1151-builder`, originator `codex-tui`, source `cli`.
- Installed `codex --version` and rollout `cli_version`: `0.153.4`.
- Target: `/Users/duckyoungkim/.aigentry/worktrees/ib1151`; branch: `build/1151-tool-entry-probe`; initial working tree clean.
- Setup source HEAD: `40031d8f769d88fd82b70b93f702def9b1b0a2fe`.
- Merge base with local main: `40031d8f769d88fd82b70b93f702def9b1b0a2fe`.
- Local main at preparation: `3e1b2fb22a6639fddd5d37af9b83a522dbd6bb04`. No remote freshness assertion.
- Dispatch source: `~/.telepty/shared/3d6800bca44aadb8b563414e0369890fe9d8be9a820de9c031afd018aa12851a.md`.

## Exact proposed first-tool command

On the next controlled measurement dispatch, the first tool call will be `functions.exec` wrapping exactly one `tools.exec_command({cmd: <the command below>, login: false})`; its result will be emitted with `text`. No earlier tool call, including reading the dispatch reference, will occur on that turn.

The sampled layer is inside Python execution within that first shell tool. Entry timestamps occur immediately after importing `time`, after shell/Python startup and wrapper entry. They do not measure a pre-tool hook or exact shell-process entry. Each clock pair is sampled sequentially. Read timestamps bracket one binary open/read/close of only the bound rollout; concurrent appends may occur. No second rollout read is performed.

```sh
python3 -c 'import sys;exec(sys.argv[1])' 'import time
entry_monotonic_ns = time.monotonic_ns()
entry_wall_ns = time.time_ns()
import hashlib, json, os, shlex, sys
from pathlib import Path
thread = "01a08e00-2b54-7f73-a1d7-8dd3695f569a"
source = Path("/Users/duckyoungkim/.codex/sessions/2026/09/11/rollout-2026-09-11T10-06-10-01a08e00-2b54-7f73-a1d7-8dd3695f569a.jsonl")
assert os.environ.get("CODEX_THREAD_ID") == thread, "Thread binding changed"
read_start_monotonic_ns = time.monotonic_ns()
read_start_wall_ns = time.time_ns()
with source.open("rb") as stream:
    snapshot = stream.read()
read_end_monotonic_ns = time.monotonic_ns()
read_end_wall_ns = time.time_ns()
first = json.loads(snapshot.split(b"\n", 1)[0])
assert first["type"] == "session_meta" and first["payload"]["id"] == thread, "Rollout binding changed"
os.umask(0o077)
out = Path("/Users/duckyoungkim/.aigentry/worktrees/ib1151/dist/evidence/ib1151")
out.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(out, 0o700)
target = out / "tool-entry-rollout.jsonl"
with target.open("xb") as stream:
    stream.write(snapshot)
metadata = {
    "thread_id": thread,
    "source_rollout": str(source),
    "snapshot_path": str(target),
    "sha256": hashlib.sha256(snapshot).hexdigest(),
    "byte_count": len(snapshot),
    "entry_monotonic_ns": entry_monotonic_ns,
    "entry_wall_ns": entry_wall_ns,
    "read_start_monotonic_ns": read_start_monotonic_ns,
    "read_start_wall_ns": read_start_wall_ns,
    "read_end_monotonic_ns": read_end_monotonic_ns,
    "read_end_wall_ns": read_end_wall_ns,
    "sampled_layer": "Inside Python in exec_command, wrapped by first functions.exec",
    "command": shlex.join(["python3", "-c", "import sys;exec(sys.argv[1])", sys.argv[1]]),
    "durability": "No fsync; no crash durability claim"
}
with (out / "tool-entry-metadata.json").open("x") as stream:
    json.dump(metadata, stream, indent=2)
    stream.write("\n")
print(json.dumps({"snapshot": str(target), "sha256": metadata["sha256"], "byte_count": len(snapshot)}))'
```

The command is proposed only, not executed in setup. Metadata reconstructs the exact shell command using `shlex.join`. Evidence directory permissions are 0700, files are created exclusively under umask 077 (0600). Existing evidence files cause failure instead of overwrite. Snapshot and metadata are local evidence only; never commit raw rollout. No fsync or crash-durability claim.

## Boundary

Documentation only; no production/helper code, builds, tests, installations, configuration edits, restarts, or outcome interpretation. Snyk N/A. The tester owns exact synthetic-marker and event-order assertions. This measures this disposable session and normal reference dispatch only; it does not establish message authentication, inject-ID binding, or runtime loop behavior.

Commit this report before sending READY and HOLD to the orchestrator. Phase 2 requires the separate controlled dispatch.

## Sample 01 — captured, pending independent tester review

Controlled dispatch reference: `~/.telepty/shared/566e816cc82cfcbb6eb48728c455bc26151fcceb22728a0432d81aa12eccc725.md`. Setup commit: `3de4454`. Synthetic label inside that reference: `IB1151-SAMPLE-01-20260911`; no assertion that this inner label was present in the initial PTY payload. The tester must correlate the outer context-reference message and actual inject ID; no inject ID was inferred here.

Actual order on the controlled turn:

1. Assistant commentary announced capture before reading the reference; no tool had run on this turn.
2. First tool: `functions.exec` wrapping exactly one `tools.exec_command`, with `login: false`, executing the exact prepared command above. Exit code 0; output reported the snapshot path, SHA-256 and 275461 bytes.
3. Second tool: `functions.exec` wrapping `exec_command` to read the controlled dispatch reference.
4. Subsequent inspection read only the output metadata, hashed its bytes, inspected artifact permissions/size, and checked Git status/ignore rules. No snapshot message contents were inspected after capture.

No ordering or command deviation observed; one capture, no retries. Entry timestamps are inside Python after importing `time`, within the first tool, as specified in setup. They are not exact shell entry, pre-tool visibility, or crash-durability measurements.

| Recorded timestamp | Monotonic ns | Unix wall-clock ns |
| --- | --- | --- |
| Entry | 1673992744969625 | 1789088958200376000 |
| Read start | 1673992754478041 | 1789088958209884000 |
| Read end | 1673992754552791 | 1789088958209959000 |

- Snapshot: `dist/evidence/ib1151/tool-entry-rollout.jsonl`, 275461 bytes; SHA-256 recorded from the captured bytes: `b9f64d832e320d67a2c082d5a47d2e8193953a10783c261ddeb653ccb45e13b5`.
- Metadata: `dist/evidence/ib1151/tool-entry-metadata.json`, 2993 bytes; SHA-256 of saved metadata: `78b7a8bdb85e526b9beacd6ce46f964271abc7d7066d6a7b6aa1ee51233ff6e4`.
- Known thread remained `01a08e00-2b54-7f73-a1d7-8dd3695f569a`; capture checked the environment binding and snapshot session metadata.
- Both artifacts have mode 0600; their directory has mode 0700. Git reports both paths ignored; raw rollout and metadata remain local, uncommitted evidence.

No builds or tests run; Snyk N/A (documentation only). No runtime outcome assertion, tester verdict, or loop activation. Phase 2 execution complete; HOLD for independent tester review.
