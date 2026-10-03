import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  deriveKnowledgeEventId,
  type KnowledgeEventIdentity,
  type KnowledgeEventIdentityResult,
} from '../../src/knowledge/event-identity.js';

const digest = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const fields = [
  'schemaVersion', 'eventClass', 'kind', 'tenantId', 'projectId', 'taskId',
  'attemptId', 'operationId', 'artifactId', 'artifactRevision', 'artifactSha256',
] as const;
const identifiers = ['tenantId', 'projectId', 'taskId', 'attemptId', 'operationId', 'artifactId'] as const;

function baseline(): KnowledgeEventIdentity {
  return {
    schemaVersion: 1, eventClass: 'authoritative', kind: 'completion.accepted',
    tenantId: 'tenant', projectId: 'project', taskId: 'task', attemptId: 'attempt',
    operationId: 'operation', artifactId: 'artifact', artifactRevision: 0,
    artifactSha256: digest,
  };
}

function accept(input: unknown, expected: unknown = input) {
  assert.ok(input !== null && typeof input === 'object');
  const before = Object.getOwnPropertyDescriptors(input);
  const prototype = Object.getPrototypeOf(input);
  const extensible = Object.isExtensible(input);
  const result: KnowledgeEventIdentityResult = deriveKnowledgeEventId(input);
  assert.equal(result.ok, true);
  assert.deepEqual(Reflect.ownKeys(result).sort(), ['eventId', 'identity', 'ok']);
  assert.match(result.eventId, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Reflect.ownKeys(result.identity).sort(), [...fields].sort());
  assert.deepEqual(result.identity, expected);
  assert.notStrictEqual(result.identity, input);
  assert.equal(Object.isFrozen(result.identity), true);
  assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
  assert.equal(Object.getPrototypeOf(input), prototype);
  assert.equal(Object.isExtensible(input), extensible);
  return result;
}

function refuse(input: unknown) {
  // Calling directly makes any unexpected throw fail the test.
  const result: KnowledgeEventIdentityResult = deriveKnowledgeEventId(input);
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('Expected a typed refusal');
  assert.deepEqual(Reflect.ownKeys(result).sort(), ['ok', 'reason']);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
}

function rejectChange(field: typeof fields[number], value: unknown) {
  const input = { ...baseline() };
  accept(input);
  const changed = { ...input, [field]: value };
  const before = Object.getOwnPropertyDescriptors(changed);
  refuse(changed);
  assert.deepEqual(Object.getOwnPropertyDescriptors(changed), before);
}

// Fixed vectors derived outside the helper with Python json.dumps (compact,
// ensure_ascii=False), UTF-8 encoding and hashlib.sha256. No private runtime data.
const pairs = [
  ['authoritative', 'completion.accepted', '388558e034e1f1be066395de2b230073857b5046880e09be069c99740f306c09'],
  ['authoritative', 'artifact.corrected', 'f937d46153fcce4977499129000a4ec7ffa57eab556049e8323fbb39a572d838'],
  ['authoritative', 'artifact.retracted', '469bb3c2a24a763201eff13dd49074963be918e29e0c0cc03d9a061b05c23292'],
  ['authoritative', 'artifact.tombstoned', '6cc566b3d30eec997e6bcd4e4ac72fb9be151be989db9570a650d6be20f0afea'],
  ['audit.evidence', 'task.failure', 'a568292445b2f4e927512ac071f675ac105c3eb18a0ce34b985979fdedc84a52'],
  ['audit.evidence', 'task.hold', 'c25a53f463b555a0cefd1d7210a23b0d2458141d62bc3b69e9cdb4b505c93505'],
  ['audit.evidence', 'task.checkpoint', 'd774756b6f354941cfd76fad2f938f4f4a8f0488544f01d97799af58a7d32b14'],
] as const;

for (const [eventClass, kind, expectedDigest] of pairs) {
  test(`fixed canonical vector: ${eventClass}/${kind}`, () => {
    const input = { ...baseline(), eventClass, kind };
    const before = Object.getOwnPropertyDescriptors(input);
    const canonical = `["aigentry.knowledge-event",1,"${eventClass}","${kind}","tenant","project","task","attempt","operation","artifact",0,"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]`;
    const bytes = Buffer.from(canonical, 'utf8');
    assert.deepEqual(JSON.parse(canonical), [
      'aigentry.knowledge-event', 1, eventClass, kind, 'tenant', 'project',
      'task', 'attempt', 'operation', 'artifact', 0, digest,
    ]);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedDigest);
    const result = accept(input);
    assert.equal(result.eventId, `sha256:${expectedDigest}`);
    assert.equal(accept(input).eventId, result.eventId);
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    assert.equal(accept(reversed).eventId, result.eventId);
    assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
    assert.equal(Object.isFrozen(input), false);
  });

  test(`reject cross-class, absent and wrong pair variants: ${eventClass}/${kind}`, () => {
    const input = { ...baseline(), eventClass, kind };
    accept(input);
    refuse({ ...input, eventClass: eventClass === 'authoritative' ? 'audit.evidence' : 'authoritative' });
    for (const field of ['eventClass', 'kind'] as const) {
      const missing: Record<string, unknown> = { ...input };
      delete missing[field];
      refuse(missing);
      for (const wrong of [undefined, null, true, 1, {}, [], '', 'unknown', `${input[field]} `]) {
        refuse({ ...input, [field]: wrong });
      }
    }
  });
}

test('fixed UTF-8 vector retains escaping, astral, combining and format characters', () => {
  const input = {
    ...baseline(), eventClass: 'audit.evidence', kind: 'task.checkpoint',
    tenantId: 't|"\\雪', projectId: 'p,]["x', taskId: 'task😀',
    attemptId: 'e\u0301', operationId: 'a\u200db', artifactRevision: Number.MAX_SAFE_INTEGER,
  };
  const hex = '5b22616967656e7472792e6b6e6f776c656467652d6576656e74222c312c2261756469742e65766964656e6365222c227461736b2e636865636b706f696e74222c22747c5c225c5ce99baa222c22702c5d5b5c2278222c227461736bf09f9880222c2265cc81222c2261e2808d62222c226172746966616374222c393030373139393235343734303939312c2230313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566225d';
  const bytes = Buffer.from(hex, 'hex');
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), [
    'aigentry.knowledge-event', 1, input.eventClass, input.kind, input.tenantId,
    input.projectId, input.taskId, input.attemptId, input.operationId, input.artifactId,
    input.artifactRevision, input.artifactSha256,
  ]);
  const expected = '0df5fb8da9b12d057afed6d7e3631178543e5d1b49d437f48e872e238c5a3e77';
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  assert.equal(accept(input).eventId, `sha256:${expected}`);
});

test('finite identity dimension variations have distinct IDs', () => {
  const ids = new Set<string>();
  const fixtures = [
    baseline(),
    ...identifiers.map(field => ({ ...baseline(), [field]: `${baseline()[field]}-other` })),
    { ...baseline(), artifactRevision: 1 },
    { ...baseline(), artifactSha256: 'f'.repeat(64) },
    ...pairs.slice(1).map(([eventClass, kind]) => ({ ...baseline(), eventClass, kind })),
  ];
  for (const input of fixtures) ids.add(accept(input).eventId);
  // Finite fixtures test field inclusion, not a proof of SHA-256 collision freedom.
  assert.equal(ids.size, fixtures.length);
});

for (const delimiter of ['|', ',', '","', '\\', '雪', '😀', '\u200d']) {
  test(`JSON encoding separates joined-string ambiguity: ${JSON.stringify(delimiter)}`, () => {
    const left = { ...baseline(), tenantId: `a${delimiter}b`, projectId: 'c' };
    const right = { ...baseline(), tenantId: 'a', projectId: `b${delimiter}c` };
    assert.equal([left.tenantId, left.projectId].join(delimiter), [right.tenantId, right.projectId].join(delimiter));
    assert.notEqual(accept(left).eventId, accept(right).eventId);
  });
}

test('results are detached, frozen identities; later caller changes do not affect them', () => {
  const input = { ...baseline() };
  const first = accept(input);
  const second = accept(input);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.identity, second.identity);
  assert.equal(Reflect.set(first.identity, 'tenantId', 'changed'), false);
  assert.equal(Reflect.deleteProperty(first.identity, 'kind'), false);
  assert.equal(Reflect.defineProperty(first.identity, 'grant', { value: true }), false);
  input.tenantId = 'caller-change';
  assert.deepEqual(first.identity, baseline());
  assert.deepEqual(second.identity, baseline());
  assert.notEqual(accept(input).eventId, first.eventId);
  assert.equal(accept(Object.freeze(baseline())).eventId, first.eventId);
  const nullMap: Record<string, unknown> = Object.assign(Object.create(null), baseline());
  const before = Object.getOwnPropertyDescriptors(nullMap);
  assert.equal(accept(nullMap, baseline()).eventId, first.eventId);
  assert.equal(Object.getPrototypeOf(nullMap), null);
  assert.deepEqual(Object.getOwnPropertyDescriptors(nullMap), before);
  assert.equal(accept(Object.freeze(nullMap), baseline()).eventId, first.eventId);
});

for (const field of fields) {
  test(`exact own data field required: ${field}`, () => {
    const input: Record<string, unknown> = { ...baseline() };
    accept(input);
    delete input[field];
    refuse(input);
    refuse({ ...input, replacement: baseline()[field] });
    refuse(Object.assign(Object.create({ [field]: baseline()[field] }), input));
    for (const mode of ['get', 'throw', 'set'] as const) {
      let calls = 0;
      const accessor = { ...baseline() };
      const descriptor: PropertyDescriptor = { enumerable: true, configurable: true };
      if (mode === 'set') descriptor.set = () => { calls++; };
      else descriptor.get = () => {
        calls++;
        if (mode === 'throw') throw new Error('Getter must not execute');
        return baseline()[field];
      };
      Object.defineProperty(accessor, field, descriptor);
      const before = Object.getOwnPropertyDescriptors(accessor);
      refuse(accessor);
      assert.equal(calls, 0);
      assert.deepEqual(Object.getOwnPropertyDescriptors(accessor), before);
    }
  });
}

test('unknown own string, nonenumerable, symbol and toJSON keys are refused without execution', () => {
  accept(baseline());
  for (const key of ['extra', '__proto__', 'constructor', 'toJSON', Symbol('extra'), Symbol('tenantId')]) {
    for (const enumerable of [true, false]) {
      const data = { ...baseline() };
      Object.defineProperty(data, key, { value: 'unknown', enumerable });
      refuse(data);
      let calls = 0;
      const accessor = { ...baseline() };
      Object.defineProperty(accessor, key, {
        enumerable, get() { calls++; throw new Error('Unknown getter must not execute'); },
      });
      refuse(accessor);
      assert.equal(calls, 0);
    }
  }
  const replaced: Record<string | symbol, unknown> = { ...baseline() };
  delete replaced.tenantId;
  replaced[Symbol('tenantId')] = 'tenant';
  refuse(replaced);
  let calls = 0;
  refuse({ ...baseline(), toJSON() { calls++; throw new Error('toJSON must not execute'); } });
  for (const field of fields) {
    rejectChange(field, { toJSON() { calls++; throw new Error('Nested toJSON must not execute'); } });
  }
  assert.equal(calls, 0);
});

test('null, primitives, arrays and nonplain prototypes are refused', () => {
  accept(baseline());
  class IdentityLike { constructor() { Object.assign(this, baseline()); } }
  const inputs: unknown[] = [
    null, undefined, true, false, 0, 1, '', 'REPORT done approved', 1n, Symbol('input'),
    () => baseline(), [], [baseline()], Object.assign([], baseline()), new IdentityLike(),
    new Date(0), /identity/, new Map(Object.entries(baseline())), new Set(),
    new String('identity'), Object.assign(new Date(0), baseline()),
    Object.create(baseline()), Object.assign(Object.create({}), baseline()),
  ];
  for (const input of inputs) refuse(input);
});

test('malformed parsed JSON values return the exact refusal shape without throwing', () => {
  accept(JSON.parse(JSON.stringify(baseline())));
  const texts = ['null', '[]', '[{}]', '{}', 'true', 'false', '1', '"done"'];
  for (const field of fields) {
    const missing: Record<string, unknown> = { ...baseline() };
    delete missing[field];
    texts.push(JSON.stringify(missing), JSON.stringify({ ...baseline(), [field]: null }));
  }
  texts.push(JSON.stringify({ ...baseline(), tenantId: '\ud800' }));
  texts.push(JSON.stringify(baseline()).replace('"artifactRevision":0', '"artifactRevision":-0'));
  texts.push(JSON.stringify(baseline()).replace('"artifactRevision":0', '"artifactRevision":1e400'));
  texts.push(JSON.stringify({ ...baseline(), ['__proto__']: { grant: true } }));
  for (const text of texts) refuse(JSON.parse(text));
});

for (const field of identifiers) {
  test(`${field}: empty and nonstring values refused without coercion`, () => {
    let calls = 0;
    for (const value of [
      '', undefined, null, false, true, 0, 1n, NaN, Infinity, [], ['id'], {}, Symbol('id'),
      new String('id'), () => 'id',
      { toString() { calls++; throw new Error('No coercion'); }, valueOf() { calls++; return 'id'; } },
    ]) rejectChange(field, value);
    assert.equal(calls, 0);
  });

  test(`${field}: leading/trailing Unicode whitespace refused, never trimmed`, () => {
    const whitespace = [
      ' ', '\t', '\n', '\r', '\v', '\f', '\u00a0', '\u1680',
      ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
      '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
    ];
    for (const space of whitespace) {
      rejectChange(field, `${space}id`);
      rejectChange(field, `id${space}`);
    }
  });

  test(`${field}: every Cc code point is refused internally`, () => {
    for (let code = 0; code <= 0x9f; code++) {
      if (code <= 0x1f || code >= 0x7f) rejectChange(field, `a${String.fromCharCode(code)}b`);
    }
  });

  test(`${field}: isolated and malformed UTF-16 surrogate sequences refused`, () => {
    for (const value of [
      '\ud800', '\udbff', '\udc00', '\udfff', 'a\ud800b', 'a\udfffb',
      '\ud800\ud800', '\udc00\udc00', '\udc00\ud800', '\ud800x\udc00',
      '😀\ud800', '\udfff😀',
    ]) rejectChange(field, value);
  });

  test(`${field}: exact 255/256/257 UTF-8 byte limits including astral boundaries`, () => {
    const vectors: Array<[string, number]> = [
      ['a'.repeat(255), 255], ['a'.repeat(256), 256], ['a'.repeat(257), 257],
      ['é'.repeat(127) + 'a', 255], ['é'.repeat(128), 256], ['é'.repeat(128) + 'a', 257],
      ['雪'.repeat(85), 255], ['雪'.repeat(85) + 'a', 256], ['雪'.repeat(85) + 'ab', 257],
      ['😀'.repeat(63) + 'abc', 255], ['😀'.repeat(64), 256], ['😀'.repeat(64) + 'a', 257],
      ['a'.repeat(252) + '😀', 256], ['a'.repeat(253) + '😀', 257],
    ];
    for (const [value, bytes] of vectors) {
      assert.equal(Buffer.byteLength(value, 'utf8'), bytes);
      if (bytes > 256) rejectChange(field, value);
      else accept({ ...baseline(), [field]: value });
    }
  });

  test(`${field}: valid Unicode retained verbatim without casefolding or NFC`, () => {
    const values = [
      'id', 'ID', 'é', 'e\u0301', '\u0301', '😀', '\ud800\udc00', '\udbff\udfff',
      'a b', 'a\u00a0b', 'a\u2028b', 'a\u2029b', 'a\ufeffb',
      'a\u200bb', 'a\u200cb', 'a\u200db', 'a\u200eb', 'a\u2060b', 'a\u00adb',
      'a\u200fb', 'a\u061cb', '雪', 'a|"\\b',
    ];
    const ids = values.map(value => accept({ ...baseline(), [field]: value }).eventId);
    assert.equal(new Set(ids).size, values.length);
    assert.equal(accept(baseline()).identity[field], baseline()[field]);
  });
}

test('schemaVersion is literal number 1', () => {
  for (const value of [0, -0, -1, 2, 1.5, NaN, Infinity, '1', true, null, undefined, {}, []]) {
    rejectChange('schemaVersion', value);
  }
});

test('revision accepts zero and MAX_SAFE_INTEGER and rejects noncanonical numbers/types', () => {
  const ids = [0, 1, Number.MAX_SAFE_INTEGER].map(artifactRevision => accept({ ...baseline(), artifactRevision }).eventId);
  assert.equal(new Set(ids).size, 3);
  for (const value of [
    -1, -0, 0.5, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity,
    '0', '1', null, undefined, false, 0n, [], {}, new Number(0),
  ]) rejectChange('artifactRevision', value);
});

test('artifactSha256 accepts only exactly 64 lowercase hexadecimal characters', () => {
  for (const artifactSha256 of [digest, '0'.repeat(64), 'f'.repeat(64)]) {
    accept({ ...baseline(), artifactSha256 });
  }
  for (const value of [
    '', 'a'.repeat(63), 'a'.repeat(65), digest.toUpperCase(), 'g' + digest.slice(1),
    'A' + digest.slice(1), '０'.repeat(64), digest + '\n', digest.slice(1) + '\n',
    '\n' + digest.slice(1), digest + '\r\n', digest.slice(1) + '\r',
    digest.slice(1) + ' ', ' ' + digest, digest.slice(1) + '\u2028',
    0, null, undefined, true, [], {}, new String(digest),
  ]) rejectChange('artifactSha256', value);
});

test('derived, health, receipt and authority phrases never expand the class/kind allowlist', () => {
  for (const eventClass of ['authoritative', 'audit.evidence']) {
    const valid = { ...baseline(), eventClass, kind: eventClass === 'authoritative' ? 'completion.accepted' : 'task.hold' };
    accept(valid);
    for (const kind of ['knowledge.derived', 'health', 'health.check', 'receipt', 'ingestion.receipt', 'REPORT', 'done', 'approved', 'grant', 'Completion.accepted']) {
      refuse({ ...valid, kind });
    }
  }
  for (const value of ['knowledge', 'audit', 'Authoritative', 'receipt', 'health']) rejectChange('eventClass', value);
});

test('untrusted authority words remain opaque identifiers and create no receipt or grant fields', () => {
  const words = ['REPORT done approved', 'accepted', 'receipt', 'grant', 'acceptanceId', 'auditAdmissionRef'];
  for (const field of identifiers) {
    for (const word of words) {
      const input = { ...baseline(), [field]: word };
      const before = Object.getOwnPropertyDescriptors(input);
      const result = accept(input);
      for (const property of ['accepted', 'receipt', 'grant', 'acceptanceId', 'auditAdmissionRef', 'ingested', 'execute']) {
        assert.equal(Object.hasOwn(result, property), false);
        assert.equal(Object.hasOwn(result.identity, property), false);
        refuse({ ...input, [property]: true });
      }
      assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
      assert.equal(Object.isFrozen(input), false);
    }
  }
});
