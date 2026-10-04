// #1167 — regression for win-launch-tap-check.mjs (harness only; no product code is run). Fake/inert fixtures only.
// The intended 31 names are derived independently from the pinned win-launch.test.ts (template expanded) and must
// match the real CI TAP records; positive controls are real node --test TAP from inert same-named tests; the two
// actual previous CI TAPs (embedded, sha256-checked) must stay red; every counterfactual must be exit 1 + mismatch.
// usage: node --test tests/dispatch/win-launch-tap-check.test.mjs   (WIN_LAUNCH_TEST_TS overrides the source path)
import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, 'win-launch-tap-check.mjs');
const SELF = fileURLToPath(import.meta.url);
const WORKFLOW = path.join(HERE, '..', '..', '.github', 'workflows', 'windows-npm-direct-validation.yml');
const SOURCE = process.env.WIN_LAUNCH_TEST_TS || path.join(HERE, '..', 'session', 'boot-adapter', 'win-launch.test.ts');
const SOURCE_SHA = '2e03a66121fd9a65e3e796b80e8f56973a748807f5cd6c3c8f07f493e4112c11';
const ENV = { ...process.env }; delete ENV.NODE_TEST_CONTEXT; // children must be plain processes, not test-runner children
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tapcheck-'));
process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }));

// ---- intended names from the pinned source (independent of the checker's static list) ----
function intendedFromSource(src) {
  const names = [];
  const calls = [...src.matchAll(/^([ \t]*)test\((?:"((?:[^"\\\n]|\\.)*)"|`([^`\n]*)`),/gm)];
  for (const m of calls) {
    if (m[2] !== undefined) { names.push(JSON.parse(`"${m[2]}"`)); continue; }
    // template: expand over the for-of chain on the line before the call (outer loop varies slowest)
    const prev = src.slice(0, m.index).trimEnd().split('\n').at(-1);
    const loops = [...prev.matchAll(/for \(const (\w+) of \[([^\]]*)\] as const\)/g)];
    assert.ok(loops.length > 0, `template test without for-of: ${m[3]}`);
    let out = [m[3]];
    for (const [, v, list] of loops) { const vals = JSON.parse(`[${list}]`); out = out.flatMap(s => vals.map(x => s.split('${' + v + '}').join(x))); }
    assert.ok(out.every(s => !s.includes('${')), `unexpanded template: ${m[3]}`);
    names.push(...out);
  }
  return { names, calls: calls.length };
}
const SRC = fs.readFileSync(SOURCE);
const { names: INTENDED, calls: CALLS } = intendedFromSource(SRC.toString('utf8'));
const tapName = s => s.replace(/\\/g, '\\\\').replace(/#/g, '\\#');
const TOP = /^(not ok|ok) (\d+) - (.*?)(?: # (SKIP|TODO)\b.*)?$/;
const topNames = tap => tap.split('\n').map(l => TOP.exec(l)).filter(Boolean).map(m => m[3]);
// role outcome expectations (task #1167 contract), stated here independently of the checker's BASELINE table
const candOutcome = n => /^T10 \[POSIX\] /.test(n) ? 'skip' : 'pass';
const baseOutcome = n => /^(T10 \[POSIX\]|P[1-4]) /.test(n) ? 'skip'
  : /^(O[1-5] |T-miss |evidence root )/.test(n) ? 'pass' : 'fail';

// ---- the two actual previous CI TAPs (Windows, node v20.20.2; both classified mismatch) ----
const CI_CANDIDATE_SHA = '49618b537bcf95b9e67d168380e337bc13bdfd53a2ad5b9c4671f56db378e63a';
const CI_BASELINE_SHA = 'f15aa3d5812c1f75807b5f39f704086e230a1de7a8c485a0dcb7de812edab9d7';
const CI_CANDIDATE = String.raw`TAP version 13
# Subtest: O1 generator identity: pinned cmd-shim 6.0.3 located and hash-verified
ok 1 - O1 generator identity: pinned cmd-shim 6.0.3 located and hash-verified # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 1.9354
  ...
# Subtest: O2 contract §2 transcription == generator bytes for V-A (A empty / A set) and V-B
ok 2 - O2 contract §2 transcription == generator bytes for V-A (A empty / A set) and V-B # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.4083
  ...
# Subtest: O3 V-V (env -S K=V) generator bytes differ from V-A and carry @SET
ok 3 - O3 V-V (env -S K=V) generator bytes differ from V-A and carry @SET # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.117
  ...
# Subtest: O4 generator emits non-inert fields unrefused (recognition must enforce inertness)
ok 4 - O4 generator emits non-inert fields unrefused (recognition must enforce inertness) # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.1081
  ...
# Subtest: O5 negative mutation set: every mutation changes the bytes and all are distinct
ok 5 - O5 negative mutation set: every mutation changes the bytes and all are distinct # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.1121
  ...
# Subtest: T10 [POSIX] run(): one spawn, argv0/args/cwd/env as given, shell false, literals byte-exact
ok 6 - T10 [POSIX] run(): one spawn, argv0/args/cwd/env as given, shell false, literals byte-exact # SKIP POSIX identity control
  ---
  duration_ms: 0.1014
  ...
# Subtest: T10 [POSIX] probeVersion(): one spawn [exe, --version]; missing exe → CLI_NOT_FOUND
ok 7 - T10 [POSIX] probeVersion(): one spawn [exe, --version]; missing exe → CLI_NOT_FOUND # SKIP POSIX identity control
  ---
  duration_ms: 0.2329
  ...
# Subtest: T10 [POSIX] run() missing bare exe keeps the real ENOENT
ok 8 - T10 [POSIX] run() missing bare exe keeps the real ENOENT # SKIP POSIX identity control
  ---
  duration_ms: 0.1359
  ...
# Subtest: T10 [POSIX] geminiBinary(): PATH X_OK agy → agy, else gemini (unchanged)
ok 9 - T10 [POSIX] geminiBinary(): PATH X_OK agy → agy, else gemini (unchanged) # SKIP POSIX identity control
  ---
  duration_ms: 0.2584
  ...
# Subtest: T1+T2 [win32] V-A local/bare/PATH: direct node, literals byte-exact, no sentinel, stdin hash
ok 10 - T1+T2 [win32] V-A local/bare/PATH: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.236
  ...
# Subtest: T1+T2 [win32] V-A local/bare/Path: direct node, literals byte-exact, no sentinel, stdin hash
ok 11 - T1+T2 [win32] V-A local/bare/Path: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.1347
  ...
# Subtest: T1+T2 [win32] V-A local/abs/PATH: direct node, literals byte-exact, no sentinel, stdin hash
ok 12 - T1+T2 [win32] V-A local/abs/PATH: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.1115
  ...
# Subtest: T1+T2 [win32] V-A local/abs/Path: direct node, literals byte-exact, no sentinel, stdin hash
ok 13 - T1+T2 [win32] V-A local/abs/Path: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.1015
  ...
# Subtest: T1+T2 [win32] V-A prefix/bare/PATH: direct node, literals byte-exact, no sentinel, stdin hash
ok 14 - T1+T2 [win32] V-A prefix/bare/PATH: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.1923
  ...
# Subtest: T1+T2 [win32] V-A prefix/bare/Path: direct node, literals byte-exact, no sentinel, stdin hash
ok 15 - T1+T2 [win32] V-A prefix/bare/Path: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.1197
  ...
# Subtest: T1+T2 [win32] V-A prefix/abs/PATH: direct node, literals byte-exact, no sentinel, stdin hash
ok 16 - T1+T2 [win32] V-A prefix/abs/PATH: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.2068
  ...
# Subtest: T1+T2 [win32] V-A prefix/abs/Path: direct node, literals byte-exact, no sentinel, stdin hash
ok 17 - T1+T2 [win32] V-A prefix/abs/Path: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.1292
  ...
# Subtest: T2 [win32] native .exe hit launched as-is; V-B native target via dp0+\\+T
ok 18 - T2 [win32] native .exe hit launched as-is; V-B native target via dp0+\\+T # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.301
  ...
# Subtest: T4 [win32] byte/line/BOM/newline/field mutations, V-V, unknown version, non-inert fields → refuse
ok 19 - T4 [win32] byte/line/BOM/newline/field mutations, V-V, unknown version, non-inert fields → refuse # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.1358
  ...
# Subtest: T5 [win32] earlier .bat / bad .cmd hit → refuse, never skip to the later valid shim
ok 20 - T5 [win32] earlier .bat / bad .cmd hit → refuse, never skip to the later valid shim # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.1652
  ...
# Subtest: T6 [win32] dp0\\node.exe present → that interpreter; node→node.cmd → refuse
ok 21 - T6 [win32] dp0\\node.exe present → that interpreter; node→node.cmd → refuse # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.1194
  ...
# Subtest: T7 [win32] shim dir containing & → refuse
ok 22 - T7 [win32] shim dir containing & → refuse # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0801
  ...
# Subtest: T8 [win32] >32767 command line → OS spawn error, no payload; 30000 control byte-exact
ok 23 - T8 [win32] >32767 command line → OS spawn error, no payload; 30000 control byte-exact # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0732
  ...
# Subtest: T9 [win32] non-reading child with 8 MiB stdin → no crash, no delivery claim
ok 24 - T9 [win32] non-reading child with 8 MiB stdin → no crash, no delivery claim # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0703
  ...
# Subtest: T-miss [win32] missing bare name keeps ENOENT (not CLI_LAUNCH_UNSUPPORTED)
ok 25 - T-miss [win32] missing bare name keeps ENOENT (not CLI_LAUNCH_UNSUPPORTED) # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0722
  ...
# Subtest: P1 parseCmdShim accepts oracle V-A/V-B bytes with the authored fields
ok 26 - P1 parseCmdShim accepts oracle V-A/V-B bytes with the authored fields # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0705
  ...
# Subtest: P2 parseCmdShim rejects mutations, V-V, unknown version, non-inert/unsupported fields
ok 27 - P2 parseCmdShim rejects mutations, V-V, unknown version, non-inert/unsupported fields # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0708
  ...
# Subtest: P3 candidate generateCmdShim(fields) == pinned upstream generator bytes (product vs oracle)
ok 28 - P3 candidate generateCmdShim(fields) == pinned upstream generator bytes (product vs oracle) # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.079
  ...
# Subtest: P4 resource characterization: parseCmdShim has no input size bound (record only)
ok 29 - P4 resource characterization: parseCmdShim has no input size bound (record only) # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0698
  ...
# Subtest: T-gem [win32] geminiBinary: any first agy hit (even unsupported agy.cmd) → agy; none → gemini
ok 30 - T-gem [win32] geminiBinary: any first agy hit (even unsupported agy.cmd) → agy; none → gemini
  ---
  duration_ms: 2.8388
  ...
# Subtest: evidence root preserved (owned, not deleted)
ok 31 - evidence root preserved (owned, not deleted)
  ---
  duration_ms: 0.3122
  ...
# root=D:\\a\\_temp\\wl-tmp\\win-launch (owned) QCleJt
1..31
# tests 31
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 29
# todo 0
# duration_ms 152.478
`;
const CI_BASELINE = String.raw`TAP version 13
# Subtest: O1 generator identity: pinned cmd-shim 6.0.3 located and hash-verified
ok 1 - O1 generator identity: pinned cmd-shim 6.0.3 located and hash-verified # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 1.0823
  ...
# Subtest: O2 contract §2 transcription == generator bytes for V-A (A empty / A set) and V-B
ok 2 - O2 contract §2 transcription == generator bytes for V-A (A empty / A set) and V-B # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.1271
  ...
# Subtest: O3 V-V (env -S K=V) generator bytes differ from V-A and carry @SET
ok 3 - O3 V-V (env -S K=V) generator bytes differ from V-A and carry @SET # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0716
  ...
# Subtest: O4 generator emits non-inert fields unrefused (recognition must enforce inertness)
ok 4 - O4 generator emits non-inert fields unrefused (recognition must enforce inertness) # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0541
  ...
# Subtest: O5 negative mutation set: every mutation changes the bytes and all are distinct
ok 5 - O5 negative mutation set: every mutation changes the bytes and all are distinct # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0522
  ...
# Subtest: T10 [POSIX] run(): one spawn, argv0/args/cwd/env as given, shell false, literals byte-exact
ok 6 - T10 [POSIX] run(): one spawn, argv0/args/cwd/env as given, shell false, literals byte-exact # SKIP POSIX identity control
  ---
  duration_ms: 0.0622
  ...
# Subtest: T10 [POSIX] probeVersion(): one spawn [exe, --version]; missing exe → CLI_NOT_FOUND
ok 7 - T10 [POSIX] probeVersion(): one spawn [exe, --version]; missing exe → CLI_NOT_FOUND # SKIP POSIX identity control
  ---
  duration_ms: 0.1175
  ...
# Subtest: T10 [POSIX] run() missing bare exe keeps the real ENOENT
ok 8 - T10 [POSIX] run() missing bare exe keeps the real ENOENT # SKIP POSIX identity control
  ---
  duration_ms: 0.0624
  ...
# Subtest: T10 [POSIX] geminiBinary(): PATH X_OK agy → agy, else gemini (unchanged)
ok 9 - T10 [POSIX] geminiBinary(): PATH X_OK agy → agy, else gemini (unchanged) # SKIP POSIX identity control
  ---
  duration_ms: 0.1288
  ...
# Subtest: T1+T2 [win32] V-A local/bare/PATH: direct node, literals byte-exact, no sentinel, stdin hash
ok 10 - T1+T2 [win32] V-A local/bare/PATH: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.105
  ...
# Subtest: T1+T2 [win32] V-A local/bare/Path: direct node, literals byte-exact, no sentinel, stdin hash
ok 11 - T1+T2 [win32] V-A local/bare/Path: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0628
  ...
# Subtest: T1+T2 [win32] V-A local/abs/PATH: direct node, literals byte-exact, no sentinel, stdin hash
ok 12 - T1+T2 [win32] V-A local/abs/PATH: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.5562
  ...
# Subtest: T1+T2 [win32] V-A local/abs/Path: direct node, literals byte-exact, no sentinel, stdin hash
ok 13 - T1+T2 [win32] V-A local/abs/Path: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0561
  ...
# Subtest: T1+T2 [win32] V-A prefix/bare/PATH: direct node, literals byte-exact, no sentinel, stdin hash
ok 14 - T1+T2 [win32] V-A prefix/bare/PATH: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0991
  ...
# Subtest: T1+T2 [win32] V-A prefix/bare/Path: direct node, literals byte-exact, no sentinel, stdin hash
ok 15 - T1+T2 [win32] V-A prefix/bare/Path: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0496
  ...
# Subtest: T1+T2 [win32] V-A prefix/abs/PATH: direct node, literals byte-exact, no sentinel, stdin hash
ok 16 - T1+T2 [win32] V-A prefix/abs/PATH: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.093
  ...
# Subtest: T1+T2 [win32] V-A prefix/abs/Path: direct node, literals byte-exact, no sentinel, stdin hash
ok 17 - T1+T2 [win32] V-A prefix/abs/Path: direct node, literals byte-exact, no sentinel, stdin hash # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0511
  ...
# Subtest: T2 [win32] native .exe hit launched as-is; V-B native target via dp0+\\+T
ok 18 - T2 [win32] native .exe hit launched as-is; V-B native target via dp0+\\+T # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.12
  ...
# Subtest: T4 [win32] byte/line/BOM/newline/field mutations, V-V, unknown version, non-inert fields → refuse
ok 19 - T4 [win32] byte/line/BOM/newline/field mutations, V-V, unknown version, non-inert fields → refuse # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0523
  ...
# Subtest: T5 [win32] earlier .bat / bad .cmd hit → refuse, never skip to the later valid shim
ok 20 - T5 [win32] earlier .bat / bad .cmd hit → refuse, never skip to the later valid shim # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0782
  ...
# Subtest: T6 [win32] dp0\\node.exe present → that interpreter; node→node.cmd → refuse
ok 21 - T6 [win32] dp0\\node.exe present → that interpreter; node→node.cmd → refuse # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.042
  ...
# Subtest: T7 [win32] shim dir containing & → refuse
ok 22 - T7 [win32] shim dir containing & → refuse # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0553
  ...
# Subtest: T8 [win32] >32767 command line → OS spawn error, no payload; 30000 control byte-exact
ok 23 - T8 [win32] >32767 command line → OS spawn error, no payload; 30000 control byte-exact # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0328
  ...
# Subtest: T9 [win32] non-reading child with 8 MiB stdin → no crash, no delivery claim
ok 24 - T9 [win32] non-reading child with 8 MiB stdin → no crash, no delivery claim # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0266
  ...
# Subtest: T-miss [win32] missing bare name keeps ENOENT (not CLI_LAUNCH_UNSUPPORTED)
ok 25 - T-miss [win32] missing bare name keeps ENOENT (not CLI_LAUNCH_UNSUPPORTED) # SKIP ORACLE_UNAVAILABLE: lib/index.js hash mismatch at C:\\hostedtoolcache\\windows\\node\\20.20.2\\x64\\node_modules\\npm\\node_modules\\cmd-shim
  ---
  duration_ms: 0.0249
  ...
# Subtest: P1 parseCmdShim accepts oracle V-A/V-B bytes with the authored fields
ok 26 - P1 parseCmdShim accepts oracle V-A/V-B bytes with the authored fields # SKIP candidate win-launch.js absent in this tree (baseline)
  ---
  duration_ms: 0.0259
  ...
# Subtest: P2 parseCmdShim rejects mutations, V-V, unknown version, non-inert/unsupported fields
ok 27 - P2 parseCmdShim rejects mutations, V-V, unknown version, non-inert/unsupported fields # SKIP candidate win-launch.js absent in this tree (baseline)
  ---
  duration_ms: 0.0258
  ...
# Subtest: P3 candidate generateCmdShim(fields) == pinned upstream generator bytes (product vs oracle)
ok 28 - P3 candidate generateCmdShim(fields) == pinned upstream generator bytes (product vs oracle) # SKIP candidate win-launch.js absent in this tree (baseline)
  ---
  duration_ms: 0.025
  ...
# Subtest: P4 resource characterization: parseCmdShim has no input size bound (record only)
ok 29 - P4 resource characterization: parseCmdShim has no input size bound (record only) # SKIP candidate win-launch.js absent in this tree (baseline)
  ---
  duration_ms: 0.0255
  ...
# Subtest: T-gem [win32] geminiBinary: any first agy hit (even unsupported agy.cmd) → agy; none → gemini
not ok 30 - T-gem [win32] geminiBinary: any first agy hit (even unsupported agy.cmd) → agy; none → gemini
  ---
  duration_ms: 2.1494
  location: 'D:\\a\\aigentry-orchestrator\\aigentry-orchestrator\\baseline\\dist\\tests\\session\\boot-adapter\\win-launch.test.js:405:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    
    + 'gemini'
    - 'agy'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'agy'
  actual: 'gemini'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///D:/a/aigentry-orchestrator/aigentry-orchestrator/baseline/dist/tests/session/boot-adapter/win-launch.test.js:409:12)
    Test.runInAsyncScope (node:async_hooks:206:9)
    Test.run (node:internal/test_runner/test:796:25)
    Test.processPendingSubtests (node:internal/test_runner/test:526:18)
    Test.postRun (node:internal/test_runner/test:889:19)
    Test.run (node:internal/test_runner/test:835:12)
    async Test.processPendingSubtests (node:internal/test_runner/test:526:7)
  ...
# Subtest: evidence root preserved (owned, not deleted)
ok 31 - evidence root preserved (owned, not deleted)
  ---
  duration_ms: 0.1911
  ...
# root=D:\\a\\_temp\\wl-tmp\\win-launch (owned) qnwkrk
1..31
# tests 31
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 29
# todo 0
# duration_ms 89.9237
`;

// ---- helpers ----
let seq = 0;
function check(mode, tap, raw) {
  const f = path.join(DIR, `c${++seq}.tap`), o = `${f}.json`;
  fs.writeFileSync(f, tap);
  const r = cp.spawnSync(process.execPath, [CHECKER, mode, f, raw, o], { encoding: 'utf8', env: ENV, timeout: 30_000 });
  return { status: r.status, signal: r.signal, j: fs.existsSync(o) ? JSON.parse(fs.readFileSync(o, 'utf8')) : null };
}
function green(r, verdict) { assert.equal(r.status, 0, JSON.stringify(r.j?.problems)); assert.equal(r.j.verdict, verdict); assert.deepEqual(r.j.problems, []); }
function red(r, re) {
  assert.equal(r.status, 1, `exit ${r.status} ${r.signal ?? ''}`);
  assert.equal(r.j.verdict, 'mismatch');
  assert.ok(r.j.problems.some(p => re.test(p)), `no problem matching ${re}: ${JSON.stringify(r.j.problems)}`);
}
// real node --test TAP over inert same-named tests (T4-T6 carry nested subtests like the source does)
function inertTap(role) {
  const want = role === 'candidate' ? candOutcome : baseOutcome;
  const body = INTENDED.map(n => {
    const o = want(n), nested = /^T[456] \[win32\] /.test(n);
    if (o === 'skip') return `test(${JSON.stringify(n)}, { skip: 'inert skip' }, () => {});`;
    if (nested) return `test(${JSON.stringify(n)}, async (t) => { await t.test('a', () => {}); await t.test('b', () => { ${o === 'fail' ? "assert.fail('inert')" : ''} }); });`;
    return `test(${JSON.stringify(n)}, () => { ${o === 'fail' ? "assert.fail('inert')" : ''} });`;
  });
  const f = path.join(DIR, `inert-${role}.test.mjs`);
  fs.writeFileSync(f, `import test from 'node:test';\nimport assert from 'node:assert';\n${body.join('\n')}\n`);
  const r = cp.spawnSync(process.execPath, ['--test', '--test-reporter=tap', f], { encoding: 'utf8', env: ENV, timeout: 60_000 });
  assert.equal(r.signal, null, 'inert node --test timed out');
  return { tap: r.stdout, raw: String(r.status) };
}
const L = tap => tap.split('\n');
const setFooter = (tap, k, f) => tap.replace(new RegExp(`^# ${k} (\\d+)$`, 'm'), (_, n) => `# ${k} ${f(Number(n))}`);
const rename = (tap, from, to) => L(tap).map(l => { const m = TOP.exec(l); return m && from.test(m[3]) ? l.replace(/ - .*$/, ` - ${to}`) : l; }).join('\n');
function dropTop(tap, re) { // remove one top-level test block, renumber, fix plan and footer: a self-consistent 30-test TAP
  const ls = L(tap), at = ls.findIndex(l => { const m = TOP.exec(l); return m && re.test(m[3]); });
  let start = at; while (!ls[start].startsWith('# Subtest: ')) start--;
  let end = at + 1; while (ls[end].startsWith('  ')) end++;
  const outcome = ls[at].startsWith('not ok') ? 'fail' : / # SKIP/.test(ls[at]) ? 'skipped' : 'pass';
  ls.splice(start, end - start);
  let k = 0; const out = ls.map(l => TOP.test(l) ? l.replace(/^(not ok|ok) \d+ /, (_, s) => `${s} ${++k} `) : l).join('\n');
  return setFooter(setFooter(out.replace(/^1\.\.31$/m, '1..30'), 'tests', n => n - 1), outcome, n => n - 1);
}

const CAND = inertTap('candidate'), BASE = inertTap('baseline');

test('pinned source: 31 unique intended names (24 test() calls, one 2x2x2 template) == both real CI TAP records', () => {
  assert.equal(sha(SRC), SOURCE_SHA, `win-launch.test.ts is not the pinned source: ${SOURCE}`);
  assert.equal(CALLS, 24);
  assert.equal(INTENDED.length, 31);
  assert.equal(new Set(INTENDED).size, 31);
  assert.equal(INTENDED.filter(n => n.startsWith('T1+T2 [win32] V-A ')).length, 8);
  assert.ok(!/^\s*(describe|suite|it)\(|\btest\.(only|skip|todo)\(/m.test(SRC.toString('utf8')), 'source shape the derivation does not cover');
  assert.equal(sha(CI_CANDIDATE), CI_CANDIDATE_SHA);
  assert.equal(sha(CI_BASELINE), CI_BASELINE_SHA);
  for (const tap of [CI_CANDIDATE, CI_BASELINE]) assert.deepEqual(topNames(tap), INTENDED.map(tapName));
  assert.deepEqual(topNames(CI_CANDIDATE).map(n => n.replace(/\\(.)/g, '$1')), INTENDED); // TAP unescape round-trip
});

test('positive controls: real node --test TAP over inert same-named tests', () => {
  assert.equal(CAND.raw, '0'); assert.equal(BASE.raw, '1');
  assert.deepEqual(topNames(CAND.tap), INTENDED.map(tapName));
  assert.ok(Number(/^# tests (\d+)$/m.exec(CAND.tap)[1]) > 31, 'footer counts nested subtests (must not be mistaken for 31)');
  green(check('candidate', CAND.tap, CAND.raw), 'candidate_tests_green_pending_review');
  green(check('baseline', BASE.tap, BASE.raw), 'negative_control_discriminates');
});

test('actual previous CI TAPs stay red on outcomes only (no structural false alarm)', () => {
  for (const [mode, tap, raw, re] of [['candidate', CI_CANDIDATE, '0', /: skip \(want pass\)$/], ['baseline', CI_BASELINE, '1', /\(control expects (pass|fail)\)$/]]) {
    const r = check(mode, tap, raw);
    red(r, re);
    assert.ok(r.j.problems.every(p => re.test(p)), JSON.stringify(r.j.problems));
  }
});

test('counterfactuals: exit 1 + mismatch', async (t) => {
  const c = CAND.tap, b = BASE.tap;
  const unknown = (ok) => ['TAP version 13', ...Array.from({ length: 31 }, (_, k) => `${ok ? 'ok' : 'not ok'} ${k + 1} - bogus ${k + 1}`), '1..31',
    '# tests 31', '# suites 0', `# pass ${ok ? 31 : 0}`, `# fail ${ok ? 0 : 31}`, '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 1', ''].join('\n');
  const last = tap => L(tap).findLastIndex(l => TOP.test(l));
  const cases = [
    ['cand dup O1 replaces T1+T2', 'candidate', rename(c, /^T1\+T2 .*local\/bare\/PATH/, tapName(INTENDED[0])), '0', /duplicate top-level test: O1 /],
    ['cand dup O2 replaces T-gem', 'candidate', rename(c, /^T-gem /, tapName(INTENDED[1])), '0', /intended test missing: T-gem /],
    ['base dup O1 replaces evidence root', 'baseline', rename(b, /^evidence root /, tapName(INTENDED[0])), '1', /duplicate top-level test: O1 /],
    ['base dup T4 replaces T-gem', 'baseline', rename(b, /^T-gem /, tapName(INTENDED.find(n => n.startsWith('T4 ')))), '1', /intended test missing: T-gem /],
    ['cand 31 unknown names', 'candidate', unknown(true), '0', /intended test missing: O1 /],
    ['base 31 unknown names', 'baseline', unknown(false), '1', /intended test missing: O1 /],
    ['cand repeated number 1', 'candidate', L(c).map(l => TOP.test(l) ? l.replace(/^ok \d+ /, 'ok 1 ') : l).join('\n'), '0', /result 2 is numbered 1/],
    ['base repeated number 1', 'baseline', L(b).map(l => TOP.test(l) ? l.replace(/^(not ok|ok) \d+ /, '$1 1 ') : l).join('\n'), '1', /result 2 is numbered 1/],
    ['cand plan 1..99', 'candidate', c.replace(/^1\.\.31$/m, '1..99'), '0', /plan 1\.\.99 /],
    ['base plan 1..5', 'baseline', b.replace(/^1\.\.31$/m, '1..5'), '1', /plan 1\.\.5 /],
    ['cand plan missing', 'candidate', c.replace(/^1\.\.31\n/m, ''), '0', /plan missing/],
    ['cand truncated right after 31st result', 'candidate', L(c).slice(0, last(c) + 1).join('\n'), '0', /plan missing/],
    ['base truncated right after 31st result', 'baseline', L(b).slice(0, last(b) + 1).join('\n'), '1', /plan missing/],
    ['cand truncated inside 31st YAML block', 'candidate', L(c).slice(0, last(c) + 3).join('\n'), '0', /unterminated YAML/],
    ['cand Bail out! appended', 'candidate', `${c}Bail out! crashed\n`, '0', /Bail out!/],
    ['base Bail out! appended', 'baseline', `${b}Bail out! crashed\n`, '1', /Bail out!/],
    ['cand T10 TODO instead of SKIP', 'candidate', setFooter(setFooter(c.replace(/^(ok \d+ - T10 \[POSIX\] .*) # SKIP.*$/gm, '$1 # TODO inert'), 'skipped', n => n - 4), 'todo', n => n + 4), '0', /TODO directive/],
    ['cand missing expected name (consistent 30)', 'candidate', dropTop(c, /^T-gem /), '0', /intended test missing: T-gem /],
    ['cand extra name (consistent 32)', 'candidate', setFooter(setFooter(c.replace(/^1\.\.31$/m, '# Subtest: extra\nok 32 - extra\n  ---\n  duration_ms: 1\n  ...\n1..32'), 'tests', n => n + 1), 'pass', n => n + 1), '0', /extra top-level test 32: extra/],
    ['cand footer tests forced to 31 (nested ignored)', 'candidate', setFooter(c, 'tests', () => 31), '0', /summary # tests 31 != \d+/],
    ['cand footer cancelled 1', 'candidate', setFooter(c, 'cancelled', () => 1), '0', /summary # cancelled 1 != 0/],
    ['cand footer removed', 'candidate', c.replace(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) .*\n/gm, ''), '0', /0 lines after the plan/],
    ['cand Windows escape lost (dp0\\node.exe)', 'candidate', c.replace(/^(ok \d+ - T6 \[win32\] dp0)\\\\/m, '$1\\'), '0', /intended test missing: T6 /],
    ['cand unrecognized result line', 'candidate', c.replace(/^ok 5 - /m, 'ok 5 '), '0', /unrecognized result line/],
    ['cand missing TAP header', 'candidate', c.replace(/^TAP version 13\n/, ''), '0', /not "TAP version 13"/],
    ...['3', '137', '', 'abc', '01', ' 0', '0\n', '1'].map(raw => [`cand raw ${JSON.stringify(raw)}`, 'candidate', c, raw, /literal "0"/]),
    ...['0', '3', '137', '01'].map(raw => [`base raw ${JSON.stringify(raw)}`, 'baseline', b, raw, /literal "1"/]),
  ];
  assert.equal(cases.length, 37);
  for (const [id, mode, tap, raw, re] of cases) await t.test(id, () => red(check(mode, tap, raw), re));
});

test('workflow pins this checker and this regression, and runs it before classification', () => {
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  const pin = f => new RegExp(`^ +check harness/tests/dispatch/${f.replace(/\./g, '\\.')} +([0-9a-f]{64})$`, 'm').exec(wf)?.[1];
  assert.equal(pin('win-launch-tap-check.mjs'), sha(fs.readFileSync(CHECKER)));
  assert.equal(pin('win-launch-tap-check.test.mjs'), sha(fs.readFileSync(SELF)));
  const self = wf.indexOf('node --test "$GITHUB_WORKSPACE/harness/tests/dispatch/win-launch-tap-check.test.mjs"');
  assert.ok(self > 0 && self < wf.indexOf('node "$GITHUB_WORKSPACE/harness/tests/dispatch/win-launch-tap-check.mjs"'));
});
