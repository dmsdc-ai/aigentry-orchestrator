# Current-screen readiness (#751)

Status: implementation authorized by user reply
`call_1YFDenrfyTUKaxtIlAHMel8g/0`; independent acceptance pending.

## Evidence and Scope

The previous bt751cm/bf1177aj/st1171ad wave observed idle Claude prompts through
cmux while session-probe consumed telepty's historical output and returned
`hard-negative` / `working`. No forced Enter or readiness bypass is authorized.
The inspected cmux CLI additionally sets `scrollback=true` for `--lines`.

The controller's narrow exception owns `bin/session-probe.py` and its new
read-only adapter module `bin/current_screen.py`, plus its single install-list
entry in `bin/init/manifest.mjs`. They form one coupled change.
No dispatch, cleanup, daemon, permissions or transport actuation changes.

## Contract

- Live readiness consumes a current viewport, never a historical output ring.
- Adapter selection uses the target session's backend, not the controller's
  active window. Unsupported backends return unknown, not historical fallback.
- The cmux adapter requires local session identity, exact workspace/surface UUIDs,
  connected owner, and matching process TTY. Check process incarnation, terminal
  mapping and session identity before/after reading. Never select by title/index.
- Read the exact surface with no `--lines` or `--scrollback`; validate returned
  identities. Bound command time and accepted response size. Never log raw screen,
  command errors, credentials or user content in probe errors.
- Error, missing/changed identity, missing owner, unreadable/blank/control-laden
  viewport, unsupported backend and malformed responses fail closed. They cannot
  establish readiness, started work, completion or approval.
- Preserve capture-file fixtures as explicit offline observations. Existing
  historical classifiers remain available for fixture regression, not live input.
- Current readiness requires a prompt at the live footer; modal/error/unsubmitted
  states cannot become ready. Claude's framed composer bounds its live controls so
  historical spinner glyphs above the composer do not mean it is currently busy.
  Working/interrupt controls at the footer still block dispatch. Unrecognized
  controls fail closed; the detector never answers an approval.
- This is a sampled observation, not an atomic read-and-inject guarantee. No claim
  of cryptographic session authentication or full cross-terminal acceptance.

## Verification and Release Gates

Independent tester: same frozen baseline/candidate fake CLI harness, historical
busy vs actual idle reproduction, active/modal/error/unsubmitted/blank negatives,
unsupported backend, UUID/TTY/incarnation/reconnect changes, missing tools,
malformed/oversized/timed-out reads, exact argv (no history/actuation), fixture
regressions, and no completion/approval inference. Fake processes only.
Controller compile check is not independent testing. Real confined dispatch and
target follow-up require a builder validation after hermetic tests. Security,
package/init availability of the adjacent module, cross-OS/cross-terminal,
installed upgrade/recovery and release gates remain open. Do not replace the
current daemon or migrate data. #751 remains incomplete.
