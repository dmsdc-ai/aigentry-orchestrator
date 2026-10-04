# setup-fixtures.ps1 - #1167 Windows private-storage ACL prototype, test-only.
# Dot-sourced by run-validation.ps1 on a DISPOSABLE CI runner (elevated). It creates two fake standard
# local accounts, fake-data fixtures under one fixture root in RUNNER_TEMP, FAT32/exFAT virtual disks
# under RUNNER_TEMP, and provides the admin-side INDEPENDENT oracle (raw Win32 SDDL / attributes / link
# count / volume flags / content sha256 read with SeBackupPrivilege on a backup-semantics handle).
# It never loads or calls the product helper. It never writes, prints or logs a password.
# Every mutated path must pass Assert-PspOwnedPath. Cleanup removes only identities/resources it recorded.
# Windows PowerShell 5.1 syntax.

Set-StrictMode -Version 2.0

$script:PspOracleSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace Psp1167 {
  public class Snap {
    public string path; public int openError; public int infoError; public string sddl; public int sddlError;
    public uint attributes; public bool isDir; public bool isReparse; public uint nLinks; public long size;
    public string volumeSerial; public string fileIndex; public string fsName; public uint volumeFlags;
    public bool persistentAcls; public int volumeError; public string finalPath; public int finalPathError;
    public string sha256; public int readError; public bool ancestorReparse; public string ancestorReparsePath;
  }

  public class Removal {
    public int files; public int dirs; public int links; public int entries; public List<string> problems = new List<string>();
  }

  public static class Oracle {
    const uint READ_CONTROL = 0x00020000, FILE_READ_DATA = 0x1, FILE_READ_ATTRIBUTES = 0x80;
    const uint SHARE_ALL = 0x7, OPEN_EXISTING = 3;
    const uint FLAG_BACKUP = 0x02000000, FLAG_OPEN_REPARSE = 0x00200000;
    const uint ATTR_DIR = 0x10, ATTR_REPARSE = 0x400;
    static readonly IntPtr INVALID = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    struct BHFI { public uint attrs; public uint c1, c2, a1, a2, w1, w2; public uint volSerial, sizeHigh, sizeLow, nLinks, idxHigh, idxLow; }
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct TokPriv { public uint count; public long luid; public uint attrs; }
    [StructLayout(LayoutKind.Sequential)]
    struct SecAttr { public int len; public IntPtr sd; public bool inherit; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string p, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateDirectoryW(string p, ref SecAttr sa);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr h, out BHFI info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool GetVolumeInformationByHandleW(IntPtr h, StringBuilder vn, int vnl, out uint serial, out uint maxc, out uint flags, StringBuilder fs, int fsl);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder b, uint n, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint GetShortPathNameW(string l, StringBuilder s, uint n);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint GetLongPathNameW(string s, StringBuilder l, uint n);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint GetFileAttributesW(string p);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool GetVolumeInformationW(string root, StringBuilder vn, int vnl, out uint serial, out uint maxc, out uint flags, StringBuilder fs, int fsl);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(IntPtr h, byte[] buf, int n, out int read, IntPtr ov);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern uint GetSecurityInfo(IntPtr h, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint rev, uint info, out IntPtr str, out uint len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint rev, out IntPtr sd, out uint len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSidToSidW(string s, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint SetNamedSecurityInfoW(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint acc, out IntPtr t);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValueW(string sys, string name, out long luid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr t, bool disableAll, ref TokPriv n, int len, IntPtr prev, IntPtr ret);
    [StructLayout(LayoutKind.Sequential)]
    struct Disposition { public byte delete; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(IntPtr h, int cls, IntPtr buf, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(IntPtr h, int cls, ref Disposition info, uint size);
    const uint DELETE_ACCESS = 0x00010000, SYNCHRONIZE = 0x00100000;

    // Returns 0 when enabled; 1300 (ERROR_NOT_ALL_ASSIGNED) when the token does not hold it.
    public static int EnablePrivilege(string name) {
      IntPtr tok;
      if (!OpenProcessToken(GetCurrentProcess(), 0x0020 | 0x0008, out tok)) return Marshal.GetLastWin32Error();
      try {
        TokPriv tp = new TokPriv(); tp.count = 1; tp.attrs = 0x2;
        if (!LookupPrivilegeValueW(null, name, out tp.luid)) return Marshal.GetLastWin32Error();
        if (!AdjustTokenPrivileges(tok, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) return Marshal.GetLastWin32Error();
        return Marshal.GetLastWin32Error();
      } finally { CloseHandle(tok); }
    }

    public static string ShortPath(string p) { StringBuilder sb = new StringBuilder(1024); uint n = GetShortPathNameW(p, sb, 1024); return (n == 0 || n >= 1024) ? null : sb.ToString(); }
    public static string LongPath(string p) { StringBuilder sb = new StringBuilder(1024); uint n = GetLongPathNameW(p, sb, 1024); return (n == 0 || n >= 1024) ? null : sb.ToString(); }

    public static uint VolumeFlags(string root) {
      StringBuilder vn = new StringBuilder(261); StringBuilder fs = new StringBuilder(261); uint serial, maxc, flags;
      return GetVolumeInformationW(root, vn, 261, out serial, out maxc, out flags, fs, 261) ? flags : 0xFFFFFFFF;
    }

    // DACL only. sddl "D:NO_ACCESS_CONTROL" yields a NULL DACL (SetNamedSecurityInfo with a NULL pointer).
    public static int SetDaclFromSddl(string path, string sddl, bool protect) {
      IntPtr sd; uint len;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out len)) return Marshal.GetLastWin32Error();
      try {
        bool present, defaulted; IntPtr dacl;
        if (!GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted)) return Marshal.GetLastWin32Error();
        if (!present) return 87;
        uint info = 0x4 | (protect ? 0x80000000u : 0x20000000u);
        return (int)SetNamedSecurityInfoW(path, 1, info, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
      } finally { LocalFree(sd); }
    }

    // Owner only; needs SeRestorePrivilege enabled when the SID is not the caller.
    public static int SetOwner(string path, string sidString) {
      IntPtr sid;
      if (!ConvertStringSidToSidW(sidString, out sid)) return Marshal.GetLastWin32Error();
      try { return (int)SetNamedSecurityInfoW(path, 1, 0x1, sid, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero); }
      finally { LocalFree(sid); }
    }

    // Creates a NEW directory with its final descriptor applied at creation (no inherited window).
    // ERROR_ALREADY_EXISTS (183) when the name exists: an existing object is never adopted.
    public static int CreateProtectedDir(string path, string sddl) {
      IntPtr sd; uint len;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out len)) return Marshal.GetLastWin32Error();
      try {
        SecAttr sa = new SecAttr(); sa.len = Marshal.SizeOf(typeof(SecAttr)); sa.sd = sd; sa.inherit = false;
        return CreateDirectoryW(path, ref sa) ? 0 : Marshal.GetLastWin32Error();
      } finally { LocalFree(sd); }
    }

    // Stable capture of an untrusted outbox file into a NEW trusted file: the leaf is not followed, share READ
    // only (a live writer => 32), and the bytes come from that one handle. -2 dir/reparse/nLinks!=1,
    // -3 larger than max, -4 size changed during the read, -5 destination exists or cannot be written.
    public static int Capture(string src, string dst, long max) {
      IntPtr h = CreateFileW(src, FILE_READ_DATA | FILE_READ_ATTRIBUTES, 0x1, IntPtr.Zero, OPEN_EXISTING, FLAG_OPEN_REPARSE, IntPtr.Zero);
      if (h == INVALID) return Marshal.GetLastWin32Error();
      try {
        BHFI fi;
        if (!GetFileInformationByHandle(h, out fi)) return Marshal.GetLastWin32Error();
        if ((fi.attrs & (ATTR_DIR | ATTR_REPARSE)) != 0 || fi.nLinks != 1) return -2;
        long size = ((long)fi.sizeHigh << 32) | fi.sizeLow;
        if (size > max) return -3;
        using (MemoryStream ms = new MemoryStream()) {
          byte[] b = new byte[65536]; int r;
          while (true) {
            if (!ReadFile(h, b, b.Length, out r, IntPtr.Zero)) return Marshal.GetLastWin32Error();
            if (r == 0) break;
            ms.Write(b, 0, r);
            if (ms.Length > max) return -3;
          }
          if (ms.Length != size) return -4;
          using (FileStream fs = new FileStream(dst, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { ms.WriteTo(fs); }
        }
        return 0;
      } catch (IOException) { return -5; } finally { CloseHandle(h); }
    }

    // ---- cleanup deletion: no owner/DACL change, no link following, handle-bound identity ----
    // Backup semantics (SeBackup/SeRestore enabled by the caller) grant list/DELETE without touching any ACL.
    // No FILE_SHARE_DELETE: a held entry cannot be renamed or replaced underneath the walk.
    static IntPtr OpenForRemoval(string p, uint share) {
      return CreateFileW(p, DELETE_ACCESS | FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, share, IntPtr.Zero, OPEN_EXISTING, FLAG_BACKUP | FLAG_OPEN_REPARSE, IntPtr.Zero);
    }
    static int MarkDelete(IntPtr h) {
      Disposition d = new Disposition(); d.delete = 1;
      return SetFileInformationByHandle(h, 4, ref d, 1) ? 0 : Marshal.GetLastWin32Error();
    }
    // Names of one directory, read through its already-verified handle (FileFullDirectoryInfo); never a path re-walk.
    static List<string> ListNames(IntPtr dir, out int err) {
      List<string> names = new List<string>(); err = 0;
      IntPtr buf = Marshal.AllocHGlobal(65536);
      try {
        int cls = 15;
        while (true) {
          if (!GetFileInformationByHandleEx(dir, cls, buf, 65536)) { int e = Marshal.GetLastWin32Error(); if (e != 18) err = e; break; }
          cls = 14;
          int off = 0;
          while (true) {
            IntPtr ent = IntPtr.Add(buf, off);
            int next = Marshal.ReadInt32(ent, 0), len = Marshal.ReadInt32(ent, 60);
            string n = Marshal.PtrToStringUni(IntPtr.Add(ent, 68), len / 2);
            if (n != "." && n != "..") names.Add(n);
            if (next == 0) break;
            off += next;
          }
        }
      } finally { Marshal.FreeHGlobal(buf); }
      return names;
    }

    // The one deliberate hardlink fixture: both names must still be the same file (volume + file index) with
    // exactly these two links before the first name goes, and the survivor must be that file with one link.
    // null = removed or both absent; a single remaining name is left to RemoveTree (which refuses nLinks != 1).
    public static string RemoveLinkPair(string a, string b) {
      IntPtr ha = OpenForRemoval(a, SHARE_ALL); int ea = (ha == INVALID) ? Marshal.GetLastWin32Error() : 0;
      IntPtr hb = OpenForRemoval(b, SHARE_ALL); int eb = (hb == INVALID) ? Marshal.GetLastWin32Error() : 0;
      try {
        if ((ea != 0 && ea != 2) || (eb != 0 && eb != 2)) return "link pair open " + ea + "/" + eb;
        if (ea == 2 || eb == 2) return null;
        BHFI fa, fb;
        if (!GetFileInformationByHandle(ha, out fa) || !GetFileInformationByHandle(hb, out fb)) return "link pair info " + Marshal.GetLastWin32Error();
        if (((fa.attrs | fb.attrs) & (ATTR_DIR | ATTR_REPARSE)) != 0 || fa.volSerial != fb.volSerial || fa.idxHigh != fb.idxHigh || fa.idxLow != fb.idxLow || fa.nLinks != 2 || fb.nLinks != 2)
          return "link pair identity changed (left in place)";
        CloseHandle(hb); hb = INVALID;
        int e = MarkDelete(ha); CloseHandle(ha); ha = INVALID;
        if (e != 0) return "delete " + a + ": " + e;
        hb = OpenForRemoval(b, SHARE_ALL);
        if (hb == INVALID) return "reopen " + b + ": " + Marshal.GetLastWin32Error();
        BHFI f2;
        if (!GetFileInformationByHandle(hb, out f2) || f2.volSerial != fa.volSerial || f2.idxHigh != fa.idxHigh || f2.idxLow != fa.idxLow || f2.nLinks != 1 || (f2.attrs & (ATTR_DIR | ATTR_REPARSE)) != 0)
          return "link pair survivor identity changed (left in place)";
        e = MarkDelete(hb);
        return (e != 0) ? "delete " + b + ": " + e : null;
      } finally { if (ha != INVALID) CloseHandle(ha); if (hb != INVALID) CloseHandle(hb); }
    }

    // Deletes one owned directory tree. Reparse points are deleted as links and never entered; other volumes and
    // multi-link files are refused and left in place; a directory goes only once empty. Any problem leaves the
    // root in place (explicit cleanup failure, never claimed clean).
    public static Removal RemoveTree(string root, int maxDepth, int maxEntries) {
      Removal r = new Removal();
      IntPtr h = OpenForRemoval(root, 0x3);
      if (h == INVALID) { r.problems.Add("open " + root + ": " + Marshal.GetLastWin32Error()); return r; }
      try {
        BHFI fi;
        if (!GetFileInformationByHandle(h, out fi)) { r.problems.Add("info " + root + ": " + Marshal.GetLastWin32Error()); return r; }
        if ((fi.attrs & ATTR_REPARSE) != 0 || (fi.attrs & ATTR_DIR) == 0) { r.problems.Add("root is not a plain directory"); return r; }
        Walk(h, root, fi.volSerial, 0, maxDepth, maxEntries, r);
        if (r.problems.Count == 0) { int e = MarkDelete(h); if (e != 0) r.problems.Add("delete " + root + ": " + e); else r.dirs++; }
      } finally { CloseHandle(h); }
      return r;
    }

    static void Walk(IntPtr dir, string path, uint vol, int depth, int maxDepth, int maxEntries, Removal r) {
      if (depth >= maxDepth) { r.problems.Add("depth cap at " + path); return; }
      int err; List<string> names = ListNames(dir, out err);
      if (err != 0) { r.problems.Add("list " + path + ": " + err); return; }
      foreach (string n in names) {
        if (++r.entries > maxEntries) { r.problems.Add("entry cap at " + path); return; }
        string p = path + "\\" + n;
        IntPtr h = OpenForRemoval(p, 0x3);
        if (h == INVALID) { r.problems.Add("open " + p + ": " + Marshal.GetLastWin32Error()); continue; }
        try {
          BHFI fi;
          if (!GetFileInformationByHandle(h, out fi)) { r.problems.Add("info " + p + ": " + Marshal.GetLastWin32Error()); continue; }
          if (fi.volSerial != vol) { r.problems.Add("other volume (left in place) " + p); continue; }
          bool reparse = (fi.attrs & ATTR_REPARSE) != 0, isDir = (fi.attrs & ATTR_DIR) != 0;
          if (!reparse && isDir) { int before = r.problems.Count; Walk(h, p, vol, depth + 1, maxDepth, maxEntries, r); if (r.problems.Count != before) continue; }
          else if (!reparse && fi.nLinks != 1) { r.problems.Add("multi-link file (left in place, nLinks " + fi.nLinks + ") " + p); continue; }
          int e = MarkDelete(h);
          if (e != 0) r.problems.Add("delete " + p + ": " + e);
          else if (reparse) r.links++; else if (isDir) r.dirs++; else r.files++;
        } finally { CloseHandle(h); }
      }
    }

    // One backup-semantics handle, leaf not followed; every fact below is read on that handle.
    public static Snap Take(string path, string ancestorFloor) {
      Snap s = new Snap(); s.path = path;
      if (ancestorFloor != null && path.StartsWith(ancestorFloor + "\\", StringComparison.OrdinalIgnoreCase)) {
        string[] parts = path.Substring(ancestorFloor.Length + 1).Split('\\');
        string cur = ancestorFloor;
        for (int i = 0; i < parts.Length - 1; i++) {
          cur = cur + "\\" + parts[i];
          uint a = GetFileAttributesW(cur);
          if (a != 0xFFFFFFFF && (a & ATTR_REPARSE) != 0) { s.ancestorReparse = true; s.ancestorReparsePath = cur; break; }
        }
      }
      IntPtr h = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_READ_DATA, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FLAG_BACKUP | FLAG_OPEN_REPARSE, IntPtr.Zero);
      if (h == INVALID) { s.openError = Marshal.GetLastWin32Error(); return s; }
      try {
        BHFI fi;
        if (GetFileInformationByHandle(h, out fi)) {
          s.attributes = fi.attrs; s.isDir = (fi.attrs & ATTR_DIR) != 0; s.isReparse = (fi.attrs & ATTR_REPARSE) != 0;
          s.nLinks = fi.nLinks; s.volumeSerial = fi.volSerial.ToString("X8");
          s.fileIndex = (((ulong)fi.idxHigh << 32) | fi.idxLow).ToString("X16");
          s.size = ((long)fi.sizeHigh << 32) | fi.sizeLow;
        } else { s.infoError = Marshal.GetLastWin32Error(); }
        StringBuilder vn = new StringBuilder(261); StringBuilder fs = new StringBuilder(261); uint serial, maxc, flags;
        if (GetVolumeInformationByHandleW(h, vn, 261, out serial, out maxc, out flags, fs, 261)) {
          s.fsName = fs.ToString(); s.volumeFlags = flags; s.persistentAcls = (flags & 0x8) != 0;
        } else { s.volumeError = Marshal.GetLastWin32Error(); }
        StringBuilder fp = new StringBuilder(32768);
        uint n = GetFinalPathNameByHandleW(h, fp, 32768, 0);
        if (n == 0 || n >= 32768) s.finalPathError = Marshal.GetLastWin32Error(); else s.finalPath = fp.ToString();
        IntPtr o, g, d, sa, sd;
        uint err = GetSecurityInfo(h, 1, 0x7, out o, out g, out d, out sa, out sd);
        if (err != 0) { s.sddlError = (int)err; }
        else {
          try {
            IntPtr str; uint len;
            if (ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 0x7, out str, out len)) { s.sddl = Marshal.PtrToStringUni(str); LocalFree(str); }
            else { s.sddlError = Marshal.GetLastWin32Error(); }
          } finally { LocalFree(sd); }
        }
        if (s.infoError == 0 && !s.isDir && !s.isReparse) {
          using (SHA256 sha = SHA256.Create()) {
            byte[] buf = new byte[65536]; int r;
            while (true) {
              if (!ReadFile(h, buf, buf.Length, out r, IntPtr.Zero)) { s.readError = Marshal.GetLastWin32Error(); break; }
              if (r == 0) break;
              sha.TransformBlock(buf, 0, r, null, 0);
            }
            if (s.readError == 0) { sha.TransformFinalBlock(new byte[0], 0, 0); s.sha256 = BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant(); }
          }
        }
      } finally { CloseHandle(h); }
      return s;
    }
  }
}
'@
if (-not ('Psp1167.Oracle' -as [type])) { Add-Type -TypeDefinition $script:PspOracleSource -Language CSharp -IgnoreWarnings }

$script:PspSidAdmins = 'S-1-5-32-544'
$script:PspSidSystem = 'S-1-5-18'
$script:PspSidUsers = 'S-1-5-32-545'
$script:PspOwnedRoots = New-Object System.Collections.ArrayList
$script:PspLog = New-Object System.Collections.ArrayList

function Add-PspLog { param([string]$Step, [string]$Detail, $Code)
  [void]$script:PspLog.Add([ordered]@{ t = (Get-Date).ToUniversalTime().ToString('o'); step = $Step; detail = $Detail; code = $Code })
}

function Register-PspOwnedRoot { param([string]$Root) [void]$script:PspOwnedRoots.Add($Root.TrimEnd('\')) }

# Every path this harness mutates must be the fixture root, inside it, or inside a registered owned VHD root.
function Assert-PspOwnedPath { param([string]$Path)
  if ([string]::IsNullOrEmpty($Path)) { throw 'owned-path guard: empty path' }
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  foreach ($r in $script:PspOwnedRoots) {
    if ($full.Equals($r, [StringComparison]::OrdinalIgnoreCase)) { return $full }
    if ($full.StartsWith($r + '\', [StringComparison]::OrdinalIgnoreCase)) { return $full }
  }
  throw "owned-path guard: $Path is outside every owned root"
}

function Save-PspState { param($State, [string]$StatePath)
  ($State | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

function Get-PspTempLong {
  $t = [Psp1167.Oracle]::LongPath([System.IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\'))
  if (-not $t) { throw 'cannot resolve the long form of RUNNER_TEMP' }
  return $t
}

# ---- trusted root (state, oracle receipts, scratch, elevated harness copies) ----
# Created NEW with its final protected SYSTEM+Administrators-only descriptor and read back BEFORE any fake
# account or lower-privileged process exists. A/B inputs/outputs stay in their own work dirs (outboxes);
# the admin side captures them into the trusted root. Twin rule: acl.test.mjs trustProblems.
$script:PspTrustSddl = 'O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$script:PspTrustFiles = @('acl.test.mjs', 'setup-fixtures.ps1', 'run-as-user.ps1', 'run-validation.ps1')
$script:PspRightBits = @{ GA = 0x10000000; GR = 2147483648; GW = 0x40000000; GX = 0x20000000; FA = 0x1F01FF; FR = 0x120089; FW = 0x120116; FX = 0x1200A0
  RC = 0x20000; SD = 0x10000; WD = 0x40000; WO = 0x80000; CC = 0x1; DC = 0x2; LC = 0x4; SW = 0x8; RP = 0x10; WP = 0x20; DT = 0x40; LO = 0x80; CR = 0x100 }
# write data/append/EA/attributes, delete child, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_WRITE, GENERIC_ALL
$script:PspWriteBits = [long](0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000)

function ConvertTo-PspSid { param([string]$S)
  switch -CaseSensitive ($S) { 'BA' { return 'S-1-5-32-544' } 'SY' { return 'S-1-5-18' } default { return $S } }
}

function Test-PspReadOnlyRights { param([string]$Rights)
  [long]$mask = 0
  if ($Rights -cmatch '^0x[0-9a-fA-F]+$') { $mask = [Convert]::ToInt64($Rights.Substring(2), 16) }
  elseif ($Rights -cmatch '^([A-Z]{2})+$') {
    for ($i = 0; $i -lt $Rights.Length; $i += 2) {
      $t = $Rights.Substring($i, 2)
      if (-not $script:PspRightBits.ContainsKey($t)) { return $false }
      $mask = $mask -bor [long]$script:PspRightBits[$t]
    }
  } else { return $false }
  return (($mask -band $script:PspWriteBits) -eq 0)
}

# Problems (empty = trusted): owner listed; DACL present and non-NULL (protected when asked); only allow/deny
# ACEs; every allow ACE is SYSTEM/Administrators or a listed reader without any write/delete/DAC/owner bit.
function Test-PspTrustedSddl { param([string]$Sddl, [string[]]$Owners, [string[]]$Readers = @(), [switch]$Protected)
  if ([string]::IsNullOrEmpty($Sddl) -or -not ($Sddl -cmatch '^O:([^:()]+?)(G:[^:()]+?)?D:([A-Z_]*)((\([^()]*\))*)$')) { return @('sddl-unparsed') }
  $owner = ConvertTo-PspSid $Matches[1]; $flags = $Matches[3]; $aceText = $Matches[4]
  $p = @()
  if ($Owners -cnotcontains $owner) { $p += "owner:$owner" }
  if ($flags -cmatch 'NO_ACCESS_CONTROL') { $p += 'null-dacl' }
  if ($Protected -and ($flags -cnotmatch '^P')) { $p += 'not-protected' }
  $allow = 0
  foreach ($m in [regex]::Matches($aceText, '\(([^()]*)\)')) {
    $f = $m.Groups[1].Value.Split(';')
    if ($f.Count -ne 6) { $p += "ace-shape:$($m.Value)"; continue }
    if ($f[0] -ceq 'D') { continue }
    if ($f[0] -cne 'A') { $p += "ace-type:$($f[0])"; continue }
    $allow++
    $sid = ConvertTo-PspSid $f[5]
    if (@($script:PspSidAdmins, $script:PspSidSystem) -ccontains $sid) { continue }
    if (($Readers -ccontains $sid) -and (Test-PspReadOnlyRights $f[2])) { continue }
    $p += "foreign-allow:${sid}:$($f[2])"
  }
  if ($allow -eq 0) { $p += 'no-allow-ace' }
  return $p
}

# Readback of one trusted object: the backup-handle oracle and Get-Acl must agree, and both pass the rule.
function Test-PspTrustedObject { param([string]$Path, [string[]]$Owners, [string[]]$Readers = @(), [switch]$Protected)
  $s = [Psp1167.Oracle]::Take($Path, $null)
  $g = $null; try { $g = (Get-Acl -LiteralPath $Path -ErrorAction Stop).Sddl } catch { $g = $null }
  $p = @()
  if ($s.openError -ne 0) { $p += "open-error:$($s.openError)" }
  if ($s.isReparse) { $p += 'reparse' }
  if (-not $s.persistentAcls) { $p += 'non-acl-volume' }
  $p += @(Test-PspTrustedSddl $s.sddl $Owners $Readers -Protected:$Protected)
  if ($null -eq $g) { $p += 'getacl-unavailable' } elseif ($g -cne $s.sddl) { $p += 'readback-contradiction' }
  return [ordered]@{ path = $Path; sddl = $s.sddl; getAclSddl = $g; problems = @($p) }
}

function Get-PspTrustObjects { param($T)
  $o = @($T.root, $T.state, $T.receipts, $T.scratch, $T.src, $T.canary) + @($script:PspTrustFiles | ForEach-Object { Join-Path $T.src $_ })
  foreach ($x in @($T.statePath, (Join-Path $T.src 'node.exe'))) { if (Test-Path -LiteralPath $x) { $o += $x } }
  return $o
}

function Get-PspTrustReadback { param($T, [string]$AdminSid)
  foreach ($p in Get-PspTrustObjects $T) {
    if ($p -ceq $T.root) { Test-PspTrustedObject $p @($script:PspSidAdmins) -Protected }
    else { Test-PspTrustedObject $p @($script:PspSidAdmins, $script:PspSidSystem, $AdminSid) }
  }
}

function Get-PspTrustLayout { param([string]$Root)
  return [ordered]@{ root = $Root; state = (Join-Path $Root 'state'); statePath = (Join-Path $Root 'state\state.json'); receipts = (Join-Path $Root 'receipts')
    canary = (Join-Path $Root 'receipts\trust-canary.json'); scratch = (Join-Path $Root 'scratch'); src = (Join-Path $Root 'src') }
}

# $Leaf is the name the workflow bound before any fake account existed; later steps use only that name.
function Initialize-PspTrustRoot { param([string]$TempLong, [string]$SourceDir, [string]$AdminSid, [string]$Leaf)
  if ($Leaf -cnotmatch '^psp1167-trust-[0-9a-f]{16}$') { throw "trust root name not bound by the workflow: '$Leaf'" }
  $root = Join-Path $TempLong $Leaf
  $e = [Psp1167.Oracle]::CreateProtectedDir($root, $script:PspTrustSddl)
  if ($e -ne 0) { throw "trust root $root not created (Win32 $e)" }
  Register-PspOwnedRoot $root
  $t = Get-PspTrustLayout $root
  foreach ($d in @($t.state, $t.receipts, $t.scratch, $t.src)) { [void](New-PspDir $d) }
  $t.srcSha256 = [ordered]@{}
  foreach ($f in $script:PspTrustFiles) {
    $to = Join-Path $t.src $f
    Copy-Item -LiteralPath (Join-Path $SourceDir $f) -Destination $to
    $h = (Get-FileHash -LiteralPath (Join-Path $SourceDir $f) -Algorithm SHA256).Hash.ToLowerInvariant()
    $t.srcSha256[$f] = (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($t.srcSha256[$f] -ne $h) { throw "trusted copy of $f differs from the pinned source" }
  }
  [System.IO.File]::WriteAllText($t.canary, 'psp1167 trust canary: fake-user write probes target this file')
  $t.readback = @(Get-PspTrustReadback $t $AdminSid)
  $bad = @($t.readback | Where-Object { $_.problems.Count -gt 0 } | ForEach-Object { "$($_.path)=$($_.problems -join ',')" })
  if ($bad.Count -gt 0) { throw ('trust root readback failed: ' + ($bad -join '; ')) }
  return $t
}

# Copies one untrusted outbox file into the trusted receipts dir (see Oracle.Capture); throws on refusal.
function Copy-PspCapture { param([string]$Source, [string]$Dest, [long]$Max = 16MB)
  $e = [Psp1167.Oracle]::Capture($Source, $Dest, $Max)
  if ($e -ne 0) { throw "capture of $Source refused ($e)" }
}

# ---- cleanup state validation ----
# Every rule holds BEFORE any destructive action; one violation refuses the whole cleanup (no normalisation,
# no partial delete). Twin: acl.test.mjs validateCleanupState (same literals; coupling checked offline).
function Get-PspKeys { param($O)
  if ($O -is [System.Collections.IDictionary]) { return @($O.Keys) }
  return @($O.PSObject.Properties | ForEach-Object { $_.Name })
}

function Test-PspCleanupState { param($State, [string]$TempLong, [string]$RunId)
  if ($null -eq $State) { return @('state-null') }
  if ($RunId -cnotmatch '^\d+$') { return @('run-id') }
  if (((@(Get-PspKeys $State) | Sort-Object) -join ',') -cne 'root,schema,users,vdisks') { return @('state-keys') }
  $p = @()
  if ($State.schema -cne 'aigentry/1167-psp-state/v1') { $p += 'schema' }
  $root = $State.root
  if ($null -ne $root) {
    if (-not ($root -is [string])) { $p += 'root-type'; $root = $null }
    else {
      $i = $root.LastIndexOf('\')
      if ($i -lt 0 -or $root.Substring($i + 1) -cnotmatch "^psp1167-$RunId-[0-9a-f]{8}$") { $p += 'root-leaf' }
      if ($i -lt 0 -or $root.Substring(0, $i) -cne $TempLong) { $p += 'root-parent' }
      $full = $null; try { $full = [System.IO.Path]::GetFullPath($root) } catch { $full = $null }
      if ($full -cne $root) { $p += 'root-not-canonical' }
      if (($p.Count -eq 0) -and (Test-Path -LiteralPath $root) -and (((Get-Item -LiteralPath $root -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { $p += 'root-reparse' }
    }
  }
  $us = @($State.users)
  if (-not ($State.users -is [array])) { $p += 'users-type' }
  if ($us.Count -gt 2) { $p += 'users-count' }
  $first = $null
  for ($i = 0; $i -lt [Math]::Min($us.Count, 2); $i++) {
    $u = $us[$i]
    if (($null -eq $u) -or (((@(Get-PspKeys $u) | Sort-Object) -join ',') -cne 'name,sid')) { $p += "user$i-shape"; continue }
    if (-not ($u.name -is [string]) -or ($u.name -cnotmatch '^psp[ab][0-9a-f]{6}$') -or ($u.name.Substring(0, 4) -cne @('pspa', 'pspb')[$i])) { $p += "user$i-name"; continue }
    if (-not ($u.sid -is [string]) -or ($u.sid -cnotmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') -or ([long]$u.sid.Substring($u.sid.LastIndexOf('-') + 1) -lt 1000)) { $p += "user$i-sid"; continue }
    if ($i -eq 0) { $first = $u }
    elseif ($null -ne $first) {
      if ($u.name.Substring(4) -cne $first.name.Substring(4)) { $p += 'user-pair-suffix' }
      if ($u.sid.Substring(0, $u.sid.LastIndexOf('-')) -cne $first.sid.Substring(0, $first.sid.LastIndexOf('-'))) { $p += 'user-pair-domain' }
      if ($u.sid -ceq $first.sid) { $p += 'user-pair-sid' }
    }
  }
  $vs = @($State.vdisks); $seen = @()
  if (-not ($State.vdisks -is [array])) { $p += 'vdisks-type' }
  if ($vs.Count -gt 2) { $p += 'vdisks-count' }
  foreach ($v in $vs) {
    if (($null -eq $v) -or (((@(Get-PspKeys $v) | Sort-Object) -join ',') -cne 'attached,file,fs,letter')) { $p += 'vdisk-shape'; continue }
    if (@('fat32', 'exfat') -cnotcontains $v.fs) { $p += 'vdisk-fs'; continue }
    if ($seen -ccontains $v.fs) { $p += 'vdisk-duplicate' }
    $seen += $v.fs
    if (($null -eq $root) -or ($v.file -cne ($root + '\vhd-' + $v.fs + '.vhdx'))) { $p += "vdisk-file:$($v.fs)" }
    if (-not ($v.letter -is [string]) -or ($v.letter -cnotmatch '^[P-Y]$')) { $p += 'vdisk-letter' }
  }
  return $p
}

# 28 chars from a CSPRNG plus one of each class. Returned only as a read-only SecureString.
function New-PspPassword {
  $sets = @('ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%+=?-_')
  $all = -join $sets
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 32
  $rng.GetBytes($bytes)
  $ss = New-Object System.Security.SecureString
  for ($i = 0; $i -lt 28; $i++) { $ss.AppendChar($all[$bytes[$i] % $all.Length]) }
  for ($i = 0; $i -lt 4; $i++) { $ss.AppendChar($sets[$i][$bytes[28 + $i] % $sets[$i].Length]) }
  $rng.Dispose()
  $ss.MakeReadOnly()
  return ,$ss
}

# Creates one NEW standard local account. Refuses if the name exists (no existing account is modified).
# The state file gets name+SID before anything else so cleanup can find it; never the password.
function New-PspFakeUser { param([string]$Name, [System.Security.SecureString]$Password, $State, [string]$StatePath)
  if (Get-LocalUser -Name $Name -ErrorAction SilentlyContinue) { throw "refusing: local account $Name already exists" }
  $u = New-LocalUser -Name $Name -Password $Password -Description 'psp1167 disposable CI fake user' -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword
  $rec = [ordered]@{ name = $Name; sid = $u.SID.Value }
  $State.users += ,$rec
  Save-PspState $State $StatePath
  try { Add-LocalGroupMember -SID $script:PspSidUsers -Member $u -ErrorAction Stop; Add-PspLog 'users-group' $Name 0 }
  catch { if ($_.FullyQualifiedErrorId -like 'MemberExists*') { Add-PspLog 'users-group' "$Name already member" 0 } else { throw } }
  return $rec
}

function Remove-PspFakeUsers { param($State)
  $results = @()
  foreach ($u in @($State.users)) {
    $r = [ordered]@{ name = $u.name; sid = $u.sid; removed = $false; profileRemoved = $null; error = $null }
    try {
      if (($u.name -cnotmatch '^psp[ab][0-9a-f]{6}$') -or ($u.sid -cnotmatch '^S-1-5-21-\d+-\d+-\d+-\d+$')) { throw "refusing unowned account $($u.name) $($u.sid)" }
      $live = Get-LocalUser -SID $u.sid -ErrorAction SilentlyContinue
      if ($null -eq $live) { $r.error = 'not-present' }
      elseif ($live.Name -cne $u.name) { $r.error = "sid-name-mismatch:$($live.Name)"; }
      elseif ($live.Description -cne 'psp1167 disposable CI fake user') { $r.error = 'description-mismatch' }
      else { Remove-LocalUser -SID $u.sid -ErrorAction Stop; $r.removed = $true }
      if (($null -eq $r.error) -or ($r.error -eq 'not-present')) {
        $prof = Get-CimInstance -ClassName Win32_UserProfile -Filter ("SID='{0}'" -f $u.sid) -ErrorAction SilentlyContinue
        if ($prof) { $prof | Remove-CimInstance -ErrorAction Stop; $r.profileRemoved = $true } else { $r.profileRemoved = $false }
      }
    } catch { $r.error = $_.Exception.Message }
    $results += ,$r
  }
  return $results
}

function Invoke-PspNative { param([string]$Step, [string]$Exe, [string[]]$Arguments, [switch]$AllowFail)
  $ErrorActionPreference = 'Continue'   # PS 5.1: native stderr under 2>&1 must be captured, not thrown
  $out = & $Exe @Arguments 2>&1 | Out-String
  $code = $LASTEXITCODE
  Add-PspLog $Step (($Exe + ' ' + ($Arguments -join ' ')) + ' => ' + $out.Trim()) $code
  if (($code -ne 0) -and (-not $AllowFail)) { throw "$Step failed ($code): $($out.Trim())" }
  return [ordered]@{ code = $code; output = $out.Trim() }
}

function Set-PspOwner { param([string]$Path, [string]$Sid)
  $p = Assert-PspOwnedPath $Path
  $r = Invoke-PspNative 'setowner-icacls' 'icacls.exe' @($p, '/setowner', "*$Sid", '/L', '/Q') -AllowFail
  if ($r.code -ne 0) {
    $e = [Psp1167.Oracle]::SetOwner($p, $Sid)
    Add-PspLog 'setowner-fallback-SetNamedSecurityInfo' $p $e
    if ($e -ne 0) { throw "set owner $Sid on $p failed: icacls $($r.code), SetNamedSecurityInfo $e" }
  }
}

function Set-PspGrantOnly { param([string]$Path, [string[]]$Grants)
  $p = Assert-PspOwnedPath $Path
  [void](Invoke-PspNative 'grant-protected' 'icacls.exe' (@($p, '/inheritance:r', '/grant:r') + $Grants + @('/Q')))
}

function Set-PspDaclSddl { param([string]$Path, [string]$Sddl)
  $p = Assert-PspOwnedPath $Path
  $e = [Psp1167.Oracle]::SetDaclFromSddl($p, $Sddl, $true)
  Add-PspLog 'set-dacl-sddl' "$p <= $Sddl" $e
  if ($e -ne 0) { throw "SetDaclFromSddl $p failed: $e" }
}

function New-PspFile { param([string]$Path, [int]$Length = 96)
  $p = Assert-PspOwnedPath $Path
  $bytes = New-Object byte[] $Length
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()
  [System.IO.File]::WriteAllBytes($p, $bytes)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $h = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
  return $h
}

function New-PspDir { param([string]$Path)
  $p = Assert-PspOwnedPath $Path
  [void](New-Item -ItemType Directory -Path $p -ErrorAction Stop)
  return $p
}

function Get-PspFreeLetter {
  $used = @([System.IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name.Substring(0, 1).ToUpperInvariant() })
  foreach ($l in @('R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Q', 'P')) { if ($used -notcontains $l) { return $l } }
  throw 'no free drive letter for the owned VHD'
}

# Creates, attaches, formats and letters ONE new virtual disk file that this run owns. The only diskpart
# selection is `select vdisk file=<exact owned path>`; diskpart halts a script on the first error.
function New-PspVhd { param([string]$VhdPath, [string]$FileSystem, [string]$Label, $State, [string]$StatePath, [string]$ScratchDir)
  $vp = Assert-PspOwnedPath $VhdPath
  if (Test-Path -LiteralPath $vp) { throw "refusing: $vp already exists" }
  $letter = Get-PspFreeLetter
  $rec = [ordered]@{ file = $vp; letter = $letter; fs = $FileSystem; attached = $false }
  $State.vdisks += ,$rec
  Save-PspState $State $StatePath
  $script = Join-Path $ScratchDir ("diskpart-create-{0}.txt" -f $FileSystem)
  @(
    "create vdisk file=`"$vp`" maximum=64 type=expandable",
    "select vdisk file=`"$vp`"",
    'attach vdisk',
    'create partition primary',
    "format fs=$FileSystem quick label=$Label",
    "assign letter=$letter"
  ) | Set-Content -LiteralPath $script -Encoding ASCII
  $r = Invoke-PspNative "diskpart-create-$FileSystem" 'diskpart.exe' @('/s', $script) -AllowFail
  $rec.attached = $true
  Save-PspState $State $StatePath
  if ($r.code -ne 0) { throw "diskpart create $FileSystem failed ($($r.code))" }
  $root = "${letter}:\"
  if (-not (Test-Path -LiteralPath $root)) { throw "VHD $FileSystem letter $letter not visible" }
  $flags = [Psp1167.Oracle]::VolumeFlags($root)
  $fsinfo = Invoke-PspNative "fsutil-volumeinfo-$FileSystem" 'fsutil.exe' @('fsinfo', 'volumeinfo', "${letter}:") -AllowFail
  Register-PspOwnedRoot ("${letter}:\psp1167")
  return [ordered]@{ letter = $letter; root = "${letter}:\psp1167"; volumeFlags = $flags; persistentAcls = (($flags -ne [uint32]::MaxValue) -and (($flags -band 0x8) -ne 0)); fsutil = $fsinfo }
}

function Remove-PspVhds { param($State, [string]$ScratchDir, [string]$Root)
  $ErrorActionPreference = 'Continue'
  $results = @()
  foreach ($v in @($State.vdisks)) {
    $r = [ordered]@{ file = $v.file; detached = $false; deleted = $false; error = $null }
    try {
      if ((-not $Root) -or (@('fat32', 'exfat') -cnotcontains $v.fs) -or ($v.file -cne ($Root + '\vhd-' + $v.fs + '.vhdx'))) { throw "refusing unowned vdisk path $($v.file)" }
      if ((Test-Path -LiteralPath $v.file) -and (((Get-Item -LiteralPath $v.file -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "refusing reparse vdisk path $($v.file)" }
      if (Test-Path -LiteralPath $v.file) {
        $script = Join-Path $ScratchDir ('diskpart-detach-{0}.txt' -f [guid]::NewGuid().ToString('N'))
        @("select vdisk file=`"$($v.file)`"", 'detach vdisk') | Set-Content -LiteralPath $script -Encoding ASCII
        $d = & diskpart.exe /s $script 2>&1 | Out-String
        $r.detached = ($LASTEXITCODE -eq 0)
        Remove-Item -LiteralPath $v.file -Force -ErrorAction Stop
        $r.deleted = $true
      }
    } catch { $r.error = $_.Exception.Message }
    $results += ,$r
  }
  return $results
}

# Live processes owned by the given SIDs (fake users): any hit is a concurrent writer and refuses cleanup/export.
# Emits one flat 'PID:Name:SID' string per hit and nothing when there is none (callers wrap it in @()). A process
# whose owner cannot be established (enumeration error, owner query error, nonzero/missing/non-integer ReturnValue,
# missing or invalid SID) throws a fixed refusal: an unknown owner is never reported as "no live writer". A successful
# enumeration with no process is known-empty (0 hits). SID validity ignores case; matching stays exact-case.
# DIAGNOSTIC (host stream only, never pipeline output): right before the refusal, the FIRST unknown owner is written as
# one fixed line 'psp-diag owner-unknown cat=<closed enum> pid=<uint32|none> rv=<integer|none>', then one bounded count
# line over ALL enumerated rows 'psp-diag owner-unknown-counts rows=<n> hits=<n> <cat>=<n> ...' (row categories only).
# Never a name, command line, environment, SID or exception text. Every enumerated row is classified; the refusal is the
# one of the FIRST unknown, and no hit list is returned once any owner is unknown.
function Get-PspLiveSidProcesses { param([string[]]$Sids = @())
  if (@($Sids).Count -eq 0) { return }
  $hits = @()
  $ints = @('System.Byte', 'System.SByte', 'System.Int16', 'System.UInt16', 'System.Int32', 'System.UInt32', 'System.Int64', 'System.UInt64')
  $procs = $null; try { $procs = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) } catch { $procs = $null }
  if ($null -eq $procs) {
    Write-Host 'psp-diag owner-unknown cat=enumeration pid=none rv=none'
    throw 'refusing: process enumeration failed (live writer state unknown)'
  }
  $first = $null; $firstCat = $null; $rows = 0
  $n = [ordered]@{ 'query' = 0; 'shape' = 0; 'rv-missing' = 0; 'rv-type' = 0; 'rv-nonzero' = 0; 'sid-invalid' = 0 }
  foreach ($p in $procs) {
    $rows++
    $cat = $null; $rv = $null; $sid = $null
    $o = $null; try { $o = @(Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop) } catch { $o = $null }
    if ($null -eq $p) { $cat = 'shape' } elseif ($null -eq $o) { $cat = 'query' } elseif (($o.Count -ne 1) -or ($null -eq $o[0])) { $cat = 'shape' }
    if ($null -eq $cat) {
      try { $rv = $o[0].ReturnValue } catch { $rv = $null }
      if ($null -eq $rv) { $cat = 'rv-missing' } elseif ($ints -cnotcontains $rv.GetType().FullName) { $cat = 'rv-type' } elseif ($rv -ne 0) { $cat = 'rv-nonzero' }
    }
    if ($null -eq $cat) {
      try { $sid = $o[0].Sid } catch { $sid = $null }
      if (($sid -isnot [string]) -or ($sid -inotmatch '^S-1-[0-9]+(-[0-9]+)+\z')) { $cat = 'sid-invalid' }
    }
    if ($null -ne $cat) {
      $n[$cat]++
      if ($null -eq $first) {
        $pv = $null; try { $pv = $p.ProcessId } catch { $pv = $null }
        $dp = 'none'; if (($null -ne $pv) -and ($ints -ccontains $pv.GetType().FullName) -and ($pv -ge 0) -and ($pv -le [uint32]::MaxValue)) { $dp = [string]$pv }
        $dr = 'none'; if (@('rv-nonzero', 'sid-invalid') -ccontains $cat) { $dr = [string]$rv }
        if ($dp -cnotmatch '^[0-9]{1,10}\z') { $dp = 'none' }
        if ($dr -cnotmatch '^-?[0-9]{1,20}\z') { $dr = 'none' }
        $first = 'psp-diag owner-unknown cat=' + $cat + ' pid=' + $dp + ' rv=' + $dr; $firstCat = $cat
      }
      continue
    }
    if ($Sids -ccontains $sid) { $hits += [string]("$($p.ProcessId):$($p.Name):$sid") }
  }
  if ($null -ne $first) {
    Write-Host $first
    Write-Host ('psp-diag owner-unknown-counts rows=' + $rows + ' hits=' + @($hits).Count + ' query=' + $n['query'] + ' shape=' + $n['shape'] + ' rv-missing=' + $n['rv-missing'] + ' rv-type=' + $n['rv-type'] + ' rv-nonzero=' + $n['rv-nonzero'] + ' sid-invalid=' + $n['sid-invalid'])
    if (@('query', 'shape') -ccontains $firstCat) { throw 'refusing: process owner query failed (live writer state unknown)' }
    if ($firstCat -ceq 'sid-invalid') { throw 'refusing: process owner SID missing or invalid (live writer state unknown)' }
    throw 'refusing: process owner query returned a nonzero or missing ReturnValue (live writer state unknown)'
  }
  return $hits
}

# Deletes the owned fixture root without changing any owner or ACL and without following links (no icacls,
# no rmdir /s): refused while any fake-user process is alive (no concurrent writer); the deliberate hardlink
# pair goes only after identity verification; everything else through Oracle.RemoveTree. Anything it cannot
# remove safely leaves the root in place and is reported (removed=false); VM teardown is not cleanup success.
function Remove-PspFixtureRoot { param([string]$Root, [string]$TempLong, [string]$RunId, [string[]]$WriterSids = @())
  $ErrorActionPreference = 'Continue'
  $r = [ordered]@{ root = $Root; removed = $false; error = $null; liveWriters = @(); walk = $null }
  try {
    $i = $Root.LastIndexOf('\')
    if (($RunId -cnotmatch '^\d+$') -or ($i -lt 0) -or ($Root.Substring($i + 1) -cnotmatch "^psp1167-$RunId-[0-9a-f]{8}$")) { throw "refusing unowned root $Root" }
    if (($Root.Substring(0, $i) -cne $TempLong) -or ([System.IO.Path]::GetFullPath($Root) -cne $Root)) { throw "refusing non-canonical root or root outside RUNNER_TEMP: $Root" }
    if ((Test-Path -LiteralPath $Root) -and (((Get-Item -LiteralPath $Root -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "refusing reparse-point root $Root" }
    if (Test-Path -LiteralPath $Root) {
      foreach ($priv in @('SeBackupPrivilege', 'SeRestorePrivilege')) { $e = [Psp1167.Oracle]::EnablePrivilege($priv); if ($e -ne 0) { throw "cannot enable $priv ($e)" } }
      $r.liveWriters = @(Get-PspLiveSidProcesses $WriterSids)
      if ($r.liveWriters.Count -gt 0) { throw ('refusing: fake-user processes still alive: ' + ($r.liveWriters -join ', ')) }
      $pair = [Psp1167.Oracle]::RemoveLinkPair((Join-Path $Root 'fx\files\file-nlink2.bin'), (Join-Path $Root 'fx\files\file-nlink2.link.bin'))
      if ($null -ne $pair) { throw "refusing: $pair" }
      $w = [Psp1167.Oracle]::RemoveTree($Root, 32, 20000)
      $r.walk = [ordered]@{ files = $w.files; dirs = $w.dirs; links = $w.links; entries = $w.entries; problems = @($w.problems) }
      $r.removed = ($w.problems.Count -eq 0) -and -not (Test-Path -LiteralPath $Root)
      if (-not $r.removed) { $r.error = 'fixture root not fully removed (explicit cleanup failure)' }
    } else { $r.removed = $true }
  } catch { $r.error = $_.Exception.Message }
  return $r
}

# Admin-side oracle snapshot. Never the helper. fsutil cross-checks are recorded raw.
function Get-PspSnapshot { param([string[]]$Paths, [string]$AncestorFloor, [switch]$WithFsutil)
  $ErrorActionPreference = 'Continue'
  $out = @()
  foreach ($p in $Paths) {
    $s = [Psp1167.Oracle]::Take($p, $AncestorFloor)
    $o = [ordered]@{}
    foreach ($f in $s.GetType().GetFields()) { $o[$f.Name] = $f.GetValue($s) }
    if ($WithFsutil -and ($s.openError -eq 0)) {
      $rp = & fsutil.exe reparsepoint query $p 2>&1 | Out-String
      $o['fsutilReparseExit'] = $LASTEXITCODE
      $o['fsutilReparse'] = ($rp.Trim() -split "`r?`n" | Select-Object -First 4) -join ' | '
      if (-not $s.isDir) {
        $hl = & fsutil.exe hardlink list $p 2>&1 | Out-String
        $o['fsutilHardlinkExit'] = $LASTEXITCODE
        $o['fsutilHardlinks'] = @($hl.Trim() -split "`r?`n" | Where-Object { $_ -ne '' })
      }
      try { $o['getAclSddl'] = (Get-Acl -LiteralPath $p -ErrorAction Stop).Sddl } catch { $o['getAclSddl'] = $null; $o['getAclError'] = $_.Exception.GetType().Name }
    }
    $out += ,$o
  }
  return ,$out
}

# Builds every fixture. Order: create tree and links while admin still has inherited access, then
# owners, then file DACLs, then directory DACLs leaf-to-root (icacls propagates to inheriting children).
function New-PspFixtures { param([string]$Root, [string]$SidA, [string]$SidB, $State, [string]$StatePath, [string]$ScratchDir, $Trust)
  foreach ($priv in @('SeRestorePrivilege', 'SeBackupPrivilege', 'SeTakeOwnershipPrivilege')) {
    $e = [Psp1167.Oracle]::EnablePrivilege($priv); Add-PspLog 'enable-privilege' $priv $e
    if ($e -ne 0) { throw "admin token cannot enable $priv ($e)" }
  }
  $fx = Join-Path $Root 'fx'; $files = Join-Path $fx 'files'; $ha = Join-Path $Root 'helper-area'; $ctl = Join-Path $Root 'ctl'
  $wa = Join-Path $Root 'work-A'; $wb = Join-Path $Root 'work-B'; $bin = Join-Path $Root 'bin'
  $m = [ordered]@{ schema = 'aigentry/1167-psp-fixture-manifest/v1'; root = $Root; sids = [ordered]@{ A = $SidA; B = $SidB; admins = $script:PspSidAdmins }
    content = [ordered]@{}; unavailable = @(); cases = @(); measuredOnly = @(); probes = [ordered]@{}; mutable = @(); vhd = @(); shortNames = [ordered]@{}; dirs = [ordered]@{ fx = $fx; files = $files; helperArea = $ha; ctl = $ctl; workA = $wa; workB = $wb; bin = $bin } }

  Set-PspGrantOnly $Root @("*${script:PspSidAdmins}:(OI)(CI)F", "*${script:PspSidSystem}:(OI)(CI)F", "*${SidA}:(RX)", "*${SidB}:(RX)")
  foreach ($d in @($bin, $wa, $wb, $fx)) { [void](New-PspDir $d) }
  foreach ($d in @("$wa\tmp", "$wb\tmp")) { [void](New-PspDir $d) }
  [void](Invoke-PspNative 'grant-bin' 'icacls.exe' @($bin, '/grant', "*${SidA}:(OI)(CI)RX", "*${SidB}:(OI)(CI)RX", '/Q'))
  [void](Invoke-PspNative 'grant-work-A' 'icacls.exe' @($wa, '/grant', "*${SidA}:(OI)(CI)F", '/Q'))
  [void](Invoke-PspNative 'grant-work-B' 'icacls.exe' @($wb, '/grant', "*${SidB}:(OI)(CI)F", '/Q'))
  [void](Invoke-PspNative 'grant-fx' 'icacls.exe' @($fx, '/grant', "*${SidA}:(RX)", "*${SidB}:(RX)", '/Q'))
  $m.content['a-own'] = New-PspFile "$wa\a-own.bin"
  $m.content['b-own'] = New-PspFile "$wb\b-own.bin"

  # ---- tree ----
  $dOk = Join-Path $fx 'dir-ok-longname-1167'
  $dirs = [ordered]@{
    D_OK = $dOk; D_B_OWNED = "$fx\dir-b-owned"; D_B_ACE = "$fx\dir-b-ace"; D_NULL = "$fx\dir-null-dacl"; D_EMPTY = "$fx\dir-empty-dacl"
    INHERIT_PARENT = "$fx\inherit-parent"; D_NONPROT = "$fx\inherit-parent\dir-nonprotected"; D_ADMIN = "$fx\dir-admin-owned"
    D_UNKNOWN = "$fx\dir-unknown-ace"; NEST = "$fx\nest"; D_NEST_OK = "$fx\nest\inner-ok"; FILES = $files; INHERITED_FOREIGN = "$fx\inherited-foreign"
    HELPER_AREA = $ha; CTL = $ctl; CTL_SUB = "$ctl\ctl-sub"
  }
  foreach ($k in $dirs.Keys) { [void](New-PspDir $dirs[$k]) }
  $fileNames = [ordered]@{
    F_OK = "$files\file-ok.bin"; F_B_OWNED = "$files\file-b-owned.bin"; F_B_ACE = "$files\file-b-ace.bin"; F_NULL = "$files\file-null-dacl.bin"
    F_EMPTY = "$files\file-empty-dacl.bin"; F_ADMIN = "$files\file-admin-owned.bin"; F_UNKNOWN = "$files\file-unknown-ace.bin"
    F_NLINK2 = "$files\file-nlink2.bin"; F_ADS_HOST = "$files\file-ads.bin"; F_LONG = "$files\file-long-name-1167.bin"
    F_INHERITED_FOREIGN = "$fx\inherited-foreign\file-inherited-foreign.bin"
    CTL_FILE = "$ctl\ctl-file.bin"; CTL_DEL = "$ctl\ctl-del.bin"
  }
  foreach ($k in $fileNames.Keys) { $m.content[$k] = New-PspFile $fileNames[$k] }
  $m.mutable += ,$fileNames.CTL_DEL

  # ---- links, streams, short names (fsutil / mklink, measured) ----
  $links = [ordered]@{}
  [void](Invoke-PspNative 'hardlink-create' 'fsutil.exe' @('hardlink', 'create', "$files\file-nlink2.link.bin", $fileNames.F_NLINK2))
  $links['F_NLINK2_LINK'] = "$files\file-nlink2.link.bin"
  [void](Invoke-PspNative 'junction-ok' 'cmd.exe' @('/d', '/c', 'mklink', '/J', "$fx\junction-to-ok", $dOk))
  [void](Invoke-PspNative 'symlinkd-ok' 'cmd.exe' @('/d', '/c', 'mklink', '/D', "$fx\symlink-dir-to-ok", $dOk))
  [void](Invoke-PspNative 'junction-files' 'cmd.exe' @('/d', '/c', 'mklink', '/J', "$fx\jparent", $files))
  [void](Invoke-PspNative 'junction-nest' 'cmd.exe' @('/d', '/c', 'mklink', '/J', "$fx\jnest", $dirs.NEST))
  [void](Invoke-PspNative 'symlink-file' 'cmd.exe' @('/d', '/c', 'mklink', "$files\file-symlink.bin", $fileNames.F_OK))
  [void](Invoke-PspNative 'symlink-dangling' 'cmd.exe' @('/d', '/c', 'mklink', "$ha\dangling-link", "$ha\dangling-target"))
  Set-Content -LiteralPath $fileNames.F_ADS_HOST -Stream 'alt' -Value 'psp1167 fake alternate stream' -Encoding ASCII
  $m.shortNames = [ordered]@{}
  foreach ($pair in @(@($dOk, 'DIROKL~1'), @($fileNames.F_LONG, 'FILELO~1.BIN'))) {
    $long = $pair[0]; $short = [Psp1167.Oracle]::ShortPath($long)
    if (($null -eq $short) -or $short.Equals($long, [StringComparison]::OrdinalIgnoreCase)) {
      [void](Invoke-PspNative 'setshortname' 'fsutil.exe' @('file', 'setshortname', $long, $pair[1]) -AllowFail)
      $short = [Psp1167.Oracle]::ShortPath($long)
    }
    if (($null -eq $short) -or $short.Equals($long, [StringComparison]::OrdinalIgnoreCase)) { $m.unavailable += ,"short-name:$long"; $short = $null }
    $m.shortNames[$long] = $short
  }

  # ---- owners ----
  $ownerA = @($dirs.D_OK, $dirs.D_B_ACE, $dirs.D_NULL, $dirs.D_EMPTY, $dirs.INHERIT_PARENT, $dirs.D_NONPROT, $dirs.D_UNKNOWN, $dirs.NEST, $dirs.D_NEST_OK,
    $files, $dirs.INHERITED_FOREIGN, $ha, $ctl, $dirs.CTL_SUB,
    $fileNames.F_OK, $fileNames.F_B_ACE, $fileNames.F_NULL, $fileNames.F_EMPTY, $fileNames.F_UNKNOWN, $fileNames.F_NLINK2, $fileNames.F_ADS_HOST,
    $fileNames.F_LONG, $fileNames.F_INHERITED_FOREIGN, $fileNames.CTL_FILE, $fileNames.CTL_DEL)
  foreach ($p in $ownerA) { Set-PspOwner $p $SidA }
  foreach ($p in @($dirs.D_B_OWNED, $fileNames.F_B_OWNED)) { Set-PspOwner $p $SidB }
  foreach ($p in @($dirs.D_ADMIN, $fileNames.F_ADMIN)) { Set-PspOwner $p $script:PspSidAdmins }

  # ---- file DACLs (explicit, protected) ----
  $cond = "(XA;;FR;;;${SidA};(Member_of {SID(BU)}))"
  Set-PspGrantOnly $fileNames.F_B_OWNED @("*${SidA}:F")
  Set-PspGrantOnly $fileNames.F_B_ACE @("*${SidA}:F", "*${SidB}:R")
  Set-PspDaclSddl $fileNames.F_NULL 'D:NO_ACCESS_CONTROL'
  Set-PspDaclSddl $fileNames.F_EMPTY 'D:P'
  Set-PspGrantOnly $fileNames.F_ADMIN @("*${SidA}:F")
  Set-PspDaclSddl $fileNames.F_UNKNOWN "D:P(A;;FA;;;${SidA})$cond"
  # F_OK, F_NLINK2, F_ADS_HOST, F_LONG inherit from files; F_INHERITED_FOREIGN inherits A+B; ctl files inherit from ctl.

  # ---- directory DACLs, leaf to root ----
  Set-PspGrantOnly $dirs.D_OK @("*${SidA}:(OI)(CI)F")
  Set-PspGrantOnly $dirs.D_B_OWNED @("*${SidA}:(OI)(CI)F")
  Set-PspGrantOnly $dirs.D_B_ACE @("*${SidA}:(OI)(CI)F", "*${SidB}:(OI)(CI)RX")
  Set-PspDaclSddl $dirs.D_NULL 'D:NO_ACCESS_CONTROL'
  Set-PspDaclSddl $dirs.D_EMPTY 'D:P'
  Set-PspGrantOnly $dirs.INHERIT_PARENT @("*${SidA}:(OI)(CI)F")      # D_NONPROT keeps only the inherited A ACE
  Set-PspGrantOnly $dirs.D_ADMIN @("*${SidA}:(OI)(CI)F")
  Set-PspDaclSddl $dirs.D_UNKNOWN "D:P(A;OICI;FA;;;${SidA})(XA;OICI;FR;;;${SidA};(Member_of {SID(BU)}))"
  Set-PspGrantOnly $dirs.D_NEST_OK @("*${SidA}:(OI)(CI)F")
  Set-PspGrantOnly $dirs.NEST @("*${SidA}:(OI)(CI)F")
  Set-PspGrantOnly $files @("*${SidA}:(OI)(CI)F")
  Set-PspGrantOnly $dirs.INHERITED_FOREIGN @("*${SidA}:(OI)(CI)F", "*${SidB}:(OI)(CI)R")
  Set-PspGrantOnly $ha @("*${SidA}:(OI)(CI)F")
  Set-PspGrantOnly $dirs.CTL_SUB @("*${SidA}:(OI)(CI)M")   # differs from ctl so a moved file's descriptor origin is observable
  Set-PspGrantOnly $ctl @("*${SidA}:(OI)(CI)F")

  # ---- cases: requested path, helper op, declared intent/defect (the oracle must agree) ----
  $drive = $Root.Substring(0, 1)
  $unc = '\\localhost\' + $drive + '$' + $dOk.Substring(2)
  $C = New-Object System.Collections.ArrayList
  function Add-Case { param($id, $op, $path, $intent, $defect, $object, [switch]$NoSnapshot, $phase = 'existing')
    [void]$C.Add([ordered]@{ id = $id; op = $op; path = $path; intent = $intent; defect = $defect; object = $object; snapshot = (-not $NoSnapshot); phase = $phase }) }
  Add-Case 'D_OK' 'inspectDir' $dOk 'ok' $null $dOk
  Add-Case 'D_NEST_OK' 'inspectDir' $dirs.D_NEST_OK 'ok' $null $dirs.D_NEST_OK
  Add-Case 'D_B_OWNED' 'inspectDir' $dirs.D_B_OWNED 'unsafe' 'owner' $dirs.D_B_OWNED
  Add-Case 'D_B_ACE' 'inspectDir' $dirs.D_B_ACE 'unsafe' 'foreign-allow' $dirs.D_B_ACE
  Add-Case 'D_NULL' 'inspectDir' $dirs.D_NULL 'unsafe' 'null-dacl' $dirs.D_NULL
  Add-Case 'D_EMPTY' 'inspectDir' $dirs.D_EMPTY 'unsafe' 'no-owner-ace' $dirs.D_EMPTY
  Add-Case 'D_NONPROT' 'inspectDir' $dirs.D_NONPROT 'unsafe' 'not-protected' $dirs.D_NONPROT
  Add-Case 'D_ADMIN' 'inspectDir' $dirs.D_ADMIN 'unsafe' 'owner' $dirs.D_ADMIN
  Add-Case 'D_UNKNOWN' 'inspectDir' $dirs.D_UNKNOWN 'unsafe' 'unknown-ace' $dirs.D_UNKNOWN
  Add-Case 'D_JUNCTION' 'inspectDir' "$fx\junction-to-ok" 'unsafe' 'reparse' "$fx\junction-to-ok"
  Add-Case 'D_SYMLINK' 'inspectDir' "$fx\symlink-dir-to-ok" 'unsafe' 'reparse' "$fx\symlink-dir-to-ok"
  Add-Case 'D_UNDER_JUNCTION' 'inspectDir' "$fx\jnest\inner-ok" 'unsafe' 'ancestor-reparse' $dirs.D_NEST_OK
  Add-Case 'D_NOT_DIR' 'inspectDir' $fileNames.F_OK 'unsafe' 'not-dir' $fileNames.F_OK
  Add-Case 'D_MISSING' 'inspectDir' "$fx\does-not-exist" 'missing' 'missing' $null
  if ($m.shortNames[$dOk]) { Add-Case 'D_SHORTNAME' 'inspectDir' $m.shortNames[$dOk] 'unsafe' 'final-path-mismatch' $dOk }
  else { Add-Case 'D_SHORTNAME' 'inspectDir' $null 'unsafe' 'final-path-mismatch' $dOk -NoSnapshot }
  Add-Case 'D_TRAILDOT' 'inspectDir' ($dOk + '.') 'unsafe' 'grammar:trailing-dot-or-space' $dOk
  Add-Case 'D_TRAILSPACE' 'inspectDir' ($dOk + ' ') 'unsafe' 'grammar:trailing-dot-or-space' $dOk
  Add-Case 'D_ADS' 'inspectDir' ($dOk + '::$INDEX_ALLOCATION') 'unsafe' 'grammar:colon' $dOk
  Add-Case 'D_UNC' 'inspectDir' $unc 'unsafe' 'grammar:prefix' $dOk -NoSnapshot
  Add-Case 'D_LONGPREFIX' 'inspectDir' ('\\?\' + $dOk) 'unsafe' 'grammar:prefix' $dOk -NoSnapshot
  Add-Case 'D_DEVPREFIX' 'inspectDir' ('\\.\' + $dOk) 'unsafe' 'grammar:prefix' $dOk -NoSnapshot
  Add-Case 'D_RESERVED' 'inspectDir' "$fx\CON" 'unsafe' 'grammar:reserved-name' $null -NoSnapshot
  Add-Case 'F_OK' 'readPrivateFile' $fileNames.F_OK 'ok' $null $fileNames.F_OK
  Add-Case 'F_B_OWNED' 'readPrivateFile' $fileNames.F_B_OWNED 'unsafe' 'owner' $fileNames.F_B_OWNED
  Add-Case 'F_B_ACE' 'readPrivateFile' $fileNames.F_B_ACE 'unsafe' 'foreign-allow' $fileNames.F_B_ACE
  Add-Case 'F_NULL' 'readPrivateFile' $fileNames.F_NULL 'unsafe' 'null-dacl' $fileNames.F_NULL
  Add-Case 'F_EMPTY' 'readPrivateFile' $fileNames.F_EMPTY 'unavailable' 'empty-dacl' $fileNames.F_EMPTY
  Add-Case 'F_ADMIN' 'readPrivateFile' $fileNames.F_ADMIN 'unsafe' 'owner' $fileNames.F_ADMIN
  Add-Case 'F_UNKNOWN' 'readPrivateFile' $fileNames.F_UNKNOWN 'unsafe' 'unknown-ace' $fileNames.F_UNKNOWN
  Add-Case 'F_INHERITED_FOREIGN' 'readPrivateFile' $fileNames.F_INHERITED_FOREIGN 'unsafe' 'foreign-allow' $fileNames.F_INHERITED_FOREIGN
  Add-Case 'F_NLINK2' 'readPrivateFile' $fileNames.F_NLINK2 'unsafe' 'hardlink' $fileNames.F_NLINK2
  Add-Case 'F_SYMLINK' 'readPrivateFile' "$files\file-symlink.bin" 'unsafe' 'reparse' "$files\file-symlink.bin"
  Add-Case 'F_UNDER_JUNCTION' 'readPrivateFile' "$fx\jparent\file-ok.bin" 'unsafe' 'ancestor-reparse' $fileNames.F_OK
  Add-Case 'F_NOT_FILE' 'readPrivateFile' $dOk 'unsafe' 'not-file' $dOk
  Add-Case 'F_MISSING' 'readPrivateFile' "$files\does-not-exist.bin" 'missing' 'missing' $null
  if ($m.shortNames[$fileNames.F_LONG]) { Add-Case 'F_SHORTNAME' 'readPrivateFile' $m.shortNames[$fileNames.F_LONG] 'unsafe' 'final-path-mismatch' $fileNames.F_LONG }
  else { Add-Case 'F_SHORTNAME' 'readPrivateFile' $null 'unsafe' 'final-path-mismatch' $fileNames.F_LONG -NoSnapshot }
  Add-Case 'F_TRAILDOT' 'readPrivateFile' ($fileNames.F_OK + '.') 'unsafe' 'grammar:trailing-dot-or-space' $fileNames.F_OK
  Add-Case 'F_ADS' 'readPrivateFile' ($fileNames.F_ADS_HOST + ':alt') 'unsafe' 'grammar:colon' $fileNames.F_ADS_HOST
  Add-Case 'F_DATA_STREAM' 'readPrivateFile' ($fileNames.F_OK + '::$DATA') 'unsafe' 'grammar:colon' $fileNames.F_OK
  Add-Case 'F_UNC' 'readPrivateFile' ('\\localhost\' + $drive + '$' + $fileNames.F_OK.Substring(2)) 'unsafe' 'grammar:prefix' $fileNames.F_OK -NoSnapshot
  Add-Case 'F_LONGPREFIX' 'readPrivateFile' ('\\?\' + $fileNames.F_OK) 'unsafe' 'grammar:prefix' $fileNames.F_OK -NoSnapshot
  # helper-created objects (phase 'create'; run in this order by acl.test.mjs)
  Add-Case 'C_DIR' 'createPrivateDir' "$ha\created-dir" 'ok' $null "$ha\created-dir" -phase 'create'
  Add-Case 'C_DIR_INSPECT' 'inspectDir' "$ha\created-dir" 'ok' $null "$ha\created-dir" -phase 'create'
  Add-Case 'C_DIR_AGAIN' 'createPrivateDir' "$ha\created-dir" 'exists' 'exists' "$ha\created-dir" -phase 'create'
  Add-Case 'C_FILE' 'createPrivateFileExclusive' "$ha\created-dir\created-file.bin" 'ok' $null "$ha\created-dir\created-file.bin" -phase 'create'
  Add-Case 'C_FILE_READ' 'readPrivateFile' "$ha\created-dir\created-file.bin" 'ok' $null "$ha\created-dir\created-file.bin" -phase 'create'
  Add-Case 'C_FILE_AGAIN' 'createPrivateFileExclusive' "$ha\created-dir\created-file.bin" 'exists' 'exists' "$ha\created-dir\created-file.bin" -phase 'create'
  Add-Case 'C_DANGLING' 'createPrivateFileExclusive' "$ha\dangling-link" 'exists' 'exists' "$ha\dangling-link" -phase 'create'
  Add-Case 'C_DIR_TRAILDOT' 'createPrivateDir' "$ha\created-dot." 'unsafe' 'grammar:trailing-dot-or-space' $null -phase 'create' -NoSnapshot
  Add-Case 'C_FILE_ADS' 'createPrivateFileExclusive' "$ha\created-ads.bin:alt" 'unsafe' 'grammar:colon' $null -phase 'create' -NoSnapshot
  $m.cases = @($C)

  # absent-after checks for creates that must not materialize anything
  $m.mustStayAbsent = @("$ha\dangling-target", "$ha\created-dot", "$ha\created-ads.bin")

  # ---- probe plans (OS operations only; independent of the helper) ----
  $m.probes['B1'] = @(New-PspDenialPlan 'B1' $dOk $fileNames.F_OK $wb)
  $m.probes['B2'] = @(New-PspDenialPlan 'B2' "$ha\created-dir" "$ha\created-dir\created-file.bin" $wb)
  # B's own-file positive control precedes BOTH denial plans: a child that denies everything cannot pass.
  foreach ($t in @('B1', 'B2')) {
    $m.probes["${t}self"] = @(
      [ordered]@{ id = "$t-self-read"; op = 'read'; path = "$wb\b-own.bin"; expect = 0 },
      [ordered]@{ id = "$t-self-create"; op = 'create'; path = "$wb\b-self-$t.tmp"; expect = 0 },
      [ordered]@{ id = "$t-self-delete"; op = 'delete'; path = "$wb\b-self-$t.tmp"; expect = 0 })
  }
  $m.probes['Atrust'] = @(New-PspTrustPlan 'Atrust' $Trust $bin $wa)
  $m.probes['Btrust'] = @(New-PspTrustPlan 'Btrust' $Trust $bin $wb)
  $m.probes['Actl'] = @(
    [ordered]@{ id = 'A-list'; op = 'list'; path = $ctl; expect = 0 },
    [ordered]@{ id = 'A-create'; op = 'create'; path = "$ctl\a-probe.tmp"; expect = 0 },
    [ordered]@{ id = 'A-create-cleanup'; op = 'delete'; path = "$ctl\a-probe.tmp"; expect = 0 },
    [ordered]@{ id = 'A-mkdir'; op = 'mkdir'; path = "$ctl\a-probe-dir"; expect = 0 },
    [ordered]@{ id = 'A-mkdir-cleanup'; op = 'rmdir'; path = "$ctl\a-probe-dir"; expect = 0 },
    [ordered]@{ id = 'A-hardlink-into'; op = 'hardlink'; path = "$ctl\a-link-in.bin"; path2 = "$wa\a-own.bin"; expect = 0 },
    [ordered]@{ id = 'A-hardlink-into-cleanup'; op = 'delete'; path = "$ctl\a-link-in.bin"; expect = 0 },
    [ordered]@{ id = 'A-read'; op = 'read'; path = $fileNames.CTL_FILE; expect = 0 },
    [ordered]@{ id = 'A-write-open'; op = 'write-open'; path = $fileNames.CTL_FILE; expect = 0 },
    [ordered]@{ id = 'A-read-control'; op = 'read-control'; path = $fileNames.CTL_FILE; expect = 0 },
    [ordered]@{ id = 'A-rename'; op = 'rename'; path = $fileNames.CTL_FILE; path2 = "$($fileNames.CTL_FILE).renamed"; expect = 0 },
    [ordered]@{ id = 'A-rename-back'; op = 'rename'; path = "$($fileNames.CTL_FILE).renamed"; path2 = $fileNames.CTL_FILE; expect = 0 },
    [ordered]@{ id = 'A-rename-dir'; op = 'rename'; path = $dirs.CTL_SUB; path2 = "$($dirs.CTL_SUB).renamed"; expect = 0 },
    [ordered]@{ id = 'A-rename-dir-back'; op = 'rename'; path = "$($dirs.CTL_SUB).renamed"; path2 = $dirs.CTL_SUB; expect = 0 },
    [ordered]@{ id = 'A-hardlink-out'; op = 'hardlink'; path = "$wa\a-link-out.bin"; path2 = $fileNames.CTL_FILE; expect = 0 },
    [ordered]@{ id = 'A-hardlink-out-cleanup'; op = 'delete'; path = "$wa\a-link-out.bin"; expect = 0 },
    [ordered]@{ id = 'A-delete'; op = 'delete'; path = $fileNames.CTL_DEL; expect = 0 })
  $m.moveMeasure = [ordered]@{ srcDir = $ctl; dstDir = $dirs.CTL_SUB }

  # ---- objects the oracle snapshots before/after each phase ----
  $snapObjects = @($dirs.Values) + @($fileNames.Values) + @($links.Values) + @("$fx\junction-to-ok", "$fx\symlink-dir-to-ok", "$fx\jparent", "$fx\jnest", "$files\file-symlink.bin", "$ha\dangling-link", ($fileNames.F_ADS_HOST + ':alt'))
  $m.snapshotObjects = @($snapObjects | Select-Object -Unique)
  return $m
}

# B attempts the five denied operation classes (+ list/delete/read-control) against one A dir + A file.
function New-PspDenialPlan { param([string]$Tag, [string]$Dir, [string]$File, [string]$WorkB)
  return @(
    [ordered]@{ id = "$Tag-list-dir"; op = 'list'; path = $Dir; expect = 5 },
    [ordered]@{ id = "$Tag-create-in-dir"; op = 'create'; path = "$Dir\b-probe.tmp"; expect = 5 },
    [ordered]@{ id = "$Tag-mkdir-in-dir"; op = 'mkdir'; path = "$Dir\b-probe-dir"; expect = 5 },
    [ordered]@{ id = "$Tag-hardlink-into-dir"; op = 'hardlink'; path = "$Dir\b-link-in.bin"; path2 = "$WorkB\b-own.bin"; expect = 5 },
    [ordered]@{ id = "$Tag-rename-dir"; op = 'rename'; path = $Dir; path2 = "$Dir.b-renamed"; expect = 5 },
    [ordered]@{ id = "$Tag-read-file"; op = 'read'; path = $File; expect = 5 },
    [ordered]@{ id = "$Tag-write-file"; op = 'write-open'; path = $File; expect = 5 },
    [ordered]@{ id = "$Tag-read-control-file"; op = 'read-control'; path = $File; expect = 5 },
    [ordered]@{ id = "$Tag-rename-file"; op = 'rename'; path = $File; path2 = "$File.b-renamed"; expect = 5 },
    [ordered]@{ id = "$Tag-rename-file-out"; op = 'rename'; path = $File; path2 = "$WorkB\b-stolen.bin"; expect = 5 },
    [ordered]@{ id = "$Tag-hardlink-out-of-file"; op = 'hardlink'; path = "$WorkB\b-link-out.bin"; path2 = $File; expect = 5 },
    [ordered]@{ id = "$Tag-delete-file"; op = 'delete'; path = $File; expect = 5 })
}

# A or B attempts to read/overwrite/rename the trusted state, oracle receipts, elevated sources and the
# read-execute bin, each expected ERROR_ACCESS_DENIED; own-work-dir create/write/delete are the positive control.
function New-PspTrustPlan { param([string]$Tag, $Trust, [string]$Bin, [string]$Work)
  return @(
    [ordered]@{ id = "$Tag-own-create"; op = 'create'; path = "$Work\$Tag-own.tmp"; expect = 0 },
    [ordered]@{ id = "$Tag-own-write"; op = 'write-open'; path = "$Work\$Tag-own.tmp"; expect = 0 },
    [ordered]@{ id = "$Tag-own-delete"; op = 'delete'; path = "$Work\$Tag-own.tmp"; expect = 0 },
    [ordered]@{ id = "$Tag-list-trust"; op = 'list'; path = $Trust.root; expect = 5 },
    [ordered]@{ id = "$Tag-create-in-trust"; op = 'create'; path = "$($Trust.root)\$Tag.tmp"; expect = 5 },
    [ordered]@{ id = "$Tag-rename-trust"; op = 'rename'; path = $Trust.root; path2 = "$($Trust.root)-$Tag"; expect = 5 },
    [ordered]@{ id = "$Tag-read-state"; op = 'read'; path = $Trust.statePath; expect = 5 },
    [ordered]@{ id = "$Tag-write-state"; op = 'write-open'; path = $Trust.statePath; expect = 5 },
    [ordered]@{ id = "$Tag-rename-state"; op = 'rename'; path = $Trust.statePath; path2 = "$($Trust.state)\$Tag.json"; expect = 5 },
    [ordered]@{ id = "$Tag-create-in-state"; op = 'create'; path = "$($Trust.state)\$Tag.json"; expect = 5 },
    [ordered]@{ id = "$Tag-write-oracle"; op = 'write-open'; path = $Trust.canary; expect = 5 },
    [ordered]@{ id = "$Tag-create-in-oracle"; op = 'create'; path = "$($Trust.receipts)\snap-$Tag.json"; expect = 5 },
    [ordered]@{ id = "$Tag-write-src"; op = 'write-open'; path = "$($Trust.src)\run-validation.ps1"; expect = 5 },
    [ordered]@{ id = "$Tag-create-in-src"; op = 'create'; path = "$($Trust.src)\$Tag.ps1"; expect = 5 },
    [ordered]@{ id = "$Tag-write-bin-script"; op = 'write-open'; path = "$Bin\run-as-user.ps1"; expect = 5 },
    [ordered]@{ id = "$Tag-write-bin-node"; op = 'write-open'; path = "$Bin\node.exe"; expect = 5 },
    [ordered]@{ id = "$Tag-create-in-bin"; op = 'create'; path = "$Bin\$Tag.tmp"; expect = 5 },
    [ordered]@{ id = "$Tag-rename-bin"; op = 'rename'; path = $Bin; path2 = "$Bin-$Tag"; expect = 5 })
}

# FAT32 / exFAT fixtures on owned VHDs; appended to the manifest. Unavailable => recorded, never skipped.
function Add-PspVhdFixtures { param($Manifest, $State, [string]$StatePath, [string]$ScratchDir, [string]$SidA)
  foreach ($spec in @(@('fat32', 'PSPFAT', 'FAT'), @('exfat', 'PSPEXFAT', 'EXFAT'))) {
    $fs = $spec[0]; $tag = $spec[2]
    try {
      $v = New-PspVhd -VhdPath (Join-Path $Manifest.root "vhd-$fs.vhdx") -FileSystem $fs -Label $spec[1] -State $State -StatePath $StatePath -ScratchDir $ScratchDir
      $Manifest.vhd += ,$v
      $root = $v.root
      [void](New-Item -ItemType Directory -Path (Assert-PspOwnedPath $root))
      $d = New-PspDir "$root\dir-$fs"
      $Manifest.content["F_$tag"] = New-PspFile "$d\file-$fs.bin"
      $Manifest.cases += ,([ordered]@{ id = "D_$tag"; op = 'inspectDir'; path = $d; intent = 'unsafe'; defect = 'non-acl-volume'; object = $d; snapshot = $true; phase = 'existing' })
      $Manifest.cases += ,([ordered]@{ id = "F_$tag"; op = 'readPrivateFile'; path = "$d\file-$fs.bin"; intent = 'unsafe'; defect = 'non-acl-volume'; object = "$d\file-$fs.bin"; snapshot = $true; phase = 'existing' })
      $Manifest.cases += ,([ordered]@{ id = "C_DIR_$tag"; op = 'createPrivateDir'; path = "$root\created-dir"; intent = 'unsafe'; defect = 'non-acl-volume'; object = $null; snapshot = $false; phase = 'create' })
      $Manifest.cases += ,([ordered]@{ id = "C_FILE_$tag"; op = 'createPrivateFileExclusive'; path = "$root\created-file.bin"; intent = 'unsafe'; defect = 'non-acl-volume'; object = $null; snapshot = $false; phase = 'create' })
      $Manifest.snapshotObjects += @($d, "$d\file-$fs.bin")
      $Manifest.measuredOnly = @($Manifest.measuredOnly) + @("$root\created-dir", "$root\created-file.bin")
    } catch {
      $Manifest.unavailable += ,("vhd-${fs}: " + $_.Exception.Message)
      $Manifest.cases += ,([ordered]@{ id = "D_$tag"; op = 'inspectDir'; path = $null; intent = 'unsafe'; defect = 'non-acl-volume'; object = $null; snapshot = $false; phase = 'existing' })
      $Manifest.cases += ,([ordered]@{ id = "F_$tag"; op = 'readPrivateFile'; path = $null; intent = 'unsafe'; defect = 'non-acl-volume'; object = $null; snapshot = $false; phase = 'existing' })
    }
  }
}
