import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  boundedIntakeChild, capturedArguments, defaultIntakePorts, intakeAck, intakeChildEnvironment,
  intakePumpOnce, intakeStatusDocument, intakeTransportOutcome, parseIntakeCommand,
  readIntakeStatusFile, reconcilerIntakeArguments, runIntakeCommand,
} from '../../dist/src/request-capture/intake-pump.js';
import {
  applyIntakeEvent, applyIntakeNotice, emptyIntakeDocument, INTAKE_ORDER_LABEL, intakeNoticeId,
} from '../../dist/src/request-capture/intake.js';
import { captureSubmittedPrompt } from '../../dist/src/request-capture/receipt.js';
import { listCaptureInventory } from '../../dist/src/request-capture/inventory.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = 'a'.repeat(64);
const at = '2026-10-20T00:00:00Z';
const received = '2026-10-20T00:00:00.000Z';
const observation = (value, code = 0) => ({ code, signal: null, error: null, spawned: true,
  timeout: false, overflow: false, stdout: JSON.stringify(value), stderr: '',
  stdout_eof: true, stderr_eof: true });
const item = n => ({ ingress_id: id(n), capture_id: id(n + 100), sha256: digest, byte_len: 8,
  received_at: received, receipt_schema_version: 2, ingress_id_provenance: 'minted-at-capture',
  durability: 'file-and-directory-fsync', upstream_id_status: 'unavailable',
  upstream_delivery_id: null, upstream_scope_sha256: null, task_binding: 'pending', provenance: 'unverified' });
const inventory = items => ({ schema_version: 1, complete: true, snapshot: 'non-atomic-observation',
  order: 'received-at-then-capture-id-not-commit', raw_content_read: false, content_hash_verified: false,
  hook_outcome: 'unrecorded', execution_state: 'unknown', dedupe: 'unavailable', items, anomalies: [] });
const fields = args => Object.fromEntries(Array.from({ length: (args.length - 1) / 2 },
  (_, n) => [args[n * 2 + 1].slice(2).replaceAll('-', '_'), args[n * 2 + 2]]));
const config = { stateDir: '/simulation/state', registryScript: '/simulation/registry',
  telepty: '/simulation/telepty', destination: 'orchestrator', env: {} };

// LABELLED SIMULATION: accepts canonical receipt timestamps to isolate the new caller
// from the confirmed prerequisite gap. This is NOT evidence that the real registry accepts them.
function simulation(items = [item(1)], change = {}) {
  let doc = emptyIntakeDocument(), token = 0, elapsed = 0;
  const calls = [];
  const ports = {
    inventory: async () => { calls.push('inventory'); return inventory(items); },
    registry: async args => {
      calls.push(args);
      if (args[0] === 'intake-list') return observation({ ...doc, order: INTAKE_ORDER_LABEL, count: doc.requests.length });
      const f = fields(args);
      if (args[0] === 'intake-event') {
        const existing = doc.requests.find(row => row.ingress_id === f.ingress_id);
        if (existing) return observation({ result: 'intake_replay', completion_fact: null }, 8);
        const made = applyIntakeEvent(doc, { kind: 'captured', at, ingress_id: f.ingress_id,
          capture_id: f.capture_id, channel: f.channel, upstream_namespace: f.upstream_namespace,
          sha256: f.sha256, byte_len: Number(f.byte_len), received_at: at, upstream_id_status: 'unavailable' });
        assert.equal(made.result, 'intake_written');
        doc = made.document;
        doc.requests.at(-1).received_at = f.received_at;
        doc.generation++;
        return observation({ result: 'intake_written', kind: 'captured', ingress_id: f.ingress_id,
          generation: doc.generation, completion_fact: null });
      }
      const e = { ...f, at: f.now, attempt: Number(f.attempt) };
      delete e.now;
      if (e.action === 'claim') {
        e.previous_attempt = Number(e.previous_attempt);
        e.previous_claim = e.previous_claim === 'none' ? null : e.previous_claim;
      }
      if (e.retry_at === 'none') e.retry_at = null;
      const outcome = applyIntakeNotice(doc, e);
      if (outcome.result !== 'intake_written') return observation({ result: outcome.result, completion_fact: null },
        outcome.result === 'intake_notice_race' || outcome.result === 'intake_notice_replay' ? 8 : 4);
      doc = outcome.document;
      doc.generation++;
      return observation({ result: 'intake_written', action: e.action, notice_id: e.notice_id,
        ingress_id: e.ingress_id, generation: doc.generation, completion_fact: null });
    },
    send: async () => { calls.push('send'); return observation({ queued: true }); },
    readStatus: async () => { calls.push('status'); return structuredClone(doc); },
    monotonic: () => elapsed,
    now: () => at,
    token: () => `claim-${++token}`,
    ...change,
  };
  return { ports, calls, get doc() { return doc; }, set doc(value) { doc = value; },
    advance(ms) { elapsed += ms; } };
}

async function owned(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-pump-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o700);
  return root;
}

test('real capture → actual inventory → public caller → actual registry preserves exact receipt identity/time',
  { timeout: 60_000 }, async t => {
    const deadline = performance.now() + 60_000;
    const root = await owned(t);
    const capture = path.join(root, 'capture'), stateDir = path.join(root, 'state');
    await fs.mkdir(capture, { mode: 0o700 });
    const first = await captureSubmittedPrompt(Buffer.from('same original'), { root: capture });
    const second = await captureSubmittedPrompt(Buffer.from('same original'), { root: capture });
    const view = await listCaptureInventory(capture);
    assert.equal(view.complete, true);
    assert.equal(view.items.length, 2);
    assert.equal(first.sha256, second.sha256);
    assert.notEqual(first.ingress_id, second.ingress_id);
    const realConfig = { ...config, stateDir, registryScript: path.join(repo, 'bin/dispatch-registry.py'),
      env: { HOME: root, PATH: process.env.PATH, TMPDIR: root } };
    const ports = defaultIntakePorts(realConfig);
    const registry = ports.registry;
    ports.registry = (args, ms) => registry(args, Math.max(0, Math.min(ms, Math.floor(deadline - performance.now()))));
    // Only transport is simulated: no external delivery in this owned fixture.
    ports.send = async () => observation({ simulation: 'unknown transport' });
    const response = await runIntakeCommand(['intake-pump', '--once', '--capture-root', capture], realConfig, ports);
    const pass = JSON.parse(response.output);
    // Permanent positive oracle. NO skip, expected-failure or simulated registry success.
    // Statically expected to expose the base's whole-second-only received_at parser.
    assert.equal(pass.imported, 2, 'both valid receipt identities must be durably admitted');
    const persisted = JSON.parse(await fs.readFile(path.join(stateDir, 'intake.json'), 'utf8'));
    for (const receipt of [first, second]) {
      const row = persisted.requests.find(r => r.ingress_id === receipt.ingress_id);
      for (const key of ['ingress_id', 'capture_id', 'sha256', 'byte_len', 'received_at'])
        assert.equal(row[key], receipt[key], `byte-identical ${key}`);
    }
    const again = JSON.parse((await runIntakeCommand(
      ['intake-pump', '--once', '--capture-root', capture], realConfig, ports)).output);
    assert.equal(again.imported, 0);
    assert.equal(again.replayed, 2);
  });

test('simulation: complete empty pass, then every pass reconciles before notice', async () => {
  const empty = simulation([]);
  assert.equal((await intakePumpOnce('/capture', 'orch', empty.ports)).code, 0);
  const sim = simulation([item(2), item(1)]);
  const first = await intakePumpOnce('/capture', 'orch', sim.ports);
  assert.equal(first.imported, 2);
  assert.equal(first.code, 3);
  assert.equal(sim.doc.requests[0].ingress_id, id(1));
  assert.deepEqual(sim.calls.slice(0, 4).map(c => Array.isArray(c) ? c[0] : c),
    ['inventory', 'intake-event', 'intake-event', 'intake-list']);
  assert.equal(sim.doc.requests[0].notice.events.at(-1).status, 'unknown');
  const before = sim.calls.length;
  const again = await intakePumpOnce('/capture', 'orch', sim.ports);
  assert.equal(again.replayed, 2);
  assert.equal(sim.calls[before], 'inventory');
  assert.equal(sim.doc.requests[0].notice.events.length, 2, 'unknown claim never retried');
  assert.equal(sim.doc.requests[0].work_state, 'unstarted');
});

for (const [name, alter] of [
  ['incomplete', v => { v.complete = false; }],
  ['anomaly', v => { v.anomalies = [{ code: 'scan_limit', count: 1, refs: [] }]; }],
  ['duplicate identity', v => { v.items.push({ ...v.items[0] }); }],
  ['unsupported durability', v => { v.items[0].durability = 'file-fsync-only'; }],
  ['over bound', v => { v.items = Array.from({ length: 101 }, (_, n) => item(n + 1)); }],
  ['invalid identity', v => { v.items[0].ingress_id = 'not-a-uuid'; }],
]) {
  test(`simulation: ${name} refuses before registry or transport`, async () => {
    const sim = simulation();
    const v = inventory([item(1)]);
    alter(v);
    sim.ports.inventory = async () => v;
    assert.equal((await intakePumpOnce('/capture', 'orch', sim.ports)).code, 3);
    assert.deepEqual(sim.calls, []);
  });
}

for (const [name, response, expected] of [
  ['collision', observation({ result: 'intake_identity_collision', completion_fact: null }, 4), 4],
  ['wrong zero', observation({ result: 'intake_replay', completion_fact: null }), 9],
  ['wrong eight', observation({ result: 'intake_written', completion_fact: null }, 8), 9],
  ['storage', observation({ result: 'registry_corrupt' }, 9), 9],
  ['timeout', { ...observation({}), timeout: true }, 9],
  ['overflow', { ...observation({}), overflow: true }, 9],
  ['malformed', { ...observation({}), stdout: '{' }, 9],
]) {
  test(`simulation: ${name} stops all subsequent imports/notices`, async () => {
    const sim = simulation([item(1), item(2)]);
    let calls = 0;
    sim.ports.registry = async () => { calls++; return response; };
    const pass = await intakePumpOnce('/capture', 'orch', sim.ports);
    assert.equal(pass.code, expected);
    assert.equal(calls, 1);
    assert.equal(pass.notices, 0);
  });
}

for (const result of ['intake_replay', 'intake_archived']) {
  test(`simulation: typed ${result} preserves no-resurrection semantics`, async () => {
    const sim = simulation();
    const registry = sim.ports.registry;
    sim.ports.registry = args => args[0] === 'intake-event'
      ? Promise.resolve(observation({ result, completion_fact: null }, 8)) : registry(args);
    const pass = await intakePumpOnce('/capture', 'orch', sim.ports);
    assert.equal(pass.replayed, 1);
    assert.equal(sim.doc.requests.length, 0);
    assert.equal(pass.notices, 0);
  });
}

test('simulation: upstream duplicate is inconsistent with this adapter unavailable upstream identity', async () => {
  const sim = simulation();
  sim.ports.registry = async () => observation({ result: 'intake_upstream_duplicate', completion_fact: null }, 8);
  const pass = await intakePumpOnce('/capture', 'orch', sim.ports);
  assert.equal(pass.code, 9);
  assert.equal(pass.replayed, 0);
  assert.equal(pass.notices, 0);
});

test('simulation: definitive not_sent retries only at durable retry_at; explicit-null eligibility is required', async () => {
  const sim = simulation();
  sim.ports.send = async () => {
    sim.calls.push('send');
    return { ...observation({}), spawned: false, error: 'ENOENT' };
  };
  await intakePumpOnce('/capture', 'orch', sim.ports);
  assert.equal(sim.doc.requests[0].notice.events.at(-1).status, 'not_sent');
  await intakePumpOnce('/capture', 'orch', sim.ports);
  assert.equal(sim.calls.filter(c => c === 'send').length, 1);
  sim.ports.now = () => '2026-10-20T00:01:00Z';
  await intakePumpOnce('/capture', 'orch', sim.ports);
  assert.equal(sim.calls.filter(c => c === 'send').length, 2);
  assert.equal(sim.doc.requests[0].notice.events.at(-1).attempt, 2);
  for (const field of ['pause', 'superseded_by', 'result', 'failure']) {
    const malformed = simulation();
    await malformed.ports.registry(capturedArguments(item(1), at));
    delete malformed.doc.requests[0][field];
    assert.equal((await intakePumpOnce('/capture', 'orch', malformed.ports)).code, 9);
    assert.ok(!malformed.calls.includes('send'));
  }
});

test('simulation: crash after claim leaves live claim; stale result cannot overwrite it', async () => {
  const sim = simulation();
  sim.ports.send = async () => { throw new Error('simulated crash cut'); };
  assert.equal((await intakePumpOnce('/capture', 'orch', sim.ports)).code, 9);
  const claim = sim.doc.requests[0].notice.events[0];
  assert.equal(claim.action, 'claim');
  const before = JSON.stringify(sim.doc);
  await intakePumpOnce('/capture', 'orch', sim.ports);
  assert.equal(JSON.stringify(sim.doc), before);
  const { previous_attempt, previous_claim, ...tuple } = claim;
  assert.equal(applyIntakeNotice(sim.doc, { ...tuple, action: 'result', claim: 'stale',
    status: 'unknown', evidence_sha256: digest, retry_at: null }).result, 'intake_transition_refused');
  assert.equal(JSON.stringify(sim.doc), before);
});

test('simulation: claim race never sends, result uncertainty never retries', async () => {
  const race = simulation();
  const registry = race.ports.registry;
  race.ports.registry = args => args[0] === 'intake-notice'
    ? Promise.resolve(observation({ result: 'intake_notice_race', completion_fact: null }, 8)) : registry(args);
  assert.equal((await intakePumpOnce('/capture', 'orch', race.ports)).code, 3);
  assert.ok(!race.calls.includes('send'));
  const lost = simulation();
  const real = lost.ports.registry;
  lost.ports.registry = async args => {
    const r = await real(args);
    return args[0] === 'intake-notice' && fields(args).action === 'result' ? { ...r, stdout: '' } : r;
  };
  assert.equal((await intakePumpOnce('/capture', 'orch', lost.ports)).code, 9);
  await intakePumpOnce('/capture', 'orch', lost.ports);
  assert.equal(lost.calls.filter(c => c === 'send').length, 1);
});

test('simulation: paused/terminal states retain lifecycle and no new notice', async () => {
  for (const state of ['waiting', 'failed', 'completed', 'cancelled']) {
    const sim = simulation();
    await sim.ports.registry(capturedArguments(item(1), at));
    sim.doc.requests[0].state = state;
    sim.doc.requests[0].work_state = state === 'waiting' ? 'paused' : state;
    const before = JSON.stringify(sim.doc);
    const pass = await intakePumpOnce('/capture', 'orch', sim.ports);
    assert.equal(pass.notices, 0);
    assert.equal(JSON.stringify(sim.doc), before);
    const row = intakeStatusDocument(sim.doc).requests[0];
    assert.equal(row.position, state === 'completed' || state === 'cancelled' ? null : 1);
  }
});

test('simulation: missing evidence blocks notice, missing binding is visible, deadline prevents writes', async () => {
  const sim = simulation();
  await sim.ports.registry(capturedArguments(item(1), at));
  sim.ports.inventory = async () => inventory([]);
  const pass = await intakePumpOnce('/capture', 'orch', sim.ports);
  assert.equal(pass.notices, 0);
  assert.ok(pass.reasons.some(r => r.startsWith('evidence_missing')));
  assert.ok(pass.reasons.some(r => r.startsWith('binding_pending')));
  const expired = simulation();
  expired.ports.inventory = async () => { expired.advance(60_000); return inventory([item(1)]); };
  assert.equal((await intakePumpOnce('/capture', 'orch', expired.ports)).code, 3);
  assert.deepEqual(expired.calls, []);
});

test('transport observations never promote generic/queued/consumed text to authenticated sent', () => {
  for (const stdout of ['ok', 'QUEUED, NOT consumed', '— consumed as a new turn.', 'Submit gated-timeout']) {
    assert.equal(intakeTransportOutcome({ ...observation({}), stdout }), 'unknown');
  }
  assert.equal(intakeTransportOutcome({ ...observation({}), spawned: false, error: 'ENOENT' }), 'not_sent');
  assert.equal(intakeTransportOutcome({ ...observation({}), error: 'ENOENT' }), 'unknown');
  assert.equal(intakeTransportOutcome({ ...observation({}), timeout: true }), 'unknown');
});

test('simulation: status and default ACK have no import, claim, send or mutation', async () => {
  const sim = simulation();
  assert.equal((await runIntakeCommand(['intake-status', '--json'], config, sim.ports)).code, 0);
  assert.deepEqual(sim.calls, ['status']);
  assert.equal((await intakeAck(sim.ports)).reason, 'receiver_verification_unavailable');
  assert.equal((await runIntakeCommand(['intake-ack'], config, sim.ports)).code, 4);
  assert.deepEqual(sim.calls, ['status']);
});

test('simulation: verified receiver ACK exact tuple only; lifecycle unchanged', async () => {
  const sim = simulation();
  await sim.ports.registry(capturedArguments(item(1), at));
  const claim = { action: 'claim', ingress_id: id(1), notice_id: intakeNoticeId(id(1)),
    attempt: 1, claim: 'verified-claim', owner: 'intake-pump', at, previous_attempt: 0, previous_claim: null };
  sim.doc = applyIntakeNotice(sim.doc, claim).document;
  const { previous_attempt, previous_claim, ...tuple } = claim;
  sim.doc = applyIntakeNotice(sim.doc, { ...tuple, action: 'result', status: 'sent',
    evidence_sha256: digest, retry_at: null }).document;
  const ack = { ...tuple, action: 'ack', evidence_sha256: digest };
  const stale = await intakeAck(sim.ports, { verify: async () => ({ ...ack, claim: 'stale' }) });
  assert.equal(stale.code, 4);
  const before = { ...sim.doc.requests[0], notice: null };
  assert.equal((await intakeAck(sim.ports, { verify: async () => ack })).code, 0);
  assert.deepEqual({ ...sim.doc.requests[0], notice: null }, before);
  assert.equal((await intakeAck(sim.ports, { verify: async () => ack })).reason, 'verified_ack_replay');
});

test('exact CLI grammar and reconciler default-off/dry-run/environment boundary', () => {
  for (const args of [
    ['intake-pump'], ['intake-pump', '--once', '--capture-root', 'relative'],
    ['intake-pump', '--once', '--once', '/capture'], ['intake-pump', '--once', '--unknown', '/capture'],
    ['intake-status', '--json', '--json'], ['intake-ack', '--verified'], ['intake-ack', '--owner', 'orch'],
  ]) assert.equal(parseIntakeCommand(args), null);
  assert.deepEqual(parseIntakeCommand(['intake-pump', '--capture-root', '/capture', '--once']),
    { command: 'intake-pump', root: '/capture' });
  assert.equal(reconcilerIntakeArguments(0, {}), null);
  assert.equal(reconcilerIntakeArguments(1, { AIGENTRY_INTAKE_PUMP: '1', AIGENTRY_CAPTURE_ROOT: '/capture' }), null);
  assert.equal(reconcilerIntakeArguments(0, { AIGENTRY_INTAKE_PUMP: '1', AIGENTRY_CAPTURE_ROOT: 'relative' }), null);
  assert.deepEqual(reconcilerIntakeArguments(0, { AIGENTRY_INTAKE_PUMP: '1', AIGENTRY_CAPTURE_ROOT: '/capture' }),
    ['intake-pump', '--once', '--capture-root', '/capture']);
  assert.deepEqual(intakeChildEnvironment({ HOME: '/owned', PATH: '/bin', NODE_OPTIONS: '--require evil',
    TELEPTY_SESSION_TOKEN: 'secret', TELEPTY_SUBMIT_FORCE_DEFAULT: '1' }), { HOME: '/owned', PATH: '/bin' });
});

test('real public entrypoint: invalid args/ACK/status never create state; corrupt status never logs',
  { timeout: 60_000 }, async t => {
    const root = await owned(t), stateDir = path.join(root, 'absent');
    const env = { HOME: root, PATH: process.env.PATH, TMPDIR: root, DISPATCH_STATE_DIR: stateDir };
    const cli = path.join(repo, 'dist/src/tracker/cli.js');
    const cases = [
      [['intake-pump', '--once', '--capture-root', 'relative'], 4],
      [['intake-status', '--json', '--unknown'], 4],
      [['intake-ack'], 4],
      [['intake-status', '--json'], 0],
    ];
    for (const [args, code] of cases) {
      const r = await boundedIntakeChild(process.execPath, [cli, ...args], env, 10_000);
      assert.equal(r.code, code, r.stderr);
      assert.deepEqual(await fs.readdir(root), []);
    }
    await fs.mkdir(stateDir, { mode: 0o700 });
    await fs.writeFile(path.join(stateDir, 'intake.json'), '{broken', { mode: 0o600 });
    assert.equal(await readIntakeStatusFile(stateDir), null);
    assert.deepEqual(await fs.readdir(stateDir), ['intake.json']);
    assert.equal(await fs.readFile(path.join(stateDir, 'intake.json'), 'utf8'), '{broken');
  });
