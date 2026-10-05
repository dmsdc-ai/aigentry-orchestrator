// #1172 — workflow policy regression for the shipped doctrine set (AGENTS.md, docs/rules.md,
// .agents/skills/orchestrate-turn/SKILL.md). Node built-ins only; reads files, writes nothing,
// spawns nothing. Every check is a small semantic section check, and every mutation below is
// applied in memory to the real staged text: the unmodified text must pass and the mutant must fail.
//
// Scope of proof: policy TEXT and packaging DECLARATIONS only. It does not run npm pack, init or an
// installed release, and it does not prove any runtime gate is wired.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Optional override for the three policy documents only (e.g. to measure a reference policy tree).
const docsRoot = path.resolve(process.env.AIGENTRY_WORKFLOW_POLICY_DOCS || repo);
const SKILL_PATH = '.agents/skills/orchestrate-turn/SKILL.md';
const POLICY_PATHS = ['AGENTS.md', 'docs/rules.md', SKILL_PATH];
const SELF = 'tests/packaging/workflow-policy.test.mjs';

const read = (root, rel) => readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const docs = () => ({ agents: read(docsRoot, 'AGENTS.md'), rules: read(docsRoot, 'docs/rules.md'), skill: read(docsRoot, SKILL_PATH) });

// ---------- text helpers ----------
const norm = s => s.replace(/\*\*/g, '').replace(/`/g, '');
// Soft-wrapped prose lines are joined; blank lines, list items, table rows, quotes and headings stay breaks.
const sentences = s => norm(s).replace(/\n\s*\n/g, '\u0000').replace(/\n(?!\s*([-*|>#]|\d+\.)\s)/g, ' ')
  .split(/(?<=[.!?。])\s+|\n+|\u0000/).map(x => x.trim()).filter(Boolean);
const paragraphs = s => s.split(/\n\s*\n/);
const NEGATION = /\b(no|not|never|without|must not|cannot|does not|do not|don't)\b|않|금지|불가|없|아니/i;
// A paragraph explicitly marked as history/quotation is not an operative instruction.
const HISTORICAL = /\b(historical|withdrawn|superseded)\b|철회|폐기된|과거 규칙/i;
const operative = s => paragraphs(s).filter(p => !HISTORICAL.test(p)).join('\n\n');

// Fence-aware markdown section: from the heading matching re to the next heading of same/higher level.
function section(text, re) {
  const lines = text.split('\n');
  let fence = false, start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (!m) continue;
    if (start < 0) { if (re.test(lines[i])) { start = i; level = m[1].length; } }
    else if (m[1].length <= level) return lines.slice(start, i).join('\n');
  }
  return start < 0 ? '' : lines.slice(start).join('\n');
}
const lineOf = (text, re) => text.split('\n').filter(l => re.test(l)).join('\n');
const need = (problems, label, text, ...res) => { for (const re of res) if (!re.test(norm(text))) problems.push(`${label}: missing ${re}`); };
const needSection = (problems, label, text) => { if (!text) problems.push(`${label}: section not found`); return text; };

// ---------- withdrawn worker-count deliberation rule ----------
// The withdrawn rule couples a session/worker COUNT (≥3) to MANDATORY deliberation. The peer
// communication guardrail "(≥3 parties)" / "(≥3자)" is a different, retained rule and must not match.
const WITHDRAWN = [
  /(≥|>=)\s*3\s*(개\s*)?(parallel|병렬|sessions?|세션)[^\n]{0,60}deliberation/i,
  /deliberation[^\n]{0,40}(≥|>=)\s*3\s*(개\s*)?(parallel|병렬|sessions?|세션)/i,
  /(≥|>=)\s*3\s*(이면|⇒|=>|→|->)\s*deliberation/i,
  /(3\s*개\s*이상|three or more|3 or more)[^\n]{0,40}deliberation/i,
];
function checkWithdrawn(d) {
  const problems = [];
  for (const [name, text] of Object.entries(d)) {
    for (const p of paragraphs(operative(text))) {
      for (const line of norm(p).split('\n')) {
        if (WITHDRAWN.some(re => re.test(line))) problems.push(`${name}: worker-count deliberation mandate: ${line.trim().slice(0, 160)}`);
      }
    }
  }
  return problems;
}

// ---------- Rule 36 resource-based parallelism + retained guards ----------
const NO_FIXED_CAP = /고정 상한(은|을)?\s*(없|두지 않)|no fixed (worker-count )?cap/i;
const TASK_BOARD = /task board/i;
const SINGLE_WRITER = /단일 작성자|one writer|single writer|one active writer/i;
const INDEPENDENT_VALIDATION = /독립 (검증|테스트)|independent (validation|verification|testing)/i;
function checkParallel(d) {
  const problems = [];
  const r36 = needSection(problems, 'rules Rule 36', section(d.rules, /^## Rule 36\./));
  need(problems, 'rules Rule 36', r36, NO_FIXED_CAP, /CPU/, /메모리|memory/i, /API|rate limit/i, TASK_BOARD,
    SINGLE_WRITER, INDEPENDENT_VALIDATION, /worktree/, /--track/);
  const agentsList = lineOf(section(d.agents, /위임 전 체크리스트/), /Rule 36/);
  const agentsPar = section(d.agents, /^## .*병렬 위임/);
  needSection(problems, 'AGENTS Rule 36 checklist', agentsList);
  needSection(problems, 'AGENTS parallel section', agentsPar);
  need(problems, 'AGENTS Rule 36', `${agentsList}\n${agentsPar}`, NO_FIXED_CAP, /자원|resource/i, TASK_BOARD,
    SINGLE_WRITER, INDEPENDENT_VALIDATION, /worktree/, /--track/);
  const s12 = `${lineOf(d.skill, /^\|\s*1-2\s*\|/)}\n${section(d.skill, /^### 1-2\b/)}`;
  needSection(problems, 'skill 1-2', s12.trim());
  need(problems, 'skill 1-2', s12, NO_FIXED_CAP, /CPU/, /memory/i, /API/, TASK_BOARD, SINGLE_WRITER,
    INDEPENDENT_VALIDATION, /worktree isolation/i, /track/);
  // Retained peer communication cap (information-only, 3 rounds).
  need(problems, 'AGENTS peer cap', d.agents, /3\s*라운드\s*cap|3-round cap/i);
  const s23 = needSection(problems, 'skill 2-3', section(d.skill, /^### 2-3\b/));
  need(problems, 'skill 2-3', s23, /3 rounds|three-round|3-round/i, /MUST NOT delegate/);
  return problems;
}

// ---------- Rule 12 fresh-session exception ----------
const FORCE_ENTER = /강제\s*Enter|force[ds]?\s*Enter|forcedEnter/i;
const READINESS_BYPASS = /준비 검사 생략|bypass(es|ing)?\s+readiness|skip(s|ping)?\s+readiness|readiness (check )?(bypass|skip)/i;
const PERMISSION_EXPANSION = /권한 확대|expand(s|ing)? (permissions|authority)|permission expansion/i;
// Every mention of a forbidden expansion must be negated in its own sentence.
function negatedOnly(problems, label, text, concepts) {
  for (const s of sentences(text)) for (const [name, re] of concepts) {
    if (re.test(s) && !NEGATION.test(s)) problems.push(`${label}: affirmative ${name}: ${s.slice(0, 160)}`);
  }
  for (const [name, re] of concepts) {
    if (!sentences(text).some(s => re.test(s) && NEGATION.test(s))) problems.push(`${label}: no explicit prohibition of ${name}`);
  }
}
function checkFreshSession(d) {
  const problems = [];
  const r12 = needSection(problems, 'rules Rule 12', section(d.rules, /^## Rule 12\./));
  need(problems, 'rules Rule 12', r12, /\/clear/, /신규 프로세스|new process/i, /재개하지 않|resume\/continue 부재|no resumed|not resumed/i,
    /빈 대화|empty conversation/i, /task\/sid\/attempt/, /(재사용|reuse)[^.\n]{0,40}\/clear|\/clear[^.\n]{0,40}(재사용|reuse)/i);
  negatedOnly(problems, 'rules Rule 12', r12, [['forced Enter', FORCE_ENTER], ['readiness bypass', READINESS_BYPASS], ['permission expansion', PERMISSION_EXPANSION]]);
  const r121 = section(d.rules, /^### Rule 12-1\./);
  need(problems, 'rules Rule 12-1', r121, /\/clear/, /신규 세션|new session/i);
  const a12 = needSection(problems, 'AGENTS Rule 12 checklist', lineOf(d.agents, /^- \[ \].*Rule 12/));
  need(problems, 'AGENTS Rule 12', a12, /\/clear/, /신규 프로세스|new process/i, /빈 대화|empty conversation/i, /격리|confinement|task\/sid\/attempt/i, /재사용|reuse/i);
  negatedOnly(problems, 'AGENTS Rule 12', a12, [['forced Enter', FORCE_ENTER], ['readiness bypass', READINESS_BYPASS]]);
  const s12 = needSection(problems, 'skill Rule 12 paragraph', paragraphs(d.skill).filter(p => /Rule 12\b/.test(p) && !HISTORICAL.test(p)).join('\n\n'));
  need(problems, 'skill Rule 12', s12, /new process/i, /no resumed|not resumed|without resum/i, /empty conversation/i, /task\/sid\/attempt/,
    /(clear|\/clear)[^.\n]{0,40}reused|reused[^.\n]{0,60}clear/i);
  negatedOnly(problems, 'skill Rule 12', s12, [['forced Enter', FORCE_ENTER], ['readiness bypass', READINESS_BYPASS]]);
  // A forced-Enter/readiness bypass may not be granted anywhere else in the doctrine either.
  for (const [name, text] of Object.entries(d)) {
    for (const s of sentences(operative(text))) {
      if ((FORCE_ENTER.test(s) || READINESS_BYPASS.test(s)) && !NEGATION.test(s)) problems.push(`${name}: affirmative bypass: ${s.slice(0, 160)}`);
    }
  }
  return problems;
}

// ---------- bounded status clauses in the skill (MUST remain) ----------
const STATUS_SUBJECT = /dispatch-tracker|status --json|since-generation|registry rows?|\bRows\b/i;
const STATUS_CLAIM = /completion|complete|\bACK\b|acceptance|authority|ready|started|event delta|cache/i;
function checkStatusClauses(d) {
  const problems = [];
  const s = norm(d.skill);
  if (!s.includes('bin/dispatch-tracker.sh status --json --live --limit 100')) problems.push('skill: literal bounded status command missing');
  need(problems, 'skill status', d.skill, /--since-generation <G>/);
  const ss = sentences(d.skill);
  const has = (label, ...res) => { if (!ss.some(x => res.every(re => re.test(x)))) problems.push(`skill status: missing ${label}`); };
  has('--live omits retired and gated', /--live/, /exclud|omit/i, /retired/i, /gated/i);
  has('--live is not inventory/completion authority', /--live/, /never|not/i, /inventory|completion|authority/i);
  has('unchanged generation still a full scan', /unchanged generation/i, /scan: "full"|scans? the full registry|full[- ]scan/i, /not an event delta|not[^.]{0,20}(cache|cheap)/i);
  has('rows are observations, not completion/authority', /Rows are/, /observation/i, /never|not/i, /completion|authority/i);
  for (const x of ss) {
    if (STATUS_SUBJECT.test(x) && STATUS_CLAIM.test(x) && !NEGATION.test(x) && !/separate|only/i.test(x)) problems.push(`skill status: evidence/authority inflation: ${x.slice(0, 160)}`);
  }
  return problems;
}

// ---------- helper names in the skill must be real, shipped helpers ----------
async function shippedFacts() {
  const { MANIFEST } = await import(pathToFileURL(path.join(repo, 'bin/init/manifest.mjs')).href);
  const usageSrc = read(repo, 'src/tracker/usage.ts');
  const usage = /USAGE\s*=\s*`([\s\S]*?)`;/.exec(usageSrc)?.[1] ?? '';
  const subcommands = new Set([...usage.matchAll(/^#\s+dispatch-tracker\.sh\s+(\S+)/gm)].map(m => m[1]));
  const flags = new Set([...usage.matchAll(/--[a-z][a-z-]*/g)].map(m => m[0]));
  return { MANIFEST, subcommands, flags };
}
function checkHelpers(d, facts) {
  const problems = [];
  const { MANIFEST, subcommands, flags } = facts;
  const glob = g => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  const text = operative(d.skill);
  for (const m of text.matchAll(/\bbin\/[A-Za-z0-9_.*\/-]*[A-Za-z0-9_*]/g)) {
    const p = m[0];
    if (!MANIFEST.some(x => glob(p).test(x))) problems.push(`skill: helper not in init manifest: ${p}`);
  }
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
  for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) spans.push(...block[1].split('\n').filter(l => !/^\s*#/.test(l)));
  for (const span of spans) {
    const first = span.trim().split(/\s+/)[0];
    if (/^[\w.-]+\.(sh|mjs|py)$/.test(first) && !MANIFEST.some(x => x.endsWith(`/${first}`) || x === first)) problems.push(`skill: unknown helper ${first}`);
    const sub = /dispatch-tracker\.sh\s+([^\s`]+)/.exec(span)?.[1];
    if (sub && !subcommands.has(sub)) problems.push(`skill: unsupported dispatch-tracker subcommand ${sub}`);
    if (/(dispatch-tracker\.sh\s+status|^\s*status\s+--)/.test(span)) {
      for (const f of span.match(/--[a-z][a-z-]*/g) ?? []) if (!flags.has(f)) problems.push(`skill: unsupported status flag ${f}`);
    }
  }
  if (/universal[- ]?runner/i.test(text)) problems.push('skill: invented universal runner');
  return problems;
}

// ---------- packaging declaration (NOT built/installed proof) ----------
function checkPackaging(pkg, MANIFEST) {
  const problems = [];
  const files = pkg.files ?? [];
  for (const p of POLICY_PATHS) {
    const declared = files.some(f => !f.startsWith('!') && (f === p || p.startsWith(`${f.replace(/\/$/, '')}/`)));
    if (!declared) problems.push(`package.json files[] does not declare ${p}`);
    if (!MANIFEST.includes(p)) problems.push(`init MANIFEST does not list ${p}`);
  }
  return problems;
}

// ---------- runner registration ----------
// Blank comments (keeping strings) and measure brace depth so a conditional registration is caught.
function stripComments(src) {
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    out += c; i++;
  }
  return out;
}
function checkRunner(src) {
  const problems = [];
  const code = stripComments(src);
  const hits = [...code.matchAll(/(['"])tests\/packaging\/workflow-policy\.test\.mjs\1/g)];
  if (hits.length !== 1) return [`runner registers ${SELF} ${hits.length} times (expected exactly 1)`];
  const idx = hits[0].index;
  const depth = code.slice(0, idx).replace(/(['"`])(?:\\.|(?!\1).)*\1/gs, '').split('').reduce((d, c) => d + (c === '{') - (c === '}'), 0);
  if (depth !== 0) problems.push(`runner registration is conditional (brace depth ${depth})`);
  const stmt = code.slice(code.lastIndexOf(';', idx) + 1, idx);
  if (!/^\s*(sourceTestFiles\.push\(|const sourceTestFiles = \[)/.test(stmt)) problems.push('runner registration is not a sourceTestFiles entry');
  if (!/spawnSync\(process\.execPath, \['--test', \.\.\.testFiles, \.\.\.sourceTestFiles\]/.test(code)) problems.push('sourceTestFiles no longer passed to node --test');
  return problems;
}

// ======================= tests on the staged text =======================
test('withdrawn worker-count deliberation mandate is absent from operative text in all three files', () => {
  assert.deepEqual(checkWithdrawn(docs()), []);
});
test('Rule 36: resource-based parallelism, task-board fallback, retained guards and peer cap', () => {
  assert.deepEqual(checkParallel(docs()), []);
});
test('Rule 12: fresh-session exception is bound and /clear is retained for reused sessions', () => {
  assert.deepEqual(checkFreshSession(docs()), []);
});
test('skill keeps the bounded status clauses without evidence/authority inflation', () => {
  assert.deepEqual(checkStatusClauses(docs()), []);
});
test('skill names only helpers/subcommands/flags present in the staged manifest and usage', async () => {
  assert.deepEqual(checkHelpers(docs(), await shippedFacts()), []);
});
test('package.json files[] and init MANIFEST declare the three policy paths (declaration only)', async () => {
  const { MANIFEST } = await shippedFacts();
  assert.deepEqual(checkPackaging(JSON.parse(read(repo, 'package.json')), MANIFEST), []);
});
test('real runner registers this test unconditionally in sourceTestFiles', () => {
  assert.deepEqual(checkRunner(read(repo, 'scripts/run-tests.mjs')), []);
});

// ======================= discriminating mutations =======================
const dropSentences = re => t => t.split('\n').map(l => l.split(/(?<=[.!?。])\s+/).filter(s => !re.test(norm(s))).join(' ')).join('\n');
const inSection = (re, fn) => t => { const s = section(t, re); return s ? t.replace(s, fn(s)) : t; };
const append = add => s => `${s.replace(/\s*$/, '')}\n${add}\n\n`;
const appendToLine = (lineRe, add) => t => t.split('\n').map(l => (lineRe.test(l) ? `${l.replace(/\s*\|\s*$/, '')}${add} |` : l)).join('\n');

const M = [
  ['rules Rule 36 reintroduces ≥3 deliberation', 'rules', inSection(/^## Rule 36\./, append('- 병렬 세션 **≥3이면 deliberation MCP 경유**.')), checkWithdrawn],
  ['AGENTS parallel section reintroduces count tier table', 'agents', inSection(/^## .*병렬 위임/, append('| 병렬 세션 수 | 방식 |\n|---|---|\n| 3개 이상 | deliberation 경유 |')), checkWithdrawn],
  ['AGENTS workflow reintroduces ≥3 ⇒ deliberation', 'agents', inSection(/^## 워크플로우/, append('1-2 parallel-first (Rule 9; ≥3 ⇒ deliberation)')), checkWithdrawn],
  ['skill 1-2 reintroduces deliberation for ≥3 parallel sessions', 'skill', inSection(/^### 1-2\b/, append('Keep deliberation MCP for ≥3 parallel sessions.')), checkWithdrawn],
  ['skill table row reintroduces ≥3 parallel ⇒ deliberation', 'skill', appendToLine(/^\|\s*1-2\s*\|/, '; ≥3 parallel ⇒ deliberation MCP'), checkWithdrawn],
  ['rules Rule 36 drops no-fixed-cap', 'rules', inSection(/^## Rule 36\./, dropSentences(/고정 상한/)), checkParallel],
  ['rules Rule 36 drops task-board fallback', 'rules', inSection(/^## Rule 36\./, dropSentences(/task board/i)), checkParallel],
  ['rules Rule 36 drops single-writer guard', 'rules', inSection(/^## Rule 36\./, dropSentences(/단일 작성자/)), checkParallel],
  ['AGENTS drops task-board fallback', 'agents', dropSentences(/task board/i), checkParallel],
  ['AGENTS drops peer 3-round cap', 'agents', t => t.replace(/3\s*라운드\s*cap/g, 'cap'), checkParallel],
  ['skill 1-2 drops one-writer guard', 'skill', inSection(/^### 1-2\b/, dropSentences(/one writer|single writer|one active writer/i)), checkParallel],
  ['skill 1-2 drops independent verification', 'skill', t => inSection(/^### 1-2\b/, dropSentences(/independent (validation|verification)/i))(t.replace(/^(\|\s*1-2\s*\|.*)independent verification/m, '$1verification')), checkParallel],
  ['skill 2-3 drops 3-round cap', 'skill', inSection(/^### 2-3\b/, s => s.replace(/3 rounds|three-round|3-round/gi, 'some rounds')), checkParallel],
  ['rules Rule 12 drops empty-conversation binding', 'rules', inSection(/^## Rule 12\./, dropSentences(/빈 대화/)), checkFreshSession],
  ['rules Rule 12 drops reused-session /clear', 'rules', inSection(/^## Rule 12\./, dropSentences(/재사용/)), checkFreshSession],
  ['rules Rule 12 drops task/sid/attempt binding', 'rules', inSection(/^## Rule 12\./, s => s.replace(/task\/sid\/attempt/g, 'task')), checkFreshSession],
  ['rules Rule 12 grants forced Enter/readiness skip', 'rules', inSection(/^## Rule 12\./, append('검증된 신규 세션은 강제 Enter로 준비 검사 생략이 허용된다.')), checkFreshSession],
  ['rules Rule 12 drops the expansion prohibition', 'rules', inSection(/^## Rule 12\./, dropSentences(/강제 Enter|준비 검사 생략|권한 확대/)), checkFreshSession],
  ['AGENTS Rule 12 checklist drops reuse/forced-Enter limit', 'agents', t => t.split('\n').map(l => (/^- \[ \].*Rule 12/.test(l) ? dropSentences(/강제 Enter|재사용/)(l) : l)).join('\n'), checkFreshSession],
  ['skill Rule 12 drops no-resumed-history binding', 'skill', t => t.replace(/no resumed history|not resumed|without resum\w*/gi, 'any history'), checkFreshSession],
  ['skill grants forced Enter for fresh sessions', 'skill', t => `${t}\nA verified fresh session may force Enter and bypass readiness.\n`, checkFreshSession],
  ['skill drops literal bounded status command', 'skill', t => t.replaceAll('bin/dispatch-tracker.sh status --json --live --limit 100', 'bin/dispatch-tracker.sh status --json'), checkStatusClauses],
  ['skill drops unchanged-generation full-scan warning', 'skill', dropSentences(/unchanged generation/i), checkStatusClauses],
  ['skill drops --live omits gated', 'skill', t => t.replace(/retired AND gated|retired and gated/g, 'retired'), checkStatusClauses],
  ['skill inflates status rows to completion/ACK', 'skill', t => `${t}\nRegistry rows from \`status --json\` prove completion and ACK.\n`, checkStatusClauses],
  ['skill invents a universal runner helper', 'skill', t => `${t}\nCommand first: run \`bin/universal-runner.sh status\`.\n`, 'helpers'],
  ['skill uses an unsupported status flag', 'skill', t => `${t}\nThen run \`bin/dispatch-tracker.sh status --json --watch\`.\n`, 'helpers'],
  ['skill uses an unsupported tracker subcommand', 'skill', t => `${t}\nThen run \`bin/dispatch-tracker.sh tail --json\`.\n`, 'helpers'],
];

for (const [name, file, mutate, check] of M) {
  test(`mutation must fail: ${name}`, async () => {
    const base = docs();
    const run = async x => (check === 'helpers' ? checkHelpers(x, await shippedFacts()) : check(x));
    assert.deepEqual(await run(base), [], 'unmodified staged text must pass before a mutation can discriminate');
    const mutated = { ...base, [file]: mutate(base[file]) };
    assert.notEqual(mutated[file], base[file], 'mutation target not found in staged text');
    assert.ok((await run(mutated)).length > 0, 'mutant passed: check does not discriminate');
  });
}

test('control: a clearly marked historical quotation of the withdrawn rule is not operative', () => {
  const base = docs();
  assert.deepEqual(checkWithdrawn(base), []);
  const quoted = '> Historical (withdrawn 2026-09-24): the former rule read "≥3 parallel ⇒ deliberation MCP".';
  assert.deepEqual(checkWithdrawn({ ...base, skill: `${base.skill}\n\n${quoted}\n` }), []);
  assert.ok(checkWithdrawn({ ...base, skill: `${base.skill}\n\n${quoted.replace(/Historical \(withdrawn 2026-09-24\): /, '')}\n` }).length > 0);
});
test('control: the retained peer guardrail "(≥3 parties)" is not mistaken for the withdrawn rule', () => {
  const d = { agents: '', rules: '', skill: 'escalate to deliberation MCP (≥3 parties) or back to the orchestrator.\n직접 info 교환은 3라운드 cap — deliberation MCP(≥3자)' };
  assert.deepEqual(checkWithdrawn(d), []);
});
test('mutation must fail: package declaration loses AGENTS.md / init MANIFEST loses the skill', async () => {
  const { MANIFEST } = await shippedFacts();
  const pkg = JSON.parse(read(repo, 'package.json'));
  assert.deepEqual(checkPackaging(pkg, MANIFEST), []);
  assert.ok(checkPackaging({ ...pkg, files: pkg.files.filter(f => f !== 'AGENTS.md') }, MANIFEST).length > 0);
  assert.ok(checkPackaging(pkg, MANIFEST.filter(p => p !== SKILL_PATH)).length > 0);
});
test('mutation must fail: runner registration removed, duplicated or made conditional', () => {
  const src = read(repo, 'scripts/run-tests.mjs');
  assert.deepEqual(checkRunner(src), []);
  const line = `sourceTestFiles.push('${SELF}');`;
  assert.ok(src.includes(line), 'registration line not found');
  assert.ok(checkRunner(src.replace(line, '')).length > 0);
  assert.ok(checkRunner(src.replace(line, `${line}\n${line}`)).length > 0);
  assert.ok(checkRunner(src.replace(line, `if (process.platform === 'darwin') {\n  ${line}\n}`)).length > 0);
  assert.ok(checkRunner(src.replace(line, `// ${line}`)).length > 0);
});

// ======================= Rule 24 (2026-09-21 human-approved revision) =======================
// Literal policy regression only: guards against (a) the per-spec re-approval rule returning and
// (b) the in-scope autonomy widening into blanket auto-approval. Not a general NLP/security claim.
const PER_SPEC_REAPPROVAL = [/스펙 선작성 \+ 사용자 승인/, /스펙 선작성\s*→\s*(오케스트레이터 경유\s*)?사용자 승인\s*→\s*구현/,
  /오케스트레이터가 사용자에게 제시\s*→\s*사용자 승인/];
const BLANKET = /자동 승인|auto-?approv|blanket approv|모든 (변경|작업|설계)[^.\n]{0,30}(자율|승인 없이)|all (changes|work|designs)[^.\n]{0,30}(autonomous|without (further )?approval)/i;
const REVIEW_AS_CONSENT = /(controller|오케스트레이터)[^.\n]{0,30}(review|판단)[^.\n]{0,30}(counts as|is|으로 기록|으로 간주)[^.\n]{0,20}(human consent|user approval|사용자 승인)/i;
function checkRule24(d) {
  const problems = [];
  const r24 = needSection(problems, 'rules Rule 24', section(d.rules, /^## Rule 24\./));
  const a24 = needSection(problems, 'AGENTS Rule 24 checklist', lineOf(section(d.agents, /위임 전 체크리스트/), /Rule 24/));
  const s24 = needSection(problems, 'skill Rule 24 paragraph', paragraphs(d.skill).filter(p => /Rule 24\b/.test(p) && !HISTORICAL.test(p)).join('\n\n'));
  const flat = t => norm(t).replace(/\s+/g, ' ');
  const want = (label, t, ...res) => { for (const re of res) if (!re.test(flat(t))) problems.push(`${label}: missing ${re}`); };
  // (a) in-scope autonomy without per-spec re-approval
  want('rules Rule 24', r24, /이미 승인된 릴리즈 범위 안의 버그 수정·회귀 테스트·이식성 수정/, /스펙과 근거를 검토한 뒤 자율 위임/, /사용자 승인을 다시 요구하지 않/);
  want('AGENTS Rule 24', a24, /승인된 릴리즈 범위의 버그·회귀 테스트·이식성 수정/, /스펙·근거 검토 후 자율 위임/);
  want('skill Rule 24', s24, /inside an already approved release scope/, /after reviewing the spec and evidence/, /without another per-spec approval/);
  for (const [label, t] of [['rules Rule 24', r24], ['AGENTS Rule 24', a24], ['skill Rule 24', s24]]) {
    for (const re of PER_SPEC_REAPPROVAL) if (re.test(flat(t))) problems.push(`${label}: per-spec re-approval rule returned: ${re}`);
  }
  // (b) no blanket approval: separate approval, pending designs, SPEC/evidence review, honest attribution
  want('rules Rule 24', r24, /새 아키텍처·권한 확대·비용·개인정보·파괴적 변경은 Rule 47/, /대기 중인 해당 설계도[^.]{0,30}승인되지 않/,
    /오케스트레이터 판단을 새로운 사용자 승인으로 기록하지 않/, /미승인 설계/, /스펙 생략, 범위 확대 또는 미검증 완료 선언을 허용하는 예외가 아니다/);
  want('AGENTS Rule 24', a24, /새 아키텍처·권한·비용·개인정보·파괴적 변경과 기존 대기 설계는 별도 승인/, /implement 금지, 스펙 먼저/);
  want('skill Rule 24', s24, /New architecture, authority, cost, privacy or destructive changes still require Rule 47 approval/,
    /existing pending designs are not approved/, /distinguish controller review from human consent/, /SPEC FIRST\/HOLD/);
  for (const [label, t] of [['rules Rule 24', r24], ['AGENTS Rule 24', a24], ['skill Rule 24', s24]]) {
    for (const s of sentences(t)) {
      if ((BLANKET.test(s) || REVIEW_AS_CONSENT.test(s)) && !NEGATION.test(s)) problems.push(`${label}: blanket approval/consent inflation: ${s.slice(0, 160)}`);
    }
  }
  return problems;
}
// Command-first routing guidance may prefer helpers but must not ban a legitimate one-off `node -e`.
function checkOneOffAllowed(d) {
  const problems = [];
  for (const s of sentences(operative(d.skill))) {
    if (/node -e/.test(s) && NEGATION.test(s) && !/fine|allowed|permitted|remains/i.test(s)) problems.push(`skill: bans one-off node -e: ${s.slice(0, 160)}`);
  }
  return problems;
}

test('Rule 24: in-scope autonomous delegation without per-spec re-approval and without blanket approval', () => {
  assert.deepEqual(checkRule24(docs()), []);
});
test('command-first routing does not ban a legitimate one-off node -e', () => {
  assert.deepEqual(checkOneOffAllowed(docs()), []);
});

const OLD_AGENTS_24 = '- [ ] **스펙 선작성 + 사용자 승인** (Rule 24): "implement 금지, 스펙 먼저" 지시가 있는가?';
const M24 = [
  ['rules Rule 24 restores per-spec user approval flow', 'rules', inSection(/^## Rule 24\./, append('모든 하위 세션 작업은 **스펙 선작성 → 오케스트레이터 경유 사용자 승인 → 구현 착수** 순서로 진행.'))],
  ['rules Rule 24 drops "no re-approval per fix"', 'rules', inSection(/^## Rule 24\./, dropSentences(/다시 요구하지 않/))],
  ['rules Rule 24 widens scope to all changes', 'rules', t => t.replace('이미 승인된 릴리즈 범위 안의 버그 수정·회귀 테스트·이식성 수정은', '모든 변경은')],
  ['rules Rule 24 drops Rule 47 separate approval', 'rules', inSection(/^## Rule 24\./, dropSentences(/Rule 47/))],
  ['rules Rule 24 drops pending-design exclusion', 'rules', inSection(/^## Rule 24\./, dropSentences(/대기 중인/))],
  ['rules Rule 24 drops controller-judgment-is-not-consent', 'rules', inSection(/^## Rule 24\./, dropSentences(/오케스트레이터 판단을/))],
  ['rules Rule 24 adds blanket auto-approval', 'rules', inSection(/^## Rule 24\./, append('- 승인 범위 밖의 새 설계도 오케스트레이터가 자동 승인한다.'))],
  ['AGENTS Rule 24 checklist reverts to per-spec approval', 'agents', t => t.split('\n').map(l => (/^- \[ \].*Rule 24/.test(l) ? OLD_AGENTS_24 : l)).join('\n')],
  ['AGENTS Rule 24 drops separate approval for new/pending designs', 'agents', t => t.replace('새 아키텍처·권한·비용·개인정보·파괴적 변경과 기존 대기 설계는 별도 승인하며, ', '')],
  ['skill drops Rule 24 paragraph', 'skill', t => paragraphs(t).filter(p => !/Rule 24\b/.test(p)).join('\n\n')],
  ['skill restores per-spec approval', 'skill', t => t.replace(/without another per-spec approval/, 'only after a per-spec approval')],
  ['skill drops Rule 47 caveat', 'skill', t => t.replace(/New architecture, authority, cost, privacy or\s+destructive changes still require Rule 47 approval;/, '')],
  ['skill treats controller review as human consent', 'skill', t => t.replace(/(Rule 24 \(human revision 2026-09-21\):)/, '$1 Controller review counts as human consent.')],
];
for (const [name, file, mutate] of M24) {
  test(`mutation must fail: ${name}`, () => {
    const base = docs();
    assert.deepEqual(checkRule24(base), [], 'unmodified staged text must pass before a mutation can discriminate');
    const mutated = { ...base, [file]: mutate(base[file]) };
    assert.notEqual(mutated[file], base[file], 'mutation target not found in staged text');
    assert.ok(checkRule24(mutated).length > 0, 'mutant passed: check does not discriminate');
  });
}
test('mutation must fail: routing guidance bans one-off node -e', () => {
  const base = docs();
  assert.deepEqual(checkOneOffAllowed(base), []);
  const banned = `${base.skill}\nNever use \`node -e\`; always route through a helper.\n`;
  assert.ok(checkOneOffAllowed({ ...base, skill: banned }).length > 0);
});

// R3: every inline invocation of the tracker's status helper must be the literal bounded command;
// a bare `bin/dispatch-tracker.sh status` (e.g. called "bounded" in routing guidance) is not bounded.
const BOUNDED_STATUS = 'bin/dispatch-tracker.sh status --json --live --limit 100';
function checkBoundedStatusLiteral(d) {
  const problems = [];
  for (const m of operative(d.skill).matchAll(/`(bin\/dispatch-tracker\.sh status[^`]*)`/g)) {
    if (!m[1].startsWith(BOUNDED_STATUS)) problems.push(`skill: status helper not the literal bounded command: ${m[1]}`);
  }
  return problems;
}
test('every inline bin/dispatch-tracker.sh status invocation is the literal bounded command', () => {
  assert.deepEqual(checkBoundedStatusLiteral(docs()), []);
});
test('mutation must fail: routing guidance names bare status as bounded', () => {
  const base = docs();
  assert.deepEqual(checkBoundedStatusLiteral(base), []);
  const routing = paragraphs(base.skill).find(p => /Operation routing/.test(p) && p.includes(`\`${BOUNDED_STATUS}\``));
  assert.ok(routing, 'routing paragraph with the bounded literal not found in staged text');
  const bare = base.skill.replace(routing, routing.replace(`\`${BOUNDED_STATUS}\``, 'bounded `bin/dispatch-tracker.sh status`'));
  assert.ok(checkBoundedStatusLiteral({ ...base, skill: bare }).length > 0, 'mutant passed: bare status not caught');
});
