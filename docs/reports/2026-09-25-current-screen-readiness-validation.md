# Current-screen readiness validation (#751)

Measured 2026-09-25. Source candidate `b4d62ca` on
`fix/751-current-screen-readiness-20260925`, based on `6f51593`.
This is a bounded corrective result, not release or installed acceptance.

## Change

Live readiness now reads the target's current viewport rather than telepty's
historical output. The cmux adapter checks exact workspace/surface UUIDs, owner
TTY/process incarnation and session binding before/after observation. Missing,
changed, unsupported or unreadable targets fail closed. No active-window,
title/index or history fallback. No forced Enter or readiness bypass was added.

Completed duration rows no longer imply active work. Current busy/modal controls
still block; inline reply prose is not mistaken for a modal. Unknown duration
forms stay unknown/static/not-started. The legacy fixture path is preserved.
`bin/current_screen.py` has an adjacent-module init manifest entry.

## Independent Evidence

Confined tester `rr751co-tester`, task751, attempt
`58c68887-e7a5-4e2b-85d3-95322cb14df2`; operation `rr751co-v5`.
Candidate probe SHA256:
`a5f05d71d3709d4f681581863f3e92e588f2096c7c2d19ccf1541f0cd3ff8db1`.
Adapter SHA256:
`71af53ba38b325e4ca17856b56b6f32a3a270bb512e18152a2f6d84082af5999`.

| Suite | Candidate result |
|---|---|
| Prefix/ambiguous-duration corrective assertions | 25 pass, 0 fail |
| Modal/current-viewport assertions | 30 pass, 0 fail, 7 observations |
| Focused delta assertions | 27 pass, 0 fail, 1 observation |
| Unmodified historical suite | 82 pass, 2 fail, 6 observations |

The two retained failures P2/P2b expect ready=true for a tester-invented token-count
suffix, not a measured CLI format. Current XS-1/XS-2 assert the opposite safety
contract and pass: unknown/static, neither ready nor verified started. Historical
failures were not deleted or reported as passing; the historical runner exits1.
R4 unsafe decorated-modal false-readies were reproduced and closed by R5.
T28 reports 8 cases plus 3 cleanup gates passing; T102 A/B ports pass, C-G untested.
One actual current viewport was captured; no universal vendor-UI grammar claim.
Controller checks were Python compile, Node syntax and git diff checks, not tests.

All 88 revision-manifest leaves were rehashed before preservation. Local evidence:
`aigentry-validation/rr751co`, plus main Git archive
`refs/archive/task751/rr751co-v5-20260925` (tar SHA256
`cb57ed45ebca9cae38d858d239358511e7650d753170abc5fd134ec205a02945`).
Corrected tester report SHA256:
`a95ca442224fb99f60def7c97376a2c955fa795cb59b975acedb2c68cf53955e`.
Actual PTY REPORT recovered through authenticated telepty; scoped worker push
remains unavailable. Receipt, semantic ACK and correctness are distinct facts.

## Remaining Gates

Hermetic fakes are not installed execution. Package/init/module resolution,
upgrade/recovery, standard-CI integration of this evidence harness, security scan,
builder acceptance and broader current-viewport fixtures remain open. Only cmux
has a current-screen adapter; other terminals return unknown, not support claims.
Cross-OS/terminal acceptance and atomic read-and-inject ownership are not proved.
Other conservative error classifiers can still reject quoted error prose.
No daemon restart, data migration, credential access or permission expansion.
Do not merge or publish this candidate as production-complete on these results.
