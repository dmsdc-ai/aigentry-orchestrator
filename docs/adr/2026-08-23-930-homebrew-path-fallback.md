# ADR — #930: homebrew is a PATH fallback, not an override

- **Date:** 2026-08-23
- **Status:** Accepted, live on every shim as of `097877b` (PR #30)
- **Supersedes:** the deferred question recorded in `bin/session-cleanup.sh:34-41` and
  restated in four port headers as "NAMED TENSION, pre-existing, mentioned not changed"

## Decision

Every `bin/*.sh` exec shim **appends** the standard directories instead of prepending
them, and resolves `telepty` explicitly into the `TELEPTY` seam the implementations
already read:

```sh
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
: "${TELEPTY:=$(command -v telepty 2>/dev/null || true)}"
[ -n "$TELEPTY" ] || TELEPTY=telepty
export TELEPTY
```

Identical in all 13 shims, including those that never spawn `telepty`. A policy that
differed per shim is how the prefix survived four ports.

## Context

`export PATH="/opt/homebrew/bin:…:$PATH"` put homebrew ahead of the caller's PATH for
every binary. That prefix is named as the cause of **#400**: a stale homebrew `telepty`
answered against a running daemon of a different version, and the version-mismatch banner
contaminated a `jq` stdin. `session-cleanup.sh` was fixed by deleting the prefix outright;
the other shims kept it byte-identical because each port was surgical and nobody was
allowed to decide.

Homebrew could not simply be deleted everywhere: a shim reached from launchd inherits a
minimal PATH with no `node` and no `python3`, and `session-cleanup.sh` could drop it only
because nothing there needs them. Hence *demoted*, not deleted.

### What was measured (2026-08-23, the dispatching host)

```
telepty                   -> ~/.nvm/versions/node/v20.20.0/bin/telepty  -> …/aigentry-telepty/cli.js  0.8.1
/opt/homebrew/bin/telepty ->                                              …/aigentry-telepty/cli.js  0.8.1
```

**Both resolved to the same file.** No mismatch was firing. The decision does not rest on
a live divergence — it rests on there being *two independent symlinks* that the shims
followed homebrew's side of regardless of what the operator runs, which diverge the moment
either side is upgraded. Recording this honestly matters: an earlier framing claimed the
two "resolve differently", and that is not what the measurement showed.

The argument that actually settled it was accidental. `tests/dispatch/T137` — the guard
written to prove the prefix is dangerous — **reached the production daemon through that
prefix**: it unset `TELEPTY` to prove a shim can still find `node` under launchd, and the
shim resolved a real `telepty` off the appended homebrew path and sent four genuine HOLDs
into the operator's live session. #400's mechanism, live, inside the test that exists to
close it. Measured rather than reasoned.

## Consequences

- The operator's `telepty` wins where there is one; launchd still finds homebrew's where
  there is not.
- `tests/dispatch/T137` pins which `telepty` a reconcile tick resolves, through step 0d's
  real spawn. It unsets the absolute `TELEPTY` that `lib.sh` exports for every other
  guard — that export is why nothing caught this earlier.
- `tests/dispatch/T129` block G is unblocked on Linux in principle (the prefix no longer
  outranks its lister stubs) but its precondition still keys on the four prefix dirs, so
  it still declines there. Open, and deliberately not changed from a darwin box.

## HOW WE WOULD KNOW THIS WAS WRONG

The failure mode of this decision is the mirror of the one it fixed: homebrew was
outranking the operator's PATH, and something may have been quietly depending on that.
A shim now prefers whatever the **caller's** environment provides, so the risk moved from
"wrong binary from homebrew" to "wrong-or-missing binary from an impoverished or unusual
inherited PATH". Concretely, revisit this decision on any of:

1. **A shim fails to find `node` or `python3` under launchd.** Symptom: the reconciler
   stops ticking, or `state/dispatch/alerts.log` fills with
   `ERR <helper> non-zero (continuing)`; running the shim by hand from a login shell
   works. That means the appended fallback is not being reached — the fallback is the
   whole reason the homebrew entry survives, and losing it is the one regression that
   would make deleting-vs-demoting the wrong call.
2. **A shim resolves a `telepty` OLDER than the daemon** — i.e. #400 in reverse, sourced
   from the caller rather than from homebrew. Symptom: a `Daemon version mismatch` banner
   in a helper's output, or `Invalid numeric literal at line 1, column 2` from a `jq`
   whose stdin was contaminated by it. The prefix used to mask a stale entry early in an
   operator's own PATH; nothing masks it now.
3. **Two shims in one tick disagree about which `telepty` they used.** Symptom:
   inconsistent `telepty list` output between helpers in the same 60s tick, or a
   dispatch that registers under one daemon and reports to another. Each shim resolves
   independently at start-up, so a PATH that changes mid-session can split them.
4. **A cron/CI/container context with a PATH that has neither the operator's tools nor
   homebrew** starts failing where it used to pass, because the prefix was previously
   supplying `/usr/bin:/bin` *ahead* of a broken inherited entry rather than behind it.
5. **`T137` starts passing trivially everywhere.** It asserts resolution ORDER, not
   identity; on a host with no second `telepty` it cannot fail. If the second binary
   disappears fleet-wide, the guard stops carrying signal and the decision is no longer
   being tested — that is a reason to strengthen the guard, not to relax the rule.

**Not evidence against it:** the two symlinks continuing to agree. They agreed on the day
the decision was made; that is the latent state the decision exists to survive, not a sign
it was unnecessary.

**If (1) fires, the fix is not to restore the prefix** — it is to make the fallback
reachable for `node`/`python3` specifically, which is all the homebrew entry was ever
needed for. Restoring the prefix restores #400.
