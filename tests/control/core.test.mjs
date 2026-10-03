// #1182 — node:test adapter for the control pure-core suite (suite.mjs) run against the real tsc emit
// under dist/src/control (no fixture fallback). fake.mjs is TEST ONLY and is reached only through suite.mjs.
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSuite } from './suite.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const compiled = resolve(repoRoot, 'dist', 'src', 'control');

// Approved population (#1182, validated tests/run.mjs MAIN_IDS): exactly these 90 ids, each once, all
// passing; 84 inv plus the 6 obs ids below (observational rows must pass too and are never dropped).
const MAIN_IDS = ('V01 V02 V03 V04 V05 V06 V07 V08 V08b V09 V10 V11 V12 V13 V13o V14 V15 P01 P02 P03 P04 P05 P06 '
  + 'AU01 AU02 AU03 AU04 AU05 AU06 AU07 AU08 S01 S02 S03 CI01 CI02 CI03 CI04 CI04b CI04c CI05 CI06 R01 R02 R02b R03 '
  + 'SC01 SC02 SC03 SC04 SC04b SC04c SC05 SC05b SC05c SC06 SC07 SC08 D01 D02 D03 D04 D05 D06 D07 D08 D09 D10 '
  + 'I01 I02 I03 I04 I05 I06 I06b I06c I06d I06e H1 H2 AU07b I07 I08 I09 I10 I11 I12 I13 E01 E02').split(' ');
const OBS_IDS = ['V13o', 'R03', 'SC06', 'D08', 'I06d', 'I13'];

test('#1182 control pure-core suite: 90 approved rows (84 inv, 6 obs) against dist/src/control', async (t) => {
  const rows = await runSuite(compiled);
  assert.ok(Array.isArray(rows), `runSuite returned ${typeof rows}, expected an array of result rows`);
  assert.equal(rows.length, MAIN_IDS.length, `runSuite returned ${rows.length} rows, expected exactly ${MAIN_IDS.length}`);
  const byId = new Map();
  rows.forEach((row, i) => {
    assert.ok(row !== null && typeof row === 'object' && typeof row.id === 'string' && typeof row.kind === 'string'
      && typeof row.title === 'string' && typeof row.status === 'string', `row ${i}: malformed result row`);
    assert.ok(MAIN_IDS.includes(row.id), `row ${i}: unexpected result ${row.id}`);
    assert.ok(!byId.has(row.id), `row ${i}: duplicate result ${row.id}`);
    byId.set(row.id, row);
  });
  const missing = MAIN_IDS.filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], `missing results: ${missing.join(' ')}`);
  for (const id of MAIN_IDS) {
    const { kind, title, status, error } = byId.get(id);
    await t.test(`${kind} ${id}: ${title}`, () => {
      assert.equal(kind, OBS_IDS.includes(id) ? 'obs' : 'inv', `${id}: unexpected kind ${JSON.stringify(kind)}`);
      assert.equal(status, 'pass', `${kind} ${id} "${title}": status ${JSON.stringify(status)}${error ? ` — ${error}` : ''}`);
    });
  }
});
