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

    Snyk taints this env var and follows it into `open()` and `os.replace()`.
    The finding is accepted rather than fixed, for these reasons:

      * every filename under this directory is a FIXED LITERAL — `active.json`,
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
    inodes and both think they were exclusive."""

    def __init__(self) -> None:
        self.path = registry_path() + ".lock"
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
                    return self
        except BaseException as exc:
            self.__exit__(*sys.exc_info())
            if isinstance(exc, OSError):
                raise RegistryError("registry_unavailable", f"lock failed: {exc}") from exc
            raise

    def __exit__(self, *exc_info):
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
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
    except json.JSONDecodeError as exc:
        raise RegistryError("registry_corrupt", f"unparseable registry: {exc}")
    except OSError as exc:
        raise RegistryError("registry_unavailable", f"cannot read registry: {exc}")
    return validate(raw)


def load_bounded(path: str, limit: int) -> object:
    """list --jsonl only: read at most limit+1 bytes from ONE opened file, then
    parse. The default load() path above is unchanged."""
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
    doc = load(limit=JSONL_READ_LIMIT)
    generation = doc["generation"]
    if type(generation) is not int or not 0 <= generation <= JSONL_MAX_INT:
        raise RegistryError("registry_corrupt", "generation out of range")
    if cursor is not None and cursor[0] != generation:
        raise RegistryError("stale_cursor", "registry generation changed")
    if cursor is not None and cursor[3] != live:
        raise RegistryError("invalid_argument", "list --jsonl: cursor filter mismatch")
    matching = []
    for rec in doc["dispatches"]:
        gate = rec.get("gate")
        if gate is not None and not isinstance(gate, dict):
            raise RegistryError("registry_corrupt", "gate axis is not an object")
        gated = gate is not None and gate.get("state") is not None
        if live and (rec["lifecycle"]["state"] in RETIRED_LIFECYCLES or gated):
            continue
        matching.append(rec)
    matching.sort(key=jsonl_key)
    header = {"v": 1, "generation": generation, "unchanged": since == generation,
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
                row[field], oversize = jsonl_value(pointer(rec, field))
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
    print(json.dumps(load(), ensure_ascii=False, indent=2))
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
        # becomes part of a path. Everything else joins a fixed literal. Confine
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


OPS = {
    "archive-sidecars": (op_archive_sidecars, ()),
    "begin-delivery": (op_begin_delivery, ("sid", "ref-hash")),
    "check-dedup": (op_check_dedup, ("sid", "ref-hash")),
    "get": (op_get, ("sid",)),
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
REPEATED_FLAGS = {"field"}


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
        if exc.result in ("registry_corrupt", "registry_unavailable", "registry_write_failed"):
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
