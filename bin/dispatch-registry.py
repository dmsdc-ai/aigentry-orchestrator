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
                 delivery unknown, re-dispatched, cleaned, quarantined…).
    gate         whether a human is holding it (HITL).
    observations everything that was measured, each explicitly nonterminal.

Every operation is one transaction: exclusive flock on a STABLE sibling
lockfile (never the active.json inode, which an atomic rename replaces), full
schema validation, same-directory temp file, fsync(temp), atomic rename,
fsync(directory). Corruption is fail-closed: bytes are preserved, a health line
is written OUTSIDE the corrupt file, and nothing is delivered, pruned or
restored. There is no `r+ → truncate → json.dump` path anywhere.

Article 17: Python standard library only.

Exit codes: 0 ok · 4 usage · 7 delivery-unknown/retry-held · 8 deduplicated ·
9 registry error.
"""

from __future__ import annotations

import datetime
import errno
import fcntl
import hashlib
import json
import os
import shutil
import sys
import time
import uuid

OK, USAGE, RETRY_HELD, DEDUPLICATED, REGISTRY_ERROR = 0, 4, 7, 8, 9

SCHEMA_VERSION = 2
LOCK_TIMEOUT_S = 10.0

# Lifecycles that are finished with: pruning may reclaim them and the pollers
# skip them. None of them says anything about the TASK.
RETIRED_LIFECYCLES = {"cleaned", "cutover_retired", "delivery_failed", "not_delivered"}

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

    def __enter__(self):
        if fault("lock"):
            raise RegistryError("registry_unavailable", "lock acquisition faulted (test seam)")
        os.makedirs(state_dir(), exist_ok=True)
        self.fh = open(self.path, "a+")
        deadline = time.monotonic() + LOCK_TIMEOUT_S
        while True:
            try:
                fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError as exc:
                if exc.errno not in (errno.EAGAIN, errno.EACCES):
                    raise RegistryError("registry_unavailable", f"lock failed: {exc}")
                if time.monotonic() >= deadline:
                    raise RegistryError("registry_unavailable",
                                        f"lock timeout after {LOCK_TIMEOUT_S}s")
                time.sleep(0.05)

    def __exit__(self, *exc_info):
        if self.fh is not None:
            fcntl.flock(self.fh, fcntl.LOCK_UN)
            self.fh.close()
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
    return doc


def load(required: bool = True) -> dict:
    path = registry_path()
    if not os.path.exists(path):
        if required:
            return {"schema_version": SCHEMA_VERSION, "generation": 0, "dispatches": []}
        raise RegistryError("registry_unavailable", f"no registry at {path}")
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
    except json.JSONDecodeError as exc:
        raise RegistryError("registry_corrupt", f"unparseable registry: {exc}")
    except OSError as exc:
        raise RegistryError("registry_unavailable", f"cannot read registry: {exc}")
    return validate(raw)


def commit(doc: dict) -> None:
    """temp → fsync(temp) → rename → fsync(dir). Recovery sees one complete
    generation or the other, never a half-written file."""
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


def append_observation(rec: dict, kind: str, at: str, **fields) -> None:
    obs = {"kind": kind, "at": at, "terminal": False}
    obs.update({k: v for k, v in fields.items() if v is not None})
    rec.setdefault("observations", []).append(obs)
    rec["last_observation"] = obs
    rec["last_seen_at"] = at


def dedup_verdict(doc: dict, key: str) -> tuple[str, dict | None]:
    matches = [r for r in doc["dispatches"] if r["dedup"]["key"] == key]
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
          "completion_fact": None})
    return {"proceed": OK, "retry_held": RETRY_HELD, "deduplicated": DEDUPLICATED}[verdict]


def op_begin_delivery(args: dict) -> int:
    """The authoritative write-before-delivery transaction. Only its `proceed`
    result authorizes handing bytes to telepty."""
    at = now_iso(args.get("now"))
    sid, ref_hash = args["sid"], args["ref-hash"]
    key = dedup_key(sid, ref_hash)
    with _Lock():
        doc = load()
        verdict, prior = dedup_verdict(doc, key)
        if verdict != "proceed":
            kind = "dedup_suppressed" if verdict == "deduplicated" else "dedup_retry_held"
            append_observation(prior, kind, at, ref_hash=ref_hash)
            commit(doc)
            emit({"result": ("DISPATCH_DEDUPLICATED" if verdict == "deduplicated"
                             else "DISPATCH_RETRY_HELD"),
                  "dispatch_id": prior["dispatch_id"],
                  "new_delivery": False,
                  "prior_transport": ("write_observed" if verdict == "deduplicated" else "unknown"),
                  "outcome": "unknown",
                  "completion_fact": None})
            return DEDUPLICATED if verdict == "deduplicated" else RETRY_HELD

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
        append_observation(record, "dispatch_tracking_started", at)
        doc["dispatches"].append(record)
        commit(doc)
    emit({"result": "proceed", "dispatch_id": record["dispatch_id"],
          "new_delivery": True, "outcome": "unknown", "completion_fact": None})
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
        rec = require_record(doc, args["sid"])
        append_observation(rec, args["kind"], at, **extra)
        commit(doc)
    return OK


def op_set_lifecycle(args: dict) -> int:
    """A re-dispatch IS a lifecycle transition, so the attempt counter and the
    deadline move with it rather than through an outcome-shaped operation."""
    at = now_iso(args.get("now"))
    with _Lock():
        doc = load()
        rec = require_record(doc, args["sid"])
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
        for rec in doc["dispatches"]:
            if rec["lifecycle"]["state"] in RETIRED_LIFECYCLES:
                try:
                    seen = datetime.datetime.fromisoformat(
                        str(rec.get("last_seen_at", "")).replace("Z", "+00:00"))
                    if (now_dt - seen).total_seconds() > cutoff:
                        continue
                except ValueError:
                    pass
            keep.append(rec)
        doc["dispatches"] = keep
        commit(doc)
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
    for name in os.listdir(src):
        shutil.move(os.path.join(src, name), os.path.join(dest, name))
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
                       "branch", "worktree", "keep-alive", "now"},
    "check-dedup": {"sid", "ref-hash"},
    "get": {"sid", "pointer"},
    "list": {"fields", "live", "not-retired", "keep-alive", "due-before"},
    "migrate": {"now"},
    "observe": {"sid", "kind", "field", "json", "now"},
    "prune": {"older-than-seconds", "now"},
    "set-gate": {"sid", "state", "clear", "now"},
    "set-lifecycle": {"sid", "state", "re-dispatch-count", "bump-re-dispatch-count",
                      "expected-report-by", "extend-minutes", "now"},
    "set-transport-result": {"sid", "result", "inject-id", "now"},
    "snapshot": set(),
}
BOOLEAN_FLAGS = {"keep-alive", "live", "not-retired", "clear", "bump-re-dispatch-count"}
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
    try:
        op, args = parse(argv)
        return OPS[op][0](args)
    except RegistryError as exc:
        if exc.result in ("registry_corrupt", "registry_unavailable", "registry_write_failed"):
            health(exc.result, exc.detail)
        emit({"result": exc.result, "detail": exc.detail, "completion_fact": None})
        if exc.result in ("usage", "unknown_operation", "invalid_argument"):
            return USAGE
        return REGISTRY_ERROR


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
