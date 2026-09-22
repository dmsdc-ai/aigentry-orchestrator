// Task1167 / release1171 — Windows owned-lifetime prototype (operation wn1167a-v1).
//
// Narrow Win32 job/handle/control binding for the architecture selected in
// architecture/DECISION.md (SHA256 b3e9e64359812d56021e7f542570dbd57d35508e1ec5db2dc2e39284b5ee18a8).
// Two disjoint halves live here on purpose, because both halves must speak the
// same control framing and share the same handle rules:
//
//   caller half  — createInvocation/arm/cancel/snapshot/finish/dispose.
//                  Owns the per-invocation unnamed Job Object (KILL_ON_JOB_CLOSE,
//                  no breakaway), the private control pipe, and one native control
//                  thread that enforces every deadline while the caller's
//                  JavaScript is blocked (spawnSync).
//   broker half  — acquireOwnership/controlSend/controlClose.
//                  Authenticates the originating caller by PID *and* process
//                  creation time, duplicates the caller's job handle, self-assigns,
//                  and closes the temporary duplicate BEFORE any payload frame is
//                  even read. That close is the execution barrier.
//
// NOT COMPILED HERE: no Windows SDK is available in the authoring environment, so
// this translation unit has never been through a compiler. It is submitted for
// independent Windows compilation; compiler diagnostics route back unchanged.
//
// Documented-API notes: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, AssignProcessToJobObject
// nesting/assignment restrictions, DuplicateHandle object sharing and
// WaitForSingleObject return discrimination follow the frozen official pages. The
// named-pipe identity calls (GetNamedPipeServerProcessId / GetNamedPipeClientProcessId),
// PIPE_REJECT_REMOTE_CLIENTS, FILE_FLAG_FIRST_PIPE_INSTANCE, CancelIoEx and
// BCryptGenRandom are documented Win32 but are NOT covered by those six frozen
// pages; they are listed as owing API-level review in output/REPORT.md.

#ifndef _WIN32
#error "owned-job.cc is Windows-only. POSIX callers must not build or load this addon."
#endif

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <node_api.h>

namespace {

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------
// One ASCII line per message, '\n' terminated, strictly tokenised. Only the
// caller->broker PAYLOAD line carries user data, it is base64 of UTF-8 JSON, and
// it is transmitted only after the broker reports the ownership barrier. Native
// code never parses JSON; the broker parses exactly one JSON document, after it
// already owns the job.
//
//   caller -> broker : AIGJOB1 IDENT <pid> <creation64> <jobHandle64> <handshakeMs> <handoffHoldMs> <faultMode>
//   caller -> broker : AIGJOB1 PAYLOAD <base64>
//   broker -> caller : AIGJOB1 HELLO <brokerPid>
//   broker -> caller : AIGJOB1 OWNED <activeProcesses> <atMs>
//   broker -> caller : AIGJOB1 LAUNCHED <rootPid> <atMs>
//   broker -> caller : AIGJOB1 EXIT <exitCode> <atMs> <stdoutBytes> <stderrBytes> <drainComplete>
//   broker -> caller : AIGJOB1 LAUNCHERR <winError> <errnoTag> <atMs>
//   broker -> caller : AIGJOB1 FAULT <stageCode> <winError> <atMs>
//
// Broker->caller lines are hard-capped at kControlLineMax bytes; the payload line
// is capped separately at kPayloadLineMax. Anything else is a protocol fault and
// fails closed.

const size_t kControlLineMax = 512;
const size_t kPayloadLineMax = 1u << 20;         // 1 MiB of base64 envelope.
const DWORD kTerminateExitCode = 0xA1;           // Distinguishes job termination.
const DWORD kAccountingPollMs = 10;
const DWORD kMaxEvents = 64;

// cancel() reason codes. 0 = not cancelled.
const uint32_t kCancelAbort = 1;
const uint32_t kCancelBuffer = 2;

uint64_t NowMs() { return GetTickCount64(); }

uint64_t FileTimeToU64(const FILETIME& ft) {
  ULARGE_INTEGER v;
  v.LowPart = ft.dwLowDateTime;
  v.HighPart = ft.dwHighDateTime;
  return v.QuadPart;
}

// Process identity is (PID, creation time). PID alone is reusable; the pair is
// what both halves authenticate against.
bool ProcessCreation(HANDLE process, uint64_t* out) {
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return false;
  *out = FileTimeToU64(created);
  return true;
}

DWORD RemainingMs(uint64_t deadline) {
  uint64_t now = NowMs();
  if (now >= deadline) return 0;
  uint64_t left = deadline - now;
  return left > MAXDWORD ? MAXDWORD : static_cast<DWORD>(left);
}

// ---------------------------------------------------------------------------
// Deadline-bounded overlapped I/O
// ---------------------------------------------------------------------------

enum IoOutcome { kIoOk, kIoTimeout, kIoSignalled, kIoFailed };

// Waits for one overlapped operation, an optional auxiliary event (cancel, or
// parent death), and a deadline. On timeout/abort the operation is cancelled and
// then reaped: the handle is never closed while an I/O is still outstanding.
IoOutcome WaitIo(HANDLE file, OVERLAPPED* ov, HANDLE aux, DWORD timeoutMs,
                 DWORD* transferred, DWORD* winError) {
  HANDLE waits[2];
  DWORD count = 0;
  waits[count++] = ov->hEvent;
  if (aux != NULL) waits[count++] = aux;

  DWORD wait = WaitForMultipleObjects(count, waits, FALSE, timeoutMs);
  if (wait == WAIT_OBJECT_0) {
    if (GetOverlappedResult(file, ov, transferred, FALSE)) return kIoOk;
    *winError = GetLastError();
    return kIoFailed;
  }
  if (wait == WAIT_FAILED) {
    *winError = GetLastError();
    return kIoFailed;
  }
  // WAIT_TIMEOUT or the auxiliary handle. Cancel, then block until the kernel
  // has released the OVERLAPPED and the buffer.
  CancelIoEx(file, ov);
  DWORD reaped = 0;
  GetOverlappedResult(file, ov, &reaped, TRUE);
  *transferred = 0;
  return wait == WAIT_TIMEOUT ? kIoTimeout : kIoSignalled;
}

// Byte-stream line reader with a residual buffer and an enforced cap.
struct LineReader {
  std::string residual;

  // Returns kIoOk and fills `line` (without the newline) or a non-ok outcome.
  IoOutcome ReadLine(HANDLE pipe, HANDLE aux, uint64_t deadline, size_t maxLine,
                     std::string* line, DWORD* winError) {
    for (;;) {
      size_t nl = residual.find('\n');
      if (nl != std::string::npos) {
        *line = residual.substr(0, nl);
        residual.erase(0, nl + 1);
        if (!line->empty() && (*line)[line->size() - 1] == '\r') line->pop_back();
        return kIoOk;
      }
      if (residual.size() > maxLine) {
        *winError = ERROR_BAD_LENGTH;
        return kIoFailed;
      }
      DWORD remaining = RemainingMs(deadline);
      if (remaining == 0) return kIoTimeout;

      char chunk[4096];
      OVERLAPPED ov;
      ZeroMemory(&ov, sizeof(ov));
      ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
      if (ov.hEvent == NULL) {
        *winError = GetLastError();
        return kIoFailed;
      }
      DWORD got = 0;
      BOOL ok = ReadFile(pipe, chunk, sizeof(chunk), &got, &ov);
      IoOutcome outcome;
      if (ok) {
        outcome = kIoOk;
      } else if (GetLastError() == ERROR_IO_PENDING) {
        outcome = WaitIo(pipe, &ov, aux, remaining, &got, winError);
      } else {
        *winError = GetLastError();
        outcome = kIoFailed;
      }
      CloseHandle(ov.hEvent);
      if (outcome != kIoOk) return outcome;
      if (got == 0) {
        *winError = ERROR_BROKEN_PIPE;
        return kIoFailed;
      }
      residual.append(chunk, got);
    }
  }
};

IoOutcome WriteAll(HANDLE pipe, HANDLE aux, uint64_t deadline, const std::string& data,
                   DWORD* winError) {
  size_t sent = 0;
  while (sent < data.size()) {
    DWORD remaining = RemainingMs(deadline);
    if (remaining == 0) return kIoTimeout;

    OVERLAPPED ov;
    ZeroMemory(&ov, sizeof(ov));
    ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (ov.hEvent == NULL) {
      *winError = GetLastError();
      return kIoFailed;
    }
    DWORD put = 0;
    DWORD slice = static_cast<DWORD>(data.size() - sent > 4096 ? 4096 : data.size() - sent);
    BOOL ok = WriteFile(pipe, data.data() + sent, slice, &put, &ov);
    IoOutcome outcome;
    if (ok) {
      outcome = kIoOk;
    } else if (GetLastError() == ERROR_IO_PENDING) {
      outcome = WaitIo(pipe, &ov, aux, remaining, &put, winError);
    } else {
      *winError = GetLastError();
      outcome = kIoFailed;
    }
    CloseHandle(ov.hEvent);
    if (outcome != kIoOk) return outcome;
    if (put == 0) {
      *winError = ERROR_BROKEN_PIPE;
      return kIoFailed;
    }
    sent += put;
  }
  return kIoOk;
}

// ---------------------------------------------------------------------------
// Caller-side record
// ---------------------------------------------------------------------------

struct Event {
  const char* tag;
  uint32_t at_ms;
  uint32_t a;
  uint32_t b;
};

struct Record {
  std::string state = "created";
  std::string stop_reason;                 // empty until the control thread decides
  uint32_t fault_stage = 0;
  uint32_t fault_win_error = 0;
  uint32_t protocol_faults = 0;

  bool barrier = false;
  uint32_t barrier_at_ms = 0;
  uint32_t barrier_active_processes = 0;

  bool launched = false;
  uint32_t root_pid = 0;
  uint32_t launched_at_ms = 0;

  bool has_root_exit = false;
  uint32_t root_exit_code = 0;
  uint32_t root_exit_at_ms = 0;
  uint32_t root_stdout_bytes = 0;
  uint32_t root_stderr_bytes = 0;
  bool root_drain_complete = false;

  bool has_launch_error = false;
  uint32_t launch_win_error = 0;
  uint32_t launch_errno_tag = 0;

  uint32_t broker_pid = 0;
  uint64_t broker_creation = 0;
  bool broker_exit_observed = false;
  uint32_t broker_exit_code = 0;

  uint32_t job_flags_requested = 0;
  uint32_t job_flags_effective = 0;
  bool job_flags_effective_known = false;

  bool terminate_called = false;
  bool terminate_ok = false;
  uint32_t terminate_win_error = 0;

  std::string cleanup_state = "unknown";
  std::string cleanup_reason = "not-started";
  uint32_t cleanup_elapsed_ms = 0;
  uint32_t active_processes_final = 0;
  bool active_processes_known = false;
  uint32_t total_terminated_processes = 0;

  uint32_t handshake_elapsed_ms = 0;
  uint32_t execution_elapsed_ms = 0;
  uint32_t cancel_reason = 0;

  std::vector<Event> events;
};

struct Invocation {
  HANDLE job = NULL;
  HANDLE pipe = INVALID_HANDLE_VALUE;
  HANDLE cancel_event = NULL;
  HANDLE done_event = NULL;
  HANDLE broker_process = NULL;

  std::wstring pipe_name;
  std::string ident_line;
  std::string payload_line;

  DWORD handshake_ms = 2000;
  DWORD execution_ms = 5000;
  DWORD cleanup_ms = 500;
  DWORD handoff_hold_ms = 0;
  DWORD fault_mode = 0;

  std::atomic<uint32_t> cancel_reason{0};
  std::atomic<bool> armed{false};
  std::atomic<bool> disposed{false};

  std::mutex mu;
  Record rec;
  std::thread worker;
  uint64_t t0 = 0;
};

void PushEvent(Invocation* inv, const char* tag, uint32_t a, uint32_t b) {
  if (inv->rec.events.size() >= kMaxEvents) return;
  Event e;
  e.tag = tag;
  e.at_ms = static_cast<uint32_t>(NowMs() - inv->t0);
  e.a = a;
  e.b = b;
  inv->rec.events.push_back(e);
}

// ---------------------------------------------------------------------------
// Caller-side control thread
// ---------------------------------------------------------------------------

// Terminates the job and then *observes* emptiness. Emptiness is only reported as
// proof when an assignment barrier was actually seen; an empty job that never had
// a member is explicitly not a lifetime oracle.
void RunCleanup(Invocation* inv) {
  bool barrier;
  {
    std::lock_guard<std::mutex> lock(inv->mu);
    barrier = inv->rec.barrier;
    inv->rec.state = "cleanup";
    PushEvent(inv, "terminate", 0, 0);
  }
  uint64_t started = NowMs();

  BOOL ok = TerminateJobObject(inv->job, kTerminateExitCode);
  DWORD terminate_error = ok ? 0 : GetLastError();

  bool zero = false;
  uint32_t active = 0;
  uint32_t total = 0;
  bool accounting_known = false;
  uint64_t deadline = started + inv->cleanup_ms;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION acct;
    ZeroMemory(&acct, sizeof(acct));
    DWORD returned = 0;
    if (QueryInformationJobObject(inv->job, JobObjectBasicAccountingInformation, &acct,
                                  sizeof(acct), &returned) &&
        returned == sizeof(acct)) {
      accounting_known = true;
      active = static_cast<uint32_t>(acct.ActiveProcesses);
      total = static_cast<uint32_t>(acct.TotalTerminatedProcesses);
      if (acct.ActiveProcesses == 0) {
        zero = true;
        break;
      }
    }
    if (NowMs() >= deadline) break;
    Sleep(kAccountingPollMs);
  }

  // Independent corroboration: the broker handle we opened at connect time must
  // also have stopped being STILL_ACTIVE. A stable owned handle is the oracle,
  // never PID absence.
  bool broker_exit_observed = false;
  DWORD broker_exit_code = 0;
  if (inv->broker_process != NULL) {
    DWORD code = 0;
    if (GetExitCodeProcess(inv->broker_process, &code) && code != STILL_ACTIVE) {
      broker_exit_observed = true;
      broker_exit_code = code;
    }
  }

  std::lock_guard<std::mutex> lock(inv->mu);
  inv->rec.terminate_called = true;
  inv->rec.terminate_ok = ok != FALSE;
  inv->rec.terminate_win_error = terminate_error;
  inv->rec.active_processes_known = accounting_known;
  inv->rec.active_processes_final = active;
  inv->rec.total_terminated_processes = total;
  inv->rec.broker_exit_observed = broker_exit_observed;
  inv->rec.broker_exit_code = broker_exit_code;
  inv->rec.cleanup_elapsed_ms = static_cast<uint32_t>(NowMs() - started);

  if (!barrier) {
    inv->rec.cleanup_state = "unknown";
    inv->rec.cleanup_reason = "no-assignment-barrier";
  } else if (!ok) {
    inv->rec.cleanup_state = "failed";
    inv->rec.cleanup_reason = "terminate-failed";
  } else if (!accounting_known) {
    inv->rec.cleanup_state = "unknown";
    inv->rec.cleanup_reason = "accounting-unavailable";
  } else if (!zero) {
    inv->rec.cleanup_state = "unknown";
    inv->rec.cleanup_reason = "active-members-remaining";
  } else if (!broker_exit_observed) {
    inv->rec.cleanup_state = "unknown";
    inv->rec.cleanup_reason = "broker-handle-still-active";
  } else {
    inv->rec.cleanup_state = "complete";
    inv->rec.cleanup_reason = "job-empty-and-handles-exited";
    PushEvent(inv, "accounting-zero", active, total);
  }
  inv->rec.state = "done";
  PushEvent(inv, "done", 0, 0);
}

void SetStop(Invocation* inv, const char* reason) {
  std::lock_guard<std::mutex> lock(inv->mu);
  if (inv->rec.stop_reason.empty()) inv->rec.stop_reason = reason;
}

void SetFault(Invocation* inv, uint32_t stage, DWORD win_error) {
  std::lock_guard<std::mutex> lock(inv->mu);
  if (inv->rec.stop_reason.empty()) {
    inv->rec.stop_reason = "control-fault";
    inv->rec.fault_stage = stage;
    inv->rec.fault_win_error = win_error;
  }
  PushEvent(inv, "fault", stage, win_error);
}

// Caller-side stage codes (disjoint from the broker's own FAULT stage codes,
// which arrive over the wire and are stored separately).
const uint32_t kStageConnect = 101;
const uint32_t kStageHello = 102;
const uint32_t kStageIdentWrite = 103;
const uint32_t kStageOwned = 104;
const uint32_t kStagePayloadWrite = 105;
const uint32_t kStageLaunch = 106;
const uint32_t kStageExecution = 107;
const uint32_t kStageProtocol = 108;

bool ExpectLine(Invocation* inv, LineReader* reader, uint64_t deadline, uint32_t stage,
                std::string* line) {
  DWORD win_error = 0;
  IoOutcome outcome =
      reader->ReadLine(inv->pipe, inv->cancel_event, deadline, kControlLineMax, line, &win_error);
  if (outcome == kIoOk) return true;
  if (outcome == kIoSignalled) {
    SetStop(inv, inv->cancel_reason.load() == kCancelBuffer ? "buffer-overflow" : "cancel");
  } else if (outcome == kIoTimeout) {
    SetStop(inv, stage == kStageExecution ? "deadline" : "handshake-timeout");
    SetFault(inv, stage, WAIT_TIMEOUT);
  } else {
    SetStop(inv, stage == kStageExecution ? "broker-fault" : "handshake-failure");
    SetFault(inv, stage, win_error);
  }
  return false;
}

void ControlThread(Invocation* inv) {
  {
    std::lock_guard<std::mutex> lock(inv->mu);
    inv->rec.state = "armed";
    PushEvent(inv, "armed", 0, 0);
  }

  uint64_t handshake_deadline = inv->t0 + inv->handshake_ms + inv->handoff_hold_ms;
  LineReader reader;

  // --- connect -------------------------------------------------------------
  OVERLAPPED ov;
  ZeroMemory(&ov, sizeof(ov));
  ov.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (ov.hEvent == NULL) {
    SetFault(inv, kStageConnect, GetLastError());
    RunCleanup(inv);
    SetEvent(inv->done_event);
    return;
  }
  bool connected = false;
  if (ConnectNamedPipe(inv->pipe, &ov)) {
    connected = true;
  } else {
    DWORD err = GetLastError();
    if (err == ERROR_PIPE_CONNECTED) {
      connected = true;
    } else if (err == ERROR_IO_PENDING) {
      DWORD transferred = 0;
      DWORD win_error = 0;
      IoOutcome outcome = WaitIo(inv->pipe, &ov, inv->cancel_event,
                                 RemainingMs(handshake_deadline), &transferred, &win_error);
      if (outcome == kIoOk) {
        connected = true;
      } else if (outcome == kIoSignalled) {
        SetStop(inv, "cancel");
      } else if (outcome == kIoTimeout) {
        SetStop(inv, "handshake-timeout");
        SetFault(inv, kStageConnect, WAIT_TIMEOUT);
      } else {
        SetStop(inv, "handshake-failure");
        SetFault(inv, kStageConnect, win_error);
      }
    } else {
      SetStop(inv, "handshake-failure");
      SetFault(inv, kStageConnect, err);
    }
  }
  CloseHandle(ov.hEvent);
  if (!connected) {
    RunCleanup(inv);
    SetEvent(inv->done_event);
    return;
  }

  // The connecting process is the broker identity from the caller's side. We hold
  // its handle for the whole invocation so that "the broker exited" is observed
  // through a stable handle rather than a PID lookup.
  {
    ULONG client_pid = 0;
    if (GetNamedPipeClientProcessId(inv->pipe, &client_pid) && client_pid != 0) {
      HANDLE proc = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                static_cast<DWORD>(client_pid));
      uint64_t creation = 0;
      if (proc != NULL) ProcessCreation(proc, &creation);
      std::lock_guard<std::mutex> lock(inv->mu);
      inv->broker_process = proc;
      inv->rec.broker_pid = static_cast<uint32_t>(client_pid);
      inv->rec.broker_creation = creation;
      inv->rec.state = "connected";
      PushEvent(inv, "connected", static_cast<uint32_t>(client_pid), 0);
    }
  }

  // --- HELLO ---------------------------------------------------------------
  std::string line;
  if (!ExpectLine(inv, &reader, handshake_deadline, kStageHello, &line)) {
    RunCleanup(inv);
    SetEvent(inv->done_event);
    return;
  }
  {
    unsigned hello_pid = 0;
    int consumed = 0;
    if (sscanf_s(line.c_str(), "AIGJOB1 HELLO %u%n", &hello_pid, &consumed) != 1 ||
        consumed != static_cast<int>(line.size())) {
      SetStop(inv, "handshake-failure");
      SetFault(inv, kStageProtocol, ERROR_INVALID_DATA);
      RunCleanup(inv);
      SetEvent(inv->done_event);
      return;
    }
    std::lock_guard<std::mutex> lock(inv->mu);
    // A HELLO whose PID disagrees with the authenticated pipe client is recorded
    // but never preferred over the handle-derived identity.
    if (inv->rec.broker_pid != 0 && inv->rec.broker_pid != hello_pid) inv->rec.protocol_faults++;
    PushEvent(inv, "hello", hello_pid, 0);
  }

  // --- IDENT ---------------------------------------------------------------
  {
    DWORD win_error = 0;
    IoOutcome outcome =
        WriteAll(inv->pipe, inv->cancel_event, handshake_deadline, inv->ident_line, &win_error);
    if (outcome != kIoOk) {
      SetStop(inv, outcome == kIoSignalled ? "cancel" : "handshake-failure");
      if (outcome != kIoSignalled) SetFault(inv, kStageIdentWrite, win_error);
      RunCleanup(inv);
      SetEvent(inv->done_event);
      return;
    }
    std::lock_guard<std::mutex> lock(inv->mu);
    PushEvent(inv, "ident-sent", 0, 0);
  }

  // --- OWNED (the broker's ownership barrier) ------------------------------
  if (!ExpectLine(inv, &reader, handshake_deadline, kStageOwned, &line)) {
    RunCleanup(inv);
    SetEvent(inv->done_event);
    return;
  }
  {
    unsigned active = 0, at_ms = 0, stage = 0, win_error = 0;
    int consumed = 0;
    if (sscanf_s(line.c_str(), "AIGJOB1 OWNED %u %u%n", &active, &at_ms, &consumed) == 2 &&
        consumed == static_cast<int>(line.size())) {
      std::lock_guard<std::mutex> lock(inv->mu);
      inv->rec.barrier = true;
      inv->rec.barrier_active_processes = active;
      inv->rec.barrier_at_ms = static_cast<uint32_t>(NowMs() - inv->t0);
      inv->rec.handshake_elapsed_ms = inv->rec.barrier_at_ms;
      inv->rec.state = "owned";
      PushEvent(inv, "owned", active, at_ms);
    } else if (sscanf_s(line.c_str(), "AIGJOB1 FAULT %u %u %u%n", &stage, &win_error, &at_ms,
                        &consumed) == 3 &&
               consumed == static_cast<int>(line.size())) {
      SetStop(inv, "broker-refusal");
      SetFault(inv, stage, win_error);
      RunCleanup(inv);
      SetEvent(inv->done_event);
      return;
    } else {
      SetStop(inv, "handshake-failure");
      SetFault(inv, kStageProtocol, ERROR_INVALID_DATA);
      RunCleanup(inv);
      SetEvent(inv->done_event);
      return;
    }
  }

  // --- PAYLOAD (first user data on the wire, strictly after the barrier) ----
  {
    DWORD win_error = 0;
    IoOutcome outcome =
        WriteAll(inv->pipe, inv->cancel_event, handshake_deadline, inv->payload_line, &win_error);
    if (outcome != kIoOk) {
      SetStop(inv, outcome == kIoSignalled ? "cancel" : "handshake-failure");
      if (outcome != kIoSignalled) SetFault(inv, kStagePayloadWrite, win_error);
      RunCleanup(inv);
      SetEvent(inv->done_event);
      return;
    }
    std::lock_guard<std::mutex> lock(inv->mu);
    inv->rec.state = "payload-sent";
    PushEvent(inv, "payload-sent", 0, 0);
  }

  // --- LAUNCHED / LAUNCHERR ------------------------------------------------
  if (!ExpectLine(inv, &reader, handshake_deadline, kStageLaunch, &line)) {
    RunCleanup(inv);
    SetEvent(inv->done_event);
    return;
  }
  {
    unsigned root_pid = 0, at_ms = 0, win_error = 0, errno_tag = 0, stage = 0;
    int consumed = 0;
    if (sscanf_s(line.c_str(), "AIGJOB1 LAUNCHED %u %u%n", &root_pid, &at_ms, &consumed) == 2 &&
        consumed == static_cast<int>(line.size())) {
      std::lock_guard<std::mutex> lock(inv->mu);
      inv->rec.launched = true;
      inv->rec.root_pid = root_pid;
      inv->rec.launched_at_ms = static_cast<uint32_t>(NowMs() - inv->t0);
      inv->rec.state = "running";
      PushEvent(inv, "launched", root_pid, at_ms);
    } else if (sscanf_s(line.c_str(), "AIGJOB1 LAUNCHERR %u %u %u%n", &win_error, &errno_tag,
                        &at_ms, &consumed) == 3 &&
               consumed == static_cast<int>(line.size())) {
      {
        std::lock_guard<std::mutex> lock(inv->mu);
        inv->rec.has_launch_error = true;
        inv->rec.launch_win_error = win_error;
        inv->rec.launch_errno_tag = errno_tag;
        PushEvent(inv, "launch-error", win_error, errno_tag);
      }
      SetStop(inv, "launch-error");
      RunCleanup(inv);
      SetEvent(inv->done_event);
      return;
    } else if (sscanf_s(line.c_str(), "AIGJOB1 FAULT %u %u %u%n", &stage, &win_error, &at_ms,
                        &consumed) == 3 &&
               consumed == static_cast<int>(line.size())) {
      SetStop(inv, "broker-fault");
      SetFault(inv, stage, win_error);
      RunCleanup(inv);
      SetEvent(inv->done_event);
      return;
    } else {
      SetStop(inv, "handshake-failure");
      SetFault(inv, kStageProtocol, ERROR_INVALID_DATA);
      RunCleanup(inv);
      SetEvent(inv->done_event);
      return;
    }
  }

  // --- execution -----------------------------------------------------------
  // The execution budget starts at the observed launch, so bootstrap latency is
  // charged to the separate handshake budget and the caller's configured
  // execution timeout keeps its full, unreduced meaning.
  uint64_t exec_started = NowMs();
  uint64_t exec_deadline = exec_started + inv->execution_ms;
  if (!ExpectLine(inv, &reader, exec_deadline, kStageExecution, &line)) {
    {
      std::lock_guard<std::mutex> lock(inv->mu);
      inv->rec.execution_elapsed_ms = static_cast<uint32_t>(NowMs() - exec_started);
      inv->rec.cancel_reason = inv->cancel_reason.load();
    }
    RunCleanup(inv);
    SetEvent(inv->done_event);
    return;
  }
  {
    unsigned code = 0, at_ms = 0, so = 0, se = 0, drained = 0, stage = 0, win_error = 0;
    int consumed = 0;
    if (sscanf_s(line.c_str(), "AIGJOB1 EXIT %u %u %u %u %u%n", &code, &at_ms, &so, &se, &drained,
                 &consumed) == 5 &&
        consumed == static_cast<int>(line.size())) {
      std::lock_guard<std::mutex> lock(inv->mu);
      inv->rec.has_root_exit = true;
      inv->rec.root_exit_code = code;
      inv->rec.root_exit_at_ms = static_cast<uint32_t>(NowMs() - inv->t0);
      inv->rec.root_stdout_bytes = so;
      inv->rec.root_stderr_bytes = se;
      inv->rec.root_drain_complete = drained != 0;
      inv->rec.execution_elapsed_ms = static_cast<uint32_t>(NowMs() - exec_started);
      if (inv->rec.stop_reason.empty()) inv->rec.stop_reason = "root-exit";
      PushEvent(inv, "root-exit", code, at_ms);
    } else if (sscanf_s(line.c_str(), "AIGJOB1 FAULT %u %u %u%n", &stage, &win_error, &at_ms,
                        &consumed) == 3 &&
               consumed == static_cast<int>(line.size())) {
      {
        std::lock_guard<std::mutex> lock(inv->mu);
        inv->rec.execution_elapsed_ms = static_cast<uint32_t>(NowMs() - exec_started);
      }
      SetStop(inv, "broker-fault");
      SetFault(inv, stage, win_error);
    } else {
      {
        std::lock_guard<std::mutex> lock(inv->mu);
        inv->rec.execution_elapsed_ms = static_cast<uint32_t>(NowMs() - exec_started);
      }
      SetStop(inv, "broker-fault");
      SetFault(inv, kStageProtocol, ERROR_INVALID_DATA);
    }
  }

  RunCleanup(inv);
  SetEvent(inv->done_event);
}

// ---------------------------------------------------------------------------
// Node-API helpers
// ---------------------------------------------------------------------------

napi_value ThrowCoded(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}

bool GetUint32Prop(napi_env env, napi_value obj, const char* key, uint32_t fallback,
                   uint32_t max_value, uint32_t* out) {
  napi_value value;
  if (napi_get_named_property(env, obj, key, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  if (type == napi_undefined || type == napi_null) {
    *out = fallback;
    return true;
  }
  if (type != napi_number) return false;
  double raw = 0;
  if (napi_get_value_double(env, value, &raw) != napi_ok) return false;
  if (!(raw >= 0) || raw > static_cast<double>(max_value)) return false;
  *out = static_cast<uint32_t>(raw);
  return true;
}

bool GetStringProp(napi_env env, napi_value obj, const char* key, size_t max_len,
                   std::string* out) {
  napi_value value;
  if (napi_get_named_property(env, obj, key, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &len) != napi_ok) return false;
  if (len > max_len) return false;
  out->assign(len, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, &(*out)[0], len + 1, &written) != napi_ok) return false;
  out->resize(written);
  return true;
}

bool GetArgString(napi_env env, napi_value value, size_t max_len, std::string* out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &len) != napi_ok) return false;
  if (len > max_len) return false;
  out->assign(len, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, &(*out)[0], len + 1, &written) != napi_ok) return false;
  out->resize(written);
  return true;
}

void SetU32(napi_env env, napi_value obj, const char* key, uint32_t value) {
  napi_value v;
  if (napi_create_uint32(env, value, &v) == napi_ok) napi_set_named_property(env, obj, key, v);
}

void SetF64(napi_env env, napi_value obj, const char* key, double value) {
  napi_value v;
  if (napi_create_double(env, value, &v) == napi_ok) napi_set_named_property(env, obj, key, v);
}

void SetBool(napi_env env, napi_value obj, const char* key, bool value) {
  napi_value v;
  if (napi_get_boolean(env, value, &v) == napi_ok) napi_set_named_property(env, obj, key, v);
}

void SetStr(napi_env env, napi_value obj, const char* key, const std::string& value) {
  napi_value v;
  if (napi_create_string_utf8(env, value.c_str(), value.size(), &v) == napi_ok) {
    napi_set_named_property(env, obj, key, v);
  }
}

// base64 of UTF-8 JSON is the only shape the payload line may take; anything else
// is rejected before it can reach the wire.
bool IsBase64(const std::string& s) {
  if (s.empty() || s.size() > kPayloadLineMax - 32) return false;
  for (size_t i = 0; i < s.size(); i++) {
    char c = s[i];
    bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
              c == '+' || c == '/' || c == '=';
    if (!ok) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Caller-side exports
// ---------------------------------------------------------------------------

void DisposeInvocation(Invocation* inv) {
  if (inv->disposed.exchange(true)) return;
  if (inv->cancel_event != NULL) SetEvent(inv->cancel_event);
  if (inv->worker.joinable()) inv->worker.join();
  // Closing the last job handle is what KILL_ON_JOB_CLOSE acts on; it stays open
  // until here so that cleanup accounting could be observed first.
  if (inv->job != NULL) CloseHandle(inv->job);
  if (inv->pipe != INVALID_HANDLE_VALUE) {
    DisconnectNamedPipe(inv->pipe);
    CloseHandle(inv->pipe);
  }
  if (inv->broker_process != NULL) CloseHandle(inv->broker_process);
  if (inv->cancel_event != NULL) CloseHandle(inv->cancel_event);
  if (inv->done_event != NULL) CloseHandle(inv->done_event);
  inv->job = NULL;
  inv->pipe = INVALID_HANDLE_VALUE;
  inv->broker_process = NULL;
  inv->cancel_event = NULL;
  inv->done_event = NULL;
}

void FinalizeInvocation(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
  Invocation* inv = static_cast<Invocation*>(data);
  DisposeInvocation(inv);
  delete inv;
}

bool UnwrapInvocation(napi_env env, napi_value value, Invocation** out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_external) return false;
  void* data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok || data == nullptr) return false;
  *out = static_cast<Invocation*>(data);
  return true;
}

napi_value SelfIdentity(napi_env env, napi_callback_info info) {
  (void)info;
  uint64_t creation = 0;
  if (!ProcessCreation(GetCurrentProcess(), &creation)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_IDENTITY", "GetProcessTimes failed for the caller");
  }
  char buf[32];
  _snprintf_s(buf, sizeof(buf), _TRUNCATE, "%llu", static_cast<unsigned long long>(creation));

  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) return nullptr;
  SetU32(env, result, "pid", static_cast<uint32_t>(GetCurrentProcessId()));
  SetStr(env, result, "creationTime", std::string(buf));
  return result;
}

napi_value CreateInvocation(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "createInvocation(options) requires options");
  }
  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "options must be an object");
  }

  uint32_t handshake_ms = 0, execution_ms = 0, cleanup_ms = 0, handoff_hold_ms = 0, fault_mode = 0;
  std::string payload;
  if (!GetUint32Prop(env, argv[0], "handshakeTimeoutMs", 2000, 600000, &handshake_ms) ||
      !GetUint32Prop(env, argv[0], "executionTimeoutMs", 5000, 3600000, &execution_ms) ||
      !GetUint32Prop(env, argv[0], "cleanupBudgetMs", 500, 600000, &cleanup_ms) ||
      !GetUint32Prop(env, argv[0], "handoffHoldMs", 0, 5000, &handoff_hold_ms) ||
      !GetUint32Prop(env, argv[0], "brokerFaultMode", 0, 2, &fault_mode) ||
      !GetStringProp(env, argv[0], "payloadFrame", kPayloadLineMax, &payload)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "invalid createInvocation options");
  }
  if (handshake_ms == 0 || execution_ms == 0) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "handshake and execution budgets must be > 0");
  }
  if (!IsBase64(payload)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "payloadFrame must be non-empty base64");
  }

  Invocation* inv = new Invocation();
  inv->handshake_ms = handshake_ms;
  inv->execution_ms = execution_ms;
  inv->cleanup_ms = cleanup_ms;
  inv->handoff_hold_ms = handoff_hold_ms;
  inv->fault_mode = fault_mode;

  // Per-invocation unnamed job. Unnamed keeps it unreachable by name; the only
  // ways in are this handle and a duplicate the broker must authenticate for.
  inv->job = CreateJobObjectW(NULL, NULL);
  if (inv->job == NULL) {
    DWORD err = GetLastError();
    delete inv;
    char msg[128];
    _snprintf_s(msg, sizeof(msg), _TRUNCATE, "CreateJobObjectW failed (GetLastError=%lu)", err);
    return ThrowCoded(env, "ERR_OWNED_JOB_CREATE", msg);
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  // KILL_ON_JOB_CLOSE only. Neither JOB_OBJECT_LIMIT_BREAKAWAY_OK nor
  // JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK is ever set: members must not escape.
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(inv->job, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    DWORD err = GetLastError();
    CloseHandle(inv->job);
    delete inv;
    char msg[160];
    _snprintf_s(msg, sizeof(msg), _TRUNCATE,
                "SetInformationJobObject(KILL_ON_JOB_CLOSE) failed (GetLastError=%lu)", err);
    return ThrowCoded(env, "ERR_OWNED_JOB_LIMITS", msg);
  }
  inv->rec.job_flags_requested = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION readback;
  ZeroMemory(&readback, sizeof(readback));
  DWORD returned = 0;
  if (QueryInformationJobObject(inv->job, JobObjectExtendedLimitInformation, &readback,
                                sizeof(readback), &returned) &&
      returned == sizeof(readback)) {
    inv->rec.job_flags_effective = readback.BasicLimitInformation.LimitFlags;
    inv->rec.job_flags_effective_known = true;
  }

  unsigned char nonce[16];
  if (BCryptGenRandom(NULL, nonce, sizeof(nonce), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    CloseHandle(inv->job);
    delete inv;
    return ThrowCoded(env, "ERR_OWNED_JOB_RANDOM", "BCryptGenRandom failed");
  }
  wchar_t name[96];
  _snwprintf_s(name, _countof(name), _TRUNCATE,
               L"\\\\.\\pipe\\aigentry-owned-job-%02x%02x%02x%02x%02x%02x%02x%02x"
               L"%02x%02x%02x%02x%02x%02x%02x%02x",
               nonce[0], nonce[1], nonce[2], nonce[3], nonce[4], nonce[5], nonce[6], nonce[7],
               nonce[8], nonce[9], nonce[10], nonce[11], nonce[12], nonce[13], nonce[14],
               nonce[15]);
  inv->pipe_name.assign(name);

  // One instance only, first-instance-only, local clients only: the random name
  // is the handshake secret and squatting it must fail rather than race.
  inv->pipe = CreateNamedPipeW(
      name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 64 * 1024,
      64 * 1024, 0, NULL);
  if (inv->pipe == INVALID_HANDLE_VALUE) {
    DWORD err = GetLastError();
    CloseHandle(inv->job);
    delete inv;
    char msg[128];
    _snprintf_s(msg, sizeof(msg), _TRUNCATE, "CreateNamedPipeW failed (GetLastError=%lu)", err);
    return ThrowCoded(env, "ERR_OWNED_JOB_CONTROL", msg);
  }

  inv->cancel_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  inv->done_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (inv->cancel_event == NULL || inv->done_event == NULL) {
    DWORD err = GetLastError();
    if (inv->cancel_event != NULL) CloseHandle(inv->cancel_event);
    if (inv->done_event != NULL) CloseHandle(inv->done_event);
    CloseHandle(inv->pipe);
    CloseHandle(inv->job);
    delete inv;
    char msg[128];
    _snprintf_s(msg, sizeof(msg), _TRUNCATE, "CreateEventW failed (GetLastError=%lu)", err);
    return ThrowCoded(env, "ERR_OWNED_JOB_CONTROL", msg);
  }

  uint64_t creation = 0;
  if (!ProcessCreation(GetCurrentProcess(), &creation)) {
    DisposeInvocation(inv);
    delete inv;
    return ThrowCoded(env, "ERR_OWNED_JOB_IDENTITY", "GetProcessTimes failed for the caller");
  }
  char ident[256];
  _snprintf_s(ident, sizeof(ident), _TRUNCATE, "AIGJOB1 IDENT %lu %llu %llu %lu %lu %lu\n",
              GetCurrentProcessId(), static_cast<unsigned long long>(creation),
              static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(inv->job)),
              static_cast<unsigned long>(inv->handshake_ms),
              static_cast<unsigned long>(inv->handoff_hold_ms),
              static_cast<unsigned long>(inv->fault_mode));
  inv->ident_line.assign(ident);
  inv->payload_line = "AIGJOB1 PAYLOAD " + payload + "\n";

  napi_value external;
  if (napi_create_external(env, inv, FinalizeInvocation, nullptr, &external) != napi_ok) {
    DisposeInvocation(inv);
    delete inv;
    return ThrowCoded(env, "ERR_OWNED_JOB_INTERNAL", "napi_create_external failed");
  }

  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) return nullptr;
  napi_set_named_property(env, result, "invocation", external);
  {
    napi_value pipe_value;
    if (napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(inv->pipe_name.c_str()),
                                 inv->pipe_name.size(), &pipe_value) != napi_ok) {
      return nullptr;
    }
    napi_set_named_property(env, result, "pipeName", pipe_value);
  }
  SetU32(env, result, "jobFlagsRequested", inv->rec.job_flags_requested);
  SetU32(env, result, "jobFlagsEffective", inv->rec.job_flags_effective);
  SetBool(env, result, "jobFlagsEffectiveKnown", inv->rec.job_flags_effective_known);
  return result;
}

napi_value Arm(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  Invocation* inv = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1 ||
      !UnwrapInvocation(env, argv[0], &inv)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "arm(invocation) requires an invocation");
  }
  if (inv->disposed.load()) {
    return ThrowCoded(env, "ERR_OWNED_JOB_STATE", "invocation already disposed");
  }
  if (inv->armed.exchange(true)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_STATE", "invocation already armed");
  }
  inv->t0 = NowMs();
  inv->worker = std::thread(ControlThread, inv);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value Cancel(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  Invocation* inv = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1 ||
      !UnwrapInvocation(env, argv[0], &inv)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "cancel(invocation, reason) requires an invocation");
  }
  uint32_t reason = kCancelAbort;
  if (argc >= 2) {
    napi_valuetype type;
    if (napi_typeof(env, argv[1], &type) == napi_ok && type == napi_number) {
      double raw = 0;
      if (napi_get_value_double(env, argv[1], &raw) == napi_ok && raw >= 1 && raw <= 2) {
        reason = static_cast<uint32_t>(raw);
      }
    }
  }
  uint32_t expected = 0;
  inv->cancel_reason.compare_exchange_strong(expected, reason);
  if (inv->cancel_event != NULL) SetEvent(inv->cancel_event);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value BuildRecord(napi_env env, Invocation* inv) {
  std::lock_guard<std::mutex> lock(inv->mu);
  const Record& r = inv->rec;

  napi_value out;
  if (napi_create_object(env, &out) != napi_ok) return nullptr;
  SetStr(env, out, "state", r.state);
  SetStr(env, out, "stopReason", r.stop_reason);
  SetU32(env, out, "faultStage", r.fault_stage);
  SetU32(env, out, "faultWinError", r.fault_win_error);
  SetU32(env, out, "protocolFaults", r.protocol_faults);

  SetBool(env, out, "barrier", r.barrier);
  SetU32(env, out, "barrierAtMs", r.barrier_at_ms);
  SetU32(env, out, "barrierActiveProcesses", r.barrier_active_processes);

  SetBool(env, out, "launched", r.launched);
  SetU32(env, out, "rootPid", r.root_pid);
  SetU32(env, out, "launchedAtMs", r.launched_at_ms);

  SetBool(env, out, "hasRootExit", r.has_root_exit);
  SetU32(env, out, "rootExitCode", r.root_exit_code);
  SetU32(env, out, "rootExitAtMs", r.root_exit_at_ms);
  SetU32(env, out, "rootStdoutBytes", r.root_stdout_bytes);
  SetU32(env, out, "rootStderrBytes", r.root_stderr_bytes);
  SetBool(env, out, "rootDrainComplete", r.root_drain_complete);

  SetBool(env, out, "hasLaunchError", r.has_launch_error);
  SetU32(env, out, "launchWinError", r.launch_win_error);
  SetU32(env, out, "launchErrnoTag", r.launch_errno_tag);

  SetU32(env, out, "brokerPid", r.broker_pid);
  SetF64(env, out, "brokerCreationTime", static_cast<double>(r.broker_creation));
  SetBool(env, out, "brokerExitObserved", r.broker_exit_observed);
  SetU32(env, out, "brokerExitCode", r.broker_exit_code);

  SetU32(env, out, "jobFlagsRequested", r.job_flags_requested);
  SetU32(env, out, "jobFlagsEffective", r.job_flags_effective);
  SetBool(env, out, "jobFlagsEffectiveKnown", r.job_flags_effective_known);

  SetBool(env, out, "terminateCalled", r.terminate_called);
  SetBool(env, out, "terminateOk", r.terminate_ok);
  SetU32(env, out, "terminateWinError", r.terminate_win_error);

  SetStr(env, out, "cleanupState", r.cleanup_state);
  SetStr(env, out, "cleanupReason", r.cleanup_reason);
  SetU32(env, out, "cleanupElapsedMs", r.cleanup_elapsed_ms);
  SetU32(env, out, "activeProcessesFinal", r.active_processes_final);
  SetBool(env, out, "activeProcessesKnown", r.active_processes_known);
  SetU32(env, out, "totalTerminatedProcesses", r.total_terminated_processes);

  SetU32(env, out, "handshakeElapsedMs", r.handshake_elapsed_ms);
  SetU32(env, out, "executionElapsedMs", r.execution_elapsed_ms);
  SetU32(env, out, "cancelReason", r.cancel_reason ? r.cancel_reason : inv->cancel_reason.load());
  SetU32(env, out, "handoffHoldMs", inv->handoff_hold_ms);
  SetU32(env, out, "brokerFaultMode", inv->fault_mode);

  napi_value events;
  if (napi_create_array_with_length(env, r.events.size(), &events) == napi_ok) {
    for (size_t i = 0; i < r.events.size(); i++) {
      napi_value item;
      if (napi_create_object(env, &item) != napi_ok) break;
      SetStr(env, item, "tag", std::string(r.events[i].tag));
      SetU32(env, item, "atMs", r.events[i].at_ms);
      SetU32(env, item, "a", r.events[i].a);
      SetU32(env, item, "b", r.events[i].b);
      napi_set_element(env, events, static_cast<uint32_t>(i), item);
    }
    napi_set_named_property(env, out, "events", events);
  }
  return out;
}

napi_value Snapshot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  Invocation* inv = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1 ||
      !UnwrapInvocation(env, argv[0], &inv)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "snapshot(invocation) requires an invocation");
  }
  return BuildRecord(env, inv);
}

napi_value Finish(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  Invocation* inv = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1 ||
      !UnwrapInvocation(env, argv[0], &inv)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "finish(invocation, waitMs) requires an invocation");
  }
  uint32_t wait_ms = 2000;
  if (argc >= 2) {
    napi_valuetype type;
    if (napi_typeof(env, argv[1], &type) == napi_ok && type == napi_number) {
      double raw = 0;
      if (napi_get_value_double(env, argv[1], &raw) == napi_ok && raw >= 0 && raw <= 600000) {
        wait_ms = static_cast<uint32_t>(raw);
      }
    }
  }
  // Bounded: the control thread's own cleanup budget is what this waits on. A
  // WAIT_TIMEOUT here leaves cleanupState at whatever was last observed, which is
  // "unknown" unless the thread already proved emptiness.
  bool settled = false;
  if (inv->done_event != NULL) {
    settled = WaitForSingleObject(inv->done_event, wait_ms) == WAIT_OBJECT_0;
  }
  napi_value record = BuildRecord(env, inv);
  if (record != nullptr) SetBool(env, record, "settled", settled);
  return record;
}

napi_value Dispose(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  Invocation* inv = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1 ||
      !UnwrapInvocation(env, argv[0], &inv)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "dispose(invocation) requires an invocation");
  }
  DisposeInvocation(inv);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

// ---------------------------------------------------------------------------
// Broker-side exports
// ---------------------------------------------------------------------------

// Broker FAULT stage codes, sent verbatim to the caller.
const uint32_t kBrokerStageConnect = 1;
const uint32_t kBrokerStageHello = 2;
const uint32_t kBrokerStageIdentRead = 3;
const uint32_t kBrokerStageIdentity = 4;
const uint32_t kBrokerStageDuplicate = 5;
const uint32_t kBrokerStageHandoffAborted = 6;
const uint32_t kBrokerStageAssign = 7;
const uint32_t kBrokerStageMembership = 8;
const uint32_t kBrokerStagePayloadRead = 9;

struct Control {
  HANDLE pipe = INVALID_HANDLE_VALUE;
  LineReader reader;
  std::atomic<bool> closed{false};
};

void FinalizeControl(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
  Control* control = static_cast<Control*>(data);
  if (!control->closed.exchange(true) && control->pipe != INVALID_HANDLE_VALUE) {
    CloseHandle(control->pipe);
  }
  delete control;
}

bool UnwrapControl(napi_env env, napi_value value, Control** out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_external) return false;
  void* data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok || data == nullptr) return false;
  *out = static_cast<Control*>(data);
  return true;
}

// Guards the temporary duplicated job handle. Exactly one of the acquiring thread
// or the watchdog releases it; a caller that dies inside this window makes the
// watchdog close the duplicate, which drops the job's last handle and lets
// KILL_ON_JOB_CLOSE run instead of stranding a holder.
struct HandoffGuard {
  std::mutex mu;
  HANDLE temp_job = NULL;
  bool released = false;
  bool aborted = false;
  uint32_t abort_reason = 0;
};

void HandoffWatchdog(HandoffGuard* guard, HANDLE parent, HANDLE done, DWORD timeout_ms) {
  HANDLE waits[2] = {done, parent};
  DWORD count = parent != NULL ? 2 : 1;
  DWORD wait = WaitForMultipleObjects(count, waits, FALSE, timeout_ms);
  if (wait == WAIT_OBJECT_0) return;  // released normally

  std::lock_guard<std::mutex> lock(guard->mu);
  if (guard->released) return;
  if (guard->temp_job != NULL) CloseHandle(guard->temp_job);
  guard->temp_job = NULL;
  guard->released = true;
  guard->aborted = true;
  guard->abort_reason = wait == WAIT_TIMEOUT ? 1 : (wait == WAIT_OBJECT_0 + 1 ? 2 : 3);
}

// Writes a best-effort FAULT line and returns a thrown JS error. The caller-side
// control thread treats a refusal as fail-closed; if even the write fails, the
// caller's handshake deadline covers it.
napi_value BrokerFault(napi_env env, HANDLE pipe, uint64_t t0, uint32_t stage, DWORD win_error,
                       const char* code, const char* message) {
  if (pipe != INVALID_HANDLE_VALUE) {
    char line[128];
    _snprintf_s(line, sizeof(line), _TRUNCATE, "AIGJOB1 FAULT %lu %lu %lu\n",
                static_cast<unsigned long>(stage), static_cast<unsigned long>(win_error),
                static_cast<unsigned long>(NowMs() - t0));
    DWORD ignored = 0;
    WriteAll(pipe, NULL, NowMs() + 1000, std::string(line), &ignored);
  }
  char detail[256];
  _snprintf_s(detail, sizeof(detail), _TRUNCATE, "%s (stage=%lu, GetLastError=%lu)", message,
              static_cast<unsigned long>(stage), static_cast<unsigned long>(win_error));
  return ThrowCoded(env, code, detail);
}

napi_value AcquireOwnership(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS",
                      "acquireOwnership(pipeName, timeoutMs) requires a pipe name");
  }
  std::string pipe_name_utf8;
  if (!GetArgString(env, argv[0], 128, &pipe_name_utf8)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "pipeName must be a short string");
  }
  // The pipe name is untrusted input as far as this process is concerned: accept
  // only the exact shape this prototype mints, never an arbitrary path.
  const std::string prefix = "\\\\.\\pipe\\aigentry-owned-job-";
  if (pipe_name_utf8.size() != prefix.size() + 32 ||
      pipe_name_utf8.compare(0, prefix.size(), prefix) != 0) {
    return ThrowCoded(env, "ERR_OWNED_JOB_CONTROL", "pipeName is not an owned-job control pipe");
  }
  for (size_t i = prefix.size(); i < pipe_name_utf8.size(); i++) {
    char c = pipe_name_utf8[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      return ThrowCoded(env, "ERR_OWNED_JOB_CONTROL", "pipeName suffix is not lowercase hex");
    }
  }
  uint32_t timeout_ms = 2000;
  if (argc >= 2) {
    napi_valuetype type;
    if (napi_typeof(env, argv[1], &type) == napi_ok && type == napi_number) {
      double raw = 0;
      if (napi_get_value_double(env, argv[1], &raw) == napi_ok && raw >= 1 && raw <= 600000) {
        timeout_ms = static_cast<uint32_t>(raw);
      }
    }
  }

  std::wstring wide(pipe_name_utf8.begin(), pipe_name_utf8.end());  // ASCII-only by validation
  uint64_t t0 = NowMs();
  uint64_t deadline = t0 + timeout_ms;

  // --- connect -------------------------------------------------------------
  HANDLE pipe = INVALID_HANDLE_VALUE;
  DWORD connect_error = 0;
  for (;;) {
    pipe = CreateFileW(wide.c_str(), GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                       FILE_FLAG_OVERLAPPED, NULL);
    if (pipe != INVALID_HANDLE_VALUE) break;
    connect_error = GetLastError();
    if (RemainingMs(deadline) == 0) {
      return BrokerFault(env, INVALID_HANDLE_VALUE, t0, kBrokerStageConnect, connect_error,
                         "ERR_OWNED_JOB_CONTROL", "control pipe connect timed out");
    }
    if (connect_error == ERROR_PIPE_BUSY) {
      WaitNamedPipeW(wide.c_str(), 50);
    } else if (connect_error == ERROR_FILE_NOT_FOUND) {
      Sleep(5);
    } else {
      return BrokerFault(env, INVALID_HANDLE_VALUE, t0, kBrokerStageConnect, connect_error,
                         "ERR_OWNED_JOB_CONTROL", "control pipe connect failed");
    }
  }

  Control* control = new Control();
  control->pipe = pipe;

  // The pipe server process is the only identity this broker will accept as the
  // duplication source. PID comes from the pipe object, not from the wire.
  ULONG server_pid = 0;
  if (!GetNamedPipeServerProcessId(pipe, &server_pid) || server_pid == 0) {
    DWORD err = GetLastError();
    FinalizeControl(env, control, nullptr);
    return BrokerFault(env, INVALID_HANDLE_VALUE, t0, kBrokerStageIdentity, err,
                       "ERR_OWNED_JOB_IDENTITY", "GetNamedPipeServerProcessId failed");
  }

  // --- HELLO ---------------------------------------------------------------
  {
    char hello[64];
    _snprintf_s(hello, sizeof(hello), _TRUNCATE, "AIGJOB1 HELLO %lu\n", GetCurrentProcessId());
    DWORD win_error = 0;
    if (WriteAll(pipe, NULL, deadline, std::string(hello), &win_error) != kIoOk) {
      FinalizeControl(env, control, nullptr);
      return BrokerFault(env, INVALID_HANDLE_VALUE, t0, kBrokerStageHello, win_error,
                         "ERR_OWNED_JOB_CONTROL", "HELLO write failed");
    }
  }

  // --- IDENT ---------------------------------------------------------------
  std::string line;
  {
    DWORD win_error = 0;
    if (control->reader.ReadLine(pipe, NULL, deadline, kControlLineMax, &line, &win_error) !=
        kIoOk) {
      FinalizeControl(env, control, nullptr);
      return BrokerFault(env, INVALID_HANDLE_VALUE, t0, kBrokerStageIdentRead, win_error,
                         "ERR_OWNED_JOB_CONTROL", "IDENT read failed or timed out");
    }
  }
  unsigned long parent_pid = 0, handshake_ms = 0, handoff_hold_ms = 0, fault_mode = 0;
  unsigned long long parent_creation = 0, job_handle_value = 0;
  {
    int consumed = 0;
    if (sscanf_s(line.c_str(), "AIGJOB1 IDENT %lu %llu %llu %lu %lu %lu%n", &parent_pid,
                 &parent_creation, &job_handle_value, &handshake_ms, &handoff_hold_ms, &fault_mode,
                 &consumed) != 6 ||
        consumed != static_cast<int>(line.size()) || job_handle_value == 0 || parent_pid == 0 ||
        handoff_hold_ms > 5000 || fault_mode > 2) {
      HANDLE raw = control->pipe;
      napi_value thrown = BrokerFault(env, raw, t0, kBrokerStageIdentRead, ERROR_INVALID_DATA,
                                      "ERR_OWNED_JOB_PROTOCOL", "IDENT frame is malformed");
      FinalizeControl(env, control, nullptr);
      return thrown;
    }
  }
  if (parent_pid != static_cast<unsigned long>(server_pid)) {
    napi_value thrown = BrokerFault(env, pipe, t0, kBrokerStageIdentity, ERROR_ACCESS_DENIED,
                                    "ERR_OWNED_JOB_IDENTITY",
                                    "IDENT pid does not match the control pipe server pid");
    FinalizeControl(env, control, nullptr);
    return thrown;
  }

  HANDLE parent = OpenProcess(
      PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, server_pid);
  if (parent == NULL) {
    DWORD err = GetLastError();
    napi_value thrown = BrokerFault(env, pipe, t0, kBrokerStageIdentity, err,
                                    "ERR_OWNED_JOB_IDENTITY", "OpenProcess on the caller failed");
    FinalizeControl(env, control, nullptr);
    return thrown;
  }
  uint64_t actual_creation = 0;
  if (!ProcessCreation(parent, &actual_creation) ||
      actual_creation != static_cast<uint64_t>(parent_creation)) {
    DWORD err = GetLastError();
    CloseHandle(parent);
    napi_value thrown =
        BrokerFault(env, pipe, t0, kBrokerStageIdentity, err, "ERR_OWNED_JOB_IDENTITY",
                    "caller creation time does not match the IDENT frame");
    FinalizeControl(env, control, nullptr);
    return thrown;
  }

  // Test-only, and only reachable over this authenticated channel: exit before the
  // barrier so an inert fixture can exercise a bootstrap that never owns anything.
  if (fault_mode == 1) {
    CloseHandle(parent);
    FinalizeControl(env, control, nullptr);
    return ThrowCoded(env, "ERR_OWNED_JOB_TEST_FAULT", "brokerFaultMode=1: exit before barrier");
  }

  // --- duplicate, self-assign, close: the execution barrier ----------------
  HandoffGuard guard;
  if (!DuplicateHandle(parent, reinterpret_cast<HANDLE>(static_cast<uintptr_t>(job_handle_value)),
                       GetCurrentProcess(), &guard.temp_job, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    DWORD err = GetLastError();
    CloseHandle(parent);
    napi_value thrown = BrokerFault(env, pipe, t0, kBrokerStageDuplicate, err,
                                    "ERR_OWNED_JOB_DUPLICATE", "DuplicateHandle of the job failed");
    FinalizeControl(env, control, nullptr);
    return thrown;
  }

  HANDLE handoff_done = CreateEventW(NULL, TRUE, FALSE, NULL);
  DWORD handoff_budget = RemainingMs(deadline) + handoff_hold_ms + 1000;
  std::thread watchdog(HandoffWatchdog, &guard, parent, handoff_done, handoff_budget);

  // Deliberate stall inside the temporary-handle window. Test hook only; it can
  // never let a payload start early, it only widens the window a fixture races.
  if (handoff_hold_ms > 0) Sleep(handoff_hold_ms);

  DWORD assign_error = 0;
  DWORD active_at_barrier = 0;
  uint32_t refuse_stage = 0;
  {
    std::lock_guard<std::mutex> lock(guard.mu);
    if (guard.released) {
      refuse_stage = kBrokerStageHandoffAborted;
      assign_error = guard.abort_reason;
    } else if (!AssignProcessToJobObject(guard.temp_job, GetCurrentProcess())) {
      assign_error = GetLastError();
      refuse_stage = kBrokerStageAssign;
      CloseHandle(guard.temp_job);
      guard.temp_job = NULL;
      guard.released = true;
    } else {
      BOOL in_job = FALSE;
      if (!IsProcessInJob(GetCurrentProcess(), guard.temp_job, &in_job) || !in_job) {
        assign_error = GetLastError();
        refuse_stage = kBrokerStageMembership;
      } else {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION acct;
        ZeroMemory(&acct, sizeof(acct));
        DWORD returned = 0;
        if (QueryInformationJobObject(guard.temp_job, JobObjectBasicAccountingInformation, &acct,
                                      sizeof(acct), &returned) &&
            returned == sizeof(acct)) {
          active_at_barrier = static_cast<DWORD>(acct.ActiveProcesses);
        }
      }
      // BARRIER: the temporary duplicate is dropped here, before any payload
      // frame is read. From now on the caller holds the only job handle, so its
      // death closes the last one and KILL_ON_JOB_CLOSE reaps this process too.
      CloseHandle(guard.temp_job);
      guard.temp_job = NULL;
      guard.released = true;
    }
  }
  SetEvent(handoff_done);
  watchdog.join();
  CloseHandle(handoff_done);
  CloseHandle(parent);

  if (refuse_stage != 0) {
    napi_value thrown = BrokerFault(
        env, pipe, t0, refuse_stage, assign_error,
        refuse_stage == kBrokerStageHandoffAborted ? "ERR_OWNED_JOB_HANDOFF"
                                                   : "ERR_OWNED_JOB_ASSIGN",
        refuse_stage == kBrokerStageHandoffAborted
            ? "handoff aborted while holding the temporary job handle"
            : "AssignProcessToJobObject refused or membership could not be confirmed");
    FinalizeControl(env, control, nullptr);
    return thrown;
  }

  // --- OWNED, then (and only then) the payload frame -----------------------
  {
    char owned[96];
    _snprintf_s(owned, sizeof(owned), _TRUNCATE, "AIGJOB1 OWNED %lu %lu\n",
                static_cast<unsigned long>(active_at_barrier),
                static_cast<unsigned long>(NowMs() - t0));
    DWORD win_error = 0;
    if (WriteAll(pipe, NULL, NowMs() + handshake_ms, std::string(owned), &win_error) != kIoOk) {
      FinalizeControl(env, control, nullptr);
      return ThrowCoded(env, "ERR_OWNED_JOB_CONTROL", "OWNED write failed after the barrier");
    }
  }
  std::string payload_line;
  {
    DWORD win_error = 0;
    if (control->reader.ReadLine(pipe, NULL, NowMs() + handshake_ms, kPayloadLineMax, &payload_line,
                                 &win_error) != kIoOk) {
      napi_value thrown = BrokerFault(env, pipe, t0, kBrokerStagePayloadRead, win_error,
                                      "ERR_OWNED_JOB_CONTROL", "PAYLOAD read failed or timed out");
      FinalizeControl(env, control, nullptr);
      return thrown;
    }
  }
  const std::string payload_prefix = "AIGJOB1 PAYLOAD ";
  if (payload_line.size() <= payload_prefix.size() ||
      payload_line.compare(0, payload_prefix.size(), payload_prefix) != 0) {
    napi_value thrown = BrokerFault(env, pipe, t0, kBrokerStagePayloadRead, ERROR_INVALID_DATA,
                                    "ERR_OWNED_JOB_PROTOCOL", "PAYLOAD frame is malformed");
    FinalizeControl(env, control, nullptr);
    return thrown;
  }
  std::string payload_b64 = payload_line.substr(payload_prefix.size());
  if (!IsBase64(payload_b64)) {
    napi_value thrown = BrokerFault(env, pipe, t0, kBrokerStagePayloadRead, ERROR_INVALID_DATA,
                                    "ERR_OWNED_JOB_PROTOCOL", "PAYLOAD frame is not base64");
    FinalizeControl(env, control, nullptr);
    return thrown;
  }

  napi_value external;
  if (napi_create_external(env, control, FinalizeControl, nullptr, &external) != napi_ok) {
    FinalizeControl(env, control, nullptr);
    return ThrowCoded(env, "ERR_OWNED_JOB_INTERNAL", "napi_create_external failed");
  }

  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) return nullptr;
  napi_set_named_property(env, result, "control", external);
  SetU32(env, result, "parentPid", static_cast<uint32_t>(server_pid));
  SetF64(env, result, "parentCreationTime", static_cast<double>(actual_creation));
  SetU32(env, result, "activeProcessesAtBarrier", active_at_barrier);
  SetU32(env, result, "barrierAtMs", static_cast<uint32_t>(NowMs() - t0));
  SetU32(env, result, "handshakeTimeoutMs", static_cast<uint32_t>(handshake_ms));
  SetU32(env, result, "handoffHoldMs", static_cast<uint32_t>(handoff_hold_ms));
  SetU32(env, result, "brokerFaultMode", static_cast<uint32_t>(fault_mode));
  SetStr(env, result, "payloadFrame", payload_b64);
  SetBool(env, result, "assigned", true);
  return result;
}

napi_value ControlSend(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  Control* control = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 2 ||
      !UnwrapControl(env, argv[0], &control)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "controlSend(control, line, timeoutMs)");
  }
  if (control->closed.load()) {
    return ThrowCoded(env, "ERR_OWNED_JOB_STATE", "control channel is closed");
  }
  std::string line;
  if (!GetArgString(env, argv[1], kControlLineMax - 1, &line)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "line must be a string within the control cap");
  }
  // Only the exact ASCII line grammar may reach the wire.
  for (size_t i = 0; i < line.size(); i++) {
    char c = line[i];
    if (c < 0x20 || c > 0x7e) {
      return ThrowCoded(env, "ERR_OWNED_JOB_PROTOCOL", "control line has non-printable bytes");
    }
  }
  uint32_t timeout_ms = 1000;
  if (argc >= 3) {
    napi_valuetype type;
    if (napi_typeof(env, argv[2], &type) == napi_ok && type == napi_number) {
      double raw = 0;
      if (napi_get_value_double(env, argv[2], &raw) == napi_ok && raw >= 1 && raw <= 600000) {
        timeout_ms = static_cast<uint32_t>(raw);
      }
    }
  }
  DWORD win_error = 0;
  IoOutcome outcome = WriteAll(control->pipe, NULL, NowMs() + timeout_ms, line + "\n", &win_error);
  napi_value result;
  if (napi_get_boolean(env, outcome == kIoOk, &result) != napi_ok) return nullptr;
  return result;
}

napi_value ControlClose(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  Control* control = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1 ||
      !UnwrapControl(env, argv[0], &control)) {
    return ThrowCoded(env, "ERR_OWNED_JOB_ARGS", "controlClose(control) requires a control handle");
  }
  if (!control->closed.exchange(true) && control->pipe != INVALID_HANDLE_VALUE) {
    CloseHandle(control->pipe);
    control->pipe = INVALID_HANDLE_VALUE;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value Describe(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  if (napi_create_object(env, &out) != napi_ok) return nullptr;
  SetU32(env, out, "protocol", 1);
  SetU32(env, out, "napiVersion", NAPI_VERSION);
  SetU32(env, out, "controlLineMax", static_cast<uint32_t>(kControlLineMax));
  SetU32(env, out, "payloadLineMax", static_cast<uint32_t>(kPayloadLineMax));
  SetU32(env, out, "terminateExitCode", kTerminateExitCode);
  SetStr(env, out, "operation", "wn1167a-v1");
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor props[] = {
      {"selfIdentity", nullptr, SelfIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"createInvocation", nullptr, CreateInvocation, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"arm", nullptr, Arm, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cancel", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"snapshot", nullptr, Snapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"finish", nullptr, Finish, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"dispose", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"acquireOwnership", nullptr, AcquireOwnership, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"controlSend", nullptr, ControlSend, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"controlClose", nullptr, ControlClose, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"describe", nullptr, Describe, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props) != napi_ok) {
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
