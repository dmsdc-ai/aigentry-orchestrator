// Own child process: traps host-I/O surfaces, then drives the candidate. Prints {hits, calls} JSON.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import cp from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const hits = [];
let armed = false;
function trap(obj, label) {
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] !== 'function') continue;
    const orig = obj[key];
    try { obj[key] = function (...a) { if (armed) hits.push(`${label}.${key}`); return orig.apply(this, a); }; } catch { /* read-only */ }
  }
}
for (const [m, l] of [[fs, 'fs'], [fsp, 'fs/promises'], [net, 'net'], [http, 'http'], [https, 'https'], [dns, 'dns'], [cp, 'child_process'], [os, 'os']]) trap(m, l);
syncBuiltinESMExports();
for (const name of ['setTimeout', 'setInterval', 'setImmediate', 'fetch']) {
  const orig = globalThis[name];
  globalThis[name] = function (...a) { if (armed) hits.push(name); return orig.apply(this, a); };
}
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (armed && a.length === 0) hits.push('new Date()'); super(...a); }
  static now() { if (armed) hits.push('Date.now'); return RealDate.now(); }
};
const perfNow = performance.now.bind(performance);
performance.now = () => { if (armed) hits.push('performance.now'); return perfNow(); };
const hr = process.hrtime; process.hrtime = function (...a) { if (armed) hits.push('process.hrtime'); return hr.apply(this, a); };
process.hrtime.bigint = () => { if (armed) hits.push('process.hrtime.bigint'); return hr.bigint(); };
const realEnv = process.env;
process.env = new Proxy(realEnv, { get(t, k) { if (armed) hits.push(`env.${String(k)}`); return t[k]; }, ownKeys(t) { if (armed) hits.push('env.keys'); return Reflect.ownKeys(t); } });
for (const name of ['cwd', 'exit', 'kill', 'chdir', 'uptime', 'memoryUsage', 'cpuUsage']) {
  const orig = process[name]; process[name] = function (...a) { if (armed) hits.push(`process.${name}`); return orig.apply(this, a); };
}

const H = await import('./helpers.mjs');
const { K, E, ev, errEv, bytes, state, rec, request, WS, grantTasks } = H;
let calls = 0;
armed = true;
try {
  let st = state();
  for (const chunks of [[bytes(ev(1), ev(2))], [bytes(ev(3)).subarray(0, 10)], [bytes(ev(3)).subarray(10), bytes(ev(1))]]) {
    const r = K.collectWindow(st, { generation: st.generation, cursor: st.cursor, chunks, observedAt: H.OBS, endOfData: true }); calls++;
    st = r.value.state;
  }
  K.collectWindow(st, { generation: 9, cursor: 0, chunks: [bytes(ev(4))], observedAt: H.OBS, endOfData: false }); calls++;
  K.collectWindow(st, { generation: 0, cursor: st.cursor, chunks: [], observedAt: '2020-01-01T00:00:00.000Z', endOfData: true }); calls++;
  const esc = state('verify-escalations-v1', 'esc');
  K.collectWindow(esc, { generation: 0, cursor: 0, chunks: [bytes({ sid: 's', ts: '2026-09-01T00:00:00Z', rc: 1, detail: 'x' }), bytes('bad\n')], observedAt: H.OBS, endOfData: true }); calls++;
  const recs = [1, 2, 3, 4, 5].map(n => rec(errEv(n, { taskId: 'T2', sid: 's2', attempt: 'a', operation: 'o' })));
  for (const grant of [WS, grantTasks('T2')]) { E.analyzeEfficiency(request({ grant, records: recs })); calls++; }
  E.analyzeEfficiency(request({ records: recs, config: { ...H.CFG, maxOperations: 3 } })); calls++;
  E.analyzeEfficiency({ bogus: true }); calls++;
  for (let i = 0; i < 5; i++) { H.C.validateEventV1(ev(i)); calls++; }
} finally { armed = false; }
process.stdout.write(JSON.stringify({ hits, calls }) + '\n');
