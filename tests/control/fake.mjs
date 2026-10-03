// TEST-ONLY fakes for task #1182 control-core tests. NOT a proposed production backing.
// FakeStore: serializable via optimistic validation of every read/written key at commit
// (synchronous check+apply, so atomic in one JS turn); writes live in a per-run overlay and
// are discarded on throw (rollback); uniqueness on idempotence key, decision_id and nonce.
// Stored values are JSON strings, so stored rows are serializable copies.
// cf1182ub port extension (ct1182ud): reserveScopeSlot (atomic count of active workers + live,
// unreleased reservations vs max_workers; unique on workspace/scope/command_id; overlay writes,
// so it rolls back) and global command_id/cap_id/msg_id uniqueness on insertAdmission.
// snapshotReads (opt-in): every run reads one MVCC snapshot taken at run start, while unique
// checks (consume/insert/reserve ids) see the latest committed rows, like a unique index.
// This models the port contract only; it is not SQLite/production isolation or durability.
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
export const key = (...parts) => JSON.stringify(parts);

export class FakeStore {
  constructor(options = {}) {
    this.serializable = options.serializable !== false; // negative control: false
    this.rollback = options.rollback !== false;         // negative control: false
    this.unique = options.unique !== false;             // negative control: false
    this.ssiRetryOnStaleAbort = options.ssiRetryOnStaleAbort !== false; // probe I06b sets false
    this.snapshotReads = options.snapshotReads === true;
    this.reserveMode = options.reserve ?? 'real'; // negative controls: 'noop' (hardcoded pass), 'ignore-expiry'
    this.globalIds = options.globalIds !== false;       // negative control: false
    this.committed = new Map();
    this.version = new Map();
    this.seq = 0;
    this.txCount = 0; this.runs = 0; this.commits = 0; this.reruns = 0;
    this.maxRetries = 8;
    this.faults = [];      // per-transaction fault specs, consumed in order
    this.calls = [];       // [txId, run, method]
    this.overrides = {};   // method -> (realResult, ...args) => row
    this.hook = null;      // async (method, txId, args) => void, after the yield, before the read
  }
  put(k, value) { this.committed.set(k, JSON.stringify(value)); this.version.set(k, ++this.seq); }
  get(k) { const v = this.committed.get(k); return v === undefined ? undefined : JSON.parse(v); }
  snapshot() { return JSON.stringify([...this.committed.entries()].sort()); }
  keys(prefix) { return [...this.committed.keys()].filter(k => JSON.parse(k)[0] === prefix); }
  apply(writes) {
    for (const [k, v] of writes) { this.committed.set(k, v); this.version.set(k, ++this.seq); }
  }
  async transaction(work) {
    const fault = this.faults.shift() ?? {};
    const txId = ++this.txCount;
    if (fault.commit === 'committed_without_run') return { status: 'committed', value: undefined };
    if (fault.commit === 'reject_before_run') throw new Error('injected: store unavailable');
    if (fault.commit === 'rolled_back_without_run') return { status: 'rolled_back', cause: 'injected' };
    let forced = fault.forceReruns ?? 0;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const start = this.seq;
      const reads = new Set();
      const writes = new Map();
      const state = { closed: false };
      const snap = this.snapshotReads ? new Map(this.committed) : null;
      const tx = this.makeTx(txId, attempt, reads, writes, state, snap);
      this.runs++;
      let value;
      const stale = () => this.serializable
        && [...reads, ...writes.keys()].some(k => (this.version.get(k) ?? 0) > start);
      try { value = await work(tx); } catch (cause) {
        state.closed = true;
        if (!this.rollback) this.apply(writes); // negative control only: leaks partial writes
        // SSI model: a run that read data a concurrent commit changed is a serialization
        // failure (e.g. PostgreSQL reports 40001, not 23505, for such unique races) and is re-run.
        if (this.ssiRetryOnStaleAbort && stale()) { this.reruns++; continue; }
        // Outcome faults for a run that aborted (the core must not read these as a confirmed rollback).
        switch (fault.abortOutcome) {
          case 'commit_uncertain': return { status: 'commit_uncertain', cause: 'injected' };
          case 'throw': throw new Error('injected: store threw after an aborted run');
          case 'bogus': return { status: 'rolled_back?', cause };
          case 'missing': return {};
          default: break;
        }
        return { status: 'rolled_back', cause };
      }
      state.closed = true;
      const conflict = stale();
      if (conflict || forced > 0) { forced--; this.reruns++; continue; }
      switch (fault.commit) {
        case 'throw': throw new Error('injected: commit transport failure, nothing applied');
        case 'throw_after_apply': this.apply(writes); throw new Error('injected: commit applied, ack lost');
        case 'uncertain_applied': this.apply(writes); return { status: 'commit_uncertain', cause: 'injected' };
        case 'uncertain_not_applied': return { status: 'commit_uncertain', cause: 'injected' };
        case 'rolled_back': return { status: 'rolled_back', cause: 'injected' };
        case 'bogus': return { status: 'committed?', value };
        case 'bogus_applied': this.apply(writes); return { status: 'rolled_back_maybe', value };
        case 'null': return null;
        case 'getter_throws': return Object.defineProperty({}, 'status', { get() { throw new Error('boom'); } });
        default: break;
      }
      this.apply(writes); this.commits++;
      return { status: 'committed', value };
    }
    return { status: 'rolled_back', cause: 'serialization_retries_exhausted' };
  }
  makeTx(txId, run, reads, writes, state, snap) {
    const store = this;
    const parse = v => (v === undefined ? undefined : JSON.parse(v));
    const read = k => {
      reads.add(k);
      if (writes.has(k)) return JSON.parse(writes.get(k));
      return snap ? parse(snap.get(k)) : store.get(k);
    };
    // Unique-index probe: latest committed row (plus own overlay), never the run snapshot.
    const uread = k => {
      reads.add(k);
      if (writes.has(k)) return JSON.parse(writes.get(k));
      return store.get(k);
    };
    const write = (k, value) => {
      const text = JSON.stringify(value);
      if (store.rollback) writes.set(k, text); else store.apply([[k, text]]);
    };
    const call = async (name, args, real) => {
      if (state.closed) throw new Error(`tx.${name} used after close`);
      store.calls.push([txId, run, name]);
      await yieldTurn();
      if (store.hook) await store.hook(name, txId, args);
      if (state.closed) throw new Error(`tx.${name} used after close`);
      const result = real();
      return store.overrides[name] ? store.overrides[name](result, ...args) : result;
    };
    return {
      grant: (u, ws) => call('grant', [u, ws], () => read(key('grant', u, ws)) ?? null),
      runtimeEnrolled: (ws, rt) => call('runtimeEnrolled', [ws, rt], () => read(key('enrolled', ws, rt)) === true),
      admission: k => call('admission', [k], () => read(key('adm', k.user_id, k.workspace_id, k.runtime_id, k.idem_key)) ?? null),
      configRevision: (ws, rt) => call('configRevision', [ws, rt], () => read(key('config_rev', ws, rt))),
      taskRevision: (ws, t) => call('taskRevision', [ws, t], () => read(key('task_rev', ws, t)) ?? null),
      scope: (ws, id) => call('scope', [ws, id], () => read(key('scope', ws, id)) ?? null),
      scopeUsage: (ws, id) => call('scopeUsage', [ws, id], () => read(key('usage', ws, id)) ?? { active_workers: 0, spent: null }),
      decision: (ws, id) => call('decision', [ws, id], () => {
        const row = read(key('decision', ws, id));
        if (row === undefined) return null;
        return { record: row.record, revoked: row.revoked, consumed: read(key('consumed_id', id)) !== undefined };
      }),
      consumeDecision: input => call('consumeDecision', [input], () => {
        const used = uread(key('consumed_id', input.decision_id)) !== undefined
          || uread(key('consumed_nonce', input.nonce)) !== undefined;
        if (used && store.unique) return 'conflict';
        write(key('consumed_id', input.decision_id), input);
        write(key('consumed_nonce', input.nonce), input);
        return 'consumed';
      }),
      reserveScopeSlot: input => call('reserveScopeSlot', [input], () => {
        if (store.reserveMode === 'noop') return 'reserved'; // negative control only: hardcoded pass, no write
        const one = key('resv', input.workspace_id, input.scope_id, input.command_id);
        if (uread(one) !== undefined && store.globalIds) return 'id_collision';
        // One index row per workspace/scope: every reserve reads and rewrites it, so concurrent
        // reservations conflict at commit validation (serializable) and the loser is re-run.
        const index = key('resv_idx', input.workspace_id, input.scope_id);
        const held = read(index) ?? [];
        const usage = read(key('usage', input.workspace_id, input.scope_id)) ?? { active_workers: 0, spent: null };
        const live = held.filter(r => r.released !== true
          && (store.reserveMode === 'ignore-expiry' || r.not_after_ms > input.reserved_at_ms)).length;
        if (usage.active_workers + live >= input.max_workers) return 'cap_reached';
        write(index, [...held, { ...input, released: false }]);
        write(one, input);
        return 'reserved';
      }),
      insertAdmission: record => call('insertAdmission', [record], () => {
        const k = record.key;
        const id = key('adm', k.user_id, k.workspace_id, k.runtime_id, k.idem_key);
        if (uread(id) !== undefined && store.unique) return 'conflict';
        const r = record.receipt;
        const gids = [key('gid', 'command_id', r.command_id), key('gid', 'cap_id', r.cap_id), key('gid', 'msg_id', r.msg_id)];
        if (store.globalIds && gids.some(g => uread(g) !== undefined)) return 'id_collision';
        for (const g of gids) write(g, { workspace_id: k.workspace_id, user_id: k.user_id, idem_key: k.idem_key });
        write(id, { request_sha256: record.request_sha256, receipt: record.receipt, capability: record.capability });
        write(key('admrec', record.receipt.command_id), record);
        return 'inserted';
      }),
    };
  }
}

let idCounter = 0;
/** Deterministic lowercase UUIDv4 allocator, unique across the process unless `fixed` is given. */
export function makeIds(fixed = null) {
  const ids = { count: 0, fixed: fixed ? [...fixed] : null, uuid() {
    ids.count++;
    if (ids.fixed) return ids.fixed[(ids.count - 1) % ids.fixed.length];
    return `00000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`;
  } };
  return ids;
}
export function makeClock(start) {
  const clock = { t: start, seq: [], count: 0, nowMs() { clock.count++; return clock.seq.length ? clock.seq.shift() : clock.t; } };
  return clock;
}
export function makeAuth() {
  const auth = { count: 0, failAt: new Set(), valid: true, mode: null, async recheck(principal) {
    auth.count++;
    auth.last = principal;
    if (auth.mode === 'throw') throw new Error('auth backend down');
    if (auth.mode !== null) return auth.mode;
    return auth.valid && !auth.failAt.has(auth.count);
  } };
  return auth;
}
