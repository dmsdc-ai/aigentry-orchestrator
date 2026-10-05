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
// 76e661ec...), bounded correction wc1167aca: README.md a1e1cd9f..., private-storage.mjs 76f7ab76...
// Load path: the wrapper's loadPrivateStorage({binaryPath, sha256}) -> { status:'ok', api }; api functions
// are synchronous, never throw, and return frozen { status, reason, win32Error, created?, volumeSerial?,
// fileId?, bytes? }. On create results `created` is true, false or null (UNKNOWN); null never equals an
// expected boolean below.
export const ABI = Object.freeze({
  confirmedBy: 'wc1167aca README.md a1e1cd9f957c0ed561da7e8c87ea341aafb524810e21874097ace70362c4fbcd + private-storage.mjs 76f7ab76f27e6f9d58f8df19499aab259a1cbdad8ac0d5089e01d7a05e77fc9f',
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
// `win32Error` (deviations only): the exact code is pinned on top of the per-reason code table.
export const CANDIDATE_EXPECT = Object.freeze({
  D_OK: { reasons: ['ok'] }, D_NEST_OK: { reasons: ['ok'] }, D_B_OWNED: { reasons: ['owner_mismatch'] },
  D_B_ACE: { reasons: ['ace_foreign_allow'] }, D_NULL: { reasons: ['dacl_null'] },
  D_EMPTY: { status: 'unavailable', reasons: ['open_failed'], win32Error: 5, deviation: 'measured CI 37241273202: the inspectDir leaf open (READ_CONTROL|FILE_READ_ATTRIBUTES) of an empty-DACL dir is denied before the DACL checks -> unavailable/open_failed/5 (README: Win32 failure, fail closed); oracle class stays unsafe/no-owner-ace. COVERAGE GAP: the native dir dacl_empty branch is not exercised live and this refusal does not cover it' },
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

// Intended Win32 code per helper reason (README a1e1cd9f "win32Error" + C ps_set sites): predicate results
// carry 0; not_found 2/3; already_exists 80/183; open_failed is ERROR_ACCESS_DENIED (directory leaf without
// BACKUP_SEMANTICS, empty-DACL file). A reason without a documented code returns null => fail (HOLD).
export const WIN32_BY_REASON = Object.freeze({ not_found: [2, 3], already_exists: [80, 183], open_failed: [5] });
const PREDICATE_REASONS = ['ok', 'owner_mismatch', 'ace_foreign_allow', 'dacl_null', 'dacl_empty', 'dacl_not_protected', 'ace_unsupported',
  'reparse_point', 'ancestor_reparse_point', 'not_directory', 'final_path_mismatch', 'path_grammar', 'link_count', 'acl_not_persistent'];
export function expectedWin32(reason) {
  if (Object.hasOwn(WIN32_BY_REASON, reason)) return WIN32_BY_REASON[reason];
  return PREDICATE_REASONS.includes(reason) ? [0] : null;
}

const PHASE = process.env.PSP_PHASE || 'selfcheck';
const ERROR_ACCESS_DENIED = 5;
const DANGEROUS_PRIVILEGES = ['SeBackupPrivilege', 'SeRestorePrivilege', 'SeTakeOwnershipPrivilege', 'SeDebugPrivilege'];
const SID_ADMINS = 'S-1-5-32-544';
const SID_SYSTEM = 'S-1-5-18';

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

// ------------------------------------------------------------------ verdict rules (pure; synthetic-tested)
// R4: one helper result against its exact expectation, including the intended Win32 code. [] = pass.
export function helperResultProblems(id, r, want) {
  const e = CANDIDATE_EXPECT[id];
  if (!e) return ['no candidate expectation'];
  if (!r) return ['no helper result'];
  if (r.threw) return ['helper threw'];
  const x = r.result;
  if (!x || !x.abiOk) return ['result outside ABI'];
  const p = [];
  if (x.status !== want) p.push(`status ${x.status}/${x.reason} != ${want}`);
  if (!e.reasons.includes(x.reason)) p.push(`reason ${x.reason} not in [${e.reasons}]`);
  const codes = expectedWin32(x.reason);
  if (!codes) p.push(`reason ${x.reason} has no documented Win32 code (HOLD)`);
  else if (!codes.includes(x.win32Error)) p.push(`win32Error ${x.win32Error} not in [${codes}] for ${x.reason}`);
  if (Number.isInteger(e.win32Error) && x.win32Error !== e.win32Error) p.push(`win32Error ${x.win32Error} != pinned ${e.win32Error}`);
  if (typeof e.created === 'boolean' && x.created !== e.created) p.push(`created ${x.created} != ${e.created}`);
  return p;
}

// R3/R5: a probe receipt comes from the expected runtime SID, ran exactly the planned operations, matched
// every expected code, and carries its own positive controls (a child that denies everything fails).
export function probeProblems(receipt, plan, { sid, selfIds = [], minDenials = 0 }) {
  if (!receipt || receipt.ok !== true) return ['receipt missing or child failed'];
  const p = [];
  if (typeof sid !== 'string' || receipt.userSid !== sid) p.push(`runtime SID ${receipt.userSid} != ${sid}`);
  const rs = asArray(receipt.results);
  if (rs.length === 0) p.push('no operations recorded');
  const want = asArray(plan).map((o) => `${o.id}:${o.expect}`).join('|');
  if (rs.map((r) => `${r.id}:${r.expect}`).join('|') !== want) p.push('operations differ from the manifest plan');
  for (const r of rs) if (r.code !== r.expect) p.push(`${r.id}: got ${r.code}, expected ${r.expect}`);
  const denials = rs.filter((r) => r.expect !== 0);
  if (denials.length < minDenials) p.push(`denial plan incomplete (${denials.length} < ${minDenials})`);
  for (const r of denials) if (r.expect !== ERROR_ACCESS_DENIED) p.push(`${r.id}: expectation ${r.expect} is not ERROR_ACCESS_DENIED`);
  for (const id of selfIds) if (!rs.some((r) => r.id === id && r.expect === 0 && r.code === 0)) p.push(`positive control ${id} missing or failed`);
  return p;
}

// R5: a non-probe launch (identity, move-measure, helper node run) ran as the expected SID; node exit 0.
export function launchProblems(receipt, sid, { node = false } = {}) {
  if (!receipt) return ['receipt missing'];
  const p = [];
  if (typeof sid !== 'string' || receipt.userSid !== sid) p.push(`runtime SID ${receipt.userSid} != ${sid}`);
  if (receipt.ok !== true) p.push('child not ok');
  if (node && receipt.nodeExit !== 0) p.push(`nodeExit ${receipt.nodeExit} != 0`);
  return p;
}

// R5 binding: every captured child self-report must match exactly one ADMIN-OBSERVED launch (launches.json,
// written by the elevated launcher into the trusted receipts dir): exact tag sequence, user, mode, launched,
// not timed out, launcher exit 0. A self-report rewritten in the outbox cannot outvote the launcher.
export const EXPECTED_LAUNCHES = Object.freeze([['identity-A', 'A', 'identity'], ['identity-B', 'B', 'identity'], ['probe-Actl', 'A', 'probe'],
  ['move-measure', 'A', 'move-measure'], ['probe-Atrust', 'A', 'probe'], ['probe-Btrust', 'B', 'probe'], ['probe-B1', 'B', 'probe'],
  ['helper-run', 'A', 'node-test'], ['probe-B2', 'B', 'probe']]);
export function launchBindingProblems(launches, users, receipts) {
  const ls = asArray(launches);
  const p = [];
  const tags = ls.map((l) => (l && typeof l === 'object' ? l.tag : null));
  if (tags.join('|') !== EXPECTED_LAUNCHES.map((e) => e[0]).join('|')) p.push(`admin-observed launch sequence [${tags}] differs from the plan`);
  for (const [tag, who, mode] of EXPECTED_LAUNCHES) {
    const hits = ls.filter((l) => l && l.tag === tag);
    if (hits.length !== 1) { p.push(`${tag}: ${hits.length} admin-observed launches (exactly 1 required)`); continue; }
    const l = hits[0];
    const name = users && users[who] && users[who].name;
    if (typeof name !== 'string' || l.user !== name) p.push(`${tag}: launched as ${l.user}, expected ${name}`);
    if (l.mode !== mode) p.push(`${tag}: launch mode ${l.mode} != ${mode}`);
    if (l.launched !== true) p.push(`${tag}: not launched`);
    if (l.timedOut !== false) p.push(`${tag}: timedOut ${l.timedOut}`);
    if (l.exitCode !== 0) p.push(`${tag}: launcher-observed exitCode ${l.exitCode} != 0`);
    const r = receipts && receipts[tag];
    if (!r || r.ok !== true) p.push(`${tag}: captured self-report missing or not ok`);
    else if (r.mode !== mode) p.push(`${tag}: self-report mode ${r.mode} != ${mode}`);
    else if (mode === 'node-test' && r.nodeExit !== 0) p.push(`${tag}: self-reported nodeExit ${r.nodeExit} != 0`);
  }
  return p;
}

// Non-empty guards: a missing or empty run/snapshot record is never a vacuous pass.
export const REQUIRED_STAGES = Object.freeze(['environment', 'fake-users', 'fixtures', 'snapshot-S0', 'identity-A', 'identity-B', 'controls-A',
  'move-measure-A', 'trust-probe-A', 'trust-probe-B', 'probe-B1', 'snapshot-S1', 'helper-as-A', 'snapshot-S2', 'probe-B2', 'snapshot-S3']);
export function stageProblems(run) {
  const st = asArray(run && run.stages);
  if (st.length === 0) return ['no orchestration stages recorded'];
  const p = st.filter((s) => !s || s.status !== 'ok').map((s) => `${s && s.name}=${s && s.status}:${s && s.error}`);
  for (const n of REQUIRED_STAGES) { const k = st.filter((s) => s && s.name === n).length; if (k !== 1) p.push(`stage ${n} recorded ${k} times`); }
  return p;
}
export function snapshotSetProblems(snaps) {
  return ['S0', 'S1', 'S2', 'S3'].filter((t) => asArray(snaps && snaps[t] && snaps[t].objects).length === 0).map((t) => `snap-${t} missing or empty`);
}

// R7: measured, never whitelisted. CONTRACT-r2 §3 says B runs with no privileges enabled.
export function enabledPrivileges(idr) {
  return asArray(idr && idr.privileges).filter((x) => /^enabled$/i.test(String(x && x.state))).map((x) => x.name);
}

// R6: independent read-back vs the backup-handle oracle. A contradiction fails; anything not read back is
// listed as unproved (the contract's Get-Acl/fsutil oracle is then NOT complete; never waived here).
// A non-directory reparse object is refused (reparse_point) before the link count is evaluated (README leaf step 2),
// so its link count is not a gated property: its read-back is the fsutil reparsepoint query, which must succeed (below).
export function readbackFindings(objects) {
  const contradictions = []; const unproved = [];
  for (const o of asArray(objects)) {
    if (!o || o.openError !== 0) continue;
    if (typeof o.getAclSddl === 'string') {
      if (o.getAclSddl !== o.sddl) {
        if (o.isReparse) unproved.push(`${o.path}: Get-Acl differs on a reparse point (may resolve the target)`);
        else contradictions.push(`${o.path}: Get-Acl ${o.getAclSddl} != oracle ${o.sddl}`);
      }
    } else unproved.push(`${o.path}: Get-Acl unavailable (${o.getAclError || 'not measured'})`);
    if (!o.isDir && !o.isReparse) {
      if (o.fsutilHardlinkExit === 0) {
        const n = asArray(o.fsutilHardlinks).length;
        if (n !== o.nLinks) contradictions.push(`${o.path}: fsutil lists ${n} links, oracle nLinks ${o.nLinks}`);
      } else unproved.push(`${o.path}: fsutil hardlink list exit ${o.fsutilHardlinkExit}`);
    }
    if (o.fsutilReparseExit === 0 && !o.isReparse) contradictions.push(`${o.path}: fsutil reports a reparse point, oracle does not`);
    if (o.isReparse && o.fsutilReparseExit !== 0) unproved.push(`${o.path}: fsutil reparsepoint query exit ${o.fsutilReparseExit}`);
  }
  return { contradictions, unproved };
}

// R2 trusted objects (twin: setup-fixtures.ps1 Test-PspTrustedSddl). Owner listed; DACL present, non-NULL
// (protected when asked); only allow/deny ACEs; every allow ACE is SYSTEM/Administrators, or a listed
// reader with no write/append/EA/attribute/delete-child/DELETE/WRITE_DAC/WRITE_OWNER/GW/GA bit.
const WRITE_BITS = (0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000) >>> 0;
export function trustProblems(snap, { owners, readers = [], protectedDacl = false }) {
  if (!snap) return ['no snapshot'];
  if (snap.openError) return [`open-error-${snap.openError}`];
  const p = [];
  if (snap.isReparse) p.push('reparse');
  if (!snap.persistentAcls) p.push('non-acl-volume');
  const sd = parseSddl(snap.sddl);
  if (!sd) return [...p, 'sddl-unparsed'];
  const own = asArray(owners).map(normalizeSid);
  if (!own.includes(normalizeSid(sd.owner))) p.push(`owner:${normalizeSid(sd.owner)}`);
  if (!sd.dacl || sd.dacl.isNull) return [...p, 'null-or-absent-dacl'];
  if (protectedDacl && !sd.dacl.protected) p.push('not-protected');
  const rd = asArray(readers).map(normalizeSid);
  let allow = 0;
  for (const a of sd.dacl.aces) {
    if (a.type === 'D') continue;
    if (a.type !== 'A') { p.push(`ace-type:${a.type}`); continue; }
    allow++;
    if (a.sid === SID_ADMINS || a.sid === SID_SYSTEM) continue;
    const { mask, unknown } = parseRights(a.rights);
    if (rd.includes(a.sid) && !unknown && ((mask & WRITE_BITS) >>> 0) === 0) continue;
    p.push(`foreign-allow:${a.sid}:${a.rights}`);
  }
  if (allow === 0) p.push('no-allow-ace');
  return p;
}

// R2 cleanup state (twin: setup-fixtures.ps1 Test-PspCleanupState; same literals). Every rule must hold
// before cleanup may act; nothing is normalised. Filesystem facts (reparse) are checked only on the PS side.
export function validateCleanupState(st, { tempLong, runId }) {
  if (!st || typeof st !== 'object' || Array.isArray(st)) return ['state-null'];
  if (!/^\d+$/.test(String(runId))) return ['run-id'];
  if (Object.keys(st).sort().join(',') !== 'root,schema,users,vdisks') return ['state-keys'];
  const p = [];
  if (st.schema !== 'aigentry/1167-psp-state/v1') p.push('schema');
  let root = st.root;
  if (root !== null) {
    if (typeof root !== 'string') { p.push('root-type'); root = null; }
    else {
      const i = root.lastIndexOf('\\');
      if (i < 0 || !new RegExp(`^psp1167-${runId}-[0-9a-f]{8}$`).test(root.slice(i + 1))) p.push('root-leaf');
      if (i < 0 || root.slice(0, i) !== tempLong) p.push('root-parent');
      if (/[/]|\\\\|\\\.\.?(\\|$)|\\$/.test(root) || path.win32.normalize(root) !== root) p.push('root-not-canonical');
    }
  }
  const us = asArray(st.users);
  if (!Array.isArray(st.users)) p.push('users-type');
  if (us.length > 2) p.push('users-count');
  let first = null;
  for (let i = 0; i < Math.min(us.length, 2); i++) {
    const u = us[i];
    if (!u || typeof u !== 'object' || Object.keys(u).sort().join(',') !== 'name,sid') { p.push(`user${i}-shape`); continue; }
    if (typeof u.name !== 'string' || !/^psp[ab][0-9a-f]{6}$/.test(u.name) || u.name.slice(0, 4) !== ['pspa', 'pspb'][i]) { p.push(`user${i}-name`); continue; }
    if (typeof u.sid !== 'string' || !/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(u.sid) || Number(u.sid.slice(u.sid.lastIndexOf('-') + 1)) < 1000) { p.push(`user${i}-sid`); continue; }
    if (i === 0) first = u;
    else if (first) {
      if (u.name.slice(4) !== first.name.slice(4)) p.push('user-pair-suffix');
      if (u.sid.slice(0, u.sid.lastIndexOf('-')) !== first.sid.slice(0, first.sid.lastIndexOf('-'))) p.push('user-pair-domain');
      if (u.sid === first.sid) p.push('user-pair-sid');
    }
  }
  const vs = asArray(st.vdisks); const seen = [];
  if (!Array.isArray(st.vdisks)) p.push('vdisks-type');
  if (vs.length > 2) p.push('vdisks-count');
  for (const v of vs) {
    if (!v || typeof v !== 'object' || Object.keys(v).sort().join(',') !== 'attached,file,fs,letter') { p.push('vdisk-shape'); continue; }
    if (!['fat32', 'exfat'].includes(v.fs)) { p.push('vdisk-fs'); continue; }
    if (seen.includes(v.fs)) p.push('vdisk-duplicate');
    seen.push(v.fs);
    if (root === null || v.file !== `${root}\\vhd-${v.fs}.vhdx`) p.push(`vdisk-file:${v.fs}`);
    if (typeof v.letter !== 'string' || !/^[P-Y]$/.test(v.letter)) p.push('vdisk-letter');
  }
  return p;
}

// ------------------------------------------------------------------ verdict operand diagnostics (pure; DIAGNOSTIC only)
// One closed-grammar line per observed verdict check, written with t.diagnostic BEFORE the unchanged assertions and read
// back from verdict.tap by run-validation.ps1 Format-PspVerdictOpDiag (twin vocabulary, same literals). Untrusted until a
// verified export; never acceptance, never a waiver. Values are fixed enums, booleans, bounded integers and counts only:
// never a path, SID, user name, SDDL, message or raw receipt string. Anything outside a vocabulary prints UNKNOWN.
export const OP_PREFIX = 'psp-op/1';
// Official privilege constant names (winnt.h SE_*_NAME). Any other name is only counted.
export const OP_PRIVILEGES = Object.freeze(['SeAssignPrimaryTokenPrivilege', 'SeAuditPrivilege', 'SeBackupPrivilege', 'SeChangeNotifyPrivilege',
  'SeCreateGlobalPrivilege', 'SeCreatePagefilePrivilege', 'SeCreatePermanentPrivilege', 'SeCreateSymbolicLinkPrivilege', 'SeCreateTokenPrivilege',
  'SeDebugPrivilege', 'SeDelegateSessionUserImpersonatePrivilege', 'SeEnableDelegationPrivilege', 'SeImpersonatePrivilege',
  'SeIncreaseBasePriorityPrivilege', 'SeIncreaseQuotaPrivilege', 'SeIncreaseWorkingSetPrivilege', 'SeLoadDriverPrivilege', 'SeLockMemoryPrivilege',
  'SeMachineAccountPrivilege', 'SeManageVolumePrivilege', 'SeProfileSingleProcessPrivilege', 'SeRelabelPrivilege', 'SeRemoteShutdownPrivilege',
  'SeRestorePrivilege', 'SeSecurityPrivilege', 'SeShutdownPrivilege', 'SeSyncAgentPrivilege', 'SeSystemEnvironmentPrivilege',
  'SeSystemProfilePrivilege', 'SeSystemtimePrivilege', 'SeTakeOwnershipPrivilege', 'SeTcbPrivilege', 'SeTimeZonePrivilege',
  'SeTrustedCredManAccessPrivilege', 'SeUndockPrivilege', 'SeUnsolicitedInputPrivilege']);
// README a1e1cd9f "Reason strings" plus the wrapper reasons.
export const OP_HELPER_REASONS = Object.freeze(['ok', 'path_grammar', 'invalid_argument', 'not_found', 'already_exists', 'ancestor_open_failed',
  'ancestor_query_failed', 'ancestor_reparse_point', 'ancestor_not_directory', 'open_failed', 'create_failed', 'type_query_failed',
  'attributes_query_failed', 'reparse_point', 'not_directory', 'not_regular_file', 'link_count', 'volume_query_failed', 'acl_not_persistent',
  'final_path_query_failed', 'final_path_unrecognized', 'final_path_mismatch', 'final_path_compare_failed', 'security_query_failed', 'owner_mismatch',
  'dacl_absent', 'dacl_null', 'dacl_not_protected', 'dacl_invalid', 'dacl_empty', 'ace_unsupported', 'ace_foreign_allow', 'owner_ace_missing',
  'identity_query_failed', 'size_query_failed', 'size_limit', 'size_changed', 'read_failed', 'write_failed', 'short_write', 'flush_failed',
  'close_failed', 'token_open_failed', 'token_query_failed', 'token_sid_invalid', 'descriptor_build_failed', 'alloc_failed', 'internal_error',
  'platform_unsupported', 'binary_path_invalid', 'binary_hash_invalid', 'binary_unreadable', 'binary_hash_mismatch', 'load_failed', 'abi_mismatch',
  'native_threw', 'native_result_invalid']);
export const OP_ORACLE_CLASSES = Object.freeze(['ok', 'unsafe', 'missing', 'unavailable', 'exists', 'error']);
// Every literal oracle reason above; reasons carrying a numeric suffix print the prefix plus a bounded oracleCode.
export const OP_ORACLE_REASONS = Object.freeze(['grammar:empty', 'grammar:prefix', 'grammar:not-drive-absolute', 'grammar:colon',
  'grammar:empty-component', 'grammar:dot-component', 'grammar:trailing-dot-or-space', 'grammar:reserved-name', 'no-snapshot', 'missing',
  'ancestor-reparse', 'reparse', 'non-acl-volume', 'final-path-mismatch', 'owner', 'dacl-absent', 'null-dacl', 'unknown-ace', 'foreign-allow',
  'not-protected', 'no-owner-ace', 'empty-dacl', 'no-owner-rw-ace', 'not-dir', 'not-file', 'hardlink', 'fixture-unavailable', 'vhd-flags-unmeasured',
  'exists', 'object-not-present']);
export const OP_ORACLE_CODED = Object.freeze(['open-error', 'info-error', 'volume-error', 'final-path-error', 'sddl-error']);
export const OP_LAUNCH_MODES = Object.freeze(['identity', 'probe', 'move-measure', 'node-test']);

const opInt = (v) => (Number.isInteger(v) && v >= -2147483648 && v <= 4294967295 ? String(v) : (v === null || v === undefined ? 'none' : 'UNKNOWN'));
const opBool = (v) => (v === true ? 'true' : v === false ? 'false' : (v === null || v === undefined ? 'none' : 'UNKNOWN'));
const opEnum = (v, list) => (typeof v === 'string' && list.includes(v) ? v : (v === null || v === undefined ? 'none' : 'UNKNOWN'));
const opCount = (n) => String(Math.min(Number.isInteger(n) && n > 0 ? n : 0, 99999));
const OP_LINE = /^psp-op\/1 kind=[a-z]{1,16}(?: [A-Za-z]{1,24}=[A-Za-z0-9_.,:-]{1,1400})*$/;
export function opLine(kind, pairs) {
  const s = `${OP_PREFIX} kind=${kind}${pairs.map(([k, v]) => ` ${k}=${v}`).join('')}`;
  return s.length <= 1409 && OP_LINE.test(s) ? s : `${OP_PREFIX} kind=error`;
}

export function privOperands(who, idr) {
  const raw = idr && idr.privileges;
  const list = asArray(raw);
  const known = new Set();
  let enabled = 0; let disabled = 0; let otherState = 0; let unknownName = 0; let enabledUnknownName = 0;
  for (const x of list) {
    const name = x && x.name;
    const isKnown = typeof name === 'string' && OP_PRIVILEGES.includes(name);
    if (!isKnown) unknownName++;
    const st = String(x && x.state);   // the enabledPrivileges predicate
    if (/^enabled$/i.test(st)) { enabled++; if (isKnown) known.add(name); else enabledUnknownName++; }
    else if (/^disabled$/i.test(st)) disabled++;
    else otherState++;
  }
  const w = idr && idr.whoami && idr.whoami.priv;
  return opLine('priv', [['who', opEnum(who, ['A', 'B'])], ['receipt', idr ? 'present' : 'absent'],
    ['shape', raw === null || raw === undefined ? 'none' : (Array.isArray(raw) ? 'array' : 'single')], ['whoamiExit', opInt(w && w.exit)],
    ['entries', opCount(list.length)], ['enabled', opCount(enabled)], ['disabled', opCount(disabled)], ['otherState', opCount(otherState)],
    ['unknownName', opCount(unknownName)], ['enabledUnknownName', opCount(enabledUnknownName)],
    ['enabledKnown', known.size ? OP_PRIVILEGES.filter((p) => known.has(p)).join(',') : 'none']]);
}

export function launchOperands(tag, rec, sid, node) {
  return opLine('launch', [['tag', opEnum(tag, EXPECTED_LAUNCHES.map((e) => e[0]))], ['receipt', rec ? 'present' : 'absent'],
    ['sidMatch', rec ? opBool(typeof sid === 'string' && rec.userSid === sid) : 'none'], ['ok', opBool(rec && rec.ok)],
    ['mode', opEnum(rec && rec.mode, OP_LAUNCH_MODES)], ['nodeExit', opInt(rec && rec.nodeExit)],
    ['error', rec ? opBool(rec.error !== null && rec.error !== undefined) : 'none'], ['problems', opCount(launchProblems(rec, sid, { node }).length)]]);
}

export function helperRunOperands(hr) {
  const rs = asArray(hr && hr.results);
  const ls = hr && hr.loadStatus;
  return opLine('helperrun', [['receipt', hr ? 'present' : 'absent'], ['loaded', opBool(hr && hr.loaded)],
    ['loadStatus', opEnum(ls && ls.status, ABI.statuses)], ['loadReason', opEnum(ls && ls.reason, OP_HELPER_REASONS)],
    ['loadWinErr', opInt(ls && ls.win32Error)], ['loadError', hr ? opBool(hr.loadError !== null && hr.loadError !== undefined) : 'none'],
    ['results', opCount(rs.length)], ['threw', opCount(rs.filter((r) => r && r.threw === true).length)],
    ['abiBad', opCount(rs.filter((r) => !(r && r.result && r.result.abiOk === true)).length)],
    ['notRun', opCount(rs.filter((r) => r && r.notRun !== null && r.notRun !== undefined).length)],
    ['promise', opCount(rs.filter((r) => r && r.returnedPromise === true).length)]]);
}

export function bindOperands(launches, users, receipts) {
  const ls = asArray(launches);
  const tags = ls.map((l) => (l && typeof l === 'object' ? l.tag : null));
  const out = [opLine('bindseq', [['seq', tags.join('|') === EXPECTED_LAUNCHES.map((e) => e[0]).join('|') ? 'match' : 'differ'],
    ['entries', opCount(ls.length)], ['problems', opCount(launchBindingProblems(launches, users, receipts).length)]])];
  for (const [tag, who, mode] of EXPECTED_LAUNCHES) {
    const hits = ls.filter((l) => l && l.tag === tag);
    const l = hits.length === 1 ? hits[0] : null;
    const name = users && users[who] && users[who].name;
    const r = receipts && receipts[tag];
    out.push(opLine('bind', [['tag', tag], ['hits', opCount(hits.length)], ['user', l ? opBool(typeof name === 'string' && l.user === name) : 'none'],
      ['mode', l ? opBool(l.mode === mode) : 'none'], ['launched', opBool(l && l.launched)], ['timedOut', opBool(l && l.timedOut)],
      ['exit', opInt(l && l.exitCode)], ['launchError', opInt(l && l.launchError)],
      ['prerequisite', l ? opBool(l.prerequisite !== null && l.prerequisite !== undefined) : 'none'], ['self', r ? 'present' : 'absent'],
      ['selfOk', opBool(r && r.ok)], ['selfMode', r ? opBool(r.mode === mode) : 'none'], ['selfNodeExit', opInt(r && r.nodeExit)]]));
  }
  return out;
}

function opOracle(o) {
  if (!o || typeof o !== 'object') return ['UNKNOWN', 'UNKNOWN', 'none'];
  const cls = opEnum(o.cls, OP_ORACLE_CLASSES);
  if (o.reason === null) return [cls, 'none', 'none'];
  if (typeof o.reason === 'string') {
    if (OP_ORACLE_REASONS.includes(o.reason)) return [cls, o.reason, 'none'];
    for (const k of OP_ORACLE_CODED) {
      if (o.reason.startsWith(`${k}-`)) { const s = o.reason.slice(k.length + 1); return [cls, k, /^-?[0-9]{1,10}$/.test(s) ? opInt(Number(s)) : 'UNKNOWN']; }
    }
  }
  return [cls, 'UNKNOWN', 'none'];
}

export function helperOperands(c, r, o, want) {
  const id = c && c.id;
  const x = r && r.result;
  const [cls, reason, code] = opOracle(o);
  return opLine('helper', [['case', opEnum(id, Object.keys(CANDIDATE_EXPECT))], ['op', opEnum(c && c.op, ABI.exports)], ['result', r ? 'present' : 'absent'],
    ['threw', r ? opBool(r.threw) : 'none'], ['abiOk', opBool(x && x.abiOk)], ['status', opEnum(x && x.status, ABI.statuses)],
    ['reason', opEnum(x && x.reason, OP_HELPER_REASONS)], ['winErr', opInt(x && x.win32Error)], ['created', opBool(x && x.created)],
    ['bytes', opInt(x && x.bytesLength)],
    ['volId', x ? opBool(typeof x.volumeSerial === 'string' && /^[0-9a-f]{16}$/.test(x.volumeSerial) && typeof x.fileId === 'string' && /^[0-9a-f]{32}$/.test(x.fileId)) : 'none'],
    ['want', opEnum(want, OP_ORACLE_CLASSES)], ['oracle', cls], ['oracleReason', reason], ['oracleCode', code],
    ['problems', opCount(helperResultProblems(id, r, want).length)]]);
}

// Which parsed parts of two differing SDDL strings differ (normalized SIDs, flags sorted, rights as masks).
function sddlDiffKinds(a, b) {
  const x = parseSddl(a); const y = parseSddl(b);
  if (!x || !y) return ['unparsed'];
  const k = [];
  if (normalizeSid(x.owner) !== normalizeSid(y.owner)) k.push('owner');
  if (normalizeSid(x.group) !== normalizeSid(y.group)) k.push('group');
  if (!x.dacl || !y.dacl) { if (x.dacl !== y.dacl) k.push('daclFlags'); }
  else {
    if (x.dacl.isNull !== y.dacl.isNull || x.dacl.protected !== y.dacl.protected || x.dacl.autoInherited !== y.dacl.autoInherited) k.push('daclFlags');
    const key = (a2, withFlags) => { const m = parseRights(a2.rights); return [a2.type, withFlags ? [...a2.flags].sort().join('') : '', m.mask, m.unknown, a2.sid, a2.condition].join(';'); };
    const ax = x.dacl.aces.map((e) => key(e, true)); const ay = y.dacl.aces.map((e) => key(e, true));
    if (ax.length !== ay.length) k.push('aceCount');
    else if (ax.join('|') !== ay.join('|')) {
      if ([...ax].sort().join('|') === [...ay].sort().join('|')) k.push('aceOrder');
      else if (x.dacl.aces.map((e) => key(e, false)).sort().join('|') === y.dacl.aces.map((e) => key(e, false)).sort().join('|')) k.push('aceFlags');
      else k.push('aceSet');
    }
  }
  if (k.length === 0) k.push('textOnly');
  return k;
}

// Split of the daclFlags and aceOrder kinds above (same parser, same ACE key; those kinds are unchanged). daclFlags:
// which flag differs (protected / autoInherited / isNull), a DACL missing on one side, or an unparsed side. aceOrder:
// whether the relative order of every (deny, allow) ACE pair changed; Unknown when an ACE is not plain allow/deny or
// two ACEs share a key (pairs not identifiable).
function denyRelOrder(xa, ya) {
  const key = (a2) => { const m = parseRights(a2.rights); return [a2.type, [...a2.flags].sort().join(''), m.mask, m.unknown, a2.sid, a2.condition].join(';'); };
  const keys = (aces) => { const ks = aces.map(key); return new Set(ks).size === ks.length && aces.every((e) => e.type === 'A' || e.type === 'D') ? ks : null; };
  const pairs = (ks) => { const out = []; ks.forEach((d, i) => { if (d.startsWith('D;')) ks.forEach((a, j) => { if (a.startsWith('A;')) out.push(`${d}|${a}|${i < j}`); }); }); return out.sort().join('\n'); };
  const kx = keys(xa); const ky = keys(ya);
  if (!kx || !ky) return 'orderDenyRelUnknown';
  return pairs(kx) === pairs(ky) ? 'orderDenyRelUnchanged' : 'orderDenyRelChanged';
}
function sddlDiffSplit(a, b) {
  const x = parseSddl(a); const y = parseSddl(b);
  if (!x || !y) return ['flagUnparsed'];
  if (!x.dacl || !y.dacl) return x.dacl !== y.dacl ? ['flagMissing'] : [];
  const k = [];
  if (x.dacl.protected !== y.dacl.protected) k.push('flagProtected');
  if (x.dacl.autoInherited !== y.dacl.autoInherited) k.push('flagAutoInherited');
  if (x.dacl.isNull !== y.dacl.isNull) k.push('flagIsNull');
  const key = (a2) => { const m = parseRights(a2.rights); return [a2.type, [...a2.flags].sort().join(''), m.mask, m.unknown, a2.sid, a2.condition].join(';'); };
  const ax = x.dacl.aces.map(key); const ay = y.dacl.aces.map(key);
  if (ax.length === ay.length && ax.join('|') !== ay.join('|') && [...ax].sort().join('|') === [...ay].sort().join('|')) k.push(denyRelOrder(x.dacl.aces, y.dacl.aces));
  return k;
}
// Closed vocabulary of Get-Acl exception type names (setup-fixtures.ps1 getAclError = Exception.GetType().Name). Any
// other name is only counted (aclErrOther); a missing type is aclErrAbsent. Never the message text.
export const OP_ACL_ERROR_TYPES = Object.freeze(['UnauthorizedAccessException', 'PrivilegeNotHeldException', 'ItemNotFoundException',
  'FileNotFoundException', 'DirectoryNotFoundException', 'PathTooLongException', 'IOException', 'ArgumentException', 'NotSupportedException',
  'InvalidOperationException', 'SecurityException', 'Win32Exception']);

// R6 categories, mirroring readbackFindings branch by branch; totals come from readbackFindings itself.
export function readbackOperands(test, snaps, objects) {
  const n = { objects: 0, skipped: 0, aclMatch: 0, aclDiffNonReparse: 0, aclDiffReparse: 0, aclUnavailNonReparse: 0, aclUnavailReparse: 0, aclErrPresent: 0,
    hlMatch: 0, hlDiff: 0, hlReparse: 0, hlExitNonzero: 0, rpNotOracle: 0, rpExitNonzero: 0 };
  const d = { dir: 0, file: 0, owner: 0, group: 0, daclFlags: 0, aceCount: 0, aceOrder: 0, aceFlags: 0, aceSet: 0, textOnly: 0, unparsed: 0 };
  const sp = { flagProtected: 0, flagAutoInherited: 0, flagIsNull: 0, flagMissing: 0, flagUnparsed: 0, orderDenyRelChanged: 0, orderDenyRelUnchanged: 0,
    orderDenyRelUnknown: 0 };
  const ae = new Map(); let aeOther = 0; let aeAbsent = 0;
  const hist = () => ({ m: new Map(), other: 0 });
  const hl = hist(); const rp = hist();
  const bump = (h, v) => {
    if (opInt(v) !== String(v) || (!h.m.has(v) && h.m.size >= 4)) { h.other++; return; }
    h.m.set(v, (h.m.get(v) || 0) + 1);
  };
  const fmt = (h) => (h.m.size ? [...h.m].map(([v, k]) => `${v}:${opCount(k)}`).join(',') : 'none');
  for (const o of asArray(objects)) {
    n.objects++;
    if (!o || o.openError !== 0) { n.skipped++; continue; }
    if (typeof o.getAclSddl === 'string') {
      if (o.getAclSddl !== o.sddl) {
        if (o.isReparse) n.aclDiffReparse++;
        else {
          n.aclDiffNonReparse++;
          if (o.isDir) d.dir++; else d.file++;
          for (const k of sddlDiffKinds(o.getAclSddl, o.sddl)) d[k]++;
          for (const k of sddlDiffSplit(o.getAclSddl, o.sddl)) sp[k]++;
        }
      } else n.aclMatch++;
    } else {
      if (o.isReparse) n.aclUnavailReparse++; else n.aclUnavailNonReparse++;
      if (o.getAclError !== null && o.getAclError !== undefined) n.aclErrPresent++;
      if (o.getAclError === null || o.getAclError === undefined) aeAbsent++;
      else if (OP_ACL_ERROR_TYPES.includes(o.getAclError)) ae.set(o.getAclError, (ae.get(o.getAclError) || 0) + 1);
      else aeOther++;
    }
    if (!o.isDir) {
      if (o.isReparse) n.hlReparse++;
      else if (o.fsutilHardlinkExit === 0) { if (asArray(o.fsutilHardlinks).length !== o.nLinks) n.hlDiff++; else n.hlMatch++; }
      else { n.hlExitNonzero++; bump(hl, o.fsutilHardlinkExit); }
    }
    if (o.fsutilReparseExit === 0 && !o.isReparse) n.rpNotOracle++;
    if (o.isReparse && o.fsutilReparseExit !== 0) { n.rpExitNonzero++; bump(rp, o.fsutilReparseExit); }
  }
  const f = readbackFindings(objects);
  const t = opEnum(test, ['contradict', 'unproved']);
  return [
    opLine('readback', [['test', t], ['snapProblems', opCount(snapshotSetProblems(snaps).length)], ...Object.entries(n).map(([k, v]) => [k, opCount(v)]),
      ['contradictions', opCount(f.contradictions.length)], ['unproved', opCount(f.unproved.length)]]),
    opLine('rbdiff', [['test', t], ...Object.entries(d).map(([k, v]) => [k, opCount(v)]), ['hlExits', fmt(hl)], ['hlExitsOther', opCount(hl.other)],
      ['rpExits', fmt(rp)], ['rpExitsOther', opCount(rp.other)]]),
    opLine('rbsplit', [['test', t], ...Object.entries(sp).map(([k, v]) => [k, opCount(v)]),
      ['aclErrTypes', ae.size ? OP_ACL_ERROR_TYPES.filter((e) => ae.has(e)).map((e) => `${e}:${opCount(ae.get(e))}`).join(',') : 'none'],
      ['aclErrOther', opCount(aeOther)], ['aclErrAbsent', opCount(aeAbsent)]]),
  ];
}

// rbcause, DIAGNOSTIC only: partitions three existing row sets by already-recorded fields. Every count is an operand, never
// a cause; no SDDL, verdict or readbackFindings predicate is touched, nothing new is collected or opened.
// miss*: the rbsplit flagMissing rows. Side = which existing text has no top-level D: (getacl / oracle; sideUnknown is
// unreachable while flagMissing holds). Class, exclusive, first match wins: (1) nonAclVolume = volumeError 0 and
// persistentAcls false; (2) oracleNull = the oracle SDDL has D:NO_ACCESS_CONTROL (an oracle with no D: is never this);
// (3) unknown = volume metadata not recorded (volumeError nonzero or persistentAcls not boolean); (4) other.
// err* (rows with a recorded Get-Acl error type) and hlNz* (non-directory/non-reparse rows with a nonzero or unmeasured fsutil hardlink exit),
// exclusive, first match wins: (1) stream = the row path equals the manifest case path of D_ADS, F_ADS or F_DATA_STREAM
// (finalPathMatches, the existing case-insensitive Windows comparison; no colon parsing); (2) unknown = any of those three
// case paths is not in the manifest, or the row has no path; (3) nonAclVolume as above; (4) unknown = volume metadata not
// recorded; (5) other. No path is printed.
export const OP_STREAM_CASES = Object.freeze(['D_ADS', 'F_ADS', 'F_DATA_STREAM']);
export function readbackCauseOperands(test, objects, manifest) {
  const z = () => ({ Stream: 0, NonAclVolume: 0, Other: 0, Unknown: 0 });
  const miss = { missGetacl: 0, missOracle: 0, missSideUnknown: 0, missNonAclVolume: 0, missOracleNull: 0, missOther: 0, missUnknown: 0 };
  const err = z(); const hl = z();
  const cs = asArray(manifest && manifest.cases);
  const streams = OP_STREAM_CASES.map((id) => cs.find((c) => c && c.id === id)).map((c) => (c && typeof c.path === 'string' && c.path !== '' ? c.path : null));
  const vol = (o) => (o.volumeError === 0 && typeof o.persistentAcls === 'boolean' ? (o.persistentAcls ? 'acl' : 'nonAcl') : 'unrecorded');
  const pathClass = (o) => {
    if (typeof o.path === 'string' && streams.some((p) => p !== null && finalPathMatches(p, o.path))) return 'Stream';
    if (typeof o.path !== 'string' || streams.includes(null)) return 'Unknown';
    const v = vol(o);
    return v === 'nonAcl' ? 'NonAclVolume' : v === 'unrecorded' ? 'Unknown' : 'Other';
  };
  for (const o of asArray(objects)) {
    if (!o || o.openError !== 0) continue;
    if (typeof o.getAclSddl === 'string') {
      if (o.getAclSddl !== o.sddl && !o.isReparse && sddlDiffSplit(o.getAclSddl, o.sddl).includes('flagMissing')) {
        const x = parseSddl(o.getAclSddl); const y = parseSddl(o.sddl);
        if (!x.dacl && y.dacl) miss.missGetacl++; else if (x.dacl && !y.dacl) miss.missOracle++; else miss.missSideUnknown++;
        const v = vol(o);
        if (v === 'nonAcl') miss.missNonAclVolume++;
        else if (y.dacl && y.dacl.isNull === true) miss.missOracleNull++;
        else if (v === 'unrecorded') miss.missUnknown++;
        else miss.missOther++;
      }
    } else if (o.getAclError !== null && o.getAclError !== undefined) err[pathClass(o)]++;
    if (!o.isDir && !o.isReparse && o.fsutilHardlinkExit !== 0) hl[pathClass(o)]++;
  }
  return opLine('rbcause', [['test', opEnum(test, ['contradict', 'unproved'])], ...Object.entries(miss).map(([k, v]) => [k, opCount(v)]),
    ...Object.entries(err).map(([k, v]) => [`err${k}`, opCount(v)]), ...Object.entries(hl).map(([k, v]) => [`hlNz${k}`, opCount(v)])]);
}

// rbstate / streamjoin / hlprobe, DIAGNOSTIC only: pure readers of the diagnostic fields Get-PspSnapshot records next to the
// unchanged getAclSddl / getAclError / fsutil fields. Every count is an operand, never a cause, acceptance or waiver; nothing
// here feeds readbackFindings, rbcause or any other line. A missing, non-boolean or invalid input is unknown, never a match.
const opHist = () => ({ m: new Map(), other: 0 });
const opHistBump = (h, v) => {
  if (opInt(v) !== String(v) || (!h.m.has(v) && h.m.size >= 4)) { h.other++; return; }
  h.m.set(v, (h.m.get(v) || 0) + 1);
};
const opHistFmt = (h) => (h.m.size ? [...h.m].map(([v, k]) => `${v}:${opCount(k)}`).join(',') : 'none');
const isBool = (v) => v === true || v === false;
// Oracle handle (GetSecurityDescriptorDacl on the SD Take read): null and absent stay distinct; an empty DACL is present.
function oracleDaclState(o) {
  if (o.daclValid !== true || !isBool(o.daclPresent)) return 'unknown';
  if (o.daclPresent === false) return 'absent';
  return o.daclNull === true ? 'null' : (o.daclNull === false ? 'present' : 'unknown');
}
// Same Get-Acl object, binary form: a DACL-present descriptor is present even with a single explicit Everyone allow rule.
function getAclBinState(o) {
  if (o.getAclBinValid !== true || !isBool(o.getAclDaclPresent) || !isBool(o.getAclAefa)) return 'unknown';
  if (o.getAclDaclPresent) return 'present';
  return o.getAclAefa ? 'absentAefa' : 'absentNoAefa';
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// rbstate: the rbsplit flagMissing rows (same selection as rbcause miss*), by the Get-Acl bracket (matching = ok; stale;
// anything else unmeasured). Only bind=ok rows enter the oracle x getacl cells; aefaMasks = raw FileSystemRights of the AEFA
// rule in those cells (bounded histogram). Control over the aclMatch rows with bind=ok: matchAefa = getacl absentAefa,
// matchUnknown = bind not ok or getacl unknown. No pairing is a normalization: NULL vs absent is pending decision D1.
export const OP_RB_ORACLE = Object.freeze(['null', 'absent', 'present', 'unknown']);
export const OP_RB_GETACL = Object.freeze(['absentAefa', 'absentNoAefa', 'present', 'unknown']);
export function readbackStateOperands(test, objects) {
  const b = { bindOk: 0, bindStale: 0, bindUnmeasured: 0 };
  const cell = Object.fromEntries(OP_RB_ORACLE.flatMap((x) => OP_RB_GETACL.map((g) => [`${x}${cap(g)}`, 0])));
  const masks = opHist(); let matchAefa = 0; let matchUnknown = 0;
  for (const o of asArray(objects)) {
    if (!o || o.openError !== 0 || typeof o.getAclSddl !== 'string') continue;
    const bind = o.getAclBracket === 'matching' ? 'Ok' : (o.getAclBracket === 'stale' ? 'Stale' : 'Unmeasured');
    if (o.getAclSddl === o.sddl) {
      const g = bind === 'Ok' ? getAclBinState(o) : 'unknown';
      if (g === 'absentAefa') matchAefa++; else if (g === 'unknown') matchUnknown++;
      continue;
    }
    if (o.isReparse || !sddlDiffSplit(o.getAclSddl, o.sddl).includes('flagMissing')) continue;
    b[`bind${bind}`]++;
    if (bind !== 'Ok') continue;
    const g = getAclBinState(o);
    cell[`${oracleDaclState(o)}${cap(g)}`]++;
    if (g === 'absentAefa') opHistBump(masks, o.getAclAefaMask);
  }
  return opLine('rbstate', [['test', opEnum(test, ['contradict', 'unproved'])], ...Object.entries(b).map(([k, v]) => [k, opCount(v)]),
    ...Object.entries(cell).map(([k, v]) => [k, opCount(v)]), ['aefaMasks', opHistFmt(masks)], ['aefaMasksOther', opCount(masks.other)],
    ['matchAefa', opCount(matchAefa)], ['matchUnknown', opCount(matchUnknown)]]);
}

// streamjoin: per snapshot stage, per stream case (exactly one manifest case with string path and object; no colon parsing),
// the stage row whose path is exactly case.path and, for each of its unproved read-backs (Get-Acl not a string; non-dir
// non-reparse fsutil hardlink exit nonzero), the stage row whose path is exactly case.object. joinMatch / joinDiff need:
// host row present once, host openError 0, both own-handle volumeSerial/fileIndex measured and equal, both oracle sddl
// measured and equal, host getAclBracket matching, and the host's own read-back (Get-Acl string; or fsutil hardlink exit 0
// with nLinks equal); then host Get-Acl == stream oracle sddl (or listed links == nLinks) is joinMatch, else joinDiff.
// Anything else is joinUnproved with the first failing reason. Never wired into readbackFindings (decision D-S pending).
export const OP_JOIN_REASONS = Object.freeze(['manifest', 'streamRow', 'hostRow', 'open', 'identity', 'sddl', 'bracket', 'readback']);
export function streamJoinOperands(test, snaps, manifest) {
  const n = { aclRows: 0, hlRows: 0, joinMatch: 0, joinDiff: 0, joinUnproved: 0 };
  const u = Object.fromEntries(OP_JOIN_REASONS.map((r) => [r, 0]));
  const unproved = (r) => { n.joinUnproved++; u[r]++; };
  const cs = asArray(manifest && manifest.cases);
  const idOk = (o) => typeof o.volumeSerial === 'string' && /^[0-9A-F]{8}$/.test(o.volumeSerial) && typeof o.fileIndex === 'string' && /^[0-9A-F]{16}$/.test(o.fileIndex);
  for (const t of ['S0', 'S1', 'S2', 'S3']) {
    const objs = asArray(snaps && snaps[t] && snaps[t].objects);
    for (const id of OP_STREAM_CASES) {
      const hits = cs.filter((c) => c && c.id === id);
      const c = hits.length === 1 ? hits[0] : null;
      if (!c || typeof c.path !== 'string' || c.path === '' || typeof c.object !== 'string' || c.object === '') { unproved('manifest'); continue; }
      const ss = objs.filter((o) => o && o.path === c.path);
      if (ss.length !== 1) { unproved('streamRow'); continue; }
      const s = ss[0];
      if (s.openError !== 0) continue;   // not a readbackFindings row
      const sides = [];
      if (typeof s.getAclSddl !== 'string') sides.push('acl');
      if (!s.isDir && !s.isReparse && s.fsutilHardlinkExit !== 0) sides.push('hl');
      const hs = objs.filter((o) => o && o.path === c.object);
      const h = hs.length === 1 ? hs[0] : null;
      for (const side of sides) {
        n[`${side}Rows`]++;
        let r = null;
        if (!h) r = 'hostRow';
        else if (h.openError !== 0) r = 'open';
        else if (!idOk(s) || !idOk(h) || s.volumeSerial !== h.volumeSerial || s.fileIndex !== h.fileIndex) r = 'identity';
        else if (s.sddlError !== 0 || h.sddlError !== 0 || typeof s.sddl !== 'string' || typeof h.sddl !== 'string' || s.sddl !== h.sddl) r = 'sddl';
        else if (h.getAclBracket !== 'matching') r = 'bracket';
        else if (side === 'acl' ? typeof h.getAclSddl !== 'string'
          : (h.isDir !== false || h.isReparse !== false || h.fsutilHardlinkExit !== 0 || !Array.isArray(h.fsutilHardlinks) || !Number.isInteger(s.nLinks))) r = 'readback';
        if (r) { unproved(r); continue; }
        const same = side === 'acl' ? h.getAclSddl === s.sddl : (h.fsutilHardlinks.length === s.nLinks && h.nLinks === s.nLinks);
        if (same) n.joinMatch++; else n.joinDiff++;
      }
    }
  }
  return opLine('streamjoin', [['test', opEnum(test, ['contradict', 'unproved'])], ...Object.entries(n).map(([k, v]) => [k, opCount(v)]),
    ...Object.entries(u).map(([k, v]) => [`u${cap(k)}`, opCount(v)])]);
}

// hlprobe: the rbcause hlNz rows (non-dir, non-reparse, fsutil hardlink exit nonzero or unmeasured), by the rbcause path class
// (stream / nonAcl / other / unknown, same rules) x outcome: bothOk (plain open 0 and FindFirstFileNameW 0), ffnErr (plain 0,
// ffn nonzero), plainErr (plain nonzero), unknown (probe or a needed field invalid/missing). Histograms of the measured
// numeric codes (at most 4 values plus other). Counts only: no fsutil cause is inferred.
export function hardlinkProbeOperands(test, objects, manifest) {
  const outs = ['BothOk', 'FfnErr', 'PlainErr', 'Unknown'];
  const cell = Object.fromEntries(['stream', 'nonAcl', 'other', 'unknown'].flatMap((k) => outs.map((x) => [`${k}${x}`, 0])));
  const pe = opHist(); const fe = opHist(); let rows = 0; let plainUnknown = 0; let ffnUnknown = 0;
  const cs = asArray(manifest && manifest.cases);
  const streams = OP_STREAM_CASES.map((id) => cs.find((c) => c && c.id === id)).map((c) => (c && typeof c.path === 'string' && c.path !== '' ? c.path : null));
  const pathClass = (o) => {
    if (typeof o.path === 'string' && streams.some((p) => p !== null && finalPathMatches(p, o.path))) return 'stream';
    if (typeof o.path !== 'string' || streams.includes(null)) return 'unknown';
    if (o.volumeError === 0 && typeof o.persistentAcls === 'boolean') return o.persistentAcls ? 'other' : 'nonAcl';
    return 'unknown';
  };
  for (const o of asArray(objects)) {
    if (!o || o.openError !== 0) continue;
    if (!(!o.isDir && !o.isReparse && o.fsutilHardlinkExit !== 0)) continue;
    rows++;
    const valid = o.hlProbeValid === true;
    const plain = valid && o.hlPlainOpenValid === true && Number.isInteger(o.hlPlainOpenErr);
    const ffn = valid && o.hlFfnValid === true && Number.isInteger(o.hlFfnErr);
    if (plain) opHistBump(pe, o.hlPlainOpenErr); else plainUnknown++;
    if (ffn) opHistBump(fe, o.hlFfnErr); else ffnUnknown++;
    const out = !plain ? 'Unknown' : (o.hlPlainOpenErr !== 0 ? 'PlainErr' : (!ffn ? 'Unknown' : (o.hlFfnErr !== 0 ? 'FfnErr' : 'BothOk')));
    cell[`${pathClass(o)}${out}`]++;
  }
  return opLine('hlprobe', [['test', opEnum(test, ['contradict', 'unproved'])], ['rows', opCount(rows)], ...Object.entries(cell).map(([k, v]) => [k, opCount(v)]),
    ['plainErrs', opHistFmt(pe)], ['plainErrsOther', opCount(pe.other)], ['plainUnknown', opCount(plainUnknown)],
    ['ffnErrs', opHistFmt(fe)], ['ffnErrsOther', opCount(fe.other)], ['ffnUnknown', opCount(ffnUnknown)]]);
}

// F1 observation, DIAGNOSTIC only, for the four link cases: does the S0 oracle SDDL of the relevant link object (the leaf
// link, or the junction ancestor for *_UNDER_JUNCTION) carry an allow ACE for A's own SID whose generic-mapped mask covers
// what the helper opens it with: leaf READ_CONTROL|FILE_READ_ATTRIBUTES (private_storage.c:819), ancestor
// FILE_READ_ATTRIBUTES (c:377)? ACE presence only, never effective access: owner-implicit rights and FILE_READ_ATTRIBUTES
// granted through the parent are not modelled, so aAllow=none is not a denial proof. BUILTIN\Administrators and SYSTEM
// ACEs are counted apart (A's non-membership is the identity verdict, not this line). aAllow=UNKNOWN names the minimum
// missing input: snapshot (no S0 link object), sddl (no parsable oracle SDDL), sidA (A's SID missing or not S-1-... after
// normalizeSid), dacl (absent or NULL DACL), aceType / rights (an applicable ACE the existing parser cannot map; the first
// one wins), groupMembership (only another SID's ACE could grant it). Precedence: snapshot > sddl > sidA > dacl.
export const OP_LINK_CASES = Object.freeze({ D_JUNCTION: 'leaf', D_SYMLINK: 'leaf', D_UNDER_JUNCTION: 'ancestor', F_UNDER_JUNCTION: 'ancestor' });
export function linkObjectPath(c) {
  if (!c || typeof c.path !== 'string' || !OP_LINK_CASES[c.id]) return null;
  return OP_LINK_CASES[c.id] === 'leaf' ? c.path : path.win32.dirname(c.path);
}
function mappedFileMask(rights) {
  const { mask, unknown } = parseRights(rights);
  if (unknown) return null;
  let m = mask;
  if (mask & RIGHTS.GA) m |= RIGHTS.FA;
  if (mask & RIGHTS.GR) m |= RIGHTS.FR;
  if (mask & RIGHTS.GW) m |= RIGHTS.FW;
  if (mask & RIGHTS.GX) m |= RIGHTS.FX;
  return m >>> 0;
}
export function linkAclOperands(c, snap, sids) {
  const id = c && c.id;
  const kind = OP_LINK_CASES[id];
  const need = (kind === 'leaf' ? RIGHTS.RC | RIGHTS.LO : RIGHTS.LO) >>> 0;
  const s = sids || {};
  const saN = normalizeSid(s.A);
  const sa = saN !== null && /^S-1(?:-\d+)+$/.test(saN) ? saN : null;
  const n = { aDeny: 0, adminAllow: 0, otherAllow: 0, otherDeny: 0 };
  let owner = 'none'; let aAllow = 'UNKNOWN'; let missing = 'none';
  const sd = snap && snap.openError === 0 && !snap.sddlError && typeof snap.sddl === 'string' ? parseSddl(snap.sddl) : null;
  if (!snap || snap.openError !== 0) missing = 'snapshot';
  else if (!sd) missing = 'sddl';
  else {
    const o = normalizeSid(sd.owner);
    owner = o === null ? 'none' : o === sa ? 'A' : o === normalizeSid(s.B) ? 'B' : o === SID_ADMINS ? 'admins'
      : o === SID_SYSTEM ? 'system' : o === normalizeSid(s.adminUser) ? 'adminUser' : 'other';
    if (sa === null) missing = 'sidA';
    else if (!sd.dacl || sd.dacl.isNull) missing = 'dacl';
    else {
      let ex = 0; let inh = 0;
      for (const a of sd.dacl.aces) {
        if (a.flags.includes('IO')) continue;
        if (a.type !== 'A' && a.type !== 'D') { if (missing === 'none') missing = 'aceType'; continue; }
        const m = mappedFileMask(a.rights);
        if (m === null) { if (missing === 'none') missing = 'rights'; continue; }
        const who = sa !== null && a.sid === sa ? 'A' : (a.sid === SID_ADMINS || a.sid === SID_SYSTEM ? 'adminSystem' : 'other');
        if (a.type === 'D') { if ((m & need) !== 0) { if (who === 'A') n.aDeny++; else if (who === 'other') n.otherDeny++; } continue; }
        if (who === 'A') { if (a.flags.includes('ID')) inh = (inh | m) >>> 0; else ex = (ex | m) >>> 0; }
        else if (((m & need) >>> 0) === need) { if (who === 'adminSystem') n.adminAllow++; else n.otherAllow++; }
      }
      if (missing === 'none') {
        const covers = (x) => ((x & need) >>> 0) !== 0;
        if ((((ex | inh) & need) >>> 0) === need) aAllow = covers(ex) && covers(inh) ? 'both' : (covers(ex) ? 'explicit' : 'inherited');
        else if (n.otherAllow > 0) missing = 'groupMembership';
        else aAllow = 'none';
      }
    }
  }
  return opLine('linkacl', [['case', opEnum(id, Object.keys(OP_LINK_CASES))], ['need', kind === 'leaf' ? 'rcra' : (kind ? 'ra' : 'none')],
    ['link', snap ? 'present' : 'absent'], ['reparse', snap ? opBool(snap.isReparse) : 'none'], ['owner', owner], ['aAllow', aAllow],
    ['missing', missing], ...Object.entries(n).map(([k, v]) => [k, opCount(v)])]);
}

// The only catch here wraps the diagnostic builder, never an assertion: a builder fault prints one fixed line.
function opDiag(t, build) {
  let lines;
  try { lines = asArray(build()); } catch { lines = [opLine('error', [])]; }
  for (const l of lines) t.diagnostic(l);
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
      for (const r of e.reasons) assert.ok(Array.isArray(expectedWin32(r)), `${id}: ${r} has no intended Win32 code`);
    }
    assert.deepEqual(expectedWin32('open_failed'), [5]);
    assert.equal(expectedWin32('size_changed'), null);
    assert.equal(expectedHelperStatus('F_NOT_FILE', 'unsafe'), 'unavailable');
    assert.equal(expectedHelperStatus('D_OK', 'ok'), 'ok');
  });

  test('selfcheck: self-reports bind to exactly one admin-observed launch; forged, missing, duplicate, wrong, timed-out or nonzero launches fail', () => {
    const users = { A: { name: 'pspa0a1b2c', sid: A }, B: { name: 'pspb0a1b2c', sid: B } };
    const launches = EXPECTED_LAUNCHES.map(([tag, who, mode]) => ({ user: users[who].name, mode, launched: true, exitCode: 0, timedOut: false, tag }));
    const receipts = Object.fromEntries(EXPECTED_LAUNCHES.map(([tag, , mode]) => [tag, { ok: true, mode, ...(mode === 'node-test' ? { nodeExit: 0 } : {}) }]));
    assert.deepEqual(launchBindingProblems(launches, users, receipts), []);
    const h = launches.findIndex((l) => l.tag === 'helper-run');
    const bad = {
      'forged self-report over launcher exit 1': [launches.map((l, i) => (i === h ? { ...l, exitCode: 1 } : l)), receipts],
      'launcher timed out': [launches.map((l, i) => (i === h ? { ...l, timedOut: true } : l)), receipts],
      'timedOut unrecorded': [launches.map((l, i) => (i === h ? { ...l, timedOut: undefined } : l)), receipts],
      'exitCode null (killed)': [launches.map((l, i) => (i === h ? { ...l, exitCode: null } : l)), receipts],
      'exitCode string': [launches.map((l, i) => (i === h ? { ...l, exitCode: '0' } : l)), receipts],
      'launch missing': [launches.filter((l, i) => i !== h), receipts],
      'launch duplicated': [[...launches, launches[h]], receipts],
      'launched as B': [launches.map((l, i) => (i === h ? { ...l, user: users.B.name } : l)), receipts],
      'wrong mode': [launches.map((l, i) => (i === h ? { ...l, mode: 'probe' } : l)), receipts],
      'not launched': [launches.map((l, i) => (i === h ? { ...l, launched: false } : l)), receipts],
      'reordered': [[launches[1], launches[0], ...launches.slice(2)], receipts],
      'launches.json absent': [null, receipts],
      'self-report nodeExit 1': [launches, { ...receipts, 'helper-run': { ok: true, mode: 'node-test', nodeExit: 1 } }],
      'self-report missing': [launches, { ...receipts, 'helper-run': undefined }],
      'self-report from another mode': [launches, { ...receipts, 'helper-run': { ok: true, mode: 'identity', nodeExit: 0 } }],
    };
    for (const [k, [l, r]] of Object.entries(bad)) assert.notDeepEqual(launchBindingProblems(l, users, r), [], k);
    assert.notDeepEqual(launchBindingProblems(launches, null, receipts), [], 'users unrecorded');
  });

  test('selfcheck: empty or missing run stages and snapshots are never a vacuous pass', () => {
    const ok = { stages: REQUIRED_STAGES.map((name) => ({ name, status: 'ok' })) };
    assert.deepEqual(stageProblems(ok), []);
    for (const r of [null, {}, { stages: [] }, { stages: ok.stages.slice(1) }, { stages: [...ok.stages, ok.stages[3]] },
      { stages: ok.stages.map((s, i) => (i === 5 ? { ...s, status: 'blocked' } : s)) }]) assert.notDeepEqual(stageProblems(r), [], JSON.stringify(r));
    const s = (n) => ({ objects: Array.from({ length: n }, (_, i) => ({ path: `p${i}` })) });
    assert.deepEqual(snapshotSetProblems({ S0: s(1), S1: s(1), S2: s(1), S3: s(1) }), []);
    assert.deepEqual(snapshotSetProblems({ S0: s(1), S1: s(0), S2: null, S3: s(1) }), ['snap-S1 missing or empty', 'snap-S2 missing or empty']);
    assert.equal(snapshotSetProblems({}).length, 4);
    assert.deepEqual(readbackFindings([]), { contradictions: [], unproved: [] }, 'the R6 rule alone is vacuous on nothing: the verdict gates it on snapshotSetProblems');
  });

  test('selfcheck: D_EMPTY pins exactly unavailable/open_failed/5 (fail closed, never ok, no arbitrary failure); the oracle stays unsafe', () => {
    const R = (status, reason, win32Error) => ({ threw: false, result: normalizeResult({ status, reason, win32Error }) });
    const want = expectedHelperStatus('D_EMPTY', 'unsafe');
    assert.equal(want, 'unavailable');
    assert.equal(CANDIDATE_EXPECT.D_EMPTY.win32Error, 5);
    assert.deepEqual(helperResultProblems('D_EMPTY', R('unavailable', 'open_failed', 5), want), []);
    for (const [s, rs, w] of [['ok', 'ok', 0], ['unsafe', 'dacl_empty', 0], ['unavailable', 'dacl_empty', 0], ['unavailable', 'open_failed', 2],
      ['unavailable', 'open_failed', 0], ['unavailable', 'ancestor_open_failed', 5], ['unavailable', 'security_query_failed', 5],
      ['unsafe', 'owner_ace_missing', 0], ['missing', 'not_found', 2], ['unsafe', 'open_failed', 5]]) {
      assert.notDeepEqual(helperResultProblems('D_EMPTY', R(s, rs, w), want), [], `${s}/${rs}/${w}`);
    }
    assert.deepEqual(classifyDir(P, dir(P, `O:${A}G:${A}D:P`), A), { cls: 'unsafe', reason: 'no-owner-ace' });
    assert.deepEqual(helperResultProblems('F_EMPTY', R('unavailable', 'open_failed', 5), 'unavailable'), [], 'F_EMPTY control unchanged');
    assert.notDeepEqual(helperResultProblems('F_EMPTY', R('ok', 'ok', 0), 'unavailable'), []);
  });

  test('selfcheck: R6 reparse files need a successful reparsepoint read-back instead of a hardlink count; other operands unchanged', () => {
    const S = `O:${A}G:${A}D:P(A;;FA;;;${A})`;
    const rf = (x) => ({ path: 'r', openError: 0, isDir: false, isReparse: true, sddl: S, getAclSddl: S, ...x });
    assert.deepEqual(readbackFindings([rf({ fsutilReparseExit: 0 })]), { contradictions: [], unproved: [] });
    assert.deepEqual(readbackFindings([rf({ fsutilReparseExit: 0, fsutilHardlinkExit: 1 })]), { contradictions: [], unproved: [] });
    for (const x of [{ fsutilReparseExit: 1 }, { fsutilReparseExit: null }, {}, { fsutilReparseExit: '0' }]) {
      assert.equal(readbackFindings([rf(x)]).unproved.length, 1, `reparse query missing or failed: ${JSON.stringify(x)}`);
    }
    assert.equal(readbackFindings([rf({ fsutilReparseExit: 0, getAclSddl: null, getAclError: 'UnauthorizedAccessException' })]).unproved.length, 1);
    assert.equal(readbackFindings([rf({ fsutilReparseExit: 0, getAclSddl: `O:BAG:BAD:P(A;;FA;;;BA)` })]).unproved.length, 1);
    const nf = (x) => ({ path: 'n', openError: 0, isDir: false, isReparse: false, nLinks: 1, sddl: S, getAclSddl: S, fsutilReparseExit: 1, ...x });
    assert.deepEqual(readbackFindings([nf({ fsutilHardlinkExit: 0, fsutilHardlinks: ['x'] })]), { contradictions: [], unproved: [] });
    assert.equal(readbackFindings([nf({ fsutilHardlinkExit: 1 })]).unproved.length, 1, 'non-reparse hardlink exit 1 stays unproved');
    assert.equal(readbackFindings([nf({})]).unproved.length, 1, 'non-reparse hardlink unmeasured stays unproved');
    assert.equal(readbackFindings([nf({ fsutilHardlinkExit: 0, fsutilHardlinks: ['x', 'y'] })]).contradictions.length, 1);
    assert.equal(readbackFindings([nf({ fsutilReparseExit: 0, fsutilHardlinkExit: 0, fsutilHardlinks: ['x'] })]).contradictions.length, 1);
    assert.equal(readbackFindings([nf({ fsutilHardlinkExit: 0, fsutilHardlinks: ['x'], getAclSddl: `O:BAG:BAD:P(A;;FA;;;BA)` })]).contradictions.length, 1);
    assert.equal(readbackFindings([{ ...rf({ fsutilReparseExit: 1 }), isDir: true }]).unproved.length, 1, 'reparse dir query still required');
  });

  const opKv = (line) => Object.fromEntries(line.split(' ').slice(1).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));

  test('selfcheck: rbsplit splits daclFlags / aceOrder and counts Get-Acl error types in a closed vocabulary only', () => {
    const O = `O:${A}G:${A}`;
    const df = (g, o, isDir = false) => ({ path: 'p', openError: 0, isDir, isReparse: false, nLinks: 1, sddl: o, getAclSddl: g, fsutilReparseExit: 1, fsutilHardlinkExit: 0, fsutilHardlinks: ['x'] });
    const er = (e) => ({ path: 'C:\\secret', openError: 0, isDir: true, isReparse: false, sddl: `${O}D:P`, getAclSddl: null, fsutilReparseExit: 1, ...(e === undefined ? {} : { getAclError: e }) });
    const objs = [
      df(`${O}D:P(A;OICI;FA;;;${A})`, `${O}D:PAI(A;OICI;FA;;;${A})`, true), df(`${O}D:(A;;FA;;;${A})`, `${O}D:P(A;;FA;;;${A})`),
      df(`${O}D:NO_ACCESS_CONTROL`, `${O}D:(A;;FA;;;${A})`), df(O, `${O}D:P(A;;FA;;;${A})`), df(`${O}D:P(A;;FA;;;${A})`, null),
      df(`${O}D:P(D;;FA;;;${B})(A;;FA;;;${A})`, `${O}D:P(A;;FA;;;${A})(D;;FA;;;${B})`),
      df(`${O}D:P(D;;FA;;;${B})(A;;FA;;;${A})(A;;FR;;;BA)`, `${O}D:P(D;;FA;;;${B})(A;;FR;;;BA)(A;;FA;;;${A})`),
      df(`${O}D:P(A;;FA;;;${A})(A;;FA;;;${A})(D;;FA;;;${B})`, `${O}D:P(A;;FA;;;${A})(D;;FA;;;${B})(A;;FA;;;${A})`),
      er('UnauthorizedAccessException'), er('UnauthorizedAccessException'), er('NotSupportedException'), er('Evil C:\\secret ::error::pwn'), er(undefined),
    ];
    const lines = readbackOperands('unproved', {}, objs);
    assert.equal(lines.length, 3);
    for (const l of lines) { assert.ok(OP_LINE.test(l), l); assert.ok(!/secret|Evil|pwn|S-1-/.test(l), l); }
    const d = opKv(lines[1]); const s = opKv(lines[2]);
    assert.equal(s.kind, 'rbsplit');
    assert.deepEqual([d.daclFlags, d.aceOrder, d.aceCount, d.unparsed], ['4', '3', '1', '1'], 'existing rbdiff kinds unchanged');
    assert.deepEqual([s.flagProtected, s.flagAutoInherited, s.flagIsNull, s.flagMissing, s.flagUnparsed], ['1', '1', '1', '1', '1']);
    assert.deepEqual([s.orderDenyRelChanged, s.orderDenyRelUnchanged, s.orderDenyRelUnknown], ['1', '1', '1']);
    assert.deepEqual([s.aclErrTypes, s.aclErrOther, s.aclErrAbsent], ['UnauthorizedAccessException:2,NotSupportedException:1', '1', '1']);
    const none = opKv(readbackOperands('contradict', {}, [])[2]);
    assert.deepEqual([none.test, none.aclErrTypes, none.flagProtected], ['contradict', 'none', '0']);
    assert.equal(opKv(readbackOperands('payload', {}, [])[2]).test, 'UNKNOWN');
    const clip = opKv(readbackOperands('unproved', {}, Array.from({ length: 100000 }, () => er(undefined)))[2]);
    assert.deepEqual([clip.aclErrAbsent, clip.aclErrTypes], ['99999', 'none'], 'counts are clipped, never unbounded');
  });

  test('selfcheck: linkacl reports allow-ACE presence for A on the relevant link object, UNKNOWN with the missing input otherwise', () => {
    const adminUser = 'S-1-5-21-1-2-3-500';
    const sids = { A, B, adminUser };
    const J = { id: 'D_JUNCTION', path: 'D:\\a\\fx\\junction-to-ok' };
    const U = { id: 'D_UNDER_JUNCTION', path: 'D:\\a\\fx\\jnest\\inner-ok' };
    assert.equal(linkObjectPath(J), 'D:\\a\\fx\\junction-to-ok');
    assert.equal(linkObjectPath(U), 'D:\\a\\fx\\jnest');
    assert.equal(linkObjectPath({ id: 'F_UNDER_JUNCTION', path: 'D:\\a\\fx\\jparent\\file-ok.bin' }), 'D:\\a\\fx\\jparent');
    assert.equal(linkObjectPath({ id: 'D_OK', path: 'D:\\a' }), null);
    assert.equal(linkObjectPath({ id: 'D_JUNCTION', path: null }), null);
    const ln = (sddl, x = {}) => ({ openError: 0, isReparse: true, sddl, ...x });
    const k = (c, snap) => { const l = linkAclOperands(c, snap, sids); assert.ok(OP_LINE.test(l) && !/S-1-|secret/.test(l), l); return opKv(l); };
    const pick = (v) => [v.owner, v.aAllow, v.missing, v.aDeny, v.adminAllow, v.otherAllow, v.otherDeny];
    assert.deepEqual(pick(k(J, ln('O:BAG:SYD:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)'))), ['admins', 'none', 'none', '0', '2', '0', '0']);
    assert.deepEqual([k(J, ln('O:BAG:SYD:AI(A;ID;FA;;;BA)')).need, k(U, ln('O:BAG:SYD:AI(A;ID;FA;;;BA)')).need], ['rcra', 'ra']);
    assert.deepEqual(pick(k(J, ln(`O:${A}G:${A}D:P(A;;FR;;;${A})`))), ['A', 'explicit', 'none', '0', '0', '0', '0']);
    assert.deepEqual(pick(k(J, ln(`O:${adminUser}G:SYD:AI(A;ID;GR;;;${A})`))), ['adminUser', 'inherited', 'none', '0', '0', '0', '0']);
    assert.equal(k(J, ln(`O:${B}G:SYD:AI(A;;RC;;;${A})(A;ID;LO;;;${A})`)).aAllow, 'both');
    assert.equal(k(J, ln(`O:BAG:SYD:P(A;;RC;;;${A})`)).aAllow, 'none', 'leaf needs FILE_READ_ATTRIBUTES too');
    assert.equal(k(U, ln(`O:BAG:SYD:P(A;;LO;;;${A})`)).aAllow, 'explicit', 'ancestor needs FILE_READ_ATTRIBUTES only');
    assert.equal(k(J, ln(`O:BAG:SYD:P(A;;GW;;;${A})`)).aAllow, 'none', 'GW maps to FILE_GENERIC_WRITE (no FILE_READ_ATTRIBUTES)');
    assert.equal(k(J, ln(`O:BAG:SYD:P(A;OICIIO;FA;;;${A})`)).aAllow, 'none', 'inherit-only ACE does not apply to the link');
    assert.deepEqual(pick(k(J, ln(`O:BAG:SYD:P(D;;LO;;;${A})(A;;FA;;;${A})`))), ['admins', 'explicit', 'none', '1', '0', '0', '0']);
    assert.deepEqual(pick(k(J, ln('O:BAG:SYD:AI(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)(D;;FA;;;WD)'))), ['admins', 'UNKNOWN', 'groupMembership', '0', '1', '1', '1']);
    for (const [sddl, miss] of [[`O:BAG:SYD:P(A;;FA;;;${A})(XA;;FR;;;${A};(Member_of {SID(BU)}))`, 'aceType'], [`O:BAG:SYD:P(A;;ZZ;;;${A})`, 'rights'],
      ['O:BAG:SYD:NO_ACCESS_CONTROL', 'dacl'], ['O:BAG:SY', 'dacl']]) {
      assert.deepEqual([k(J, ln(sddl)).aAllow, k(J, ln(sddl)).missing], ['UNKNOWN', miss], sddl);
    }
    assert.deepEqual([k(J, ln(null, { sddlError: 5 })).missing, k(J, ln('O:BAG:SYD:P', { openError: 5 })).missing], ['sddl', 'snapshot']);
    const absent = k(J, undefined);
    assert.deepEqual([absent.link, absent.reparse, absent.owner, absent.aAllow, absent.missing], ['absent', 'none', 'none', 'UNKNOWN', 'snapshot']);
    const other = k({ id: 'D_OK', path: 'D:\\a' }, ln('O:BAG:SYD:P'));
    assert.deepEqual([other.case, other.need], ['UNKNOWN', 'none']);
  });

  test('selfcheck: linkacl names sidA for a missing or invalid A SID (never aAllow=none) and keeps the first unknown ACE reason', () => {
    const J = { id: 'D_JUNCTION', path: 'D:\\a\\fx\\junction-to-ok' };
    const ln = (sddl, x = {}) => ({ openError: 0, isReparse: true, sddl, ...x });
    const k = (snap, sids) => { const l = linkAclOperands(J, snap, sids); assert.ok(OP_LINE.test(l) && !/S-1-|secret|alias/i.test(l), l); return opKv(l); };
    assert.deepEqual([k({ openError: 0, sddl: 'O:BAG:SYD:P(A;;FA;;;BA)' }, {}).aAllow, k({ openError: 0, sddl: 'O:BAG:SYD:P(A;;FA;;;BA)' }, {}).missing], ['UNKNOWN', 'sidA']);
    for (const bad of [undefined, null, '', 'A', 'secret', 'S-', 'S-1', 'S-1x-5', 'S-1-5-21-x-2', ' S-1-5-21-1-2-3-1001', 42, {}, ['S-1-5-21-1-2-3-1001']]) {
      const v = k(ln(`O:BAG:SYD:AI(A;ID;FA;;;BA)(A;ID;FA;;;${A})`), { A: bad, B });
      assert.deepEqual([v.aAllow, v.missing], ['UNKNOWN', 'sidA'], JSON.stringify(bad));
    }
    assert.deepEqual([k(ln('O:BAG:SY'), {}).missing, k(ln('O:BAG:SYD:NO_ACCESS_CONTROL'), { A: 'x' }).missing], ['sidA', 'sidA'], 'sidA precedes dacl');
    assert.deepEqual([k(ln(null, { sddlError: 5 }), {}).missing, k(ln('O:BAG:SY', { openError: 5 }), {}).missing, k(undefined, {}).missing], ['sddl', 'snapshot', 'snapshot'],
      'snapshot > sddl > sidA');
    assert.equal(k(ln(`O:${A}G:SYD:P(A;;FA;;;${A})`), { A: A.toLowerCase(), B }).aAllow, 'explicit', 'a valid SID still normalizes');
    assert.equal(k(ln('O:BAG:SYD:P(A;;FA;;;BA)'), { A, B }).aAllow, 'none', 'a valid A SID with no A ACE stays none');
    assert.deepEqual([k(ln(`O:BAG:SYD:P(A;;ZZ;;;${A})(XA;;FR;;;${A};(x))`), { A }).missing, k(ln(`O:BAG:SYD:P(XA;;FR;;;${A};(x))(A;;ZZ;;;${A})`), { A }).missing],
      ['rights', 'aceType'], 'the first unknown reason is kept');
  });

  test('selfcheck: rbcause partitions flagMissing / Get-Acl-error / hardlink-nonzero rows by recorded fields only, closed and bounded', () => {
    const O = `O:${A}G:${A}`; const P = `${O}D:P(A;;FA;;;${A})`;
    const man = { cases: [{ id: 'D_ADS', path: 'C:\\fx\\d::$INDEX_ALLOCATION' }, { id: 'F_ADS', path: 'C:\\fx\\secret.bin:alt' }, { id: 'F_DATA_STREAM', path: 'C:\\fx\\ok.bin::$DATA' }] };
    const acl = { volumeError: 0, persistentAcls: true }; const fat = { volumeError: 0, persistentAcls: false };
    const ms = (g, o, v, x = {}) => ({ path: 'C:\\fx\\m', openError: 0, isDir: true, isReparse: false, sddl: o, getAclSddl: g, fsutilReparseExit: 1, ...v, ...x });
    // An explicit undefined argument still takes the parameter default, so an absent field needs its own sentinel.
    const MISSING = Symbol('missing');
    const er = (p, v, e = 'NotSupportedException') => ({ path: p, openError: 0, isDir: true, isReparse: false, sddl: P, getAclSddl: null, fsutilReparseExit: 1, ...v, ...(e === MISSING ? {} : { getAclError: e }) });
    const hl = (p, v, exit = 1) => ({ path: p, openError: 0, isDir: false, isReparse: false, nLinks: 1, sddl: P, getAclSddl: P, fsutilReparseExit: 1, ...v, ...(exit === MISSING ? {} : { fsutilHardlinkExit: exit }) });
    const objs = [
      ms(O, `${O}D:NO_ACCESS_CONTROL`, acl), ms(P, O, acl), ms(O, `${O}D:NO_ACCESS_CONTROL`, fat), ms(O, P, { volumeError: 5, persistentAcls: false }), ms(O, P, {}),
      ms(O, P, acl), ms(`${O}D:(A;;FA;;;${A})`, P, acl), ms(O, P, acl, { isReparse: true }), ms(O, P, acl, { openError: 5 }), ms(O, 'garbage', acl),
      er('c:\\FX\\SECRET.BIN:ALT', acl), er('C:\\fx\\d::$INDEX_ALLOCATION', fat), er('C:\\fx\\plain', fat), er('C:\\fx\\plain', acl), er('C:\\fx\\x:evil', acl),
      er('C:\\fx\\plain', { volumeError: 87 }), er(undefined, acl), er('C:\\fx\\plain', acl, MISSING), er('C:\\fx\\plain', acl, null),
      hl('C:\\fx\\ok.bin::$DATA', fat), hl('C:\\fx\\plain', fat), hl('C:\\fx\\plain', acl), hl('C:\\fx\\plain', acl, MISSING), hl('C:\\fx\\plain', {}, 1),
      hl('C:\\fx\\plain', acl, 0), { ...hl('C:\\fx\\plain', acl), isDir: true }, { ...hl('C:\\fx\\plain', acl), isReparse: true, fsutilReparseExit: 0 },
    ];
    const has = (o, f) => Object.prototype.hasOwnProperty.call(o, f);
    assert.deepEqual([has(objs[17], 'getAclError'), objs[17].getAclError], [false, undefined], 'the missing-getAclError fixture has no field, not the default');
    assert.deepEqual([has(objs[18], 'getAclError'), objs[18].getAclError], [true, null], 'the null-getAclError fixture keeps an explicit null');
    assert.deepEqual([has(objs[13], 'getAclError'), objs[13].getAclError], [true, 'NotSupportedException'], 'the default getAclError fixture records an error type');
    assert.deepEqual([has(objs[22], 'fsutilHardlinkExit'), objs[22].fsutilHardlinkExit], [false, undefined], 'the missing-hardlink-exit fixture has no field, not the default');
    assert.deepEqual([has(objs[21], 'fsutilHardlinkExit'), objs[21].fsutilHardlinkExit], [true, 1], 'the default hardlink-exit fixture records exit 1');
    assert.deepEqual([has(objs[24], 'fsutilHardlinkExit'), objs[24].fsutilHardlinkExit], [true, 0], 'the exit-0 hardlink fixture records exit 0');
    const kv = (l) => { assert.ok(OP_LINE.test(l), l); assert.ok(!/secret|evil|S-1-|C:|fx|DATA|INDEX|alt|alias/i.test(l), l); return opKv(l); };
    const v = kv(readbackCauseOperands('unproved', objs, man));
    assert.equal(v.kind, 'rbcause');
    const pick = (x, ks) => ks.map((q) => x[q]);
    const MS = ['missGetacl', 'missOracle', 'missSideUnknown', 'missNonAclVolume', 'missOracleNull', 'missOther', 'missUnknown'];
    const ER = ['errStream', 'errNonAclVolume', 'errOther', 'errUnknown']; const HL = ['hlNzStream', 'hlNzNonAclVolume', 'hlNzOther', 'hlNzUnknown'];
    assert.deepEqual(pick(v, MS), ['5', '1', '0', '1', '1', '2', '2'], 'side split; nonAclVolume > oracleNull > unknown > other; an oracle with no D: is never oracleNull');
    assert.deepEqual(pick(v, ER), ['2', '1', '2', '2'], 'stream by manifest case path only; a colon in another path is not parsed');
    assert.deepEqual(pick(v, HL), ['1', '1', '2', '1'], 'dirs, reparse and exit 0 are not in the hardlink-nonzero set');
    const r = readbackOperands('unproved', {}, objs).map(opKv);
    const sum = (x, ks) => String(ks.reduce((a2, q) => a2 + Number(x[q]), 0));
    assert.deepEqual([sum(v, MS.slice(0, 3)), sum(v, MS.slice(3))], [r[2].flagMissing, r[2].flagMissing], 'both miss partitions sum to rbsplit flagMissing');
    assert.deepEqual([sum(v, ER), sum(v, HL)], [r[0].aclErrPresent, r[0].hlExitNonzero], 'partitions sum to the existing readback counts');
    assert.deepEqual(readbackFindings(objs).unproved.length, Number(r[0].aclDiffReparse) + Number(r[0].aclUnavailNonReparse) + Number(r[0].aclUnavailReparse) + Number(r[0].hlExitNonzero) + Number(r[0].rpExitNonzero),
      'readbackFindings unchanged');
    for (const m of [undefined, null, {}, { cases: 'x' }, { cases: man.cases.slice(1) }, { cases: [...man.cases.slice(0, 2), { id: 'F_DATA_STREAM' }] }]) {
      const u = kv(readbackCauseOperands('unproved', objs, m));
      assert.deepEqual(pick(u, MS), pick(v, MS), 'miss rows need no manifest');
      const stream = m && Array.isArray(m.cases) && m.cases.length === 2 && m.cases[0].id === 'F_ADS' ? '1' : (m && Array.isArray(m.cases) && m.cases.length === 3 ? '2' : '0');
      assert.equal(u.errStream, stream, JSON.stringify(m));
      assert.deepEqual([u.errNonAclVolume, u.errOther, u.hlNzNonAclVolume, u.hlNzOther], ['0', '0', '0', '0'], 'a missing manifest case is unknown, never a diagnosis');
    }
    assert.equal(kv(readbackCauseOperands('payload', [], man)).test, 'UNKNOWN');
    const e = kv(readbackCauseOperands('contradict', undefined, undefined));
    assert.deepEqual([e.test, ...pick(e, [...MS, ...ER, ...HL])], ['contradict', ...Array(15).fill('0')]);
    const big = kv(readbackCauseOperands('unproved', Array.from({ length: 100001 }, () => er('C:\\fx\\plain', acl)), man));
    assert.equal(big.errOther, '99999', 'counts are clipped, never unbounded');
  });

  // Diagnostic-only fields added by Get-PspSnapshot; stripping them must leave readbackFindings byte-identical.
  const DIAG_FIELDS = ['daclValid', 'daclError', 'daclPresent', 'daclNull', 'daclDefaulted', 'getAclBinValid', 'getAclBinError', 'getAclDaclPresent',
    'getAclDaclNull', 'getAclRuleCount', 'getAclAefa', 'getAclAefaMask', 'getAclBracket', 'getAclBracketError', 'hlProbeValid', 'hlProbeError',
    'hlPlainOpenValid', 'hlPlainOpenErr', 'hlFfnValid', 'hlFfnErr'];
  const strip = (objs) => objs.map((o) => Object.fromEntries(Object.entries(o).filter(([k]) => !DIAG_FIELDS.includes(k))));
  const omit = (o, k) => { const x = { ...o }; delete x[k]; return x; };
  const hasOwn = (o, f) => Object.prototype.hasOwnProperty.call(o, f);
  const kvSafe = (l, kind) => {
    assert.ok(OP_LINE.test(l), l); assert.ok(!/secret|evil|S-1-|C:|fx|DATA|INDEX|alt|NotSupported|Exception/i.test(l), l);
    const v = opKv(l); assert.equal(v.kind, kind); return v;
  };

  test('selfcheck: rbstate keeps oracle NULL vs Get-Acl absent+AEFA a contradiction, empty != NULL, explicit Everyone present, unknown/stale excluded', () => {
    const O = `O:${A}G:${A}`; const NULLD = `${O}D:NO_ACCESS_CONTROL`;
    const ms = (g, o, x = {}) => ({ path: 'C:\\fx\\m', openError: 0, isDir: true, isReparse: false, sddl: o, getAclSddl: g, fsutilReparseExit: 1, getAclBracket: 'matching',
      daclValid: true, daclPresent: true, daclNull: true, getAclBinValid: true, getAclDaclPresent: false, getAclDaclNull: true, getAclAefa: true, getAclAefaMask: 2032127, ...x });
    const objs = [
      ms(O, NULLD), ms(O, `${O}D:P`, { daclNull: false, getAclAefa: false, getAclAefaMask: null }), ms(O, NULLD, { getAclDaclPresent: true }),
      ms(O, NULLD, { getAclBracket: 'stale' }), omit(ms(O, NULLD), 'getAclBracket'), ms(O, NULLD, { daclValid: false }), omit(ms(O, NULLD), 'getAclBinValid'),
      ms(O, NULLD, { getAclBinValid: false, getAclBinError: 'NotSupportedException' }), ms(O, `${O}D:P(A;;FA;;;${A})`, { daclNull: false }), ms(O, NULLD, { daclPresent: false }),
      ms(`${O}D:(A;;FA;;;WD)`, `${O}D:(A;;FA;;;WD)`, { daclNull: false, getAclDaclPresent: true }), ms(O, O, { daclPresent: false }), ms(O, O, { getAclBinValid: false }),
      ms(O, NULLD, { isReparse: true }), ms(null, NULLD, { getAclError: 'NotSupportedException' }),
    ];
    assert.deepEqual([hasOwn(objs[4], 'getAclBracket'), objs[4].getAclBracket], [false, undefined], 'the missing-bracket fixture has no field, not the default');
    assert.deepEqual([hasOwn(objs[6], 'getAclBinValid'), objs[6].getAclBinValid], [false, undefined], 'the missing-validity fixture has no field, not the default');
    assert.deepEqual([hasOwn(objs[0], 'getAclBracket'), objs[0].getAclBracket, objs[0].daclNull, objs[0].getAclAefa], [true, 'matching', true, true], 'default fixture shape');
    const v = kvSafe(readbackStateOperands('contradict', objs), 'rbstate');
    const pick = (ks) => ks.map((q) => v[q]);
    assert.deepEqual(pick(['bindOk', 'bindStale', 'bindUnmeasured']), ['8', '1', '1']);
    assert.deepEqual(pick(['nullAbsentAefa', 'presentAbsentNoAefa', 'nullPresent', 'unknownAbsentAefa', 'nullUnknown', 'presentAbsentAefa', 'absentAbsentAefa']),
      ['1', '1', '1', '1', '2', '1', '1'], 'NULL+AEFA, empty (present) vs absent, explicit present never absentAefa, unknown kept apart');
    assert.deepEqual(pick(['nullAbsentNoAefa', 'absentAbsentNoAefa', 'absentPresent', 'presentPresent', 'unknownUnknown']), ['0', '0', '0', '0', '0']);
    const cells = OP_RB_ORACLE.flatMap((x) => OP_RB_GETACL.map((g) => Number(v[`${x}${g[0].toUpperCase()}${g.slice(1)}`])));
    assert.equal(cells.reduce((a2, b2) => a2 + b2, 0), 8, 'only bind=ok rows are paired');
    assert.deepEqual(pick(['aefaMasks', 'aefaMasksOther', 'matchAefa', 'matchUnknown']), ['2032127:4', '0', '1', '1'], 'explicit Everyone with present=true is not matchAefa');
    const r = readbackOperands('contradict', {}, objs).map(opKv);
    assert.equal(String(Number(v.bindOk) + Number(v.bindStale) + Number(v.bindUnmeasured)), r[2].flagMissing, 'rbstate rows are exactly rbsplit flagMissing');
    assert.equal(readbackFindings([objs[0]]).contradictions.length, 1, 'oracle NULL + Get-Acl absent/AEFA stays a contradiction in the original predicate');
    assert.deepEqual(readbackFindings(objs), readbackFindings(strip(objs)), 'readbackFindings ignores every diagnostic field');
    assert.deepEqual(readbackOperands('contradict', {}, objs), readbackOperands('contradict', {}, strip(objs)), 'existing operand lines unchanged');
    const bare = kvSafe(readbackStateOperands('contradict', strip(objs)), 'rbstate');
    assert.deepEqual([bare.bindOk, bare.bindUnmeasured, bare.matchAefa, bare.matchUnknown], ['0', '10', '0', '3'], 'no diagnostic fields: nothing measured, nothing matched');
    assert.equal(kvSafe(readbackStateOperands('payload', undefined), 'rbstate').test, 'UNKNOWN');
    assert.equal(kvSafe(readbackStateOperands('unproved', Array.from({ length: 100001 }, () => objs[0])), 'rbstate').nullAbsentAefa, '99999');
  });

  test('selfcheck: streamjoin binds stream rows to the exact manifest host of the same stage; missing host/stage/ID/SDDL/bracket stay unproved', () => {
    const O = `O:${A}G:${A}`; const P = `${O}D:P(A;;FA;;;${A})`; const Q = `${O}D:P(A;;FR;;;${A})`;
    const man = { cases: [{ id: 'D_ADS', path: 'C:\\fx\\d::$INDEX_ALLOCATION', object: 'C:\\fx\\d' }, { id: 'F_ADS', path: 'C:\\fx\\h.bin:alt', object: 'C:\\fx\\h.bin' },
      { id: 'F_DATA_STREAM', path: 'C:\\fx\\ok.bin::$DATA', object: 'C:\\fx\\ok.bin' }] };
    const row = (p, idx, x = {}) => ({ path: p, openError: 0, infoError: 0, sddlError: 0, isDir: false, isReparse: false, nLinks: 1, volumeSerial: '0000ABCD',
      fileIndex: `00000000000000${idx}`, sddl: P, getAclSddl: P, fsutilReparseExit: 1, fsutilHardlinkExit: 0, fsutilHardlinks: ['x'], getAclBracket: 'matching', ...x });
    const strm = (p, idx, x = {}) => row(p, idx, { getAclSddl: null, getAclError: 'NotSupportedException', fsutilHardlinkExit: 1, fsutilHardlinks: [], ...x });
    const sD = (x) => strm('C:\\fx\\d::$INDEX_ALLOCATION', 'D1', { isDir: true, ...x }); const sF = () => strm('C:\\fx\\h.bin:alt', 'F2'); const sK = () => strm('C:\\fx\\ok.bin::$DATA', 'F3');
    const hD = (x) => row('C:\\fx\\d', 'D1', { isDir: true, ...x }); const hF = (x) => row('C:\\fx\\h.bin', 'F2', x); const hK = (x) => row('C:\\fx\\ok.bin', 'F3', x);
    const snaps = {
      S0: { objects: [sD(), hD(), sF(), hF(), sK(), hK({ getAclSddl: Q })] },
      S1: { objects: [sD(), sF(), sK()] },
      S2: { objects: [sD(), hD({ fileIndex: '00000000000000D9' }), sF(), hF({ sddl: Q, getAclSddl: Q }), sK(), hK({ getAclBracket: 'stale' })] },
      S3: { objects: [sF(), omit(hF(), 'getAclBracket'), sK(), hK({ fsutilHardlinkExit: 1, getAclSddl: null, getAclError: 'NotSupportedException' })] },
    };
    assert.deepEqual([hasOwn(snaps.S3.objects[1], 'getAclBracket'), hasOwn(snaps.S0.objects[1], 'getAclBracket')], [false, true], 'missing bracket is a missing field');
    const all = () => ['S0', 'S1', 'S2', 'S3'].flatMap((t) => snaps[t].objects);
    const before = JSON.stringify(readbackFindings(all()));
    const v = kvSafe(streamJoinOperands('unproved', snaps, man), 'streamjoin');
    const pick = (ks) => ks.map((q) => v[q]);
    assert.deepEqual(pick(['aclRows', 'hlRows', 'joinMatch', 'joinDiff', 'joinUnproved']), ['11', '8', '4', '1', '15']);
    assert.deepEqual(pick(['uManifest', 'uStreamRow', 'uHostRow', 'uOpen', 'uIdentity', 'uSddl', 'uBracket', 'uReadback']), ['0', '1', '5', '0', '1', '2', '4', '2'],
      'host only in another stage, ID or SDDL mismatch, stale or missing bracket, host without read-back: unproved');
    assert.equal(JSON.stringify(readbackFindings(all())), before, 'the join never changes readbackFindings');
    assert.deepEqual(readbackFindings(all()), readbackFindings(strip(all())));
    const f = readbackFindings(all());
    assert.ok(f.contradictions.some((x) => x.startsWith('C:\\fx\\ok.bin:')), 'the host mismatch (joinDiff) is still the original contradiction');
    assert.equal(f.unproved.filter((x) => x.includes(':alt') || x.includes('::$')).length, 19, 'every stream read-back stays unproved in the original predicate');
    for (const m of [undefined, null, {}, { cases: man.cases.map((c) => omit(c, 'object')) }, { cases: [...man.cases, man.cases[0]] }]) {
      const w = kvSafe(streamJoinOperands('unproved', snaps, m), 'streamjoin');
      const dup = m && Array.isArray(m.cases) && m.cases.length === 4;
      assert.deepEqual([w.joinMatch, w.joinDiff], dup ? ['3', '1'] : ['0', '0'], `no host is guessed from the stream path: ${JSON.stringify(m)}`);
      assert.equal(w.uManifest, dup ? '4' : '12');
    }
    assert.equal(kvSafe(streamJoinOperands('payload', undefined, undefined), 'streamjoin').test, 'UNKNOWN');
  });

  test('selfcheck: hlprobe counts measured plain-open / FindFirstFileNameW codes by rbcause class; invalid or missing probe is unknown', () => {
    const O = `O:${A}G:${A}`; const P = `${O}D:P(A;;FA;;;${A})`;
    const man = { cases: [{ id: 'D_ADS', path: 'C:\\fx\\d::$INDEX_ALLOCATION' }, { id: 'F_ADS', path: 'C:\\fx\\secret.bin:alt' }, { id: 'F_DATA_STREAM', path: 'C:\\fx\\ok.bin::$DATA' }] };
    const acl = { volumeError: 0, persistentAcls: true };
    const hp = (p, v, x = {}) => ({ path: p, openError: 0, isDir: false, isReparse: false, nLinks: 1, sddl: P, getAclSddl: P, fsutilReparseExit: 1, fsutilHardlinkExit: 1,
      hlProbeValid: true, hlPlainOpenValid: true, hlPlainOpenErr: 0, hlFfnValid: true, hlFfnErr: 0, ...v, ...x });
    const objs = [
      hp('C:\\fx\\secret.bin:alt', acl), hp('C:\\fx\\plain', acl, { hlFfnErr: 5 }), hp('C:\\fx\\plain', acl, { hlPlainOpenErr: 5, hlFfnErr: 5 }),
      omit(hp('C:\\fx\\plain', acl), 'hlProbeValid'), hp('C:\\fx\\plain', { volumeError: 0, persistentAcls: false }, { hlFfnValid: false }), hp('C:\\fx\\plain', { volumeError: 87 }),
      hp('C:\\fx\\plain', acl, { fsutilHardlinkExit: 0 }), hp('C:\\fx\\plain', acl, { isDir: true }), hp('C:\\fx\\plain', acl, { isReparse: true, fsutilReparseExit: 0 }),
    ];
    assert.deepEqual([hasOwn(objs[3], 'hlProbeValid'), objs[3].hlProbeValid], [false, undefined], 'the missing-probe fixture has no field, not the default');
    const v = kvSafe(hardlinkProbeOperands('unproved', objs, man), 'hlprobe');
    const pick = (ks) => ks.map((q) => v[q]);
    assert.deepEqual(pick(['rows', 'streamBothOk', 'otherFfnErr', 'otherPlainErr', 'otherUnknown', 'nonAclUnknown', 'unknownBothOk']), ['6', '1', '1', '1', '1', '1', '1']);
    assert.deepEqual(pick(['plainErrs', 'plainErrsOther', 'plainUnknown', 'ffnErrs', 'ffnErrsOther', 'ffnUnknown']), ['0:4,5:1', '0', '1', '0:2,5:2', '0', '2']);
    const c = kvSafe(readbackCauseOperands('unproved', objs, man), 'rbcause');
    assert.equal(v.rows, String(['hlNzStream', 'hlNzNonAclVolume', 'hlNzOther', 'hlNzUnknown'].reduce((a2, q) => a2 + Number(c[q]), 0)), 'rows are exactly the rbcause hlNz rows');
    assert.deepEqual(readbackFindings(objs), readbackFindings(strip(objs)));
    const many = kvSafe(hardlinkProbeOperands('unproved', [1, 2, 3, 4, 5, 6].map((e) => hp('C:\\fx\\plain', acl, { hlPlainOpenErr: e })), man), 'hlprobe');
    assert.deepEqual([many.plainErrs, many.plainErrsOther, many.otherPlainErr], ['1:1,2:1,3:1,4:1', '2', '6'], 'at most four codes, the rest counted as other');
    const odd = kvSafe(hardlinkProbeOperands('unproved', [hp('C:\\fx\\plain', acl, { hlPlainOpenErr: '5' }), hp('C:\\fx\\plain', acl, { hlFfnErr: 1.5 })], man), 'hlprobe');
    assert.deepEqual([odd.otherUnknown, odd.plainUnknown, odd.ffnUnknown], ['2', '1', '1'], 'non-integer codes are unknown, never a code');
    assert.equal(kvSafe(hardlinkProbeOperands('payload', undefined, undefined), 'hlprobe').test, 'UNKNOWN');
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
      const codes = expectedWin32(r.result.reason);
      assert.ok(codes && codes.includes(r.result.win32Error), `${c.id}: win32Error ${r.result.win32Error} not the intended code [${codes}] for ${r.result.reason}`);
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
      'probe-Actl.json', 'probe-B1.json', 'probe-B2.json', 'move-measure.json', 'helper-receipt.json',
      'trust.json', 'state.json', 'probe-Atrust.json', 'probe-Btrust.json', 'helper-run.json', 'launches.json'];
    const missing = required.filter((f) => !fs.existsSync(path.join(dir, f)));
    assert.deepEqual(missing, [], `missing receipts: ${missing.join(', ')}`);
  });

  test('verdict: every orchestration stage before the verdict completed', () => {
    assert.deepEqual(stageProblems(run), []);
  });

  test('verdict: helper ABI confirmed from the candidate and every case has an exact expectation', () => {
    assert.ok(cases.length > 0, 'manifest lists no cases');
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

    // R7: the r2 wording is measured, not whitelisted. Any enabled privilege leaves the policy decision HOLD.
    test(`verdict: CONTRACT-HOLD r2 §3 "no privileges enabled" holds for fake user ${who}`, (t) => {
      const idr = load(`identity-${who}.json`);
      opDiag(t, () => privOperands(who, idr));
      assert.ok(idr && asArray(idr.privileges).length > 0, 'whoami /priv not measured');
      const enabled = enabledPrivileges(idr);
      assert.deepEqual(enabled, [], `CONTRACT_UNPROVED (policy HOLD, not whitelisted): enabled privileges ${enabled.join(',')}`);
    });
  }

  // R5: every launch ran as the intended runtime identity; the helper node run exited 0.
  for (const [file, who, node] of [['probe-Actl.json', 'A', false], ['move-measure.json', 'A', false], ['helper-run.json', 'A', true],
    ['probe-B1.json', 'B', false], ['probe-B2.json', 'B', false], ['probe-Atrust.json', 'A', false], ['probe-Btrust.json', 'B', false]]) {
    test(`verdict: ${file} ran as fake user ${who}${node ? ' and node exited 0' : ''}`, (t) => {
      opDiag(t, () => [launchOperands(file.slice(0, -5), load(file), who === 'A' ? sidA : sidB, node), ...(node ? [helperRunOperands(helperReceipt)] : [])]);
      assert.ok(/^S-1-5-21-/.test(String(sidA)) && /^S-1-5-21-/.test(String(sidB)) && sidA !== sidB, 'fake user SIDs not recorded');
      assert.deepEqual(launchProblems(load(file), who === 'A' ? sidA : sidB, { node }), []);
    });
  }

  test('verdict: every captured self-report is bound to exactly one admin-observed launch (exit 0, not timed out)', (t) => {
    const receipts = Object.fromEntries(EXPECTED_LAUNCHES.map(([tag]) => [tag, load(`${tag}.json`)]));
    opDiag(t, () => bindOperands(load('launches.json'), manifest && manifest.users, receipts));
    assert.deepEqual(launchBindingProblems(load('launches.json'), manifest && manifest.users, receipts), []);
  });

  test('verdict: elevated node runtime equals the approved workflow pin', () => {
    const n = env && env.node;
    assert.ok(n && /^[0-9a-f]{64}$/.test(String(n.pinnedSha256)), 'node pin not recorded');
    assert.equal(n.sha256, n.pinnedSha256);
    assert.equal(n.version, n.pinnedVersion);
  });

  test('verdict: every essential fixture is available (unavailable => HOLD, never skipped)', () => {
    assert.ok(manifest, 'manifest missing');
    assert.deepEqual(asArray(manifest.unavailable), []);
    for (const c of cases) assert.ok(c.path, `${c.id} has no requested path`);
  });

  const pl = (k) => asArray(manifest && manifest.probes && manifest.probes[k]);
  const selfOf = (t) => ['read', 'create', 'delete'].map((x) => `${t}-self-${x}`);
  const ownOf = (t) => ['create', 'write', 'delete'].map((x) => `${t}-own-${x}`);
  const probeSpec = [
    ['probe-Actl.json', 'A positive control', () => pl('Actl'), 'A', ['A-list', 'A-create', 'A-read', 'A-write-open'], 0],
    ['probe-B1.json', 'B on pre-existing A objects', () => [...pl('B1self'), ...pl('B1')], 'B', selfOf('B1'), 12],
    ['probe-B2.json', 'B on helper-created objects', () => [...pl('B2self'), ...pl('B2')], 'B', selfOf('B2'), 12],
    ['probe-Atrust.json', 'A on trusted state/oracle/sources', () => pl('Atrust'), 'A', ownOf('Atrust'), 15],
    ['probe-Btrust.json', 'B on trusted state/oracle/sources', () => pl('Btrust'), 'B', ownOf('Btrust'), 15],
  ];
  for (const [file, label, plan, who, selfIds, minDenials] of probeSpec) {
    test(`verdict: ${label}: plan, runtime SID, positive controls and numeric Win32 codes`, () => {
      assert.deepEqual(probeProblems(load(file), plan(), { sid: who === 'A' ? sidA : sidB, selfIds, minDenials }), []);
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
    test(`verdict: helper ${c.id} ${c.op} equals oracle`, (t) => {
      const r = results.get(c.id);
      const o = oracleFor(c);
      opDiag(t, () => [helperOperands(c, r, o, expectedHelperStatus(c.id, o.cls)), ...(OP_LINK_CASES[c.id]
        ? [linkAclOperands(c, get('S0', linkObjectPath(c)), { A: sidA, B: sidB, adminUser: manifest.trust && manifest.trust.adminSid })] : [])]);
      assert.deepEqual(helperResultProblems(c.id, r, expectedHelperStatus(c.id, o.cls)), [], `oracle ${o.cls}/${o.reason}`);
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

  test('verdict: pre-existing fixtures and trusted objects unchanged S0 -> S1 -> S2 -> S3 (sha256, SDDL, links, type)', () => {
    const mutable = new Set(asArray(manifest.mutable).map((p) => p.toLowerCase()));
    const diffs = [];
    assert.ok(asArray(manifest.trustObjects).length >= 10 && asArray(manifest.binObjects).length >= 5, 'trusted object list missing');
    for (const p of [...asArray(manifest.snapshotObjects), ...asArray(manifest.trustObjects), ...asArray(manifest.binObjects)]) {
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

  // R2: trusted root read back before any account existed, and every trusted/bin object stays non-writable
  // by A/B at every snapshot. The state cleanup will trust passes the independent twin validator.
  test('verdict: trusted root was protected and read back (oracle == Get-Acl) before fake accounts existed', () => {
    const tr = load('trust.json');
    assert.ok(tr && asArray(tr.readback).length >= 10, 'trust readback missing');
    const bad = asArray(tr.readback).filter((x) => asArray(x.problems).length > 0 || x.getAclSddl !== x.sddl).map((x) => `${x.path}: ${asArray(x.problems).join(',')}`);
    assert.deepEqual(bad, []);
    assert.equal(tr.root, manifest.trust.root);
    assert.equal(asArray(run && run.stages).map((s) => s.name)[0], 'environment', 'trust.json is written before the first stage');
    assert.ok(tr.runnerTemp && (typeof tr.runnerTemp.sddl === 'string' || tr.runnerTemp.icacls), 'parent RUNNER_TEMP ACL not recorded');
  });

  test('verdict: trusted and bin objects are not writable by A/B at S0..S3', () => {
    const t = manifest.trust;
    const owners = [SID_ADMINS, SID_SYSTEM, t.adminSid];
    const bad = [];
    for (const tag of ['S0', 'S1', 'S2', 'S3']) {
      for (const p of asArray(manifest.trustObjects)) {
        const isRoot = p.toLowerCase() === String(t.root).toLowerCase();
        const pr = trustProblems(get(tag, p), { owners: isRoot ? [SID_ADMINS] : owners, protectedDacl: isRoot });
        if (pr.length) bad.push(`${tag} ${p}: ${pr.join(',')}`);
      }
      for (const p of asArray(manifest.binObjects)) {
        const pr = trustProblems(get(tag, p), { owners, readers: [sidA, sidB] });
        if (pr.length) bad.push(`${tag} ${p}: ${pr.join(',')}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test('verdict: recorded cleanup state passes the independent validator (no tamper, exact owned names)', () => {
    const st = load('state.json');
    assert.deepEqual(validateCleanupState(st, { tempLong: process.env.PSP_TEMP_LONG, runId: process.env.PSP_RUN_ID }), []);
    assert.equal(st.root, manifest.root);
    assert.deepEqual(asArray(st.users).map((u) => u.sid), [sidA, sidB]);
  });

  // R6: Get-Acl / fsutil read-back. Contradictions fail; anything not read back is CONTRACT_UNPROVED.
  const allSnapObjects = () => ['S0', 'S1', 'S2', 'S3'].flatMap((t) => asArray(snaps[t] && snaps[t].objects));
  test('verdict: independent read-back never contradicts the backup-handle oracle', (t) => {
    opDiag(t, () => readbackOperands('contradict', snaps, allSnapObjects()));
    opDiag(t, () => readbackCauseOperands('contradict', allSnapObjects(), manifest));
    opDiag(t, () => readbackStateOperands('contradict', allSnapObjects()));
    opDiag(t, () => streamJoinOperands('contradict', snaps, manifest));
    opDiag(t, () => hardlinkProbeOperands('contradict', allSnapObjects(), manifest));
    assert.deepEqual(snapshotSetProblems(snaps), []);
    assert.deepEqual(readbackFindings(allSnapObjects()).contradictions, []);
  });
  test('verdict: CONTRACT-HOLD r2 §4 Get-Acl/fsutil read-back available for every gated object', (t) => {
    opDiag(t, () => readbackOperands('unproved', snaps, allSnapObjects()));
    opDiag(t, () => readbackCauseOperands('unproved', allSnapObjects(), manifest));
    opDiag(t, () => readbackStateOperands('unproved', allSnapObjects()));
    opDiag(t, () => streamJoinOperands('unproved', snaps, manifest));
    opDiag(t, () => hardlinkProbeOperands('unproved', allSnapObjects(), manifest));
    assert.deepEqual(snapshotSetProblems(snaps), [], 'CONTRACT_UNPROVED: no read-back evidence at all');
    const { unproved } = readbackFindings(allSnapObjects());
    assert.deepEqual(unproved, [], `CONTRACT_UNPROVED (not waived, oracle not replaced): ${unproved.length} read-backs unavailable`);
  });

  test('verdict: feasibility measurements recorded (values reported, not judged)', () => {
    const mm = load('move-measure.json');
    assert.ok(mm && mm.ok && mm.measure, 'MoveFileExW descriptor measurement missing');
    assert.ok(env && typeof env.elevatedDefaultOwnerSddl === 'string', 'elevated default owner missing');
    const ia = load('identity-A.json');
    assert.ok(ia && ia.node && ia.node.exit === 0, 'win32 O_NOFOLLOW (as A) missing');
  });
}
