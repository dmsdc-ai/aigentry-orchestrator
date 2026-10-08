# Orchestrator 0.2.2 Release Evidence

Task: #1171 (release group `release-1171`). Publication and CI installation are verified. No release-group
task is closed by this release; landing on `main` and adoption on the owner's machines are not done.

## Identity

- Package: `@dmsdc-ai/aigentry-orchestrator@0.2.2`; npm `latest` reads back as `0.2.2`; `os` is
  `darwin`, `linux`, `win32`; sha1 `dc166dc73e633e465faf8e9b845a361ef683eb1a`, 375 files.
- Release commit: `e56952d8b941b0f49e92a23a92499c0b5a930a4c`; annotated tag `v0.2.2`; base tag `v0.2.1`
  (`67f2df8`); 171 commits ahead of `origin/main` (`a536cd8`).
- [Release workflow 37353025540](https://github.com/dmsdc-ai/aigentry-orchestrator/actions/runs/37353025540):
  success on attempt 3. [GitHub Release](https://github.com/dmsdc-ai/aigentry-orchestrator/releases/tag/v0.2.2)
  published at `2026-10-05T18:42:18Z` (03:42 KST on 2026-10-06).
- Published by the release workflow at `2026-10-05T18:37Z`; readable from the registry at about `18:41Z`.

## What was measured

| Check | Where | Result |
|---|---|---|
| Linux full suite | CI run 37350955632, ubuntu-latest | 3349 tests, 0 fail (11 skipped, 1 todo) |
| macOS full suite | same run, macos-latest | pass; dispatch guard suite 5m24s |
| Windows full suite (W1) | same run, windows-latest | 2883 tests, 2882 pass, 0 fail, 0 skipped, 1 todo |
| Windows installed package (W0) | same run | pass |
| Browser and TLS acceptance | same run, ubuntu-22.04 | pass |
| Release admission | release run, Gate job | 19 tasks, 423 changed paths, policy ACCEPT |
| Registry bytes | release run, attempt 3 | registry sha1 equals a fresh pack of the tag |
| Clean install | release run and the controller's Mac | `aigentry-orchestrator --version` prints `0.2.2` |

The one `todo` is the recorded unsupported-grammar case "NA3"; it is `todo` on every platform.

## Windows

Native Windows is supported with two documented limitations that refuse instead of running: confined worker
spawn (exit 78, `SANDBOX_PLATFORM_UNSUPPORTED`) and native request capture install (exit 2). Prerequisites:
Git for Windows bash, jq, Python 3. Only the GitHub `windows-latest` image was measured.

## Security

- Snyk Code on the 96 changed files under `src`, `bin`, `scripts` plus the package files, at `2284f88`
  (no scoped file changed afterwards): 33 findings. An independent analyst traced each one in the candidate
  code: 28 false positives, 5 hardening items, none exploitable as shipped. All 33 are recorded as
  eligible in `release/security/0.2.2/policy.json` (sha256 `de4c303f…7db6`, pinned in `release.yml`).
  The orchestrator made these decisions under the owner's delegation of technical decisions; the owner
  did not review the policy bytes personally.
- Deferred hardening: `--grab-delay-ms` ceiling in `scripts/ci/xres-owner.c` (#1177), single-flight
  metadata refresh in `src/hitl/web/auth.ts` (#1151), sealed-manifest read in
  `src/session/worker-sandbox-runner.ts` (#652).
- `npm audit`: two high-severity advisories through `node-forge` in `@anthropic-ai/sandbox-runtime`, no
  fixed version available; recorded in the changelog.

## What went wrong on the way

1. The first `v0.2.2` tag (on `bb30eb3`) published nothing. `release.yml` capped the dispatch guard suite at
   4 minutes; `ci.yml` allowed 8 and the suite needs about 6 on macOS. Fixed in `e56952d` (12 minutes in
   both workflows, pinned by tests) and the unpublished tag was moved.
2. Release run attempt 1 lost the Ubuntu suite to an intermittent fixture cleanup error (`ENOTEMPTY`) in
   `tests/packaging/release-admission.test.mjs`. Re-run of that job passed. Root cause not measured: #1195.
3. Attempt 2 published, then failed its own read-back: it waits 60 seconds and npm took about 4 minutes to
   show the version. Attempt 3 verified the registry copy without publishing again. #1196.

## Not measured, not done

- Install and `init` from the registry on a real Windows machine or into a real home directory.
- Behaviour of the installed package in a running orchestrator session; installed role instructions change
  only after a forced reinstall.
- `release/0.2.2` is not merged into `main` (pull request 33 is open). Local `main` has 335 unpushed commits
  and uncommitted files, so landing needs the owner's decision.
- Three diagnostic observation workflows are red on the pull request and have been red on every run (#1196).
