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
  O-5-capability   a REAL observation, no longer a waiver: a SECOND Xvfb that this
                   harness starts, owns and stops, on a private display, with the
                   X-Resource extension DISABLED at the server (`-extension X-Resource`,
                   Xserver.man:174-178; the name is miinitext.c:158 / XResproto.h:11).
                   The probe there must answer `xres-unavailable` at the capability gate.
                   Three things make it an observation rather than an error. The display is
                   not guessed: the server picks a free number itself and reports it over
                   `-displayfd` on a pipe only that one owned child inherited, read under a
                   fixed byte and time bound (Xserver.man:150-155, connection.c:195-270), so
                   the display provably belongs to this handle's server. The server is
                   PROVED alive and its connection PROVED usable while the capability is
                   absent, so this is never a bad-DISPLAY or refused-connection failure
                   wearing a capability verdict's name. And it is authenticated from its
                   first instant, because its cookie file exists before it is exec'd — see
                   `owned_display` for why that ordering is forced by auth.c:180-202.
                   `xres-too-old` stays UNEXERCISED: no server advertising < 1.2 exists in
                   this lane, and this oracle does not pretend to cover it.

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
import select
import shutil
import signal
import subprocess
import sys
import tempfile
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

# O-5 only. Bounds for the second, XRes-less server this harness starts and owns.
CAP_READY_SECONDS = 20.0    # bounded wait for that server's first usable answer
CAP_TOOL_SECONDS = 5.0      # per `xdpyinfo` and per `xauth` bound
CAP_POLL_SECONDS = 0.5      # gap between readiness attempts, and per pipe wait
# The display number is NOT chosen here and is NOT guessed. The server picks a free one
# itself and reports it back over `-displayfd` [Xserver.man:150-155; connection.c:249-270
# binds the socket BEFORE the number exists, connection.c:195-206 writes it]. These bound
# how long that report may take and how much may be read from the pipe: a display number
# is at most five digits plus the newline the server writes.
CAP_DISPLAYFD_SECONDS = 20.0
CAP_DISPLAYFD_BYTES = 16
CAP_SCREEN = "640x480x24"
# The label the SERVER's own cookie entry carries. It is never examined: the server matches
# entries in its `-auth` file by protocol name alone and never looks at the entry's
# family, address or display number [auth.c:104-141]. The number that matters is on the
# CLIENT side, and that file is written only once the server has said which display it
# bound — see `owned_display`.
CAP_AUTH_PLACEHOLDER = ":0"
# The extension to disable, spelled exactly as the server registers it
# [miinitext.c:158 `{ResExtensionInit, "X-Resource", &noResExtension}`; XResproto.h:11
# `#define XRES_NAME "X-Resource"`]. A misspelling is a NO-OP at the server
# [miinitext.c:212-234], which leaves XRes ENABLED and makes O-5 fail — it can never fake
# a pass.
XRES_EXTENSION = "X-Resource"

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

# The extension list `xdpyinfo` prints, and nothing wider. The count it announces is
# checked against the names actually read, so a shape this does not recognise is UNKNOWN
# and is never reported as "the extension is absent".
#
# The shape is taken from the tool's own source, not from a sample: the header is
# `printf("number of extensions:    %d\n", n)` [xdpyinfo.c:176], and without the
# `-queryExtensions` flag — which this harness never passes — each name is
# `printf("    %s\n", extlist[i])` [xdpyinfo.c:181-184], i.e. exactly four spaces, then the
# name VERBATIM, then the newline. Nothing else is on the line.
#
# A NAME MAY CONTAIN SPACES, which is why the name group runs to the end of the line
# instead of matching one whitespace-free word. `Generic Event Extension` is a registered
# extension name [miinitext.c:105 `{GEExtensionInit, "Generic Event Extension", NULL}`], and
# `xdpyinfo` sorts the list with plain `strcmp` [xdpyinfo.c:165-179], so on an Xvfb that
# builds neither GLX nor DRI3 it lands sixth — which is exactly where the previous
# single-word predicate stopped, announcing 23 and reading 5 (CI-r2.log:465). The names are
# NOT special-cased and no row is skipped: the format simply is "four spaces, then the
# name". If a caller ever did pass `-queryExtensions`, each line would still parse but would
# carry the trailing `(opcode: ...)` text, so the exact `X-Resource` comparison below would
# fail and the oracle would refuse — never silently mis-read.
EXT_HEADER = re.compile(r"^number of extensions:\s+(?P<count>[0-9]+)$")
EXT_NAME = re.compile(r"^ {4}(?P<name>\S.*)$")

# What the server may write on its `-displayfd` pipe, and nothing else: a display number.
# Anything that does not match this whole pattern is malformed and REFUSES.
DISPLAYFD = re.compile(r"^[0-9]{1,5}$")

CANCELLED = []   # every INT/TERM the handler recorded, first signal first
OWNED = []       # (handle, what) for every child this harness started, oldest first
RESULTS = []     # one Outcome per oracle, in the order they ran
PRIVATE = []     # directories this harness created for its OWN X authority cookies


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


def run_probe(argv, bound=PROBE_SECONDS, env=None):
    """One bounded probe invocation. Returns (verdict, fields, evidence).

    `env` defaults to None, which is "inherit this harness's environment" — exactly what
    every oracle but O-5 does, unchanged. O-5 passes an environment whose `DISPLAY` and
    `XAUTHORITY` name ITS OWN private, XRes-less server, so that probe cannot reach, and
    cannot be confused with, the outer display.

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
                              timeout=bound, env=env)
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


def extension_list(env, what):
    """One bounded `xdpyinfo` against exactly the display named in `env` (None inherits
    this harness's own display). Returns (state, names, evidence).

    `ok` means the connection was usable AND the list parsed with the count the server
    itself announced. `unusable` means the display did not answer inside the bound.
    `unknown` is any shape this does not recognise — and an unrecognised shape is NEVER
    reported as an extension being absent, which is the same refusal-on-unknown rule
    `xprop()` above keeps.
    """
    try:
        done = subprocess.run(["xdpyinfo"], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=CAP_TOOL_SECONDS, env=env)
    except subprocess.TimeoutExpired:
        return ("unusable", None,
                "%s xdpyinfo hit its %gs bound" % (what, CAP_TOOL_SECONDS))
    except OSError as failure:
        return ("unknown", None, "%s xdpyinfo not-invoked errno=%s" % (what, failure.errno))
    if done.returncode != 0:
        return ("unusable", None, "%s xdpyinfo exit-%d stderr=\"%s\""
                % (what, done.returncode, render(done.stderr)))
    lines = done.stdout.decode("utf-8", "replace").splitlines()
    for index, line in enumerate(lines):
        header = EXT_HEADER.match(line)
        if header is None:
            continue
        names = []
        for rest in lines[index + 1:]:
            found = EXT_NAME.match(rest)
            if found is None:
                break
            names.append(found.group("name"))
        # The announced count must equal what was read, or this output was not the shape
        # this parser understands and no conclusion about any extension follows from it.
        if len(names) != int(header.group("count")):
            # The line that stopped the parse, bounded and rendered by the same path-redacting
            # `render` every other record uses. Without it, a count mismatch says only that
            # the parse failed and not WHERE — which is how the previous mismatch reached CI
            # unmeasured (CI-r2.log:465). What this may disclose is the extension-name text of
            # a display started by this job: no environment, no cookie, no file path, and no
            # more than one line.
            stopped = lines[index + 1 + len(names)] if index + 1 + len(names) < len(lines) \
                else ""
            return ("unknown", None,
                    "%s xdpyinfo announced %s extensions and %d were read; the first line"
                    " that did not parse was \"%s\""
                    % (what, header.group("count"), len(names),
                       render(stopped.encode("utf-8", "replace"))))
        return ("ok", names, "%s extensions=%d" % (what, len(names)))
    return ("unknown", None, "%s xdpyinfo printed no extension count" % what)


def without_display(environ):
    """A copy of `environ` with any inherited display and authority REMOVED. Used for the
    one process that must not reference the outer display at all: O-5's own X server."""
    stripped = dict(environ)
    stripped.pop("DISPLAY", None)
    stripped.pop("XAUTHORITY", None)
    return stripped


def add_cookie(authority, display, cookie):
    """Write ONE MIT-MAGIC-COOKIE-1 entry with `xauth`, bounded. Returns None, or trouble
    text.

    The command goes in on STDIN (`xauth source -`), never on the argv, so the cookie value
    never appears in any process's command line — the same reason Debian's `xvfb-run` feeds
    `xauth` a heredoc. It is not logged here either; a cookie whose entry failed to be
    written is never used for anything and dies with this run.
    """
    try:
        added = subprocess.run(["xauth", "-f", authority, "source", "-"],
                               input=("add %s . %s\n" % (display, cookie)).encode("ascii"),
                               stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, timeout=CAP_TOOL_SECONDS)
    except (subprocess.TimeoutExpired, OSError) as failure:
        return ("the %s cookie entry could not be written (%s)"
                % (display, type(failure).__name__))
    if added.returncode != 0:
        return ("xauth exit-%d for the %s entry stderr=\"%s\""
                % (added.returncode, display, render(added.stderr)))
    return None


def read_displayfd(pipe, server):
    """Read the display number THIS server chose, from the pipe only it inherited.

    Returns (number-as-text, evidence) or (None, why-it-refused). Strict and bounded: at
    most CAP_DISPLAYFD_BYTES bytes, within CAP_DISPLAYFD_SECONDS, terminated by the newline
    the server writes [connection.c:195-206]. EOF, an over-long or malformed value, a
    timeout, or a server that is not alive when the value arrives all REFUSE. There is no
    fallback and nothing is guessed: if the pipe did not say it, this harness does not know
    it.
    """
    deadline = time.monotonic() + CAP_DISPLAYFD_SECONDS
    buffered = b""
    while b"\n" not in buffered:
        if CANCELLED:
            return (None, "cancelled while waiting for the display number")
        left = deadline - time.monotonic()
        if left <= 0:
            return (None, "no display number within %gs (%d bytes read)"
                    % (CAP_DISPLAYFD_SECONDS, len(buffered)))
        try:
            ready = select.select([pipe], [], [], min(CAP_POLL_SECONDS, left))[0]
        except OSError as failure:
            return (None, "the display pipe could not be waited on, errno=%s"
                    % failure.errno)
        if not ready:
            if server.poll() is not None:
                return (None, "the owned server exited with %d before reporting a display"
                        % server.returncode)
            continue
        try:
            chunk = os.read(pipe, CAP_DISPLAYFD_BYTES + 1 - len(buffered))
        except OSError as failure:
            return (None, "the display pipe could not be read, errno=%s" % failure.errno)
        if not chunk:
            # Only this server held the write end, so EOF means it closed or died without
            # reporting. It is a refusal, never an invitation to pick a number.
            return (None, "the display pipe reached EOF after %d bytes, so the owned server"
                    " never reported a display" % len(buffered))
        buffered += chunk
        if b"\n" not in buffered and len(buffered) > CAP_DISPLAYFD_BYTES:
            return (None, "the display pipe sent more than %d bytes with no newline"
                    % CAP_DISPLAYFD_BYTES)
    text = buffered.split(b"\n")[0].decode("ascii", "replace")
    if not DISPLAYFD.match(text):
        return (None, "the display pipe sent \"%s\", which is not a display number"
                % render(buffered))
    # The write end was inherited by THIS child alone, so a number that arrives here while
    # that child is alive names a display THIS handle's server bound: the socket is created
    # before the number exists [connection.c:249-270] and the number is written afterwards
    # [connection.c:195-206]. This is the ownership binding, and it replaces guessing.
    if server.poll() is not None:
        return (None, "the owned server exited with %d as its display number arrived"
                % server.returncode)
    return (text, "displayfd=%s bytes=%d" % (text, len(buffered)))


def owned_display():
    """Start the ONE Xvfb O-5 owns, and let the SERVER choose and report its own display.

    Returns (handle, env, names, evidence). `names` is non-None only when that server
    answered and its extension list parsed; `handle` is None only when nothing was started
    and so nothing needs stopping. Every handle it does create is OWNED, so the one cleanup
    path stops and joins it even when this function gives up, and both pipe ends are closed
    on every path.

    WHY THE DISPLAY NUMBER IS NOT CHOSEN HERE
      A guessed `:N` cannot be attributed to this handle: a foreign server may already hold
      `N`, and mitigations around that (a fresh cookie, poll/query/poll) narrow the window
      without proving whose server answered. So the server picks instead. `-displayfd`
      makes it "attempt to listen on successively higher display numbers, and upon finding
      a free one, write the display number back on this file descriptor as a
      newline-terminated string" [Xserver.man:150-155] — the socket is bound BEFORE the
      number is knowable [connection.c:249-270], and the write end of the pipe is inherited
      by this ONE child and by nothing else (`pass_fds`, and Python's fds are
      close-on-exec otherwise). No display number is passed on the argv, because an
      explicit one would take precedence over `-displayfd` [connection.c:249].

    THE AUTHENTICATION ORDERING, AND WHY IT IS THIS WAY ROUND
      The server's `-auth` file MUST exist before the server accepts its first client:
      `CheckAuthorization` loads it on the first connection, and if it finds no valid
      entries it calls `EnableLocalAccess()` [auth.c:180-202] — i.e. creating the cookie
      only after `-displayfd` reports would leave a genuine window in which any local
      client could connect unauthenticated. So the server's cookie file is written BEFORE
      exec and is never rewritten afterwards.
      That is possible without knowing the display number because the server matches
      entries in that file by protocol NAME alone and never examines the entry's family,
      address or display number [auth.c:104-141, `LoadAuthorization`]; one valid entry is
      also what makes it call `DisableLocalAccess()` [auth.c:197-199]. The display number
      only matters to the CLIENT side, which looks an entry up by display — so a second
      file, carrying the SAME cookie under the display the server actually reported, is
      written once that number is known and before any client connects. Two files, one
      cookie, no rewrite of the file the server reads, and no unauthenticated instant.
      `-ac` is never passed, `-nolisten tcp` keeps the server off the network entirely
      [Xserver.man:220-226], `-extension X-Resource` disables the named extension
      [Xserver.man:174-178, options "all of the X servers accept" Xserver.man:70], and the
      cookie is 128 bits from `os.urandom` inside a `mkdtemp` (0700) directory. No personal
      display, cookie or authority is inherited or reused, and the cookie value is never
      printed.
    """
    try:
        directory = tempfile.mkdtemp(prefix="xres-o5-")
    except OSError as failure:
        return (None, None, None, "no private directory errno=%s" % failure.errno)
    PRIVATE.append(directory)
    server_auth = os.path.join(directory, "server.auth")
    client_auth = os.path.join(directory, "client.auth")
    cookie = os.urandom(16).hex()

    # BEFORE exec, so there is no instant at which this server would enable local access.
    trouble = add_cookie(server_auth, CAP_AUTH_PLACEHOLDER, cookie)
    if trouble is not None:
        return (None, None, None, trouble)

    try:
        reader, writer = os.pipe()
    except OSError as failure:
        return (None, None, None, "no display pipe errno=%s" % failure.errno)
    server = None
    try:
        try:
            server = subprocess.Popen(
                ["Xvfb", "-displayfd", str(writer), "-screen", "0", CAP_SCREEN,
                 "-nolisten", "tcp", "-extension", XRES_EXTENSION, "-auth", server_auth],
                stdin=subprocess.DEVNULL, stdout=sys.stderr, stderr=sys.stderr,
                # The write end, and nothing else, crosses into this ONE child. Every other
                # child this harness starts keeps Python's default close-on-exec, so no
                # other process can hold that end open or write to it.
                pass_fds=(writer,),
                # The outer display and its cookie are REMOVED rather than a new
                # environment invented: this server is told nothing about them, and nothing
                # else about the runner's environment is changed. It takes its display from
                # `-displayfd` and its authority from `-auth`.
                env=without_display(os.environ))
        except (OSError, ValueError) as failure:
            return (None, None, None, "Xvfb not-invoked (%s)" % type(failure).__name__)
        OWNED.append((server, "O-5 Xvfb"))
        # The parent's copy of the write end goes NOW: while it is open, a dead server would
        # not show up as EOF and the read below could only end at its timeout.
        os.close(writer)
        writer = -1
        number, startup = read_displayfd(reader, server)
    finally:
        if writer >= 0:
            os.close(writer)
        os.close(reader)
    if number is None:
        return (server, None, None, startup)

    display = ":%s" % number
    env = dict(os.environ)
    env["DISPLAY"] = display
    env["XAUTHORITY"] = client_auth
    trouble = add_cookie(client_auth, display, cookie)
    if trouble is not None:
        return (server, env, None, "%s | %s" % (startup, trouble))

    deadline = time.monotonic() + CAP_READY_SECONDS
    last = "it never answered"
    while True:
        if CANCELLED:
            return (server, env, None, "%s | cancelled while starting" % startup)
        if server.poll() is not None:
            return (server, env, None, "%s | the owned server exited with %d before"
                    " answering on %s" % (startup, server.returncode, display))
        state, names, evidence = extension_list(env, display)
        if state == "ok":
            return (server, env, names, "%s %s" % (startup, evidence))
        last = evidence
        if deadline - time.monotonic() <= 0:
            return (server, env, None, "%s | %s not usable within %gs (%s)"
                    % (startup, display, CAP_READY_SECONDS, last))
        pause(CAP_POLL_SECONDS)


def oracle_capability():
    """O-5, as a REAL observation. This REPLACES the unrun waiver, which asserted nothing
    and left the probe's `xres-unavailable` / `xres-too-old` branches unexercised.

    The measurement is the probe against a second Xvfb this harness starts, owns and stops,
    on a private display, with X-Resource disabled at the server. The whole difficulty of
    this oracle is that "the capability is missing" must not be satisfied by a server that
    is not there, and must not be satisfied by a server that is not OURS: a bad DISPLAY, a
    refused connection or a wrong cookie all end in `XOpenDisplay` returning NULL, which the
    probe reports as no record at all [xres-owner.c:713-719] and which would prove NOTHING
    about the gate; and a display number this harness merely picked could belong to somebody
    else's server, which would make any verdict about it meaningless. So six things are
    required, and each is an observation:

      0. OWNERSHIP, first, because everything below is a claim about one server: the display
         number is not chosen or guessed here. It is read from the `-displayfd` pipe whose
         write end was inherited by this one owned child and by nothing else, within a fixed
         byte and time bound, and only while that child is alive — see `owned_display` and
         `read_displayfd`. EOF, a malformed value or the bound expiring REFUSE. So the
         display below is one THIS handle's server bound, not one that happened to answer.
      1. CONTROL, on the outer display: `xdpyinfo` there MUST advertise X-Resource. If it
         does not, an absence on the owned display is not evidence that `-extension` did
         anything, and this refuses instead of passing.
      2. PRE-CHECK, owned display: `xdpyinfo` exits zero — a real connection and a real
         round trip, so the server is up and the cookie works — its extension list is
         non-empty, and X-Resource is NOT in it.
      3. LIVENESS BRACKET, the §B.2 discipline reused: `poll()` returns None immediately
         before the probe and again immediately after it, with no cached reading, so the
         server was alive across the probe's entire lifetime.
      4. POST-CHECK: the same server, still usable and still without X-Resource, after the
         measurement.
      5. GATE-BEFORE-ANY-STEP: the record must carry `server-version=- existence=- step6=-
         xres-status=-`, which is only reachable by refusing at the capability gate
         [xres-owner.c:740-748] rather than at any window step.

    The exit status is asserted without a new output shape: `run_probe` returns a verdict
    other than `owner-unreadable` only for rc 0 or rc 2, and rc 0 iff `owned`, so
    `verdict=xres-unavailable` ENTAILS rc 2 — the non-zero exit v1 §9.5 requires of a
    capability refusal.

    Anything else — another verdict, an unparsable record, a timeout, a server that will
    not start, a failed control or a failed pre/post check — is `fail`. Never `not-run`,
    never `pass`. `xres-too-old` is NOT covered: no server advertising < 1.2 exists in this
    lane, and that is stated in the evidence rather than implied away.
    """
    expected = ("xres-unavailable from a live, usable server with %s disabled"
                % XRES_EXTENSION)

    state, names, control = extension_list(None, "outer-display")
    if state != "ok":
        return record("O-5-capability", "fail", expected,
                      "the control display could not be read (%s)" % state, control)
    if XRES_EXTENSION not in names:
        return record("O-5-capability", "fail", expected,
                      "the control display does not advertise %s either, so an absence on"
                      " a private display would prove nothing" % XRES_EXTENSION, control)

    # ONE attempt, on the display the owned server itself reported. There is no second
    # candidate and no fallback: a display this harness cannot attribute to its own handle
    # is not a display it will draw a capability conclusion from.
    server, env, before, startup = owned_display()
    if before is None:
        return record("O-5-capability", "fail", expected,
                      "no server this harness owns reported a usable display", startup)
    if not before:
        return record("O-5-capability", "fail", expected,
                      "the owned server advertised no extension at all, which is not an"
                      " extension list this may draw a conclusion from", startup)
    if XRES_EXTENSION in before:
        return record("O-5-capability", "fail", expected,
                      "the owned server still advertises %s, so the extension was not"
                      " disabled" % XRES_EXTENSION, startup)

    if server.poll() is not None:                                     # t0
        return record("O-5-capability", "fail", expected,
                      "the owned server exited before the probe was spawned", startup)
    # `--mode bogus --outside` is the only mode that claims neither a window XID nor an
    # owner pid, and the capability gate runs BEFORE all mode-specific work, so this asks
    # the gate and nothing else. Its own instrumentation flag is never even reached.
    verdict, fields, evidence = run_probe(["--mode", "bogus", "--outside"], env=env)
    if server.poll() is not None:                                     # t2
        return record("O-5-capability", "fail", expected,
                      "the owned server exited mid-bracket, so this attempt is discarded"
                      " rather than read as a capability result", evidence)

    state, after, post = extension_list(env, "owned-after")
    if state != "ok" or not after or XRES_EXTENSION in after:
        return record("O-5-capability", "fail", expected,
                      "the owned server was not still usable-and-XRes-less after the"
                      " probe (%s)" % state, "%s | %s" % (evidence, post))

    gated = (fields is not None and fields["version"] == "-"
             and fields["existence"] == "-" and fields["step6"] == "-"
             and fields["xres_status"] == "-")
    ok = verdict == "xres-unavailable" and gated
    return record("O-5-capability", "pass" if ok else "fail", expected,
                  "verdict=%s gate-before-any-step=%s"
                  % (verdict, "yes" if gated else "no"),
                  "%s :: control=\"%s\" owned-display=%s (%s) before=%d-extensions %s ::"
                  " xres-too-old remains UNEXERCISED (no server advertising < 1.2 in this"
                  " lane)"
                  % (evidence, control, env["DISPLAY"], startup, len(before), post))


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

        # Last, and on its OWN private server: everything above measures the outer display,
        # and O-5 must not disturb it.
        oracle_capability()
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
        # The private authority directories go last, once the server that was reading one
        # has been stopped and joined. A cookie this harness created and could not remove is
        # treated exactly as an unstoppable child is: reported, and the run is not a pass.
        for directory in PRIVATE:
            try:
                shutil.rmtree(directory)
            except OSError as failure:
                note("problem (a private authority directory could not be removed,"
                     " errno=%s)" % failure.errno)
                cleanup_rc = 1
        note("cleanup (owned-processes=%d private-authorities=%d cleanup-errors=%d"
             " unowned-descendants=not-signalled)"
             % (len(OWNED), len(PRIVATE), cleanup_rc))

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
