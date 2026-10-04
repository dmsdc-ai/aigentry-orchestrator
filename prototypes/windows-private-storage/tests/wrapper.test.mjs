// wrapper.test.mjs - #1167 regression tests for private-storage.mjs (the JS wrapper only). Test-only,
// Node standard library only, any OS.
// STUB, NOT NATIVE: process.dlopen is replaced for each load by a fake that sets module.exports to a plain
// JS object, and the "binary" is fake bytes written to a temp file only so the wrapper's sha256 gate can
// pass. No .node file is ever loaded and no Win32 API is called; nothing here is native or Windows evidence.
// On non-win32 hosts process.platform reads 'win32' only for the duration of one loadPrivateStorage call,
// and the binary is a temp file whose literal name is 'C:\psp1167-stub\fake.node' (cwd = its directory).
// PSP_WRAPPER_UNDER_TEST selects the wrapper (default ../private-storage.mjs); if
// PSP_WRAPPER_UNDER_TEST_SHA256 is set, the wrapper must match it before import.
// PSP_WRAPPER_TEST_TMP overrides the temp root (default os.tmpdir()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const WRAPPER = process.env.PSP_WRAPPER_UNDER_TEST ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'private-storage.mjs');
const WRAPPER_SHA256 = sha256(fs.readFileSync(WRAPPER));
if (process.env.PSP_WRAPPER_UNDER_TEST_SHA256) {
  assert.equal(WRAPPER_SHA256, process.env.PSP_WRAPPER_UNDER_TEST_SHA256, 'wrapper differs from its pin: not imported');
}
const W = await import(pathToFileURL(WRAPPER).href);
console.log(`# wrapper ${WRAPPER_SHA256} ${WRAPPER} (stub native; host platform ${process.platform})`);

const SECRET = 'SECRET-1167-C:\\Users\\victim\\token';
const SERIAL = '0123456789abcdef';
const FILEID = '0123456789abcdef0123456789abcdef';
const P = 'C:\\psp\\x';
const FUNCS = ['inspectDir', 'readPrivateFile', 'createPrivateDir', 'createPrivateFileExclusive'];
const CREATES = ['createPrivateDir', 'createPrivateFileExclusive'];

// ------------------------------------------------------------------ fake binary + fake dlopen
const TMP_ROOT = process.env.PSP_WRAPPER_TEST_TMP || os.tmpdir();
const STUB_DIR = fs.mkdtempSync(path.join(TMP_ROOT, 'psp1167-wrapper-'));
const ON_WIN = process.platform === 'win32';
const BIN = ON_WIN ? path.join(STUB_DIR, 'fake.node') : 'C:\\psp1167-stub\\fake.node';
const BIN_BYTES = Buffer.from('psp1167 fake binary bytes: not a PE image, never loaded\n');
fs.writeFileSync(ON_WIN ? BIN : path.join(STUB_DIR, BIN), BIN_BYTES);
const BIN_SHA = sha256(BIN_BYTES);

function load(options, { platform = 'win32', exportsValue, dlopenThrows = false } = {}) {
  const dlopenCalls = [];
  const realDlopen = process.dlopen;
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  const cwd = process.cwd();
  process.dlopen = (module, filename) => {
    dlopenCalls.push(filename);
    if (dlopenThrows) throw new Error(SECRET);
    module.exports = exportsValue;
  };
  Object.defineProperty(process, 'platform', { ...platformDesc, value: platform });
  if (!ON_WIN) process.chdir(STUB_DIR);
  try {
    return { result: W.loadPrivateStorage(options), dlopenCalls };
  } finally {
    process.chdir(cwd);
    Object.defineProperty(process, 'platform', platformDesc);
    process.dlopen = realDlopen;
  }
}

// Fake native module: each function records its calls and delegates to impl[name] (default: throws).
function fakeNative(impl = {}) {
  const calls = [];
  const native = { abi: W.ABI_TAG };
  for (const name of FUNCS) {
    native[name] = (...args) => {
      calls.push({ name, args });
      if (!impl[name]) throw new Error(`unexpected native call ${name}`);
      return impl[name](...args);
    };
  }
  return { native, calls };
}

function loadApi(impl) {
  const { native, calls } = fakeNative(impl);
  const { result, dlopenCalls } = load({ binaryPath: BIN, sha256: BIN_SHA }, { exportsValue: native });
  assert.equal(result.status, 'ok', `stub load failed: ${JSON.stringify(result)}`);
  assert.deepEqual(dlopenCalls, [BIN]);
  return { api: result.api, calls };
}

// One op against a stub whose function returns/throws `behaviour()`. Returns { res, calls }.
const ARGS = { inspectDir: [P], readPrivateFile: [P, 65536], createPrivateDir: [P], createPrivateFileExclusive: [P, Buffer.from('abc')] };
function run(name, behaviour, args = ARGS[name]) {
  const { api, calls } = loadApi({ [name]: behaviour });
  let res;
  assert.doesNotThrow(() => { res = api[name](...args); }, `${name} threw out of the wrapper`);
  return { res, calls };
}

const okRaw = (extra = {}) => ({ status: 'ok', reason: 'ok', win32Error: 0, volumeSerial: SERIAL, fileId: FILEID, ...extra });
const keys = (o) => Object.keys(o).sort();
function assertOneCall(calls, name) {
  assert.equal(calls.length, 1, `expected exactly one native call (no retry/delete/follow-up), got ${JSON.stringify(calls.map((c) => c.name))}`);
  assert.equal(calls[0].name, name);
}
function assertCreateFailure(res, reason, created) {
  assert.ok(Object.isFrozen(res));
  assert.deepEqual(keys(res), ['created', 'reason', 'status', 'win32Error']);
  assert.equal(res.status, 'unavailable');
  assert.equal(res.reason, reason);
  assert.equal(res.win32Error, 0);
  assert.equal(res.created, created);
  assert.ok(!JSON.stringify(res).includes('SECRET'), 'secret text forwarded');
}
function assertPlainFailure(res, reason) {
  assert.ok(Object.isFrozen(res));
  assert.deepEqual(keys(res), ['reason', 'status', 'win32Error']);
  assert.deepEqual({ ...res }, { status: 'unavailable', reason, win32Error: 0 });
  assert.ok(!JSON.stringify(res).includes('SECRET'), 'secret text forwarded');
}

// ------------------------------------------------------------------ loader: fail closed, platform behaviour
test('L1 loader: non-win32 platform is platform_unsupported and never reaches dlopen', () => {
  for (const platform of ['linux', 'darwin']) {
    const { result, dlopenCalls } = load({ binaryPath: BIN, sha256: BIN_SHA }, { platform, exportsValue: fakeNative().native });
    assertPlainFailure(result, 'platform_unsupported');
    assert.deepEqual(dlopenCalls, []);
  }
});

test('L2 loader: invalid binaryPath / sha256 / unreadable / mismatch fail closed before dlopen', () => {
  const cases = [
    [undefined, 'binary_path_invalid'], [{}, 'binary_path_invalid'], [{ binaryPath: 42, sha256: BIN_SHA }, 'binary_path_invalid'],
    [{ binaryPath: 'fake.node', sha256: BIN_SHA }, 'binary_path_invalid'], [{ binaryPath: 'C:/psp1167-stub/fake.node', sha256: BIN_SHA }, 'binary_path_invalid'],
    [{ binaryPath: 'C:\\a\\..\\fake.node', sha256: BIN_SHA }, 'binary_path_invalid'], [{ binaryPath: 'C:\\psp1167-stub\\fake.dll', sha256: BIN_SHA }, 'binary_path_invalid'],
    [{ binaryPath: BIN, sha256: BIN_SHA.toUpperCase() }, 'binary_hash_invalid'], [{ binaryPath: BIN, sha256: BIN_SHA.slice(1) }, 'binary_hash_invalid'],
    [{ binaryPath: BIN, sha256: undefined }, 'binary_hash_invalid'],
    [{ binaryPath: ON_WIN ? path.join(STUB_DIR, 'absent.node') : 'C:\\psp1167-stub\\absent.node', sha256: BIN_SHA }, 'binary_unreadable'],
    [{ binaryPath: BIN, sha256: sha256(Buffer.from('other')) }, 'binary_hash_mismatch'],
  ];
  for (const [options, reason] of cases) {
    const { result, dlopenCalls } = load(options, { exportsValue: fakeNative().native });
    assertPlainFailure(result, reason);
    assert.deepEqual(dlopenCalls, [], `${reason}: dlopen reached`);
  }
});

test('L3 loader: dlopen throw is load_failed without forwarding its text', () => {
  const { result, dlopenCalls } = load({ binaryPath: BIN, sha256: BIN_SHA }, { dlopenThrows: true });
  assertPlainFailure(result, 'load_failed');
  assert.deepEqual(dlopenCalls, [BIN]);
});

test('L4 loader: wrong exports / ABI tag / missing function is abi_mismatch', () => {
  const missing = fakeNative().native; delete missing.createPrivateFileExclusive;
  const notFn = { ...fakeNative().native, inspectDir: 'x' };
  for (const exportsValue of [null, undefined, 'x', {}, { ...fakeNative().native, abi: 'other' }, missing, notFn]) {
    const { result } = load({ binaryPath: BIN, sha256: BIN_SHA }, { exportsValue });
    assertPlainFailure(result, 'abi_mismatch');
  }
});

test('L5 loader: valid stub loads once at the exact path; api is frozen with exactly the four functions', () => {
  const { native } = fakeNative();
  const { result, dlopenCalls } = load({ binaryPath: BIN, sha256: BIN_SHA }, { exportsValue: native });
  assert.equal(result.status, 'ok');
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.api));
  assert.deepEqual(keys(result.api), [...FUNCS].sort());
  assert.deepEqual(dlopenCalls, [BIN]);
});

// ------------------------------------------------------------------ positive: the four operations
test('P1 positive: inspectDir ok passes exact fields, no created, one call with the path', () => {
  const { res, calls } = run('inspectDir', () => okRaw({ extra: SECRET }));
  assert.deepEqual({ ...res }, okRaw());
  assert.ok(Object.isFrozen(res));
  assertOneCall(calls, 'inspectDir');
  assert.deepEqual(calls[0].args, [P]);
});

test('P2 positive: readPrivateFile ok forwards the same Buffer and passes max', () => {
  const bytes = Buffer.from('payload');
  const { res, calls } = run('readPrivateFile', () => okRaw({ bytes }));
  assert.deepEqual(keys(res), ['bytes', 'fileId', 'reason', 'status', 'volumeSerial', 'win32Error']);
  assert.equal(res.bytes, bytes);
  assertOneCall(calls, 'readPrivateFile');
  assert.deepEqual(calls[0].args, [P, 65536]);
});

test('P3 positive: createPrivateDir / createPrivateFileExclusive ok keep created:true', () => {
  for (const name of CREATES) {
    const { res, calls } = run(name, () => okRaw({ created: true }));
    assert.deepEqual({ ...res }, okRaw({ created: true }));
    assertOneCall(calls, name);
    assert.deepEqual(calls[0].args, ARGS[name]);
  }
});

test('P4 positive: documented refusals pass through (exists/already_exists/80, created:false; unsafe without created)', () => {
  for (const name of CREATES) {
    const { res } = run(name, () => ({ status: 'exists', reason: 'already_exists', win32Error: 80, created: false }));
    assert.deepEqual({ ...res }, { status: 'exists', reason: 'already_exists', win32Error: 80, created: false });
  }
  const { res } = run('inspectDir', () => ({ status: 'unsafe', reason: 'owner_mismatch', win32Error: 0, bytes: Buffer.from('x') }));
  assert.deepEqual({ ...res }, { status: 'unsafe', reason: 'owner_mismatch', win32Error: 0 });
});

// ------------------------------------------------------------------ invalid arguments: never reach native
test('I1 invalid args: create* -> invalid_argument created:false with zero native calls', () => {
  const longPath = 'C:\\' + 'a'.repeat(W.MAX_PATH_CHARS);
  const throwingBytes = new Proxy(new Uint8Array(1), { getPrototypeOf() { throw new Error(SECRET); } });
  const cases = [
    ['createPrivateDir', ['']], ['createPrivateDir', [42]], ['createPrivateDir', [longPath]], ['createPrivateDir', []],
    ['createPrivateFileExclusive', [P, 'abc']], ['createPrivateFileExclusive', [P, [1, 2]]], ['createPrivateFileExclusive', [P, new ArrayBuffer(1)]],
    ['createPrivateFileExclusive', [P, new Uint8Array(W.MAX_IO_BYTES + 1)]], ['createPrivateFileExclusive', ['', Buffer.from('a')]],
    ['createPrivateFileExclusive', [P, throwingBytes]],
  ];
  for (const [name, args] of cases) {
    const { api, calls } = loadApi({});
    let res;
    assert.doesNotThrow(() => { res = api[name](...args); }, `${name} threw on invalid args`);
    assertCreateFailure(res, 'invalid_argument', false);
    assert.equal(calls.length, 0, `${name}: native reached after invalid args`);
  }
});

test('I2 invalid args: inspectDir/readPrivateFile -> invalid_argument without created, zero native calls', () => {
  const cases = [['inspectDir', ['']], ['inspectDir', [null]], ['readPrivateFile', [P, -1]], ['readPrivateFile', [P, 1.5]],
    ['readPrivateFile', [P, W.MAX_IO_BYTES + 1]], ['readPrivateFile', [P, '10']], ['readPrivateFile', ['', 10]]];
  for (const [name, args] of cases) {
    const { api, calls } = loadApi({});
    assertPlainFailure(api[name](...args), 'invalid_argument');
    assert.equal(calls.length, 0);
  }
});

// ------------------------------------------------------------------ native exception / non-object / missing bool -> created:null
test('N1 create*: native throw -> native_threw created:null (UNKNOWN), text not forwarded, one call', () => {
  for (const name of CREATES) {
    const { res, calls } = run(name, () => { throw new Error(SECRET); });
    assertCreateFailure(res, 'native_threw', null);
    assertOneCall(calls, name);
  }
});

test('N2 create*: non-object or missing/non-boolean created -> native_result_invalid created:null', () => {
  const raws = [undefined, null, 42, 'ok', true, okRaw(), okRaw({ created: 'true' }), okRaw({ created: 1 }), okRaw({ created: null })];
  for (const name of CREATES) {
    for (const raw of raws) {
      const { res, calls } = run(name, () => raw);
      assertCreateFailure(res, 'native_result_invalid', null);
      assertOneCall(calls, name);
    }
  }
});

test('N3 inspect/read: native throw / non-object fail closed without a created field', () => {
  for (const name of ['inspectDir', 'readPrivateFile']) {
    assertPlainFailure(run(name, () => { throw new Error(SECRET); }).res, 'native_threw');
    assertPlainFailure(run(name, () => undefined).res, 'native_result_invalid');
  }
});

// ------------------------------------------------------------------ raw created retained across later throw / malformed fields
test('R1 create*: valid raw created true/false is kept when other fields are malformed', () => {
  const malformed = [{ status: 'bogus', reason: 'ok', win32Error: 0 }, { status: 'ok', reason: SECRET, win32Error: 0 },
    { status: 'ok', reason: 'ok', win32Error: -1 }, okRaw({ volumeSerial: 'ABCDEF0123456789' }), okRaw({ fileId: undefined })];
  for (const name of CREATES) {
    for (const created of [true, false]) {
      for (const m of malformed) {
        const { res, calls } = run(name, () => ({ ...m, created }));
        assertCreateFailure(res, 'native_result_invalid', created);
        assertOneCall(calls, name);
      }
    }
  }
});

test('R2 create*: a throwing getter/proxy trap after created is read keeps created and never escapes', () => {
  for (const name of CREATES) {
    for (const created of [true, false]) {
      const getterRaw = { created, get status() { throw new Error(SECRET); } };
      const proxyRaw = new Proxy({ created }, { get(t, k) { if (k === 'created') return t.created; throw new Error(SECRET); } });
      for (const raw of [getterRaw, proxyRaw]) {
        const { res, calls } = run(name, () => raw);
        assertCreateFailure(res, 'native_result_invalid', created);
        assertOneCall(calls, name);
      }
    }
    // created getter itself throws -> UNKNOWN
    const { res } = run(name, () => ({ get created() { throw new Error(SECRET); }, status: 'ok' }));
    assertCreateFailure(res, 'native_result_invalid', null);
  }
});

// ------------------------------------------------------------------ getters / proxies read once
function countingProxy(target) {
  const counts = {};
  const proxy = new Proxy(target, { get(t, k, r) { if (typeof k === 'string') counts[k] = (counts[k] || 0) + 1; return Reflect.get(t, k, r); } });
  return { proxy, counts };
}

test('G1 every raw property is read at most once, for all four operations', () => {
  const raws = { inspectDir: okRaw(), readPrivateFile: okRaw({ bytes: Buffer.from('b') }),
    createPrivateDir: okRaw({ created: true }), createPrivateFileExclusive: okRaw({ created: true }) };
  for (const name of FUNCS) {
    const { proxy, counts } = countingProxy(raws[name]);
    const { res } = run(name, () => proxy);
    assert.equal(res.status, 'ok', `${name}: ${JSON.stringify(res)}`);
    for (const [k, n] of Object.entries(counts)) assert.ok(n <= 1, `${name}: raw.${k} read ${n} times`);
  }
});

// Getter defined on the raw object itself (an object spread would evaluate it once and drop it).
function withGetter(raw, key, values) {
  let i = 0;
  return Object.defineProperty(raw, key, { enumerable: true, get: () => values[Math.min(i++, values.length - 1)] });
}

test('G2 value-changing getters cannot smuggle a second value into the result', () => {
  for (const name of CREATES) {
    const { res } = run(name, () => withGetter(okRaw(), 'created', [true, SECRET]));
    assert.equal(res.created, true, `${name}: created ${JSON.stringify(res.created)}`);
  }
  const { res } = run('inspectDir', () => withGetter(okRaw(), 'volumeSerial', [SERIAL, [SECRET]]));
  assert.equal(res.status, 'ok');
  assert.equal(res.volumeSerial, SERIAL);
  assert.ok(!JSON.stringify(res).includes('SECRET'));
});

// ------------------------------------------------------------------ reason leakage / malformed hex / byte field
test('M1 reason must be a native reason string; arbitrary text is never forwarded', () => {
  for (const reason of ['owner_mismatch', 'path_grammar', 'acl_not_persistent', 'already_exists', 'not_found']) {
    assert.equal(run('inspectDir', () => ({ status: 'unsafe', reason, win32Error: 0 })).res.reason, reason);
  }
  for (const reason of [SECRET, 'OK', 'native_threw', '', 5, undefined]) {
    assertPlainFailure(run('inspectDir', () => ({ status: 'unsafe', reason, win32Error: 0 })).res, 'native_result_invalid');
  }
});

test('M2 status / win32Error must be exact', () => {
  for (const raw of [{ status: 'OK', reason: 'ok', win32Error: 0 }, { status: ['ok'], reason: 'ok', win32Error: 0 },
    { status: 'unsafe', reason: 'ok', win32Error: 1.5 }, { status: 'unsafe', reason: 'ok', win32Error: 2 ** 32 }, { status: 'unsafe', reason: 'ok', win32Error: '5' }]) {
    assertPlainFailure(run('inspectDir', () => raw).res, 'native_result_invalid');
  }
});

test('M3 volumeSerial / fileId must be lowercase hex strings of exact length (no coercion)', () => {
  const bad = [{ volumeSerial: SERIAL.toUpperCase() }, { volumeSerial: SERIAL.slice(1) }, { volumeSerial: [SERIAL] },
    { volumeSerial: { toString: () => SERIAL } }, { fileId: FILEID + '0' }, { fileId: [FILEID] }, { fileId: 0 }];
  for (const b of bad) assertPlainFailure(run('inspectDir', () => okRaw(b)).res, 'native_result_invalid');
});

test('M4 readPrivateFile ok requires a Buffer; non-ok never forwards bytes', () => {
  for (const bytes of [undefined, 'abc', new Uint8Array(3), new ArrayBuffer(3), [1, 2, 3]]) {
    assertPlainFailure(run('readPrivateFile', () => okRaw({ bytes })).res, 'native_result_invalid');
  }
  const { res } = run('readPrivateFile', () => ({ status: 'unsafe', reason: 'size_limit', win32Error: 0, bytes: Buffer.from(SECRET) }));
  assert.deepEqual(keys(res), ['reason', 'status', 'win32Error']);
});
