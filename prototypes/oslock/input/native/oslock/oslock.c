/* oslock.c — #1166 primitive-only prototype: advisory whole-file OS lock handles.
 *
 * Node-API only (node_api.h, NAPI_VERSION 8), no third-party code. Every export is
 * synchronous, non-blocking and runs on the calling JS thread only: no wait call, no
 * libuv threadpool. Waiting/polling is the JS harness's job (proto/with-os-lock.mjs).
 *
 * Ownership (the only rules that free memory or descriptors):
 *   - A record's OS descriptor is closed by exactly one of: close(), the handle
 *     finalizer, or the env cleanup hook — whichever runs first sets state CLOSED and
 *     forgets the descriptor before/regardless of the close result, so it is never
 *     closed twice and never retried on a possibly reused number.
 *   - A record's MEMORY is freed only by its wrap finalizer (or by open() itself when
 *     the wrap never succeeded). Env teardown never frees records, so a finalizer that
 *     runs after the cleanup hook still points at live memory.
 *   - The per-env registry is refcounted: 1 for instance data, 1 for the cleanup hook,
 *     1 per linked record. Whichever of those releases last frees it, so neither the
 *     instance-data finalizer, the cleanup hook nor a late handle finalizer can touch
 *     freed registry memory, in any order.
 *   Residual: if Node never runs a handle finalizer (env torn down without finalizing),
 *   the small record struct leaks; its descriptor was already closed by the hook. */
#ifndef NAPI_VERSION
#define NAPI_VERSION 8
#endif
/* glibc hides flock/O_NOFOLLOW/O_CLOEXEC under strict -std=c11 without this. */
#if !defined(_WIN32) && !defined(_DEFAULT_SOURCE)
#define _DEFAULT_SOURCE
#endif

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#endif
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <node_api.h>

#define OSLOCK_ABI "oslock/1"
#define OSLOCK_EINTR_RETRIES 3
#define OSLOCK_RECORD_MAGIC 0x6f736c6bu
#ifdef _WIN32
#define OSLOCK_MAX_PATH_UNITS 32767
#else
#define OSLOCK_MAX_PATH_UNITS PATH_MAX
#endif

/* Per-module 128-bit tag: only objects created by open() carry it. */
static const napi_type_tag kHandleTag = {0x9d3c5a7e41b2f068ULL, 0x2e81c4d7a6f05b39ULL};

typedef enum { ST_OPEN = 1, ST_LOCKED = 2, ST_CLOSED = 3 } rec_state;

typedef struct registry registry;

typedef struct record {
  uint32_t magic;
  rec_state state;
  napi_env env; /* creating env: compared only, never dereferenced */
#ifdef _WIN32
  HANDLE h;
#else
  int fd;
#endif
  registry* reg; /* NULL once unlinked */
  struct record* prev;
  struct record* next;
} record;

struct registry {
  record* head;
  unsigned refs; /* instance data + cleanup hook + one per linked record */
};

/* ---------- registry / record ownership ---------- */

static void reg_unref(registry* reg) {
  if (--reg->refs == 0) free(reg);
}

static void rec_link(registry* reg, record* rec) {
  rec->reg = reg;
  rec->prev = NULL;
  rec->next = reg->head;
  if (reg->head) reg->head->prev = rec;
  reg->head = rec;
  reg->refs++;
}

static void rec_unlink(record* rec) {
  registry* reg = rec->reg;
  if (!reg) return;
  if (rec->prev) rec->prev->next = rec->next;
  else reg->head = rec->next;
  if (rec->next) rec->next->prev = rec->prev;
  rec->prev = rec->next = NULL;
  rec->reg = NULL;
  reg_unref(reg);
}

/* ---------- OS layer: returns 0 or an OS error number ---------- */

#ifdef _WIN32
typedef DWORD os_error;

static os_error os_unlock(record* rec) {
  OVERLAPPED ov;
  memset(&ov, 0, sizeof ov);
  return UnlockFileEx(rec->h, 0, 1, 0, &ov) ? 0 : GetLastError();
}

/* Exactly one CloseHandle; the handle is forgotten whatever the result. */
static os_error os_close(record* rec) {
  HANDLE h = rec->h;
  rec->h = INVALID_HANDLE_VALUE;
  return CloseHandle(h) ? 0 : GetLastError();
}
#define SYS_UNLOCK "UnlockFileEx"
#define SYS_CLOSE "CloseHandle"
#else
typedef int os_error;

static os_error os_unlock(record* rec) {
  int tries = 0;
  for (;;) {
    if (flock(rec->fd, LOCK_UN) == 0) return 0;
    if (errno != EINTR || tries++ >= OSLOCK_EINTR_RETRIES) return errno;
  }
}

/* Exactly one close(): never retried, since after EINTR/EIO the number may already
 * be released and reused. A failure is reported as uncertain cleanup. */
static os_error os_close(record* rec) {
  int fd = rec->fd;
  rec->fd = -1;
  return close(fd) == 0 ? 0 : errno;
}
#define SYS_UNLOCK "flock"
#define SYS_CLOSE "close"
#endif

/* Unlock if locked, then ALWAYS close once. Returns the first error; *close_failed
 * marks that the descriptor's release could not be confirmed. */
static os_error release_os(record* rec, const char** syscall, int* close_failed) {
  os_error err = 0, cerr;
  *close_failed = 0;
  *syscall = NULL;
  if (rec->state == ST_LOCKED) {
    err = os_unlock(rec);
    if (err) *syscall = SYS_UNLOCK;
  }
  cerr = os_close(rec);
  rec->state = ST_CLOSED;
  if (cerr) {
    *close_failed = 1;
    if (!err) {
      err = cerr;
      *syscall = SYS_CLOSE;
    }
  }
  return err;
}

/* ---------- errors ---------- */

static void os_error_code(os_error e, char* buf, size_t n) {
#ifdef _WIN32
  snprintf(buf, n, "WIN32_%lu", (unsigned long)e);
#else
  const char* s = NULL;
  switch (e) {
    case EACCES: s = "EACCES"; break;
    case EPERM: s = "EPERM"; break;
    case ENOENT: s = "ENOENT"; break;
    case EEXIST: s = "EEXIST"; break;
    case ELOOP: s = "ELOOP"; break;
    case EISDIR: s = "EISDIR"; break;
    case ENOTDIR: s = "ENOTDIR"; break;
    case ENAMETOOLONG: s = "ENAMETOOLONG"; break;
    case EINTR: s = "EINTR"; break;
    case EWOULDBLOCK: s = "EWOULDBLOCK"; break;
    case EBADF: s = "EBADF"; break;
    case EINVAL: s = "EINVAL"; break;
    case ENOLCK: s = "ENOLCK"; break;
    case EMFILE: s = "EMFILE"; break;
    case ENFILE: s = "ENFILE"; break;
    case EIO: s = "EIO"; break;
    case EROFS: s = "EROFS"; break;
    case ENOSPC: s = "ENOSPC"; break;
    case ENXIO: s = "ENXIO"; break;
    case EOPNOTSUPP: s = "EOPNOTSUPP"; break;
    case ETXTBSY: s = "ETXTBSY"; break;
    case EDQUOT: s = "EDQUOT"; break;
    case ENOMEM: s = "ENOMEM"; break;
    case EOVERFLOW: s = "EOVERFLOW"; break;
    default: break;
  }
  if (s) snprintf(buf, n, "%s", s);
  else snprintf(buf, n, "ERRNO_%d", e);
#endif
}

static void set_str_prop(napi_env env, napi_value obj, const char* key, const char* val) {
  napi_value v;
  if (napi_create_string_utf8(env, val, NAPI_AUTO_LENGTH, &v) == napi_ok)
    napi_set_named_property(env, obj, key, v);
}

/* Throws Error/TypeError with .code, optional .syscall, optional .cleanupUncertain.
 * Never overwrites an exception that is already pending. */
static void throw_coded(napi_env env, int type_error, const char* code, const char* syscall,
                        const char* msg, int uncertain) {
  bool pending = false;
  napi_value code_v, msg_v, err;
  napi_status s;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) return;
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_v) != napi_ok ||
      napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &msg_v) != napi_ok) {
    napi_throw_error(env, code, msg);
    return;
  }
  s = type_error ? napi_create_type_error(env, code_v, msg_v, &err)
                 : napi_create_error(env, code_v, msg_v, &err);
  if (s != napi_ok) {
    napi_throw_error(env, code, msg);
    return;
  }
  if (syscall) set_str_prop(env, err, "syscall", syscall);
  if (uncertain) {
    napi_value t;
    if (napi_get_boolean(env, true, &t) == napi_ok)
      napi_set_named_property(env, err, "cleanupUncertain", t);
  }
  napi_throw(env, err);
}

static void throw_os(napi_env env, os_error e, const char* syscall, int uncertain) {
  char code[32], msg[96];
  os_error_code(e, code, sizeof code);
  snprintf(msg, sizeof msg, "oslock: %s failed (%s)%s", syscall, code,
           uncertain ? "; descriptor release uncertain" : "");
  throw_coded(env, 0, code, syscall, msg, uncertain);
}

static void throw_napi(napi_env env, const char* what) {
  char msg[96];
  snprintf(msg, sizeof msg, "oslock: %s failed", what);
  throw_coded(env, 0, "EOSLOCK_NAPI", NULL, msg, 0);
}

/* ---------- argument helpers ---------- */

static int get_one_arg(napi_env env, napi_callback_info info, napi_value* out) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
    throw_napi(env, "napi_get_cb_info");
    return -1;
  }
  if (argc < 1) {
    if (napi_get_undefined(env, &argv[0]) != napi_ok) {
      throw_napi(env, "napi_get_undefined");
      return -1;
    }
  }
  *out = argv[0];
  return 0;
}

/* Resolves a JS value to a live record of THIS env, or throws:
 * untagged/foreign/plain/other-env -> TypeError EOSLOCK_HANDLE; CLOSED -> EOSLOCK_CLOSED. */
static record* get_record(napi_env env, napi_value v) {
  napi_valuetype t;
  bool tagged = false;
  void* p = NULL;
  record* rec;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_object ||
      napi_check_object_type_tag(env, v, &kHandleTag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, v, &p) != napi_ok || p == NULL) {
    throw_coded(env, 1, "EOSLOCK_HANDLE", NULL, "oslock: not an oslock handle", 0);
    return NULL;
  }
  rec = (record*)p;
  if (rec->magic != OSLOCK_RECORD_MAGIC || rec->env != env) {
    throw_coded(env, 1, "EOSLOCK_HANDLE", NULL, "oslock: handle belongs to another environment",
                0);
    return NULL;
  }
  if (rec->state == ST_CLOSED) {
    throw_coded(env, 0, "EOSLOCK_CLOSED", NULL, "oslock: handle is closed", 0);
    return NULL;
  }
  return rec;
}

/* Reads a path string with no truncation: rejects non-strings, empty strings, embedded
 * NUL, unpaired UTF-16 surrogates (which would be silently replaced on conversion) and
 * over-long paths. Returns a malloc'd NUL-terminated UTF-16 buffer. */
static char16_t* get_path_utf16(napi_env env, napi_value v, size_t* len_out) {
  napi_valuetype t;
  size_t n = 0, got = 0, i;
  char16_t* buf;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_string) {
    throw_coded(env, 1, "EOSLOCK_PATH", NULL, "oslock: path must be a string", 0);
    return NULL;
  }
  if (napi_get_value_string_utf16(env, v, NULL, 0, &n) != napi_ok) {
    throw_napi(env, "napi_get_value_string_utf16");
    return NULL;
  }
  if (n == 0) {
    throw_coded(env, 1, "EOSLOCK_PATH", NULL, "oslock: path must not be empty", 0);
    return NULL;
  }
  if (n >= OSLOCK_MAX_PATH_UNITS) {
    throw_coded(env, 0, "ENAMETOOLONG", NULL, "oslock: path too long", 0);
    return NULL;
  }
  buf = (char16_t*)calloc(n + 1, sizeof(char16_t));
  if (!buf) {
    throw_coded(env, 0, "ENOMEM", NULL, "oslock: out of memory", 0);
    return NULL;
  }
  if (napi_get_value_string_utf16(env, v, buf, n + 1, &got) != napi_ok || got != n) {
    free(buf);
    throw_coded(env, 0, "EOSLOCK_PATH", NULL, "oslock: path could not be read in full", 0);
    return NULL;
  }
  for (i = 0; i < n; i++) {
    char16_t c = buf[i];
    int bad = 0;
    if (c == 0) bad = 1;
    else if (c >= 0xD800 && c <= 0xDBFF) {
      if (i + 1 < n && buf[i + 1] >= 0xDC00 && buf[i + 1] <= 0xDFFF) i++;
      else bad = 1;
    } else if (c >= 0xDC00 && c <= 0xDFFF) bad = 1;
    if (bad) {
      free(buf);
      throw_coded(env, 1, "EOSLOCK_PATH", NULL,
                  "oslock: path contains NUL or an unpaired surrogate", 0);
      return NULL;
    }
  }
  *len_out = n;
  return buf;
}

/* ---------- open: returns 0 with a validated descriptor in rec, or throws ---------- */

#ifdef _WIN32
static int os_open_validated(napi_env env, napi_value pathv, record* rec) {
  size_t n = 0;
  char16_t* wpath = get_path_utf16(env, pathv, &n);
  SECURITY_ATTRIBUTES sa;
  BY_HANDLE_FILE_INFORMATION fi;
  HANDLE h;
  const char* reject = NULL;
  const char* reject_code = NULL;
  if (!wpath) return -1;
  sa.nLength = sizeof sa;
  sa.lpSecurityDescriptor = NULL;
  sa.bInheritHandle = FALSE; /* never inherited by children */
  /* No FILE_SHARE_DELETE: the carrier cannot be deleted/renamed while held open.
   * FILE_FLAG_OPEN_REPARSE_POINT: a final-component reparse point is opened as itself
   * and rejected below instead of being followed. */
  h = CreateFileW((LPCWSTR)wpath, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                  &sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  free(wpath);
  if (h == INVALID_HANDLE_VALUE) {
    throw_os(env, GetLastError(), "CreateFileW", 0);
    return -1;
  }
  rec->h = h;
  if (GetFileType(h) != FILE_TYPE_DISK) {
    reject_code = "EOSLOCK_TYPE";
    reject = "oslock: carrier is not a disk file";
  } else if (!GetFileInformationByHandle(h, &fi)) {
    os_error e = GetLastError();
    int cf = os_close(rec) != 0;
    throw_os(env, e, "GetFileInformationByHandle", cf);
    return -1;
  } else if (fi.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
    reject_code = "EOSLOCK_TYPE";
    reject = "oslock: carrier is a directory";
  } else if (fi.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
    reject_code = "EOSLOCK_TYPE";
    reject = "oslock: carrier is a reparse point";
  } else if (fi.nNumberOfLinks != 1) {
    reject_code = "EOSLOCK_LINKS";
    reject = "oslock: carrier has more than one link";
  }
  if (reject) {
    int cf = os_close(rec) != 0; /* closed BEFORE throw */
    throw_coded(env, 0, reject_code, NULL, reject, cf);
    return -1;
  }
  return 0;
}
#else
static int os_open_validated(napi_env env, napi_value pathv, record* rec) {
  size_t n16 = 0, n = 0, got = 0;
  char16_t* check = get_path_utf16(env, pathv, &n16);
  char* path;
  struct stat st;
  int fd, tries = 0;
  const char* reject = NULL;
  const char* reject_code = NULL;
  if (!check) return -1;
  free(check); /* validation only; the syscall needs UTF-8 */
  if (napi_get_value_string_utf8(env, pathv, NULL, 0, &n) != napi_ok) {
    throw_napi(env, "napi_get_value_string_utf8");
    return -1;
  }
  if (n >= PATH_MAX) {
    throw_coded(env, 0, "ENAMETOOLONG", NULL, "oslock: path too long", 0);
    return -1;
  }
  path = (char*)malloc(n + 1);
  if (!path) {
    throw_coded(env, 0, "ENOMEM", NULL, "oslock: out of memory", 0);
    return -1;
  }
  if (napi_get_value_string_utf8(env, pathv, path, n + 1, &got) != napi_ok || got != n ||
      strlen(path) != n) {
    free(path);
    throw_coded(env, 0, "EOSLOCK_PATH", NULL, "oslock: path could not be read in full", 0);
    return -1;
  }
  /* O_NOFOLLOW guards the final component only. O_CLOEXEC is atomic (never set later).
   * O_NONBLOCK keeps a FIFO/device carrier from blocking open() before validation. */
  do {
    fd = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0600);
  } while (fd < 0 && errno == EINTR && tries++ < OSLOCK_EINTR_RETRIES);
  free(path);
  if (fd < 0) {
    throw_os(env, errno, "open", 0);
    return -1;
  }
  rec->fd = fd;
  if (fstat(fd, &st) != 0) {
    os_error e = errno;
    int cf = os_close(rec) != 0;
    throw_os(env, e, "fstat", cf);
    return -1;
  }
  if (!S_ISREG(st.st_mode)) {
    reject_code = "EOSLOCK_TYPE";
    reject = "oslock: carrier is not a regular file";
  } else if (st.st_nlink != 1) {
    reject_code = "EOSLOCK_LINKS";
    reject = "oslock: carrier has more than one link";
  } else if (st.st_uid != geteuid()) {
    reject_code = "EOSLOCK_OWNER";
    reject = "oslock: carrier is owned by another user";
  }
  if (reject) {
    int cf = os_close(rec) != 0; /* closed BEFORE throw */
    throw_coded(env, 0, reject_code, NULL, reject, cf);
    return -1;
  }
  return 0;
}
#endif

/* ---------- finalizers / env cleanup (no JS calls in any of these) ---------- */

static void handle_finalize(napi_env env, void* data, void* hint) {
  record* rec = (record*)data;
  (void)env;
  (void)hint;
  if (!rec || rec->magic != OSLOCK_RECORD_MAGIC) return;
  if (rec->state != ST_CLOSED) {
    const char* sc;
    int cf;
    (void)release_os(rec, &sc, &cf);
  }
  rec_unlink(rec);
  rec->magic = 0;
  free(rec);
}

/* Env teardown (worker exit / main exit): close every live descriptor, unlink records,
 * but never free them — their finalizers may still run afterwards. */
static void env_cleanup(void* arg) {
  registry* reg = (registry*)arg;
  while (reg->head) {
    record* rec = reg->head;
    if (rec->state != ST_CLOSED) {
      const char* sc;
      int cf;
      (void)release_os(rec, &sc, &cf);
    }
    rec_unlink(rec); /* cannot free reg: the hook's own ref is still held */
  }
  reg_unref(reg);
}

static void registry_finalize(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
  reg_unref((registry*)data);
}

/* ---------- exports ---------- */

static napi_value js_abi(napi_env env, napi_callback_info info) {
  napi_value v;
  (void)info;
  if (napi_create_string_utf8(env, OSLOCK_ABI, NAPI_AUTO_LENGTH, &v) != napi_ok) {
    throw_napi(env, "napi_create_string_utf8");
    return NULL;
  }
  return v;
}

static napi_value js_open(napi_env env, napi_callback_info info) {
  napi_value pathv, obj;
  registry* reg = NULL;
  record* rec;
  if (get_one_arg(env, info, &pathv)) return NULL;
  if (napi_get_instance_data(env, (void**)&reg) != napi_ok || !reg) {
    throw_napi(env, "napi_get_instance_data");
    return NULL;
  }
  rec = (record*)calloc(1, sizeof *rec);
  if (!rec) {
    throw_coded(env, 0, "ENOMEM", NULL, "oslock: out of memory", 0);
    return NULL;
  }
  rec->magic = OSLOCK_RECORD_MAGIC;
  rec->env = env;
  rec->state = ST_CLOSED;
  if (os_open_validated(env, pathv, rec)) {
    free(rec); /* descriptor already closed (or never opened) */
    return NULL;
  }
  rec->state = ST_OPEN;
  /* Tag before wrap: if wrap fails the object holds no native pointer and is dropped. */
  if (napi_create_object(env, &obj) != napi_ok ||
      napi_type_tag_object(env, obj, &kHandleTag) != napi_ok ||
      napi_wrap(env, obj, rec, handle_finalize, NULL, NULL) != napi_ok) {
    /* No finalizer was attached, so this frame still owns rec and its descriptor. */
    const char* sc;
    int cf;
    (void)release_os(rec, &sc, &cf);
    rec->magic = 0;
    free(rec);
    throw_napi(env, "handle creation");
    return NULL;
  }
  /* From here the finalizer owns rec's memory; linking cannot fail. */
  rec_link(reg, rec);
  return obj;
}

static napi_value js_try_lock(napi_env env, napi_callback_info info) {
  napi_value hv, result;
  record* rec;
  if (get_one_arg(env, info, &hv)) return NULL;
  if (!(rec = get_record(env, hv))) return NULL;
  if (rec->state == ST_LOCKED) {
    throw_coded(env, 0, "EOSLOCK_STATE", NULL, "oslock: handle is already locked", 0);
    return NULL;
  }
  {
#ifdef _WIN32
    OVERLAPPED ov;
    memset(&ov, 0, sizeof ov);
    if (!LockFileEx(rec->h, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov)) {
      os_error e = GetLastError();
      if (e != ERROR_LOCK_VIOLATION) {
        throw_os(env, e, "LockFileEx", 0);
        return NULL;
      }
      if (napi_get_boolean(env, false, &result) != napi_ok) throw_napi(env, "napi_get_boolean");
      return result;
    }
#else
    int tries = 0;
    for (;;) {
      os_error e;
      if (flock(rec->fd, LOCK_EX | LOCK_NB) == 0) break;
      e = errno;
      if (e == EWOULDBLOCK || e == EAGAIN) {
        if (napi_get_boolean(env, false, &result) != napi_ok) throw_napi(env, "napi_get_boolean");
        return result;
      }
      if (e != EINTR || tries++ >= OSLOCK_EINTR_RETRIES) {
        throw_os(env, e, "flock", 0);
        return NULL;
      }
    }
#endif
  }
  rec->state = ST_LOCKED;
  if (napi_get_boolean(env, true, &result) != napi_ok) {
    throw_napi(env, "napi_get_boolean");
    return NULL;
  }
  return result;
}

static napi_value js_unlock(napi_env env, napi_callback_info info) {
  napi_value hv, undef;
  record* rec;
  os_error e;
  if (get_one_arg(env, info, &hv)) return NULL;
  if (!(rec = get_record(env, hv))) return NULL;
  if (rec->state != ST_LOCKED) {
    throw_coded(env, 0, "EOSLOCK_STATE", NULL, "oslock: handle is not locked", 0);
    return NULL;
  }
  e = os_unlock(rec);
  if (e) {
    /* State stays LOCKED (release not confirmed); close() still releases via close. */
    throw_os(env, e, SYS_UNLOCK, 0);
    return NULL;
  }
  rec->state = ST_OPEN;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value js_close(napi_env env, napi_callback_info info) {
  napi_value hv, undef;
  record* rec;
  const char* sc;
  int cf;
  os_error e;
  if (get_one_arg(env, info, &hv)) return NULL;
  if (!(rec = get_record(env, hv))) return NULL; /* second close -> EOSLOCK_CLOSED */
  e = release_os(rec, &sc, &cf);
  rec_unlink(rec); /* memory stays owned by the finalizer */
  if (e) {
    throw_os(env, e, sc, cf);
    return NULL;
  }
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value js_identity(napi_env env, napi_callback_info info) {
  napi_value hv, obj;
  record* rec;
  char a[32], b[32];
  if (get_one_arg(env, info, &hv)) return NULL;
  if (!(rec = get_record(env, hv))) return NULL;
#ifdef _WIN32
  {
    BY_HANDLE_FILE_INFORMATION fi;
    if (!GetFileInformationByHandle(rec->h, &fi)) {
      throw_os(env, GetLastError(), "GetFileInformationByHandle", 0);
      return NULL;
    }
    snprintf(a, sizeof a, "%lu", (unsigned long)fi.dwVolumeSerialNumber);
    snprintf(b, sizeof b, "%llu",
             ((unsigned long long)fi.nFileIndexHigh << 32) | (unsigned long long)fi.nFileIndexLow);
  }
#else
  {
    struct stat st;
    if (fstat(rec->fd, &st) != 0) {
      throw_os(env, errno, "fstat", 0);
      return NULL;
    }
    /* Same integer conversion libuv applies to st_dev/st_ino (uint64_t). */
    snprintf(a, sizeof a, "%llu", (unsigned long long)(uint64_t)st.st_dev);
    snprintf(b, sizeof b, "%llu", (unsigned long long)(uint64_t)st.st_ino);
  }
#endif
  if (napi_create_object(env, &obj) != napi_ok) {
    throw_napi(env, "napi_create_object");
    return NULL;
  }
#ifdef _WIN32
  set_str_prop(env, obj, "vol", a);
  set_str_prop(env, obj, "idx", b);
#else
  set_str_prop(env, obj, "dev", a);
  set_str_prop(env, obj, "ino", b);
#endif
  return obj;
}

NAPI_MODULE_INIT() {
  void* existing = NULL;
  registry* reg;
  napi_property_descriptor props[] = {
      {"abi", NULL, js_abi, NULL, NULL, NULL, napi_enumerable, NULL},
      {"open", NULL, js_open, NULL, NULL, NULL, napi_enumerable, NULL},
      {"tryLock", NULL, js_try_lock, NULL, NULL, NULL, napi_enumerable, NULL},
      {"unlock", NULL, js_unlock, NULL, NULL, NULL, napi_enumerable, NULL},
      {"close", NULL, js_close, NULL, NULL, NULL, napi_enumerable, NULL},
      {"identity", NULL, js_identity, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  /* Fail closed rather than overwrite another registry's instance data. */
  if (napi_get_instance_data(env, &existing) != napi_ok || existing) {
    throw_coded(env, 0, "EOSLOCK_INIT", NULL, "oslock: environment already initialized", 0);
    return NULL;
  }
  reg = (registry*)calloc(1, sizeof *reg);
  if (!reg) {
    throw_coded(env, 0, "ENOMEM", NULL, "oslock: out of memory", 0);
    return NULL;
  }
  reg->refs = 1; /* instance data */
  if (napi_set_instance_data(env, reg, registry_finalize, NULL) != napi_ok) {
    free(reg);
    throw_napi(env, "napi_set_instance_data");
    return NULL;
  }
  reg->refs++; /* cleanup hook */
  if (napi_add_env_cleanup_hook(env, env_cleanup, reg) != napi_ok) {
    reg->refs--;
    throw_napi(env, "napi_add_env_cleanup_hook");
    return NULL;
  }
  if (napi_define_properties(env, exports, sizeof props / sizeof props[0], props) != napi_ok) {
    throw_napi(env, "napi_define_properties");
    return NULL;
  }
  return exports;
}
