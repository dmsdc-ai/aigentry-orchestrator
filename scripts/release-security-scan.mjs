#!/usr/bin/env node
// Scanner receipt producer for scripts/release-admission.mjs (REQUIREMENTS §2.4, C3). Node stdlib only.
// It stages exactly the files the security scope selects at one commit (committed bytes, at their
// repo-relative paths) into a fresh temporary directory, runs the scanner ONCE there through an
// injectable argv (default `snyk code test --sarif`, no shell), captures stdout exactly, and writes:
//   sarif.json            the scanner's stdout bytes, unmodified (representation "stdout-exact")
//   receipt.json          the gate's receipt record
//   scan-manifest.json    the staged files [[path, bytes, sha256], ...] + commit + scope hash (manifest_sha256)
//   original-receipt.json the full run record (argv, timing, exit, signal, ...) (original_receipt_sha256)
// No retries. A failed, timed-out, signalled, overflowing or unparseable run is recorded in the
// receipt as observed and the command exits 1; nothing is hidden or rewritten. It handles no
// credential: the scanner inherits this process's environment and its existing authentication.
//
// usage: scripts/release-security-scan.mjs --repo <abs> --scope-file <json> --out <abs dir>
//          [--commit <40-hex|HEAD>] [--scanner-argv <JSON array>] [--timeout-ms N] [--max-stdout-bytes N]
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPENDENCY_PATHS, EvidenceError, HEX40, MAX_FILE, byteOrder, diffNames, fail, gitRunner, headFile, inventoryEntries,
  inventoryTriples, need, parseArgs, prepareOut, sarifResults, selectScope, serialize, severityCounts, sha256, splitNul,
  strictJSON, validateReceipt, validateScope,
} from './release-evidence.mjs';

export const DEFAULT_SCANNER_ARGV = ['snyk', 'code', 'test', '--sarif'];
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// Regular committed files only: symlinks, gitlinks and trees cannot be inventoried by the gate.
function stageList(git, commit, selected) {
  const entries = new Map();
  for (const entry of splitNul(git('ls-tree', '-r', '-z', '--full-tree', commit))) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(entry);
    need(match, 'malformed git ls-tree output');
    entries.set(match[4], { mode: match[1], type: match[2] });
  }
  const folded = new Set();
  return selected.map(name => {
    const entry = entries.get(name);
    need(entry, `selected path is absent at ${commit} (deleted under a scope root?): ${name}`);
    need(entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755'), `selected path is not a regular file: ${name}`);
    need(!folded.has(name.toLowerCase()), `selected paths are case-aliased: ${name}`);
    folded.add(name.toLowerCase());
    const bytes = headFile(git, name, commit);
    need(bytes.length <= MAX_FILE, `selected file exceeds 16 MiB: ${name}`);
    return { path: name, bytes };
  });
}

// Runs the scanner exactly once; every outcome is returned, none is thrown.
export function runScanner(argv, cwd, { timeoutMs, maxStdoutBytes }) {
  const started = new Date();
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env: process.env, stdio: ['ignore', 'pipe', 'inherit'],
    timeout: timeoutMs, maxBuffer: maxStdoutBytes, killSignal: 'SIGKILL', windowsHide: true, shell: false });
  const finished = new Date();
  const code = result.error?.code ?? null;
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  return {
    started_at: started.toISOString(), finished_at: finished.toISOString(), duration_ms: finished - started,
    exit: Number.isSafeInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    timed_out: code === 'ETIMEDOUT',
    overflow: code === 'ENOBUFS' || stdout.length > maxStdoutBytes,
    spawn_error: code && code !== 'ETIMEDOUT' && code !== 'ENOBUFS' ? String(code) : null,
    stdout,
  };
}

function scanCommand(argv) {
  const o = parseArgs(argv, ['--repo', '--scope-file', '--out', '--commit', '--scanner-argv', '--timeout-ms', '--max-stdout-bytes']);
  need(o.has('--scope-file') && o.has('--out'), 'missing --scope-file or --out');
  const requested = o.get('--commit') ?? 'HEAD';
  need(requested === 'HEAD' || HEX40.test(requested), '--commit must be HEAD or a 40-hex commit');
  let scannerArgv = DEFAULT_SCANNER_ARGV;
  if (o.has('--scanner-argv')) {
    try { scannerArgv = JSON.parse(o.get('--scanner-argv')); } catch { fail('--scanner-argv must be a JSON array of strings'); }
  }
  need(Array.isArray(scannerArgv) && scannerArgv.length > 0 && scannerArgv.every(arg => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0')),
    '--scanner-argv must be a non-empty JSON array of non-empty strings');
  // Without a shell, Windows cannot launch .cmd/.bat shims (npm's snyk.cmd); name the scanner executable itself.
  need(process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(scannerArgv[0]),
    'on Windows pass the scanner executable (e.g. snyk-win.exe), not a .cmd/.bat shim; no shell is used');
  const timeoutMs = Number(o.get('--timeout-ms') ?? DEFAULT_TIMEOUT_MS);
  const maxStdoutBytes = Number(o.get('--max-stdout-bytes') ?? MAX_FILE);
  need(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, '--timeout-ms must be a positive integer');
  need(Number.isSafeInteger(maxStdoutBytes) && maxStdoutBytes > 0 && maxStdoutBytes <= MAX_FILE, '--max-stdout-bytes must be 1..16 MiB');

  const git = gitRunner(o.get('--repo'));
  const commit = git('rev-parse', '--verify', `${requested}^{commit}`).toString().trim();
  need(HEX40.test(commit), 'could not resolve --commit');
  const scopeBytes = readFileSync(o.get('--scope-file'));
  const scope = strictJSON(scopeBytes);
  validateScope(scope);
  git('merge-base', '--is-ancestor', scope.base_commit, commit);
  // Planning evidence is unknown before the manifest; policy re-checks the selection against it.
  const selected = selectScope(scope, diffNames(git, scope.base_commit, commit), new Set());
  for (const name of DEPENDENCY_PATHS) need(selected.includes(name), `scope must select ${name} (list it as a leaf)`);
  const staged = stageList(git, commit, selected);
  const inventory = inventoryEntries(staged);
  const sources = new Set(inventory.filter(file => file.kind === 'source').map(file => file.path));
  need(sources.size > 0, 'scope selects no source file; the gate needs at least one projected source');
  const scanManifestBytes = serialize({ schema_version: 1, commit, scope_sha256: sha256(scopeBytes), files: inventoryTriples(inventory) });
  const out = prepareOut(o.get('--out'));
  writeFileSync(out('scan-manifest.json'), scanManifestBytes);

  const staging = mkdtempSync(path.join(tmpdir(), 'release-security-scan-'));
  let run;
  try {
    for (const file of staged) {
      const target = path.join(staging, ...file.path.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.bytes, { flag: 'wx' });
    }
    console.log(`staged ${staged.length} file(s) from ${commit}; running scanner once`);
    run = runScanner(scannerArgv, staging, { timeoutMs, maxStdoutBytes });
  } finally {
    try { rmSync(staging, { recursive: true, force: true }); }
    catch { console.error('warning: could not remove the temporary staging directory'); }
  }

  let results = [];
  let sarifError = null;
  try {
    results = sarifResults(strictJSON(run.stdout), sources);
  } catch (error) {
    results = [];
    sarifError = error instanceof EvidenceError ? error.message : 'SARIF is not valid UTF-8 JSON';
  }
  const sarifValid = sarifError === null && !run.timed_out && !run.overflow;
  const severities = severityCounts(results);
  const stdoutSha = sha256(run.stdout);
  const original = { schema_version: 1, producer: 'scripts/release-security-scan.mjs', commit,
    scope_sha256: sha256(scopeBytes), scan_manifest_sha256: sha256(scanManifestBytes), staged_files: staged.length,
    scanner_argv: scannerArgv, cwd: '<temporary staging directory>', timeout_ms: timeoutMs, max_stdout_bytes: maxStdoutBytes,
    started_at: run.started_at, finished_at: run.finished_at, duration_ms: run.duration_ms,
    exit: run.exit, signal: run.signal, timed_out: run.timed_out, overflow: run.overflow, spawn_error: run.spawn_error,
    stdout_bytes: run.stdout.length, stdout_sha256: stdoutSha, sarif_valid: sarifValid, sarif_error: sarifError,
    findings: results.length, severities, node: process.version, platform: process.platform };
  const originalBytes = serialize(original);
  const receipt = { schema_version: 1, sarif_sha256: stdoutSha, original_receipt_sha256: sha256(originalBytes),
    stdout_sha256: stdoutSha, manifest_sha256: sha256(scanManifestBytes), exit: run.exit, findings: results.length,
    severities, timed_out: run.timed_out, overflow: run.overflow, signal: run.signal, sarif_valid: sarifValid,
    representation: 'stdout-exact' };
  writeFileSync(out('sarif.json'), run.stdout);
  writeFileSync(out('original-receipt.json'), originalBytes);
  writeFileSync(out('receipt.json'), serialize(receipt));
  console.log(`scanner exit=${run.exit} signal=${run.signal} timed_out=${run.timed_out} overflow=${run.overflow} ` +
    `spawn_error=${run.spawn_error} sarif_valid=${sarifValid} findings=${results.length} ${JSON.stringify(severities)}`);
  if (sarifError) console.error(`SARIF refused: ${sarifError}`);
  try { validateReceipt(receipt, run.stdout); }
  catch (error) {
    fail(`scanner run recorded but NOT admissible (${error.message}); the receipt is kept as evidence of the failure. ` +
      'Do not edit it: fix the cause and run this step again with an empty --out.');
  }
  for (const result of [...results].sort((a, b) => byteOrder(a.fingerprint, b.fingerprint))) {
    console.log(`needs: adjudication for ${result.fingerprint} (${result.rule} at ${result.path}:${result.region.startLine}:${result.region.startColumn}, level=${result.level ?? 'none'})`);
  }
  console.log('next: blobs (--sarif-file sarif.json --receipt-file receipt.json); keep original-receipt.json and scan-manifest.json for policy and provenance');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { scanCommand(process.argv.slice(2)); }
  catch (error) {
    console.error(`release-security-scan refused: ${error instanceof EvidenceError ? error.message : 'unexpected input or I/O failure'}`);
    process.exitCode = 1;
  }
}
