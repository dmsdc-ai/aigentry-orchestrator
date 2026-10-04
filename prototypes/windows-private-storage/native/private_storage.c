/*
 * Windows private-storage feasibility prototype (task 1167, CONTRACT r2).
 *
 * Isolated prototype: NOT imported by src/hitl/web/auth.ts, not packaged, not
 * shipped. Node-API + kernel32/advapi32 only. Four functions:
 *   inspectDir(path)
 *   readPrivateFile(path, max)
 *   createPrivateDir(path)
 *   createPrivateFileExclusive(path, bytes)
 * Each returns { status, reason, win32Error, ... } and never echoes the path
 * or any input/output bytes in a failure result. See ../README.md.
 *
 * Stated limits (not solved here): ancestor races between component checks,
 * privileged tokens (SeBackup/SeRestore/SeTakeOwnership/SeDebug), SYSTEM,
 * same-user processes, VSS, offline access, durability (G2).
 */
#ifndef _WIN32
#error "private_storage.c is a Windows-only prototype"
#endif

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <aclapi.h>

#ifndef NAPI_VERSION
#define NAPI_VERSION 8
#endif
#ifndef BUILDING_NODE_EXTENSION
#define BUILDING_NODE_EXTENSION
#endif
#include <node_api.h>

#define PS_ABI_TAG "aigentry-private-storage-proto-1"
#define PS_PREFIX_LEN 4                      /* L"\\\\?\\" */
#define PS_MAX_PATH_CHARS 32000              /* user path, excluding prefix */
#define PS_MAX_COMPONENT_CHARS 255
#define PS_MAX_FINAL_CHARS 32768             /* GetFinalPathNameByHandleW bound */
#define PS_MAX_IO_BYTES (16u * 1024u * 1024u)
#define PS_IO_CHUNK (1u * 1024u * 1024u)
#define PS_TOKEN_INFO_BYTES 512

/* WCHAR and Node-API char16_t must have the same width. */
typedef char ps_wchar_width_check[(sizeof(WCHAR) == sizeof(char16_t)) ? 1 : -1];

typedef enum ps_status {
  PS_OK = 0,
  PS_MISSING,
  PS_UNSAFE,
  PS_EXISTS,
  PS_UNAVAILABLE
} ps_status;

static const char *const ps_status_names[] = {
  "ok", "missing", "unsafe", "exists", "unavailable"
};

typedef struct ps_result {
  ps_status status;
  const char *reason;  /* static string only */
  DWORD win32_error;
  int created;         /* -1: not a create call */
  BOOL has_identity;
  FILE_ID_INFO identity;
} ps_result;

typedef struct ps_path {
  WCHAR *buf;          /* L"\\\\?\\" + validated user path, NUL terminated */
  size_t len;          /* chars in buf, excluding NUL */
} ps_path;

typedef union ps_sid {
  SID sid;
  BYTE raw[SECURITY_MAX_SID_SIZE];
} ps_sid;

typedef union ps_token_user_buf {
  TOKEN_USER tu;
  BYTE raw[PS_TOKEN_INFO_BYTES];
} ps_token_user_buf;

typedef union ps_acl_buf {
  ACL acl;
  BYTE raw[256];
} ps_acl_buf;

typedef struct ps_private_sd {
  SECURITY_DESCRIPTOR sd;
  ps_acl_buf dacl;
} ps_private_sd;

static void ps_init(ps_result *r, int created) {
  ZeroMemory(r, sizeof(*r));
  r->status = PS_UNAVAILABLE;
  r->reason = "internal_error";
  r->win32_error = 0;
  r->created = created;
}

static void ps_set(ps_result *r, ps_status status, const char *reason, DWORD err) {
  r->status = status;
  r->reason = reason;
  r->win32_error = err;
}

/* Not-found errors map to missing; every other open error fails closed. */
static void ps_fail_open(ps_result *r, DWORD err, const char *reason) {
  if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) {
    ps_set(r, PS_MISSING, "not_found", err);
  } else {
    ps_set(r, PS_UNAVAILABLE, reason, err);
  }
}

static void ps_close(HANDLE *h, ps_result *r) {
  if (*h == INVALID_HANDLE_VALUE) return;
  if (!CloseHandle(*h) && r->status == PS_OK) {
    ps_set(r, PS_UNAVAILABLE, "close_failed", GetLastError());
  }
  *h = INVALID_HANDLE_VALUE;
}

/* ---------- path grammar ---------- */

static WCHAR ps_ascii_upper(WCHAR ch) {
  return (ch >= L'a' && ch <= L'z') ? (WCHAR)(ch - (L'a' - L'A')) : ch;
}

static BOOL ps_ascii_ieq(const WCHAR *c, const char *lit, size_t n) {
  size_t i;
  for (i = 0; i < n; i++) {
    if (ps_ascii_upper(c[i]) != (WCHAR)(unsigned char)lit[i]) return FALSE;
  }
  return TRUE;
}

/* Reserved DOS device names, with or without an extension. */
static BOOL ps_is_reserved_name(const WCHAR *c, size_t n) {
  size_t base = 0;
  WCHAR d;
  while (base < n && c[base] != L'.') base++;
  while (base > 0 && c[base - 1] == L' ') base--;
  if (base == 3) {
    return ps_ascii_ieq(c, "CON", 3) || ps_ascii_ieq(c, "PRN", 3) ||
           ps_ascii_ieq(c, "AUX", 3) || ps_ascii_ieq(c, "NUL", 3);
  }
  if (base == 4 && (ps_ascii_ieq(c, "COM", 3) || ps_ascii_ieq(c, "LPT", 3))) {
    d = c[3];
    return (d >= L'0' && d <= L'9') || d == 0x00B9 || d == 0x00B2 || d == 0x00B3;
  }
  if (base == 6) return ps_ascii_ieq(c, "CONIN$", 6);
  if (base == 7) return ps_ascii_ieq(c, "CONOUT$", 7);
  return FALSE;
}

static BOOL ps_valid_component(const WCHAR *c, size_t n) {
  size_t i;
  WCHAR ch;
  if (n == 0 || n > PS_MAX_COMPONENT_CHARS) return FALSE;
  for (i = 0; i < n; i++) {
    ch = c[i];
    if (ch < 0x20 || ch == L'<' || ch == L'>' || ch == L':' || ch == L'"' ||
        ch == L'/' || ch == L'|' || ch == L'?' || ch == L'*') {
      return FALSE;
    }
  }
  /* Trailing dot/space (also rejects "." and ".."). */
  if (c[n - 1] == L'.' || c[n - 1] == L' ') return FALSE;
  return !ps_is_reserved_name(c, n);
}

/*
 * Accepted user grammar: "X:\comp[\comp...]" only. Refused: UNC, "\\?\",
 * "\\.\", forward slashes, relative/drive-relative paths, empty components,
 * "." / "..", ADS ':' after the drive, trailing dot/space, reserved device
 * names, control and wildcard characters, trailing separator. The only
 * "\\?\" this module ever handles is the one it prepends itself.
 */
static BOOL ps_valid_grammar(const WCHAR *u, size_t n) {
  size_t i, start;
  if (n < 4) return FALSE;
  if (!((u[0] >= L'A' && u[0] <= L'Z') || (u[0] >= L'a' && u[0] <= L'z'))) return FALSE;
  if (u[1] != L':' || u[2] != L'\\') return FALSE;
  start = 3;
  for (i = 3; i <= n; i++) {
    if (i == n || u[i] == L'\\') {
      if (!ps_valid_component(u + start, i - start)) return FALSE;
      start = i + 1;
    }
  }
  return TRUE;
}

static void ps_path_free(ps_path *p) {
  if (p->buf != NULL) {
    HeapFree(GetProcessHeap(), 0, p->buf);
    p->buf = NULL;
  }
  p->len = 0;
}

static BOOL ps_read_path(napi_env env, napi_value v, ps_path *p, ps_result *r) {
  napi_valuetype t;
  size_t n = 0, copied = 0;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_string) {
    ps_set(r, PS_UNAVAILABLE, "invalid_argument", 0);
    return FALSE;
  }
  if (napi_get_value_string_utf16(env, v, NULL, 0, &n) != napi_ok) {
    ps_set(r, PS_UNAVAILABLE, "invalid_argument", 0);
    return FALSE;
  }
  if (n == 0 || n > PS_MAX_PATH_CHARS) {
    ps_set(r, PS_UNSAFE, "path_grammar", 0);
    return FALSE;
  }
  p->buf = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                              (PS_PREFIX_LEN + n + 1) * sizeof(WCHAR));
  if (p->buf == NULL) {
    ps_set(r, PS_UNAVAILABLE, "alloc_failed", ERROR_NOT_ENOUGH_MEMORY);
    return FALSE;
  }
  p->buf[0] = L'\\';
  p->buf[1] = L'\\';
  p->buf[2] = L'?';
  p->buf[3] = L'\\';
  if (napi_get_value_string_utf16(env, v, (char16_t *)(p->buf + PS_PREFIX_LEN), n + 1,
                                  &copied) != napi_ok ||
      copied != n) {
    ps_set(r, PS_UNAVAILABLE, "invalid_argument", 0);
    return FALSE;
  }
  p->len = PS_PREFIX_LEN + n;
  p->buf[p->len] = L'\0';
  if (!ps_valid_grammar(p->buf + PS_PREFIX_LEN, n)) {
    ps_set(r, PS_UNSAFE, "path_grammar", 0);
    return FALSE;
  }
  return TRUE;
}

/* ---------- other arguments ---------- */

static BOOL ps_read_max(napi_env env, napi_value v, DWORD *out, ps_result *r) {
  napi_valuetype t;
  double d = 0.0;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_number ||
      napi_get_value_double(env, v, &d) != napi_ok) {
    ps_set(r, PS_UNAVAILABLE, "invalid_argument", 0);
    return FALSE;
  }
  /* Rejects NaN, infinities, negatives, non-integers and values over the cap. */
  if (!(d >= 0.0 && d <= (double)PS_MAX_IO_BYTES) || (double)(DWORD)d != d) {
    ps_set(r, PS_UNAVAILABLE, "invalid_argument", 0);
    return FALSE;
  }
  *out = (DWORD)d;
  return TRUE;
}

static BOOL ps_read_bytes(napi_env env, napi_value v, const BYTE **data, size_t *len,
                          ps_result *r) {
  bool is = false;
  void *ptr = NULL;
  size_t n = 0, offset = 0;
  napi_typedarray_type type;
  napi_value backing;
  if (napi_is_buffer(env, v, &is) != napi_ok) {
    ps_set(r, PS_UNAVAILABLE, "invalid_argument", 0);
    return FALSE;
  }
  if (is) {
    if (napi_get_buffer_info(env, v, &ptr, &n) != napi_ok) {
      ps_set(r, PS_UNAVAILABLE, "invalid_argument", 0);
      return FALSE;
    }
  } else {
    if (napi_is_typedarray(env, v, &is) != napi_ok || !is ||
        napi_get_typedarray_info(env, v, &type, &n, &ptr, &backing, &offset) != napi_ok ||
        type != napi_uint8_array) {
      ps_set(r, PS_UNAVAILABLE, "invalid_argument", 0);
      return FALSE;
    }
  }
  if (n > PS_MAX_IO_BYTES || (n > 0 && ptr == NULL)) {
    ps_set(r, PS_UNAVAILABLE, "invalid_argument", 0);
    return FALSE;
  }
  *data = (const BYTE *)ptr;
  *len = n;
  return TRUE;
}

/* ---------- token and creation descriptor ---------- */

static BOOL ps_token_user(ps_sid *out, ps_result *r) {
  HANDLE token = NULL;
  ps_token_user_buf info;
  DWORD needed = 0, err;
  PSID sid;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    ps_set(r, PS_UNAVAILABLE, "token_open_failed", GetLastError());
    return FALSE;
  }
  if (!GetTokenInformation(token, TokenUser, &info, (DWORD)sizeof(info), &needed)) {
    err = GetLastError();
    CloseHandle(token);
    ps_set(r, PS_UNAVAILABLE, "token_query_failed", err);
    return FALSE;
  }
  if (!CloseHandle(token)) {
    ps_set(r, PS_UNAVAILABLE, "close_failed", GetLastError());
    return FALSE;
  }
  sid = info.tu.User.Sid;
  if (sid == NULL || !IsValidSid(sid) || GetLengthSid(sid) > (DWORD)sizeof(out->raw)) {
    ps_set(r, PS_UNAVAILABLE, "token_sid_invalid", 0);
    return FALSE;
  }
  if (!CopySid((DWORD)sizeof(out->raw), out->raw, sid)) {
    ps_set(r, PS_UNAVAILABLE, "token_sid_invalid", GetLastError());
    return FALSE;
  }
  return TRUE;
}

/*
 * Owner = TokenUser, protected DACL with exactly one ACE: allow TokenUser
 * FILE_ALL_ACCESS (OI|CI for directories). Supplied at creation only; this
 * module never calls SetSecurityInfo on an existing object.
 */
static BOOL ps_build_private_sd(ps_private_sd *out, PSID user, BOOL is_dir, ps_result *r) {
  DWORD acl_len = (DWORD)(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD)) +
                  GetLengthSid(user);
  BYTE flags = is_dir ? (BYTE)(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) : (BYTE)0;
  ZeroMemory(out, sizeof(*out));
  if (acl_len > (DWORD)sizeof(out->dacl.raw)) {
    ps_set(r, PS_UNAVAILABLE, "descriptor_build_failed", 0);
    return FALSE;
  }
  if (!InitializeAcl(&out->dacl.acl, acl_len, ACL_REVISION) ||
      !AddAccessAllowedAceEx(&out->dacl.acl, ACL_REVISION, flags, FILE_ALL_ACCESS, user) ||
      !InitializeSecurityDescriptor(&out->sd, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&out->sd, user, FALSE) ||
      !SetSecurityDescriptorDacl(&out->sd, TRUE, &out->dacl.acl, FALSE) ||
      !SetSecurityDescriptorControl(&out->sd, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
    ps_set(r, PS_UNAVAILABLE, "descriptor_build_failed", GetLastError());
    return FALSE;
  }
  if (!IsValidSecurityDescriptor(&out->sd)) {
    ps_set(r, PS_UNAVAILABLE, "descriptor_build_failed", 0);
    return FALSE;
  }
  return TRUE;
}

/* ---------- ancestor walk ---------- */

/* buf[end] is temporarily NUL-terminated and always restored. */
static BOOL ps_check_ancestor(WCHAR *buf, size_t end, ps_result *r) {
  WCHAR saved = buf[end];
  HANDLE h;
  DWORD err;
  FILE_BASIC_INFO bi;
  BOOL ok = FALSE;
  buf[end] = L'\0';
  h = CreateFileW(buf, FILE_READ_ATTRIBUTES,
                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                  OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                  NULL);
  err = GetLastError();
  buf[end] = saved;
  if (h == INVALID_HANDLE_VALUE) {
    ps_fail_open(r, err, "ancestor_open_failed");
    return FALSE;
  }
  if (!GetFileInformationByHandleEx(h, FileBasicInfo, &bi, (DWORD)sizeof(bi))) {
    ps_set(r, PS_UNAVAILABLE, "ancestor_query_failed", GetLastError());
  } else if (bi.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
    ps_set(r, PS_UNSAFE, "ancestor_reparse_point", 0);
  } else if (!(bi.FileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
    ps_set(r, PS_UNSAFE, "ancestor_not_directory", 0);
  } else {
    ok = TRUE;
  }
  if (!CloseHandle(h) && ok) {
    ps_set(r, PS_UNAVAILABLE, "close_failed", GetLastError());
    ok = FALSE;
  }
  return ok;
}

/*
 * Opens every proper ancestor (drive root first) separately and refuses
 * reparse points and non-directories. Each handle is closed before the next
 * open, so an ancestor swap between checks is a stated limit; the leaf
 * final-path comparison only catches a swap visible when the leaf is opened.
 */
static BOOL ps_walk_ancestors(ps_path *p, ps_result *r) {
  size_t i, root_sep = PS_PREFIX_LEN + 2;
  for (i = root_sep; i < p->len; i++) {
    if (p->buf[i] != L'\\') continue;
    if (!ps_check_ancestor(p->buf, i == root_sep ? i + 1 : i, r)) return FALSE;
  }
  return TRUE;
}

/* ---------- same-handle checks ---------- */

static BOOL ps_check_attributes(HANDLE h, BOOL want_dir, ps_result *r) {
  FILE_BASIC_INFO bi;
  FILE_STANDARD_INFO si;
  DWORD type, err;
  SetLastError(NO_ERROR);
  type = GetFileType(h);
  if (type != FILE_TYPE_DISK) {
    err = GetLastError();
    if (type == FILE_TYPE_UNKNOWN && err != NO_ERROR) {
      ps_set(r, PS_UNAVAILABLE, "type_query_failed", err);
    } else {
      ps_set(r, PS_UNSAFE, want_dir ? "not_directory" : "not_regular_file", 0);
    }
    return FALSE;
  }
  if (!GetFileInformationByHandleEx(h, FileBasicInfo, &bi, (DWORD)sizeof(bi))) {
    ps_set(r, PS_UNAVAILABLE, "attributes_query_failed", GetLastError());
    return FALSE;
  }
  if (bi.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
    ps_set(r, PS_UNSAFE, "reparse_point", 0);
    return FALSE;
  }
  if (want_dir != ((bi.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0)) {
    ps_set(r, PS_UNSAFE, want_dir ? "not_directory" : "not_regular_file", 0);
    return FALSE;
  }
  if (!GetFileInformationByHandleEx(h, FileStandardInfo, &si, (DWORD)sizeof(si))) {
    ps_set(r, PS_UNAVAILABLE, "attributes_query_failed", GetLastError());
    return FALSE;
  }
  if (want_dir != (si.Directory != FALSE)) {
    ps_set(r, PS_UNSAFE, want_dir ? "not_directory" : "not_regular_file", 0);
    return FALSE;
  }
  if (!want_dir && si.NumberOfLinks != 1) {
    ps_set(r, PS_UNSAFE, "link_count", 0);
    return FALSE;
  }
  return TRUE;
}

static BOOL ps_check_volume(HANDLE h, ps_result *r) {
  DWORD flags = 0;
  if (!GetVolumeInformationByHandleW(h, NULL, 0, NULL, NULL, &flags, NULL, 0)) {
    ps_set(r, PS_UNAVAILABLE, "volume_query_failed", GetLastError());
    return FALSE;
  }
  if (!(flags & FILE_PERSISTENT_ACLS)) {
    ps_set(r, PS_UNSAFE, "acl_not_persistent", 0);
    return FALSE;
  }
  return TRUE;
}

/*
 * The final path must be exactly "\\?\" + the requested path, compared
 * case-insensitively (ordinal, locale-free). The only prefix stripped is the
 * "\\?\" + drive form that GetFinalPathNameByHandleW itself returns for
 * VOLUME_NAME_DOS; any other form (UNC, volume GUID, ...) is refused rather
 * than skipping the comparison.
 */
static BOOL ps_check_final_path(HANDLE h, const ps_path *p, ps_result *r) {
  WCHAR *buf = NULL;
  DWORD cap = (DWORD)(p->len + 1), n = 0;
  int attempt, cmp;
  BOOL ok = FALSE;
  for (attempt = 0; attempt < 2; attempt++) {
    buf = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (size_t)cap * sizeof(WCHAR));
    if (buf == NULL) {
      ps_set(r, PS_UNAVAILABLE, "alloc_failed", ERROR_NOT_ENOUGH_MEMORY);
      return FALSE;
    }
    n = GetFinalPathNameByHandleW(h, buf, cap, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (n == 0) {
      ps_set(r, PS_UNAVAILABLE, "final_path_query_failed", GetLastError());
      goto done;
    }
    if (n < cap) break;
    /* n is the required size including NUL. */
    HeapFree(GetProcessHeap(), 0, buf);
    buf = NULL;
    if (n > PS_MAX_FINAL_CHARS || attempt == 1) {
      ps_set(r, PS_UNSAFE, "final_path_mismatch", 0);
      return FALSE;
    }
    cap = n;
  }
  if (buf == NULL) {
    ps_set(r, PS_UNAVAILABLE, "final_path_query_failed", 0);
    return FALSE;
  }
  if (n < PS_PREFIX_LEN + 3 || buf[0] != L'\\' || buf[1] != L'\\' || buf[2] != L'?' ||
      buf[3] != L'\\') {
    ps_set(r, PS_UNSAFE, "final_path_unrecognized", 0);
    goto done;
  }
  if (buf[PS_PREFIX_LEN + 1] != L':' || buf[PS_PREFIX_LEN + 2] != L'\\') {
    /* e.g. "\\?\UNC\..." or a volume GUID path */
    ps_set(r, PS_UNSAFE, "final_path_unrecognized", 0);
    goto done;
  }
  if ((size_t)n != p->len) {
    ps_set(r, PS_UNSAFE, "final_path_mismatch", 0);
    goto done;
  }
  cmp = CompareStringOrdinal(buf + PS_PREFIX_LEN, (int)(n - PS_PREFIX_LEN),
                             p->buf + PS_PREFIX_LEN, (int)(p->len - PS_PREFIX_LEN), TRUE);
  if (cmp == 0) {
    ps_set(r, PS_UNAVAILABLE, "final_path_compare_failed", GetLastError());
    goto done;
  }
  if (cmp != CSTR_EQUAL) {
    ps_set(r, PS_UNSAFE, "final_path_mismatch", 0);
    goto done;
  }
  ok = TRUE;
done:
  if (buf != NULL) HeapFree(GetProcessHeap(), 0, buf);
  return ok;
}

/*
 * P-DIR / P-FILE descriptor checks: owner == TokenUser; DACL present and
 * non-NULL; directories also SE_DACL_PROTECTED; only ACCESS_ALLOWED and
 * ACCESS_DENIED ACE types; no allow ACE (explicit or inherited, including
 * inherit-only) for any other SID; at least one effective owner allow ACE with
 * the required rights (directories: OI|CI). An empty DACL is never vacuous
 * success: directory -> unsafe, file -> unavailable (owner has no data access).
 */
static BOOL ps_check_security(HANDLE h, PSID user, BOOL is_dir, ps_result *r) {
  PSID owner = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0, rc, i, sid_room;
  ACL_SIZE_INFORMATION asi;
  GENERIC_MAPPING mapping;
  ACCESS_MASK need, mask;
  LPVOID ace;
  ACE_HEADER *hdr;
  ACCESS_ALLOWED_ACE *allow;
  PSID ace_sid;
  BOOL owner_ace = FALSE, ok = FALSE;

  mapping.GenericRead = FILE_GENERIC_READ;
  mapping.GenericWrite = FILE_GENERIC_WRITE;
  mapping.GenericExecute = FILE_GENERIC_EXECUTE;
  mapping.GenericAll = FILE_ALL_ACCESS;
  need = is_dir ? (FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_TRAVERSE)
                : (FILE_READ_DATA | FILE_WRITE_DATA);

  rc = GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                       &owner, NULL, &dacl, NULL, &sd);
  if (rc != ERROR_SUCCESS) {
    ps_set(r, PS_UNAVAILABLE, "security_query_failed", rc);
    return FALSE;
  }
  if (sd == NULL || !GetSecurityDescriptorControl(sd, &control, &revision)) {
    ps_set(r, PS_UNAVAILABLE, "security_query_failed", sd == NULL ? 0 : GetLastError());
    goto done;
  }
  if (owner == NULL || !IsValidSid(owner) || !EqualSid(owner, user)) {
    ps_set(r, PS_UNSAFE, "owner_mismatch", 0);
    goto done;
  }
  if (!(control & SE_DACL_PRESENT)) {
    ps_set(r, PS_UNSAFE, "dacl_absent", 0);
    goto done;
  }
  if (dacl == NULL) {
    ps_set(r, PS_UNSAFE, "dacl_null", 0);
    goto done;
  }
  if (is_dir && !(control & SE_DACL_PROTECTED)) {
    ps_set(r, PS_UNSAFE, "dacl_not_protected", 0);
    goto done;
  }
  if (!IsValidAcl(dacl)) {
    ps_set(r, PS_UNSAFE, "dacl_invalid", 0);
    goto done;
  }
  if (!GetAclInformation(dacl, &asi, (DWORD)sizeof(asi), AclSizeInformation)) {
    ps_set(r, PS_UNAVAILABLE, "security_query_failed", GetLastError());
    goto done;
  }
  if (asi.AceCount == 0) {
    ps_set(r, is_dir ? PS_UNSAFE : PS_UNAVAILABLE, "dacl_empty", 0);
    goto done;
  }
  for (i = 0; i < asi.AceCount; i++) {
    if (!GetAce(dacl, i, &ace) || ace == NULL) {
      ps_set(r, PS_UNAVAILABLE, "security_query_failed", GetLastError());
      goto done;
    }
    hdr = (ACE_HEADER *)ace;
    if (hdr->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (hdr->AceType != ACCESS_ALLOWED_ACE_TYPE) {
      ps_set(r, PS_UNSAFE, "ace_unsupported", 0);
      goto done;
    }
    if (hdr->AceSize < (WORD)(FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart) + 8)) {
      ps_set(r, PS_UNSAFE, "dacl_invalid", 0);
      goto done;
    }
    allow = (ACCESS_ALLOWED_ACE *)ace;
    ace_sid = (PSID)&allow->SidStart;
    sid_room = (DWORD)hdr->AceSize - (DWORD)FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart);
    if (!IsValidSid(ace_sid) || GetLengthSid(ace_sid) > sid_room) {
      ps_set(r, PS_UNSAFE, "dacl_invalid", 0);
      goto done;
    }
    if (!EqualSid(ace_sid, user)) {
      ps_set(r, PS_UNSAFE, "ace_foreign_allow", 0);
      goto done;
    }
    if (hdr->AceFlags & INHERIT_ONLY_ACE) continue;
    if (is_dir && (hdr->AceFlags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) !=
                      (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) {
      continue;
    }
    mask = allow->Mask;
    MapGenericMask(&mask, &mapping);
    if ((mask & need) == need) owner_ace = TRUE;
  }
  if (!owner_ace) {
    ps_set(r, PS_UNSAFE, "owner_ace_missing", 0);
    goto done;
  }
  ok = TRUE;
done:
  LocalFree(sd);
  return ok;
}

static BOOL ps_query_identity(HANDLE h, ps_result *r) {
  if (!GetFileInformationByHandleEx(h, FileIdInfo, &r->identity, (DWORD)sizeof(r->identity))) {
    ps_set(r, PS_UNAVAILABLE, "identity_query_failed", GetLastError());
    return FALSE;
  }
  r->has_identity = TRUE;
  return TRUE;
}

static BOOL ps_verify_handle(HANDLE h, const ps_path *p, PSID user, BOOL is_dir, ps_result *r) {
  return ps_check_attributes(h, is_dir, r) && ps_check_volume(h, r) &&
         ps_check_final_path(h, p, r) && ps_check_security(h, user, is_dir, r) &&
         ps_query_identity(h, r);
}

/* ---------- bounded IO ---------- */

/* *data/*cap are set as soon as allocated so the caller always zeroes/frees. */
static BOOL ps_read_bounded(HANDLE h, DWORD max, BYTE **data, size_t *cap, size_t *total,
                            ps_result *r) {
  FILE_STANDARD_INFO si;
  size_t size, done = 0;
  DWORD want, got;
  if (!GetFileInformationByHandleEx(h, FileStandardInfo, &si, (DWORD)sizeof(si))) {
    ps_set(r, PS_UNAVAILABLE, "size_query_failed", GetLastError());
    return FALSE;
  }
  if (si.EndOfFile.QuadPart < 0 || (ULONGLONG)si.EndOfFile.QuadPart > (ULONGLONG)max) {
    ps_set(r, PS_UNSAFE, "size_limit", 0);
    return FALSE;
  }
  size = (size_t)si.EndOfFile.QuadPart;
  /* One spare byte detects growth past the queried size. */
  *data = (BYTE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size + 1);
  if (*data == NULL) {
    ps_set(r, PS_UNAVAILABLE, "alloc_failed", ERROR_NOT_ENOUGH_MEMORY);
    return FALSE;
  }
  *cap = size + 1;
  while (done < *cap) {
    want = (DWORD)(*cap - done);
    got = 0;
    if (!ReadFile(h, *data + done, want, &got, NULL)) {
      ps_set(r, PS_UNAVAILABLE, "read_failed", GetLastError());
      return FALSE;
    }
    if (got == 0) break;
    if (got > want) {
      ps_set(r, PS_UNAVAILABLE, "read_failed", 0);
      return FALSE;
    }
    done += got;
  }
  *total = done;
  if (done > (size_t)max) {
    ps_set(r, PS_UNSAFE, "size_limit", 0);
    return FALSE;
  }
  if (done != size) {
    ps_set(r, PS_UNAVAILABLE, "size_changed", 0);
    return FALSE;
  }
  return TRUE;
}

static BOOL ps_write_all(HANDLE h, const BYTE *src, size_t n, ps_result *r) {
  size_t off = 0;
  DWORD chunk, wrote;
  while (off < n) {
    chunk = (DWORD)((n - off) > PS_IO_CHUNK ? PS_IO_CHUNK : (n - off));
    wrote = 0;
    if (!WriteFile(h, src + off, chunk, &wrote, NULL)) {
      ps_set(r, PS_UNAVAILABLE, "write_failed", GetLastError());
      return FALSE;
    }
    if (wrote == 0 || wrote > chunk) {
      ps_set(r, PS_UNAVAILABLE, "short_write", 0);
      return FALSE;
    }
    off += wrote;
  }
  /* Flushes this handle only; not a power-loss or rename durability claim. */
  if (!FlushFileBuffers(h)) {
    ps_set(r, PS_UNAVAILABLE, "flush_failed", GetLastError());
    return FALSE;
  }
  return TRUE;
}

/* ---------- result object ---------- */

static BOOL ps_set_string(napi_env env, napi_value obj, const char *key, const char *value) {
  napi_value v;
  return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &v) == napi_ok &&
         napi_set_named_property(env, obj, key, v) == napi_ok;
}

static void ps_hex(const BYTE *src, size_t n, char *dst) {
  static const char digits[] = "0123456789abcdef";
  size_t i;
  for (i = 0; i < n; i++) {
    dst[2 * i] = digits[src[i] >> 4];
    dst[2 * i + 1] = digits[src[i] & 0x0F];
  }
  dst[2 * n] = '\0';
}

/* Returns NULL on any Node-API failure; the JS wrapper maps that to unavailable. */
static napi_value ps_make_result(napi_env env, const ps_result *r, BOOL with_bytes,
                                 const BYTE *bytes, size_t nbytes) {
  napi_value obj, v;
  BYTE serial[8];
  char hex[33];
  int i;
  BOOL ok = r->status == PS_OK;
  if (napi_create_object(env, &obj) != napi_ok) return NULL;
  if (!ps_set_string(env, obj, "status", ps_status_names[r->status])) return NULL;
  if (!ps_set_string(env, obj, "reason", ok ? "ok" : r->reason)) return NULL;
  if (napi_create_uint32(env, (uint32_t)r->win32_error, &v) != napi_ok ||
      napi_set_named_property(env, obj, "win32Error", v) != napi_ok) {
    return NULL;
  }
  if (r->created >= 0) {
    if (napi_get_boolean(env, r->created != 0, &v) != napi_ok ||
        napi_set_named_property(env, obj, "created", v) != napi_ok) {
      return NULL;
    }
  }
  if (ok && r->has_identity) {
    for (i = 0; i < 8; i++) {
      serial[i] = (BYTE)(r->identity.VolumeSerialNumber >> (8 * (7 - i)));
    }
    ps_hex(serial, sizeof(serial), hex);
    if (!ps_set_string(env, obj, "volumeSerial", hex)) return NULL;
    ps_hex(r->identity.FileId.Identifier, sizeof(r->identity.FileId.Identifier), hex);
    if (!ps_set_string(env, obj, "fileId", hex)) return NULL;
  }
  if (ok && with_bytes) {
    if (bytes == NULL ||
        napi_create_buffer_copy(env, nbytes, bytes, NULL, &v) != napi_ok ||
        napi_set_named_property(env, obj, "bytes", v) != napi_ok) {
      return NULL;
    }
  }
  return obj;
}

/* ---------- exported functions ---------- */

static napi_value ps_inspect_dir(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  ps_result r;
  ps_path p = {NULL, 0};
  ps_sid user;
  HANDLE h = INVALID_HANDLE_VALUE;
  ps_init(&r, -1);
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    ps_set(&r, PS_UNAVAILABLE, "invalid_argument", 0);
    goto done;
  }
  if (!ps_read_path(env, argv[0], &p, &r)) goto done;
  if (!ps_token_user(&user, &r)) goto done;
  if (!ps_walk_ancestors(&p, &r)) goto done;
  h = CreateFileW(p.buf, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
                  NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                  NULL);
  if (h == INVALID_HANDLE_VALUE) {
    ps_fail_open(&r, GetLastError(), "open_failed");
    goto done;
  }
  if (!ps_verify_handle(h, &p, &user.sid, TRUE, &r)) goto done;
  ps_set(&r, PS_OK, "ok", 0);
done:
  ps_close(&h, &r);
  ps_path_free(&p);
  return ps_make_result(env, &r, FALSE, NULL, 0);
}

static napi_value ps_read_private_file(napi_env env, napi_callback_info info) {
  size_t argc = 2, cap = 0, total = 0;
  napi_value argv[2];
  napi_value result;
  ps_result r;
  ps_path p = {NULL, 0};
  ps_sid user;
  HANDLE h = INVALID_HANDLE_VALUE;
  DWORD max = 0;
  BYTE *data = NULL;
  ps_init(&r, -1);
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    ps_set(&r, PS_UNAVAILABLE, "invalid_argument", 0);
    goto done;
  }
  if (!ps_read_max(env, argv[1], &max, &r)) goto done;
  if (!ps_read_path(env, argv[0], &p, &r)) goto done;
  if (!ps_token_user(&user, &r)) goto done;
  if (!ps_walk_ancestors(&p, &r)) goto done;
  /* Share READ only: no write/delete through another open while held. */
  h = CreateFileW(p.buf, FILE_READ_DATA | READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
                  NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN,
                  NULL);
  if (h == INVALID_HANDLE_VALUE) {
    ps_fail_open(&r, GetLastError(), "open_failed");
    goto done;
  }
  if (!ps_verify_handle(h, &p, &user.sid, FALSE, &r)) goto done;
  if (!ps_read_bounded(h, max, &data, &cap, &total, &r)) goto done;
  ps_set(&r, PS_OK, "ok", 0);
done:
  ps_close(&h, &r);
  ps_path_free(&p);
  result = ps_make_result(env, &r, TRUE, data, total);
  if (data != NULL) {
    SecureZeroMemory(data, cap);
    HeapFree(GetProcessHeap(), 0, data);
  }
  return result;
}

static napi_value ps_create_private_dir(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  ps_result r;
  ps_path p = {NULL, 0};
  ps_sid user;
  ps_private_sd psd;
  SECURITY_ATTRIBUTES sa;
  HANDLE h = INVALID_HANDLE_VALUE;
  DWORD err;
  ps_init(&r, 0);
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    ps_set(&r, PS_UNAVAILABLE, "invalid_argument", 0);
    goto done;
  }
  if (!ps_read_path(env, argv[0], &p, &r)) goto done;
  if (!ps_token_user(&user, &r)) goto done;
  if (!ps_build_private_sd(&psd, &user.sid, TRUE, &r)) goto done;
  if (!ps_walk_ancestors(&p, &r)) goto done;
  sa.nLength = (DWORD)sizeof(sa);
  sa.lpSecurityDescriptor = &psd.sd;
  sa.bInheritHandle = FALSE;
  if (!CreateDirectoryW(p.buf, &sa)) {
    err = GetLastError();
    if (err == ERROR_ALREADY_EXISTS || err == ERROR_FILE_EXISTS) {
      ps_set(&r, PS_EXISTS, "already_exists", err);
    } else {
      ps_fail_open(&r, err, "create_failed");
    }
    goto done;
  }
  r.created = 1;
  /* Re-check by path: a swap between create and open is the stated ancestor limit. */
  h = CreateFileW(p.buf, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
                  NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                  NULL);
  if (h == INVALID_HANDLE_VALUE) {
    ps_fail_open(&r, GetLastError(), "open_failed");
    goto done;
  }
  if (!ps_verify_handle(h, &p, &user.sid, TRUE, &r)) goto done;
  ps_set(&r, PS_OK, "ok", 0);
done:
  ps_close(&h, &r);
  ps_path_free(&p);
  return ps_make_result(env, &r, FALSE, NULL, 0);
}

static napi_value ps_create_private_file_exclusive(napi_env env, napi_callback_info info) {
  size_t argc = 2, nbytes = 0;
  napi_value argv[2];
  ps_result r;
  ps_path p = {NULL, 0};
  ps_sid user;
  ps_private_sd psd;
  SECURITY_ATTRIBUTES sa;
  HANDLE h = INVALID_HANDLE_VALUE;
  const BYTE *src = NULL;
  DWORD err;
  ps_init(&r, 0);
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    ps_set(&r, PS_UNAVAILABLE, "invalid_argument", 0);
    goto done;
  }
  if (!ps_read_bytes(env, argv[1], &src, &nbytes, &r)) goto done;
  if (!ps_read_path(env, argv[0], &p, &r)) goto done;
  if (!ps_token_user(&user, &r)) goto done;
  if (!ps_build_private_sd(&psd, &user.sid, FALSE, &r)) goto done;
  if (!ps_walk_ancestors(&p, &r)) goto done;
  sa.nLength = (DWORD)sizeof(sa);
  sa.lpSecurityDescriptor = &psd.sd;
  sa.bInheritHandle = FALSE;
  h = CreateFileW(p.buf, GENERIC_READ | GENERIC_WRITE, 0, &sa, CREATE_NEW,
                  FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (h == INVALID_HANDLE_VALUE) {
    err = GetLastError();
    if (err == ERROR_FILE_EXISTS || err == ERROR_ALREADY_EXISTS) {
      ps_set(&r, PS_EXISTS, "already_exists", err);
    } else {
      ps_fail_open(&r, err, "create_failed");
    }
    goto done;
  }
  r.created = 1;
  /* Verified on the creating handle before any byte is written. */
  if (!ps_verify_handle(h, &p, &user.sid, FALSE, &r)) goto done;
  if (!ps_write_all(h, src, nbytes, &r)) goto done;
  ps_set(&r, PS_OK, "ok", 0);
done:
  ps_close(&h, &r);
  ps_path_free(&p);
  return ps_make_result(env, &r, FALSE, NULL, 0);
}

static napi_value ps_register(napi_env env, napi_value exports) {
  static const struct {
    const char *name;
    napi_callback cb;
  } fns[] = {
    {"inspectDir", ps_inspect_dir},
    {"readPrivateFile", ps_read_private_file},
    {"createPrivateDir", ps_create_private_dir},
    {"createPrivateFileExclusive", ps_create_private_file_exclusive},
  };
  size_t i;
  napi_value fn;
  for (i = 0; i < sizeof(fns) / sizeof(fns[0]); i++) {
    if (napi_create_function(env, fns[i].name, NAPI_AUTO_LENGTH, fns[i].cb, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, fns[i].name, fn) != napi_ok) {
      return NULL;
    }
  }
  if (!ps_set_string(env, exports, "abi", PS_ABI_TAG)) return NULL;
  return exports;
}

NAPI_MODULE(private_storage, ps_register)
