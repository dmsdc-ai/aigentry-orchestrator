"""#1177 — owned fake-window / oracle harness for the XRes ownership probe.

PROTOTYPE, ISOLATED LINUX CI ONLY. Standard library only, one synchronous owner from
start to finish. Run by .github/workflows/xres-owned-window-prototype.yml inside that
workflow's own private `xvfb-run`, against the `xres-owner` binary that workflow just
compiled. It is NOT a product module, it is NOT imported by anything, and `ci.yml` is
UNCHANGED in this lane: this harness must succeed on its own before any caller wiring is
proposed as a separate, reviewed change.

WHAT A GREEN RUN HERE MEANS, STATED SO IT CANNOT BE OVERREAD
  Only this: on this one Xvfb build, the probe's verdicts behaved as the r2 contract says
  they must. It is NOT browser acceptance, NOT WebAuthn/TLS execution, NOT
  installed-product acceptance, and it says NOTHING about Windows or about any real
  browser. The pre-existing browser CI failure (Openbox 3.6.1-10 never sets `_NET_WM_PID`
  on its supporting window, so the current readiness proof cannot be satisfied) is NOT
  fixed by anything in this file.

WHAT IT MEASURES (CONTRACT-r2 §D; a failed OR unrun oracle BLOCKS)
  O-1-in-range     the §A.1 correction, by measurement: an XID with bogus resource low
                   bits inside a LIVE client's range. The prediction (the owning pid comes
                   back, with no error) is RECORDED, not asserted. What IS asserted is
                   that such an XID can never come out `owned`.
  O-1-openbox      the same, against Openbox's own range, because a window manager's
                   range is the one that matters here (§A.1 step 7).
  O-G-grab-holds   grab efficacy. A second client destroys the probed window while the
                   probe sits in an artificial delay inside the grab. Step 6 must still
                   find it. If this fails the §A.3 atomicity claim is FALSE and this
                   BLOCKS — no downgrade, no "unlikely in practice".
  O-G-no-grab      the negative control for the above: with the grab removed the same
                   sequence MUST be able to observe `w-absent` at step 6. Without this,
                   O-G-grab-holds could pass because nothing was ever racing.
  O-G-after-ungrab the destroy held during the grab must take effect afterwards.
  O-4-outside      an XID outside every live client's range.
  O-2-self         positive/self against a helper this harness itself forked, which is
                   also what establishes residual R5, the shared PID namespace.
  O-3-discriminate helpers A and B: probing A's window must never answer B's pid.
  O-positive-real  positive against a real Openbox's supporting window, full steps 1-6.
  O-7-owner-exit   the owner exits between window creation and probe.
  O-8-probe-bound  the probe blocked by another client's server grab must hit a bound and
                   refuse, never hang. v1 oracle 8 proposed SIGSTOP on the X server; that
                   is REPLACED here because Xvfb is not a process this harness owns and
                   signalling a foreign process is forbidden. The substitution is recorded
                   as a deviation, not hidden.
  O-5-capability   NOT RUN. There is no XRes-less server, and no server advertising
                   < 1.2, in this lane. Reported OPEN and it BLOCKS. It is never reported
                   as passed.

DISCIPLINE THE HARNESS ITSELF KEEPS
  * Every child is a `Popen` handle this harness created. The handle is the only
    authenticated identity: no pid is ever parsed out of a process list, no name is
    matched, no process group is assumed, and nothing foreign is ever signalled.
  * §B.2 pre/post bracket. v1's "never reaped, so no pid reuse window" is WITHDRAWN:
    `poll()` reaps. So every probe runs inside one bracket — `poll()` immediately before
    the spawn and again immediately after the probe is reaped, with no cached reading. Two
    `None`s mean no reap happened in between, so the pid denotes the same live process
    across the whole probe. A non-`None` at t2 means the child exited AND was just reaped:
    the verdict becomes `exited` and the numeric comparison is DISCARDED (R6).
  * The probe's self-reported verdict is never the only check. When it says `owned`, this
    harness re-compares the printed pid against the handle's own pid, and a disagreement
    is `owner-unreadable`.
  * `w-changed` (§A.4): the harness takes its own `xprop` baseline W, outside any grab,
    and refuses if the probe reports a different W. The un-grabbed interval between the
    two observations is bounded, not pretended away.
  * Artificial controls stay distinguishable from real measurements: the probe discloses
    `mode=`, `grab=` and `instrumented=` in every record, and the real positive REQUIRES
    `mode=wm grab=held instrumented=no`.
  * One cleanup path, reached from success, failure and cancellation alike. The signal
    handler RECORDS ONLY and never raises, so no cleanup can be abandoned part-way.
"""

import os
import re
import signal
import subprocess
import sys
import time

READY_SECONDS = 30.0    # whole Openbox readiness phase, the baseline read included
XPROP_SECONDS = 5.0     # per-xprop bound, clamped to what is left of READY_SECONDS
PROBE_SECONDS = 20.0    # harness bound on one probe; larger than the probe's own grab
                        # bound, so contention normally surfaces as the probe's legible
                        # `grab-unavailable` rather than as this bound's opaque timeout
TERM_SECONDS = 10.0     # bounded join after SIGTERM
KILL_SECONDS = 5.0      # bounded join after SIGKILL
POLL_SECONDS = 0.5      # cancellation poll at each wait taken before cleanup
EVIDENCE_BYTES = 400    # per-stream cap on what one record may carry
GRAB_DELAY_MS = 3000    # O-G artificial in-grab delay
RACE_AT_MS = 1000       # when inside that delay the competing destroy is issued

SUPPORTING = "_NET_SUPPORTING_WM_CHECK"

# The probe's fixed single-record protocol. One strict whole-line pattern, in the field
# order the probe writes. Anything that does not match this is UNPARSABLE, which is
# `owner-unreadable` — it is never partially salvaged.
RECORD = re.compile(
    r"^xres-owner \(verdict=(?P<verdict>[a-z0-9-]+) mode=(?P<mode>[a-z]+)"
    r" grab=(?P<grab>held|absent|unavailable|-) instrumented=(?P<instrumented>yes|no)"
    r" delay-ms=(?P<delay_ms>[0-9]+) window=(?P<window>0x[0-9a-f]+|-)"
    r" probed-xid=(?P<probed>0x[0-9a-f]+|-) existence=(?P<existence>ok|badwindow|-)"
    r" step6=(?P<step6>ok|badwindow|-) xres-status=(?P<xres_status>success|failed|-)"
    r" num-ids=(?P<num_ids>[0-9]+|-) length=(?P<length>[0-9]+|-)"
    r" pid=(?P<pid>[0-9]+|-) owner-pid=(?P<owner_pid>[0-9]+|-)"
    r" server-version=(?P<version>[0-9]+\.[0-9]+|-) x-error=(?P<x_error>[0-9]+/[0-9]+|-)"
    # The three ownership diagnostics, appended by the probe AFTER x-error. `refusal` is
    # matched as an explicit CLOSED alternation, not a character class: an unrecognised
    # token must make the whole record unparsable rather than be carried through as an
    # unknown string, which is the same refusal-on-unknown rule the rest of this file keeps.
    r" ret-client=(?P<ret_client>0x[0-9a-f]+|-) ret-mask=(?P<ret_mask>0x[0-9a-f]+|-)"
    r" refusal=(?P<refusal>xres-status|num-ids-zero|num-ids-many|ids-null"
    r"|client-mismatch|mask-mismatch|length-range|value-null|pid-invalid|-)\)$")

HELPER_READY = re.compile(
    r"^xres-owner-helper \(state=(?P<state>ready|failed)"
    r" window=(?P<window>0x[0-9a-f]+|-) pid=(?P<pid>[0-9]+)\)$")

# Path-shaped tokens are redacted out of DIAGNOSTIC text only. A BOUND on what a record
# may carry, not a parser: it deliberately runs to the next space rather than trying to be
# exact, because redacting more than a path is always safe here and redacting less is not.
PATHLIKE = re.compile(b"/[^ ]*")

CANCELLED = []   # every INT/TERM the handler recorded, first signal first
OWNED = []       # (handle, what) for every child this harness started, oldest first
RESULTS = []     # one Outcome per oracle, in the order they ran


def cancel(number, frame):
    """RECORD ONLY. Never raises, at any interpreter point, so the cleanup path below can
    never be abandoned part-way and no wait is unwound from a handler."""
    del frame
    CANCELLED.append(number)


def note(text):
    sys.stderr.write("xres-prototype: %s\n" % text)
    sys.stderr.flush()


def render(raw):
    """Bounded, path-redacted, printable rendering of one captured stream."""
    if raw is None:
        raw = b""
    cut = len(raw) > EVIDENCE_BYTES
    shown = PATHLIKE.sub(b"<path>", raw[:EVIDENCE_BYTES])
    text = shown.decode("utf-8", "replace").replace("\\", "\\\\").replace('"', '\\"')
    text = "".join(char if 32 <= ord(char) < 127 else "?" for char in text)
    return text + ("<truncated>" if cut else "")


class Outcome(object):
    """One oracle result. `state` is pass, fail or not-run; not-run BLOCKS exactly as fail
    does, and neither is ever rendered as a pass."""

    def __init__(self, name, state, expected, observed, evidence=""):
        self.name = name
        self.state = state
        self.expected = expected
        self.observed = observed
        self.evidence = evidence

    def line(self):
        return ('oracle (name=%s result=%s expected=%s observed=%s evidence="%s")'
                % (self.name, self.state, self.expected, self.observed, self.evidence))


def record(name, state, expected, observed, evidence=""):
    outcome = Outcome(name, state, expected, observed, evidence)
    RESULTS.append(outcome)
    note(outcome.line())
    return outcome


def pause(seconds):
    """A bounded sleep that also ends on a recorded cancellation."""
    end = time.monotonic() + seconds
    while not CANCELLED:
        left = end - time.monotonic()
        if left <= 0:
            return
        time.sleep(min(POLL_SECONDS, left))


def join(child, seconds):
    try:
        child.wait(timeout=seconds)
        return True
    except subprocess.TimeoutExpired:
        return False


def stop(child, what):
    """Stop and join exactly this owned child, synchronously. TERM, bounded join; KILL only
    while this child is still owned and unreaped; bounded final join. Both signals go
    through this handle, which will not signal a child it has already reaped, so no numeric
    pid is signalled after the join and a recycled pid cannot be hit."""
    if child.poll() is not None:
        return None
    child.terminate()
    if join(child, TERM_SECONDS):
        return None
    child.kill()
    if join(child, KILL_SECONDS):
        return None
    return ("the owned %s (pid %d) was still unreaped %gs after SIGKILL"
            % (what, child.pid, KILL_SECONDS))


# ----------------------------------------------------------------- the probe binary ---

def probe_path():
    path = os.environ.get("XRES_OWNER_BIN", "")
    if not path:
        note("problem (XRES_OWNER_BIN is not set, so no probe could be invoked)")
        return None
    return path


def run_probe(argv, bound=PROBE_SECONDS):
    """One bounded probe invocation. Returns (verdict, fields, evidence).

    Classification, and the one place the probe's exit status is read:
      rc 0  -> the record must say `owned`
      rc 2  -> a determinate refusal verdict was printed
      any other rc, a timeout, or output this pattern does not match -> the record is
      unusable and the verdict is `owner-unreadable`. That is v1 §3's "non-zero exit or
      unparsable output", applied where it is the parse that failed rather than to a
      refusal that printed perfectly well.
    """
    binary = probe_path()
    if binary is None:
        return ("owner-unreadable", None, "no probe binary")
    command = [binary] + argv
    try:
        done = subprocess.run(command, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=bound)
    except subprocess.TimeoutExpired as expired:
        return ("owner-unreadable", None,
                "timed-out stdout=\"%s\" stderr=\"%s\""
                % (render(expired.stdout), render(expired.stderr)))
    except OSError as failure:
        return ("owner-unreadable", None, "not-invoked errno=%s" % failure.errno)

    evidence = ("exit-%d stdout=\"%s\" stderr=\"%s\""
                % (done.returncode, render(done.stdout), render(done.stderr)))
    if done.returncode not in (0, 2):
        return ("owner-unreadable", None, evidence)
    lines = [line for line in done.stdout.decode("utf-8", "replace").splitlines() if line]
    if len(lines) != 1:
        return ("owner-unreadable", None, evidence)
    found = RECORD.match(lines[0])
    if not found:
        return ("owner-unreadable", None, evidence)
    fields = found.groupdict()
    # The exit status and the printed verdict must agree, or neither is trustworthy.
    if (done.returncode == 0) != (fields["verdict"] == "owned"):
        return ("owner-unreadable", None, evidence)
    return (fields["verdict"], fields, evidence)


def bracketed_probe(handle, argv, bound=PROBE_SECONDS):
    """§B.2. The probe's whole lifetime nests inside one pre/post `poll()` bracket on the
    owner's handle, with no cached earlier reading, so the server's answer instant is
    inside an interval over which `handle.pid` provably denotes the same live process."""
    if handle is not None and handle.poll() is not None:            # t0
        return ("exited", None, "owner had already exited before the probe was spawned")
    verdict, fields, evidence = run_probe(argv, bound)
    if handle is not None and handle.poll() is not None:            # t2
        # R6: the child exited mid-bracket and was JUST reaped by this very poll. The
        # numeric comparison from this attempt is discarded, not re-run.
        return ("exited", fields,
                "%s; owner exited mid-bracket so the pid comparison is discarded"
                % evidence)
    if verdict == "owned" and handle is not None:
        # The probe's own comparison is never the only check.
        if fields["pid"] == "-" or int(fields["pid"]) != handle.pid:
            return ("owner-unreadable", fields,
                    "%s; printed pid did not match this handle" % evidence)
    return (verdict, fields, evidence)


def artificial(fields):
    """True when this record came from an instrumented or reduced run. Keeps a control
    from ever being counted as an actual, full X server measurement."""
    if fields is None:
        return True
    return fields["instrumented"] == "yes" or fields["mode"] != "wm" or \
        fields["grab"] != "held"


def diagnostics(fields):
    """The probe's three ownership diagnostics, rendered for the two O-G records that build
    their evidence from selected fields rather than carrying the probe's raw stdout — without
    this they are the only failing oracles whose refusal branch stays invisible. Bounded:
    three already-parsed fields, no new parsing and no new output shape. Reports nothing but
    what the record carried, and never influences any pass/fail decision."""
    if fields is None:
        return "ret-client=- ret-mask=- refusal=-"
    return ("ret-client=%s ret-mask=%s refusal=%s"
            % (fields["ret_client"], fields["ret_mask"], fields["refusal"]))


# ----------------------------------------------------------------------- the helper ---

def start_helper(what):
    """Start one owned helper client: it creates one window and answers line commands.
    Returns (handle, window) or (handle, None) when it never reported ready."""
    binary = probe_path()
    if binary is None:
        return (None, None)
    handle = subprocess.Popen([binary, "--mode", "helper"], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=sys.stderr)
    OWNED.append((handle, what))
    line = handle.stdout.readline().decode("utf-8", "replace").strip()
    found = HELPER_READY.match(line)
    if not found or found.group("state") != "ready":
        return (handle, None)
    if int(found.group("pid")) != handle.pid:
        # The helper reports the pid it sees for itself; this handle is the authenticated
        # one. A disagreement is a PID-namespace problem (residual R5) and refuses here
        # rather than silently becoming a wrong comparison later.
        note("problem (helper %s reported pid %s but this handle owns %d)"
             % (what, found.group("pid"), handle.pid))
        return (handle, None)
    return (handle, int(found.group("window"), 16))


def helper_send(handle, command):
    """Send one command and deliberately do NOT read the reply. Under a server grab the
    helper's own request blocks, and WHEN that reply becomes readable is itself the
    observation O-G wants — so reading is always a separate, explicit step."""
    try:
        handle.stdin.write((command + "\n").encode("ascii"))
        handle.stdin.flush()
        return "sent"
    except (BrokenPipeError, ValueError, OSError) as failure:
        return "unreachable-%s" % type(failure).__name__


def helper_reply(handle):
    """Read one pending helper reply, or report that none arrived. This cannot block
    forever: the helper is an owned child, and when it dies its stdout reaches EOF."""
    line = handle.stdout.readline().decode("utf-8", "replace").strip()
    return line if line else "no-reply"


# --------------------------------------------------------------- the xprop baseline ---

def xprop(target, name, deadline):
    """One bounded xprop read. Returns (state, text) with state ok, absent or unknown.
    Unknown is anything that did not come back in a recognised shape and is NEVER reported
    as absence."""
    left = deadline - time.monotonic()
    if left <= 0:
        return ("unknown", "")
    try:
        done = subprocess.run(["xprop"] + target + ["-notype", name],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE,
                              timeout=min(XPROP_SECONDS, left))
    except (subprocess.TimeoutExpired, OSError):
        return ("unknown", "")
    if done.returncode != 0:
        return ("unknown", "")
    text = done.stdout.decode("utf-8", "replace").strip()
    # The two exit-zero absence forms xprop prints for the ONE property it was asked for,
    # aligned with the existing supervisor's parser in ci.yml and no wider.
    if text.endswith("not found.") or text == "%s:  no such atom on any window." % name:
        return ("absent", text)
    return ("ok", text)


def supporting_window(target, deadline):
    state, text = xprop(target, SUPPORTING, deadline)
    if state != "ok":
        return (state, None)
    found = re.match(r"^%s\(WINDOW\): window id # (0x[0-9a-fA-F]+)$" % SUPPORTING, text) \
        or re.match(r"^%s: window id # (0x[0-9a-fA-F]+)$" % SUPPORTING, text)
    if not found:
        return ("unknown", None)
    return ("value", int(found.group(1), 16))


def openbox_ready(wm, deadline):
    """Bounded wait for a real Openbox to register, using the harness's OWN xprop chain.
    This is the observation the probe cannot make — the absent-to-present transition — and
    it does not replace the probe's own in-grab chain; both are required (§A.4)."""
    while True:
        if CANCELLED:
            return ("cancelled", None)
        if wm.poll() is not None:
            return ("exited", None)
        if deadline - time.monotonic() <= 0:
            return ("timeout", None)
        state, window = supporting_window(["-root"], deadline)
        if state != "value":
            pause(1)
            continue
        # The same chain the existing supervisor keeps: W must point back at itself (the
        # EWMH staleness test) and must be named Openbox. The probe re-derives all of it
        # inside its grab; neither chain substitutes for the other.
        state, back = supporting_window(["-id", hex(window)], deadline)
        if state != "value" or back != window:
            pause(1)
            continue
        state, name = xprop(["-id", hex(window)], "_NET_WM_NAME", deadline)
        if state != "ok" or "Openbox" not in name:
            pause(1)
            continue
        return ("ready", window)


# ------------------------------------------------------------------------- oracles ----

def oracle_positive_self(helper_a, window_a):
    """O-2. Positive/self, and the one that establishes residual R5: the pid the server
    reports must equal the pid of a handle this harness itself owns, or the two numbers
    are not even in the same namespace."""
    verdict, fields, evidence = bracketed_probe(
        helper_a, ["--mode", "xid", "--window", hex(window_a),
                   "--owner-pid", str(helper_a.pid)])
    state = "pass" if verdict == "owned" else "fail"
    return record("O-2-self", state, "owned", verdict,
                  "%s server-version=%s" % (evidence,
                                            fields["version"] if fields else "-"))


def oracle_discriminate(helper_a, window_a, helper_b, window_b):
    """O-3. "Returns some local pid" must not pass as exact."""
    checks = []
    # The owner handle bracketed is always the handle that OWNS the probed window, so a
    # mid-probe exit of that owner is what voids the comparison (R6) — never the other
    # helper's liveness, which is irrelevant to the question being asked.
    for name, handle, window, claimed, want in (
            ("a-with-b", helper_a, window_a, helper_b.pid, "owner-foreign"),
            ("b-with-a", helper_b, window_b, helper_a.pid, "owner-foreign"),
            ("b-with-b", helper_b, window_b, helper_b.pid, "owned")):
        verdict, _, evidence = bracketed_probe(
            handle, ["--mode", "xid", "--window", hex(window),
                     "--owner-pid", str(claimed)])
        checks.append((name, want, verdict, evidence))
    failed = [c for c in checks if c[1] != c[2]]
    state = "fail" if failed else "pass"
    return record("O-3-discriminate", state,
                  "; ".join("%s=%s" % (c[0], c[1]) for c in checks),
                  "; ".join("%s=%s" % (c[0], c[2]) for c in checks),
                  " | ".join(c[3] for c in checks))


def oracle_bogus(name, args, note_text):
    """O-1 / O-4. The ASSERTION is only that a deliberately non-existent XID can never be
    `owned` — `w-absent` at step 2 is what refuses it. The XRes call's own behaviour for
    that XID is MEASURED and printed verbatim; no prediction about it is asserted, because
    the whole point of §A.1 is that my reading of a draft spec is not evidence."""
    verdict, fields, evidence = run_probe(["--mode", "bogus"] + args)
    if verdict == "w-absent" and fields is not None:
        state = "pass"
        measured = ("probed-xid=%s existence=%s xres-status=%s num-ids=%s pid=%s"
                    " x-error=%s" % (fields["probed"], fields["existence"],
                                     fields["xres_status"], fields["num_ids"],
                                     fields["pid"], fields["x_error"]))
    elif verdict == "owned":
        state = "fail"
        measured = "the probe returned owned for an XID that is not a live window"
    else:
        state = "fail"
        measured = evidence
    return record(name, state, "w-absent (never owned)", verdict,
                  "%s :: %s :: %s" % (note_text, measured, evidence))


def oracle_grab_holds(helper_a, window_a):
    """O-G. The probe sits in an artificial delay INSIDE the grab while a second client
    destroys the probed window. Step 6 must still find it. If it does not, §A.3's
    atomicity claim is false and this BLOCKS.

    The helper's reply is deliberately read only AFTER the probe has exited: if the grab
    holds, the helper's own destroy request cannot be processed until the ungrab, and that
    blocking is a direct, independent observation of the premise."""
    binary = probe_path()
    if binary is None:
        return record("O-G-grab-holds", "fail", "step6=ok", "no probe binary")
    if helper_a.poll() is not None:                                   # t0
        return record("O-G-grab-holds", "fail", "step6=ok", "exited")
    started = time.monotonic()
    probe = subprocess.Popen(
        [binary, "--mode", "xid", "--window", hex(window_a),
         "--owner-pid", str(helper_a.pid), "--grab-delay-ms", str(GRAB_DELAY_MS)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    OWNED.append((probe, "O-G probe"))
    pause(RACE_AT_MS / 1000.0)
    helper_send(helper_a, "destroy")
    destroy_sent = time.monotonic()
    try:
        out, err = probe.communicate(timeout=PROBE_SECONDS)
    except subprocess.TimeoutExpired:
        probe.kill()
        out, err = probe.communicate()
        return record("O-G-grab-holds", "fail", "step6=ok", "owner-unreadable",
                      "the probe hit the harness bound; stderr=\"%s\"" % render(err))
    probe_exited = time.monotonic()
    if helper_a.poll() is not None:                                   # t2
        return record("O-G-grab-holds", "fail", "step6=ok", "exited",
                      "the helper exited mid-bracket, so this attempt is discarded")
    reply = helper_reply(helper_a)
    replied = time.monotonic()
    # If the destroy was held by the grab, its reply cannot predate the probe's exit.
    blocked = replied >= probe_exited and (probe_exited - destroy_sent) > 0
    lines = [line for line in out.decode("utf-8", "replace").splitlines() if line]
    found = RECORD.match(lines[0]) if lines else None
    if found is None:
        return record("O-G-grab-holds", "fail", "step6=ok", "owner-unreadable",
                      "exit-%d stdout=\"%s\" stderr=\"%s\""
                      % (probe.returncode, render(out), render(err)))
    fields = found.groupdict()
    ok = (fields["grab"] == "held" and fields["existence"] == "ok"
          and fields["step6"] == "ok" and fields["verdict"] == "owned")
    return record("O-G-grab-holds", "pass" if ok else "fail",
                  "grab=held existence=ok step6=ok verdict=owned",
                  "grab=%s existence=%s step6=%s verdict=%s"
                  % (fields["grab"], fields["existence"], fields["step6"],
                     fields["verdict"]),
                  "helper-destroy-reply-blocked-until-ungrab=%s reply=\"%s\""
                  " in-grab-delay-ms=%s elapsed=%.2fs %s"
                  % ("yes" if blocked else "no", reply, fields["delay_ms"],
                     probe_exited - started, diagnostics(fields)))


def oracle_after_ungrab(helper_a, window_a):
    """The destroy that the grab held must have taken effect once the grab was released."""
    verdict, _, evidence = bracketed_probe(
        helper_a, ["--mode", "xid", "--window", hex(window_a),
                   "--owner-pid", str(helper_a.pid)])
    state = "pass" if verdict == "w-absent" else "fail"
    return record("O-G-after-ungrab", state, "w-absent", verdict, evidence)


def oracle_no_grab(helper, window):
    """O-G's negative control. With the grab removed the same delay-then-destroy sequence
    MUST be able to reach `w-absent` at step 6. Without this the positive above could be
    passing because nothing was ever actually racing."""
    binary = probe_path()
    if binary is None:
        return record("O-G-no-grab", "fail", "w-absent at step 6", "no probe binary")
    if helper.poll() is not None:
        return record("O-G-no-grab", "fail", "w-absent at step 6", "exited")
    probe = subprocess.Popen(
        [binary, "--mode", "xid", "--window", hex(window),
         "--owner-pid", str(helper.pid), "--grab-delay-ms", str(GRAB_DELAY_MS),
         "--no-grab"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    OWNED.append((probe, "O-G control probe"))
    pause(RACE_AT_MS / 1000.0)
    helper_send(helper, "destroy")
    try:
        out, err = probe.communicate(timeout=PROBE_SECONDS)
    except subprocess.TimeoutExpired:
        probe.kill()
        out, err = probe.communicate()
        return record("O-G-no-grab", "fail", "w-absent at step 6", "owner-unreadable",
                      "stderr=\"%s\"" % render(err))
    reply = helper_reply(helper)
    lines = [line for line in out.decode("utf-8", "replace").splitlines() if line]
    found = RECORD.match(lines[0]) if lines else None
    if found is None:
        return record("O-G-no-grab", "fail", "w-absent at step 6", "owner-unreadable",
                      "exit-%d stdout=\"%s\"" % (probe.returncode, render(out)))
    fields = found.groupdict()
    ok = (fields["grab"] == "absent" and fields["existence"] == "ok"
          and fields["step6"] == "badwindow" and fields["verdict"] == "w-absent")
    return record("O-G-no-grab", "pass" if ok else "fail",
                  "grab=absent existence=ok step6=badwindow verdict=w-absent",
                  "grab=%s existence=%s step6=%s verdict=%s"
                  % (fields["grab"], fields["existence"], fields["step6"],
                     fields["verdict"]),
                  "control-only (instrumented=%s) helper-reply=\"%s\" %s"
                  % (fields["instrumented"], reply, diagnostics(fields)))


def oracle_owner_exit():
    """O-7. The owner exits between window creation and the probe. Its window goes with
    its connection, so the probe must refuse on EXISTENCE, and the pre/post bracket must
    report `exited` when the same handle is used as the owner."""
    helper, window = start_helper("O-7 helper")
    if helper is None or window is None:
        return record("O-7-owner-exit", "fail", "w-absent then exited",
                      "the helper never reported a window")
    trouble = stop(helper, "O-7 helper")          # our own handle; nothing foreign
    if trouble is not None:
        return record("O-7-owner-exit", "fail", "w-absent then exited", "unstoppable",
                      trouble)
    # The owner is gone, so this probe has no live owner handle to bracket: the existence
    # check is the whole question here.
    verdict, _, evidence = run_probe(["--mode", "xid", "--window", hex(window),
                                      "--owner-pid", str(helper.pid)])
    # And the bracket over the now-reaped handle must say `exited`, never a comparison.
    bracket, _, _ = bracketed_probe(helper, ["--mode", "xid", "--window", hex(window),
                                             "--owner-pid", str(helper.pid)])
    ok = verdict == "w-absent" and bracket == "exited"
    return record("O-7-owner-exit", "pass" if ok else "fail",
                  "probe=w-absent bracket=exited",
                  "probe=%s bracket=%s" % (verdict, bracket), evidence)


def oracle_probe_bound():
    """O-8, REPLACING v1's SIGSTOP-the-X-server oracle. A helper takes a server grab and
    holds it; the probe's first round trip inside its own bracket therefore cannot return.
    The probe MUST come back with a bound-expiry refusal and MUST NOT hang.

    The substitution is deliberate and is a deviation from v1 §9.8: SIGSTOP would mean
    signalling Xvfb, which this harness did not start and does not own."""
    helper, window = start_helper("O-8 helper")
    if helper is None or window is None:
        return record("O-8-probe-bound", "fail", "grab-unavailable or owner-unreadable",
                      "the helper never reported a window")
    helper_send(helper, "grab")
    reply = helper_reply(helper)
    if "command=grab result=ok" not in reply:
        return record("O-8-probe-bound", "fail", "grab-unavailable or owner-unreadable",
                      "the helper could not take a grab", reply)
    started = time.monotonic()
    verdict, _, evidence = bracketed_probe(
        helper, ["--mode", "xid", "--window", hex(window),
                 "--owner-pid", str(helper.pid)])
    elapsed = time.monotonic() - started
    helper_send(helper, "ungrab")
    ok = verdict in ("grab-unavailable", "owner-unreadable")
    return record("O-8-probe-bound", "pass" if ok else "fail",
                  "grab-unavailable or owner-unreadable", verdict,
                  "%s elapsed=%.2fs helper-ungrab=\"%s\""
                  % (evidence, elapsed, helper_reply(helper)))


def oracle_positive_real(wm, seen_window):
    """The one FULL measurement: steps 1-6 against a real Openbox, no instrumentation, and
    cross-checked against the W this harness saw with its own xprop chain (§A.4)."""
    verdict, fields, evidence = bracketed_probe(
        wm, ["--mode", "wm", "--owner-pid", str(wm.pid)])
    if fields is None:
        return record("O-positive-real", "fail", "owned", verdict, evidence)
    if artificial(fields):
        return record("O-positive-real", "fail", "a real, uninstrumented measurement",
                      "mode=%s grab=%s instrumented=%s"
                      % (fields["mode"], fields["grab"], fields["instrumented"]),
                      evidence)
    if fields["window"] == "-" or int(fields["window"], 16) != seen_window:
        # w-changed. The un-grabbed interval between the harness's observation and the
        # probe's step 1 is bounded here rather than pretended away.
        return record("O-positive-real", "fail", "owned", "w-changed",
                      "the harness saw W=0x%x and the probe reported window=%s"
                      % (seen_window, fields["window"]))
    state = "pass" if verdict == "owned" else "fail"
    return record("O-positive-real", state, "owned", verdict,
                  "%s server-version=%s length=%s num-ids=%s"
                  % (evidence, fields["version"], fields["length"], fields["num_ids"]))


def oracle_capability_not_run():
    """O-5. No XRes-less server and no server advertising < 1.2 exists in this lane, so
    this was NOT RUN. It stays OPEN and it BLOCKS. It is not reported as passed, and the
    `xres-unavailable` / `xres-too-old` code paths therefore remain UNEXERCISED."""
    return record("O-5-capability", "not-run",
                  "xres-unavailable / xres-too-old on a server without XRes >= 1.2",
                  "no such server in this lane",
                  "the capability-gate code paths are unexercised and this BLOCKS")


# ---------------------------------------------------------------------------- main ----

def main():
    started = time.monotonic()
    if probe_path() is None:
        return 1

    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGTERM, cancel)

    deadline = started + READY_SECONDS
    cleanup_rc = 0
    wm = None
    try:
        # A supporting window that is ALREADY here belongs to something this harness did
        # not start, and an initial state that could not be READ is not an absent one: the
        # absent-to-present transition is only evidence if the absence was observed.
        state, existing = supporting_window(["-root"], deadline)
        if state == "value":
            note("problem (a supporting window (0x%x) already owned this display before"
                 " the prototype started)" % existing)
            return 1
        if state != "absent":
            note("problem (the initial %s state came back %s, and an unreadable initial"
                 " state is not an absent one)" % (SUPPORTING, state))
            return 1

        # Helper-only oracles first: they need no window manager at all, so a failure here
        # is never confounded with an Openbox problem.
        helper_a, window_a = start_helper("helper A")
        helper_b, window_b = start_helper("helper B")
        if helper_a is None or window_a is None or helper_b is None or window_b is None:
            note("problem (a helper never reported a usable window)")
            return 1

        oracle_positive_self(helper_a, window_a)
        oracle_discriminate(helper_a, window_a, helper_b, window_b)
        oracle_bogus("O-1-in-range", ["--range-of", hex(window_a)],
                     "bogus low bits inside helper A's own live range")
        oracle_bogus("O-4-outside", ["--outside"],
                     "an XID outside every live client's range")

        # O-G consumes helper A's window (that is the point), so it runs after the
        # oracles that need that window alive.
        oracle_grab_holds(helper_a, window_a)
        oracle_after_ungrab(helper_a, window_a)
        # The negative control needs its own live window, because A's is now destroyed.
        helper_c, window_c = start_helper("helper C")
        if helper_c is None or window_c is None:
            record("O-G-no-grab", "fail", "w-absent at step 6",
                   "the control helper never reported a window")
        else:
            oracle_no_grab(helper_c, window_c)

        oracle_owner_exit()
        oracle_probe_bound()

        # The real Openbox, started and owned here, exactly one of them.
        wm = subprocess.Popen(["openbox", "--sm-disable"], stdin=subprocess.DEVNULL,
                              stdout=sys.stderr, stderr=sys.stderr)
        OWNED.append((wm, "Openbox"))
        ready, seen = openbox_ready(wm, time.monotonic() + READY_SECONDS)
        if ready != "ready":
            record("O-positive-real", "fail", "owned",
                   "Openbox never registered (%s)" % ready)
        else:
            oracle_positive_real(wm, seen)
            oracle_bogus("O-1-openbox", ["--range-of", hex(seen)],
                         "bogus low bits inside Openbox's own live range")

        oracle_capability_not_run()
    finally:
        # THE cleanup path, and the only way out of the block above. The handler never
        # raises, so no cancellation can unwind out of it; each owned child is stopped and
        # joined exactly once, newest first. Descendants are deliberately NOT signalled:
        # reaching them would mean assuming a process group.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        for child, what in reversed(OWNED):
            trouble = stop(child, what)
            if trouble is not None:
                note("problem (%s)" % trouble)
                cleanup_rc = 1
        note("cleanup (owned-processes=%d cleanup-errors=%d"
             " unowned-descendants=not-signalled)" % (len(OWNED), cleanup_rc))

    passed = [r for r in RESULTS if r.state == "pass"]
    failed = [r for r in RESULTS if r.state == "fail"]
    unrun = [r for r in RESULTS if r.state == "not-run"]
    note("summary (oracles=%d pass=%d fail=%d not-run=%d elapsed=%.1fs)"
         % (len(RESULTS), len(passed), len(failed), len(unrun),
            time.monotonic() - started))
    for outcome in failed + unrun:
        note("blocking (%s)" % outcome.line())
    note("scope (this is an isolated ownership prototype: NOT browser acceptance, NOT"
         " WebAuthn/TLS execution, NOT installed-product acceptance, and no claim about"
         " Windows or about any real browser follows from it)")

    if CANCELLED:
        note("cancelled (signal=%d)" % CANCELLED[0])
        return 128 + CANCELLED[0]
    if failed or unrun:
        # A failed OR unrun oracle BLOCKS (r2 §D). An unrun oracle is not a pass and this
        # exit status does not distinguish them on purpose.
        return 1
    if cleanup_rc:
        note("problem (every oracle passed but an owned process could not be stopped and"
             " joined, so this run is reported as a failure rather than as a pass)")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
