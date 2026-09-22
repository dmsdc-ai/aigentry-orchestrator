// Synthetic SQLite substrate qualification only; no product imports or live state.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const candidate = 'v24.21.0';
const self = fileURLToPath(import.meta.url);
const mode = process.argv[2];
const evidence = {
  scope: 'synthetic API/build substrate; not installed product qualification',
  candidate, node: process.version, platform: process.platform, arch: process.arch,
  versions: process.versions, checks: [],
  unqualified: ['product behavior', 'TypeScript declarations', 'installed CLI',
    'hard-kill/hot-journal recovery', 'storage-error handling', 'VM/power-loss durability'],
};

function child(args, timeout = 5000) {
  const result = spawnSync(process.execPath, [self, ...args], {
    encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

// A separate supervisor enforces the bound even if synchronous SQLite blocks.
if (!mode) {
  const directory = mkdtempSync(join(tmpdir(), 'advisor-sqlite-capability-'));
  let failed = false;
  try {
    const result = child(['--fixture', directory], 110000);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ ...evidence, passed: false, error: error.message }));
  } finally {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch (error) { failed = true; console.error(`Fixture cleanup failed: ${error.message}`); }
  }
  if (failed) process.exitCode = 1;
} else {
  let db;
  try {
    assert.equal(process.version, candidate, 'Run only on the exact candidate');
    const { DatabaseSync } = await import('node:sqlite');
    assert.equal(typeof DatabaseSync, 'function');
    const directory = process.argv[3];
    assert.ok(directory);
    const path = join(directory, 'synthetic.sqlite');
    const scalar = (sql) => Object.values(db.prepare(sql).get())[0];
    function open(readOnly = false) {
      db = new DatabaseSync(path, { readOnly, timeout: 100 });
      for (const method of ['prepare', 'exec', 'close']) assert.equal(typeof db[method], 'function');
      if (!readOnly) {
        db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;');
        if (process.platform === 'darwin') db.exec('PRAGMA fullfsync=ON;');
        const settings = {
          journal_mode: scalar('PRAGMA journal_mode'), synchronous: scalar('PRAGMA synchronous'),
          foreign_keys: scalar('PRAGMA foreign_keys'), busy_timeout: scalar('PRAGMA busy_timeout'),
          fullfsync: scalar('PRAGMA fullfsync'),
        };
        assert.equal(settings.journal_mode, 'delete');
        assert.equal(settings.synchronous, 3);
        assert.equal(settings.foreign_keys, 1);
        assert.equal(settings.busy_timeout, 100);
        if (process.platform === 'darwin') assert.equal(settings.fullfsync, 1);
        evidence.pragmas = settings;
      }
    }
    function snapshot() {
      return {
        state: { ...db.prepare('SELECT * FROM fixture_state').get() },
        requests: db.prepare('SELECT * FROM fixture_requests ORDER BY id').all().map(row => ({ ...row })),
      };
    }
    function transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = work(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    function mutate(id, payload, expected, enabled, charge) {
      return transaction(() => {
        const prior = db.prepare('SELECT * FROM fixture_requests WHERE id=?').get(id);
        if (prior) {
          assert.equal(prior.payload, payload, 'replay-payload-conflict');
          return prior.result;
        }
        const result = db.prepare('UPDATE fixture_state SET revision=revision+1, enabled=?, charges=charges+? WHERE id=1 AND revision=?').run(enabled, charge, expected);
        assert.equal(Number(result.changes), 1, 'revision-conflict');
        const revision = scalar('SELECT revision FROM fixture_state');
        db.prepare('INSERT INTO fixture_requests VALUES(?,?,?)').run(id, payload, revision);
        return revision;
      });
    }
    if (mode === '--contender') {
      // Parent holds BEGIN IMMEDIATE throughout this independent process.
      db = new DatabaseSync(path, { timeout: 100 });
      db.exec('PRAGMA busy_timeout=100');
      assert.equal(scalar('PRAGMA busy_timeout'), 100);
      const started = performance.now();
      let refusal;
      try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); }
      catch (error) { refusal = { code: error.code, errcode: error.errcode }; }
      const elapsedMs = performance.now() - started;
      assert.ok(refusal, 'contending writer must refuse');
      assert.equal(refusal.errcode & 255, 5, 'must be SQLITE_BUSY');
      assert.ok(elapsedMs >= 70 && elapsedMs < 1500, `busy bound: ${elapsedMs}ms`);
      db.close(); db = undefined;
      console.log(JSON.stringify({ pid: process.pid, elapsedMs, refusal }));
    } else if (mode === '--reopen') {
      open(true);
      db.exec('BEGIN');
      const result = snapshot();
      db.exec('COMMIT'); db.close(); db = undefined;
      console.log(JSON.stringify(result));
    } else {
      assert.equal(mode, '--fixture');
      open();
      evidence.sqliteVersion = scalar('SELECT sqlite_version()');
      evidence.compileOptions = db.prepare('PRAGMA compile_options').all();
      assert.ok(evidence.sqliteVersion && evidence.compileOptions.length);
      const statement = db.prepare('SELECT 1 AS value');
      for (const method of ['run', 'get', 'all']) assert.equal(typeof statement[method], 'function');
      evidence.apis = ['DatabaseSync(path,{readOnly,timeout})', 'prepare', 'exec', 'run', 'get', 'all', 'close'];
      db.exec(`CREATE TABLE fixture_state(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN(0,1)), charges INTEGER NOT NULL);
        CREATE TABLE fixture_requests(id TEXT PRIMARY KEY, payload TEXT NOT NULL, result INTEGER NOT NULL);
        CREATE TABLE fixture_child(parent INTEGER REFERENCES fixture_state(id));`);
      transaction(() => db.prepare('INSERT INTO fixture_state VALUES(1,0,1,0)').run());
      assert.throws(() => db.prepare('INSERT INTO fixture_child VALUES(99)').run(),
        error => (error.errcode & 255) === 19);
      evidence.checks.push('foreign-key enforcement');
      assert.equal(mutate('reserve', 'reserve-one', 0, 1, 1), 1);
      assert.equal(mutate('disable', 'disable-only', 1, 0, 0), 2);
      const committed = snapshot();
      assert.deepEqual(committed.state, { id: 1, revision: 2, enabled: 0, charges: 1 });
      assert.equal(mutate('reserve', 'reserve-one', 0, 1, 1), 1);
      assert.throws(() => mutate('reserve', 'changed', 2, 1, 1), /replay-payload-conflict/);
      assert.throws(() => mutate('stale-cas', 'stale', 1, 1, 1), /revision-conflict/);
      assert.deepEqual(snapshot(), committed);
      db.exec('BEGIN IMMEDIATE; UPDATE fixture_state SET enabled=1, charges=999; ROLLBACK;');
      assert.deepEqual(snapshot(), committed);
      evidence.checks.push('commit', 'same-payload replay', 'changed-payload refusal', 'stale CAS refusal', 'explicit rollback');
      db.exec('BEGIN IMMEDIATE');
      try {
        evidence.contention = child(['--contender', directory]);
        assert.notEqual(evidence.contention.pid, process.pid);
      } finally { db.exec('ROLLBACK'); }
      evidence.checks.push('two-real-process bounded SQLITE_BUSY refusal');
      db.close(); db = undefined;
      open();
      assert.deepEqual(snapshot(), committed);
      assert.equal(mutate('disable', 'disable-only', 1, 0, 0), 2);
      assert.deepEqual(snapshot(), committed);
      db.close(); db = undefined;
      function files() {
        return readdirSync(directory).sort().map(name => {
          const file = join(directory, name);
          const stat = statSync(file);
          return { name, bytes: stat.size, mtimeMs: stat.mtimeMs,
            sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
        });
      }
      const before = files();
      assert.deepEqual(child(['--reopen', directory]), committed);
      open(true);
      db.exec('BEGIN');
      assert.deepEqual(snapshot(), committed);
      db.exec('COMMIT');
      assert.throws(() => db.prepare('UPDATE fixture_state SET enabled=1').run(),
        error => (error.errcode & 255) === 8);
      db.close(); db = undefined;
      assert.deepEqual(files(), before, 'readonly snapshot must preserve file set, bytes and mtime');
      evidence.checks.push('close/reopen persistence', 'replay after reopen',
        'fresh-process readonly persistence', 'readonly write refusal and unchanged files',
        'disabled preference and retained charge');
      evidence.readonlyFiles = before;
      console.log(JSON.stringify({ ...evidence, passed: true }));
    }
  } catch (error) {
    console.log(JSON.stringify({ ...evidence, passed: false,
      error: { message: error.message, code: error.code, errcode: error.errcode } }));
    process.exitCode = 1;
  } finally { if (db) db.close(); }
}
