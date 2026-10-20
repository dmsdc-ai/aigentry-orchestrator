#!/usr/bin/env python3
"""dispatch-registry.py — the ONLY writer of the orchestrator dispatch registry.

telepty#60 Stage A. The registry used to be one overloaded `status` string that
prompt glyphs, git commits, cleanups and disconnects could all set to a terminal
value. It is now four independent axes:

    outcome      what the assigned session REPORTED. Creation-only in 0.8.0:
                 {"state": "unknown", "reported_value": null}. There is no
                 operation here that can move it, because there is no
                 measurement in 0.8.0 that could license one. The authenticated
                 correlated report protocol is Stage B (#816 / #817).
    lifecycle    where the dispatch is in ITS OWN process (attempt started,
                 delivery unknown, re-dispatched, superseded, cleaned, quarantined…).
    gate         whether a human is holding it (HITL).
    observations everything that was measured, each explicitly nonterminal.

Registry mutations hold an exclusive native lock on a STABLE sibling lockfile
(never the active.json inode, which an atomic rename replaces). Read-only
check-dedup/get/list/snapshot remain unlocked. POSIX writes use full schema
validation, same-directory temp file, fsync(temp), atomic rename, fsync(directory).
Native Windows writes use the same sequence without fsync(directory), which Windows
does not have: NTFS journals the rename, so the level there is file-fsync-only.
Corruption is fail-closed: bytes are preserved, a health line
is written OUTSIDE the corrupt file, and nothing is delivered, pruned or
restored. There is no `r+ → truncate → json.dump` path anywhere.

Article 17: Python standard library only.

Exit codes: 0 ok · 4 usage · 7 delivery-unknown/retry-held · 8 deduplicated ·
9 registry error.
"""

from __future__ import annotations

import base64
import datetime
import errno
import hashlib
import json
import math
import os
import re
import shutil
import stat
import sys
import time
import uuid

if os.name == "nt":
    import msvcrt
else:
    import fcntl

OK, USAGE, RETRY_HELD, DEDUPLICATED, REGISTRY_ERROR = 0, 4, 7, 8, 9

SCHEMA_VERSION = 2
LOCK_TIMEOUT_S = 10.0

# Lifecycles that are finished with: pruning may reclaim them and the pollers
# skip them. None of them says anything about the TASK.
RETIRED_LIFECYCLES = {"cleaned", "cutover_retired", "delivery_failed", "not_delivered",
                      "superseded"}

# #1170 report obligation (the `report` key, additive). Resolutions the pump still
# scans — and that pruning must therefore never reclaim, whatever the lifecycle (the one
# exception, a retired failed_seen past the scan window, is archived first: op_prune).
REPORT_RESOLUTIONS = {"open", "done", "rework_requested", "rejected", "failed_seen",
                      "not_delivered", "legacy_unbound", "legacy_seen"}
REPORT_KEEP = {"open", "rework_requested", "failed_seen", "legacy_unbound"}
REPORT_ITEM_RE = re.compile(r"(REPORT|HOLD)-([1-9]|[12][0-9]|3[0-2])")
# #1136 hook-written turn-end status: own seq space, never a final, never resolves anything.
REPORT_TURN_RE = re.compile(r"TURN-([1-9]|[1-5][0-9]|6[0-4])")
REPORT_MAX_TURNS = 64
REPORT_FAILURE_EVENTS = {"exited", "dead", "gone", "cleaned", "overdue", "delivery_unknown",
                         "item_conflict", "item_invalid", "hook_degraded"}
REPORT_SUBMIT = {"consumed", "queued", "unknown", "gate_timeout", "failed"}
REPORT_VERDICTS = {"REPORT": {"accepted", "rework", "rejected"}, "HOLD": {"answered", "rejected"},
                   "TURN": {"seen"}, "failure": {"seen"}, "legacy": {"seen"}}
# REPORT_MAX_ITEMS is per kind (REPORT-1..32 and HOLD-1..32, as the worker prompt allows).
# Failures: 7 record-level kinds once each + item_invalid/item_conflict once per item identity.
REPORT_ITEM_FAILURE_EVENTS = {"item_conflict", "item_invalid"}
REPORT_MAX_ITEMS, REPORT_MAX_HISTORY = 32, 64
REPORT_MAX_FAILURES = (len(REPORT_FAILURE_EVENTS) - len(REPORT_ITEM_FAILURE_EVENTS)
                       + len(REPORT_ITEM_FAILURE_EVENTS) * (2 * REPORT_MAX_ITEMS + REPORT_MAX_TURNS))
# A retired failed_seen record leaves the hot registry only after the pump's own late-scan
# window (decide.ts DEFAULT_POLICY.failedSeenScanDays) and a durable append to this archive.
REPORT_FAILED_SEEN_SCAN_DAYS = 7
REPORT_ARCHIVE = "report-archive.jsonl"
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
HEX64_RE = re.compile(r"[0-9a-f]{64}")

CAPABILITY = {
    "turn_boundary": "unavailable",
    "observation_tracking": "persistent",
    "session_authentication": "unavailable",
    "session_authentication_reason": "no_815_epoch_fact",
    "capability_delivery": "unavailable",
    "capability_delivery_reason": "816_not_implemented",
    "remote_sender_identity": "unavailable",
    "remote_sender_identity_reason": "817_not_implemented",
    "outcome_protocol": "unavailable",
    "outcome_protocol_reason": "stage_b_deferred_to_0.9.0",
    "outcome_authority": "orchestrator",
}


class RegistryError(Exception):
    def __init__(self, result: str, detail: str) -> None:
        super().__init__(detail)
        self.result = result
        self.detail = detail


def state_dir() -> str:
    """Resolve the registry directory.

    DISPATCH_STATE_DIR is operator/test configuration, but it is still input, and
    every durable write in this file is rooted at it. Normalise it and refuse
    anything that is not a plain absolute path: a relative value would resolve
    against whatever directory the caller happened to be in, and a traversal
    segment would silently retarget the whole registry.

    ACCEPTED SNYK FINDING — `python/PT` Path Traversal, Low, 5 occurrences
    (2026-07-30, reviewed and accepted by the orchestrator).

    That historical waiver does not cover the new status-projections paths.
    Their digest-only names and dir_fd admission require separate exact-source
    review; no inherited security clearance is claimed for them.

    Snyk taints this env var and follows it into `open()` and `os.replace()`.
    The finding is accepted rather than fixed, for these reasons:

      * legacy filenames under this directory are FIXED LITERALS — `active.json`,
        `active.json.lock`, `registry-health.log`, `active.json.legacy-v1.bak`,
        `report-archive.jsonl` (#1170) and the `.<pid>.tmp` sibling. No sid,
        dispatch_id, track, ref path or any other record value is ever
        interpolated into a path;
      * the value is orchestrator configuration, not request data. Anyone who can
        set it on the orchestrator process already has code execution as that user;
      * the normalisation below (absolute, no `..`, no NUL) is real hardening, but
        Snyk's rule wants containment against a fixed allowed root, and this
        component cannot have one: production uses `<repo>/state/dispatch` and
        every test uses its own `mktemp -d`. An allow-list would be a functional
        constraint invented to quiet a Low on operator configuration.

    WHAT INVALIDATES THIS WAIVER: any future path built from a record field
    (per-sid files, per-dispatch directories, an operator-supplied filename). At
    that point the taint is genuine and this must be re-reviewed, not re-waived.
    The one place a filesystem-derived name becomes a path — `op_archive_sidecars`
    — is confined explicitly at its call site.
    """
    default = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "state", "dispatch")
    override = os.environ.get("DISPATCH_STATE_DIR")
    if not override:
        return default
    if "\x00" in override or os.pardir in override.split(os.sep):
        raise RegistryError("registry_unavailable",
                            "DISPATCH_STATE_DIR must be a plain path without '..' segments")
    resolved = os.path.realpath(override)
    if not os.path.isabs(resolved):
        raise RegistryError("registry_unavailable",
                            "DISPATCH_STATE_DIR must resolve to an absolute path")
    return resolved


def registry_path() -> str:
    return os.path.join(state_dir(), "active.json")


# SQLite transition artifacts. The JSON backend must never run beside one: it
# would read an empty registry and publish a fresh active.json next to the
# SQLite state (#1167). Fixed literals only; nothing here is removed or opened.
TRANSITION_ARTIFACTS = ("active.db", "active.db-journal", "active.db-wal", "active.db-shm",
                        "active.json.source", "active.json.pre-sqlite.bak",
                        "active.json.barrier.tmp")


def refuse_transition_artifacts() -> None:
    """Fail closed if any transition artifact exists, of any type. lstat never
    follows links, so a dangling symlink counts as present; only
    FileNotFoundError means absent, and any other OSError refuses too."""
    directory = state_dir()
    for name in TRANSITION_ARTIFACTS:
        path = os.path.join(directory, name)
        try:
            os.lstat(path)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise RegistryError("registry_unavailable",
                                f"cannot inspect transition artifact {path}: {exc}") from exc
        raise RegistryError("registry_unavailable",
                            f"SQLite transition artifact present at {path}; JSON registry refused")


def now_iso(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    return (datetime.datetime.now(datetime.timezone.utc)
            .isoformat(timespec="seconds").replace("+00:00", "Z"))


def plus_minutes(iso: str, minutes: int) -> str:
    try:
        dt = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return iso
    return ((dt + datetime.timedelta(minutes=minutes))
            .isoformat(timespec="seconds").replace("+00:00", "Z"))


def health(result: str, detail: str) -> None:
    """Health alerts go OUTSIDE the file being complained about."""
    try:
        os.makedirs(state_dir(), exist_ok=True)
        with open(os.path.join(state_dir(), "registry-health.log"), "a",
                  encoding="utf-8") as fh:
            fh.write(f"{now_iso()} {result} {detail}\n")
    except OSError:
        pass


def fault(name: str) -> bool:
    return os.environ.get("AIGENTRY_REGISTRY_FAULT", "") == name


# --- durable transaction -------------------------------------------------


class _Lock:
    """Exclusive lock on a stable sibling file. Never the registry inode: an
    atomic rename replaces that, so two writers would hold locks on different
    inodes and both think they were exclusive.

    `path` routes the lock to the document being written. It defaults to the
    dispatch registry's own lock, so every existing caller is unchanged. The
    #1166 intake ledger is a separate document with a separate lock file
    (`intake_lock_path()`): an intake write must never contend with a dispatch
    write, which is what makes an urgent cancel responsive by topology rather
    than by hope."""

    active = None

    def __init__(self, path: str | None = None) -> None:
        self.path = path if path is not None else registry_path() + ".lock"
        self.fh = None
        self.acquired = False

    def __enter__(self):
        if fault("lock"):
            raise RegistryError("registry_unavailable", "lock acquisition faulted (test seam)")
        try:
            os.makedirs(state_dir(), exist_ok=True)
            self.fh = open(self.path, "a+b", buffering=0)
            deadline = time.monotonic() + LOCK_TIMEOUT_S
            while True:
                if os.name == "nt":
                    # Append-open may start beyond zero. Lock [0, 1), even at EOF.
                    self.fh.seek(0, os.SEEK_SET)
                if time.monotonic() >= deadline:
                    raise RegistryError("registry_unavailable",
                                        f"lock timeout after {LOCK_TIMEOUT_S}s")
                try:
                    if os.name == "nt":
                        msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as exc:
                    if os.name == "nt":
                        contended = (exc.errno == errno.EACCES
                                     and getattr(exc, "winerror", None) in (None, 33))
                    else:
                        contended = exc.errno in (errno.EAGAIN, errno.EACCES)
                    if not contended:
                        raise
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise RegistryError("registry_unavailable",
                                            f"lock timeout after {LOCK_TIMEOUT_S}s")
                    time.sleep(min(0.05, remaining))
                else:
                    self.acquired = True
                    # Artifacts may have appeared while this writer waited.
                    refuse_transition_artifacts()
                    _Lock.active = self
                    return self
        except BaseException as exc:
            self.__exit__(*sys.exc_info())
            if isinstance(exc, OSError):
                raise RegistryError("registry_unavailable", f"lock failed: {exc}") from exc
            raise

    def __exit__(self, *exc_info):
        if _Lock.active is self:
            _Lock.active = None
        cleanup_error = None
        if self.fh is not None:
            try:
                if self.acquired:
                    if os.name == "nt":
                        self.fh.seek(0, os.SEEK_SET)
                        msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(self.fh, fcntl.LOCK_UN)
            except OSError as exc:
                cleanup_error = exc
            finally:
                self.acquired = False
                try:
                    self.fh.close()
                except OSError as exc:
                    if cleanup_error is None:
                        cleanup_error = exc
                    else:
                        health("registry_unavailable", f"lock close failed: {exc}")
                finally:
                    self.fh = None
        if cleanup_error is not None:
            detail = f"lock cleanup failed: {cleanup_error}"
            if exc_info[0] is not None:
                health("registry_unavailable", detail)
            else:
                raise RegistryError("registry_unavailable", detail) from cleanup_error
        return False


def validate(doc: object) -> dict:
    if not isinstance(doc, dict):
        raise RegistryError("registry_corrupt", "registry root is not an object (legacy v1 array?)")
    if doc.get("schema_version") != SCHEMA_VERSION:
        raise RegistryError("registry_corrupt",
                            f"schema_version={doc.get('schema_version')!r}, want {SCHEMA_VERSION}")
    if not isinstance(doc.get("generation"), int):
        raise RegistryError("registry_corrupt", "generation is not an integer")
    records = doc.get("dispatches")
    if not isinstance(records, list):
        raise RegistryError("registry_corrupt", "dispatches is not an array")
    seen_ids = set()
    for rec in records:
        if not isinstance(rec, dict):
            raise RegistryError("registry_corrupt", "dispatch record is not an object")
        did = rec.get("dispatch_id")
        if not isinstance(did, str) or not did:
            raise RegistryError("registry_corrupt", f"invalid dispatch_id {did!r}")
        if did in seen_ids:
            raise RegistryError("registry_corrupt", f"duplicate dispatch_id {did!r}")
        seen_ids.add(did)
        assigned, dedup = rec.get("assigned"), rec.get("dedup")
        outcome, lifecycle = rec.get("outcome"), rec.get("lifecycle")
        if not isinstance(assigned, dict) or not isinstance(assigned.get("sid"), str):
            raise RegistryError("registry_corrupt", f"{did}: assigned.sid missing")
        for axis, name in ((dedup, "dedup"), (outcome, "outcome"), (lifecycle, "lifecycle")):
            if not isinstance(axis, dict):
                raise RegistryError("registry_corrupt", f"{did}: {name} axis missing")
        for field in ("key", "ref_hash"):
            if not isinstance(dedup.get(field), str):
                raise RegistryError("registry_corrupt", f"{did}: dedup.{field} missing")
        if outcome.get("state") != "unknown":
            raise RegistryError("registry_corrupt",
                                f"{did}: outcome.state={outcome.get('state')!r}; "
                                "0.8.0 has no writer that may set anything else")
        if outcome.get("reported_value") is not None:
            raise RegistryError("registry_corrupt", f"{did}: outcome.reported_value is not null")
        if not isinstance(lifecycle.get("state"), str):
            raise RegistryError("registry_corrupt", f"{did}: lifecycle.state missing")
        report = rec.get("report")
        if report is not None and not (
                isinstance(report, dict) and report.get("v") == 1
                and report.get("resolution") in REPORT_RESOLUTIONS
                and isinstance(report.get("items"), dict)
                and isinstance(report.get("failures"), list)
                and isinstance(report.get("history"), list)):
            raise RegistryError("registry_corrupt", f"{did}: report is malformed")
    return doc


def load(required: bool = True, limit: int | None = None) -> dict:
    path = registry_path()
    if not os.path.exists(path):
        if required:
            return {"schema_version": SCHEMA_VERSION, "generation": 0, "dispatches": []}
        raise RegistryError("registry_unavailable", f"no registry at {path}")
    if limit is not None:
        return validate(load_bounded(path, limit))
    duplicate = False

    def authority_object(pairs):
        nonlocal duplicate
        obj = {}
        for key, value in pairs:
            if key in obj:
                duplicate = True
            obj[key] = value
        return obj

    try:
        with open(path, encoding="utf-8", newline="") as fh:
            first = fh.readline(STATUS_PREFIX_LIMIT + 1)
            raw = json.loads(first + fh.read(), object_pairs_hook=authority_object)
    except json.JSONDecodeError as exc:
        raise RegistryError("registry_corrupt", f"unparseable registry: {exc}")
    except OSError as exc:
        raise RegistryError("registry_unavailable", f"cannot read registry: {exc}")
    doc = validate(raw)
    if "status_projection" in doc:
        descriptor = validate_status_descriptor(doc["status_projection"])
        canonical = {key: descriptor[key] for key in ("v", "sha256", "bytes", "rows")}
        expected = status_prefix_bytes(doc["generation"], canonical)
        # Full-authority writers keep validate()'s generation domain. Only
        # status applies its existing safe, nonnegative generation bound.
        if duplicate or len(expected) > STATUS_PREFIX_LIMIT or first.encode("utf-8") != expected:
            raise RegistryError("registry_corrupt", "conflicting status projection metadata")
        if os.name == "nt":
            raise RegistryError("registry_unavailable", "native projection admission unavailable")
    return doc


def load_bounded(path: str, limit: int) -> object:
    """Legacy capped load helper. Status uses load_status's shared budget."""
    try:
        with open(path, "rb") as fh:
            data = fh.read(limit + 1)
    except OSError as exc:
        raise RegistryError("registry_unavailable", f"cannot read registry: {exc}")
    if len(data) > limit:
        raise RegistryError("registry_too_large", f"registry exceeds {limit} bytes")
    try:
        return json.loads(data.decode("utf-8"))
    except (ValueError, RecursionError) as exc:
        raise RegistryError("registry_corrupt", f"unparseable registry: {exc}")


def commit(doc: dict) -> None:
    """temp → fsync(temp) → rename → fsync(dir) (POSIX; Windows stops after the
    journaled rename). Recovery sees one complete generation or the other, never
    a half-written file."""
    doc["generation"] = int(doc.get("generation", 0)) + 1
    validate(doc)
    if os.name != "nt":
        commit_status_projection(doc)
        return
    path = registry_path()
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        if fault("temp_write"):
            raise RegistryError("registry_write_failed", "temp write faulted (test seam)")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
            fh.flush()
            if fault("fsync"):
                raise RegistryError("registry_write_failed", "fsync faulted (test seam)")
            os.fsync(fh.fileno())
        if fault("rename"):
            raise RegistryError("registry_write_failed", "rename faulted (test seam)")
        os.replace(tmp, path)
    except RegistryError:
        _unlink(tmp)
        raise
    except OSError as exc:
        _unlink(tmp)
        raise RegistryError("registry_write_failed", f"durable write failed: {exc}")
    if os.name == "nt":
        # No directory fsync exists here; the rename above is the last boundary.
        return
    if fault("dir_fsync"):
        # The rename already landed; the fault models a crash before the
        # directory entry was durable. Both generations are complete, which is
        # the whole point of the contract.
        raise RegistryError("registry_write_failed", "directory fsync faulted (test seam)")
    dir_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


# --- record helpers ------------------------------------------------------


def dedup_key(sid: str, ref_hash: str) -> str:
    return hashlib.sha256((sid + "\x00" + ref_hash).encode("utf-8")).hexdigest()


def find_by_sid(doc: dict, sid: str) -> dict | None:
    matches = [r for r in doc["dispatches"] if r["assigned"]["sid"] == sid]
    if not matches:
        return None
    live = [r for r in matches if r["lifecycle"]["state"] not in RETIRED_LIFECYCLES]
    return (live or matches)[-1]


def require_record(doc: dict, sid: str) -> dict:
    rec = find_by_sid(doc, sid)
    if rec is None:
        raise RegistryError("dispatch_not_found", f"no dispatch record for sid {sid!r}")
    return rec


def live_records(doc: dict, sid: str) -> list[dict]:
    """Every non-retired record for the sid — the set-valued sibling of find_by_sid.

    A sid accumulates ONE RECORD PER DISPATCH, so the more a worker is talked to
    the more records it has. find_by_sid is singular by design: it answers "which
    dispatch", which is the right question for a per-dispatch fact. It is the
    wrong question for a fact about the SESSION, and cleanup asked it anyway —
    retiring one record per invocation and leaving the other N-1 permanently in
    the --live set, polled forever and HOLDing every reconcile tick for a session
    that no longer exists (#853).

    Retired records are excluded deliberately, not incidentally: re-stamping one
    would overwrite a more informative terminal lifecycle (not_delivered,
    delivery_failed) with a blander one, and would reset the last_seen_at clock
    that op_prune ages retired records out by.
    """
    return [r for r in doc["dispatches"]
            if r["assigned"]["sid"] == sid
            and r["lifecycle"]["state"] not in RETIRED_LIFECYCLES]


def target_records(doc: dict, args: dict) -> list[dict]:
    """Resolve an operation's target set: --all → every live record for the sid,
    default → the single record find_by_sid picks.

    Only the two operations that describe the SESSION rather than one dispatch
    accept --all. set-gate and set-transport-result stay singular on purpose: a
    HITL gate and a transport result are facts about one delivery, and fanning
    either across a sid's history would assert something nothing measured.

    An empty list is a legitimate answer — the sid has records but all of them
    are already retired — and callers treat it as a quiet no-op. Only a sid with
    no records at all is an error, which keeps `dispatch_not_found` meaning what
    it always meant.
    """
    sid = args["sid"]
    if not args.get("all"):
        return [require_record(doc, sid)]
    records = live_records(doc, sid)
    if not records and find_by_sid(doc, sid) is None:
        raise RegistryError("dispatch_not_found", f"no dispatch record for sid {sid!r}")
    return records


def append_observation(rec: dict, kind: str, at: str, **fields) -> None:
    obs = {"kind": kind, "at": at, "terminal": False}
    obs.update({k: v for k, v in fields.items() if v is not None})
    rec.setdefault("observations", []).append(obs)
    rec["last_observation"] = obs
    rec["last_seen_at"] = at


def dedup_verdict(doc: dict, key: str) -> tuple[str, dict | None]:
    matches = [r for r in doc["dispatches"] if r["dedup"]["key"] == key
               and r["lifecycle"]["state"] != "superseded"]
    for rec in matches:
        if rec.get("transport", {}).get("result") == "write_observed":
            return "deduplicated", rec
    for rec in matches:
        if rec.get("transport", {}).get("result") != "not_delivered":
            return "retry_held", rec
    return "proceed", None


def pointer(rec: dict, path: str):
    cur = rec
    for part in path.split("."):
        cur = cur.get(part) if isinstance(cur, dict) else None
    return cur


def render(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


# --- operations ----------------------------------------------------------


def op_check_dedup(args: dict) -> int:
    """Read-only: permits spawn/readiness/preparation to run before the
    delivery transaction. It creates no record and no sidecar, so an abort in
    those steps leaves nothing behind to swallow the retry."""
    doc = load()
    verdict, rec = dedup_verdict(doc, dedup_key(args["sid"], args["ref-hash"]))
    emit({"result": verdict,
          "dispatch_id": rec["dispatch_id"] if rec else None,
          "prior_lifecycle": rec["lifecycle"]["state"] if rec else None,
          "prior_transport": rec.get("transport", {}).get("result") if rec else None,
          "completion_fact": None})
    return {"proceed": OK, "retry_held": RETRY_HELD, "deduplicated": DEDUPLICATED}[verdict]


def op_begin_delivery(args: dict) -> int:
    """The authoritative write-before-delivery transaction. Only its `proceed`
    result authorizes handing bytes to telepty."""
    at = now_iso(args.get("now"))
    sid, ref_hash = args["sid"], args["ref-hash"]
    key = dedup_key(sid, ref_hash)
    retry_requested = "retry-unknown" in args
    retry_reason = (args.get("retry-unknown") or "").strip()
    binding = report_binding(args)
    with _Lock():
        doc = load()
        verdict, prior = dedup_verdict(doc, key)
        retry_refused = retry_requested and (
            not retry_reason or verdict != "retry_held"
            or prior["lifecycle"]["state"] != "delivery_state_unknown"
            or prior.get("transport", {}).get("result") != "unknown")
        if retry_refused:
            pass  # Refusal is read-only; emit after releasing the native lock.
        elif verdict != "proceed" and not retry_requested:
            kind = "dedup_suppressed" if verdict == "deduplicated" else "dedup_retry_held"
            append_observation(prior, kind, at, ref_hash=ref_hash)
            commit(doc)
        else:
            record = {
                "dispatch_id": uuid.uuid4().hex,
                "assigned": {"sid": sid, "session_epoch": None},
                "dedup": {"key": key, "ref_hash": ref_hash},
                "outcome": {"state": "unknown", "reported_value": None, "basis": None},
                "lifecycle": {"state": "delivery_attempt_started", "at": at},
                "transport": {"result": "unknown", "inject_id": None, "at": None},
                "gate": {"state": None, "prev_lifecycle": None},
                "capability": dict(CAPABILITY),
                "observations": [],
                "last_observation": None,
                "ref_path": args.get("ref-path", ""),
                "dispatched_at": at,
                "expected_report_by": plus_minutes(at, 30),
                "last_seen_at": at,
                "cwd": args.get("cwd", ""),
                "from_sid": args.get("from", ""),
                "re_dispatch_count": 0,
                "keep_alive": bool(args.get("keep-alive")),
                "track": args.get("track", ""),
                "role": args.get("role", ""),
                "branch": args.get("branch", ""),
                "started_at": at,
            }
            if args.get("worktree"):
                record["worktree"] = args["worktree"]
            if binding:
                record["assigned"]["attempt"] = binding["attempt"]
                record["assigned"]["manifest_sha256"] = binding["manifest-sha256"]
                record["report"] = new_report(binding["report-request-id"],
                                              binding["report-challenge-sha256"])
            append_observation(record, "dispatch_tracking_started", at)
            if retry_requested:
                # Supersede and append in one commit; no old transport/completion fact changes.
                prior["lifecycle"] = {"state": "superseded", "at": at}
                append_observation(prior, "superseded_by_retry", at,
                                   superseded_by=record["dispatch_id"], reason=retry_reason)
                append_observation(record, "retry_of_unknown", at,
                                   retry_of=prior["dispatch_id"], reason=retry_reason)
            doc["dispatches"].append(record)
            commit(doc)
    if retry_refused:
        emit({"result": "DISPATCH_RETRY_REFUSED",
              "dispatch_id": prior["dispatch_id"] if prior else None,
              "prior_lifecycle": prior["lifecycle"]["state"] if prior else None,
              "prior_transport": prior.get("transport", {}).get("result") if prior else None,
              "new_delivery": False, "outcome": "unknown", "completion_fact": None})
        return USAGE
    if verdict != "proceed" and not retry_requested:
        emit({"result": ("DISPATCH_DEDUPLICATED" if verdict == "deduplicated"
                         else "DISPATCH_RETRY_HELD"),
              "dispatch_id": prior["dispatch_id"],
              "new_delivery": False,
              "prior_transport": ("write_observed" if verdict == "deduplicated" else "unknown"),
              "outcome": "unknown",
              "completion_fact": None})
        return DEDUPLICATED if verdict == "deduplicated" else RETRY_HELD
    emit({"result": "proceed", "dispatch_id": record["dispatch_id"],
          "new_delivery": True, "outcome": "unknown", "completion_fact": None,
          "retry_of": prior["dispatch_id"] if retry_requested else None})
    return OK


def op_observe(args: dict) -> int:
    at = now_iso(args.get("now"))
    extra = {}
    if args.get("json"):
        try:
            parsed = json.loads(args["json"])
        except json.JSONDecodeError as exc:
            raise RegistryError("invalid_argument", f"--json is not JSON: {exc}")
        if not isinstance(parsed, dict):
            raise RegistryError("invalid_argument", "--json must be an object")
        extra.update(parsed)
    for item in args.get("field", []):
        key, _, value = item.partition("=")
        try:
            extra[key] = json.loads(value)
        except json.JSONDecodeError:
            extra[key] = value
    extra.pop("terminal", None)   # observations are nonterminal by construction
    extra.pop("kind", None)
    with _Lock():
        doc = load()
        records = target_records(doc, args)
        if not records:
            return OK
        for rec in records:
            append_observation(rec, args["kind"], at, **extra)
        commit(doc)
    return OK


def op_set_lifecycle(args: dict) -> int:
    """A re-dispatch IS a lifecycle transition, so the attempt counter and the
    deadline move with it rather than through an outcome-shaped operation."""
    at = now_iso(args.get("now"))
    # The re-dispatch counter belongs to ONE delivery attempt. Fanning it across
    # every live record for a sid would invent attempts nobody made, so the
    # combination fails closed rather than being silently ignored — the same
    # contract the flag parser applies to unknown field names.
    if args.get("all") and (args.get("re-dispatch-count") is not None
                            or args.get("bump-re-dispatch-count")):
        raise RegistryError("invalid_argument",
                            "set-lifecycle: --all cannot carry a re-dispatch count; "
                            "the counter is per-dispatch, not per-session")
    with _Lock():
        doc = load()
        records = target_records(doc, args)
        if not records:
            return OK
        for rec in records:
            if args.get("state"):
                rec["lifecycle"] = {"state": args["state"], "at": at}
            if args.get("re-dispatch-count") is not None:
                rec["re_dispatch_count"] = int(args["re-dispatch-count"])
            if args.get("bump-re-dispatch-count"):
                rec["re_dispatch_count"] = int(rec.get("re_dispatch_count", 0)) + 1
            if args.get("expected-report-by"):
                rec["expected_report_by"] = args["expected-report-by"]
            if args.get("extend-minutes"):
                rec["expected_report_by"] = plus_minutes(at, int(args["extend-minutes"]))
            rec["last_seen_at"] = at
        commit(doc)
    return OK


def op_set_gate(args: dict) -> int:
    at = now_iso(args.get("now"))
    with _Lock():
        doc = load()
        rec = require_record(doc, args["sid"])
        gate = rec.setdefault("gate", {"state": None, "prev_lifecycle": None})
        if args.get("clear"):
            gate["state"] = None
        else:
            if not args.get("state"):
                raise RegistryError("invalid_argument", "set-gate needs --state or --clear")
            if gate.get("state") is None:
                gate["prev_lifecycle"] = rec["lifecycle"]["state"]
            gate["state"] = args["state"]
        rec["last_seen_at"] = at
        commit(doc)
    return OK


def op_set_transport_result(args: dict) -> int:
    """A transport result is a transport fact. It is not consumption and it is
    certainly not completion. inject_id stays null until telepty surfaces one;
    a null id is a supported, pollable state, not an accident."""
    at = now_iso(args.get("now"))
    result = args.get("result")
    if result not in ("write_observed", "not_delivered", "unknown"):
        raise RegistryError("invalid_argument", f"unknown transport result {result!r}")
    with _Lock():
        doc = load()
        rec = require_record(doc, args["sid"])
        rec["transport"] = {"result": result,
                            "inject_id": args.get("inject-id") or rec.get("transport", {}).get("inject_id"),
                            "at": at}
        if result == "write_observed":
            append_observation(rec, "transport_write_observed", at)
        elif result == "not_delivered":
            rec["lifecycle"] = {"state": "not_delivered", "at": at}
            append_observation(rec, "transport_not_delivered", at)
            report = rec.get("report")
            if isinstance(report, dict) and report.get("request_id") and not report["items"]:
                report["resolution"] = "not_delivered"   # nothing was handed over: no obligation
        else:
            rec["lifecycle"] = {"state": "delivery_state_unknown", "at": at}
            append_observation(rec, "delivery_state_unknown", at)
        commit(doc)
    return OK


def op_get(args: dict) -> int:
    doc = load()
    rec = find_by_sid(doc, args["sid"]) if args.get("sid") else None
    if rec is None:
        if args.get("pointer"):
            print("")
            return OK
        emit({"result": "dispatch_not_found", "sid": args.get("sid")})
        return OK
    if args.get("pointer"):
        print(render(pointer(rec, args["pointer"])))
    else:
        print(json.dumps(rec, ensure_ascii=False))
    return OK


def render_cell(value) -> str:
    """TSV cells are never empty: bash collapses runs of tab, so an empty field
    would silently shift every later column in the reader. Absence is the literal
    "null", which readers already translate back."""
    text = render(value)
    return text if text != "" else "null"


def op_list(args: dict) -> int:
    if args.get("jsonl"):
        return op_list_jsonl(args)
    doc = load()
    fields = (args.get("fields") or "assigned.sid").split(",")
    due_before = args.get("due-before")
    for rec in doc["dispatches"]:
        lifecycle = rec["lifecycle"]["state"]
        gated = rec.get("gate", {}).get("state") is not None
        if args.get("not-retired") and lifecycle in RETIRED_LIFECYCLES:
            continue
        if args.get("live") and (lifecycle in RETIRED_LIFECYCLES or gated):
            continue
        if args.get("keep-alive") and rec.get("keep_alive") is not True:
            continue
        if due_before and str(rec.get("expected_report_by", "")) >= due_before:
            continue
        print("\t".join(render_cell(pointer(rec, f)) for f in fields))
    return OK


# --- list --jsonl: bounded, paged, whitelisted observation rows ---------------
# Read-only. Rows are registry observations, never completion/ACK/authority.
JSONL_READ_LIMIT = 32 * 1024 * 1024
JSONL_OUTPUT_LIMIT = 1024 * 1024
JSONL_MAX_INT = 9007199254740991
JSONL_MAX_LIMIT = 100
JSONL_MAX_STRING = 256
JSONL_MAX_ID_BYTES = 256
JSONL_MAX_AT_BYTES = 128
JSONL_MAX_CURSOR = 2048
JSONL_FIELDS = ("dispatch_id", "assigned.sid", "track", "role", "lifecycle.state", "lifecycle.at",
                "gate.state", "outcome.state", "transport.result", "transport.at", "dispatched_at",
                "expected_report_by", "last_seen_at", "re_dispatch_count", "keep_alive",
                "last_observation.kind", "last_observation.at", "dedup.ref_hash")
JSONL_FLAGS = {"jsonl", "limit", "after", "since-generation"}
JSONL_EXIT = {"usage": USAGE, "unknown_operation": USAGE, "invalid_argument": USAGE,
              "stale_cursor": 3, "identity_too_large": 3, "output_too_large": 3}


def jsonl_requested(argv: list[str]) -> bool:
    """True only when parse() would reach a literal `--jsonl` flag of `list`.
    Every other argv keeps the legacy flag set and legacy error output."""
    if not argv or argv[0] != "list":
        return False
    rest, i = argv[1:], 0
    while i < len(rest):
        name = rest[i][2:] if rest[i].startswith("--") else None
        if name not in FLAGS["list"]:
            return False
        if name == "jsonl":
            return True
        i += 1 if name in BOOLEAN_FLAGS else 2
    return False


def jsonl_number(text: str | None, pattern: str) -> int:
    if text is None or not re.fullmatch(pattern, text) or int(text) > JSONL_MAX_INT:
        raise RegistryError("invalid_argument", "list --jsonl: invalid number")
    return int(text)


def jsonl_key(rec: dict) -> tuple[str, str]:
    at = rec.get("dispatched_at")
    return (at if isinstance(at, str) else "", rec["dispatch_id"])


def cursor_encode(generation: int, key: tuple[str, str], live: bool) -> str:
    text = json.dumps([generation, key[0], key[1], live], ensure_ascii=True, separators=(",", ":"))
    return base64.urlsafe_b64encode(text.encode("ascii")).decode("ascii").rstrip("=")


def cursor_decode(cursor: str) -> list:
    """Opaque canonical base64url of [generation, dispatched_at, dispatch_id, live].
    Exact types, and re-encoding must reproduce the input byte for byte."""
    bad = RegistryError("invalid_argument", "list --jsonl: invalid cursor")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,%d}" % JSONL_MAX_CURSOR, cursor):
        raise bad
    try:
        value = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode("ascii"))
    except (ValueError, RecursionError):
        raise bad
    if not (isinstance(value, list) and len(value) == 4 and type(value[0]) is int
            and 0 <= value[0] <= JSONL_MAX_INT and isinstance(value[1], str)
            and isinstance(value[2], str) and value[2] and type(value[3]) is bool):
        raise bad
    if cursor_encode(value[0], (value[1], value[2]), value[3]) != cursor:
        raise bad
    return value


def jsonl_value(value) -> tuple[object, bool]:
    """(projected scalar, oversize). Non-scalars and unsafe numbers are null."""
    if value is None or isinstance(value, bool):
        return value, False
    if isinstance(value, int):
        return (value if abs(value) <= JSONL_MAX_INT else None), False
    if isinstance(value, float):
        return (value if math.isfinite(value) else None), False
    if isinstance(value, str):
        return (None, True) if len(value) > JSONL_MAX_STRING else (value, False)
    return None, False


# Commit-bound projection protocol and POSIX admission. Windows remains on the
# legacy writer until its in-process native admission adapter is implemented.
STATUS_PREFIX_LIMIT = 65536
STATUS_PROJECTION_FIELDS = JSONL_FIELDS + ("gate_invalid", "gated")


class StatusReadBudget:
    """One status request's prefix/object budget over already admitted fds.
    Native storage admission owns the handles and their lifetime. This counter
    never opens, seeks, reopens or closes them; os.read has no hidden prefetch.
    """

    def __init__(self) -> None:
        self.consumed = 0

    def read(self, fd: int, count: int) -> bytes:
        if count <= 0:
            raise RegistryError("registry_error", "invalid status read size")
        allowance = JSONL_READ_LIMIT + 1 - self.consumed
        if allowance <= 0:
            raise RegistryError("registry_too_large", "status read budget exhausted")
        try:
            data = os.read(fd, min(count, allowance))
        except OSError as exc:
            raise RegistryError("registry_unavailable", "cannot read status data") from exc
        self.consumed += len(data)
        if self.consumed > JSONL_READ_LIMIT:
            raise RegistryError("registry_too_large", "status read budget exhausted")
        return data

    def prefix(self, fd: int) -> bytes:
        """Retain the bounded first line even when it selects the legacy path."""
        data = bytearray()
        while len(data) < STATUS_PREFIX_LIMIT:
            byte = self.read(fd, 1)
            if not byte:
                break
            data.extend(byte)
            if byte == b"\n":
                break
        return bytes(data)

    def remainder(self, fd: int) -> bytes:
        """Consume to EOF with the same allowance, including one refusal probe.
        Legacy callers prepend the retained prefix; projection callers keep it
        separate. Neither path may allocate a second counter for the object.
        """
        chunks = []
        while True:
            data = self.read(fd, 65536)
            if not data:
                return b"".join(chunks)
            chunks.append(data)


def status_json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"),
                      allow_nan=False).encode("ascii")


def status_unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate status key")
        result[key] = value
    return result


def status_invalid_constant(value: str) -> None:
    raise ValueError("nonfinite status number")


def status_projection_bytes(doc: dict) -> bytes:
    """Full raw strings survive until selected-page jsonl_value projection.
    gate facts preserve the distinction between a normalized-null state and an
    actual null state. A status-invalid gate does not reject a valid mutation.
    Generation is deliberately absent, so identical projections can be reused.
    """
    validate(doc)
    rows = []
    for rec in doc["dispatches"]:
        row = {}
        for field in JSONL_FIELDS:
            value = pointer(rec, field)
            row[field] = value if isinstance(value, str) else jsonl_value(value)[0]
        gate = rec.get("gate")
        row["gate_invalid"] = gate is not None and not isinstance(gate, dict)
        row["gated"] = isinstance(gate, dict) and gate.get("state") is not None
        rows.append(row)
    return status_json_bytes({"v": 1, "rows": rows}) + b"\n"


def status_projection_descriptor(data: bytes, rows: int) -> dict:
    return {"v": 1, "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data), "rows": rows}


def validate_status_descriptor(value: object) -> dict:
    if not (isinstance(value, dict) and set(value) == {"v", "sha256", "bytes", "rows"}
            and type(value["v"]) is int and value["v"] == 1
            and isinstance(value["sha256"], str) and HEX64_RE.fullmatch(value["sha256"])
            and type(value["bytes"]) is int and 0 < value["bytes"] <= JSONL_MAX_INT
            and type(value["rows"]) is int and 0 <= value["rows"] <= JSONL_MAX_INT):
        raise RegistryError("registry_corrupt", "invalid status projection descriptor")
    return value


def status_prefix_bytes(generation: int, descriptor: dict) -> bytes:
    """Canonical fragment; remaining complete authority members follow it."""
    return status_json_bytes({"schema_version": SCHEMA_VERSION,
                              "generation": generation,
                              "status_projection": descriptor})[:-1] + b",\n"


def parse_status_prefix(data: bytes) -> dict:
    """Parse only an already bounded first line, never search authority history."""
    bad = RegistryError("registry_corrupt", "invalid status projection prefix")
    if len(data) > STATUS_PREFIX_LIMIT or not data.endswith(b",\n"):
        raise bad
    try:
        value = json.loads((data[:-2] + b"}").decode("ascii"),
                           object_pairs_hook=status_unique_object,
                           parse_constant=status_invalid_constant)
    except (ValueError, RecursionError) as exc:
        raise bad from exc
    if not (isinstance(value, dict)
            and set(value) == {"schema_version", "generation", "status_projection"}
            and type(value["schema_version"]) is int and value["schema_version"] == SCHEMA_VERSION
            and type(value["generation"]) is int and 0 <= value["generation"] <= JSONL_MAX_INT):
        raise bad
    descriptor = validate_status_descriptor(value["status_projection"])
    canonical_descriptor = {key: descriptor[key] for key in ("v", "sha256", "bytes", "rows")}
    if status_prefix_bytes(value["generation"], canonical_descriptor) != data:
        raise bad
    return value


def validate_status_projection(data: bytes, descriptor: dict) -> list[dict]:
    """Validate the entire fetched object, including rows outside the query page.
    Caller must account prefix plus object bytes before calling; descriptor size
    alone never authorizes a read. No generation/cursor shortcut belongs here.
    """
    descriptor = validate_status_descriptor(descriptor)
    bad = RegistryError("registry_corrupt", "invalid status projection object")
    if (len(data) != descriptor["bytes"] or hashlib.sha256(data).hexdigest() != descriptor["sha256"]
            or not data.endswith(b"\n")):
        raise bad
    try:
        decoder = json.JSONDecoder(object_pairs_hook=status_unique_object,
                                   parse_constant=status_invalid_constant)
        text = data.decode("ascii")
        value, end = decoder.raw_decode(text)
        if end != len(text) - 1:
            raise bad
    except (ValueError, RecursionError) as exc:
        raise bad from exc
    if not (isinstance(value, dict) and set(value) == {"v", "rows"}
            and type(value["v"]) is int and value["v"] == 1
            and isinstance(value["rows"], list) and len(value["rows"]) == descriptor["rows"]):
        raise bad
    seen = set()
    for row in value["rows"]:
        if not isinstance(row, dict) or set(row) != set(STATUS_PROJECTION_FIELDS):
            raise bad
        for field in JSONL_FIELDS:
            scalar = row[field]
            if not (scalar is None or isinstance(scalar, (str, bool))
                    or (type(scalar) is int and abs(scalar) <= JSONL_MAX_INT)
                    or (type(scalar) is float and math.isfinite(scalar))):
                raise bad
        did = row["dispatch_id"]
        if not isinstance(did, str) or not did or did in seen:
            raise bad
        seen.add(did)
        if (not all(isinstance(row[field], str) for field in
                    ("assigned.sid", "lifecycle.state", "dedup.ref_hash"))
                or row["outcome.state"] != "unknown"
                or type(row["gate_invalid"]) is not bool or type(row["gated"]) is not bool):
            raise bad
        if row["gate_invalid"]:
            if row["gated"] or row["gate.state"] is not None:
                raise bad
        elif row["gate.state"] is not None and not row["gated"]:
            raise bad
    return value["rows"]


def status_same_inode(left, right) -> bool:
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


class PosixProjectionStore:
    """Admitted directory handles, never a record-derived path or a repair.
    Relative opens pin resolution even if a namespace is renamed. Ancestor and
    named-object identity checks additionally reject observed substitutions.
    Root/current-user ownership and writable-parent restrictions exclude other
    unprivileged users; this does not grant protection from root/the owner.
    """

    def __init__(self, directory: str, create: bool = False) -> None:
        self.directory = directory
        self.create = create
        self.handles = []
        self.entries = []
        self.state_fd = None
        self.objects_fd = None

    @staticmethod
    def parent_safe(info) -> bool:
        return (stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.geteuid())
                and (not info.st_mode & 0o022 or bool(info.st_mode & stat.S_ISVTX)))

    def __enter__(self):
        if os.name == "nt":
            raise RegistryError("registry_unavailable", "native projection admission unavailable")
        try:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
            fd = os.open(os.sep, flags)
            self.handles.append(fd)
            if not self.parent_safe(os.fstat(fd)):
                raise RegistryError("registry_unavailable", "unsafe projection ancestor")
            for name in self.directory.split(os.sep)[1:]:
                if not name or name in (os.curdir, os.pardir):
                    raise RegistryError("registry_unavailable", "unsafe projection directory")
                child = os.open(name, flags, dir_fd=fd)
                self.handles.append(child)
                self.entries.append((fd, name, child))
                if not self.parent_safe(os.fstat(child)):
                    raise RegistryError("registry_unavailable", "unsafe projection ancestor")
                fd = child
            self.state_fd = fd
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise RegistryError("registry_unavailable", "unsafe projection state directory")
            if self.create:
                self.check_lock()
                try:
                    os.mkdir("status-projections", mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                else:
                    # Persist the new parent entry before any authority replace.
                    os.fsync(fd)
            objects = os.open("status-projections", flags, dir_fd=fd)
            self.handles.append(objects)
            self.entries.append((fd, "status-projections", objects))
            self.objects_fd = objects
            self.check_namespace()
            return self
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise

    def __exit__(self, *exc_info):
        error = None
        for fd in reversed(self.handles):
            try:
                os.close(fd)
            except OSError as exc:
                if error is None:
                    error = exc
        self.handles = []
        if error is not None and exc_info[0] is None:
            raise error
        return False

    def check_namespace(self) -> None:
        for parent, name, fd in self.entries:
            actual = os.fstat(fd)
            named = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not self.parent_safe(actual) or not status_same_inode(actual, named):
                raise RegistryError("registry_unavailable", "projection namespace changed")
        state = os.fstat(self.state_fd)
        objects = os.fstat(self.objects_fd)
        if (state.st_uid != os.geteuid() or state.st_mode & 0o022
                or objects.st_uid != os.geteuid() or objects.st_mode & 0o077):
            raise RegistryError("registry_unavailable", "projection directory is not private")

    def check_lock(self) -> None:
        held = _Lock.active
        named = os.stat("active.json.lock", dir_fd=self.state_fd, follow_symlinks=False)
        if (held is None or not held.acquired or held.fh is None
                or not stat.S_ISREG(named.st_mode) or named.st_nlink != 1
                or named.st_uid != os.geteuid() or named.st_mode & 0o022
                or not status_same_inode(named, os.fstat(held.fh.fileno()))):
            raise RegistryError("registry_unavailable", "projection publication lock changed")

    @staticmethod
    def object_info(fd: int):
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_nlink != 1):
            raise RegistryError("registry_corrupt", "unsafe status projection object")
        return info

    def open_object(self, digest: str) -> int:
        if not isinstance(digest, str) or not HEX64_RE.fullmatch(digest):
            raise RegistryError("registry_corrupt", "invalid status projection digest")
        fd = os.open(digest, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                     dir_fd=self.objects_fd)
        try:
            self.object_info(fd)
        except BaseException:
            os.close(fd)
            raise
        return fd

    def check_object(self, digest: str, fd: int, before) -> None:
        after = self.object_info(fd)
        named = os.stat(digest, dir_fd=self.objects_fd, follow_symlinks=False)
        if (not status_same_inode(before, after) or not status_same_inode(after, named)
                or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns
                or before.st_ctime_ns != after.st_ctime_ns):
            raise RegistryError("registry_corrupt", "status projection object changed")
        self.check_namespace()

    def fetch(self, descriptor: dict, budget: StatusReadBudget) -> list[dict]:
        if budget.consumed + descriptor["bytes"] > JSONL_READ_LIMIT:
            raise RegistryError("registry_too_large", "status read budget exhausted")
        fd = self.open_object(descriptor["sha256"])
        try:
            before = self.object_info(fd)
            if before.st_size != descriptor["bytes"]:
                raise RegistryError("registry_corrupt", "status projection size mismatch")
            data = budget.remainder(fd)
            self.check_object(descriptor["sha256"], fd, before)
            return validate_status_projection(data, descriptor)
        finally:
            os.close(fd)

    def verify_existing(self, digest: str, data: bytes) -> None:
        """Full-authority writer verification, not a second status read budget."""
        fd = self.open_object(digest)
        try:
            before = self.object_info(fd)
            if before.st_size != len(data):
                raise RegistryError("registry_corrupt", "existing projection size mismatch")
            offset = 0
            while True:
                chunk = os.read(fd, min(65536, len(data) + 1 - offset))
                if not chunk:
                    break
                if chunk != data[offset:offset + len(chunk)]:
                    raise RegistryError("registry_corrupt", "existing projection bytes mismatch")
                offset += len(chunk)
            if offset != len(data):
                raise RegistryError("registry_corrupt", "existing projection is truncated")
            self.check_object(digest, fd, before)
        finally:
            os.close(fd)

    def install(self, digest: str, data: bytes) -> None:
        if not HEX64_RE.fullmatch(digest):
            raise RegistryError("registry_corrupt", "invalid status projection digest")
        self.check_namespace()
        self.check_lock()
        name = ".projection-" + uuid.uuid4().hex + ".tmp"
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=self.objects_fd)
        try:
            self.object_info(fd)
            status_write_all(fd, data)
            os.fsync(fd)
            source = self.object_info(fd)
            if not status_same_inode(source, os.stat(name, dir_fd=self.objects_fd, follow_symlinks=False)):
                raise RegistryError("registry_corrupt", "projection temporary changed")
            try:
                os.link(name, digest, src_dir_fd=self.objects_fd, dst_dir_fd=self.objects_fd,
                        follow_symlinks=False)
            except FileExistsError:
                self.verify_existing(digest, data)
                os.unlink(name, dir_fd=self.objects_fd)
            else:
                linked = os.fstat(fd)
                target = os.stat(digest, dir_fd=self.objects_fd, follow_symlinks=False)
                if linked.st_nlink != 2 or not status_same_inode(linked, target):
                    raise RegistryError("registry_corrupt", "projection installation identity changed")
                os.unlink(name, dir_fd=self.objects_fd)
                installed = self.object_info(fd)
                self.check_object(digest, fd, installed)
            self.check_namespace()
            os.fsync(self.objects_fd)
        finally:
            # Failed installation can leave a private orphan; never remove old
            # digest objects or perform discovery/repair/GC here.
            os.close(fd)


def status_write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        if count <= 0:
            raise OSError("short status write")
        view = view[count:]


def commit_status_projection(doc: dict) -> None:
    """POSIX-only publication under the same authority lock and generation."""
    replaced = False
    try:
        data = status_projection_bytes(doc)
        descriptor = status_projection_descriptor(data, len(doc["dispatches"]))
        prefix = status_prefix_bytes(doc["generation"], descriptor)
        if len(prefix) > STATUS_PREFIX_LIMIT:
            raise RegistryError("registry_write_failed", "status prefix exceeds bound")
        remaining = {key: value for key, value in doc.items()
                     if key not in ("schema_version", "generation", "status_projection")}
        authority = prefix + json.dumps(remaining, ensure_ascii=True, indent=2).encode("ascii")[1:] + b"\n"
        with PosixProjectionStore(state_dir(), create=True) as store:
            store.install(descriptor["sha256"], data)
            name = f"active.json.{os.getpid()}.tmp"
            created = False
            try:
                if fault("temp_write"):
                    raise RegistryError("registry_write_failed", "temp write faulted (test seam)")
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o600, dir_fd=store.state_fd)
                created = True
                try:
                    store.object_info(fd)
                    status_write_all(fd, authority)
                    if fault("fsync"):
                        raise RegistryError("registry_write_failed", "fsync faulted (test seam)")
                    os.fsync(fd)
                    store.check_namespace()
                    store.check_lock()
                    named = os.stat(name, dir_fd=store.state_fd, follow_symlinks=False)
                    if not status_same_inode(named, store.object_info(fd)):
                        raise RegistryError("registry_write_failed", "authority temporary changed")
                    if fault("rename"):
                        raise RegistryError("registry_write_failed", "rename faulted (test seam)")
                    os.replace(name, "active.json", src_dir_fd=store.state_fd, dst_dir_fd=store.state_fd)
                    replaced = True
                finally:
                    os.close(fd)
            finally:
                if created and not replaced:
                    # Only the exclusive temporary owned by this attempt.
                    try:
                        os.unlink(name, dir_fd=store.state_fd)
                    except OSError:
                        pass
            if fault("dir_fsync"):
                raise RegistryError("registry_write_failed", "authority replaced; directory fsync faulted")
            os.fsync(store.state_fd)
            store.check_namespace()
    except RegistryError as exc:
        if replaced:
            raise RegistryError("registry_write_failed", "authority replaced; durability or namespace uncertain") from exc
        raise
    except OSError as exc:
        detail = ("authority replaced; durability uncertain" if replaced
                  else "projection publication failed before authority replacement")
        raise RegistryError("registry_write_failed", detail) from exc


def status_prefix_advertised(data: bytes) -> bool:
    """Recognize only the canonical key positions in the bounded first line."""
    start = b'{"schema_version":2,"generation":'
    if not data.startswith(start):
        return False
    try:
        tail = data[len(start):].decode("ascii")
        _, end = json.JSONDecoder().raw_decode(tail)
    except (ValueError, RecursionError):
        return False
    return tail[end:].startswith(',"status_projection":')


def load_status() -> tuple[dict, int]:
    """One active open, one budget; v2 observes only its committed projection."""
    path = registry_path()
    if not os.path.exists(path):
        return {"schema_version": SCHEMA_VERSION, "generation": 0, "dispatches": []}, 1
    try:
        directory = os.path.dirname(path)
        parent_before = os.stat(directory)
        before = os.lstat(path)
        budget = StatusReadBudget()
        with open(path, "rb", buffering=0) as fh:
            first = budget.prefix(fh.fileno())
            if status_prefix_advertised(first):
                prefix = parse_status_prefix(first)
                if os.name == "nt":
                    raise RegistryError("registry_unavailable", "native projection admission unavailable")
                active = os.fstat(fh.fileno())
                if (not stat.S_ISREG(before.st_mode) or not status_same_inode(before, active)
                        or active.st_uid != os.geteuid() or active.st_mode & 0o022
                        or active.st_nlink > 1):
                    raise RegistryError("registry_corrupt", "unsafe status authority identity")
                with PosixProjectionStore(directory) as store:
                    if not status_same_inode(parent_before, os.fstat(store.state_fd)):
                        raise RegistryError("registry_unavailable", "status authority parent changed")
                    rows = store.fetch(prefix["status_projection"], budget)
                return {"generation": prefix["generation"], "dispatches": rows}, 2
            data = first + budget.remainder(fh.fileno())
        try:
            raw = json.loads(data.decode("utf-8"))
        except (ValueError, RecursionError) as exc:
            raise RegistryError("registry_corrupt", "unparseable status authority") from exc
        if isinstance(raw, dict) and "status_projection" in raw:
            raise RegistryError("registry_corrupt", "noncanonical status projection metadata")
        return validate(raw), 1
    except OSError as exc:
        raise RegistryError("registry_unavailable", "cannot read status registry") from exc


def op_list_jsonl(args: dict) -> int:
    if any(name in args for name in ("fields", "not-retired", "keep-alive", "due-before")):
        raise RegistryError("invalid_argument", "list --jsonl: unsupported flag")
    if "after" in args and "since-generation" in args:
        raise RegistryError("invalid_argument", "list --jsonl: --after excludes --since-generation")
    limit = jsonl_number(args.get("limit", "50"), r"[1-9][0-9]{0,2}")
    if limit > JSONL_MAX_LIMIT:
        raise RegistryError("invalid_argument", "list --jsonl: --limit above 100")
    since = (jsonl_number(args["since-generation"], r"0|[1-9][0-9]{0,15}")
             if "since-generation" in args else None)
    cursor = cursor_decode(args["after"]) if "after" in args else None
    live = bool(args.get("live"))
    doc, version = load_status()
    generation = doc["generation"]
    if type(generation) is not int or not 0 <= generation <= JSONL_MAX_INT:
        raise RegistryError("registry_corrupt", "generation out of range")
    if cursor is not None and cursor[0] != generation:
        raise RegistryError("stale_cursor", "registry generation changed")
    if cursor is not None and cursor[3] != live:
        raise RegistryError("invalid_argument", "list --jsonl: cursor filter mismatch")
    matching = []
    for rec in doc["dispatches"]:
        if version == 2:
            invalid, gated = rec["gate_invalid"], rec["gated"]
            lifecycle = rec["lifecycle.state"]
        else:
            gate = rec.get("gate")
            invalid = gate is not None and not isinstance(gate, dict)
            gated = isinstance(gate, dict) and gate.get("state") is not None
            lifecycle = rec["lifecycle"]["state"]
        if invalid:
            raise RegistryError("registry_corrupt", "gate axis is not an object")
        if live and (lifecycle in RETIRED_LIFECYCLES or gated):
            continue
        matching.append(rec)
    matching.sort(key=jsonl_key)
    header = {"v": version, "generation": generation, "unchanged": since == generation,
              "matching": len(matching), "oversize": 0, "more": False, "next_after": None, "rows": 0}
    lines = []
    if since != generation:
        if cursor is not None:
            matching = [rec for rec in matching if jsonl_key(rec) > (cursor[1], cursor[2])]
        page = matching[:limit]
        for rec in page:
            at, did = jsonl_key(rec)
            if (len(did.encode("utf-8", "surrogatepass")) > JSONL_MAX_ID_BYTES
                    or len(at.encode("utf-8", "surrogatepass")) > JSONL_MAX_AT_BYTES):
                raise RegistryError("identity_too_large", "dispatch identity exceeds bound")
            row = {}
            for field in JSONL_FIELDS:
                row[field], oversize = jsonl_value(rec[field] if version == 2 else pointer(rec, field))
                header["oversize"] += oversize
            lines.append(json.dumps(row, ensure_ascii=True, separators=(",", ":"), allow_nan=False))
        if len(matching) > limit:
            next_after = cursor_encode(generation, jsonl_key(page[-1]), live)
            if len(next_after) > JSONL_MAX_CURSOR:
                raise RegistryError("identity_too_large", "cursor exceeds bound")
            header["more"], header["next_after"] = True, next_after
        header["rows"] = len(lines)
    out = "".join(line + "\n" for line in
                  [json.dumps(header, ensure_ascii=True, separators=(",", ":"))] + lines)
    if len(out) > JSONL_OUTPUT_LIMIT:
        raise RegistryError("output_too_large", "projected output exceeds bound")
    # Bytes, not text: Windows text mode would turn every "\n" into "\r\n".
    sys.stdout.flush()
    sys.stdout.buffer.write(out.encode("ascii"))
    sys.stdout.buffer.flush()
    return OK


def op_snapshot(args: dict) -> int:
    doc = load()
    doc.pop("status_projection", None)
    print(json.dumps(doc, ensure_ascii=False, indent=2))
    return OK


def op_prune(args: dict) -> int:
    """Retired lifecycles age out. A dispatch whose outcome is unknown and whose
    lifecycle is still live is never removed — its history is the only record
    that the work was ever handed out."""
    cutoff = int(args.get("older-than-seconds") or 86400)
    at = now_iso(args.get("now"))
    now_dt = datetime.datetime.fromisoformat(at.replace("Z", "+00:00"))
    with _Lock():
        doc = load()
        keep = []
        archive = []
        for rec in doc["dispatches"]:
            aged = False
            if rec["lifecycle"]["state"] in RETIRED_LIFECYCLES:
                try:
                    seen = datetime.datetime.fromisoformat(
                        str(rec.get("last_seen_at", "")).replace("Z", "+00:00"))
                    aged = (now_dt - seen).total_seconds() > cutoff
                except ValueError:
                    pass
            # #1170: an unresolved report obligation outlives its lifecycle (cleaned included).
            report = rec.get("report")
            if isinstance(report, dict) and report.get("resolution") in REPORT_KEEP:
                if aged and failed_seen_past_scan(report, now_dt):
                    archive.append(rec)
                keep.append(rec)
                continue
            if aged:
                continue
            keep.append(rec)
        archive_error = None
        if archive:
            try:
                append_report_archive(archive, at)
                archived = {id(rec) for rec in archive}
                keep = [rec for rec in keep if id(rec) not in archived]
            except OSError as exc:
                # Never drop a record that is not durably archived: keep them all hot, in place.
                archive_error = f"report archive append failed, {len(archive)} record(s) kept: {exc}"
        doc["dispatches"] = keep
        commit(doc)
    if archive_error:
        raise RegistryError("registry_write_failed", archive_error)
    return OK


def failed_seen_past_scan(rep: dict, now_dt: datetime.datetime) -> bool:
    """failed_seen whose last failure review is older than the pump's late-scan window,
    i.e. a record no pump pass, capture or cleanup will ever look at again
    (decide.ts inScanSet). Anything unparseable stays hot."""
    if rep.get("resolution") != "failed_seen":
        return False
    last = None
    for f in rep.get("failures") or []:
        review = f.get("review") if isinstance(f, dict) else None
        if not review:
            continue
        try:
            t = datetime.datetime.fromisoformat(str(review.get("at", "")).replace("Z", "+00:00"))
        except ValueError:
            return False
        last = t if last is None or t > last else last
    if last is None:
        return False
    return (now_dt - last).total_seconds() > REPORT_FAILED_SEEN_SCAN_DAYS * 86400


def append_report_archive(records: list[dict], at: str) -> None:
    """Evidence, not authority: one full row per line, append → fsync (→ dir fsync), before
    the registry commit that drops them. Fixed literal name; the worker bytes stay where the
    inbox copy is (never moved or deleted). A crash before the commit repeats a line."""
    path = os.path.join(state_dir(), REPORT_ARCHIVE)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps({"v": 1, "archived_at": at, "reason": "failed_seen_retired_past_scan_window",
                                 "record": rec}, ensure_ascii=True, separators=(",", ":")) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    if os.name != "nt":
        dir_fd = os.open(state_dir(), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


# --- #1170 report obligation -------------------------------------------------
# One `report` object per dispatch, written ONLY by report-event under the same
# lock and commit as every other mutation. Four facts stay apart: captured (an
# envelope-valid item reached the inbox), notice (what the transport said),
# observed (what the receiver's audit log said) and review (an explicit ACK).
# `resolution` is derived from them here and nowhere else; only an accepted
# current final derives `done`. The outcome axis is still never touched.


def report_binding(args: dict) -> dict | None:
    """The four begin-delivery binding flags: all or none, each exactly shaped."""
    names = ("attempt", "manifest-sha256", "report-request-id", "report-challenge-sha256")
    given = [args.get(n) for n in names]
    if not any(given):
        return None
    shapes = (UUID_RE, HEX64_RE, UUID_RE, HEX64_RE)
    if not all(v and shape.fullmatch(v) for v, shape in zip(given, shapes)):
        raise RegistryError("invalid_argument",
                            "begin-delivery: --attempt/--manifest-sha256/--report-request-id/"
                            "--report-challenge-sha256 go together and must be uuid/sha256 shaped")
    return dict(zip(names, given))


def new_report(request_id: str | None, challenge_sha256: str | None) -> dict:
    return {"v": 1, "request_id": request_id, "challenge_sha256": challenge_sha256,
            "resolution": "open", "current_final": None, "items": {}, "failures": [],
            "suspect": {}, "history": [], "history_dropped": 0}


def report_history(rep: dict, at: str, event: str, item: str, **extra) -> None:
    entry = {"at": at, "event": event, "item": item}
    entry.update({k: v for k, v in extra.items() if v is not None})
    rep["history"].append(entry)
    while len(rep["history"]) > REPORT_MAX_HISTORY:
        rep["history"].pop(0)
        rep["history_dropped"] = int(rep.get("history_dropped", 0)) + 1


def derive_resolution(rep: dict) -> str:
    if not rep.get("request_id"):
        return "legacy_seen" if (rep.get("legacy") or {}).get("review") else "legacy_unbound"
    if rep.get("resolution") == "not_delivered" and not rep["items"]:
        return "not_delivered"
    pending = (any(v.get("review") is None and not v.get("superseded_by")
                   for k, v in rep["items"].items() if not k.startswith("TURN-"))
               or any(f.get("review") is None for f in rep["failures"]))
    if pending:
        return "open"
    final = rep["items"].get(rep.get("current_final") or "")
    if final:
        return {"accepted": "done", "rework": "rework_requested",
                "rejected": "rejected"}[final["review"]["verdict"]]
    return "failed_seen" if rep["failures"] else "open"


def report_subject(rep: dict, item: str) -> tuple[str, dict | None, str | None]:
    """(kind, subject, subject sha) for an item key; subject None when absent."""
    m = REPORT_ITEM_RE.fullmatch(item)
    if m:
        sub = rep["items"].get(item)
        return m.group(1), sub, sub["sha256"] if sub else None
    if REPORT_TURN_RE.fullmatch(item):
        sub = rep["items"].get(item)
        return "TURN", sub, sub["sha256"] if sub else None
    if item == "legacy":
        sub = rep.get("legacy")
        return "legacy", sub, sub["subject_sha256"] if sub else None
    fm = re.fullmatch(r"failure-([1-9][0-9]{0,2})", item)
    if fm:
        n = int(fm.group(1))
        sub = rep["failures"][n - 1] if n <= len(rep["failures"]) else None
        return "failure", sub, sub["subject_sha256"] if sub else None
    raise RegistryError("invalid_argument", f"report-event: unknown item {item!r}")


def bounded_text(value: str | None, limit: int) -> str:
    return (value or "").replace("\x00", "")[:limit]


def rep_captured(did: str, rec: dict, item: str, args: dict, fields: dict, at: str):
    rep = rec.get("report")
    if not isinstance(rep, dict) or not rep.get("request_id"):
        return "report_unbound", USAGE, {}   # legacy cannot claim a request without proof
    m = REPORT_ITEM_RE.fullmatch(item) or REPORT_TURN_RE.fullmatch(item)
    sha = args.get("sha256") or ""
    inbox = fields.get("inbox") or ""
    if not m or not HEX64_RE.fullmatch(sha) or not re.fullmatch(r"[0-9]{1,5}", fields.get("bytes", "")) \
            or int(fields["bytes"]) > 65536 or not inbox or len(inbox) > 4096:
        raise RegistryError("invalid_argument", "report-event captured: item/sha256/bytes/inbox")
    existing = rep["items"].get(item)
    if existing:
        if existing["sha256"] == sha:
            return "duplicate", DEDUPLICATED, {}
        return "item_conflict", USAGE, {"existing_sha256": existing["sha256"]}
    turn = item.startswith("TURN-")
    kind = item.split("-")[0]
    same_space = [k for k in rep["items"] if k.split("-")[0] == kind]
    if len(same_space) >= (REPORT_MAX_TURNS if turn else REPORT_MAX_ITEMS):
        return "item_limit", USAGE, {}
    entry = {"sha256": sha, "bytes": int(fields["bytes"]), "inbox": inbox, "captured_at": at,
             "superseded_by": None, "notice": None, "review": None}
    if turn:
        new_formal = [x for x in (fields.get("new_formal") or "").split(",") if x]
        if fields.get("end") not in ("stop", "api_error", "session_end") \
                or fields.get("assoc") not in ("exact", "unknown") or len(new_formal) > 32 \
                or not all(REPORT_ITEM_RE.fullmatch(x) for x in new_formal) \
                or not re.fullmatch(r"[A-Za-z0-9_.-]{0,64}", fields.get("turn_error", "")):
            # Worker-authored status fields (a bound TURN names plain KIND-n only): a refused
            # item, not a registry error — the pump lists it as ignored, never as a capture failure.
            return "turn_fields_invalid", USAGE, {}
        entry.update({"end": fields["end"], "assoc": fields["assoc"],
                      "error": fields.get("turn_error") or None, "new_formal": new_formal})
        seq = int(item.split("-")[1])
        newer = [k for k in same_space if int(k.split("-")[1]) > seq]
        if newer:
            entry["superseded_by"] = max(newer, key=lambda k: int(k.split("-")[1]))
        else:
            for key in same_space:
                if rep["items"][key].get("review") is None and not rep["items"][key].get("superseded_by"):
                    rep["items"][key]["superseded_by"] = item
    rep["items"][item] = entry
    if m.group(1) == "REPORT":
        current = rep.get("current_final")
        if current is None or int(m.group(2)) > int(current.split("-")[1]):
            for key, other in rep["items"].items():
                if key.startswith("REPORT-") and key != item and other.get("review") is None \
                        and not other.get("superseded_by"):
                    other["superseded_by"] = item
            rep["current_final"] = item
        else:
            entry["superseded_by"] = current   # a late lower seq never becomes the final
    report_history(rep, at, "captured", item, sha256=sha)
    rep["resolution"] = derive_resolution(rep)
    return "captured", OK, {"current_final": rep["current_final"], "resolution": rep["resolution"]}


def failure_item_key(f: dict) -> str | None:
    """The item an item_invalid/item_conflict failure is about: its `key`, or — for rows
    written before keys existed — the KIND-n the host-written detail starts with."""
    if f.get("key"):
        return f["key"]
    m = re.match(r"((?:REPORT|HOLD|TURN)-[0-9]{1,2})(?:\.md: | changed after capture)", str(f.get("detail") or ""))
    return m.group(1) if m else None


def rep_failure(did: str, rec: dict, item: str, args: dict, fields: dict, at: str):
    rep = rec.get("report")
    if not isinstance(rep, dict) or not rep.get("request_id"):
        return "report_unbound", USAGE, {}
    if item not in REPORT_FAILURE_EVENTS:
        raise RegistryError("invalid_argument", f"report-event failure: unknown event {item!r}")
    stage = fields.get("stage", "confirm")
    key = fields.get("key") or None
    if key is not None and (item not in REPORT_ITEM_FAILURE_EVENTS
                            or not (REPORT_ITEM_RE.fullmatch(key) or REPORT_TURN_RE.fullmatch(key))):
        raise RegistryError("invalid_argument", "report-event failure: key=KIND-n for item_invalid/item_conflict only")
    if item in REPORT_ITEM_FAILURE_EVENTS:
        key = key or failure_item_key({"detail": fields.get("detail")})
    suspect = rep.setdefault("suspect", {})
    if any(f["event"] == item and (item not in REPORT_ITEM_FAILURE_EVENTS or failure_item_key(f) == key)
           for f in rep["failures"]):
        return "duplicate", DEDUPLICATED, {}
    if stage == "suspect":
        if item in suspect:
            return "duplicate", DEDUPLICATED, {}
        suspect[item] = at
        report_history(rep, at, "failure_suspect", item)
        return "suspect", OK, {}
    if stage == "clear":
        if item not in suspect:
            return "duplicate", DEDUPLICATED, {}
        del suspect[item]
        report_history(rep, at, "failure_cleared", item)
        return "cleared", OK, {}
    if stage != "confirm":
        raise RegistryError("invalid_argument", f"report-event failure: unknown stage {stage!r}")
    if len(rep["failures"]) >= REPORT_MAX_FAILURES:
        return "failure_limit", USAGE, {}
    n = len(rep["failures"]) + 1
    subject = hashlib.sha256(f"{did}\nfailure-{n}\n{item}\n{at}".encode("utf-8")).hexdigest()
    rep["failures"].append({"n": n, "event": item, "detail": bounded_text(fields.get("detail"), 256),
                            "at": at, "subject_sha256": subject, "notice": None, "review": None,
                            **({"key": key} if key else {})})
    suspect.pop(item, None)
    report_history(rep, at, "failure", f"failure-{n}", failure_event=item)
    rep["resolution"] = derive_resolution(rep)
    return "failure_recorded", OK, {"item": f"failure-{n}", "subject_sha256": subject,
                                    "resolution": rep["resolution"]}


def rep_notice(did: str, rec: dict, item: str, args: dict, fields: dict, at: str):
    rep = rec.get("report")
    if not isinstance(rep, dict):
        return "STALE_SUBJECT", USAGE, {}
    _, sub, _ = report_subject(rep, item)
    if sub is None or sub.get("review") is not None:
        return "STALE_SUBJECT", USAGE, {}
    expect = args.get("expect-n") or ""
    next_at = fields.get("next_at") or ""
    if not re.fullmatch(r"[0-9]{1,6}", expect) or not re.fullmatch(r"[0-9T:+.Z-]{10,40}", next_at):
        raise RegistryError("invalid_argument", "report-event notice: --expect-n and next_at required")
    notice = sub.get("notice") or {"n": 0, "last_at": None, "next_at": None, "rc": None,
                                   "inject_id": None, "submit": None, "delivery_result": None,
                                   "verified_sender": None, "dest": None}
    phase = fields.get("phase")
    if notice["n"] != int(expect):
        return "notice_raced", DEDUPLICATED, {"n": notice["n"]}
    if phase == "claim":
        dest = fields.get("dest") or ""
        owner = fields.get("owner") or ""
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", dest):
            raise RegistryError("invalid_argument", "report-event notice: dest")
        if owner and not re.fullmatch(r"[0-9]{1,10}@[A-Za-z0-9_.-]{1,64}", owner):
            raise RegistryError("invalid_argument", "report-event notice: owner=<pid>@<host>")
        notice.update({"n": notice["n"] + 1, "last_at": at, "next_at": next_at, "rc": None,
                       "inject_id": None, "submit": "pending", "delivery_result": None,
                       "verified_sender": None, "dest": dest})
        # Transient owner of the pending claim (the pump that may still be sending); gone at its result.
        owners = rep.setdefault("claim_owners", {})
        if owner:
            owners[item] = owner
        else:
            owners.pop(item, None)
        if not owners:
            rep.pop("claim_owners", None)
    elif phase == "result":
        if notice.get("submit") != "pending":
            return "notice_raced", DEDUPLICATED, {"n": notice["n"]}
        inject_id = fields.get("inject_id") or ""
        if fields.get("submit") not in REPORT_SUBMIT or not re.fullmatch(r"-?[0-9]{1,4}", fields.get("rc", "")) \
                or (inject_id and not re.fullmatch(r"[0-9a-fA-F-]{36}", inject_id)):
            raise RegistryError("invalid_argument", "report-event notice: rc/submit/inject_id")
        notice.update({"rc": int(fields["rc"]), "inject_id": inject_id or None,
                       "submit": fields["submit"], "next_at": next_at})
        (rep.get("claim_owners") or {}).pop(item, None)
        if not rep.get("claim_owners"):
            rep.pop("claim_owners", None)
    else:
        raise RegistryError("invalid_argument", "report-event notice: phase=claim|result")
    sub["notice"] = notice
    report_history(rep, at, f"notice_{phase}", item, n=notice["n"], submit=notice["submit"],
                   inject_id=notice["inject_id"])
    return "notice", OK, {"n": notice["n"]}


def rep_observed(did: str, rec: dict, item: str, args: dict, fields: dict, at: str):
    rep = rec.get("report")
    if not isinstance(rep, dict):
        return "STALE_SUBJECT", USAGE, {}
    _, sub, _ = report_subject(rep, item)
    notice = (sub or {}).get("notice") or {}
    if not notice.get("inject_id") or notice["inject_id"] != fields.get("inject_id"):
        return "STALE_SUBJECT", USAGE, {}
    result = bounded_text(fields.get("delivery_result"), 64)
    sender = bounded_text(fields.get("verified_sender"), 128) or None
    if notice.get("delivery_result") == result and notice.get("verified_sender") == sender:
        return "duplicate", DEDUPLICATED, {}
    notice["delivery_result"], notice["verified_sender"] = result, sender
    report_history(rep, at, "observed", item, delivery_result=result,
                   anomaly="verified_sender_not_null" if sender else None)
    return "observed", OK, {}


def rep_reviewed(did: str, rec: dict, item: str, args: dict, fields: dict, at: str):
    rep = rec.get("report")
    if not isinstance(rep, dict):
        return "STALE_SUBJECT", USAGE, {}
    kind, sub, sha = report_subject(rep, item)
    verdict = fields.get("verdict")
    if verdict not in REPORT_VERDICTS[kind]:
        return "invalid_verdict", USAGE, {"allowed": sorted(REPORT_VERDICTS[kind])}
    if sub is None or args.get("sha256") != sha:
        return "STALE_SUBJECT", USAGE, {}       # review before capture, or a different subject
    if kind == "REPORT" and item != rep.get("current_final"):
        return "STALE_SUBJECT", USAGE, {"current_final": rep.get("current_final")}
    if kind == "TURN" and sub.get("superseded_by"):
        return "STALE_SUBJECT", USAGE, {"superseded_by": sub["superseded_by"]}
    if sub.get("review") is not None:
        if sub["review"]["verdict"] == verdict:
            return "duplicate", DEDUPLICATED, {}
        return "STALE_SUBJECT", USAGE, {"reviewed": sub["review"]["verdict"]}
    by = fields.get("by_claimed") or ""
    sub["review"] = {"verdict": verdict, "at": at,
                     "by_claimed": by if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", by) else None}
    report_history(rep, at, "reviewed", item, verdict=verdict)
    rep["resolution"] = derive_resolution(rep)
    return "reviewed", OK, {"resolution": rep["resolution"]}


def rep_legacy(did: str, rec: dict, item: str, args: dict, fields: dict, at: str):
    if item != "legacy":
        raise RegistryError("invalid_argument", "report-event legacy: --item legacy")
    if rec.get("report") is not None:
        return "duplicate", DEDUPLICATED, {}
    rep = new_report(None, None)
    rep["resolution"] = "legacy_unbound"
    rep["legacy"] = {"at": at, "notice": None, "review": None,
                     "subject_sha256": hashlib.sha256(f"{did}\nlegacy\n{at}".encode("utf-8")).hexdigest()}
    report_history(rep, at, "legacy_unbound", "legacy")
    rec["report"] = rep
    return "legacy_unbound", OK, {"subject_sha256": rep["legacy"]["subject_sha256"]}


REPORT_EVENTS = {"captured": rep_captured, "failure": rep_failure, "notice": rep_notice,
                 "observed": rep_observed, "reviewed": rep_reviewed, "legacy": rep_legacy}


def op_report_event(args: dict) -> int:
    """One report fact, one commit. 0 written · 8 same fact/raced · 4 conflict/stale/invalid."""
    at = now_iso(args.get("now"))
    did, kind, item = args["dispatch-id"], args["kind"], args["item"]
    if kind not in REPORT_EVENTS:
        raise RegistryError("invalid_argument", f"report-event: unknown kind {kind!r}")
    fields = {}
    for entry in args.get("field", []):
        key, sep, value = entry.partition("=")
        if not sep or not re.fullmatch(r"[a-z_]{1,32}", key):
            raise RegistryError("invalid_argument", f"report-event: bad --field {key!r}")
        fields[key] = value
    with _Lock():
        doc = load()
        rec = next((r for r in doc["dispatches"] if r["dispatch_id"] == did), None)
        if rec is None:
            raise RegistryError("dispatch_not_found", f"no dispatch record {did!r}")
        result, code, extra = REPORT_EVENTS[kind](did, rec, item, args, fields, at)
        if code == OK:
            rec["last_seen_at"] = at
            commit(doc)
    emit({"result": result, "dispatch_id": did, "kind": kind, "item": item, **extra,
          "completion_fact": None})
    return code


def superseded_by(rec: dict) -> str | None:
    for obs in reversed(rec.get("observations") or []):
        if obs.get("kind") == "superseded_by_retry":
            return obs.get("superseded_by")
    return None


def op_report_list(args: dict) -> int:
    """Read-only JSONL for the pump. Default: every bound record still in REPORT_KEEP,
    plus live, ungated records with no report yet (legacy candidates). --sid: that
    sid's bound records in REPORT_KEEP. --all: every record that has a report."""
    doc = load()
    sid = args.get("sid")
    for rec in doc["dispatches"]:
        if sid and rec["assigned"]["sid"] != sid:
            continue
        rep = rec.get("report")
        if rep is None:
            if args.get("all") or sid or rec["lifecycle"]["state"] in RETIRED_LIFECYCLES \
                    or (rec.get("gate") or {}).get("state") is not None:
                continue
        elif not args.get("all") and (rep.get("resolution") not in REPORT_KEEP
                                      or (sid and not rep.get("request_id"))):
            continue
        row = {"dispatch_id": rec["dispatch_id"], "sid": rec["assigned"]["sid"],
               "attempt": rec["assigned"].get("attempt"),
               "manifest_sha256": rec["assigned"].get("manifest_sha256"),
               "from_sid": rec.get("from_sid") or "", "lifecycle": rec["lifecycle"]["state"],
               "gate": (rec.get("gate") or {}).get("state"),
               "transport": (rec.get("transport") or {}).get("result"),
               "expected_report_by": rec.get("expected_report_by"),
               "dispatched_at": rec.get("dispatched_at"), "superseded_by": superseded_by(rec),
               "report": rep}
        print(json.dumps(row, ensure_ascii=True, separators=(",", ":")))
    return OK


def op_migrate(args: dict) -> int:
    """Cutover: one legacy root array becomes one schema-v2 generation. Nothing
    is promoted — a legacy record whose status claimed the task was reported
    becomes outcome unknown like every other, with the claim preserved as an
    observation so the audit trail survives without the false authority."""
    at = now_iso(args.get("now"))
    path = registry_path()
    with _Lock():
        try:
            with open(path, "rb") as fh:
                raw_bytes = fh.read()
        except OSError as exc:
            raise RegistryError("registry_unavailable", f"cannot read legacy registry: {exc}")
        try:
            legacy = json.loads(raw_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise RegistryError("registry_corrupt", f"legacy registry is unparseable: {exc}")
        if isinstance(legacy, dict):
            raise RegistryError("already_schema_v2",
                                "registry is already an envelope; migration is one-shot")
        if not isinstance(legacy, list):
            raise RegistryError("registry_corrupt", "legacy registry is neither array nor envelope")

        backup = path + ".legacy-v1.bak"
        with open(backup, "wb") as fh:
            fh.write(raw_bytes)
            fh.flush()
            os.fsync(fh.fileno())

        doc = {"schema_version": SCHEMA_VERSION, "generation": 0, "dispatches": []}
        for entry in legacy:
            if not isinstance(entry, dict) or not entry.get("sid"):
                raise RegistryError("registry_corrupt", f"unmappable legacy entry: {entry!r}")
            sid = str(entry["sid"])
            legacy_status = str(entry.get("status") or "")
            quarantine = legacy_status in ("in_flight", "re_dispatched", "stuck_welcome",
                                           "awaiting_user", "disconnected")
            ref_hash = str(entry.get("ref_hash") or "")
            rec = {
                "dispatch_id": uuid.uuid4().hex,
                "assigned": {"sid": sid, "session_epoch": None},
                "dedup": {"key": dedup_key(sid, ref_hash), "ref_hash": ref_hash},
                "outcome": {"state": "unknown", "reported_value": None, "basis": None},
                "lifecycle": {"state": "cutover_quarantine" if quarantine else "cutover_retired",
                              "at": at},
                # The sidecars are archived rather than imported, and a legacy
                # entry carries no typed transport fact, so delivery is unknown.
                "transport": {"result": "unknown", "inject_id": None, "at": None},
                "gate": {"state": "awaiting_user" if legacy_status == "awaiting_user" else None,
                         "prev_lifecycle": None},
                "capability": dict(CAPABILITY),
                "observations": [],
                "last_observation": None,
                "re_dispatch_count": int(entry.get("re_dispatch_count") or 0),
                "keep_alive": entry.get("keep_alive") is True,
            }
            for field in ("ref_path", "dispatched_at", "expected_report_by", "last_seen_at",
                          "cwd", "from_sid", "track", "role", "branch", "worktree",
                          "started_at"):
                if entry.get(field) is not None:
                    rec[field] = entry[field]
            append_observation(rec, "legacy_status_observed", at, legacy_status=legacy_status)
            doc["dispatches"].append(rec)
        commit(doc)
    emit({"result": "migrated", "dispatches": len(doc["dispatches"]), "backup": backup})
    return OK


def op_archive_sidecars(args: dict) -> int:
    """The pre-ledger $HOME/.aigentry/dispatch-helper/<sid> marks lose all
    authority at cutover. This is the only code path allowed to touch them, and
    it moves them out of the way rather than importing them as delivery facts."""
    src = args.get("dir") or os.path.join(os.path.expanduser("~"), ".aigentry", "dispatch-helper")
    if not os.path.isdir(src):
        emit({"result": "no_sidecars", "dir": src})
        return OK
    dest = src + ".archived"
    os.makedirs(dest, exist_ok=True)
    dest_root = os.path.realpath(dest)
    for name in os.listdir(src):
        # This is the ONE place in this file where a name read off the filesystem
        # becomes part of a path. Projection names are computed digests, not
        # filesystem-derived names. Confine
        # it: a plain basename only, and a destination that provably stays inside
        # the archive directory. Fails closed — an unexpected entry aborts the
        # archival rather than being moved somewhere unexamined.
        if name != os.path.basename(name) or name in (os.curdir, os.pardir):
            raise RegistryError("registry_unavailable",
                                f"refusing to archive a non-basename sidecar entry {name!r}")
        target = os.path.join(dest, name)
        if os.path.realpath(os.path.dirname(target)) != dest_root:
            raise RegistryError("registry_unavailable",
                                f"sidecar {name!r} resolves outside the archive directory")
        shutil.move(os.path.join(src, name), target)
    os.rmdir(src)
    emit({"result": "archived", "dir": dest})
    return OK


# --- #1166 U1 durable request intake ledger ----------------------------------
# A SEPARATE document with a SEPARATE lock, written by this same single-writer
# program. Not an array inside active.json: validate() requires dispatch_id /
# assigned.sid / dedup / outcome / lifecycle on every record, so an intake row
# would force a SCHEMA_VERSION bump of the live registry (a live-state
# migration) and would put every prompt write behind the dispatch lock, in
# direct conflict with #1172. On a separate inode none of that happens, and
# refuse_transition_artifacts() still covers these ops unchanged (main()).
#
# The decision core is specified once in src/request-capture/intake.ts (pure);
# this is the only WRITER. tests/request-capture/intake-registry.test.mjs
# R-DIFF replays one event sequence through both and asserts the documents are
# equal, so the two cannot drift silently.
#
# Four facts stay apart: a transport delivery is not an event here at all;
# binding records an owner and moves nothing; `answered` is a human answer, not
# a completion; only `work-completed` (verdict AND result link AND evidence)
# completes a row. Idle, cleanup, session end, worker exit, a notice, a
# transport rc, a turn boundary and liveness have no event, so they cannot
# reach a request state.
#
# Every path below is a FIXED LITERAL. No ingress_id, capture_id, digest or any
# other record field is ever interpolated into a path, which is exactly the
# condition the accepted state_dir() waiver names as its invalidation.

INTAKE_SCHEMA_VERSION = 1
INTAKE_FILE = "intake.json"
INTAKE_LOCK = "intake.json.lock"
INTAKE_ARCHIVE = "intake-archive.jsonl"
INTAKE_ORDER_LABEL = "received-at-then-ingress-id-not-commit-not-execution"
# Bounded archive lookup: non-resurrection must be PROVEN, and an unprovable
# scan refuses the capture instead of admitting it.
INTAKE_ARCHIVE_SCAN_BYTES = 32 * 1024 * 1024
INTAKE_ARCHIVE_SCAN_LINES = 262144
INTAKE_ARCHIVE_MAX_LINE = 1024 * 1024
INTAKE_STATES = ("queued", "in_progress", "waiting", "completed", "failed", "cancelled")
INTAKE_CLOSED = ("completed", "cancelled")
# The exhaustive transition table. Absence is a refusal; there is no default arm.
INTAKE_TRANSITIONS = {
    "captured": (),
    "bind": ("queued", "in_progress", "waiting"),
    "start": ("queued", "waiting"),
    "pause": ("queued", "in_progress"),
    "resume": ("waiting",),
    "answered": ("queued", "in_progress", "waiting"),
    "work-completed": ("queued", "in_progress", "waiting"),
    "fail": ("queued", "in_progress", "waiting"),
    "cancel": ("queued", "in_progress", "waiting", "failed"),
    "amend": ("queued", "in_progress", "waiting", "failed"),
}
INTAKE_ANSWER_VERDICTS = ("answered", "rejected", "rework")
INTAKE_WORK_VERDICTS = ("accepted", "rejected")
INTAKE_FAILURE_REASONS = ("evidence_missing", "evidence_corrupt", "measured_failure")
INTAKE_BOUNDS = {"rows": 4096, "history": 256, "revisions": 64, "review": 64, "binding": 64,
                 "depends_on": 32, "id_chars": 128, "text_chars": 256, "result_ref_chars": 512,
                 "byte_len": 2 ** 53 - 1}
# Fields that would make the ledger a second copy of the prompt, or a record
# value a path or a command. Refused by the validator, not by convention.
INTAKE_FORBIDDEN_KEYS = ("argv", "attachment", "attachments", "body", "command", "content",
                         "cwd", "env", "excerpt", "file", "filename", "metadata", "original",
                         "original_text", "path", "prompt", "raw", "raw_ref", "script", "shell",
                         "text", "original_ref")
INTAKE_UUID4_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
INTAKE_AT_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
INTAKE_NAME_RE = re.compile(r"[a-z0-9][a-z0-9._-]*")
INTAKE_NAMESPACE_RE = re.compile(r"[a-z0-9][a-z0-9._/-]*")
INTAKE_REFERENCE_RE = re.compile(r"[A-Za-z0-9._:/-]+")
INTAKE_TOKEN_RE = re.compile(r"[A-Za-z0-9._:-]+")
INTAKE_TEXT_RE = re.compile(r"[^\x00-\x1f\x7f]+")
INTAKE_UINT_RE = re.compile(r"0|[1-9][0-9]*")
# The shipped exit vocabulary (0/4/7/8/9); nothing new is invented. These are
# returned by the op itself, so main()'s existing mapping is untouched.
INTAKE_EXITS = {"invalid_argument": USAGE, "intake_malformed": USAGE,
                "intake_transition_refused": USAGE, "intake_identity_collision": USAGE,
                "intake_bounds_exceeded": USAGE, "intake_not_found": USAGE,
                "intake_replay": DEDUPLICATED, "intake_upstream_duplicate": DEDUPLICATED,
                "intake_notice_replay": DEDUPLICATED, "intake_notice_race": DEDUPLICATED,
                "intake_archived": DEDUPLICATED,
                "intake_archive_unbounded": REGISTRY_ERROR}
INTAKE_IMMUTABLE = ("capture_id", "channel", "upstream_namespace", "upstream_delivery_id",
                    "upstream_id_status", "upstream_scope_sha256", "sha256", "byte_len",
                    "received_at")


class IntakeRefusal(Exception):
    """A refused intake event: an exact result, zero writes, a shipped exit code."""

    def __init__(self, result: str, detail: str) -> None:
        super().__init__(detail)
        self.result = result
        self.detail = detail


def intake_path() -> str:
    return os.path.join(state_dir(), INTAKE_FILE)


def intake_lock_path() -> str:
    return os.path.join(state_dir(), INTAKE_LOCK)


def intake_archive_path() -> str:
    return os.path.join(state_dir(), INTAKE_ARCHIVE)


def intake_validate(doc: object) -> dict:
    """Fail closed. A malformed ledger is reported, never repaired, never
    partially read, and its bytes are left exactly as found."""
    if not isinstance(doc, dict):
        raise RegistryError("registry_corrupt", "intake root is not an object")
    if doc.get("schema_version") != INTAKE_SCHEMA_VERSION:
        raise RegistryError("registry_corrupt",
                            f"intake schema_version={doc.get('schema_version')!r}, "
                            f"want {INTAKE_SCHEMA_VERSION}")
    if not isinstance(doc.get("generation"), int) or isinstance(doc.get("generation"), bool):
        raise RegistryError("registry_corrupt", "intake generation is not an integer")
    rows = doc.get("requests")
    if not isinstance(rows, list):
        raise RegistryError("registry_corrupt", "intake requests is not an array")
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise RegistryError("registry_corrupt", "intake record is not an object")
        ingress = row.get("ingress_id")
        if not isinstance(ingress, str) or not INTAKE_UUID4_RE.fullmatch(ingress):
            raise RegistryError("registry_corrupt", f"invalid ingress_id {ingress!r}")
        if ingress in seen:
            raise RegistryError("registry_corrupt", f"duplicate ingress_id {ingress!r}")
        seen.add(ingress)
        if "notice" not in row or not intake_notice_valid(row["notice"], ingress):
            raise RegistryError("registry_corrupt", f"{ingress}: invalid notice")
        for key in INTAKE_FORBIDDEN_KEYS:
            if key in row:
                raise RegistryError("registry_corrupt",
                                    f"{ingress}: forbidden field {key!r}; the intake ledger "
                                    "stores identifiers and measurements only")
        if row.get("state") not in INTAKE_STATES:
            raise RegistryError("registry_corrupt", f"{ingress}: invalid state "
                                                    f"{row.get('state')!r}")
        for key in ("history", "review", "binding", "revisions", "depends_on",
                    "bound_dispatch_ids"):
            if not isinstance(row.get(key), list):
                raise RegistryError("registry_corrupt", f"{ingress}: {key} is not an array")
    return doc


def intake_load() -> dict:
    """An absent ledger is a valid empty one — there is nothing to migrate."""
    path = intake_path()
    if not os.path.exists(path):
        return {"schema_version": INTAKE_SCHEMA_VERSION, "generation": 0, "requests": []}
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        raise RegistryError("registry_unavailable", f"cannot read intake ledger: {exc}")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise RegistryError("registry_corrupt", f"unparseable intake ledger: {exc}")
    return intake_validate(parsed)


def intake_commit(doc: dict) -> None:
    """The same durable sequence as the dispatch registry's commit(), on the
    intake inode: temp -> fsync(temp) -> rename -> fsync(dir), Windows stopping
    after the journaled rename. Recovery sees one complete generation or the
    other, never a half-written ledger. There is no truncate-in-place path."""
    doc["generation"] = int(doc.get("generation", 0)) + 1
    intake_validate(doc)
    path = intake_path()
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        if fault("temp_write"):
            raise RegistryError("registry_write_failed", "temp write faulted (test seam)")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
            fh.flush()
            if fault("fsync"):
                raise RegistryError("registry_write_failed", "fsync faulted (test seam)")
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        if fault("rename"):
            raise RegistryError("registry_write_failed", "rename faulted (test seam)")
        os.replace(tmp, path)
    except RegistryError:
        _unlink(tmp)
        raise
    except OSError as exc:
        _unlink(tmp)
        raise RegistryError("registry_write_failed", f"durable intake write failed: {exc}")
    if os.name == "nt":
        return
    if fault("dir_fsync"):
        raise RegistryError("registry_write_failed", "directory fsync faulted (test seam)")
    dir_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def append_intake_archive(records: list[dict], at: str) -> None:
    """Evidence, not authority: one full row per line, append -> fsync (-> dir
    fsync), BEFORE the commit that drops them. Fixed literal name. The archive
    and the hot rewrite are two separate durable boundaries and this does not
    pretend otherwise: a crash in between repeats a line, keyed by the exact
    immutable ingress_id, so the repeat is the same evidence and never a second
    request."""
    path = intake_archive_path()
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0),
                 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps({"v": 1, "archived_at": at,
                                 "reason": "closed_aged_past_cutoff",
                                 "ingress_id": rec["ingress_id"], "record": rec},
                                ensure_ascii=True, separators=(",", ":")) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    if os.name != "nt":
        dir_fd = os.open(state_dir(), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


def intake_archived_ids() -> tuple[set, bool]:
    """Bounded lookup. Returns (ids, complete). `complete=False` means
    non-resurrection could not be proven within the bound, which the caller
    turns into a refusal — never into an admission."""
    ids: set = set()
    try:
        fh = open(intake_archive_path(), "rb")
    except FileNotFoundError:
        return ids, True
    except OSError as exc:
        raise RegistryError("registry_unavailable", f"cannot read intake archive: {exc}")
    total = lines = 0
    with fh:
        while True:
            # Bounded read: never materialise more than the line bound plus one byte. `for raw in
            # fh` allocated a whole unterminated line BEFORE the named bound was evaluated, so a
            # corrupt private archive could make this read hundreds of MiB to reach a refusal it
            # already knew it would make (ir1166bcx R4). The extra byte is what distinguishes a
            # line exactly at the bound from one past it.
            raw = fh.readline(INTAKE_ARCHIVE_MAX_LINE + 1)
            if not raw:
                break                       # EOF: the scan completed
            if len(raw) > INTAKE_ARCHIVE_MAX_LINE:
                return ids, False
            total += len(raw)
            lines += 1
            if total > INTAKE_ARCHIVE_SCAN_BYTES or lines > INTAKE_ARCHIVE_SCAN_LINES:
                return ids, False
            if not raw.endswith(b"\n"):
                # A crash mid-append can leave a torn final line. It is skipped,
                # never repaired. Any EARLIER unparseable line fails closed below.
                break
            try:
                entry = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return ids, False
            if isinstance(entry, dict) and isinstance(entry.get("ingress_id"), str):
                ids.add(entry["ingress_id"])
    return ids, True


def intake_text(value: object, name: str, limit: int, pattern) -> str:
    """Length first: an over-long but well-shaped value is a bound, not a shape."""
    if not isinstance(value, str) or not value:
        raise IntakeRefusal("intake_malformed", f"{name} is required")
    if len(value) > limit:
        raise IntakeRefusal("intake_bounds_exceeded", f"{name} exceeds {limit} characters")
    if not pattern.fullmatch(value):
        raise IntakeRefusal("intake_malformed", f"{name} is malformed")
    return value


def intake_immutable(args: dict) -> dict:
    """The identity and measurement set of one delivery. An upstream identity is
    never fabricated, and a claimed one is never left unbacked."""
    capture_id = intake_text(args.get("capture-id"), "capture-id", INTAKE_BOUNDS["id_chars"],
                             INTAKE_UUID4_RE)
    channel = intake_text(args.get("channel"), "channel", INTAKE_BOUNDS["id_chars"],
                          INTAKE_NAME_RE)
    namespace = intake_text(args.get("upstream-namespace"), "upstream-namespace",
                            INTAKE_BOUNDS["id_chars"], INTAKE_NAMESPACE_RE)
    digest = intake_text(args.get("sha256"), "sha256", 64, HEX64_RE)
    received_at = intake_text(args.get("received-at"), "received-at", 32, INTAKE_AT_RE)
    raw_len = args.get("byte-len")
    if not isinstance(raw_len, str) or not INTAKE_UINT_RE.fullmatch(raw_len) \
            or int(raw_len) > INTAKE_BOUNDS["byte_len"]:
        raise IntakeRefusal("intake_malformed", "byte-len must be a non-negative safe integer")
    status = args.get("upstream-id-status")
    if status not in ("available", "unavailable"):
        raise IntakeRefusal("intake_malformed",
                            "upstream-id-status must be available or unavailable")
    delivery_id = args.get("upstream-delivery-id")
    scope = args.get("upstream-scope-sha256")
    if status == "unavailable" and delivery_id is not None:
        raise IntakeRefusal("intake_malformed",
                            "upstream-delivery-id is present but upstream-id-status is "
                            "unavailable; an upstream identity is never fabricated")
    if status == "available":
        intake_text(delivery_id, "upstream-delivery-id", INTAKE_BOUNDS["id_chars"],
                    INTAKE_TOKEN_RE)
        intake_text(scope, "upstream-scope-sha256", 64, HEX64_RE)
    elif scope is not None:
        intake_text(scope, "upstream-scope-sha256", 64, HEX64_RE)
    return {"capture_id": capture_id, "channel": channel, "upstream_namespace": namespace,
            "upstream_delivery_id": delivery_id, "upstream_id_status": status,
            "upstream_scope_sha256": scope, "sha256": digest, "byte_len": int(raw_len),
            "received_at": received_at}


def intake_upstream_key(row: dict) -> str:
    """channel + namespace + provider/session scope + the provider id. Every
    component is mandatory, so one provider's id can never collide across
    channels, providers or sessions."""
    parts = (row["channel"], row["upstream_namespace"], row.get("upstream_scope_sha256") or "",
             row.get("upstream_delivery_id") or "")
    return hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()


def intake_new_row(fields: dict, at: str, supersedes: str | None, ingress_id: str) -> dict:
    return {"ingress_id": ingress_id, **fields, "state": "queued", "work_state": "unstarted",
            "answered_at": None, "owning_task": None, "bound_dispatch_ids": [], "depends_on": [],
            "pause": None, "result": None, "failure": None, "supersedes": supersedes,
            "superseded_by": None, "revisions": [], "review": [], "binding": [], "notice": None,
            "last_event_at": at,
            "history": [{"at": at, "event": "captured" if supersedes is None else "amend",
                         "from": None, "to": "queued"}]}


def intake_bounds_check(row: dict) -> None:
    """Growth REFUSES at the bound: an intake obligation must not lose its own
    audit trail, so nothing here evicts the way the report history rotates."""
    for key in ("history", "review", "binding", "revisions", "depends_on"):
        if len(row[key]) > INTAKE_BOUNDS[key]:
            raise IntakeRefusal("intake_bounds_exceeded",
                                f"{key} would exceed {INTAKE_BOUNDS[key]} entries")


def intake_history(row: dict, kind: str, at: str, to: str, **extra) -> None:
    """One transition, one append. No field is ever rewritten in place."""
    entry = {"at": at, "event": kind, "from": row["state"], "to": to}
    entry.update({k: v for k, v in extra.items() if v is not None})
    row["history"].append(entry)
    row["state"] = to
    row["last_event_at"] = at


def intake_find(doc: dict, ingress_id: str) -> dict | None:
    for row in doc["requests"]:
        if row["ingress_id"] == ingress_id:
            return row
    return None


def intake_creation(doc: dict, kind: str, ingress_id: str, args: dict, at: str) -> dict:
    fields = intake_immutable(args)
    existing = intake_find(doc, ingress_id)
    if existing is not None:
        for key in INTAKE_IMMUTABLE:
            if existing.get(key) != fields[key]:
                # The stored row is authority: a mismatch refuses. It never
                # overwrites and never silently no-ops.
                raise IntakeRefusal("intake_identity_collision",
                                    f"{ingress_id}: {key} does not match the recorded delivery")
        raise IntakeRefusal("intake_replay", f"{ingress_id} was already captured")
    archived, complete = intake_archived_ids()
    if not complete:
        raise IntakeRefusal("intake_archive_unbounded",
                            "the intake archive could not be scanned within its bound; capture "
                            "refused rather than admitted, because non-resurrection cannot be "
                            "proven")
    if ingress_id in archived:
        raise IntakeRefusal("intake_archived", f"{ingress_id} is archived and is not resurrected")
    if fields["upstream_id_status"] == "available":
        key = intake_upstream_key(dict(fields))
        for row in doc["requests"]:
            if row.get("upstream_id_status") == "available" and intake_upstream_key(row) == key:
                raise IntakeRefusal("intake_upstream_duplicate",
                                    f"upstream delivery already recorded as {row['ingress_id']}")
    if kind == "captured":
        if len(doc["requests"]) + 1 > INTAKE_BOUNDS["rows"]:
            raise IntakeRefusal("intake_bounds_exceeded",
                                f"the ledger holds {INTAKE_BOUNDS['rows']} requests")
        row = intake_new_row(fields, at, None, ingress_id)
        doc["requests"].append(row)
        return row
    # amend: a new delivery superseding an earlier one; the original is preserved verbatim.
    supersedes = intake_text(args.get("supersedes"), "supersedes", INTAKE_BOUNDS["id_chars"],
                             INTAKE_UUID4_RE)
    original = intake_find(doc, supersedes)
    if original is None:
        raise IntakeRefusal("intake_not_found", f"no intake request {supersedes}")
    if original["state"] not in INTAKE_TRANSITIONS["amend"]:
        raise IntakeRefusal("intake_transition_refused",
                            f"amend is not authorised from {original['state']}")
    if original.get("superseded_by") is not None:
        raise IntakeRefusal("intake_transition_refused",
                            f"{supersedes} is already superseded by "
                            f"{original['superseded_by']}; the link is set once")
    if len(doc["requests"]) + 1 > INTAKE_BOUNDS["rows"]:
        raise IntakeRefusal("intake_bounds_exceeded",
                            f"the ledger holds {INTAKE_BOUNDS['rows']} requests")
    original["superseded_by"] = ingress_id
    original["revisions"].append({"at": at, "kind": "superseded_by", "revision": ingress_id})
    original["history"].append({"at": at, "event": "amend", "from": original["state"],
                                "to": original["state"]})
    original["last_event_at"] = at
    intake_bounds_check(original)
    row = intake_new_row(fields, at, supersedes, ingress_id)
    row["revisions"] = [{"at": at, "kind": "amends", "revision": supersedes}]
    doc["requests"].append(row)
    return row


def intake_mutation(doc: dict, kind: str, ingress_id: str, args: dict, at: str) -> dict:
    row = intake_find(doc, ingress_id)
    # An event for an unknown request is never a creation.
    if row is None:
        raise IntakeRefusal("intake_not_found", f"no intake request {ingress_id}")
    allowed = INTAKE_TRANSITIONS[kind]

    if kind == "bind":
        task = intake_text(args.get("owning-task"), "owning-task", INTAKE_BOUNDS["id_chars"],
                           INTAKE_TOKEN_RE)
        dispatch = intake_text(args.get("dispatch-id"), "dispatch-id",
                               INTAKE_BOUNDS["id_chars"], INTAKE_TOKEN_RE)
        if row["state"] not in allowed:
            raise IntakeRefusal("intake_transition_refused",
                                f"bind is not authorised from {row['state']}")
        # Recording an owner is not a grant: no state moves, nothing is
        # dispatched, no task is created, no command is admitted.
        row["owning_task"] = task
        if dispatch not in row["bound_dispatch_ids"]:
            row["bound_dispatch_ids"].append(dispatch)
        row["binding"].append({"at": at, "owning_task": task, "dispatch_id": dispatch})
        intake_history(row, kind, at, row["state"])
    elif kind == "start":
        if row["state"] not in allowed:
            raise IntakeRefusal("intake_transition_refused",
                                f"start is not authorised from {row['state']}")
        if not row["binding"]:
            raise IntakeRefusal("intake_transition_refused",
                                f"{ingress_id} has no recorded owner; bind before start")
        # start is the other exit from `waiting`, so it clears the pause it resolves, in this
        # same single transition. Leaving it set made `pause` permanently unavailable, because a
        # pause is set-once while it holds (ir1166bcx R2). From `queued` this is a no-op, so
        # start has one behaviour and not two. A second pause after this is a NEW fact.
        row["pause"] = None
        row["depends_on"] = []
        intake_history(row, kind, at, "in_progress")
        row["work_state"] = "in_progress"
    elif kind == "pause":
        reason = intake_text(args.get("reason"), "reason", INTAKE_BOUNDS["text_chars"],
                             INTAKE_TEXT_RE)
        owner = intake_text(args.get("owner"), "owner", INTAKE_BOUNDS["id_chars"],
                            INTAKE_TOKEN_RE)
        condition = intake_text(args.get("resume-condition"), "resume-condition",
                                INTAKE_BOUNDS["text_chars"], INTAKE_TEXT_RE)
        depends_on = list(args.get("depends-on") or [])
        if len(depends_on) > INTAKE_BOUNDS["depends_on"]:
            raise IntakeRefusal("intake_bounds_exceeded",
                                f"depends_on would exceed {INTAKE_BOUNDS['depends_on']} entries")
        for dependency in depends_on:
            intake_text(dependency, "depends-on", INTAKE_BOUNDS["id_chars"], INTAKE_TOKEN_RE)
        if row["state"] not in allowed:
            raise IntakeRefusal("intake_transition_refused",
                                f"pause is not authorised from {row['state']}")
        if row.get("pause") is not None:
            raise IntakeRefusal("intake_transition_refused",
                                f"{ingress_id} already carries a pause; it is set once")
        row["pause"] = {"reason": reason, "owner": owner, "resume_condition": condition,
                        "resume_to": row["state"]}
        row["depends_on"] = depends_on
        intake_history(row, kind, at, "waiting")
        row["work_state"] = "paused"
    elif kind == "resume":
        if row["state"] not in allowed or row.get("pause") is None:
            raise IntakeRefusal("intake_transition_refused",
                                f"resume requires a recorded pause; {ingress_id} is "
                                f"{row['state']}")
        back = row["pause"]["resume_to"]
        row["pause"] = None
        row["depends_on"] = []
        intake_history(row, kind, at, back)
        row["work_state"] = "in_progress" if back == "in_progress" else "unstarted"
    elif kind == "answered":
        verdict = intake_text(args.get("verdict"), "verdict", INTAKE_BOUNDS["id_chars"],
                              INTAKE_TOKEN_RE)
        if verdict not in INTAKE_ANSWER_VERDICTS:
            raise IntakeRefusal("intake_malformed",
                                "verdict must be one of "
                                f"{'|'.join(INTAKE_ANSWER_VERDICTS)} for an answer")
        scope = intake_text(args.get("scope"), "scope", INTAKE_BOUNDS["text_chars"],
                            INTAKE_TEXT_RE)
        if row["state"] not in allowed:
            raise IntakeRefusal("intake_transition_refused",
                                f"answered is not authorised from {row['state']}")
        if row.get("answered_at") is not None:
            raise IntakeRefusal("intake_transition_refused",
                                f"{ingress_id} was answered at {row['answered_at']}; the answer "
                                "is set once")
        # An answer is NOT a completion: state and work_state are deliberately
        # unchanged, and any result reference passed here is not admitted as one.
        row["answered_at"] = at
        row["review"].append({"at": at, "verdict": verdict, "scope": scope})
        intake_history(row, kind, at, row["state"])
    elif kind == "work-completed":
        verdict = intake_text(args.get("verdict"), "verdict", INTAKE_BOUNDS["id_chars"],
                              INTAKE_TOKEN_RE)
        if verdict not in INTAKE_WORK_VERDICTS:
            raise IntakeRefusal("intake_malformed",
                                "verdict must be one of "
                                f"{'|'.join(INTAKE_WORK_VERDICTS)} for a work completion")
        ref = intake_text(args.get("result-ref"), "result-ref",
                          INTAKE_BOUNDS["result_ref_chars"], INTAKE_REFERENCE_RE)
        evidence = intake_text(args.get("evidence-sha256"), "evidence-sha256", 64, HEX64_RE)
        if row["state"] not in allowed:
            raise IntakeRefusal("intake_transition_refused",
                                f"work-completed is not authorised from {row['state']}")
        if row.get("result") is not None:
            raise IntakeRefusal("intake_transition_refused",
                                f"{ingress_id} already carries a completion result; it is set "
                                "once")
        # `review` is the human-answer log and nothing else: a work verdict appended here was
        # indistinguishable from an answer, and showed a review on a row nobody had answered
        # (ir1166bcx R3). No fact is lost — the verdict and its evidence are in `result` and the
        # appended history entry, and the work axis is result + history + work_state.
        row["result"] = {"verdict": verdict, "result_ref": ref, "evidence_sha256": evidence}
        intake_history(row, kind, at, "completed")
        row["work_state"] = "completed"
    elif kind == "fail":
        reason = intake_text(args.get("reason"), "reason", INTAKE_BOUNDS["text_chars"],
                             INTAKE_TOKEN_RE)
        if reason not in INTAKE_FAILURE_REASONS:
            raise IntakeRefusal("intake_malformed",
                                f"reason must be one of {'|'.join(INTAKE_FAILURE_REASONS)}")
        if row["state"] not in allowed:
            raise IntakeRefusal("intake_transition_refused",
                                f"fail is not authorised from {row['state']}")
        # Recorded, never swept: a failed row is never pruned, at any age.
        row["failure"] = {"at": at, "reason": reason}
        intake_history(row, kind, at, "failed")
        row["work_state"] = "failed"
    elif kind == "cancel":
        reason = intake_text(args.get("reason"), "reason", INTAKE_BOUNDS["text_chars"],
                             INTAKE_TEXT_RE)
        if row["state"] not in allowed:
            raise IntakeRefusal("intake_transition_refused",
                                f"cancel is not authorised from {row['state']}")
        # Scope-exact to this one row, and never a completion: nothing touches
        # `result`, and a cancellation is not a review verdict, so `review` stays
        # as it was. The reason is preserved in the appended history entry.
        intake_history(row, kind, at, "cancelled", reason=reason)
        row["work_state"] = "cancelled"
    else:
        raise IntakeRefusal("invalid_argument", f"unknown intake event kind {kind!r}")
    intake_bounds_check(row)
    return row


def op_intake_event(args: dict) -> int:
    """One intake fact, one commit, under the INTAKE lock only.

    0 written · 4 refused/invalid · 8 replay/duplicate/archived · 9 storage."""
    kind = args["kind"]
    try:
        if kind not in INTAKE_TRANSITIONS:
            raise IntakeRefusal("invalid_argument", f"unknown intake event kind {kind!r}")
        at = intake_text(now_iso(args.get("now")), "now", 32, INTAKE_AT_RE)
        ingress_id = intake_text(args.get("ingress-id"), "ingress-id",
                                 INTAKE_BOUNDS["id_chars"], INTAKE_UUID4_RE)
        with _Lock(intake_lock_path()):
            doc = intake_load()
            row = (intake_creation(doc, kind, ingress_id, args, at)
                   if kind in ("captured", "amend")
                   else intake_mutation(doc, kind, ingress_id, args, at))
            intake_commit(doc)
    except IntakeRefusal as exc:
        emit({"result": exc.result, "detail": exc.detail, "completion_fact": None})
        return INTAKE_EXITS[exc.result]
    emit({"result": "intake_written", "kind": kind, "ingress_id": ingress_id,
          "state": row["state"], "work_state": row["work_state"],
          "generation": doc["generation"], "completion_fact": None})
    return OK


INTAKE_NOTICE_MAX_EVENTS = 64
INTAKE_NOTICE_MAX_ATTEMPTS = 16
INTAKE_NOTICE_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")


def intake_notice_id(ingress: str) -> str:
    return hashlib.sha256("\0".join(("intake-notice-v1", ingress, "1")).encode("utf-8")).hexdigest()


def intake_notice_time(value: object) -> bool:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", value):
        return False
    try:
        datetime.datetime.fromisoformat(value[:-1] + "+00:00")
        return True
    except ValueError:
        return False


def intake_notice_token(value: object, claim: bool = False) -> bool:
    return (isinstance(value, str) and INTAKE_NOTICE_TOKEN.fullmatch(value) is not None
            and (not claim or value != "none"))


def intake_notice_integer(value: object, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high


def intake_notice_event_valid(e: object) -> bool:
    if not isinstance(e, dict):
        return False
    common = {"action", "ingress_id", "notice_id", "attempt", "claim", "owner", "at"}
    action = e.get("action")
    extra = ({"previous_attempt", "previous_claim"} if action == "claim"
             else {"status", "evidence_sha256", "retry_at"} if action in ("result", "resolve")
             else {"evidence_sha256"} if action == "ack" else None)
    if extra is None or set(e) != common | extra:
        return False
    if (not isinstance(e["ingress_id"], str) or not INTAKE_UUID4_RE.fullmatch(e["ingress_id"])
            or not isinstance(e["notice_id"], str) or not HEX64_RE.fullmatch(e["notice_id"])
            or not intake_notice_integer(e["attempt"], 1, INTAKE_NOTICE_MAX_ATTEMPTS + 1)
            or not intake_notice_token(e["claim"], True) or not intake_notice_token(e["owner"])
            or not intake_notice_time(e["at"])):
        return False
    if action == "claim":
        return (intake_notice_integer(e["previous_attempt"], 0, INTAKE_NOTICE_MAX_ATTEMPTS)
                and (e["previous_claim"] is None if e["previous_attempt"] == 0
                     else intake_notice_token(e["previous_claim"], True)))
    if not isinstance(e["evidence_sha256"], str) or not HEX64_RE.fullmatch(e["evidence_sha256"]):
        return False
    if action == "ack":
        return True
    if e["status"] not in ("sent", "not_sent") and not (action == "result" and e["status"] == "unknown"):
        return False
    return ((intake_notice_time(e["retry_at"]) and e["retry_at"] >= e["at"])
            if e["status"] == "not_sent" else e["retry_at"] is None)


def intake_notice_append(events: list, e: dict) -> str | None:
    if e["attempt"] > INTAKE_NOTICE_MAX_ATTEMPTS:
        return "intake_bounds_exceeded"
    last = events[-1] if events else None
    if e["action"] == "claim":
        if (e["previous_attempt"] != (last["attempt"] if last else 0)
                or e["previous_claim"] != (last["claim"] if last else None)):
            return "intake_notice_race"
        if (e["attempt"] != (last["attempt"] if last else 0) + 1
                or any(old["action"] == "claim" and old["claim"] == e["claim"] for old in events)
                or (last and (last["action"] not in ("result", "resolve")
                              or last["status"] != "not_sent" or last["retry_at"] is None
                              or e["at"] < last["retry_at"]))):
            return "intake_transition_refused"
    else:
        if not last or any(e[k] != last[k] for k in ("attempt", "claim", "owner")):
            return "intake_transition_refused"
        allowed = (last["action"] == "claim" if e["action"] == "result"
                   else last["action"] == "result" and last["status"] == "unknown"
                   if e["action"] == "resolve"
                   else last["action"] in ("result", "resolve") and last["status"] == "sent")
        if not allowed:
            return "intake_transition_refused"
    if last and e["at"] < last["at"]:
        return "intake_transition_refused"
    return "intake_bounds_exceeded" if len(events) >= INTAKE_NOTICE_MAX_EVENTS else None


def intake_notice_valid(value: object, ingress: str) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict):
        return False
    if "version" not in value:
        return set(value) == {"claim", "owner", "at"} and all(isinstance(v, str) for v in value.values())
    if (set(value) != {"version", "notice_id", "generation", "events"}
            or type(value["version"]) is not int or value["version"] != 1
            or type(value["generation"]) is not int or value["generation"] != 1
            or value["notice_id"] != intake_notice_id(ingress)
            or not isinstance(value["events"], list)
            or not 1 <= len(value["events"]) <= INTAKE_NOTICE_MAX_EVENTS):
        return False
    prior = []
    for e in value["events"]:
        if (not intake_notice_event_valid(e) or e["ingress_id"] != ingress
                or e["notice_id"] != value["notice_id"] or intake_notice_append(prior, e) is not None):
            return False
        prior.append(e)
    return True


def intake_notice_mutation(doc: dict, e: dict) -> dict:
    if not intake_notice_event_valid(e):
        raise IntakeRefusal("intake_malformed", "invalid notice event")
    if e["notice_id"] != intake_notice_id(e["ingress_id"]):
        raise IntakeRefusal("intake_identity_collision", "notice identity does not match ingress")
    row = intake_find(doc, e["ingress_id"])
    if row is None:
        raise IntakeRefusal("intake_not_found", "notice target is not in hot ledger")
    notice = row.get("notice")
    if notice is not None and "version" not in notice:
        raise IntakeRefusal("intake_transition_refused", "legacy claim outcome is unknown")
    events = notice["events"] if notice else []
    if e in events:
        raise IntakeRefusal("intake_notice_replay", "exact retained notice event")
    refused = intake_notice_append(events, e)
    if refused:
        raise IntakeRefusal(refused, "notice append refused")
    if e["action"] == "claim" and (row.get("state") != "queued" or row.get("work_state") != "unstarted"
            or any(k not in row or row[k] is not None for k in ("pause", "superseded_by", "result", "failure"))):
        raise IntakeRefusal("intake_transition_refused", "notice target is not queued and unstarted")
    row["notice"] = {"version": 1, "notice_id": e["notice_id"], "generation": 1, "events": [*events, dict(e)]}
    return row


def op_intake_notice(args: dict) -> int:
    """Evidence custody only: no transport/probing, lifecycle mutation or authenticity claim.

    Archived rows have no ACK/recovery writer in this slice; only hot rows are addressable.
    """
    try:
        e = {k.replace("-", "_"): v for k, v in args.items() if k != "now"}
        e["at"] = args.get("now")
        for key in ("attempt", "previous_attempt"):
            if key in e:
                if not re.fullmatch(r"0|[1-9][0-9]{0,2}", e[key]):
                    raise IntakeRefusal("intake_malformed", "invalid notice integer")
                e[key] = int(e[key])
        for key in ("previous_claim", "retry_at"):
            if e.get(key) == "none":
                e[key] = None
        with _Lock(intake_lock_path()):
            doc = intake_load()
            row = intake_notice_mutation(doc, e)
            intake_commit(doc)
    except IntakeRefusal as exc:
        emit({"result": exc.result, "detail": exc.detail, "completion_fact": None})
        return INTAKE_EXITS[exc.result]
    emit({"result": "intake_written", "action": e["action"], "ingress_id": e["ingress_id"],
          "notice_id": e["notice_id"], "state": row["state"], "work_state": row["work_state"],
          "generation": doc["generation"], "completion_fact": None})
    return OK


def op_intake_list(args: dict) -> int:
    """Read-only and unlocked, like get/list/snapshot/report-list.

    `position` is DERIVED here and never stored: ascending (received_at,
    ingress_id) over rows that are neither closed nor superseded. It is receipt
    order — not commit order, not execution order — and the label says so. A
    closed or superseded row is still listed, with position null; an amended
    request is therefore not counted twice.

    `--jsonl` is one row per line. It is NOT the bounded `list --jsonl` paging
    core (#1172): jsonl_requested() is scoped to argv[0] == "list", so nothing
    here touches that path or its exit mapping."""
    doc = intake_load()
    rows = sorted(doc["requests"], key=lambda r: (r["received_at"], r["ingress_id"]))
    wanted_state, wanted_id = args.get("state"), args.get("ingress-id")
    if wanted_state is not None and wanted_state not in INTAKE_STATES:
        raise RegistryError("invalid_argument", f"intake-list: unknown state {wanted_state!r}")
    position = 0
    listed = []
    for row in rows:
        open_row = row["state"] not in INTAKE_CLOSED and row.get("superseded_by") is None
        if open_row:
            position += 1
        if wanted_state is not None and row["state"] != wanted_state:
            continue
        if wanted_id is not None and row["ingress_id"] != wanted_id:
            continue
        listed.append({**row, "position": position if open_row else None})
    if args.get("jsonl"):
        for row in listed:
            print(json.dumps(row, ensure_ascii=True, separators=(",", ":")))
        return OK
    print(json.dumps({"schema_version": doc["schema_version"], "generation": doc["generation"],
                      "order": INTAKE_ORDER_LABEL, "count": len(listed), "requests": listed},
                     ensure_ascii=False, indent=2))
    return OK


def op_intake_prune(args: dict) -> int:
    """Archive a CLOSED and AGED row, and nothing else, ever.

    The #1170 precedent in op_prune, applied to an obligation that outlives any
    dispatch: a row in queued/in_progress/waiting/failed is never reclaimed at
    any age, a superseded but open row is never reclaimed, and no row is dropped
    that is not durably archived first. On an archive OSError EVERY candidate
    stays hot, in place, byte-identical, and the op surfaces
    registry_write_failed. Dispatch cleanup, session reaping, cleaned /
    cutover_retired and Layer-D retirement have no path to an intake row."""
    cutoff = int(args.get("older-than-seconds") or 86400)
    at = now_iso(args.get("now"))
    now_dt = datetime.datetime.fromisoformat(at.replace("Z", "+00:00"))
    archive_error = None
    with _Lock(intake_lock_path()):
        doc = intake_load()
        keep, archive = [], []
        for row in doc["requests"]:
            aged = False
            # Closed and aged, and nothing else. Supersession is NOT a retention rule: a
            # cancelled or completed row that happens to have been superseded is finished work,
            # and gating on it here left such a row hot forever at any age while the pure core
            # archived it (ir1166bcx R1). The supersession exclusion belongs to FIFO accounting
            # in op_intake_list, where it stays, so an amended request is still never counted
            # twice in the queue. An OPEN superseded row is still retained — by the closed test.
            if row["state"] in INTAKE_CLOSED:
                try:
                    seen = datetime.datetime.fromisoformat(
                        str(row.get("last_event_at", "")).replace("Z", "+00:00"))
                    aged = (now_dt - seen).total_seconds() > cutoff
                except ValueError:
                    aged = False
            if aged:
                archive.append(row)
            else:
                keep.append(row)
        if archive:
            try:
                append_intake_archive(archive, at)
            except OSError as exc:
                # Never drop a record that is not durably archived: keep them all
                # hot, in place, and write nothing at all.
                archive_error = (f"intake archive append failed, {len(archive)} record(s) "
                                 f"kept: {exc}")
                archive = []
                keep = list(doc["requests"])
        if archive:
            doc["requests"] = keep
            intake_commit(doc)
    if archive_error:
        raise RegistryError("registry_write_failed", archive_error)
    emit({"result": "pruned", "archived": len(archive), "kept": len(keep),
          "completion_fact": None})
    return OK


OPS = {
    "archive-sidecars": (op_archive_sidecars, ()),
    "begin-delivery": (op_begin_delivery, ("sid", "ref-hash")),
    "check-dedup": (op_check_dedup, ("sid", "ref-hash")),
    "get": (op_get, ("sid",)),
    "intake-event": (op_intake_event, ("kind", "ingress-id")),
    "intake-notice": (op_intake_notice, ("action", "ingress-id", "notice-id", "attempt", "claim", "owner", "now")),
    "intake-list": (op_intake_list, ()),
    "intake-prune": (op_intake_prune, ()),
    "list": (op_list, ()),
    "migrate": (op_migrate, ()),
    "observe": (op_observe, ("sid", "kind")),
    "prune": (op_prune, ()),
    "report-event": (op_report_event, ("dispatch-id", "kind", "item")),
    "report-list": (op_report_list, ()),
    "set-gate": (op_set_gate, ("sid",)),
    "set-lifecycle": (op_set_lifecycle, ("sid",)),
    "set-transport-result": (op_set_transport_result, ("sid", "result")),
    "snapshot": (op_snapshot, ()),
}

# Flags each operation accepts. Unknown names fail closed rather than being
# silently ignored — a typo must never look like a successful write.
FLAGS = {
    "archive-sidecars": {"dir"},
    "begin-delivery": {"sid", "ref-hash", "ref-path", "cwd", "from", "track", "role",
                       "branch", "worktree", "keep-alive", "now", "retry-unknown",
                       "attempt", "manifest-sha256", "report-request-id", "report-challenge-sha256"},
    "check-dedup": {"sid", "ref-hash"},
    "get": {"sid", "pointer"},
    # #1166 intake ledger. No flag here is ever interpolated into a path.
    "intake-event": {"kind", "ingress-id", "capture-id", "channel", "upstream-namespace",
                     "upstream-delivery-id", "upstream-id-status", "upstream-scope-sha256",
                     "sha256", "byte-len", "received-at", "owning-task", "dispatch-id",
                     "verdict", "scope", "result-ref", "evidence-sha256", "reason", "owner",
                     "resume-condition", "depends-on", "supersedes", "now"},
    "intake-list": {"state", "ingress-id", "jsonl"},
    "intake-notice": {"action", "ingress-id", "notice-id", "attempt", "claim", "owner", "now",
                      "previous-attempt", "previous-claim", "status", "evidence-sha256", "retry-at"},
    "intake-prune": {"older-than-seconds", "now"},
    "list": {"fields", "live", "not-retired", "keep-alive", "due-before",
             "jsonl", "limit", "after", "since-generation"},
    "migrate": {"now"},
    # `all` is offered ONLY here and on set-lifecycle: these two describe the
    # session, and a session has as many records as it had dispatches (#853).
    "observe": {"sid", "kind", "field", "json", "now", "all"},
    "prune": {"older-than-seconds", "now"},
    "report-event": {"dispatch-id", "kind", "item", "sha256", "expect-n", "field", "now"},
    "report-list": {"sid", "all"},
    "set-gate": {"sid", "state", "clear", "now"},
    "set-lifecycle": {"sid", "state", "re-dispatch-count", "bump-re-dispatch-count",
                      "expected-report-by", "extend-minutes", "now", "all"},
    "set-transport-result": {"sid", "result", "inject-id", "now"},
    "snapshot": set(),
}
BOOLEAN_FLAGS = {"keep-alive", "live", "not-retired", "clear", "bump-re-dispatch-count",
                 "all", "jsonl"}
REPEATED_FLAGS = {"field", "depends-on"}


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def parse(argv: list[str]) -> tuple[str, dict]:
    if not argv:
        raise RegistryError("usage", "operation required")
    if argv[0] == "--list-ops":
        for name in sorted(OPS):
            print(name)
        raise SystemExit(OK)
    op = argv[0]
    if op not in OPS:
        raise RegistryError("unknown_operation", f"unknown operation {op!r}")
    allowed = FLAGS[op]
    if op == "list" and not jsonl_requested(argv):
        allowed = allowed - JSONL_FLAGS
    args: dict = {}
    rest = argv[1:]
    while rest:
        token = rest.pop(0)
        if not token.startswith("--"):
            raise RegistryError("invalid_argument", f"unexpected argument {token!r}")
        name = token[2:]
        if op == "intake-notice" and name in args:
            raise RegistryError("invalid_argument", f"{op}: duplicate field {name!r}")
        if name not in allowed:
            raise RegistryError("invalid_argument", f"{op}: unknown field {name!r}")
        if name in BOOLEAN_FLAGS:
            args[name] = True
            continue
        if not rest:
            raise RegistryError("invalid_argument", f"{op}: --{name} needs a value")
        value = rest.pop(0)
        if name in REPEATED_FLAGS:
            args.setdefault(name, []).append(value)
        else:
            args[name] = value
    for required in OPS[op][1]:
        if not args.get(required):
            raise RegistryError("invalid_argument", f"{op}: --{required} is required")
    return op, args


def main(argv: list[str]) -> int:
    jsonl = jsonl_requested(argv)
    try:
        op, args = parse(argv)
        refuse_transition_artifacts()
        return OPS[op][0](args)
    except RegistryError as exc:
        if not jsonl and exc.result in ("registry_corrupt", "registry_unavailable", "registry_write_failed"):
            health(exc.result, exc.detail)
        if jsonl:
            # Fixed, nonsensitive: no detail, path, id or registry bytes; stdout empty.
            sys.stderr.write(f"dispatch-registry: list --jsonl: {exc.result}\n")
            return JSONL_EXIT.get(exc.result, REGISTRY_ERROR)
        emit({"result": exc.result, "detail": exc.detail, "completion_fact": None})
        if exc.result in ("usage", "unknown_operation", "invalid_argument"):
            return USAGE
        return REGISTRY_ERROR
    except Exception:
        if not jsonl:
            raise
        # New mode never prints a traceback that could quote registry values.
        sys.stderr.write("dispatch-registry: list --jsonl: registry_error\n")
        return REGISTRY_ERROR


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
