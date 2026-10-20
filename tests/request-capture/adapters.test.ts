import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// #1166 U2 — independent contract tests for the shipped submission-adapter declaration table.
// The computed URL lets this file compile before the product exists; a missing module is
// reported as FEATURE_ABSENT, never as a skip and never as a product mock.
//
// What this suite is allowed to prove: that the declaration matches the source it cites.
// What it must never be read as proving: that any adapter is installed, registered or active.
// No hook is registered, no settings file is written, no provider is probed, no capture runs.
const adaptersUrl = new URL('../../src/request-capture/adapters.js', import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const STATUSES = ['supported', 'unsupported', 'unobservable'];
const QUALIFIERS = ['opt-in', 'posix-only', 'lifecycle-observation-only', 'not-prompt-capture',
  'mechanism-present-not-registered', 'no-hook-surface-in-source', 'deferred-to-unit-u6'];
const NOT_EVIDENCED = 'not-evidenced-here';
const EVIDENCE = /^([A-Za-z0-9_./-]+):([1-9][0-9]{0,6})$/;

type Adapter = Record<string, unknown> & {
  adapter_id: string; cli: string; lane: string; capture_status: string;
  qualifiers: string[]; mechanism: string | null; caller_evidence: string[];
  channel: string | null; upstream_id_status: string; upstream_delivery_id: null;
  installation: string; activation: string; owning_task: string;
};
type Module = Record<string, unknown> & {
  SUBMISSION_ADAPTERS?: Adapter[];
  ADAPTER_DECLARATION_BASIS?: string;
  findSubmissionAdapter?: (id: string) => Adapter | null;
  supportedCaptureChannels?: () => string[];
};

async function product(): Promise<Module> {
  try {
    return await import(adaptersUrl.href) as Module;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      assert.fail('FEATURE_ABSENT: dist/src/request-capture/adapters.js is not built (no candidate staged)');
    }
    throw error;
  }
}

async function table(): Promise<Adapter[]> {
  const loaded = await product();
  assert.ok(Array.isArray(loaded.SUBMISSION_ADAPTERS), 'SUBMISSION_ADAPTERS export');
  return loaded.SUBMISSION_ADAPTERS!;
}

/** The cited line, 1-based, exactly as a reviewer would open it. */
async function citedLine(citation: string): Promise<string> {
  const match = EVIDENCE.exec(citation);
  assert.ok(match, `citation is not <file>:<line>: ${citation}`);
  const [, rel, lineNumber] = match!;
  assert.equal(path.isAbsolute(rel!), false, `citation must be repo-relative: ${citation}`);
  assert.equal(rel!.split('/').includes('..'), false, `citation must not traverse: ${citation}`);
  const text = await fs.readFile(path.join(repoRoot, rel!), 'utf8');
  const lines = text.split('\n');
  const index = Number(lineNumber) - 1;
  assert.ok(index < lines.length, `${citation} is past the end of the file (${lines.length} lines)`);
  return lines[index]!;
}

test('declaration module exports the reviewed table and lookups', async () => {
  const loaded = await product();
  const rows = await table();
  assert.ok(rows.length > 0, 'the table is not empty');
  assert.equal(typeof loaded.findSubmissionAdapter, 'function');
  assert.equal(typeof loaded.supportedCaptureChannels, 'function');
  // The basis is part of the shipped data: a consumer must not have to infer it.
  assert.equal(typeof loaded.ADAPTER_DECLARATION_BASIS, 'string');
  assert.match(loaded.ADAPTER_DECLARATION_BASIS!, /declaration/);
  assert.match(loaded.ADAPTER_DECLARATION_BASIS!, /not.*(installed|activated)/);
  assert.equal(new Set(rows.map(row => row.adapter_id)).size, rows.length, 'adapter ids are distinct');
  for (const row of rows) assert.deepEqual(loaded.findSubmissionAdapter!(row.adapter_id), row);
  assert.equal(loaded.findSubmissionAdapter!('no-such-adapter'), null);
});

// A1 — importing the declaration must not touch the filesystem, spawn anything, read the
// environment or probe a provider. Measured in an isolated child, not asserted by inspection.
test('A1: importing the declaration is inert — no fs, child_process, net or env read', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'adapters-inert-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const probe = path.join(dir, 'probe.cjs');
  // The target is baked in, so this child takes no argv and reads no env: it is a fixed,
  // test-owned measurement, not a general-purpose diagnostic helper.
  await fs.writeFile(probe, `const TARGET = ${JSON.stringify(adaptersUrl.href)};\n` + String.raw`
const Module = require('node:module');
const touched = [];
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/^(node:)?(fs|child_process|net|tls|http|https|dgram|cluster|worker_threads|dns|os|crypto)(\/|$)/.test(request)) {
    touched.push('require:' + request);
  }
  return realLoad.call(this, request, parent, isMain);
};
const envRead = [];
process.env = new Proxy(process.env, { get(target, key) { envRead.push(String(key)); return target[key]; } });
void (async () => {
  await import(TARGET);
  if (process.send) process.send({ touched, envRead });
})();
`);
  const child = fork(probe, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const message = await new Promise<{ touched: string[]; envRead: string[] }>((resolve, reject) => {
    child.once('message', value => resolve(value as { touched: string[]; envRead: string[] }));
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`probe exited ${code}/${signal}`)));
  });
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  assert.deepEqual(message.touched, [], 'declaration module pulled in an I/O capability');
  // Node's own ESM loader reads these two around any dynamic import; they are the runtime's, not
  // the module's. Any other key would have to come from the declaration itself.
  const LOADER_INTERNAL = ['WATCH_REPORT_DEPENDENCIES', 'NODE_V8_COVERAGE'];
  assert.deepEqual(message.envRead.filter(key => !LOADER_INTERNAL.includes(key)), [],
    `declaration module read the environment: ${JSON.stringify(message.envRead)}`);
});

// A2 — the anti-rot oracle. Every citation must still resolve to a line that contains the
// claimed token, so a declaration cannot silently outlive the source it describes.
test('A2: every cited caller line exists and still contains the claimed token', async () => {
  const rows = await table();
  for (const row of rows) {
    assert.ok(Array.isArray(row.caller_evidence), `${row.adapter_id}: caller_evidence array`);
    assert.ok(row.caller_evidence.length > 0, `${row.adapter_id}: at least one citation`);
    for (const entry of row.caller_evidence) {
      assert.equal(typeof entry, 'string');
      const [citation, ...rest] = entry.split('#');
      const token = rest.join('#');
      assert.notEqual(token, '', `${row.adapter_id}: citation needs a '#<token>' claim: ${entry}`);
      const line = await citedLine(citation!);
      assert.ok(line.includes(token), `${row.adapter_id}: ${citation} no longer contains ${JSON.stringify(token)}; got ${JSON.stringify(line.trim())}`);
    }
  }
});

// A3 — a row may only be `supported` if its own evidence chain reaches the capture writer.
test('A3: only an adapter whose evidence reaches captureSubmittedPrompt is supported', async () => {
  const rows = await table();
  const supported = rows.filter(row => row.capture_status === 'supported');
  assert.deepEqual(supported.map(row => row.adapter_id), ['codex-native'],
    'exactly one adapter is declared supported in this source');
  for (const row of supported) {
    const chain = row.caller_evidence.map(entry => entry.split('#')[0]!.split(':')[0]!);
    assert.ok(chain.includes('src/request-capture/receipt.ts'),
      `${row.adapter_id} claims supported capture without citing the capture writer`);
    assert.ok(chain.includes('src/request-capture/cli.ts'),
      `${row.adapter_id} claims supported capture without citing the hook entry point`);
  }
  const confined = rows.find(row => row.adapter_id === 'claude-confined-worker');
  assert.ok(confined, 'the confined worker lane is declared');
  // Lifecycle observation is NOT prompt capture: it is a qualifier on an unsupported row.
  assert.equal(confined!.capture_status, 'unsupported');
  assert.ok(confined!.qualifiers.includes('lifecycle-observation-only'));
  assert.ok(confined!.qualifiers.includes('not-prompt-capture'));
  assert.equal(confined!.channel, null, 'a non-capturing lane owns no capture channel');
});

// A4 — a declaration is never evidence of installation or activation.
test('A4: no row claims installation or activation, and no probe is exported', async () => {
  const loaded = await product();
  const rows = await table();
  for (const row of rows) {
    assert.equal(row.installation, NOT_EVIDENCED, `${row.adapter_id} installation`);
    assert.equal(row.activation, NOT_EVIDENCED, `${row.adapter_id} activation`);
    const text = JSON.stringify(row);
    assert.doesNotMatch(text, /"(installed|activated|enabled|registered|active)":\s*true/,
      `${row.adapter_id} asserts an installed/active state`);
  }
  for (const name of Object.keys(loaded)) {
    assert.doesNotMatch(name, /^(is|probe|detect|check)?(Installed|Activated|Install|Activate|Register)/i,
      `export ${name} would turn a declaration into an installation claim`);
  }
});

// A5 — no provider delivery identity has been measured on any lane, so none may be declared.
test('A5: every row declares an unavailable upstream delivery identity', async () => {
  for (const row of await table()) {
    assert.equal(row.upstream_id_status, 'unavailable', `${row.adapter_id} upstream_id_status`);
    assert.equal(row.upstream_delivery_id, null, `${row.adapter_id} upstream_delivery_id`);
  }
});

// A6 — the only supported channel is the one the receipt actually writes.
test('A6: supportedCaptureChannels matches the receipt channel literal', async () => {
  const loaded = await product();
  const rows = await table();
  assert.deepEqual(loaded.supportedCaptureChannels!(), ['codex-native']);
  const receipt = await fs.readFile(path.join(repoRoot, 'src/request-capture/receipt.ts'), 'utf8');
  assert.ok(receipt.includes('channel: "codex-native"'), 'receipt writer still uses this channel');
  const declared = rows.filter(row => row.capture_status === 'supported').map(row => row.channel);
  assert.deepEqual(declared, ['codex-native']);
  // A returned array must not be a live handle on the table.
  const first = loaded.supportedCaptureChannels!();
  first.push('telepty');
  assert.deepEqual(loaded.supportedCaptureChannels!(), ['codex-native'], 'the declaration is not mutable through the accessor');
});

test('shape: every row carries the full declaration contract and nothing else', async () => {
  const rows = await table();
  const keys = ['activation', 'adapter_id', 'caller_evidence', 'capture_status', 'channel', 'cli',
    'installation', 'lane', 'mechanism', 'owning_task', 'qualifiers', 'upstream_delivery_id',
    'upstream_id_status'];
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), keys, `${row.adapter_id} keys`);
    assert.match(row.adapter_id, /^[a-z][a-z0-9-]{0,63}$/);
    assert.match(row.cli, /^[a-z][a-z0-9-]{0,31}$/);
    assert.match(row.lane, /^[a-z][a-z0-9-]{0,63}$/);
    assert.ok(STATUSES.includes(row.capture_status), `${row.adapter_id} status enum`);
    assert.ok(Array.isArray(row.qualifiers), `${row.adapter_id} qualifiers array`);
    for (const qualifier of row.qualifiers) {
      assert.ok(QUALIFIERS.includes(qualifier), `${row.adapter_id} unknown qualifier ${qualifier}`);
    }
    assert.equal(new Set(row.qualifiers).size, row.qualifiers.length, `${row.adapter_id} distinct qualifiers`);
    assert.ok(row.mechanism === null || typeof row.mechanism === 'string', `${row.adapter_id} mechanism`);
    assert.equal(row.capture_status === 'unobservable', row.mechanism === null,
      `${row.adapter_id}: an unobservable lane has no mechanism, and a mechanism means it is observable`);
    assert.match(row.owning_task, /^#[0-9]{1,7}(, #[0-9]{1,7})*$/, `${row.adapter_id} owning_task`);
  }
  // The six measured lanes of U2-ORIGINAL-SPEC §4.1, no more and no fewer.
  assert.deepEqual(rows.map(row => row.adapter_id).sort(), ['claude-confined-worker',
    'claude-orchestrator', 'codex-native', 'gemini', 'grok', 'telepty-peer-to-orchestrator']);
});

test('unobservable lanes declare the absent hook surface rather than claiming coverage', async () => {
  const rows = await table();
  for (const id of ['gemini', 'grok']) {
    const row = rows.find(entry => entry.adapter_id === id);
    assert.ok(row, `${id} is declared`);
    assert.equal(row!.capture_status, 'unobservable');
    assert.ok(row!.qualifiers.includes('no-hook-surface-in-source'));
    assert.equal(row!.channel, null);
  }
  const peer = rows.find(entry => entry.adapter_id === 'telepty-peer-to-orchestrator');
  assert.equal(peer!.capture_status, 'unsupported');
  assert.ok(peer!.qualifiers.includes('deferred-to-unit-u6'), 'the peer lane names the unit that owns it');
  const orchestrator = rows.find(entry => entry.adapter_id === 'claude-orchestrator');
  assert.equal(orchestrator!.capture_status, 'unsupported');
  assert.ok(orchestrator!.qualifiers.includes('mechanism-present-not-registered'));
});

test('the codex lane declares opt-in and POSIX-only, and the shipped settings register no prompt hook', async () => {
  const rows = await table();
  const codex = rows.find(row => row.adapter_id === 'codex-native');
  assert.ok(codex);
  assert.deepEqual(codex!.qualifiers.slice().sort(), ['opt-in', 'posix-only']);
  // Re-measure the two facts those qualifiers stand for, rather than trusting the label.
  const initCli = await fs.readFile(path.join(repoRoot, 'bin/init/cli.mjs'), 'utf8');
  assert.ok(initCli.includes('opts.captureRoot ? prepareNativeCapture('), 'capture is still opt-in');
  assert.ok(/process\.platform === "win32" && \(opts\.captureRoot/.test(initCli), 'win32 is still refused');
  const native = await fs.readFile(path.join(repoRoot, 'bin/init/native-capture.mjs'), 'utf8');
  assert.ok(native.includes('UserPromptSubmit'), 'the registered hook event is still UserPromptSubmit');
  assert.ok(native.includes('["darwin", "linux"].includes(process.platform)'), 'POSIX-only is still enforced');
  // The orchestrator's own claude session registers no prompt hook: that is the declared gap.
  const settings = JSON.parse(await fs.readFile(path.join(repoRoot, '.claude/settings.json'), 'utf8')) as
    { hooks?: Record<string, unknown> };
  assert.equal(Object.keys(settings.hooks ?? {}).includes('UserPromptSubmit'), false,
    'shipped .claude/settings.json gained a prompt hook: the claude-orchestrator row must be re-measured');
});
