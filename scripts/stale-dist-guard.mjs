// #1070 — tsc never removes stale output: a compiled test whose .ts was deleted keeps
// running (and keeps PASSING while its symbols still resolve), so the suite's denominator
// drifts to "whatever is on disk". Name every orphan; never delete — the message is the evidence.
import { existsSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

// Every dist/tests/**/*.js (tests and helpers alike) must have tests/<same path>.ts.
export function findStaleCompiled(repoRoot) {
  const distTests = join(repoRoot, 'dist', 'tests');
  if (!existsSync(distTests)) return [];

  return readdirSync(distTests, { recursive: true })
    .map((entry) => String(entry).split(sep).join('/'))
    .filter((rel) => rel.endsWith('.js'))
    .filter((rel) => !existsSync(join(repoRoot, 'tests', `${rel.slice(0, -3)}.ts`)))
    .sort()
    .map((rel) => {
      const kind = rel.endsWith('.test.js') ? 'test' : 'helper';
      return `stale compiled ${kind}: dist/tests/${rel} (no tests/${rel.slice(0, -3)}.ts source)`;
    });
}
