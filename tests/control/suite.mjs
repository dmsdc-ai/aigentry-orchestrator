// Independent tests of the task #1182 isolated control admission core (emitted JS).
// kinds: inv   = invariant the approved contract requires (fail = defect or broken oracle)
//        probe = approved-contract reading the code may not satisfy (fail = reproduced divergence)
//        obs   = measured fact recorded in notes (passes unless the measurement itself breaks)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { FakeStore, key, makeAuth, makeClock, makeIds } from './fake.mjs';

export const T0 = 1_700_000_000_000;
const WS = 'ws1', RT = 'rt1', TASK = 'task-1', TASK_REV = 3, CFG_REV = 7;
const SCOPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const hex12 = n => n.toString(16).padStart(12, '0');
const idem = n => `11111111-1111-4111-8111-${hex12(n)}`;
const att = n => `22222222-2222-4222-8222-${hex12(n)}`;
const did = n => `dddddddd-dddd-4ddd-8ddd-${hex12(n)}`;
const nonceOf = n => `N${n}`.padEnd(43, 'x');
const clone = v => JSON.parse(JSON.stringify(v));
const USER = Object.freeze({ kind: 'user', user_id: 'u1', credential_id: 'c1', auth_session_id: 'sess-SECRET-1' });

export function scopeRecord(over = {}) {
  return {
    v: 1, scope_id: SCOPE_ID, rev: 1, workspace_id: WS, runtime_id: RT, task_ids: [TASK],
    ops: ['dispatch.start', 'config.set'], config_settings: ['role.launch', 'advisor.enabled'],
    paths: ['src', 'docs/api'], models: [{ cli: 'claude', model: 'opus-5-5', effort: 'medium' }],
    // cf1182ub C1 shape: exact roles + worker namespaces (fixture: role 'coder', namespace 'worker').
    roles: ['coder'], target_prefixes: ['worker'],
    loop: false, approved_at_ms: T0 - 1000, expires_at_ms: T0 + 86_400_000, approval_decision_id: null, ...over,
  };
}
export function dispatch(n, edit = () => {}) {
  const c = {
    v: 1, op: 'dispatch.start', idem_key: idem(n), workspace_id: WS, runtime_id: RT, expires_at_ms: T0 + 60_000,
    decision_id: null, task_id: TASK, task_rev: TASK_REV, attempt: att(n), scope_id: SCOPE_ID,
    expected: { config_rev: CFG_REV },
    params: { target: { sid: 'worker-1' }, role: 'coder', cli: 'claude', model: 'opus-5-5', effort: 'medium', paths: ['src/a.ts'], wave: 1, loop: false },
  };
  edit(c); return c;
}
export function configCmd(n, edit = () => {}) {
  const c = {
    v: 1, op: 'config.set', idem_key: idem(n), workspace_id: WS, runtime_id: RT, expires_at_ms: T0 + 60_000,
    // cf1182ub C3 shape: config.set is task-bound too.
    decision_id: null, task_id: TASK, task_rev: TASK_REV, scope_id: SCOPE_ID, expected: { config_rev: CFG_REV },
    params: { setting: 'role.launch', role: 'coder', cli: 'claude', model: 'opus-5-5', effort: 'medium' },
  };
  edit(c); return c;
}

/** Independent canonical encoder (sorted keys, JSON.stringify leaves) for digest cross-checks. */
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}
const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
function deepFrozen(v) {
  if (v === null || typeof v !== 'object') return true;
  return Object.isFrozen(v) && Object.values(v).every(deepFrozen);
}

const tests = [];
const T = (id, kind, title, fn) => tests.push({ id, kind, title, fn });

function makeWorld(ctx, opts = {}) {
  const store = ctx.makeStore();
  store.put(key('grant', 'u1', WS), { role: opts.role ?? 'owner' });
  store.put(key('enrolled', WS, RT), true);
  store.put(key('config_rev', WS, RT), CFG_REV);
  store.put(key('task_rev', WS, TASK), TASK_REV);
  if (opts.scope !== null) store.put(key('scope', WS, SCOPE_ID), { record: scopeRecord(opts.scope ?? {}), revoked: false });
  const auth = makeAuth(), clock = makeClock(T0), ids = makeIds();
  const trusted = { principal: opts.principal ?? USER, authentication: auth, clock, ids };
  const w = {
    store, auth, clock, ids, trusted,
    admit: (raw, t = trusted) => ctx.A.admitCommand(raw, t, store),
    adm: () => store.keys('adm').length,
    consumed: () => store.keys('consumed_id').length,
    decide(n, raw, over = {}, rowOver = {}) {
      const cmd = ctx.C.validateCommand(raw);
      assert.ok(cmd.ok, 'fixture command must validate');
      const stored = raw.scope_id === null ? undefined : store.get(key('scope', WS, raw.scope_id));
      const scope = stored === undefined ? null : ctx.C.validateScopeRecord(stored.record).value;
      const view = ctx.K.renderCommandCard({ command: cmd.value, principal: ctx.C.validatePrincipal(USER).value, scope });
      const record = {
        v: 1, decision_id: did(n), verification: 'upstream_verified', verifier: 'fake-webauthn',
        // cf1182ub C3 shape: subject binds task_id and a non-nullable task_rev for both ops.
        subject: { kind: 'command', id: raw.idem_key, task_id: raw.task_id, task_rev: raw.task_rev, config_rev: raw.expected.config_rev },
        card_sha256: view.card_sha256, verdict: 'approve', user_id: USER.user_id, credential_id: USER.credential_id,
        auth_session_id: USER.auth_session_id, workspace_id: WS, runtime_id: RT, nonce: nonceOf(n),
        rendering_origin: 'runtime_local', issued_at_ms: T0 - 1000, expires_at_ms: T0 + 60_000, ...over,
      };
      store.put(key('decision', WS, rowOver.storeId ?? did(n)), { record, revoked: false, ...rowOver.row });
      return { record, view };
    },
  };
  return w;
}
function refusedWith(res, code, reason) {
  assert.equal(res.ok, false, `expected refusal ${code}, got ok`);
  assert.equal(res.refusal.code, code, `expected ${code}, got ${res.refusal.code}: ${res.refusal.detail} reasons=${res.refusal.reasons}`);
  if (reason !== undefined) assert.ok(res.refusal.reasons.includes(reason), `expected reason ${reason}, got ${res.refusal.reasons}`);
}
const outside = c => { c.params.paths = ['lib/x.ts']; }; // out-of-scope path => decision needed
/** Counts the store.transaction calls of one admitCommand call (core retries), over the shared store. */
function counted(store) {
  const c = { n: 0, transaction(work) { c.n++; return store.transaction(work); } };
  return c;
}
/** Reservations recorded for a workspace/scope (live or lapsed) and port-method call counts. */
const resv = (store, scopeId = SCOPE_ID, ws = WS) => (store.get(key('resv_idx', ws, scopeId)) ?? []).length;
const callsOf = (store, name) => store.calls.filter(c => c[2] === name).length;
const ID_A = ['cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003'];
let freshCounter = 0;
const freshIds = () => [1, 2, 3].map(() => `eeeeeeee-0000-4000-8000-${hex12(++freshCounter)}`);

// ───────────────────────── V: validation boundaries ─────────────────────────
T('V01', 'inv', 'valid dispatch.start/config.set parse to deep-frozen detached copies', ctx => {
  for (const raw of [dispatch(1), configCmd(2), configCmd(3, c => { c.params = { setting: 'advisor.enabled', enabled: true }; })]) {
    const r = ctx.C.validateCommand(raw);
    assert.ok(r.ok, JSON.stringify(r.refusal));
    assert.ok(deepFrozen(r.value));
    const before = canon(r.value);
    raw.workspace_id = 'mutated'; if (raw.params.paths) raw.params.paths.push('x');
    assert.equal(canon(r.value), before);
  }
});
T('V02', 'inv', 'client authority/id fields and unknown fields are UNKNOWN_FIELD', ctx => {
  for (const f of ['user_id', 'credential_id', 'auth_session_id', 'command_id', 'issued_at', 'issued_at_ms', 'approved', 'role', 'msg_id']) {
    const r = ctx.C.validateCommand(dispatch(1, c => { c[f] = 'u1'; }));
    assert.equal(r.ok, false); assert.equal(r.refusal.code, 'UNKNOWN_FIELD', f);
  }
  const r2 = ctx.C.validateCommand(dispatch(1, c => { c.params.argv = ['rm']; }));
  assert.equal(r2.refusal.code, 'UNKNOWN_FIELD');
  const r3 = ctx.C.validateCommand(configCmd(1, c => { c.params.value = 'secret'; }));
  assert.equal(r3.refusal.code, 'UNKNOWN_FIELD');
  const r4 = ctx.C.validateCommand(dispatch(1, c => { c.params.target.cwd = '/'; }));
  assert.equal(r4.refusal.code, 'UNKNOWN_FIELD');
});
T('V03', 'inv', 'missing fields / version refusals', ctx => {
  const r = ctx.C.validateCommand(dispatch(1, c => { delete c.decision_id; }));
  assert.equal(r.refusal.code, 'INVALID_VALUE');
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.v = 2; })).refusal.code, 'UNKNOWN_VERSION');
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { delete c.v; })).refusal.code, 'UNKNOWN_VERSION');
  for (const f of ['task_id', 'task_rev', 'attempt', 'scope_id', 'expected']) {
    assert.equal(ctx.C.validateCommand(dispatch(1, c => { delete c[f]; })).ok, false, f);
  }
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.params.target.sid = ''; })).ok, false);
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.params.paths = []; })).ok, false);
});
T('V04', 'inv', 'pending/unknown ops and unknown config settings are OPERATION_UNAVAILABLE', ctx => {
  assert.equal(ctx.C.PENDING_OPERATIONS.length, 14);
  for (const op of [...ctx.C.PENDING_OPERATIONS, 'shell.exec', 'exec', '__proto__', 'config.get']) {
    const r = ctx.C.validateCommand(dispatch(1, c => { c.op = op; }));
    assert.equal(r.refusal.code, 'OPERATION_UNAVAILABLE', op);
  }
  for (const setting of ['api.key', 'env', 'credentials', 'role.launch ']) {
    const r = ctx.C.validateCommand(configCmd(1, c => { c.params.setting = setting; }));
    assert.equal(r.refusal.code, 'OPERATION_UNAVAILABLE', setting);
  }
});
T('V05', 'inv', 'non-safe-integer numbers refused, never normalized', ctx => {
  for (const v of [1.5, NaN, Infinity, -Infinity, -0, 2 ** 53, -1, '3', 3n, null, true]) {
    const r = ctx.C.validateCommand(dispatch(1, c => { c.task_rev = v; }));
    assert.equal(r.ok, false, String(v));
  }
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.params.wave = 0; })).ok, false);
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.expires_at_ms = 0; })).ok, false);
});
T('V06', 'inv', 'depth bound exact and cycles refused without stack overflow', ctx => {
  const nest = n => { let v = 1; for (let i = 0; i < n; i++) v = [v]; return v; };
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.x = nest(7); })).refusal.code, 'UNKNOWN_FIELD');
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.x = nest(8); })).refusal.code, 'INPUT_LIMIT');
  const cyc = dispatch(1); cyc.params.self = cyc;
  assert.equal(ctx.C.validateCommand(cyc).refusal.code, 'INPUT_LIMIT');
  const cyc2 = dispatch(1); cyc2.params.paths.push(cyc2.params.paths);
  assert.equal(ctx.C.validateCommand(cyc2).refusal.code, 'INPUT_LIMIT');
});
T('V07', 'inv', 'size bounds: bytes, text, keys, list, paths, nodes', ctx => {
  const big = dispatch(1, c => { for (let i = 0; i < 40; i++) c[`k${i}`] = 'a'.repeat(2048); });
  assert.equal(ctx.C.validateCommand(big).refusal.code, 'INPUT_LIMIT');
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.task_id = 'a'.repeat(2049); })).refusal.code, 'INPUT_LIMIT');
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { for (let i = 0; i < 60; i++) c[`k${i}`] = 1; })).refusal.code, 'INPUT_LIMIT');
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.params.paths = Array.from({ length: 65 }, (_, i) => `src/f${i}`); })).refusal.code, 'INPUT_LIMIT');
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.x = Array.from({ length: 257 }, () => 1); })).refusal.code, 'INPUT_LIMIT');
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.x = Array.from({ length: 256 }, () => Array.from({ length: 20 }, () => 1)); })).refusal.code, 'INPUT_LIMIT');
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.params.paths = [`src/${'a'.repeat(509)}`]; })).refusal.code, 'INPUT_LIMIT');
  assert.ok(ctx.C.validateCommand(dispatch(1, c => { c.params.paths = [`src/${'a'.repeat(508)}`]; })).ok);
});
T('V08', 'inv', 'prototype tricks: exotic prototypes refused, __proto__ key not merged, pollution ignored', ctx => {
  assert.equal(ctx.C.validateCommand(Object.assign(Object.create({}), dispatch(1))).refusal.code, 'INVALID_SHAPE');
  class Cmd {} assert.equal(ctx.C.validateCommand(Object.assign(new Cmd(), dispatch(1))).refusal.code, 'INVALID_SHAPE');
  assert.equal(ctx.C.validateCommand(Object.assign([], dispatch(1))).ok, false);
  const text = JSON.stringify(dispatch(1)).replace('{', '{"__proto__":{"polluted":1},');
  const r = ctx.C.validateCommand(JSON.parse(text));
  assert.equal(r.refusal.code, 'UNKNOWN_FIELD');
  assert.equal(({}).polluted, undefined);
  const nested = JSON.parse(JSON.stringify(dispatch(1)).replace('"target":{', '"target":{"__proto__":{"sid":"evil"},'));
  assert.equal(ctx.C.validateCommand(nested).refusal.code, 'UNKNOWN_FIELD');
  ctx.notes.push(`null-prototype raw object accepted: ${ctx.C.validateCommand(Object.assign(Object.create(null), dispatch(1))).ok}`);
});
T('V08b', 'inv', 'Object.prototype pollution does not supply missing/absent fields in command, scope or rows', async ctx => {
  const names = ['decision_id', 'caps', 'revoked', 'consumed', 'loop', 'spent', 'role'];
  const w = makeWorld(ctx); // built before pollution so test fixtures themselves are unaffected
  try {
    Object.prototype.decision_id = did(9); Object.prototype.caps = { max_workers: 1 };
    Object.prototype.revoked = true; Object.prototype.consumed = true; Object.prototype.loop = true;
    Object.prototype.spent = { unit: 'usd', amount: 10 ** 9 }; Object.prototype.role = 'viewer';
    assert.equal(ctx.C.validateCommand(dispatch(1, c => { delete c.decision_id; })).refusal.code, 'INVALID_VALUE');
    const res = await w.admit(dispatch(1));
    assert.ok(res.ok, JSON.stringify(res.refusal));
    assert.equal(res.capability.decision_id, null);
  } finally { for (const n of names) delete Object.prototype[n]; }
});
T('V09', 'inv', 'accessors refused without invoking getters (raw command and nested)', async ctx => {
  let calls = 0;
  const g = (o, k, v) => Object.defineProperty(o, k, { get() { calls++; return v; }, enumerable: true, configurable: true });
  const a = dispatch(1); g(a, 'workspace_id', WS);
  const b = dispatch(1); g(b.params.target, 'sid', 'worker-1');
  const c = dispatch(1); g(c.params.paths, '0', 'src/a.ts');
  const d = dispatch(1); Object.defineProperty(d, 'hidden', { value: 1, enumerable: false });
  const e = dispatch(1); e[Symbol('s')] = 1;
  for (const raw of [a, b, c]) assert.equal(ctx.C.validateCommand(raw).refusal.code, 'INVALID_SHAPE');
  for (const raw of [d, e]) assert.equal(ctx.C.validateCommand(raw).ok, false);
  const w = makeWorld(ctx);
  const res = await w.admit(a);
  assert.equal(res.ok, false);
  assert.equal(calls, 0, 'getter invoked');
  assert.equal(w.store.txCount, 0);
});
T('V10', 'inv', 'proxies (top, nested, array, revoked) refused with zero trap invocations', async ctx => {
  let traps = 0;
  const handler = {};
  for (const n of ['get', 'set', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'defineProperty', 'deleteProperty', 'isExtensible', 'preventExtensions', 'setPrototypeOf']) {
    handler[n] = (...args) => { traps++; return Reflect[n](...args); };
  }
  const top = new Proxy(dispatch(1), handler);
  const nested = dispatch(1); nested.params = new Proxy(nested.params, handler);
  const arr = dispatch(1); arr.params.paths = new Proxy(arr.params.paths, handler);
  const { proxy, revoke } = Proxy.revocable(dispatch(1), {}); revoke();
  for (const raw of [top, nested, arr, proxy]) assert.equal(ctx.C.validateCommand(raw).refusal.code, 'INVALID_SHAPE');
  const w = makeWorld(ctx);
  assert.equal((await w.admit(top)).ok, false);
  assert.equal(traps, 0, 'proxy trap invoked');
});
T('V11', 'inv', 'sparse/extra-property/subclassed arrays refused', ctx => {
  const sparse = dispatch(1); sparse.params.paths = ['src/a', , 'src/b']; // eslint-disable-line no-sparse-arrays
  const extra = dispatch(1); extra.params.paths.extra = 1;
  class A2 extends Array {} const sub = dispatch(1); sub.params.paths = A2.from(['src/a']);
  for (const raw of [sparse, extra, sub]) assert.equal(ctx.C.validateCommand(raw).refusal.code, 'INVALID_SHAPE');
});
T('V12', 'inv', 'invalid encoding / non-ASCII / non-JSON values refused in commands', ctx => {
  for (const v of ['ws\uD800', 'ws\uDC00x', 'wś', 'ws\u0000', 'ws\n']) {
    assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.workspace_id = v; })).ok, false, JSON.stringify(v));
  }
  for (const p of ['src/é.ts', 'src/e\u0301.ts', 'ｓrc/a', 'src/\uD800', 'src/a b']) {
    assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.params.paths = [p]; })).ok, false, JSON.stringify(p));
  }
  for (const v of [Buffer.from('x'), new Date(0), new Map(), () => 1, undefined, Symbol('x'), 1n]) {
    assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.params.target.sid = v; })).ok, false, String(typeof v));
  }
  let lone; try { lone = ctx.C.canonicalJson({ a: '\uD800' }); } catch (e) { lone = `refused:${e.refusal?.code}`; }
  ctx.notes.push(`generic snapshot/canonicalJson on lone surrogate: ${JSON.stringify(lone)} (commands refuse via ASCII grammar)`);
});
T('V13', 'inv', 'path grammar refuses traversal/absolute/drive/backslash/empty segments', ctx => {
  for (const p of ['/etc/passwd', 'C:/x', 'C:x', 'c:\\x', '\\\\srv\\share', 'a\\b', 'a//b', 'a/', '/', '', './a', 'a/./b', 'a/../b', '..', '.', 'src/..', 'a:b', 'a?b', 'a*b', 'a~1', '~/x']) {
    assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.params.paths = [p]; })).ok, false, JSON.stringify(p));
  }
});
T('V13o', 'obs', 'Windows-hazardous path segments accepted by grammar (executor must re-check)', ctx => {
  const accepted = [];
  for (const p of ['src/CON', 'src/aux.txt', 'src/nul', 'src/COM1', 'src/LPT1.log', 'src/a.', 'src/...', 'src/a..', 'SRC/a', `src/${'a'.repeat(300)}`, 'src/.git/config', 'src/.env', 'src/@x', 'src/+x', '-rf']) {
    if (ctx.C.validateCommand(dispatch(1, c => { c.params.paths = [p]; })).ok) accepted.push(p.length > 40 ? `src/a×${p.length - 4} (${p.length} chars)` : p);
  }
  ctx.notes.push(`accepted: ${JSON.stringify(accepted)}`);
});
T('V14', 'inv', 'identifier grammars: uppercase/non-v4 UUIDs, oversize ids refused', ctx => {
  assert.ok(ctx.C.validateCommand(dispatch(1, c => { c.idem_key = 'abcdefab-abcd-4abc-8abc-abcdefabcdef'; })).ok);
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.idem_key = 'ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF'; })).ok, false);
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.idem_key = '11111111-1111-1111-8111-000000000001'; })).ok, false);
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.attempt = '22222222-2222-4222-c222-000000000001'; })).ok, false);
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.task_id = 'a'.repeat(81); })).ok, false);
  assert.ok(ctx.C.validateCommand(dispatch(1, c => { c.task_id = 'a'.repeat(80); })).ok);
});
T('V15', 'inv', 'canonical digest: key-order invariant, content-sensitive, matches independent recompute', ctx => {
  const a = ctx.C.validateCommand(dispatch(1)).value;
  const reordered = JSON.parse(canon(dispatch(1)));
  const rev = {}; for (const k of Object.keys(reordered).reverse()) rev[k] = reordered[k];
  const b = ctx.C.validateCommand(rev).value;
  assert.equal(ctx.C.canonicalDigest(a), ctx.C.canonicalDigest(b));
  assert.equal(ctx.C.canonicalDigest(a), sha(canon(dispatch(1))));
  assert.notEqual(ctx.C.canonicalDigest(a), ctx.C.canonicalDigest(ctx.C.validateCommand(dispatch(1, c => { c.params.wave = 2; })).value));
});

// ───────────────────────── P: positive admission ─────────────────────────
T('P01', 'inv', 'dispatch.start inside scope admitted with no decision; receipt/capability exact', async ctx => {
  const w = makeWorld(ctx);
  const res = await w.admit(dispatch(1));
  assert.ok(res.ok, JSON.stringify(res.refusal));
  assert.equal(res.replayed, false);
  const { receipt: r, capability: c } = res;
  assert.equal(r.state, 'admitted'); assert.equal(r.commit, 'store_reported_committed'); assert.equal(c.state, 'issued');
  assert.equal(r.msg_id, c.msg_id); assert.equal(r.cap_id, c.cap_id); assert.equal(r.command_id, c.command_id);
  assert.equal(new Set([r.msg_id, r.cap_id, r.command_id]).size, 3);
  assert.equal(r.request_sha256, sha(canon(dispatch(1))));
  assert.equal(c.not_after_ms, Math.min(T0 + 600_000, T0 + 60_000, T0 + 86_400_000));
  assert.equal(c.scope_id, SCOPE_ID); assert.equal(c.decision_id, null);
  assert.ok(deepFrozen(res));
  const stored = w.store.get(key('adm', 'u1', WS, RT, idem(1)));
  assert.deepEqual(stored.receipt, clone(r));
  assert.equal(w.consumed(), 0);
  assert.equal(w.store.commits, 1);
});
T('P02', 'inv', 'config.set role.launch inside scope admitted; advisor.enabled without scope admitted only via decision', async ctx => {
  const w = makeWorld(ctx);
  assert.ok((await w.admit(configCmd(1))).ok);
  const raw = configCmd(2, c => { c.scope_id = null; c.params = { setting: 'advisor.enabled', enabled: true }; });
  refusedWith(await w.admit(raw), 'DECISION_REQUIRED', 'no_scope');
  w.decide(2, raw);
  raw.decision_id = did(2);
  const res = await w.admit(raw);
  assert.ok(res.ok, JSON.stringify(res.refusal));
  assert.equal(res.capability.decision_id, did(2));
  assert.equal(w.consumed(), 1);
});
T('P03', 'inv', 'controller principal and operator role admitted inside scope with no decision', async ctx => {
  const w = makeWorld(ctx, { principal: { ...USER, kind: 'controller' } });
  assert.ok((await w.admit(dispatch(1))).ok);
  const w2 = makeWorld(ctx, { role: 'operator' });
  assert.ok((await w2.admit(dispatch(2))).ok);
});
T('P04', 'inv', 'no fixed worker/wave cap when caps are null: 40 admissions and wave 10000 admitted', async ctx => {
  const w = makeWorld(ctx);
  for (let i = 1; i <= 40; i++) assert.ok((await w.admit(dispatch(i))).ok, `admission ${i}`);
  const res = await w.admit(dispatch(41, c => { c.params.wave = 10_000; }));
  assert.ok(res.ok);
  const card = (await w.admit(dispatch(42, outside))).refusal.card;
  assert.equal(card.card.scope.parallelism, 'resource_chosen');
  assert.deepEqual(clone(card.card.scope.caps), { max_workers: null, max_waves: null, spend_ceiling: null });
  assert.equal(w.adm(), 41);
});
T('P05', 'inv', 'stored AdmissionRecord is a deep-frozen JSON-serializable copy; later raw mutation cannot change it', async ctx => {
  const w = makeWorld(ctx);
  let seen;
  w.store.overrides.insertAdmission = (result, record) => { seen = record; return result; };
  const raw = dispatch(1);
  const res = await w.admit(raw);
  assert.ok(res.ok);
  assert.ok(deepFrozen(seen), 'record not deep-frozen');
  assert.deepEqual(clone(seen), JSON.parse(JSON.stringify(seen)));
  const before = canon(clone(seen));
  raw.params.paths.push('src/evil'); raw.params.target.sid = 'evil';
  assert.throws(() => { 'use strict'; seen.command.params.paths.push('x'); });
  assert.equal(canon(clone(seen)), before);
  assert.equal(seen.request_sha256, ctx.C.canonicalDigest(seen.command));
  assert.equal(seen.card_sha256, sha(canon(clone(seen.card))));
  assert.equal(seen.principal.auth_session_id, USER.auth_session_id);
  assert.deepEqual(clone(w.store.get(key('admrec', res.receipt.command_id))), clone(seen));
});
T('P06', 'inv', 'raw mutated mid-transaction does not change admitted command or digest', async ctx => {
  const w = makeWorld(ctx);
  const raw = dispatch(1);
  w.store.hook = async name => { if (name === 'grant') { raw.params.paths[0] = 'lib/evil'; raw.params.role = 'admin'; } };
  const res = await w.admit(raw);
  assert.ok(res.ok, JSON.stringify(res.refusal));
  assert.equal(res.receipt.request_sha256, sha(canon(dispatch(1))));
  const rec = w.store.get(key('admrec', res.receipt.command_id));
  assert.deepEqual(rec.command.params.paths, ['src/a.ts']);
});

// ───────────────────────── AU: authentication / tenancy / role ─────────────────────────
T('AU01', 'inv', 'missing/forged/malformed principal => UNAUTHENTICATED before any store access', async ctx => {
  for (const p of [undefined, null, {}, { ...USER, extra: 1 }, { ...USER, kind: 'admin' }, { ...USER, user_id: '' }, { ...USER, user_id: 'u 1' }, JSON.stringify(USER)]) {
    const w = makeWorld(ctx);
    const res = await w.admit(dispatch(1), { ...w.trusted, principal: p });
    refusedWith(res, 'UNAUTHENTICATED');
    assert.equal(w.store.txCount, 0);
  }
});
T('AU02', 'inv', 'advisor principal never execution authority (POLICY_DENIED, no tx)', async ctx => {
  const w = makeWorld(ctx, { principal: { ...USER, kind: 'advisor' } });
  refusedWith(await w.admit(dispatch(1)), 'POLICY_DENIED');
  assert.equal(w.store.txCount, 0);
});
T('AU03', 'inv', 'recheck false at every recheck call (scope path and decision path) refuses and leaves no writes', async ctx => {
  for (const variant of ['scope', 'decision']) {
    const build = w => {
      if (variant === 'scope') return dispatch(1);
      const raw = dispatch(1, outside); w.decide(1, raw); raw.decision_id = did(1); return raw;
    };
    const probe = makeWorld(ctx);
    assert.ok((await probe.admit(build(probe))).ok);
    const calls = probe.auth.count;
    ctx.notes.push(`${variant}: recheck called ${calls}x on success`);
    assert.ok(calls >= 3);
    for (let k = 1; k <= calls; k++) {
      const w = makeWorld(ctx);
      const raw = build(w);
      const before = w.store.snapshot();
      w.auth.failAt.add(k);
      refusedWith(await w.admit(raw), 'UNAUTHENTICATED');
      assert.equal(w.store.snapshot(), before, `writes leaked at recheck ${k}`);
    }
  }
});
T('AU04', 'inv', 'recheck throwing / returning truthy non-true => UNAUTHENTICATED', async ctx => {
  for (const mode of ['throw', 'true', 1, {}, undefined]) {
    const w = makeWorld(ctx); w.auth.mode = mode;
    refusedWith(await w.admit(dispatch(1)), 'UNAUTHENTICATED');
    assert.equal(w.adm(), 0);
  }
});
T('AU05', 'inv', 'incomplete or throwing trusted context => TRUSTED_CONTEXT_INVALID; missing store => STORE_INVALID', async ctx => {
  const w = makeWorld(ctx);
  refusedWith(await w.admit(dispatch(1), { ...w.trusted, clock: {} }), 'TRUSTED_CONTEXT_INVALID');
  refusedWith(await w.admit(dispatch(1), { ...w.trusted, ids: null }), 'TRUSTED_CONTEXT_INVALID');
  const throwing = Object.defineProperty({ ...w.trusted }, 'principal', { get() { throw new Error('x'); } });
  refusedWith(await w.admit(dispatch(1), throwing), 'TRUSTED_CONTEXT_INVALID');
  refusedWith(await ctx.A.admitCommand(dispatch(1), w.trusted, {}), 'STORE_INVALID');
  refusedWith(await ctx.A.admitCommand(dispatch(1), w.trusted, null), 'STORE_INVALID');
});
T('AU06', 'inv', 'ungranted workspace / unenrolled runtime refused before any tenant read; no card', async ctx => {
  const w = makeWorld(ctx);
  w.store.put(key('grant', 'u1', WS), null);
  const res = await w.admit(dispatch(1, outside));
  refusedWith(res, 'FORBIDDEN'); assert.equal(res.refusal.card, null);
  assert.deepEqual(w.store.calls.map(c => c[2]), ['grant']);
  const w2 = makeWorld(ctx);
  w2.store.put(key('enrolled', WS, RT), false);
  const res2 = await w2.admit(dispatch(1, outside));
  refusedWith(res2, 'RUNTIME_NOT_ENROLLED'); assert.equal(res2.refusal.card, null);
  assert.deepEqual(w2.store.calls.map(c => c[2]), ['grant', 'runtimeEnrolled']);
  const w3 = makeWorld(ctx);
  const res3 = await w3.admit(dispatch(1, c => { c.workspace_id = 'ws2'; }));
  refusedWith(res3, 'FORBIDDEN');
});
T('AU07', 'inv', 'grant revoked or auth revoked at each store await (concurrent writer) => refused, nothing admitted', async ctx => {
  const probe = makeWorld(ctx);
  const raw0 = dispatch(1, outside); probe.decide(1, raw0); raw0.decision_id = did(1);
  assert.ok((await probe.admit(raw0)).ok);
  const methods = [...new Set(probe.store.calls.map(c => c[2]))];
  ctx.notes.push(`awaited store methods on decision path: ${methods.join(',')}`);
  for (const m of methods) {
    for (const what of ['grant', 'auth', 'enroll']) {
      const w = makeWorld(ctx);
      const raw = dispatch(1, outside); w.decide(1, raw); raw.decision_id = did(1);
      let fired = false;
      w.store.hook = async name => {
        if (name !== m || fired) return; fired = true;
        if (what === 'grant') w.store.put(key('grant', 'u1', WS), null);
        else if (what === 'enroll') w.store.put(key('enrolled', WS, RT), false);
        else w.auth.valid = false;
      };
      const res = await w.admit(raw);
      assert.equal(res.ok, false, `${what} revoked at ${m} still admitted`);
      assert.equal(res.refusal.code, { grant: 'FORBIDDEN', auth: 'UNAUTHENTICATED', enroll: 'RUNTIME_NOT_ENROLLED' }[what], `${what}@${m}`);
      assert.equal(w.adm(), 0); assert.equal(w.consumed(), 0);
    }
  }
});
T('AU08', 'inv', 'role policy: operator config.set, viewer anything => POLICY_DENIED even with valid decision', async ctx => {
  const w = makeWorld(ctx, { role: 'operator' });
  refusedWith(await w.admit(configCmd(1)), 'POLICY_DENIED');
  const v = makeWorld(ctx, { role: 'viewer' });
  refusedWith(await v.admit(dispatch(1)), 'POLICY_DENIED');
  const raw = dispatch(2, outside); v.decide(2, raw); raw.decision_id = did(2);
  refusedWith(await v.admit(raw), 'POLICY_DENIED');
  assert.equal(v.consumed(), 0);
});

// ───────────────────────── S: store rows ─────────────────────────
T('S01', 'inv', 'malformed / miskeyed store rows => STORE_INVALID with rollback (no writes)', async ctx => {
  const getterRow = () => { const o = {}; Object.defineProperty(o, 'role', { get() { throw new Error('getter invoked'); }, enumerable: true }); return o; };
  const cases = [
    ['grant', () => ({ role: 'root' })], ['grant', () => ({ role: 'owner', extra: 1 })], ['grant', () => 'owner'],
    ['grant', () => new Proxy({ role: 'owner' }, {})], ['grant', getterRow],
    ['runtimeEnrolled', () => 'yes'], ['runtimeEnrolled', () => 1],
    ['configRevision', () => -1], ['configRevision', () => 7.5], ['configRevision', () => '7'], ['configRevision', () => undefined],
    ['taskRevision', () => 'x'], ['taskRevision', () => NaN],
    ['scope', r => ({ ...r, record: { ...r.record, scope_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } })],
    ['scope', r => ({ ...r, record: { ...r.record, workspace_id: 'ws2' } })],
    ['scope', r => ({ ...r, record: { ...r.record, expires_at_ms: r.record.approved_at_ms } })],
    ['scope', r => ({ ...r, record: { ...r.record, unknown: 1 } })], ['scope', r => ({ record: r.record })],
    ['decision', r => ({ ...r, record: { ...r.record, decision_id: did(77) } })],
    ['decision', r => ({ ...r, record: { ...r.record, expires_at_ms: r.record.issued_at_ms + 120_001 } })],
    ['decision', r => ({ ...r, record: { ...r.record, verification: 'self_asserted' } })],
    ['decision', r => ({ ...r, consumed: 'no' })],
    ['consumeDecision', () => 'ok'], ['consumeDecision', () => true],
    ['insertAdmission', () => true], ['insertAdmission', () => 'ok'],
  ];
  for (const [method, fn] of cases) {
    const w = makeWorld(ctx);
    const raw = dispatch(1, outside); w.decide(1, raw); raw.decision_id = did(1);
    const before = w.store.snapshot();
    w.store.overrides[method] = fn;
    const res = await w.admit(raw);
    refusedWith(res, 'STORE_INVALID');
    assert.equal(w.store.snapshot(), before, `${method} leaked writes`);
  }
});
T('S02', 'inv', 'malformed/miskeyed stored admission rows => STORE_INVALID, never replayed', async ctx => {
  const mutations = [
    r => { r.receipt.idem_key = idem(99); }, r => { r.capability.msg_id = r.capability.cap_id; },
    r => { r.capability.cap_id = r.receipt.msg_id; }, r => { r.capability.workspace_id = 'ws2'; },
    r => { r.capability.op = 'config.set'; }, r => { r.receipt.request_sha256 = '0'.repeat(64); },
    r => { r.capability.state = 'used'; }, r => { r.receipt.commit = 'durable'; }, r => { r.extra = 1; },
  ];
  for (const m of mutations) {
    const w = makeWorld(ctx);
    assert.ok((await w.admit(dispatch(1))).ok);
    w.store.overrides.admission = r => { if (r === null) return r; const c = clone(r); m(c); return c; };
    const res = await w.admit(dispatch(1));
    assert.equal(res.ok, false);
    assert.ok(['STORE_INVALID', 'CONFLICT'].includes(res.refusal.code), res.refusal.code);
  }
});
T('S03', 'inv', 'store method throwing => STORE_ROLLED_BACK (fake honours rollback), no writes', async ctx => {
  for (const m of ['grant', 'scope', 'decision', 'consumeDecision', 'insertAdmission']) {
    const w = makeWorld(ctx);
    const raw = dispatch(1, outside); w.decide(1, raw); raw.decision_id = did(1);
    const before = w.store.snapshot();
    w.store.overrides[m] = () => { throw new Error('io'); };
    refusedWith(await w.admit(raw), 'STORE_ROLLED_BACK');
    assert.equal(w.store.snapshot(), before, m);
  }
});

// ───────────────────────── CI: trusted clock / ids / expiry ─────────────────────────
T('CI01', 'inv', 'clock regression / invalid clock values => TRUSTED_CONTEXT_INVALID', async ctx => {
  for (const seq of [[T0, T0 - 1], [NaN], [1.5], [-5], ['1'], [T0, undefined]]) {
    const w = makeWorld(ctx); w.clock.seq = [...seq];
    refusedWith(await w.admit(dispatch(1)), 'TRUSTED_CONTEXT_INVALID');
    assert.equal(w.adm(), 0);
  }
  const w = makeWorld(ctx); w.clock.nowMs = () => { throw new Error('ntp'); };
  refusedWith(await w.admit(dispatch(1)), 'TRUSTED_CONTEXT_INVALID');
});
T('CI02', 'inv', 'command expiry: expired, over-long TTL, expiry crossing between reads', async ctx => {
  const w = makeWorld(ctx);
  refusedWith(await w.admit(dispatch(1, c => { c.expires_at_ms = T0; })), 'EXPIRED');
  refusedWith(await w.admit(dispatch(2, c => { c.expires_at_ms = T0 + 15 * 60_000 + 1; })), 'INVALID_VALUE');
  assert.ok((await w.admit(dispatch(3, c => { c.expires_at_ms = T0 + 15 * 60_000; }))).ok);
  const w2 = makeWorld(ctx); w2.clock.seq = [T0, T0 + 60_000];
  refusedWith(await w2.admit(dispatch(4)), 'EXPIRED');
  assert.equal(w2.adm(), 0);
});
T('CI03', 'inv', 'id allocator invalid/uppercase/repeated-within-command => TRUSTED_CONTEXT_INVALID', async ctx => {
  for (const fixed of [['not-a-uuid'], ['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'], ['00000000-0000-4000-8000-00000000abcd'],
    ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a1']]) {
    const w = makeWorld(ctx); w.trusted.ids = makeIds(fixed);
    refusedWith(await w.admit(dispatch(1)), 'TRUSTED_CONTEXT_INVALID');
    assert.equal(w.adm(), 0);
  }
});
T('CI04', 'inv', 'ID collision across admissions: a repeated trusted allocator must not yield two receipts sharing msg_id/cap_id', async ctx => {
  const w = makeWorld(ctx);
  w.trusted.ids = makeIds(['00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000b3']);
  const a = await w.admit(dispatch(1));
  const b = await w.admit(dispatch(2));
  ctx.notes.push(`first ok=${a.ok}; second ok=${b.ok}${b.ok ? ` msg_id equal=${a.receipt.msg_id === b.receipt.msg_id} cap_id equal=${a.capability.cap_id === b.capability.cap_id}` : ` code=${b.refusal.code}`}`);
  assert.ok(a.ok);
  assert.ok(!b.ok || (b.receipt.msg_id !== a.receipt.msg_id && b.capability.cap_id !== a.capability.cap_id),
    'two distinct commands were admitted with the same msg_id/cap_id/command_id');
  // cf1182ub C4: the store detects the clash and the core refuses explicitly; nothing is committed.
  refusedWith(b, 'TRUSTED_CONTEXT_INVALID', 'id_collision');
  assert.equal(w.adm(), 1);
});
T('CI04b', 'inv', 'global id collision on each of command_id/cap_id/msg_id, same user, other user, other workspace: refused, no writes; fresh ids then admit', async ctx => {
  const seen = [];
  for (const who of ['same', 'other-user', 'other-workspace']) {
    for (const pos of [0, 1, 2]) {
      const w = makeWorld(ctx);
      w.store.put(key('grant', 'u2', WS), { role: 'owner' });
      w.store.put(key('grant', 'u1', 'ws2'), { role: 'owner' });
      w.store.put(key('enrolled', 'ws2', RT), true);
      w.store.put(key('config_rev', 'ws2', RT), CFG_REV);
      w.store.put(key('task_rev', 'ws2', TASK), TASK_REV);
      w.store.put(key('scope', 'ws2', SCOPE_ID), { record: scopeRecord({ workspace_id: 'ws2' }), revoked: false });
      w.trusted.ids = makeIds(ID_A);
      assert.ok((await w.admit(dispatch(1))).ok);
      const ids = freshIds(); ids[pos] = ID_A[pos];
      const t = { ...w.trusted, ids: makeIds(ids), principal: who === 'other-user' ? { ...USER, user_id: 'u2' } : USER };
      const raw = dispatch(2, c => { if (who === 'other-workspace') c.workspace_id = 'ws2'; });
      const snap = w.store.snapshot();
      const res = await w.admit(raw, t);
      refusedWith(res, 'TRUSTED_CONTEXT_INVALID', 'id_collision');
      assert.equal(w.store.snapshot(), snap, `${who}/${pos} wrote on collision`);
      const again = await w.admit(raw, { ...t, ids: makeIds(freshIds()) });
      assert.ok(again.ok && !again.replayed, `${who}/${pos} retry with fresh ids: ${JSON.stringify(again.refusal ?? null)}`);
      seen.push(`${who}:${['command_id', 'cap_id', 'msg_id'][pos]}=${res.refusal.code}`);
    }
  }
  ctx.notes.push(seen.join(' '));
});
T('CI04c', 'inv', 'id collision rolls back decision consumption and slot reservation; reserve-level and cross-scope collisions', async ctx => {
  const results = [];
  const w = makeWorld(ctx, { scope: { caps: { max_workers: 5 } } });
  w.store.overrides.reserveScopeSlot = r => { results.push(`reserve:${r}`); return r; };
  w.store.overrides.insertAdmission = r => { results.push(`insert:${r}`); return r; };
  w.trusted.ids = makeIds(ID_A);
  assert.ok((await w.admit(dispatch(1))).ok);
  assert.equal(resv(w.store), 1);
  // decision path, msg_id collides at insert after reserve + consume
  const raw = dispatch(2, outside); w.decide(2, raw); raw.decision_id = did(2);
  const ids = freshIds(); ids[2] = ID_A[2];
  let snap = w.store.snapshot();
  refusedWith(await w.admit(raw, { ...w.trusted, ids: makeIds(ids) }), 'TRUSTED_CONTEXT_INVALID', 'id_collision');
  assert.equal(w.store.snapshot(), snap); assert.equal(w.consumed(), 0); assert.equal(resv(w.store), 1);
  assert.deepEqual(results.slice(-2), ['reserve:reserved', 'insert:id_collision']);
  const ok = await w.admit(raw, { ...w.trusted, ids: makeIds(freshIds()) });
  assert.ok(ok.ok, JSON.stringify(ok.refusal ?? null)); assert.equal(w.consumed(), 1); assert.equal(resv(w.store), 2);
  // same scope: command_id collides at the reservation key
  const ids2 = freshIds(); ids2[0] = ID_A[0];
  snap = w.store.snapshot();
  refusedWith(await w.admit(dispatch(3), { ...w.trusted, ids: makeIds(ids2) }), 'TRUSTED_CONTEXT_INVALID', 'id_collision');
  assert.equal(results.at(-1), 'reserve:id_collision'); assert.equal(w.store.snapshot(), snap);
  // another scope: the reservation key differs, insert catches the global command_id and the reservation rolls back
  const S2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  w.store.put(key('scope', WS, S2), { record: scopeRecord({ scope_id: S2, caps: { max_workers: 5 } }), revoked: false });
  snap = w.store.snapshot();
  refusedWith(await w.admit(dispatch(4, c => { c.scope_id = S2; }), { ...w.trusted, ids: makeIds(ids2) }), 'TRUSTED_CONTEXT_INVALID', 'id_collision');
  assert.deepEqual(results.slice(-2), ['reserve:reserved', 'insert:id_collision']);
  assert.equal(resv(w.store, S2), 0); assert.equal(w.store.snapshot(), snap);
  ctx.notes.push(results.join(','));
});
T('CI05', 'inv', 'capability not_after = min(now+10min, command expiry, scope expiry)', async ctx => {
  const w = makeWorld(ctx, { scope: { expires_at_ms: T0 + 5 * 60_000 } });
  const a = await w.admit(dispatch(1, c => { c.expires_at_ms = T0 + 14 * 60_000; }));
  assert.equal(a.capability.not_after_ms, T0 + 5 * 60_000);
  const w2 = makeWorld(ctx);
  const b = await w2.admit(dispatch(2, c => { c.expires_at_ms = T0 + 14 * 60_000; }));
  assert.equal(b.capability.not_after_ms, T0 + 10 * 60_000);
});
T('CI06', 'inv', 'scope not yet active / expired / expiring between clock reads => SCOPE_EXCEEDED', async ctx => {
  refusedWith(await makeWorld(ctx, { scope: { approved_at_ms: T0 + 1, expires_at_ms: T0 + 100_000 } }).admit(dispatch(1)), 'SCOPE_EXCEEDED', 'scope_not_yet_active');
  refusedWith(await makeWorld(ctx, { scope: { approved_at_ms: T0 - 100, expires_at_ms: T0 } }).admit(dispatch(1)), 'SCOPE_EXCEEDED', 'scope_expired');
  const w = makeWorld(ctx, { scope: { expires_at_ms: T0 + 10 } }); w.clock.seq = [T0, T0 + 10];
  refusedWith(await w.admit(dispatch(1)), 'SCOPE_EXCEEDED', 'scope_expired');
  assert.equal(w.adm(), 0);
});

// ───────────────────────── R: source revision CAS ─────────────────────────
T('R01', 'inv', 'stale config_rev / task_rev => STALE_REV; absent task => NOT_FOUND; absent scope => NOT_FOUND', async ctx => {
  const w = makeWorld(ctx);
  refusedWith(await w.admit(dispatch(1, c => { c.expected.config_rev = 6; })), 'STALE_REV');
  refusedWith(await w.admit(dispatch(2, c => { c.task_rev = 4; })), 'STALE_REV');
  refusedWith(await w.admit(configCmd(3, c => { c.expected.config_rev = 8; })), 'STALE_REV');
  refusedWith(await w.admit(dispatch(4, c => { c.task_id = 'task-404'; })), 'NOT_FOUND');
  refusedWith(await w.admit(dispatch(5, c => { c.scope_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; })), 'NOT_FOUND');
  const w2 = makeWorld(ctx);
  w2.store.hook = async name => { if (name === 'scope') w2.store.put(key('task_rev', WS, TASK), TASK_REV + 1); };
  refusedWith(await w2.admit(dispatch(6)), 'STALE_REV');
  assert.equal(w2.adm(), 0);
});
T('R02', 'inv', 'every command task-bound: config.set must carry/bind a task (dispatch flag reading of approved contract)', async ctx => {
  const withTask = ctx.C.validateCommand(configCmd(1, c => { c.task_id = TASK; c.task_rev = TASK_REV; }));
  const w = makeWorld(ctx);
  const res = await w.admit(configCmd(2));
  ctx.notes.push(`config.set with task_id/task_rev: ${withTask.ok ? 'accepted' : withTask.refusal.code}; config.set without task admitted: ${res.ok}; card.task=${JSON.stringify(res.ok ? null : res.refusal.card?.card.task)}`);
  assert.ok(withTask.ok || !res.ok, 'config.set cannot bind a task yet is admitted with no task binding');
  // cf1182ub C3: config.set requires and binds task_id/task_rev exactly like dispatch.start.
  assert.ok(withTask.ok); assert.ok(res.ok, JSON.stringify(res.refusal ?? null));
  for (const f of ['task_id', 'task_rev']) assert.equal(ctx.C.validateCommand(configCmd(3, c => { delete c[f]; })).ok, false, f);
  refusedWith(await w.admit(configCmd(4, c => { c.task_id = 'task-404'; })), 'NOT_FOUND');
  refusedWith(await w.admit(configCmd(5, c => { c.task_rev = TASK_REV - 1; })), 'STALE_REV');
  w.store.put(key('task_rev', WS, 'task-2'), TASK_REV);
  const out = await w.admit(configCmd(6, c => { c.task_id = 'task-2'; }));
  refusedWith(out, 'SCOPE_EXCEEDED', 'task_outside_scope');
  assert.deepEqual(clone(out.refusal.card.card.task), { id: 'task-2', rev: TASK_REV });
  assert.equal(out.refusal.card.card.subject.task_id, 'task-2'); assert.equal(out.refusal.card.card.subject.task_rev, TASK_REV);
  assert.ok(out.refusal.card.card.consequences.some(s => s.includes('task-2')), 'config.set consequences name the task');
  const w2 = makeWorld(ctx);
  w2.store.hook = async name => { if (name === 'scope') w2.store.put(key('task_rev', WS, TASK), TASK_REV + 1); };
  refusedWith(await w2.admit(configCmd(7)), 'STALE_REV');
  assert.equal(w2.adm(), 0); assert.equal(w.adm(), 1);
});
T('R02b', 'inv', 'both ops: decision subject binds task identity and revision (other task with same rev, stale rev); task missing refused', async ctx => {
  const variants = [['dispatch.start', n => dispatch(n, outside)], ['config.set', n => configCmd(n, c => { c.params.effort = 'max'; })]];
  for (const [name, make] of variants) {
    {
      const w = makeWorld(ctx);
      const raw = make(1); w.decide(1, raw); raw.decision_id = did(1);
      const r = await w.admit(raw);
      assert.ok(r.ok, `${name} positive control: ${JSON.stringify(r.refusal ?? null)}`); assert.equal(w.consumed(), 1);
    }
    {
      const w = makeWorld(ctx);
      w.store.put(key('task_rev', WS, 'task-2'), TASK_REV);
      const approved = make(1); approved.task_id = 'task-2'; w.decide(1, approved);
      const raw = make(1); raw.decision_id = did(1);
      refusedWith(await w.admit(raw), 'DECISION_REQUIRED', 'decision_subject_mismatch');
      assert.equal(w.consumed(), 0, name);
    }
    {
      const w = makeWorld(ctx);
      const raw = make(1); w.decide(1, raw); raw.decision_id = did(1);
      w.store.put(key('task_rev', WS, TASK), TASK_REV + 1);
      refusedWith(await w.admit(raw), 'STALE_REV');
      const bumped = make(1); bumped.task_rev = TASK_REV + 1; bumped.decision_id = did(1);
      refusedWith(await w.admit(bumped), 'DECISION_REQUIRED', 'decision_subject_mismatch');
      assert.equal(w.consumed(), 0, name);
    }
    {
      const w = makeWorld(ctx);
      const raw = make(1); w.decide(1, raw); raw.decision_id = did(1);
      w.store.put(key('task_rev', WS, TASK), null);
      refusedWith(await w.admit(raw), 'NOT_FOUND');
      assert.equal(w.consumed(), 0, name);
    }
  }
});
T('R03', 'obs', 'competing commands at the same source revision are all admitted (admission does not bump revisions)', async ctx => {
  const w = makeWorld(ctx);
  const cfg = await Promise.all([1, 2, 3].map(n => w.admit(configCmd(n, c => { c.params.effort = ['low', 'medium', 'high'][n - 1]; }))));
  const w2 = makeWorld(ctx, { scope: { models: ['low', 'medium', 'high'].map(effort => ({ cli: 'claude', model: 'opus-5-5', effort })) } });
  const okCfg = (await Promise.all([1, 2, 3].map(n => w2.admit(configCmd(n, c => { c.params.effort = ['low', 'medium', 'high'][n - 1]; }))))).filter(r => r.ok).length;
  const w3 = makeWorld(ctx);
  const sameAttempt = await Promise.all([1, 2, 3].map(n => w3.admit(dispatch(n, c => { c.attempt = att(1); }))));
  const caps = new Set(sameAttempt.filter(r => r.ok).map(r => r.capability.cap_id));
  ctx.notes.push(`3 config.set @config_rev ${CFG_REV} with distinct values (models in scope): ${okCfg}/3 admitted; first world (one model in scope) ${cfg.filter(r => r.ok).length}/3`);
  ctx.notes.push(`3 dispatch.start same task/task_rev/attempt, distinct idem: ${sameAttempt.filter(r => r.ok).length}/3 admitted, ${caps.size} distinct capabilities`);
});

// ───────────────────────── SC: scope coverage ─────────────────────────
T('SC01', 'inv', 'each out-of-scope dimension without decision => SCOPE_EXCEEDED with reason and card', async ctx => {
  const cases = [
    [dispatch(1, c => { c.task_id = 'task-2'; }), 'task_outside_scope', w => w.store.put(key('task_rev', WS, 'task-2'), TASK_REV)],
    [dispatch(2, c => { c.params.paths = ['src/a.ts', 'lib/b.ts']; }), 'path_outside_scope'],
    [dispatch(3, c => { c.params.paths = ['srcx/a.ts']; }), 'path_outside_scope'],
    [dispatch(4, c => { c.params.paths = ['docs/apix']; }), 'path_outside_scope'],
    [dispatch(5, c => { c.params.paths = ['docs']; }), 'path_outside_scope'],
    [dispatch(6, c => { c.params.paths = ['SRC/a.ts']; }), 'path_outside_scope'],
    [dispatch(7, c => { c.params.cli = 'codex'; }), 'model_outside_scope'],
    [dispatch(8, c => { c.params.model = 'opus-5-6'; }), 'model_outside_scope'],
    [dispatch(9, c => { c.params.effort = 'max'; }), 'model_outside_scope'],
    [configCmd(10, c => { c.params.effort = 'max'; }), 'model_outside_scope'],
  ];
  for (const [raw, reason, setup] of cases) {
    const w = makeWorld(ctx); if (setup) setup(w);
    const res = await w.admit(raw);
    refusedWith(res, 'SCOPE_EXCEEDED', reason);
    assert.ok(res.refusal.card && /^[0-9a-f]{64}$/.test(res.refusal.card.card_sha256));
    assert.equal(w.adm(), 0);
  }
  refusedWith(await makeWorld(ctx, { scope: { ops: ['config.set'] } }).admit(dispatch(11)), 'SCOPE_EXCEEDED', 'operation_outside_scope');
  refusedWith(await makeWorld(ctx, { scope: { config_settings: ['role.launch'] } }).admit(configCmd(12, c => { c.params = { setting: 'advisor.enabled', enabled: false }; })), 'SCOPE_EXCEEDED', 'setting_outside_scope');
  assert.ok((await makeWorld(ctx).admit(dispatch(13, c => { c.params.paths = ['src', 'docs/api/v1/x.md']; }))).ok);
});
T('SC02', 'inv', 'hard limits refused even with a valid approving decision (caps, loop, revoked, runtime)', async ctx => {
  const cases = [
    [{ caps: { max_waves: 2 } }, c => { c.params.wave = 3; }, 'max_waves'],
    [{ caps: { max_workers: 2 } }, () => {}, 'max_workers', w => w.store.put(key('usage', WS, SCOPE_ID), { active_workers: 2, spent: null })],
    // cf1182ub C2: spend-limited dispatch is an explicit unsupported refusal (NOT cost control).
    [{ caps: { spend_ceiling: { unit: 'usd_cents', amount: 500 } } }, () => {}, 'spend_reservation_unavailable', w => w.store.put(key('usage', WS, SCOPE_ID), { active_workers: 0, spent: { unit: 'usd_cents', amount: 500 } })],
    [{ caps: { spend_ceiling: { unit: 'usd_cents', amount: 500 } } }, () => {}, 'spend_reservation_unavailable'],
    [{ caps: { spend_ceiling: { unit: 'usd_cents', amount: 500 } } }, () => {}, 'spend_reservation_unavailable', w => w.store.put(key('usage', WS, SCOPE_ID), { active_workers: 0, spent: { unit: 'tokens', amount: 1 } })],
    [{}, c => { c.params.loop = true; }, 'loop_not_enabled_by_scope'],
    [{ runtime_id: 'rt2' }, () => {}, 'scope_runtime_mismatch'],
  ];
  for (const [scope, edit, reason, setup] of cases) {
    for (const withDecision of [false, true]) {
      const w = makeWorld(ctx, { scope }); if (setup) setup(w);
      const raw = dispatch(1, edit);
      if (withDecision) { w.decide(1, raw); raw.decision_id = did(1); }
      refusedWith(await w.admit(raw), 'SCOPE_EXCEEDED', reason);
      assert.equal(w.adm(), 0); assert.equal(w.consumed(), 0);
    }
  }
  const w = makeWorld(ctx);
  w.store.put(key('scope', WS, SCOPE_ID), { record: scopeRecord(), revoked: true });
  refusedWith(await w.admit(dispatch(1)), 'SCOPE_EXCEEDED', 'scope_revoked');
  const ok = makeWorld(ctx, { scope: { caps: { max_waves: 2, max_workers: 2, spend_ceiling: { unit: 'usd_cents', amount: 500 } } } });
  ok.store.put(key('usage', WS, SCOPE_ID), { active_workers: 1, spent: { unit: 'usd_cents', amount: 499 } });
  // cf1182ub C2: under-ceiling spend is no longer admitted; the refusal is unsupported spend-limited dispatch.
  refusedWith(await ok.admit(dispatch(2, c => { c.params.wave = 2; })), 'SCOPE_EXCEEDED', 'spend_reservation_unavailable');
  assert.equal(ok.adm(), 0);
  const ok2 = makeWorld(ctx, { scope: { caps: { max_waves: 2, max_workers: 2 } } });
  ok2.store.put(key('usage', WS, SCOPE_ID), { active_workers: 1, spent: null });
  assert.ok((await ok2.admit(dispatch(2, c => { c.params.wave = 2; }))).ok, 'within user caps should admit');
});
T('SC03', 'inv', 'loop only when scope enables it; never by default', async ctx => {
  assert.ok((await makeWorld(ctx, { scope: { loop: true } }).admit(dispatch(1, c => { c.params.loop = true; }))).ok);
  const r = ctx.C.validateScopeRecord((({ loop, ...rest }) => rest)(scopeRecord()));
  assert.equal(r.ok, false, 'scope without explicit loop must not default to true');
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { delete c.params.loop; })).ok, false);
});
T('SC04', 'inv', 'scope binds target sid and role: substituting role/target outside what was approved needs a decision', async ctx => {
  const w = makeWorld(ctx);
  const a = await w.admit(dispatch(1, c => { c.params.role = 'release-manager'; c.params.target.sid = 'prod-deployer'; }));
  const b = await w.admit(configCmd(2, c => { c.params.role = 'orchestrator'; }));
  const fields = Object.keys(scopeRecord());
  ctx.notes.push(`scope record fields: ${fields.join(',')}`);
  ctx.notes.push(`dispatch with substituted role+target admitted w/o decision: ${a.ok}; config.set role.launch for arbitrary role admitted: ${b.ok}`);
  assert.ok(!a.ok && !b.ok, 'role/target substitution admitted under scope autonomy with no decision');
  // cf1182ub C1: soft scope reasons, with card.
  refusedWith(a, 'SCOPE_EXCEEDED', 'role_outside_scope'); refusedWith(a, 'SCOPE_EXCEEDED', 'target_outside_scope');
  refusedWith(b, 'SCOPE_EXCEEDED', 'role_outside_scope');
  assert.ok(a.refusal.card && b.refusal.card); assert.equal(w.adm(), 0);
});
T('SC04b', 'inv', 'namespace boundary: exact role; sid === prefix or prefix+"-" only (cf1 never covers cf10); empty lists deny; controller composes workers with no per-worker decision', async ctx => {
  const w = makeWorld(ctx, { scope: { roles: ['coder', 'reviewer'], target_prefixes: ['cf1', 'team-a'] }, principal: { ...USER, kind: 'controller' } });
  let n = 0;
  const covered = [['cf1', 'coder'], ['cf1-coder', 'coder'], ['cf1-coder-2', 'reviewer'], ['cf1--x', 'coder'], ['team-a', 'reviewer'], ['team-a-7', 'coder']];
  for (const [sid, role] of covered) {
    const r = await w.admit(dispatch(++n, c => { c.params.target.sid = sid; c.params.role = role; }));
    assert.ok(r.ok, `${sid}/${role}: ${JSON.stringify(r.refusal ?? null)}`);
  }
  assert.equal(w.consumed(), 0); assert.equal(w.store.keys('decision').length, 0);
  for (const sid of ['cf10', 'cf1x', 'cf1_coder', 'cf', 'CF1-coder', 'xcf1-coder', 'cf10-coder', 'team', 'team-ab', 'team-a_1']) {
    const r = await w.admit(dispatch(++n, c => { c.params.target.sid = sid; }));
    refusedWith(r, 'SCOPE_EXCEEDED', 'target_outside_scope');
    assert.ok(!r.refusal.reasons.includes('role_outside_scope'), sid);
  }
  const wo = makeWorld(ctx, { scope: { roles: ['coder', 'reviewer'], target_prefixes: ['cf1'] } });
  for (const role of ['coder2', 'Coder', 'code', 'reviewer-x', 'orchestrator']) {
    refusedWith(await wo.admit(dispatch(++n, c => { c.params.target.sid = 'cf1-w'; c.params.role = role; })), 'SCOPE_EXCEEDED', 'role_outside_scope');
    refusedWith(await wo.admit(configCmd(++n, c => { c.params.role = role; })), 'SCOPE_EXCEEDED', 'role_outside_scope');
  }
  assert.ok((await wo.admit(configCmd(++n, c => { c.params.role = 'reviewer'; }))).ok, 'config.set role.launch for a scoped role');
  const e1 = makeWorld(ctx, { scope: { roles: [] } });
  refusedWith(await e1.admit(dispatch(1)), 'SCOPE_EXCEEDED', 'role_outside_scope');
  refusedWith(await e1.admit(configCmd(2)), 'SCOPE_EXCEEDED', 'role_outside_scope');
  assert.ok((await e1.admit(configCmd(3, c => { c.params = { setting: 'advisor.enabled', enabled: true }; }))).ok, 'advisor.enabled names no role');
  const e2 = makeWorld(ctx, { scope: { target_prefixes: [] } });
  refusedWith(await e2.admit(dispatch(1)), 'SCOPE_EXCEEDED', 'target_outside_scope');
  assert.equal(e2.adm(), 0);
  ctx.notes.push(`covered by ['cf1','team-a']: ${covered.map(c => c[0]).join(',')} ('cf1--x' is covered: grammar allows '-' runs)`);
});
T('SC04c', 'inv', 'exact verified decision covers soft role/target outside scope; never hard caps/loop/spend/runtime/revocation; card binds roles/target_prefixes', async ctx => {
  const out = c => { c.params.role = 'release-manager'; c.params.target.sid = 'cf10'; };
  const w = makeWorld(ctx);
  const raw = dispatch(1, out); const { view } = w.decide(1, raw); raw.decision_id = did(1);
  assert.deepEqual(clone(view.card.scope.roles), ['coder']); assert.deepEqual(clone(view.card.scope.target_prefixes), ['worker']);
  const r = await w.admit(raw);
  assert.ok(r.ok, JSON.stringify(r.refusal ?? null)); assert.equal(w.consumed(), 1);
  const w1 = makeWorld(ctx);
  w1.decide(1, dispatch(1, out));
  refusedWith(await w1.admit(dispatch(1, c => { out(c); c.params.target.sid = 'cf11'; c.decision_id = did(1); })), 'DECISION_REQUIRED', 'decision_card_mismatch');
  assert.equal(w1.consumed(), 0);
  for (const over of [{ target_prefixes: ['worker', 'cf10'] }, { roles: ['coder', 'release-manager'] }]) {
    const w2 = makeWorld(ctx);
    const raw2 = dispatch(1, out); w2.decide(1, raw2); raw2.decision_id = did(1);
    w2.store.put(key('scope', WS, SCOPE_ID), { record: scopeRecord(over), revoked: false });
    refusedWith(await w2.admit(raw2), 'DECISION_REQUIRED', 'decision_card_mismatch');
    assert.equal(w2.consumed(), 0);
  }
  const hard = [
    [{ caps: { max_workers: 1 } }, () => {}, 'max_workers', async wh => { assert.ok((await wh.admit(dispatch(9))).ok); }],
    [{}, c => { c.params.loop = true; }, 'loop_not_enabled_by_scope'],
    [{ caps: { spend_ceiling: { unit: 'usd_cents', amount: 500 } } }, () => {}, 'spend_reservation_unavailable'],
    [{ runtime_id: 'rt2' }, () => {}, 'scope_runtime_mismatch'],
    [{}, () => {}, 'scope_revoked', async wh => { wh.store.put(key('scope', WS, SCOPE_ID), { record: scopeRecord(), revoked: true }); }],
  ];
  for (const [scope, edit, reason, setup] of hard) {
    const wh = makeWorld(ctx, { scope });
    if (setup) await setup(wh);
    const rr = dispatch(1, c => { out(c); edit(c); }); wh.decide(1, rr); rr.decision_id = did(1);
    refusedWith(await wh.admit(rr), 'SCOPE_EXCEEDED', reason);
    assert.equal(wh.consumed(), 0, reason);
  }
});
T('SC05', 'inv', 'user cap max_workers=1 holds under concurrent and sequential admissions (usage reservation)', async ctx => {
  const w = makeWorld(ctx, { scope: { caps: { max_workers: 1 } } });
  const conc = await Promise.all([1, 2, 3].map(n => w.admit(dispatch(n))));
  const w2 = makeWorld(ctx, { scope: { caps: { max_workers: 1 } } });
  const seq = []; for (const n of [1, 2, 3]) seq.push(await w2.admit(dispatch(n)));
  const w3 = makeWorld(ctx, { scope: { caps: { spend_ceiling: { unit: 'usd_cents', amount: 100 } } } });
  w3.store.put(key('usage', WS, SCOPE_ID), { active_workers: 0, spent: { unit: 'usd_cents', amount: 99 } });
  const spend = []; for (const n of [1, 2, 3]) spend.push(await w3.admit(dispatch(n)));
  const w4 = makeWorld(ctx, { scope: { caps: { max_workers: 1 } } });
  w4.store.ssiRetryOnStaleAbort = false; w4.store.snapshotReads = true;
  const snapConc = await Promise.all([1, 2, 3].map(n => w4.admit(dispatch(n))));
  const count = rs => rs.filter(r => r.ok).length;
  ctx.notes.push(`max_workers=1: concurrent ${count(conc)}/3 admitted, sequential ${count(seq)}/3 admitted, concurrent snapshot/no-SSI-rerun store ${count(snapConc)}/3; spend 99/100: ${count(spend)}/3 admitted (${spend.map(r => r.ok ? 'ok' : r.refusal.reasons.join('+')).join(',')})`);
  assert.ok(count(conc) <= 1 && count(seq) <= 1, 'more capabilities issued than the user-set max_workers cap');
  // cf1182ub C2: exactly one slot (not refuse-all), refusals are the hard max_workers cap, one reservation row.
  assert.equal(count(conc), 1); assert.equal(count(seq), 1); assert.equal(count(snapConc), 1);
  for (const r of [...conc, ...seq, ...snapConc].filter(x => !x.ok)) {
    assert.equal(r.refusal.code, 'SCOPE_EXCEEDED'); assert.deepEqual([...r.refusal.reasons], ['max_workers']);
  }
  assert.equal(resv(w.store), 1); assert.equal(resv(w2.store), 1); assert.equal(resv(w4.store), 1);
  // Spend-limited dispatch is an explicit unsupported refusal: NOT successful cost control.
  assert.equal(count(spend), 0);
  for (const r of spend) refusedWith(r, 'SCOPE_EXCEEDED', 'spend_reservation_unavailable');
});
T('SC05b', 'inv', 'max_workers reservation: replay reserves nothing, no decision override, active+live reservations counted, lapse only on trusted time, config.set free', async ctx => {
  const w = makeWorld(ctx, { scope: { caps: { max_workers: 1 } } });
  const a = await w.admit(dispatch(1));
  assert.ok(a.ok);
  assert.deepEqual(w.store.get(key('resv', WS, SCOPE_ID, a.receipt.command_id)), {
    workspace_id: WS, scope_id: SCOPE_ID, command_id: a.receipt.command_id, max_workers: 1, reserved_at_ms: T0, not_after_ms: a.capability.not_after_ms,
  });
  const reserves = callsOf(w.store, 'reserveScopeSlot');
  const replay = await w.admit(dispatch(1));
  assert.equal(replay.replayed, true); assert.equal(callsOf(w.store, 'reserveScopeSlot'), reserves); assert.equal(resv(w.store), 1);
  const raw = dispatch(2, outside); w.decide(2, raw); raw.decision_id = did(2);
  refusedWith(await w.admit(raw), 'SCOPE_EXCEEDED', 'max_workers'); assert.equal(w.consumed(), 0);
  w.clock.t = a.capability.not_after_ms - 1;
  for (const [n, edit] of [[3, c => { c.params.wave = 7; }], [4, c => { c.expires_at_ms = w.clock.t + 1; }], [5, () => {}]]) {
    refusedWith(await w.admit(dispatch(n, c => { c.expires_at_ms = w.clock.t + 60_000; edit(c); })), 'SCOPE_EXCEEDED', 'max_workers');
  }
  w.clock.t = a.capability.not_after_ms;
  const b = await w.admit(dispatch(6, c => { c.expires_at_ms = w.clock.t + 60_000; }));
  assert.ok(b.ok, `slot must lapse at trusted not_after: ${JSON.stringify(b.refusal ?? null)}`);
  refusedWith(await w.admit(dispatch(7, c => { c.expires_at_ms = w.clock.t + 60_000; })), 'SCOPE_EXCEEDED', 'max_workers');
  const before = callsOf(w.store, 'reserveScopeSlot');
  const cfg = await w.admit(configCmd(8, c => { c.expires_at_ms = w.clock.t + 60_000; }));
  assert.ok(cfg.ok, `config.set is free under a full worker cap: ${JSON.stringify(cfg.refusal ?? null)}`);
  assert.equal(callsOf(w.store, 'reserveScopeSlot'), before, 'config.set reserved a worker slot');
  const w2 = makeWorld(ctx, { scope: { caps: { max_workers: 2 } } });
  w2.store.put(key('usage', WS, SCOPE_ID), { active_workers: 1, spent: null });
  assert.ok((await w2.admit(dispatch(1))).ok);
  const r2 = callsOf(w2.store, 'reserveScopeSlot');
  refusedWith(await w2.admit(dispatch(2)), 'SCOPE_EXCEEDED', 'max_workers');
  assert.ok(callsOf(w2.store, 'reserveScopeSlot') > r2, 'refused by the atomic reservation, not only the usage pre-check');
  const w3 = makeWorld(ctx, { scope: { caps: { max_workers: 1, spend_ceiling: { unit: 'usd_cents', amount: 1 } } } });
  assert.ok((await w3.admit(configCmd(1))).ok, 'spend refusal is not generalized to config.set');
  assert.ok((await w3.admit(configCmd(2, c => { c.params.effort = 'medium'; c.expected.config_rev = CFG_REV; c.idem_key = idem(3); }))).ok);
  assert.equal(callsOf(w3.store, 'reserveScopeSlot'), 0); assert.equal(callsOf(w3.store, 'scopeUsage'), 0);
});
T('SC05c', 'inv', 'slot reservation rolls back with every refused/failed transaction; uncertain commit never a pass', async ctx => {
  const world = () => makeWorld(ctx, { scope: { caps: { max_workers: 1 } } });
  const probe = world(); assert.ok((await probe.admit(dispatch(1))).ok);
  const last = probe.auth.count;
  const w = world(); w.auth.failAt.add(last);
  refusedWith(await w.admit(dispatch(1)), 'UNAUTHENTICATED');
  assert.equal(resv(w.store), 0); assert.equal(w.adm(), 0);
  assert.ok((await w.admit(dispatch(2))).ok, 'slot was not leaked by the final-auth refusal');
  const w2 = world();
  const raw = dispatch(1, outside); w2.decide(1, raw); raw.decision_id = did(1);
  w2.store.overrides.consumeDecision = () => 'conflict';
  const cs = counted(w2.store);
  refusedWith(await ctx.A.admitCommand(raw, w2.trusted, cs), 'CONFLICT', 'decision_consumed_concurrently');
  assert.equal(cs.n, 2); assert.equal(resv(w2.store), 0); assert.equal(w2.consumed(), 0);
  const w3 = world(); w3.store.overrides.insertAdmission = () => { throw new Error('io'); };
  refusedWith(await w3.admit(dispatch(1)), 'STORE_ROLLED_BACK'); assert.equal(resv(w3.store), 0);
  const w4 = world(); w4.store.faults.push({ commit: 'rolled_back' });
  refusedWith(await w4.admit(dispatch(1)), 'STORE_ROLLED_BACK'); assert.equal(resv(w4.store), 0);
  const w5 = world(); w5.store.faults.push({ commit: 'uncertain_not_applied' });
  refusedWith(await w5.admit(dispatch(1)), 'COMMIT_UNCERTAIN'); assert.equal(resv(w5.store), 0);
  assert.ok((await w5.admit(dispatch(1))).ok); assert.equal(resv(w5.store), 1);
  const w6 = world(); w6.store.faults.push({ commit: 'uncertain_applied' });
  refusedWith(await w6.admit(dispatch(1)), 'COMMIT_UNCERTAIN'); assert.equal(resv(w6.store), 1);
  const n6 = callsOf(w6.store, 'reserveScopeSlot');
  const rep = await w6.admit(dispatch(1));
  assert.equal(rep.replayed, true); assert.equal(callsOf(w6.store, 'reserveScopeSlot'), n6);
  refusedWith(await w6.admit(dispatch(2)), 'SCOPE_EXCEEDED', 'max_workers');
  const w7 = world(); w7.store.overrides.reserveScopeSlot = () => 'ok';
  refusedWith(await w7.admit(dispatch(1)), 'STORE_INVALID'); assert.equal(resv(w7.store), 0);
  const w8 = world();
  w8.store.hook = async name => { if (name === 'reserveScopeSlot') w8.store.put(key('grant', 'u1', WS), null); };
  refusedWith(await w8.admit(dispatch(1)), 'FORBIDDEN'); assert.equal(resv(w8.store), 0); assert.equal(w8.adm(), 0);
});
T('SC06', 'obs', 'max_waves compares the client-declared wave number only', async ctx => {
  const w = makeWorld(ctx, { scope: { caps: { max_waves: 1 } } });
  const rs = []; for (const n of [1, 2, 3, 4]) rs.push(await w.admit(dispatch(n)));
  ctx.notes.push(`max_waves=1 and every command declaring wave=1: ${rs.filter(r => r.ok).length}/4 admitted`);
});
T('SC07', 'inv', 'scope/decision of another workspace is not disclosed or usable', async ctx => {
  const w = makeWorld(ctx);
  w.store.put(key('grant', 'u1', 'ws2'), { role: 'owner' });
  w.store.put(key('enrolled', 'ws2', RT), true);
  w.store.put(key('config_rev', 'ws2', RT), CFG_REV);
  w.store.put(key('task_rev', 'ws2', TASK), TASK_REV);
  const res = await w.admit(dispatch(1, c => { c.workspace_id = 'ws2'; }));
  refusedWith(res, 'NOT_FOUND'); assert.equal(res.refusal.card, null);
  const raw = dispatch(2, c => { c.workspace_id = 'ws2'; c.decision_id = did(2); });
  w.store.put(key('scope', 'ws2', SCOPE_ID), { record: scopeRecord({ workspace_id: 'ws2', paths: [] }), revoked: false });
  w.decide(2, dispatch(2, outside));
  const res2 = await w.admit(raw);
  refusedWith(res2, 'DECISION_REQUIRED', 'decision_absent');
  assert.equal(w.consumed(), 0);
});
T('SC08', 'inv', 'config.set without scope and without decision => DECISION_REQUIRED(no_scope) with card', async ctx => {
  const res = await makeWorld(ctx).admit(configCmd(1, c => { c.scope_id = null; }));
  refusedWith(res, 'DECISION_REQUIRED', 'no_scope');
  assert.equal(res.refusal.card.card.scope, null);
});

// ───────────────────────── D: verified decisions ─────────────────────────
T('D01', 'inv', 'valid approving decision admits out-of-scope command and is consumed atomically', async ctx => {
  const w = makeWorld(ctx);
  const raw = dispatch(1, outside); const { record } = w.decide(1, raw); raw.decision_id = did(1);
  const res = await w.admit(raw);
  assert.ok(res.ok, JSON.stringify(res.refusal));
  const used = w.store.get(key('consumed_id', did(1)));
  assert.deepEqual(used, { decision_id: did(1), nonce: record.nonce, command_id: res.receipt.command_id });
  assert.ok(w.store.get(key('consumed_nonce', record.nonce)));
  assert.equal(res.receipt.card_sha256, record.card_sha256);
});
T('D02', 'inv', 'every binding mismatch / invalid decision is refused with no consumption or admission', async ctx => {
  const cases = [
    [{ card_sha256: '0'.repeat(64) }, 'DECISION_REQUIRED', 'decision_card_mismatch'],
    [{ subject: { kind: 'command', id: idem(2), task_id: TASK, task_rev: TASK_REV, config_rev: CFG_REV } }, 'DECISION_REQUIRED', 'decision_subject_mismatch'],
    [{ subject: { kind: 'command', id: idem(1), task_id: TASK, task_rev: TASK_REV - 1, config_rev: CFG_REV } }, 'DECISION_REQUIRED', 'decision_subject_mismatch'],
    [{ subject: { kind: 'command', id: idem(1), task_id: TASK, task_rev: TASK_REV, config_rev: CFG_REV - 1 } }, 'DECISION_REQUIRED', 'decision_subject_mismatch'],
    // cf1182ub C3: different task with the same revision number is a subject mismatch.
    [{ subject: { kind: 'command', id: idem(1), task_id: 'task-2', task_rev: TASK_REV, config_rev: CFG_REV } }, 'DECISION_REQUIRED', 'decision_subject_mismatch'],
    // cf1182ub C3: task_rev is non-nullable, so a stored null subject task_rev is a malformed row.
    [{ subject: { kind: 'command', id: idem(1), task_id: TASK, task_rev: null, config_rev: CFG_REV } }, 'STORE_INVALID'],
    // cf1182ub H1: runtime/principal mismatch share one generic reason.
    [{ user_id: 'u2' }, 'DECISION_REQUIRED', 'decision_binding_mismatch'],
    [{ credential_id: 'c2' }, 'DECISION_REQUIRED', 'decision_binding_mismatch'],
    [{ auth_session_id: 'sess-other' }, 'DECISION_REQUIRED', 'decision_binding_mismatch'],
    [{ runtime_id: 'rt2' }, 'DECISION_REQUIRED', 'decision_binding_mismatch'],
    [{ rendering_origin: 'relay' }, 'DECISION_REQUIRED', 'decision_relay_origin_unresolved'],
    [{ issued_at_ms: T0 + 1, expires_at_ms: T0 + 60_000 }, 'DECISION_REQUIRED', 'decision_expired'],
    [{ issued_at_ms: T0 - 60_000, expires_at_ms: T0 }, 'DECISION_REQUIRED', 'decision_expired'],
    [{ verdict: 'reject' }, 'DECISION_REJECTED'],
    [{ workspace_id: 'ws2' }, 'STORE_INVALID'],
  ];
  for (const [over, code, reason] of cases) {
    const w = makeWorld(ctx);
    const raw = dispatch(1, outside); w.decide(1, raw, over); raw.decision_id = did(1);
    refusedWith(await w.admit(raw), code, reason);
    assert.equal(w.consumed(), 0, JSON.stringify(over)); assert.equal(w.adm(), 0);
  }
  const extra = [
    [w => w.decide(1, dispatch(1, outside), {}, { row: { revoked: true } }), 'DECISION_REQUIRED', 'decision_revoked'],
    [() => {}, 'DECISION_REQUIRED', 'decision_absent'],
    [w => w.decide(1, dispatch(1, outside), {}, { storeId: did(1), row: {} }) && w.store.put(key('decision', WS, did(1)), { record: { ...w.store.get(key('decision', WS, did(1))).record, decision_id: did(5) }, revoked: false }), 'STORE_INVALID'],
  ];
  for (const [setup, code, reason] of extra) {
    const w = makeWorld(ctx); setup(w);
    refusedWith(await w.admit(dispatch(1, c => { outside(c); c.decision_id = did(1); })), code, reason);
    assert.equal(w.consumed(), 0);
  }
  const wc = makeWorld(ctx, { principal: { ...USER, kind: 'controller' } });
  wc.decide(1, dispatch(1, outside));
  refusedWith(await wc.admit(dispatch(1, c => { outside(c); c.decision_id = did(1); })), 'DECISION_REQUIRED', 'decision_requires_user_principal');
});
T('D03', 'inv', 'decision is not a request boolean: client cannot assert approval in the body', ctx => {
  for (const f of ['approved', 'decision', 'verdict', 'assertion', 'webauthn']) {
    assert.equal(ctx.C.validateCommand(dispatch(1, c => { c[f] = true; })).refusal.code, 'UNKNOWN_FIELD');
  }
  assert.equal(ctx.C.validateCommand(dispatch(1, c => { c.decision_id = true; })).ok, false);
});
T('D04', 'inv', 'decision replay: same command replays receipt without re-consuming; new command with consumed decision refused', async ctx => {
  const w = makeWorld(ctx);
  const raw = dispatch(1, outside); w.decide(1, raw); raw.decision_id = did(1);
  const a = await w.admit(clone(raw));
  assert.ok(a.ok);
  const consumeCalls = () => w.store.calls.filter(c => c[2] === 'consumeDecision').length;
  const before = consumeCalls(); const snap = w.store.snapshot();
  const b = await w.admit(clone(raw));
  assert.ok(b.ok); assert.equal(b.replayed, true);
  assert.equal(b.receipt.msg_id, a.receipt.msg_id); assert.equal(b.capability.cap_id, a.capability.cap_id);
  assert.equal(consumeCalls(), before); assert.equal(w.store.snapshot(), snap);
  const c = await w.admit(dispatch(2, x => { outside(x); x.decision_id = did(1); }));
  assert.equal(c.ok, false); ctx.notes.push(`new command reusing consumed decision: ${c.refusal.code}`);
  assert.equal(w.adm(), 1);
});
T('D05', 'inv', 'reused nonce across two decision records: second admission refused CONFLICT and fully rolled back', async ctx => {
  const w = makeWorld(ctx);
  const r1 = dispatch(1, outside); w.decide(1, r1); r1.decision_id = did(1);
  const r2 = dispatch(2, outside); w.decide(2, r2, { nonce: nonceOf(1) }); r2.decision_id = did(2);
  assert.ok((await w.admit(r1)).ok);
  const snap = w.store.snapshot();
  refusedWith(await w.admit(r2), 'CONFLICT');
  assert.equal(w.store.snapshot(), snap); assert.equal(w.adm(), 1);
  assert.equal(w.store.get(key('consumed_id', did(2))), undefined);
});
T('D06', 'inv', 'concurrent commands sharing a nonce: exactly one admitted', async ctx => {
  const w = makeWorld(ctx);
  const raws = [1, 2, 3, 4].map(n => { const r = dispatch(n, outside); w.decide(n, r, { nonce: nonceOf(1) }); r.decision_id = did(n); return r; });
  const rs = await Promise.all(raws.map(r => w.admit(r)));
  assert.equal(rs.filter(r => r.ok).length, 1, rs.map(r => r.ok || r.refusal.code).join(','));
  assert.equal(w.adm(), 1); assert.equal(w.consumed(), 1);
});
T('D07', 'inv', 'decision expiring between clock reads => DECISION_REQUIRED decision_expired, unconsumed', async ctx => {
  const w = makeWorld(ctx);
  const raw = dispatch(1, outside); w.decide(1, raw, { expires_at_ms: T0 + 5000 }); raw.decision_id = did(1);
  w.clock.seq = [T0, T0 + 5000];
  refusedWith(await w.admit(raw), 'DECISION_REQUIRED', 'decision_expired');
  assert.equal(w.consumed(), 0);
});
T('D08', 'obs', 'rendering_origin runtime_direct accepted (label only; not proof of remote approval)', async ctx => {
  const w = makeWorld(ctx);
  const raw = dispatch(1, outside); w.decide(1, raw, { rendering_origin: 'runtime_direct' }); raw.decision_id = did(1);
  const res = await w.admit(raw);
  ctx.notes.push(`runtime_direct decision admitted: ${res.ok}. verification:'upstream_verified' is a stored label; no signature/nonce enrollment is verified here.`);
});
T('D09', 'inv', 'card: deterministic, digest = independent canonical sha256 of card content, no auth session id, scope rev bound', async ctx => {
  const w = makeWorld(ctx);
  const r1 = await w.admit(dispatch(1, outside));
  const r2 = await w.admit(dispatch(1, outside));
  const v = r1.refusal.card;
  assert.equal(v.card_sha256, r2.refusal.card.card_sha256);
  assert.equal(v.card_sha256, sha(canon(clone(v.card))));
  assert.ok(!JSON.stringify(v.card).includes(USER.auth_session_id));
  for (const f of ['action', 'workspace_id', 'runtime_id', 'task', 'attempt', 'target', 'launch', 'scope', 'expires_at_ms', 'requested_by', 'consequences', 'subject']) assert.ok(f in v.card, f);
  assert.equal(v.card.target.sid, 'worker-1'); assert.equal(v.card.attempt, att(1));
  assert.ok(deepFrozen(v));
  const raw = dispatch(1, outside); w.decide(1, raw); raw.decision_id = did(1);
  w.store.put(key('scope', WS, SCOPE_ID), { record: scopeRecord({ rev: 2 }), revoked: false });
  refusedWith(await w.admit(raw), 'DECISION_REQUIRED', 'decision_card_mismatch');
  assert.equal(w.consumed(), 0);
});
T('D10', 'inv', 'insertAdmission conflict after consumption rolls back the consumption', async ctx => {
  const w = makeWorld(ctx);
  const raw = dispatch(1, outside); w.decide(1, raw); raw.decision_id = did(1);
  w.store.overrides.insertAdmission = () => 'conflict';
  refusedWith(await w.admit(raw), 'CONFLICT');
  assert.equal(w.consumed(), 0); assert.equal(w.adm(), 0);
  delete w.store.overrides.insertAdmission;
  assert.ok((await w.admit(raw)).ok, 'decision must still be usable after rollback');
});

// ───────────────────────── I: idempotence / outcomes ─────────────────────────
T('I01', 'inv', 'identical retry replays same receipt/msg_id/cap; no mint, no write', async ctx => {
  const w = makeWorld(ctx);
  const a = await w.admit(dispatch(1));
  const ids = w.ids.count, snap = w.store.snapshot();
  const b = await w.admit(dispatch(1));
  assert.ok(b.ok); assert.equal(b.replayed, true);
  assert.deepEqual(clone(b.receipt), clone(a.receipt)); assert.deepEqual(clone(b.capability), clone(a.capability));
  assert.equal(w.ids.count, ids); assert.equal(w.store.snapshot(), snap);
});
T('I02', 'inv', 'same key changed payload => CONFLICT, no card/receipt data, no write', async ctx => {
  const w = makeWorld(ctx);
  assert.ok((await w.admit(dispatch(1))).ok);
  const snap = w.store.snapshot();
  for (const edit of [c => { c.params.wave = 2; }, c => { c.expires_at_ms += 1; }, c => { c.params.paths = ['src/b.ts']; }]) {
    const res = await w.admit(dispatch(1, edit));
    refusedWith(res, 'CONFLICT'); assert.equal(res.refusal.card, null);
    assert.ok(!JSON.stringify(res).includes('00000000-0000-4000-8000'), 'refusal leaked stored ids');
  }
  assert.equal(w.store.snapshot(), snap);
});
T('I03', 'inv', 'replay is canonical: reordered keys replay', async ctx => {
  const w = makeWorld(ctx);
  const a = await w.admit(dispatch(1));
  const rev = {}; for (const [k, v] of Object.entries(dispatch(1)).reverse()) rev[k] = v;
  const b = await w.admit(rev);
  assert.equal(b.replayed, true); assert.equal(b.receipt.msg_id, a.receipt.msg_id);
});
T('I04', 'inv', 'idempotence key bound to authenticated user + workspace/runtime, not to session', async ctx => {
  const w = makeWorld(ctx);
  const a = await w.admit(dispatch(1));
  const sameUserOtherSession = await w.admit(dispatch(1), { ...w.trusted, principal: { ...USER, auth_session_id: 'sess-2', credential_id: 'c9' } });
  assert.equal(sameUserOtherSession.replayed, true); assert.equal(sameUserOtherSession.receipt.msg_id, a.receipt.msg_id);
  w.store.put(key('grant', 'u2', WS), { role: 'owner' });
  const other = await w.admit(dispatch(1), { ...w.trusted, principal: { ...USER, user_id: 'u2' } });
  assert.ok(other.ok); assert.equal(other.replayed, false); assert.notEqual(other.receipt.msg_id, a.receipt.msg_id);
  w.store.put(key('enrolled', WS, 'rt2'), true); w.store.put(key('config_rev', WS, 'rt2'), CFG_REV);
  w.store.put(key('scope', WS, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'), { record: scopeRecord({ scope_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', runtime_id: 'rt2' }), revoked: false });
  const rt2 = await w.admit(dispatch(1, c => { c.runtime_id = 'rt2'; c.scope_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; }));
  assert.ok(rt2.ok, JSON.stringify(rt2.refusal)); assert.equal(rt2.replayed, false);
});
T('I05', 'inv', 'grant revoked / runtime unenrolled / auth invalid before duplicate => refused with no stored data', async ctx => {
  for (const revoke of [w => w.store.put(key('grant', 'u1', WS), null), w => w.store.put(key('enrolled', WS, RT), false), w => { w.auth.valid = false; }]) {
    const w = makeWorld(ctx);
    const a = await w.admit(dispatch(1));
    revoke(w);
    const res = await w.admit(dispatch(1));
    assert.equal(res.ok, false);
    assert.ok(!JSON.stringify(res).includes(a.receipt.msg_id) && !JSON.stringify(res).includes(a.capability.cap_id));
    assert.equal(res.refusal.card, null);
  }
});
T('I06', 'inv', 'concurrent identical commands: all ok, one fresh admission, one msg_id', async ctx => {
  const w = makeWorld(ctx);
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => w.admit(dispatch(1))));
  assert.ok(rs.every(r => r.ok), rs.map(r => r.ok || r.refusal.code).join(','));
  assert.equal(rs.filter(r => !r.replayed).length, 1);
  assert.equal(new Set(rs.map(r => r.receipt.msg_id)).size, 1);
  assert.equal(w.adm(), 1);
  ctx.notes.push(`store reruns (serialization retries): ${w.store.reruns}`);
});
T('I06b', 'inv', 'concurrent identical commands replay even when the store reports the unique-key race as a plain insert conflict', async ctx => {
  const w = makeWorld(ctx);
  w.store.ssiRetryOnStaleAbort = false; // contract-literal store: insertAdmission returns 'conflict', no serialization error
  const cs = [1, 2, 3, 4, 5].map(() => counted(w.store));
  const rs = await Promise.all(cs.map(c => ctx.A.admitCommand(dispatch(1), w.trusted, c)));
  const retry = await w.admit(dispatch(1));
  ctx.notes.push(`results: ${rs.map(r => r.ok ? (r.replayed ? 'replayed' : 'admitted') : r.refusal.code).join(',')}; immediate retry with same key: ${retry.ok ? (retry.replayed ? 'replayed same msg_id=' + (retry.receipt.msg_id === rs.find(r => r.ok)?.receipt.msg_id) : 'admitted') : retry.refusal.code}`);
  ctx.notes.push(`store.transaction calls per admitCommand: ${cs.map(c => c.n).join(',')}; store reruns ${w.store.reruns}`);
  assert.ok(rs.every(r => r.ok), 'identical concurrent request refused CONFLICT instead of replaying the receipt');
  // cf1182ub C5: one winner, the same ids for all, at most one core retry each, retry path exercised.
  assert.equal(rs.filter(r => !r.replayed).length, 1);
  for (const f of ['msg_id', 'cap_id', 'command_id']) assert.equal(new Set(rs.map(r => r.receipt[f])).size, 1, f);
  assert.ok(cs.every(c => c.n <= 2)); assert.ok(cs.some(c => c.n === 2), 'confirmed-rollback retry path not exercised');
  assert.equal(w.adm(), 1);
});
T('I06c', 'inv', 'simultaneous identical ordinary/decision/capped admissions (snapshot reads, contract-literal conflicts): insert or consume conflict -> exactly one new-tx retry -> winner ids; one consume, one slot', async ctx => {
  const plans = [
    ['ordinary', ['insertAdmission']],
    ['ordinary+cap', ['reserveScopeSlot', 'insertAdmission']],
    ['decision', ['decision', 'consumeDecision', 'insertAdmission']],
    ['decision+cap', ['decision', 'reserveScopeSlot', 'consumeDecision', 'insertAdmission']],
  ];
  for (const [variant, points] of plans) {
    for (const point of points) {
      const cap = variant.endsWith('+cap'), dec = variant.startsWith('decision');
      const w = makeWorld(ctx, { scope: cap ? { caps: { max_workers: 1 } } : {} });
      w.store.ssiRetryOnStaleAbort = false; w.store.snapshotReads = true;
      const raw = dec ? dispatch(1, outside) : dispatch(1);
      if (dec) { w.decide(1, raw); raw.decision_id = did(1); }
      const seen = [];
      w.store.overrides.consumeDecision = r => { seen.push(`consume:${r}`); return r; };
      w.store.overrides.insertAdmission = r => { seen.push(`insert:${r}`); return r; };
      let winner = null;
      // Losers reach `point` only after the winner (tx 1) committed, so they see its rows.
      w.store.hook = async (name, txId) => { if (name === point && txId !== 1) await winner; };
      const cs = [1, 2, 3, 4, 5].map(() => counted(w.store));
      const ps = cs.map(c => ctx.A.admitCommand(clone(raw), w.trusted, c));
      winner = ps[0];
      const rs = await Promise.all(ps);
      const tag = `${variant}@${point}`;
      assert.ok(rs.every(r => r.ok), `${tag}: ${rs.map(r => r.ok ? 'ok' : `${r.refusal.code}:${r.refusal.reasons}`).join(',')}`);
      assert.equal(rs.filter(r => !r.replayed).length, 1, tag);
      for (const f of ['msg_id', 'cap_id', 'command_id']) assert.equal(new Set(rs.map(r => r.receipt[f])).size, 1, `${tag} ${f}`);
      assert.deepEqual(cs.map(c => c.n), [1, 2, 2, 2, 2], `${tag} transaction calls`);
      assert.equal(new Set(w.store.calls.map(c => c[0])).size, 9, `${tag}: each retry ran in a new transaction`);
      assert.equal(w.adm(), 1); assert.equal(w.consumed(), dec ? 1 : 0); assert.equal(resv(w.store), cap ? 1 : 0, `${tag} slots`);
      const conflicts = seen.filter(s => s.endsWith(':conflict'));
      const expected = dec && point !== 'insertAdmission' ? 'consume:conflict' : 'insert:conflict';
      assert.deepEqual(conflicts, [expected, expected, expected, expected], `${tag} conflict path`);
      ctx.notes.push(`${tag}: calls ${cs.map(c => c.n).join('')} conflicts ${conflicts.length}x${expected}`);
    }
  }
});
T('I06d', 'obs', 'same races on the non-snapshot contract-literal fake (reads latest committed mid-run; not a SERIALIZABLE snapshot)', async ctx => {
  for (const [variant, point] of [['decision', 'decision'], ['ordinary+cap', 'reserveScopeSlot'], ['decision', 'consumeDecision']]) {
    const cap = variant.endsWith('+cap'), dec = variant.startsWith('decision');
    const w = makeWorld(ctx, { scope: cap ? { caps: { max_workers: 1 } } : {} });
    w.store.ssiRetryOnStaleAbort = false;
    const raw = dec ? dispatch(1, outside) : dispatch(1);
    if (dec) { w.decide(1, raw); raw.decision_id = did(1); }
    let winner = null;
    w.store.hook = async (name, txId) => { if (name === point && txId !== 1) await winner; };
    const cs = [1, 2, 3, 4, 5].map(() => counted(w.store));
    const ps = cs.map(c => ctx.A.admitCommand(clone(raw), w.trusted, c));
    winner = ps[0];
    const rs = await Promise.all(ps);
    ctx.notes.push(`${variant}@${point}: ${rs.map(r => r.ok ? (r.replayed ? 'replayed' : 'admitted') : `${r.refusal.code}[${r.refusal.reasons}]`).join(',')} calls ${cs.map(c => c.n).join('')}; admissions ${w.adm()}, consumed ${w.consumed()}, slots ${resv(w.store)}`);
    assert.equal(w.adm(), 1);
  }
});
T('I06e', 'inv', 'core retry boundary: only a store-confirmed rolled_back race conflict, at most once, new tx; never different body, uncertain/unknown outcome, store throw, unrelated rollback or uncaptured abort', async ctx => {
  const run = async (setup, make = () => dispatch(1)) => {
    const w = makeWorld(ctx);
    const raw = make(w);
    await setup(w);
    const cs = counted(w.store);
    const res = await ctx.A.admitCommand(raw, w.trusted, cs);
    return { w, cs, res };
  };
  const withDecision = w => { const raw = dispatch(1, outside); w.decide(1, raw); raw.decision_id = did(1); return raw; };
  {
    const { w, cs, res } = await run(w => { w.store.overrides.insertAdmission = () => 'conflict'; });
    refusedWith(res, 'CONFLICT', 'concurrent_admission'); assert.equal(cs.n, 2); assert.equal(w.adm(), 0);
    assert.equal(new Set(w.store.calls.map(c => c[0])).size, 2, 'retry must run in a new transaction');
  }
  {
    const { w, cs, res } = await run(w => { w.store.overrides.consumeDecision = () => 'conflict'; }, withDecision);
    refusedWith(res, 'CONFLICT', 'decision_consumed_concurrently'); assert.equal(cs.n, 2); assert.equal(w.consumed(), 0);
  }
  {
    let k = 0;
    const { cs, res } = await run(w => { w.store.overrides.insertAdmission = r => (k++ === 0 ? 'conflict' : r); w.store.faults.push({}, { commit: 'uncertain_not_applied' }); });
    refusedWith(res, 'COMMIT_UNCERTAIN'); assert.equal(cs.n, 2, 'uncertain retry outcome is returned, not retried again');
  }
  {
    const { w, cs, res } = await run(w => { w.store.faults.push({ forceReruns: 2 }); });
    assert.ok(res.ok); assert.equal(cs.n, 1, 'store-internal serialization reruns are not core retries'); assert.equal(w.store.reruns, 2);
  }
  const never = [
    ['different body, same key', async w => { assert.ok((await w.admit(dispatch(1, c => { c.params.wave = 2; }))).ok); }, 'CONFLICT'],
    ['insert conflict + commit_uncertain', w => { w.store.overrides.insertAdmission = () => 'conflict'; w.store.faults.push({ abortOutcome: 'commit_uncertain' }); }, 'COMMIT_UNCERTAIN'],
    ['insert conflict + store throw', w => { w.store.overrides.insertAdmission = () => 'conflict'; w.store.faults.push({ abortOutcome: 'throw' }); }, 'COMMIT_UNCERTAIN'],
    ['insert conflict + unrecognized status', w => { w.store.overrides.insertAdmission = () => 'conflict'; w.store.faults.push({ abortOutcome: 'bogus' }); }, 'COMMIT_UNCERTAIN'],
    ['insert conflict + missing status', w => { w.store.overrides.insertAdmission = () => 'conflict'; w.store.faults.push({ abortOutcome: 'missing' }); }, 'COMMIT_UNCERTAIN'],
    ['consume conflict + commit_uncertain', w => { withDecision(w); w.store.overrides.consumeDecision = () => 'conflict'; w.store.faults.push({ abortOutcome: 'commit_uncertain' }); }, 'COMMIT_UNCERTAIN', withDecision],
    ['rolled_back without running work', w => { w.store.faults.push({ commit: 'rolled_back_without_run' }); }, 'STORE_ROLLED_BACK'],
    ['rolled_back after successful work', w => { w.store.faults.push({ commit: 'rolled_back' }); }, 'STORE_ROLLED_BACK'],
    ['store method throws (uncaptured abort)', w => { w.store.overrides.insertAdmission = () => { throw new Error('io'); }; }, 'STORE_ROLLED_BACK'],
    ['policy refusal', () => {}, 'SCOPE_EXCEEDED', () => dispatch(1, outside)],
    ['decision already consumed (pre-read)', async w => { const r0 = dispatch(9, outside); w.decide(1, r0); r0.decision_id = did(1); assert.ok((await w.admit(r0)).ok); }, 'CONFLICT', () => dispatch(1, c => { outside(c); c.decision_id = did(1); })],
    ['commit_uncertain after successful work (applied)', w => { w.store.faults.push({ commit: 'uncertain_applied' }); }, 'COMMIT_UNCERTAIN'],
    ['unrecognized status after applying writes', w => { w.store.faults.push({ commit: 'bogus_applied' }); }, 'COMMIT_UNCERTAIN'],
  ];
  const rows = [];
  for (const [label, setup, code, make] of never) {
    const { w, cs, res } = await run(setup, make);
    refusedWith(res, code);
    assert.equal(cs.n, 1, `${label}: retried`);
    rows.push(`${label}=${res.refusal.code}/${cs.n}tx`);
    if (label === 'unrecognized status after applying writes') {
      assert.equal(w.adm(), 1, 'unknown outcome is not proof that writes rolled back');
      const again = await w.admit(dispatch(1));
      assert.equal(again.replayed, true);
    }
  }
  const wn = makeWorld(ctx);
  const r1 = dispatch(1, outside); wn.decide(1, r1); r1.decision_id = did(1);
  const r2 = dispatch(2, outside); wn.decide(2, r2, { nonce: nonceOf(1) }); r2.decision_id = did(2);
  assert.ok((await wn.admit(r1)).ok);
  const cn = counted(wn.store);
  refusedWith(await ctx.A.admitCommand(r2, wn.trusted, cn), 'CONFLICT', 'decision_consumed_concurrently');
  rows.push(`sequential reused nonce (tag says concurrently)=CONFLICT/${cn.n}tx`);
  ctx.notes.push(rows.join('; '));
});
T('H1', 'inv', 'decision revoked/consumed state is not disclosed before runtime/principal binding; one generic refusal shape', async ctx => {
  const shapes = new Set();
  for (const over of [{ user_id: 'u2' }, { credential_id: 'c2' }, { auth_session_id: 'sess-x' }, { runtime_id: 'rt2' }]) {
    for (const state of ['live', 'revoked', 'consumed', 'revoked+consumed']) {
      const w = makeWorld(ctx);
      const raw = dispatch(1, outside); w.decide(1, raw, over, { row: { revoked: state.includes('revoked') } }); raw.decision_id = did(1);
      if (state.includes('consumed')) w.store.put(key('consumed_id', did(1)), { decision_id: did(1), nonce: nonceOf(1), command_id: ID_A[0] });
      const res = await w.admit(raw);
      refusedWith(res, 'DECISION_REQUIRED');
      assert.deepEqual([...res.refusal.reasons], ['decision_binding_mismatch'], `${JSON.stringify(over)} ${state}`);
      shapes.add(JSON.stringify([res.refusal.code, res.refusal.path, res.refusal.detail, res.refusal.reasons, res.refusal.card?.card_sha256]));
      assert.equal(w.adm(), 0);
    }
  }
  assert.equal(shapes.size, 1, `refusal differs by decision state: ${[...shapes].join(' | ')}`);
  const own = makeWorld(ctx);
  const raw = dispatch(1, outside); own.decide(1, raw, {}, { row: { revoked: true } }); raw.decision_id = did(1);
  refusedWith(await own.admit(raw), 'DECISION_REQUIRED', 'decision_revoked');
});
T('H2', 'inv', 'capability not_after (and its slot) is bounded by the decision expiry', async ctx => {
  const w = makeWorld(ctx, { scope: { caps: { max_workers: 3 } } });
  const raw = dispatch(1, c => { outside(c); c.expires_at_ms = T0 + 14 * 60_000; });
  const { record } = w.decide(1, raw, { expires_at_ms: T0 + 30_000 }); raw.decision_id = did(1);
  const res = await w.admit(raw);
  assert.ok(res.ok, JSON.stringify(res.refusal ?? null));
  assert.equal(res.capability.not_after_ms, T0 + 30_000); assert.ok(res.capability.not_after_ms <= record.expires_at_ms);
  assert.equal(w.store.get(key('resv', WS, SCOPE_ID, res.receipt.command_id)).not_after_ms, T0 + 30_000);
  const b = await w.admit(dispatch(2, c => { c.expires_at_ms = T0 + 14 * 60_000; }));
  assert.equal(b.capability.not_after_ms, T0 + 10 * 60_000);
});
T('AU07b', 'inv', 'capped decision path: grant/auth/enrollment revoked at each awaited store call (incl. reserveScopeSlot) => refused, no admission/consumption/slot', async ctx => {
  const scope = { caps: { max_workers: 2 } };
  const probe = makeWorld(ctx, { scope });
  const raw0 = dispatch(1, outside); probe.decide(1, raw0); raw0.decision_id = did(1);
  assert.ok((await probe.admit(raw0)).ok);
  const methods = [...new Set(probe.store.calls.map(c => c[2]))];
  assert.ok(methods.includes('reserveScopeSlot'));
  ctx.notes.push(`awaited store methods on capped decision path: ${methods.join(',')}`);
  for (const m of methods) {
    for (const what of ['grant', 'auth', 'enroll']) {
      const w = makeWorld(ctx, { scope });
      const raw = dispatch(1, outside); w.decide(1, raw); raw.decision_id = did(1);
      let fired = false;
      w.store.hook = async name => {
        if (name !== m || fired) return; fired = true;
        if (what === 'grant') w.store.put(key('grant', 'u1', WS), null);
        else if (what === 'enroll') w.store.put(key('enrolled', WS, RT), false);
        else w.auth.valid = false;
      };
      const res = await w.admit(raw);
      assert.equal(res.ok, false, `${what} revoked at ${m} still admitted`);
      assert.equal(res.refusal.code, { grant: 'FORBIDDEN', auth: 'UNAUTHENTICATED', enroll: 'RUNTIME_NOT_ENROLLED' }[what], `${what}@${m}`);
      assert.equal(w.adm(), 0); assert.equal(w.consumed(), 0); assert.equal(resv(w.store), 0);
    }
  }
});
T('I07', 'inv', 'concurrent competing bodies on one key: exactly one admitted, rest CONFLICT', async ctx => {
  const w = makeWorld(ctx);
  const rs = await Promise.all([1, 2, 3, 4].map(n => w.admit(dispatch(1, c => { c.params.paths = [`src/f${n}.ts`]; }))));
  assert.equal(rs.filter(r => r.ok).length, 1);
  assert.ok(rs.filter(r => !r.ok).every(r => r.refusal.code === 'CONFLICT'));
  assert.equal(w.adm(), 1);
});
T('I08', 'inv', 'commit_uncertain never success; retry replays when applied, admits fresh when not', async ctx => {
  const w = makeWorld(ctx);
  w.store.faults.push({ commit: 'uncertain_applied' });
  refusedWith(await w.admit(dispatch(1)), 'COMMIT_UNCERTAIN');
  const stored = w.store.get(key('adm', 'u1', WS, RT, idem(1)));
  const retry = await w.admit(dispatch(1));
  assert.equal(retry.replayed, true); assert.equal(retry.receipt.msg_id, stored.receipt.msg_id);
  const w2 = makeWorld(ctx);
  w2.store.faults.push({ commit: 'uncertain_not_applied' });
  refusedWith(await w2.admit(dispatch(1)), 'COMMIT_UNCERTAIN');
  assert.equal(w2.adm(), 0);
  const fresh = await w2.admit(dispatch(1));
  assert.ok(fresh.ok); assert.equal(fresh.replayed, false);
});
T('I09', 'inv', 'store promise rejection (before run / after apply / transport) => COMMIT_UNCERTAIN, retry consistent', async ctx => {
  for (const commit of ['reject_before_run', 'throw', 'throw_after_apply']) {
    const w = makeWorld(ctx);
    w.store.faults.push({ commit });
    refusedWith(await w.admit(dispatch(1)), 'COMMIT_UNCERTAIN');
    const retry = await w.admit(dispatch(1));
    assert.ok(retry.ok);
    assert.equal(retry.replayed, commit === 'throw_after_apply', commit);
  }
});
T('I10', 'inv', 'rolled_back after successful work => STORE_ROLLED_BACK, state unchanged, decision unconsumed', async ctx => {
  const w = makeWorld(ctx);
  const raw = dispatch(1, outside); w.decide(1, raw); raw.decision_id = did(1);
  const snap = w.store.snapshot();
  w.store.faults.push({ commit: 'rolled_back' });
  refusedWith(await w.admit(raw), 'STORE_ROLLED_BACK');
  assert.equal(w.store.snapshot(), snap);
});
T('I11', 'inv', 'broken store outcomes (commit without run, bogus status, null, throwing getter) => COMMIT_UNCERTAIN', async ctx => {
  for (const commit of ['committed_without_run', 'bogus', 'null', 'getter_throws']) {
    const w = makeWorld(ctx); w.store.faults.push({ commit });
    refusedWith(await w.admit(dispatch(1)), 'COMMIT_UNCERTAIN');
  }
});
T('I12', 'inv', 'serialization reruns: only the final run is returned and stored (single msg_id)', async ctx => {
  const w = makeWorld(ctx);
  w.store.faults.push({ forceReruns: 2 });
  const res = await w.admit(dispatch(1));
  assert.ok(res.ok);
  assert.equal(w.ids.count, 9);
  assert.equal(w.store.get(key('adm', 'u1', WS, RT, idem(1))).receipt.msg_id, res.receipt.msg_id);
  const w2 = makeWorld(ctx);
  const raw = dispatch(1, outside); w2.decide(1, raw); raw.decision_id = did(1);
  w2.store.faults.push({ forceReruns: 1 });
  const r2 = await w2.admit(raw);
  assert.ok(r2.ok); assert.equal(w2.store.get(key('consumed_id', did(1))).command_id, r2.receipt.command_id);
});
T('I13', 'obs', 'replay after role downgrade / command expiry returns the original receipt', async ctx => {
  const w = makeWorld(ctx);
  const a = await w.admit(configCmd(1));
  w.store.put(key('grant', 'u1', WS), { role: 'viewer' });
  const b = await w.admit(configCmd(1));
  w.clock.t = T0 + 3_600_000;
  const c = await w.admit(configCmd(1));
  ctx.notes.push(`owner->viewer then replay: ok=${b.ok} replayed=${b.replayed}; replay 1h after command expiry: ok=${c.ok}, cap not_after_ms already past=${c.ok && c.capability.not_after_ms < w.clock.t}`);
  assert.ok(a.ok);
});

// ───────────────────────── E: no execution effects ─────────────────────────
T('E01', 'inv', 'emitted JS imports only node:crypto/node:util and sibling modules; no effect primitives', ctx => {
  for (const f of ['admission.js', 'cards.js', 'contracts.js']) {
    const src = readFileSync(new URL(f, ctx.dirUrl), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
    assert.ok(imports.every(i => ['node:crypto', 'node:util', './cards.js', './contracts.js'].includes(i)), `${f}: ${imports}`);
    for (const bad of ['child_process', 'node:fs', 'node:net', 'node:http', 'fetch(', 'eval(', 'new Function', 'process.env', 'telepty', 'import(', 'require(']) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
  }
});
T('E02', 'inv', 'admission touches only ControlTx port methods; capability stays issued', async ctx => {
  const w = makeWorld(ctx);
  const raw = dispatch(1, outside); w.decide(1, raw); raw.decision_id = did(1);
  const res = await w.admit(raw);
  const allowed = new Set(['grant', 'runtimeEnrolled', 'admission', 'configRevision', 'taskRevision', 'scope', 'scopeUsage', 'decision', 'consumeDecision', 'reserveScopeSlot', 'insertAdmission']);
  assert.ok(w.store.calls.every(c => allowed.has(c[2])));
  assert.equal(res.capability.state, 'issued');
  ctx.notes.push(`call order: ${w.store.calls.map(c => c[2]).join(' > ')}`);
});

export const TESTS = tests;
export async function runSuite(dir, { makeStore = () => new FakeStore(), filter = null, timeoutMs = 20_000 } = {}) {
  const dirUrl = pathToFileURL(dir.endsWith('/') ? dir : `${dir}/`);
  const C = await import(new URL('contracts.js', dirUrl));
  const K = await import(new URL('cards.js', dirUrl));
  const A = await import(new URL('admission.js', dirUrl));
  const results = [];
  for (const t of tests) {
    if (filter && !filter.includes(t.id)) continue;
    const ctx = { C, K, A, dirUrl, makeStore, notes: [] };
    let status = 'pass', error = null, timer;
    try {
      await Promise.race([Promise.resolve().then(() => t.fn(ctx)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })]);
    } catch (e) { status = 'fail'; error = String(e?.message ?? e).split('\n')[0].slice(0, 300); }
    clearTimeout(timer);
    results.push({ id: t.id, kind: t.kind, title: t.title, status, error, notes: ctx.notes });
  }
  return results;
}
