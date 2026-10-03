#!/usr/bin/env node
// diagnose-locale-paths.mjs — #909 native N1/N3 observation. It records; it does not judge.
//
// N1: which arm of the product sid pre-filter pattern *[[:space:][:cntrl:]]* (located in
// the pinned fixture text, never sourced) /bin/bash takes for fixed sid byte strings, under
// the inherited locale and under LC_ALL=C.
// N3: whether /bin/test -f / -x accept job-owned symlink chains of 32/33/40/41 hops, built
// with the same orientation and count as native-session-pid.mjs, and the real regular
// executable they end at, checked directly. The target is never executed.
//
// Not a replacement for the retained red oracles (U03, U04, L02); no predicted
// classification is encoded. It runs only on a disposable GitHub-hosted runner from
// .github/workflows/native-909-nt909sw.yml on the reserved branch, with an explicit
// opt-in. Any other invocation refuses before creating a child or a file. No process
// query, no network, no product sourcing or execution. Node 20 stdlib only.
//
// Exit 0 = every row recorded intact; 2 = missing/corrupt result, timeout, abnormal child or
// run budget hit (the rows collected so far are still written); 3 = refused. An observed
// classification never changes the exit.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const BRANCH = 'test/909-native-nt909sw-20261003';
const WORKFLOW_FILE = '.github/workflows/native-909-nt909sw.yml';
const OPT_IN = '--disposable-github-hosted-vm-diagnostic-only';
const LANES = {
  darwin: { runnerOs: 'macOS', imageOs: 'macos14' },
  linux: { runnerOs: 'Linux', imageOs: 'ubuntu22' },
};
const BASH = '/bin/bash';
const TEST = '/bin/test';
const SYS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const CHILD_TIMEOUT_MS = 5000;
const RUN_BUDGET_MS = 90000;
const CHAIN_HOPS = [32, 33, 40, 41];
const EXIT = { ok: 0, incomplete: 2, refused: 3 };

// Sources hashed from the actual checkout. A non-null pin that does not match is a corrupt
// result: the observations would then describe some other harness or product text.
const SOURCES = [
  ['tests/native909/diagnose-locale-paths.mjs', null],
  ['tests/native909/native-session-pid.mjs', 'ff2f047341243c0133affe39071620dd77b0e3006ece2bf3f424a67906ee196c'],
  ['tests/native909/fake-telepty.cjs', '684a7544ad1a340e205896c5440201aa6feb2588a503fe07ad2de2b8bbfcf6a2'],
  ['tests/native909/fixtures/candidate/platform.sh', 'd37b262cb16b12cc02b5ccb4ed54582699c1845aba6fdcb9e6e864ffe25ff6f2'],
  ['tests/native909/fixtures/candidate/platform-unix.sh', 'b74f8b058af5a844f85f34f3c3caf82f7e5968121a9bad64d5c9586eb0c5d59b'],
  ['tests/native909/fixtures/prior/platform.sh', 'd37b262cb16b12cc02b5ccb4ed54582699c1845aba6fdcb9e6e864ffe25ff6f2'],
  ['tests/native909/fixtures/prior/platform-unix.sh', 'd8194b7e85c487b66ae36e565fc0485757238b24d400767d508f93e82eecbc40'],
  [WORKFLOW_FILE, null],
];
const PRODUCT_FILE = 'tests/native909/fixtures/candidate/platform-unix.sh';

// The product sid pre-filter, verbatim, and the fixed N1 script that carries the same
// pattern. The sid arrives as $1; nothing is interpolated into this text. It prints the
// arm taken, then the bytes bash received, for a round-trip check.
const PATTERN = '*[[:space:][:cntrl:]]*';
const PRODUCT_CASE = 'case "$sid" in';
const PRODUCT_ARM = `${PATTERN}) echo "session_pid: UNKNOWN sid=$safe cause=sid" >&2; return 2 ;;`;
const N1_SCRIPT = String.raw`case "$1" in *[[:space:][:cntrl:]]*) r=matched ;; *) r=unmatched ;; esac; printf '%s\n%s' "$r" "$1"`;
const N1_ARMS = ['matched', 'unmatched'];

// Fixed sid strings; their UTF-8 bytes are what reaches argv (recorded as hex per row).
const S = (x) => `nt909fx-${x}`;
const N1_SIDS = [
  ['plain', S('exact')],
  ['ascii-space', S('sp a')],
  ['ascii-tab', S('a\tb')],
  ['ascii-ctrl-soh', S('a\x01b')],
  ['ascii-del', S('a\x7fb')],
  ['non-ascii-letter', S('caf\xe9')],
  ['nbsp', S('a\xa0b')],
  ['c1-csi', S('a\u009bb')],
  ['rlo', S('a\u{202E}b')],
];

// Never executed; only checked through the chains and directly.
const TARGET_BYTES = '#!/bin/sh\nexit 0\n';

// ---------------------------------------------------------------------------
// args + guard (nothing is created before this passes)
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const outArg = () => {
  const hit = argv.find((a) => a.startsWith('--out='));
  return hit === undefined ? undefined : hit.slice('--out='.length);
};

function guardFailures(out) {
  const e = process.env;
  const lane = LANES[process.platform];
  const bad = [];
  if (!argv.includes(OPT_IN)) bad.push(`missing ${OPT_IN}`);
  for (const a of argv) if (a !== OPT_IN && !a.startsWith('--out=')) bad.push(`unknown argument ${JSON.stringify(a).slice(0, 80)}`);
  if (argv.filter((a) => a.startsWith('--out=')).length !== 1) bad.push('exactly one --out= is required');
  if (!lane) bad.push(`platform ${process.platform} is not darwin|linux`);
  if (e.GITHUB_ACTIONS !== 'true' || e.CI !== 'true') bad.push('not GitHub Actions');
  if (e.RUNNER_ENVIRONMENT !== 'github-hosted') bad.push('RUNNER_ENVIRONMENT != github-hosted');
  if (lane && e.RUNNER_OS !== lane.runnerOs) bad.push(`RUNNER_OS != ${lane.runnerOs}`);
  if (lane && e.ImageOS !== lane.imageOs) bad.push(`ImageOS != ${lane.imageOs}`);
  if (e.GITHUB_EVENT_NAME !== 'push') bad.push('GITHUB_EVENT_NAME != push');
  if (e.GITHUB_REF !== `refs/heads/${BRANCH}`) bad.push(`GITHUB_REF != refs/heads/${BRANCH}`);
  if (!(e.GITHUB_WORKFLOW_REF || '').endsWith(`/${WORKFLOW_FILE}@refs/heads/${BRANCH}`)) bad.push('GITHUB_WORKFLOW_REF is not this workflow on the reserved branch');
  const temp = e.RUNNER_TEMP;
  if (!temp || !path.isAbsolute(temp) || !fs.existsSync(temp)) bad.push('RUNNER_TEMP missing');
  else {
    // Only a new dir under RUNNER_TEMP/nt909/: the existing upload path, nothing else.
    const base = path.join(temp, 'nt909') + path.sep;
    if (!out || !path.isAbsolute(out) || path.resolve(out) !== out || !out.startsWith(base) || out.length === base.length) bad.push(`--out must be a normalized absolute path under ${base}`);
    else if (fs.existsSync(out)) bad.push('--out already exists');
  }
  if (typeof process.getuid !== 'function' || process.getuid() === 0) bad.push('uid 0 or unknown');
  if (path.basename(process.execPath) !== 'node') bad.push('node execPath basename is not node');
  return bad;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const T0 = Date.now();
const hex = (b) => Buffer.from(b).toString('hex');
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const problems = [];

// One bounded child, argv as an array, fixed env, stdin closed. Nothing starts past the
// run budget: a skipped child is a missing result.
function child(tag, file, args, env, cwd) {
  const rec = { tag, file, argv: args, argv_hex: args.map((a) => hex(a)), env, cwd };
  if (Date.now() - T0 > RUN_BUDGET_MS) return { ...rec, skipped: `run budget ${RUN_BUDGET_MS}ms exceeded` };
  const s = process.hrtime.bigint();
  const r = spawnSync(file, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1 << 20 });
  const out = r.stdout || Buffer.alloc(0);
  const err = r.stderr || Buffer.alloc(0);
  return {
    ...rec, status: r.status, signal: r.signal, error: r.error ? r.error.code || String(r.error.message).slice(0, 200) : null,
    timed_out: !!(r.error && r.error.code === 'ETIMEDOUT'),
    stdout_hex: hex(out), stdout: out.toString('utf8'), stderr_hex: hex(err), stderr: err.toString('utf8'),
    elapsed_ms: Number((process.hrtime.bigint() - s) / 1000000n),
  };
}

// A child that did not finish on its own with an allowed status is abnormal (exit 2).
function abnormal(r, statuses) {
  if (r.skipped) return r.skipped;
  if (r.timed_out) return 'timeout';
  if (r.error) return `spawn error ${r.error}`;
  if (r.signal) return `signal ${r.signal}`;
  if (statuses && !statuses.includes(r.status)) return `status ${r.status}`;
  return null;
}

const inheritedLocale = () => {
  const o = {};
  for (const k of ['LANG', 'LC_ALL', 'LC_CTYPE']) if (process.env[k] !== undefined) o[k] = process.env[k];
  return o;
};

function hashSources() {
  return SOURCES.map(([rel, want]) => {
    let got = 'missing';
    let bytes = -1;
    try { bytes = fs.statSync(path.join(ROOT, rel)).size; got = sha256(path.join(ROOT, rel)); } catch {}
    const ok = got !== 'missing' && (want === null || got === want);
    if (!ok) problems.push(`source ${rel} ${got === 'missing' ? 'missing' : 'hash differs from pin'}`);
    return { rel, bytes, sha256: got, want, ok };
  });
}

// Locate the exact pre-filter in the pinned product text (read, never sourced).
function locatePattern() {
  const res = { file: PRODUCT_FILE, pattern: PATTERN, arm: PRODUCT_ARM, lines: [], script_carries_pattern: N1_SCRIPT.includes(`case "$1" in ${PATTERN})`) };
  try {
    const lines = fs.readFileSync(path.join(ROOT, PRODUCT_FILE), 'utf8').split('\n');
    lines.forEach((l, i) => { if (l.trim() === PRODUCT_ARM && i > 0 && lines[i - 1].trim() === PRODUCT_CASE) res.lines.push(i + 1); });
  } catch (e) { res.error = e.code || 'read-error'; }
  if (res.lines.length !== 1 || !res.script_carries_pattern) problems.push(`product sid pattern not located exactly once in ${PRODUCT_FILE}`);
  return res;
}

function environment(cwd) {
  const env = { PATH: SYS_PATH };
  const pick = {};
  for (const k of ['GITHUB_REPOSITORY', 'GITHUB_REF', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW_REF', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT', 'ImageOS', 'ImageVersion']) pick[k] = process.env[k];
  const info = { platform: process.platform, arch: process.arch, node: process.version, ci: pick, inherited_locale: inheritedLocale() };
  for (const f of [BASH, TEST]) {
    try { info[`${path.basename(f)}_file`] = { path: f, realpath: fs.realpathSync(f), is_file: fs.statSync(f).isFile() }; } catch (e) { info[`${path.basename(f)}_file`] = { path: f, error: e.code }; problems.push(`${f} missing`); }
  }
  info.uname = child('env.uname', '/usr/bin/uname', ['-srm'], env, cwd);
  info.bash_version = child('env.bash', BASH, ['--version'], env, cwd);
  for (const r of [info.uname, info.bash_version]) { const a = abnormal(r, [0]); if (a) problems.push(`${r.tag} ${a}`); }
  return info;
}

// ---------------------------------------------------------------------------
// N1: sid byte classification by the exact pattern, inherited locale vs C
// ---------------------------------------------------------------------------

function runN1(cwd) {
  const arms = { inherit: inheritedLocale(), C: { ...inheritedLocale(), LC_ALL: 'C' } };
  const res = {
    note: 'observed = the case arm /bin/bash took for the bytes it received. That a "matched" sid would take the product cause=sid early return is read from the source line, not measured here.',
    script: N1_SCRIPT, charmap: {}, rows: [],
  };
  for (const [arm, loc] of Object.entries(arms)) {
    const env = { PATH: SYS_PATH, ...loc };
    const cm = child(`N1.${arm}.charmap`, '/usr/bin/locale', ['charmap'], env, cwd);
    res.charmap[arm] = cm;
    const a = abnormal(cm);
    if (a) problems.push(`${cm.tag} ${a}`);
    for (const [label, sid] of N1_SIDS) {
      const r = child(`N1.${arm}.${label}`, BASH, ['-c', N1_SCRIPT, 'nd909-n1', sid], env, cwd);
      const row = { probe: 'N1', arm, locale_env: loc, label, sid_hex: hex(sid), observed: null, received_hex: null, received_exact: null, child: r };
      const bad = abnormal(r, [0]);
      if (bad) problems.push(`${r.tag} ${bad}`);
      else {
        const out = Buffer.from(r.stdout_hex, 'hex');
        const nl = out.indexOf(0x0a);
        const got = nl < 0 ? '' : out.subarray(0, nl).toString('latin1');
        // The bytes bash re-emitted are an observation too (what case "$sid" would see);
        // only an unparseable arm line is a corrupt result.
        if (N1_ARMS.includes(got)) {
          row.observed = got;
          row.received_hex = hex(out.subarray(nl + 1));
          row.received_exact = row.received_hex === row.sid_hex;
        }
        else problems.push(`${r.tag} corrupt output`);
      }
      res.rows.push(row);
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// N3: owned symlink chains vs /bin/test -f / -x
// ---------------------------------------------------------------------------

// Same orientation and count as native-session-pid.mjs buildWorld(): chain<n>/l0 -> l1 ->
// ... -> l<n-1> -> ../pkg/cli.js, n symlinks. The walk uses lstat/readlink only, is bounded
// to n steps and must stay inside the owned root.
function buildChain(root, canon, n, created) {
  const d = path.join(root, `chain${n}`);
  fs.mkdirSync(d);
  created.push(d);
  for (let i = 0; i < n; i++) {
    const link = path.join(d, `l${i}`);
    fs.symlinkSync(i === n - 1 ? '../pkg/cli.js' : `l${i + 1}`, link);
    created.push(link);
  }
  const trace = [];
  let cur = path.join(d, 'l0');
  while (fs.lstatSync(cur).isSymbolicLink()) {
    if (trace.length >= n) throw new Error(`chain${n} walk exceeded ${n} hops`);
    const t = fs.readlinkSync(cur);
    trace.push([path.relative(root, cur), t]);
    cur = path.resolve(path.dirname(cur), t);
    if (!cur.startsWith(root + path.sep)) throw new Error(`chain${n} walk left the owned root`);
  }
  if (trace.length !== n || cur !== canon) throw new Error(`chain${n} built wrong (${trace.length})`);
  return { l0: path.join(d, 'l0'), trace };
}

// Optional errno evidence from a standard read-only API (libuv stat). It is a separate
// observation of the same path, not proof of what /bin/test or the product saw.
function nodeStat(p) {
  try {
    const st = fs.statSync(p);
    return { ok: true, is_file: st.isFile(), mode: (st.mode & 0o7777).toString(8) };
  } catch (e) {
    return { ok: false, code: e.code || null, errno: e.errno ?? null, syscall: e.syscall || null };
  }
}

function probePath(root, subject, p, hops) {
  const rows = [];
  for (const flag of ['-f', '-x']) {
    const r = child(`N3.${subject}.test${flag}`, TEST, [flag, p], { PATH: SYS_PATH }, root);
    const bad = abnormal(r, [0, 1]);
    if (bad) problems.push(`${r.tag} ${bad}`);
    rows.push({ probe: 'N3', subject, hops, path_rel: path.relative(root, p), check: `test ${flag}`, observed: bad ? null : r.status, child: r });
  }
  rows.push({ probe: 'N3', subject, hops, path_rel: path.relative(root, p), check: 'node fs.statSync', observed: nodeStat(p) });
  return rows;
}

function runN3(root, created) {
  const res = {
    note: 'observed = /bin/test exit (0 true, 1 false) on the owned l0 and on the final real regular executable. A chain exit 1 with the target at 0 is a measured executable-check failure on the chain path; errno is not claimed from it. node fs.statSync code is separate optional evidence.',
    chains: [], rows: [],
  };
  const canon = path.join(root, 'pkg/cli.js');
  fs.mkdirSync(path.dirname(canon));
  created.push(path.dirname(canon));
  fs.writeFileSync(canon, TARGET_BYTES, { mode: 0o755 });
  created.push(canon);
  fs.chmodSync(canon, 0o755);
  res.rows.push(...probePath(root, 'canonical', canon, 0));
  for (const n of CHAIN_HOPS) {
    let built;
    try { built = buildChain(root, canon, n, created); } catch (e) {
      problems.push(`N3 chain${n}: ${e.message}`);
      res.chains.push({ hops: n, error: e.message });
      continue;
    }
    res.chains.push({ hops: n, l0: path.relative(root, built.l0), trace: built.trace });
    res.rows.push(...probePath(root, `chain${n}`, built.l0, n));
  }
  return res;
}

// Remove exactly the paths this run created, newest first; nothing recursive, nothing else.
function cleanupOwned(created) {
  const left = [];
  for (const p of [...created].reverse()) {
    try { if (fs.lstatSync(p).isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p); } catch (e) { left.push({ path: p, code: e.code || 'error' }); }
  }
  if (left.length) problems.push(`owned paths not removed: ${left.length}`);
  return { removed: created.length - left.length, left };
}

function writeResults(out, doc) {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(doc, null, 2) + '\n');
  const cols = ['probe', 'arm_or_subject', 'label_or_check', 'observed', 'sid_hex_or_path', 'received_exact', 'status', 'signal', 'stderr', 'elapsed_ms'];
  const lines = [cols.join('\t')];
  for (const r of (doc.n1 && doc.n1.rows) || []) lines.push([r.probe, r.arm, r.label, r.observed, r.sid_hex, r.received_exact, r.child.status, r.child.signal, r.child.stderr, r.child.elapsed_ms].map((x) => JSON.stringify(x ?? '')).join('\t'));
  for (const r of (doc.n3 && doc.n3.rows) || []) lines.push([r.probe, r.subject, r.check, r.observed, r.path_rel, '', r.child && r.child.status, r.child && r.child.signal, r.child && r.child.stderr, r.child && r.child.elapsed_ms].map((x) => JSON.stringify(x ?? '')).join('\t'));
  for (const p of doc.problems) lines.push(['PROBLEM', '', '', '', '', '', '', '', p, ''].map((x) => JSON.stringify(x)).join('\t'));
  fs.writeFileSync(path.join(out, 'results.tsv'), lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const out = outArg();
  const refused = guardFailures(out);
  if (refused.length) {
    console.log(`REFUSED (no child or file was created):\n  - ${refused.join('\n  - ')}`);
    return EXIT.refused;
  }
  fs.mkdirSync(out, { recursive: true });
  const doc = {
    task: 909, track: 'nd909ux', kind: 'diagnostic-observation', branch: BRANCH, started: new Date().toISOString(),
    not_a_replacement_for: 'retained red oracles U03/U04/L02 in native-session-pid.mjs', problems,
  };
  const created = [];
  try {
    doc.sources = hashSources();
    doc.product_pattern = locatePattern();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'nd909diag-')));
    created.push(root);
    doc.owned_root = root;
    doc.environment = environment(root);
    doc.n1 = runN1(root);
    doc.n3 = runN3(root, created);
  } catch (e) {
    problems.push(`error: ${String(e && e.message).slice(0, 300)}`);
  } finally {
    doc.cleanup = cleanupOwned(created);
  }
  doc.exit = problems.length ? EXIT.incomplete : EXIT.ok;
  doc.finished = new Date().toISOString();
  try { writeResults(out, doc); } catch (e) {
    console.log(`INCOMPLETE: results NOT written (${String(e && e.message).slice(0, 200)})`);
    return EXIT.incomplete;
  }
  for (const r of (doc.n1 && doc.n1.rows) || []) console.log(`N1 ${r.arm.padEnd(7)} ${r.label.padEnd(17)} observed=${r.observed} received_exact=${r.received_exact} sid_hex=${r.sid_hex} stderr=${JSON.stringify(r.child.stderr)}`);
  for (const r of (doc.n3 && doc.n3.rows) || []) console.log(`N3 ${r.subject.padEnd(9)} ${r.check.padEnd(16)} observed=${JSON.stringify(r.observed)}${r.child && r.child.stderr ? ` stderr=${JSON.stringify(r.child.stderr)}` : ''}`);
  console.log(`DIAGNOSTIC os=${process.platform} rows=${((doc.n1 && doc.n1.rows) || []).length + ((doc.n3 && doc.n3.rows) || []).length} problems=${problems.length}${problems.length ? ` (${problems.join('; ')})` : ''} exit=${doc.exit}`);
  return doc.exit;
}

process.exit(main());
