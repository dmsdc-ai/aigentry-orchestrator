// acl.test.mjs - #1167 Windows private-storage ACL prototype, test-only. Node standard library only.
// PSP_PHASE selects one of three phases:
//   selfcheck (default, any OS): unit tests of the INDEPENDENT oracle below (SDDL parser, P-DIR/P-FILE
//             classifier, path-grammar rule) against synthetic inputs. No Windows evidence.
//   helper    (win32, run by run-validation.ps1 AS FAKE STANDARD USER A): verifies the helper binary sha256
//             BEFORE loading it, calls the four functions on every manifest case in order, writes a receipt.
//   verdict   (win32, admin, receipts only): never loads the helper. Compares helper results with the oracle
//             classification computed from admin backup-semantics snapshots, checks B's numeric
//             ERROR_ACCESS_DENIED codes, A/B positive controls, identities/privileges, before==after hashes.
// The oracle is never the helper. A refusal-only helper cannot pass: positive controls gate every negative.
// A green verdict is a FEASIBILITY receipt only (no product/release/security/durability acceptance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Helper ABI taken from the independently authored candidate (wc1167abt, candidate-r1 manifest
// 76e661ec...): README.md e2b1bfe0..., private-storage.mjs 3b222843... Load path: the wrapper's
// loadPrivateStorage({binaryPath, sha256}) -> { status:'ok', api }; api functions are synchronous, never
// throw, and return frozen { status, reason, win32Error, created?, volumeSerial?, fileId?, bytes? }.
export const ABI = Object.freeze({
  confirmedBy: 'candidate-r1 README.md e2b1bfe00bb121a57857ef3fc362c3665ad1e59bffdc39922a46e3d0c8ab77fa + private-storage.mjs 3b2228432e8010ffc5c24ce1bb8f867bc7cd0a2aa71680ed30b3f65d72f06288',
  abiTag: 'aigentry-private-storage-proto-1',
  exports: ['inspectDir', 'readPrivateFile', 'createPrivateDir', 'createPrivateFileExclusive'],
  statusField: 'status',
  bytesField: 'bytes',
  statuses: ['ok', 'missing', 'unsafe', 'exists', 'unavailable'],
  readMax: 65536,
});

// Exact expected helper outcome per case, from the candidate README reason vocabulary. `status` is set
// only where the documented candidate status differs from the independent oracle class; such a case is a
// documented deviation, still fail-closed (never ok), and is listed in the receipt for the reviewer.
// `reasons`: the refusal must carry one of these reasons, so a refusal for an incidental cause fails.
export const CANDIDATE_EXPECT = Object.freeze({
  D_OK: { reasons: ['ok'] }, D_NEST_OK: { reasons: ['ok'] }, D_B_OWNED: { reasons: ['owner_mismatch'] },
  D_B_ACE: { reasons: ['ace_foreign_allow'] }, D_NULL: { reasons: ['dacl_null'] }, D_EMPTY: { reasons: ['dacl_empty'] },
  D_NONPROT: { reasons: ['dacl_not_protected'] }, D_ADMIN: { reasons: ['owner_mismatch'] }, D_UNKNOWN: { reasons: ['ace_unsupported'] },
  D_JUNCTION: { reasons: ['reparse_point'] }, D_SYMLINK: { reasons: ['reparse_point'] }, D_UNDER_JUNCTION: { reasons: ['ancestor_reparse_point'] },
  D_NOT_DIR: { reasons: ['not_directory'] }, D_MISSING: { reasons: ['not_found'] }, D_SHORTNAME: { reasons: ['final_path_mismatch'] },
  D_TRAILDOT: { reasons: ['path_grammar'] }, D_TRAILSPACE: { reasons: ['path_grammar'] }, D_ADS: { reasons: ['path_grammar'] },
  D_UNC: { reasons: ['path_grammar'] }, D_LONGPREFIX: { reasons: ['path_grammar'] }, D_DEVPREFIX: { reasons: ['path_grammar'] },
  D_RESERVED: { reasons: ['path_grammar'] },
  F_OK: { reasons: ['ok'] }, F_B_OWNED: { reasons: ['owner_mismatch'] }, F_B_ACE: { reasons: ['ace_foreign_allow'] },
  F_NULL: { reasons: ['dacl_null'] }, F_EMPTY: { reasons: ['open_failed', 'dacl_empty'] }, F_ADMIN: { reasons: ['owner_mismatch'] },
  F_UNKNOWN: { reasons: ['ace_unsupported'] }, F_INHERITED_FOREIGN: { reasons: ['ace_foreign_allow'] }, F_NLINK2: { reasons: ['link_count'] },
  F_SYMLINK: { reasons: ['reparse_point'] }, F_UNDER_JUNCTION: { reasons: ['ancestor_reparse_point'] },
  F_NOT_FILE: { status: 'unavailable', reasons: ['open_failed'], deviation: 'README: a directory at the readPrivateFile leaf fails the open (no BACKUP_SEMANTICS) -> unavailable/open_failed; oracle class is unsafe/not-file' },
  F_MISSING: { reasons: ['not_found'] }, F_SHORTNAME: { reasons: ['final_path_mismatch'] }, F_TRAILDOT: { reasons: ['path_grammar'] },
  F_ADS: { reasons: ['path_grammar'] }, F_DATA_STREAM: { reasons: ['path_grammar'] }, F_UNC: { reasons: ['path_grammar'] },
  F_LONGPREFIX: { reasons: ['path_grammar'] },
  C_DIR: { reasons: ['ok'], created: true }, C_DIR_INSPECT: { reasons: ['ok'] }, C_DIR_AGAIN: { reasons: ['already_exists'], created: false },
  C_FILE: { reasons: ['ok'], created: true }, C_FILE_READ: { reasons: ['ok'] }, C_FILE_AGAIN: { reasons: ['already_exists'], created: false },
  C_DANGLING: { reasons: ['already_exists'], created: false }, C_DIR_TRAILDOT: { reasons: ['path_grammar'], created: false },
  C_FILE_ADS: { reasons: ['path_grammar'], created: false },
  D_FAT: { reasons: ['acl_not_persistent'] }, F_FAT: { reasons: ['acl_not_persistent'] }, C_DIR_FAT: { reasons: ['acl_not_persistent'] },
  C_FILE_FAT: { reasons: ['acl_not_persistent'] }, D_EXFAT: { reasons: ['acl_not_persistent'] }, F_EXFAT: { reasons: ['acl_not_persistent'] },
  C_DIR_EXFAT: { reasons: ['acl_not_persistent'] }, C_FILE_EXFAT: { reasons: ['acl_not_persistent'] },
});

export function expectedHelperStatus(caseId, oracleCls) {
  const e = CANDIDATE_EXPECT[caseId];
  return e && e.status ? e.status : oracleCls;
}

const PHASE = process.env.PSP_PHASE || 'selfcheck';
const ERROR_ACCESS_DENIED = 5;
const DANGEROUS_PRIVILEGES = ['SeBackupPrivilege', 'SeRestorePrivilege', 'SeTakeOwnershipPrivilege', 'SeDebugPrivilege'];
const SID_ADMINS = 'S-1-5-32-544';

// ------------------------------------------------------------------ independent oracle (pure)
export const SID_ALIASES = Object.freeze({
  BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546', BO: 'S-1-5-32-551', SY: 'S-1-5-18', LS: 'S-1-5-19',
  NS: 'S-1-5-20', WD: 'S-1-1-0', AU: 'S-1-5-11', AN: 'S-1-5-7', IU: 'S-1-5-4', NU: 'S-1-5-2', SU: 'S-1-5-6',
  CO: 'S-1-3-0', CG: 'S-1-3-1', OW: 'S-1-3-4', PS: 'S-1-5-10', RC: 'S-1-5-12', AC: 'S-1-15-2-1',
});

export function normalizeSid(s) {
  if (typeof s !== 'string' || s === '') return null;
  if (/^S-\d/i.test(s)) return s.toUpperCase();
  return SID_ALIASES[s.toUpperCase()] || `alias:${s.toUpperCase()}`;
}

export function splitTopLevel(str, sep) {
  const out = []; let depth = 0; let buf = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

const RIGHTS = {
  GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000, FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0,
  RC: 0x20000, SD: 0x10000, WD: 0x40000, WO: 0x80000, CC: 0x1, DC: 0x2, LC: 0x4, SW: 0x8, RP: 0x10, WP: 0x20, DT: 0x40,
  LO: 0x80, CR: 0x100,
};

export function parseRights(r) {
  if (typeof r !== 'string' || r === '') return { mask: 0, unknown: false };
  if (/^0x[0-9a-f]+$/i.test(r)) return { mask: parseInt(r, 16) >>> 0, unknown: false };
  let mask = 0; let unknown = false;
  for (let i = 0; i < r.length; i += 2) {
    const t = r.slice(i, i + 2).toUpperCase();
    if (RIGHTS[t] === undefined) unknown = true; else mask = (mask | RIGHTS[t]) >>> 0;
  }
  return { mask, unknown };
}

export function grantsReadWriteData(rights) {
  const { mask, unknown } = parseRights(rights);
  if (unknown) return false;
  const read = (mask & (0x1 | RIGHTS.GR | RIGHTS.GA)) !== 0;
  const write = (mask & (0x2 | RIGHTS.GW | RIGHTS.GA)) !== 0;
  return read && write;
}

export function parseSddl(sddl) {
  if (typeof sddl !== 'string') return null;
  const sections = []; let cur = null; let buf = ''; let depth = 0;
  for (let i = 0; i < sddl.length; i++) {
    const ch = sddl[i];
    if (depth === 0 && 'OGDS'.includes(ch) && sddl[i + 1] === ':') {
      if (cur) sections.push([cur, buf]);
      cur = ch; buf = ''; i++; continue;
    }
    if (ch === '(') depth++; else if (ch === ')') depth--;
    buf += ch;
  }
  if (cur) sections.push([cur, buf]);
  const out = { owner: null, group: null, dacl: null };
  for (const [k, v] of sections) {
    if (k === 'O') out.owner = v;
    else if (k === 'G') out.group = v;
    else if (k === 'D') {
      const first = v.indexOf('(');
      const flagText = first === -1 ? v : v.slice(0, first);
      const isNull = flagText.includes('NO_ACCESS_CONTROL');
      const rest = flagText.replace('NO_ACCESS_CONTROL', '');
      const aces = [];
      let d = 0; let start = -1;
      for (let i = first === -1 ? v.length : first; i < v.length; i++) {
        if (v[i] === '(') { if (d === 0) start = i + 1; d++; }
        else if (v[i] === ')') { d--; if (d === 0) aces.push(v.slice(start, i)); }
      }
      out.dacl = {
        isNull,
        protected: /P/.test(rest),
        autoInherited: /AI/.test(rest),
        aces: aces.map((raw) => {
          const f = splitTopLevel(raw, ';');
          return { raw, type: f[0], flags: (f[1] || '').match(/../g) || [], rights: f[2] || '', sid: normalizeSid(f[5] || ''), condition: f[6] || null };
        }),
      };
    }
  }
  return out;
}

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$)$/;
export function grammarRefusal(p) {
  if (typeof p !== 'string' || p === '') return 'empty';
  if (p.startsWith('\\\\') || p.startsWith('//')) return 'prefix';
  if (!/^[A-Za-z]:\\/.test(p)) return 'not-drive-absolute';
  if (p.indexOf(':', 2) !== -1) return 'colon';
  for (const c of p.slice(3).split(/[\\/]/)) {
    if (c === '') return 'empty-component';
    if (c === '.' || c === '..') return 'dot-component';
    if (/[. ]$/.test(c)) return 'trailing-dot-or-space';
    if (RESERVED.test(c.split('.')[0].trimEnd().toUpperCase())) return 'reserved-name';
  }
  return null;
}

export function finalPathMatches(requested, finalPath) {
  if (typeof finalPath !== 'string') return false;
  let f = finalPath;
  if (f.startsWith('\\\\?\\UNC\\')) f = '\\\\' + f.slice(8);
  else if (f.startsWith('\\\\?\\')) f = f.slice(4);
  const strip = (s) => s.replace(/\\+$/, '').toLowerCase();
  return strip(f) === strip(requested);
}

function verdictOf(cls, reason) { return { cls, reason }; }

function classifyCommon(reqPath, snap) {
  const g = grammarRefusal(reqPath);
  if (g) return verdictOf('unsafe', `grammar:${g}`);
  if (!snap) return verdictOf('error', 'no-snapshot');
  if (snap.openError === 2 || snap.openError === 3) return verdictOf('missing', 'missing');
  if (snap.openError) return verdictOf('error', `open-error-${snap.openError}`);
  if (snap.ancestorReparse) return verdictOf('unsafe', 'ancestor-reparse');
  if (snap.infoError) return verdictOf('error', `info-error-${snap.infoError}`);
  if (snap.isReparse) return verdictOf('unsafe', 'reparse');
  if (snap.volumeError) return verdictOf('error', `volume-error-${snap.volumeError}`);
  if (!snap.persistentAcls) return verdictOf('unsafe', 'non-acl-volume');
  if (snap.finalPathError) return verdictOf('error', `final-path-error-${snap.finalPathError}`);
  if (!finalPathMatches(reqPath, snap.finalPath)) return verdictOf('unsafe', 'final-path-mismatch');
  return null;
}

function classifyAcl(snap, ownerSid, kind) {
  if (snap.sddlError || typeof snap.sddl !== 'string') return verdictOf('error', `sddl-error-${snap.sddlError}`);
  const sd = parseSddl(snap.sddl);
  const owner = normalizeSid(ownerSid);
  if (normalizeSid(sd.owner) !== owner) return verdictOf('unsafe', 'owner');
  if (!sd.dacl) return verdictOf('unsafe', 'dacl-absent');
  if (sd.dacl.isNull) return verdictOf('unsafe', 'null-dacl');
  if (sd.dacl.aces.some((a) => a.type !== 'A' && a.type !== 'D')) return verdictOf('unsafe', 'unknown-ace');
  if (sd.dacl.aces.some((a) => a.type === 'A' && a.sid !== owner)) return verdictOf('unsafe', 'foreign-allow');
  if (kind === 'dir') {
    if (!sd.dacl.protected) return verdictOf('unsafe', 'not-protected');
    const ok = sd.dacl.aces.some((a) => a.type === 'A' && a.sid === owner && a.flags.includes('OI') && a.flags.includes('CI') && !a.flags.includes('IO'));
    return ok ? verdictOf('ok', null) : verdictOf('unsafe', 'no-owner-ace');
  }
  if (sd.dacl.aces.length === 0) return verdictOf('unavailable', 'empty-dacl');
  const rw = sd.dacl.aces.some((a) => a.type === 'A' && a.sid === owner && !a.flags.includes('IO') && grantsReadWriteData(a.rights));
  return rw ? verdictOf('ok', null) : verdictOf('unsafe', 'no-owner-rw-ace');
}

export function classifyDir(reqPath, snap, ownerSid) {
  const c = classifyCommon(reqPath, snap);
  if (c) return c;
  if (!snap.isDir) return verdictOf('unsafe', 'not-dir');
  return classifyAcl(snap, ownerSid, 'dir');
}

export function classifyFile(reqPath, snap, ownerSid) {
  const c = classifyCommon(reqPath, snap);
  if (c) return c;
  if (snap.isDir) return verdictOf('unsafe', 'not-file');
  if (snap.nLinks !== 1) return verdictOf('unsafe', 'hardlink');
  return classifyAcl(snap, ownerSid, 'file');
}

// ------------------------------------------------------------------ shared helpers
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}
function asArray(x) { return Array.isArray(x) ? x : (x === null || x === undefined ? [] : [x]); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function toBytes(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  return undefined;
}

export function normalizeResult(res) {
  if (!res || typeof res !== 'object') return { abiOk: false, status: null, shape: typeof res };
  const status = res[ABI.statusField];
  const raw = res[ABI.bytesField];
  const bytes = toBytes(raw);
  return {
    abiOk: ABI.statuses.includes(status) && bytes !== undefined && typeof res.reason === 'string' && Number.isInteger(res.win32Error),
    status: typeof status === 'string' ? status : null,
    reason: typeof res.reason === 'string' ? res.reason : null,
    win32Error: Number.isInteger(res.win32Error) ? res.win32Error : null,
    created: typeof res.created === 'boolean' ? res.created : null,
    volumeSerial: typeof res.volumeSerial === 'string' ? res.volumeSerial : null,
    fileId: typeof res.fileId === 'string' ? res.fileId : null,
    keys: Object.keys(res).sort(),
    bytesLength: bytes ? bytes.length : 0,
    bytesSha256: bytes ? sha256(bytes) : null,
  };
}

// ------------------------------------------------------------------ phase: selfcheck
if (PHASE === 'selfcheck') {
  const A = 'S-1-5-21-1-2-3-1001';
  const B = 'S-1-5-21-1-2-3-1002';
  const base = { openError: 0, infoError: 0, ancestorReparse: false, isReparse: false, volumeError: 0, persistentAcls: true, finalPathError: 0, nLinks: 1, sddlError: 0 };
  const dir = (p, sddl, extra = {}) => ({ ...base, isDir: true, finalPath: `\\\\?\\${p}`, sddl, ...extra });
  const file = (p, sddl, extra = {}) => ({ ...base, isDir: false, finalPath: `\\\\?\\${p}`, sddl, ...extra });
  const P = 'D:\\a\\_temp\\psp1167-1-ab\\fx\\x';

  test('selfcheck: SDDL parser handles owner, flags, nested conditional ACEs and NULL DACL', () => {
    const sd = parseSddl(`O:${A}G:${A}D:PAI(A;OICI;FA;;;${A})(XA;OICI;FR;;;${A};(Member_of {SID(BU)}))(D;;FA;;;BG)`);
    assert.equal(sd.owner, A);
    assert.equal(sd.dacl.protected, true);
    assert.equal(sd.dacl.aces.length, 3);
    assert.equal(sd.dacl.aces[1].type, 'XA');
    assert.equal(sd.dacl.aces[1].condition, '(Member_of {SID(BU)})');
    assert.equal(sd.dacl.aces[2].sid, 'S-1-5-32-546');
    const n = parseSddl(`O:${A}G:${A}D:PNO_ACCESS_CONTROL`);
    assert.equal(n.dacl.isNull, true);
    assert.equal(n.dacl.aces.length, 0);
    assert.equal(parseSddl(`O:BAG:SYD:P`).dacl.aces.length, 0);
    assert.equal(normalizeSid(parseSddl('O:BAG:SY').owner), SID_ADMINS);
  });

  test('selfcheck: P-DIR oracle', () => {
    assert.deepEqual(classifyDir(P, dir(P, `O:${A}G:${A}D:P(A;OICI;FA;;;${A})`), A), { cls: 'ok', reason: null });
    assert.equal(classifyDir(P, dir(P, `O:${B}G:${B}D:P(A;OICI;FA;;;${A})`), A).reason, 'owner');
    assert.equal(classifyDir(P, dir(P, `O:BAG:BAD:P(A;OICI;FA;;;${A})`), A).reason, 'owner');
    assert.equal(classifyDir(P, dir(P, `O:${A}G:${A}D:P(A;OICI;FA;;;${A})(A;OICI;0x1200a9;;;${B})`), A).reason, 'foreign-allow');
    assert.equal(classifyDir(P, dir(P, `O:${A}G:${A}D:NO_ACCESS_CONTROL`), A).reason, 'null-dacl');
    assert.equal(classifyDir(P, dir(P, `O:${A}G:${A}D:P`), A).reason, 'no-owner-ace');
    assert.equal(classifyDir(P, dir(P, `O:${A}G:${A}D:AI(A;OICIID;FA;;;${A})`), A).reason, 'not-protected');
    assert.equal(classifyDir(P, dir(P, `O:${A}G:${A}D:P(A;OICI;FA;;;${A})(XA;OICI;FR;;;${A};(Member_of {SID(BU)}))`), A).reason, 'unknown-ace');
    assert.equal(classifyDir(P, dir(P, `O:${A}G:${A}D:P(A;;FA;;;${A})`), A).reason, 'no-owner-ace');
    assert.equal(classifyDir(P, dir(P, `O:${A}G:${A}D:P(A;OICI;FA;;;${A})(D;OICI;FA;;;${B})`), A).cls, 'ok');
    assert.equal(classifyDir(P, dir(P, '', { isReparse: true }), A).reason, 'reparse');
    assert.equal(classifyDir(P, dir(P, '', { ancestorReparse: true }), A).reason, 'ancestor-reparse');
    assert.equal(classifyDir(P, dir(P, '', { persistentAcls: false }), A).reason, 'non-acl-volume');
    assert.equal(classifyDir(P, { ...base, openError: 2 }, A).cls, 'missing');
    assert.equal(classifyDir(P, { ...base, openError: 5 }, A).cls, 'error');
    assert.equal(classifyDir(P, dir('D:\\a\\_temp\\psp1167-1-ab\\fx\\x-long', `O:${A}G:${A}D:P(A;OICI;FA;;;${A})`), A).reason, 'final-path-mismatch');
    assert.equal(classifyDir(P, file(P, `O:${A}G:${A}D:P(A;OICI;FA;;;${A})`), A).reason, 'not-dir');
  });

  test('selfcheck: P-FILE oracle', () => {
    assert.equal(classifyFile(P, file(P, `O:${A}G:${A}D:AI(A;ID;FA;;;${A})`), A).cls, 'ok');
    assert.equal(classifyFile(P, file(P, `O:${A}G:${A}D:AI(A;ID;FA;;;${A})(A;ID;FR;;;${B})`), A).reason, 'foreign-allow');
    assert.equal(classifyFile(P, file(P, `O:${A}G:${A}D:P`), A).cls, 'unavailable');
    assert.equal(classifyFile(P, file(P, `O:${A}G:${A}D:NO_ACCESS_CONTROL`), A).reason, 'null-dacl');
    assert.equal(classifyFile(P, file(P, `O:${A}G:${A}D:P(A;;FR;;;${A})`), A).reason, 'no-owner-rw-ace');
    assert.equal(classifyFile(P, file(P, `O:${A}G:${A}D:P(A;;FA;;;${A})`, { nLinks: 2 }), A).reason, 'hardlink');
    assert.equal(classifyFile(P, dir(P, `O:${A}G:${A}D:P(A;;FA;;;${A})`), A).reason, 'not-file');
    assert.equal(classifyFile(P, file(P, `O:${A}G:${A}D:P(A;;0x12019f;;;${A})`), A).cls, 'ok');
  });

  test('selfcheck: path grammar refusals', () => {
    assert.equal(grammarRefusal('\\\\?\\D:\\a'), 'prefix');
    assert.equal(grammarRefusal('\\\\.\\D:\\a'), 'prefix');
    assert.equal(grammarRefusal('\\\\localhost\\D$\\a'), 'prefix');
    assert.equal(grammarRefusal('D:\\a\\f.bin:alt'), 'colon');
    assert.equal(grammarRefusal('D:\\a\\d::$INDEX_ALLOCATION'), 'colon');
    assert.equal(grammarRefusal('D:\\a\\d.'), 'trailing-dot-or-space');
    assert.equal(grammarRefusal('D:\\a\\d '), 'trailing-dot-or-space');
    assert.equal(grammarRefusal('D:\\a\\CON'), 'reserved-name');
    assert.equal(grammarRefusal('D:\\a\\nul.txt'), 'reserved-name');
    assert.equal(grammarRefusal('D:\\a\\..\\b'), 'dot-component');
    assert.equal(grammarRefusal('relative\\x'), 'not-drive-absolute');
    assert.equal(grammarRefusal('D:\\a\\DIROKL~1'), null);
    assert.equal(finalPathMatches('D:\\a\\b', '\\\\?\\d:\\A\\B'), true);
    assert.equal(finalPathMatches('D:\\a\\DIROKL~1', '\\\\?\\D:\\a\\dir-ok-longname-1167'), false);
  });

  test('selfcheck: ABI normalizer rejects unknown shapes', () => {
    const okr = { status: 'ok', reason: 'ok', win32Error: 0 };
    assert.equal(normalizeResult(okr).abiOk, true);
    assert.equal(normalizeResult({ ...okr, bytes: Buffer.from('x') }).bytesSha256, sha256(Buffer.from('x')));
    assert.equal(normalizeResult({ ...okr, status: 'weird' }).abiOk, false);
    assert.equal(normalizeResult({ status: 'ok' }).abiOk, false);
    assert.equal(normalizeResult('ok').abiOk, false);
    assert.equal(normalizeResult({ ...okr, bytes: 'text' }).abiOk, false);
    assert.equal(normalizeResult({ status: 'exists', reason: 'already_exists', win32Error: 80, created: false }).created, false);
  });

  test('selfcheck: candidate expectation table covers every fixture id and never expects ok on a defect', () => {
    for (const [id, e] of Object.entries(CANDIDATE_EXPECT)) {
      assert.ok(Array.isArray(e.reasons) && e.reasons.length > 0, id);
      if (e.status) assert.notEqual(e.status, 'ok', id);
      if (!['D_OK', 'D_NEST_OK', 'F_OK', 'C_DIR', 'C_DIR_INSPECT', 'C_FILE', 'C_FILE_READ'].includes(id)) assert.ok(!e.reasons.includes('ok'), id);
    }
    assert.equal(expectedHelperStatus('F_NOT_FILE', 'unsafe'), 'unavailable');
    assert.equal(expectedHelperStatus('D_OK', 'ok'), 'ok');
  });
}

// ------------------------------------------------------------------ phase: helper (as fake user A)
if (PHASE === 'helper') {
  const env = process.env;
  const manifest = readJson(env.PSP_MANIFEST);
  const receiptPath = env.PSP_HELPER_RECEIPT;
  const receipt = { schema: 'aigentry/1167-psp-helper-receipt/v1', phase: 'helper', platform: process.platform, arch: process.arch, node: process.version,
    helperPath: env.PSP_HELPER_PATH, expectedSha256: env.PSP_HELPER_SHA256, actualSha256: null, loaded: false, loadError: null, exportsPresent: null,
    wrapperPath: env.PSP_WRAPPER_PATH, wrapperExpectedSha256: env.PSP_WRAPPER_SHA256, wrapperActualSha256: null, wrapperAbiTag: null, loadStatus: null,
    abi: ABI, createdContentSha256: null, results: [] };
  const save = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  let helper = null;

  test('helper phase runs on win32 as a non-admin fake user', () => {
    assert.equal(process.platform, 'win32');
    save();
  });

  test('wrapper and binary sha256 match their pins before load; loadPrivateStorage returns the four operations', async () => {
    receipt.actualSha256 = sha256(fs.readFileSync(env.PSP_HELPER_PATH));
    receipt.wrapperActualSha256 = sha256(fs.readFileSync(env.PSP_WRAPPER_PATH));
    save();
    assert.ok(/^[0-9a-f]{64}$/.test(env.PSP_HELPER_SHA256 || ''), 'expected helper sha256 missing');
    assert.equal(receipt.actualSha256, env.PSP_HELPER_SHA256, 'helper binary differs from compile-job hash: not loaded');
    assert.equal(receipt.wrapperActualSha256, env.PSP_WRAPPER_SHA256, 'wrapper differs from its pin: not imported');
    try {
      const mod = await import(pathToFileURL(env.PSP_WRAPPER_PATH).href);
      receipt.wrapperAbiTag = mod.ABI_TAG;
      const loaded = mod.loadPrivateStorage({ binaryPath: env.PSP_HELPER_PATH, sha256: env.PSP_HELPER_SHA256 });
      receipt.loadStatus = { status: loaded.status, reason: loaded.reason || null, win32Error: loaded.win32Error ?? null };
      if (loaded.status === 'ok') { helper = loaded.api; receipt.loaded = true; }
    } catch (e) { receipt.loadError = `${e && e.name}:${e && e.code}`; }
    receipt.exportsPresent = helper ? Object.fromEntries(ABI.exports.map((k) => [k, typeof helper[k] === 'function'])) : null;
    save();
    assert.equal(receipt.wrapperAbiTag, ABI.abiTag, 'wrapper ABI tag differs');
    assert.equal(receipt.loaded, true, `helper failed to load: ${JSON.stringify(receipt.loadStatus)} ${receipt.loadError}`);
    for (const k of ABI.exports) assert.equal(typeof helper[k], 'function', `helper export ${k} missing`);
  });

  for (const c of asArray(manifest.cases)) {
    test(`helper case ${c.id}: ${c.op} expected ${c.intent}`, async () => {
      const r = { id: c.id, op: c.op, path: c.path, intent: c.intent, threw: false, errorName: null, errorCode: null, result: null, inputSha256: null, ms: null };
      receipt.results.push(r);
      if (!c.path) { r.notRun = 'fixture unavailable'; save(); assert.fail(`${c.id}: essential fixture unavailable (HOLD)`); }
      assert.ok(helper, 'helper not loaded');
      let input = null;
      if (c.op === 'createPrivateFileExclusive') {
        input = crypto.randomBytes(48);
        r.inputSha256 = sha256(input);
        if (c.id === 'C_FILE') receipt.createdContentSha256 = r.inputSha256;
      }
      const t0 = process.hrtime.bigint();
      try {
        let res;
        if (c.op === 'readPrivateFile') res = helper.readPrivateFile(c.path, ABI.readMax);
        else if (c.op === 'createPrivateFileExclusive') res = helper.createPrivateFileExclusive(c.path, input);
        else res = helper[c.op](c.path);
        if (res && typeof res.then === 'function') { r.returnedPromise = true; res = await res; }
        r.result = normalizeResult(res);
      } catch (e) { r.threw = true; r.errorName = e && e.name; r.errorCode = e && e.code; }
      r.ms = Number(process.hrtime.bigint() - t0) / 1e6;
      save();
      assert.equal(r.threw, false, `${c.id}: helper threw (${r.errorName})`);
      assert.equal(r.result.abiOk, true, `${c.id}: result shape not in provisional ABI (${JSON.stringify(r.result)})`);
      const want = expectedHelperStatus(c.id, c.intent);
      const e = CANDIDATE_EXPECT[c.id];
      assert.equal(r.returnedPromise, undefined, `${c.id}: README says synchronous, got a promise`);
      assert.equal(r.result.status, want, `${c.id}: helper ${r.result.status}/${r.result.reason} != expected ${want}`);
      assert.ok(e && e.reasons.includes(r.result.reason), `${c.id}: reason ${r.result.reason} not in ${e && e.reasons}`);
      if (c.intent !== 'ok' || c.op !== 'readPrivateFile') assert.equal(r.result.bytesLength, 0, `${c.id}: bytes returned on a non-read or refused call`);
    });
  }
}

// ------------------------------------------------------------------ phase: verdict (admin, receipts only)
if (PHASE === 'verdict') {
  const dir = process.env.PSP_RECEIPTS_DIR;
  const load = (name) => { const p = path.join(dir, name); return fs.existsSync(p) ? readJson(p) : null; };
  const manifest = load('manifest.json');
  const env = load('env.json');
  const run = load('run.json');
  const snaps = Object.fromEntries(['S0', 'S1', 'S2', 'S3'].map((t) => [t, load(`snap-${t}.json`)]));
  const snapIndex = (tag) => new Map(asArray(snaps[tag] && snaps[tag].objects).map((o) => [String(o.path).toLowerCase(), o]));
  const idx = Object.fromEntries(Object.keys(snaps).map((t) => [t, snapIndex(t)]));
  const get = (tag, p) => (p ? idx[tag].get(String(p).toLowerCase()) : undefined);
  const helperReceipt = load('helper-receipt.json');
  const sidA = manifest && manifest.sids.A;
  const sidB = manifest && manifest.sids.B;
  const cases = manifest ? asArray(manifest.cases) : [];
  const results = new Map(asArray(helperReceipt && helperReceipt.results).map((r) => [r.id, r]));

  test('verdict: required receipts exist', () => {
    const required = ['run.json', 'env.json', 'manifest.json', 'snap-S0.json', 'snap-S1.json', 'snap-S2.json', 'snap-S3.json', 'identity-A.json', 'identity-B.json',
      'probe-Actl.json', 'probe-B1.json', 'probe-B2.json', 'move-measure.json', 'helper-receipt.json'];
    const missing = required.filter((f) => !fs.existsSync(path.join(dir, f)));
    assert.deepEqual(missing, [], `missing receipts: ${missing.join(', ')}`);
  });

  test('verdict: every orchestration stage before the verdict completed', () => {
    const bad = asArray(run && run.stages).filter((s) => s.status !== 'ok').map((s) => `${s.name}=${s.status}:${s.error}`);
    assert.deepEqual(bad, []);
  });

  test('verdict: helper ABI confirmed from the candidate and every case has an exact expectation', () => {
    assert.ok(ABI.confirmedBy, 'ABI.confirmedBy is null');
    const unmapped = cases.map((c) => c.id).filter((id) => !CANDIDATE_EXPECT[id]);
    assert.deepEqual(unmapped, []);
  });

  test('verdict: wrapper hash and ABI tag matched before load', () => {
    assert.ok(helperReceipt, 'no helper receipt');
    assert.equal(helperReceipt.wrapperActualSha256, helperReceipt.wrapperExpectedSha256);
    assert.equal(helperReceipt.wrapperAbiTag, ABI.abiTag);
    assert.equal(helperReceipt.loadStatus && helperReceipt.loadStatus.status, 'ok');
  });

  test('verdict: helper binary hash matched before load', () => {
    assert.ok(env && env.helper && env.helper.present, 'helper binary not supplied');
    assert.equal(env.helper.matches, true, 'helper sha256 != compile-job output');
    assert.ok(helperReceipt, 'no helper receipt');
    assert.equal(helperReceipt.actualSha256, env.helper.expectedSha256.toLowerCase());
    assert.equal(helperReceipt.loaded, true);
  });

  for (const who of ['A', 'B']) {
    test(`verdict: fake user ${who} is a distinct standard account without bypass privileges`, () => {
      const idr = load(`identity-${who}.json`);
      assert.ok(idr, `identity-${who} receipt missing`);
      assert.equal(idr.ok, true, `identity child failed: ${idr.error}`);
      assert.equal(idr.userSid, who === 'A' ? sidA : sidB);
      assert.notEqual(sidA, sidB);
      assert.equal(idr.isAdministratorRole, false);
      assert.ok(!asArray(idr.groupSids).includes(SID_ADMINS), 'token carries BUILTIN\\Administrators');
      const privs = asArray(idr.privileges).map((p) => p.name);
      assert.ok(privs.length > 0, 'whoami /priv not measured');
      const held = DANGEROUS_PRIVILEGES.filter((p) => privs.includes(p));
      assert.deepEqual(held, [], `bypass privileges present: ${held.join(',')}`);
    });
  }

  test('verdict: every essential fixture is available (unavailable => HOLD, never skipped)', () => {
    assert.ok(manifest, 'manifest missing');
    assert.deepEqual(asArray(manifest.unavailable), []);
    for (const c of cases) assert.ok(c.path, `${c.id} has no requested path`);
  });

  const probeFile = { 'probe-Actl.json': 'A positive control', 'probe-B1.json': 'B on pre-existing A objects', 'probe-B2.json': 'B on helper-created objects' };
  for (const [file, label] of Object.entries(probeFile)) {
    test(`verdict: ${label}: numeric Win32 codes equal expectations`, () => {
      const pr = load(file);
      assert.ok(pr && pr.ok, `${file} missing or child failed`);
      const rs = asArray(pr.results);
      assert.ok(rs.length > 0, 'no operations recorded');
      const wrong = rs.filter((r) => r.code !== r.expect).map((r) => `${r.id}: got ${r.code}, expected ${r.expect}`);
      assert.deepEqual(wrong, []);
      if (file !== 'probe-Actl.json') {
        const denials = rs.filter((r) => r.expect !== 0);
        assert.ok(denials.length >= 12, 'denial plan incomplete');
        for (const r of denials) assert.equal(r.code, ERROR_ACCESS_DENIED, r.id);
        if (file === 'probe-B1.json') assert.ok(rs.some((r) => r.id === 'Bself-create' && r.code === 0), 'B self positive control missing');
      }
    });
  }

  // Oracle expectation per case. Existing objects: S0 snapshot; created objects: S2 snapshot.
  function oracleFor(c) {
    if (!c.path) return verdictOf('error', 'fixture-unavailable');
    if (c.defect === 'non-acl-volume' && !c.snapshot) {
      const vhd = asArray(manifest.vhd).find((v) => c.path.toLowerCase().startsWith(String(v.root).toLowerCase()));
      return vhd && vhd.persistentAcls === false ? verdictOf('unsafe', 'non-acl-volume') : verdictOf('error', 'vhd-flags-unmeasured');
    }
    if (c.intent === 'exists') {
      const g = grammarRefusal(c.path); if (g) return verdictOf('unsafe', `grammar:${g}`);
      const s = get(c.id === 'C_DANGLING' ? 'S0' : 'S2', c.path);
      return s && s.openError === 0 ? verdictOf('exists', 'exists') : verdictOf('error', 'object-not-present');
    }
    const tag = c.phase === 'create' ? 'S2' : 'S0';
    const s = c.snapshot ? get(tag, c.path) : null;
    const asDir = c.op === 'inspectDir' || c.op === 'createPrivateDir';
    return asDir ? classifyDir(c.path, s, sidA) : classifyFile(c.path, s, sidA);
  }

  for (const c of cases) {
    test(`verdict: oracle confirms fixture ${c.id} is ${c.intent}${c.defect ? ` (${c.defect})` : ''}`, () => {
      const o = oracleFor(c);
      assert.equal(o.cls, c.intent, `oracle ${o.cls}/${o.reason}`);
      if (c.defect && c.intent !== 'ok') assert.equal(o.reason, c.defect, 'fixture defect is not the single intended defect');
    });
  }

  const POSITIVE = ['D_OK', 'D_NEST_OK', 'F_OK', 'C_DIR', 'C_DIR_INSPECT', 'C_FILE', 'C_FILE_READ'];
  test('verdict: positive controls succeed (otherwise every refusal is non-evidential)', () => {
    const bad = POSITIVE.filter((id) => { const r = results.get(id); return !r || !r.result || r.result.status !== 'ok'; });
    assert.deepEqual(bad, []);
  });

  for (const c of cases) {
    test(`verdict: helper ${c.id} ${c.op} equals oracle`, () => {
      const r = results.get(c.id);
      assert.ok(r, 'no helper result');
      assert.equal(r.threw, false, 'helper threw');
      assert.ok(r.result && r.result.abiOk, 'result outside ABI');
      const o = oracleFor(c);
      const e = CANDIDATE_EXPECT[c.id];
      assert.ok(e, 'no candidate expectation');
      assert.equal(r.result.status, expectedHelperStatus(c.id, o.cls), `helper ${r.result.status}/${r.result.reason} vs oracle ${o.cls}/${o.reason}`);
      assert.ok(e.reasons.includes(r.result.reason), `reason ${r.result.reason} not in [${e.reasons}]`);
      if (typeof e.created === 'boolean') assert.equal(r.result.created, e.created, 'created flag');
      if (r.result.status === 'ok') assert.ok(/^[0-9a-f]{16}$/.test(r.result.volumeSerial) && /^[0-9a-f]{32}$/.test(r.result.fileId), 'ok without FileIdInfo');
      if (c.op === 'readPrivateFile' && o.cls === 'ok') {
        const want = c.id === 'F_OK' ? manifest.content.F_OK : helperReceipt.createdContentSha256;
        assert.equal(r.result.bytesSha256, want, 'bytes read differ from fixture content');
        const s = get(c.phase === 'create' ? 'S2' : 'S0', c.object);
        assert.equal(r.result.bytesSha256, s && s.sha256, 'bytes read differ from oracle content hash');
      } else {
        assert.equal(r.result.bytesLength, 0, 'bytes returned on refused/non-read call');
      }
    });
  }

  test('verdict: pre-existing fixtures unchanged S0 -> S1 -> S2 -> S3 (sha256, SDDL, links, type)', () => {
    const mutable = new Set(asArray(manifest.mutable).map((p) => p.toLowerCase()));
    const diffs = [];
    for (const p of asArray(manifest.snapshotObjects)) {
      if (mutable.has(p.toLowerCase())) continue;
      const seq = ['S0', 'S1', 'S2', 'S3'].map((t) => get(t, p));
      if (seq.some((s) => !s)) { diffs.push(`${p}: missing snapshot`); continue; }
      for (const k of ['openError', 'sha256', 'sddl', 'nLinks', 'isDir', 'isReparse', 'fileIndex']) {
        const vals = seq.map((s) => JSON.stringify(s[k]));
        if (new Set(vals).size !== 1) diffs.push(`${p}.${k}: ${vals.join(' -> ')}`);
      }
      if (seq[0].openError !== 0) diffs.push(`${p}: oracle could not open (${seq[0].openError})`);
    }
    assert.deepEqual(diffs, []);
  });

  test('verdict: helper-created objects satisfy the oracle predicates and stay unchanged through B probes', () => {
    const d = manifest.dirs.helperArea + '\\created-dir';
    const f = d + '\\created-file.bin';
    for (const t of ['S2', 'S3']) {
      assert.equal(classifyDir(d, get(t, d), sidA).cls, 'ok', `${t} created dir`);
      assert.equal(classifyFile(f, get(t, f), sidA).cls, 'ok', `${t} created file`);
    }
    assert.equal(get('S2', f).sha256, helperReceipt.createdContentSha256);
    assert.equal(get('S3', f).sha256, helperReceipt.createdContentSha256);
    for (const p of asArray(manifest.mustStayAbsent)) {
      for (const t of ['S2', 'S3']) { const s = get(t, p); assert.ok(s && (s.openError === 2 || s.openError === 3), `${p} exists at ${t}`); }
    }
  });

  test('verdict: feasibility measurements recorded (values reported, not judged)', () => {
    const mm = load('move-measure.json');
    assert.ok(mm && mm.ok && mm.measure, 'MoveFileExW descriptor measurement missing');
    assert.ok(env && typeof env.elevatedDefaultOwnerSddl === 'string', 'elevated default owner missing');
    const ia = load('identity-A.json');
    assert.ok(ia && ia.node && ia.node.exit === 0, 'win32 O_NOFOLLOW (as A) missing');
  });
}
