import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { consoleId, type ConsoleConfig, type ConsolePage, type ConsoleTask, type ConsoleView } from './console-contracts.js';

const MAX_SOURCE = 4 * 1024 * 1024;
const MAX_ROWS = 10000;
const REFRESH_MS = 15000;
const BUDGET_MS = 2000;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export class ConsoleError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Reject duplicate keys/deep input instead of accepting ambiguous security configuration. */
function parseJson(raw: string): unknown {
  const tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{' || token === '[') {
      if (stack.length >= 32) throw new Error('source_depth');
      stack.push(token === '{' ? new Set() : null);
    } else if (token === '}' || token === ']') stack.pop();
    else if (token?.startsWith('"') && tokens[i + 1] === ':') {
      const keys = stack.at(-1), key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) throw new Error('duplicate_key');
      keys.add(key);
    }
  }
  return JSON.parse(raw) as unknown;
}

/** Bounded regular-file read with component and descriptor identity checks before/after. */
async function sourceFile(path: string, max: number): Promise<unknown> {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096) throw new Error('invalid_source');
  const deadline = Date.now() + BUDGET_MS;
  const checkTime = (): void => { if (Date.now() > deadline) throw new Error('source_timeout'); };
  async function chain(): Promise<string> {
    let current = parse(path).root;
    const identities: string[] = [];
    for (const part of relative(current, dirname(path)).split(sep).filter(Boolean)) {
      checkTime();
      current = join(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_source');
      identities.push(`${info.dev}:${info.ino}`);
    }
    if (await realpath(path) !== path) throw new Error('unsafe_source');
    return identities.join('/');
  }
  const parents = await chain(), before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > max || before.nlink !== 1) throw new Error('unsafe_source');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await file.stat();
    if (!initial.isFile() || initial.dev !== before.dev || initial.ino !== before.ino || initial.size > max) throw new Error('source_changed');
    const bytes = Buffer.alloc(max + 1);
    let used = 0;
    while (used < bytes.length) {
      checkTime();
      const read = await file.read(bytes, used, bytes.length - used, null);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const after = await file.stat(), named = await lstat(path);
    if (used > max || used !== initial.size || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs ||
        named.isSymbolicLink() || named.dev !== initial.dev || named.ino !== initial.ino || await chain() !== parents) throw new Error('source_changed');
    checkTime();
    const result = parseJson(bytes.subarray(0, used).toString('utf8'));
    checkTime();
    return result;
  } finally { await file.close(); }
}

export function validateConsoleConfig(value: unknown): ConsoleConfig {
  if (!object(value) || !Array.isArray(value.projects) || !Array.isArray(value.grants) || value.projects.length > 32 || value.grants.length > 128) throw new Error('invalid_console_config');
  const projects: ConsoleConfig['projects'][number][] = [];
  const ids = new Set<string>();
  let total = 0;
  for (const project of value.projects) {
    if (!object(project) || !consoleId(project.id) || ids.has(project.id) || typeof project.taskQueue !== 'string' || !isAbsolute(project.taskQueue) ||
        resolve(project.taskQueue) !== project.taskQueue || project.taskQueue.length > 4096 || !Array.isArray(project.taskIds) || !project.taskIds.every(consoleId) ||
        (total += project.taskIds.length) > MAX_ROWS || new Set(project.taskIds).size !== project.taskIds.length) throw new Error('invalid_console_config');
    ids.add(project.id);
    projects.push(Object.freeze({ id: project.id, taskQueue: project.taskQueue, taskIds: Object.freeze([...project.taskIds]) }));
  }
  const principals = new Set<string>();
  const grants: ConsoleConfig['grants'][number][] = [];
  for (const grant of value.grants) {
    if (!object(grant) || !consoleId(grant.principalId) || principals.has(grant.principalId) || !Array.isArray(grant.projects) || grant.projects.length > 32 ||
        !grant.projects.every(id => typeof id === 'string' && ids.has(id)) || new Set(grant.projects).size !== grant.projects.length) throw new Error('invalid_console_config');
    principals.add(grant.principalId);
    grants.push(Object.freeze({ principalId: grant.principalId, projects: Object.freeze([...grant.projects]) }));
  }
  return Object.freeze({ projects: Object.freeze(projects), grants: Object.freeze(grants) });
}

export async function readConsoleConfig(path: string): Promise<ConsoleConfig> {
  try { return validateConsoleConfig(await sourceFile(path, 1024 * 1024)); }
  catch { throw new Error('invalid_console_config'); }
}

interface Snapshot { items: ConsoleTask[]; revision: string; fetchedAt: string; until: number; coverage: ConsolePage['coverage']; warnings: string[] }
const statuses = new Set(['pending', 'queued', 'delegated', 'in_progress', 'blocked', 'blocked-by-observation', 'done', 'completed', 'failed', 'cancelled', 'superseded']);

export function createConsoleReader(input: ConsoleConfig) {
  const config = validateConsoleConfig(input);
  const key = randomBytes(32);
  const cache = new Map<string, Snapshot>();
  const pending = new Map<string, Promise<Snapshot>>();
  function projects(principal: string): string[] {
    return [...(config.grants.find(grant => grant.principalId === principal)?.projects ?? [])];
  }
  function authorize(principal: string, project: string): ConsoleConfig['projects'][number] {
    if (!projects(principal).includes(project)) throw new ConsoleError(403, 'forbidden');
    const entry = config.projects.find(item => item.id === project);
    if (!entry) throw new ConsoleError(403, 'forbidden');
    return entry;
  }
  async function refresh(project: ConsoleConfig['projects'][number]): Promise<Snapshot> {
    const prior = cache.get(project.id);
    if (prior && prior.until > Date.now()) return prior;
    const ongoing = pending.get(project.id);
    if (ongoing) return ongoing;
    // Bound aggregate transient source buffers as well as concurrent requests.
    if (pending.size >= 2) throw new ConsoleError(429, 'reader_busy');
    const work = (async (): Promise<Snapshot> => {
      const items: ConsoleTask[] = [], warnings: string[] = [];
      let coverage: ConsolePage['coverage'] = 'complete';
      try {
        const data = await sourceFile(project.taskQueue, MAX_SOURCE);
        if (!object(data) || !Array.isArray(data.tasks) || (data.completed !== undefined && !Array.isArray(data.completed))) throw new Error('invalid_queue');
        const archived = Array.isArray(data.completed) ? data.completed : [];
        if (data.tasks.length + archived.length > MAX_ROWS) throw new Error('source_limit');
        const allowed = new Set(project.taskIds), seen = new Set<string>(), conflicts = new Set<string>();
        for (const [rows, archive] of [[data.tasks, false], [archived, true]] as const) {
          for (const raw of rows) {
            if (!object(raw)) continue;
            const id = typeof raw.id === 'number' && Number.isSafeInteger(raw.id) ? String(raw.id) : raw.id;
            if (!consoleId(id)) continue;
            if (!allowed.has(id)) continue;
            if (seen.has(id)) { conflicts.add(id); continue; }
            seen.add(id);
            const status = typeof raw.status === 'string' && statuses.has(raw.status) ? raw.status : 'unknown';
            const updated = typeof raw.updated_at === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(raw.updated_at) && Number.isFinite(Date.parse(raw.updated_at)) ? raw.updated_at : null;
            // Notes, titles, prompts, source paths and arbitrary metadata never cross this boundary.
            const row: ConsoleTask = {
              taskId: id, projectId: project.id, revision: '', title: null, recordedStatus: status, archive,
              lifecycle: !archive && (status === 'pending' || status === 'queued') ? status : 'unknown',
              updatedAt: updated, observedAt: null, attempt: null, sid: null, operation: null, phase: null, tool: null, surface: null,
              requestedModel: null, requestedEffort: null, observedModel: null, observedEffort: null, blocker: null, resumeOwner: null, release: null,
              reasons: ['recorded_status_only', 'execution_observation_unavailable', 'acceptance_unavailable', 'redacted_title_unavailable', 'model_effort_contract_unavailable', 'blocker_contract_unavailable'],
            };
            row.revision = digest(JSON.stringify(row));
            items.push(row);
          }
        }
        for (let i = items.length - 1; i >= 0; i--) if (conflicts.has(items[i]!.taskId)) items.splice(i, 1);
        if (conflicts.size) warnings.push('conflicting_task_records');
        if (project.taskIds.some(id => !seen.has(id))) warnings.push('configured_tasks_missing');
        if (warnings.length) coverage = 'partial';
      } catch { items.length = 0; warnings.push('task_queue_unavailable'); coverage = 'unavailable'; }
      items.sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
      const uniqueWarnings = [...new Set(warnings)];
      const snapshot: Snapshot = { items, revision: digest(JSON.stringify([items, coverage, uniqueWarnings])), fetchedAt: new Date().toISOString(), until: Date.now() + REFRESH_MS, coverage, warnings: uniqueWarnings };
      cache.set(project.id, snapshot);
      return snapshot;
    })();
    pending.set(project.id, work);
    try { return await work; } finally { pending.delete(project.id); }
  }
  function sign(payload: string): string { return createHmac('sha256', key).update(payload).digest('base64url'); }
  async function read(principal: string, projectId: string, view: ConsoleView, params: URLSearchParams, id?: string): Promise<ConsolePage> {
    const project = authorize(principal, projectId);
    const allowed = ['project', 'limit', 'cursor', 'status', 'q'];
    if ([...params.keys()].some(name => !allowed.includes(name) || params.getAll(name).length !== 1) || (id !== undefined && !consoleId(id))) throw new ConsoleError(400, 'invalid_query');
    const limitText = params.get('limit') ?? '25', status = params.get('status') ?? '', q = params.get('q') ?? '';
    if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(limitText) || (status && !statuses.has(status) && status !== 'unknown') || q.length > 80 || (q && !/^[A-Za-z0-9_-]+$/.test(q))) throw new ConsoleError(400, 'invalid_query');
    const empty: ConsolePage = { schemaVersion: 1, projectId, projectionRevision: null, sourceRevisions: [], observedAt: null, fetchedAt: null, generatedAt: new Date().toISOString(), currentness: 'unknown', coverage: 'unavailable', warnings: [], items: [], total: null, nextCursor: null };
    if (view !== 'tasks') return { ...empty, warnings: [view === 'approvals' ? 'legacy_unbound_project_binding_unavailable' : `${view}_contract_unavailable`] };
    const snapshot = await refresh(project);
    const binding = digest(JSON.stringify([principal, projectId, view, status, q, Number(limitText), id ?? null]));
    let offset = 0, expires = Date.now() + 60000;
    const cursor = params.get('cursor');
    if (cursor !== null) {
      if (cursor.length > 1024) throw new ConsoleError(400, 'invalid_cursor');
      try {
        const parts = cursor.split('.');
        if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
        const payload = parts[0]!, signature = Buffer.from(parts[1]!, 'base64url'), expected = Buffer.from(sign(payload), 'base64url');
        if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error();
        const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!object(value) || value.binding !== binding || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0 || Number(value.offset) > MAX_ROWS || typeof value.expires !== 'number') throw new Error();
        if (value.revision !== snapshot.revision || value.expires <= Date.now()) throw new ConsoleError(409, 'cursor_expired');
        offset = Number(value.offset); expires = value.expires;
      } catch (error) { if (error instanceof ConsoleError) throw error; throw new ConsoleError(400, 'invalid_cursor'); }
    }
    const filtered = snapshot.items.filter(row => (!id || row.taskId === id) && (!status || row.recordedStatus === status) && (!q || row.taskId.toLowerCase().includes(q.toLowerCase())));
    if (id && !filtered.length) throw new ConsoleError(snapshot.coverage === 'complete' ? 404 : 503, snapshot.coverage === 'complete' ? 'not_found' : 'source_unavailable');
    const items = filtered.slice(offset, offset + Number(limitText));
    let nextCursor: string | null = null;
    if (offset + items.length < filtered.length) {
      const payload = Buffer.from(JSON.stringify({ binding, revision: snapshot.revision, offset: offset + items.length, expires })).toString('base64url');
      nextCursor = `${payload}.${sign(payload)}`;
    }
    const page: ConsolePage = { ...empty, projectionRevision: snapshot.revision, sourceRevisions: [{ source: 'task_queue_projection', revision: snapshot.revision }], fetchedAt: snapshot.fetchedAt, coverage: snapshot.coverage,
      warnings: [...snapshot.warnings, 'source_observation_time_unknown', 'execution_and_acceptance_not_covered'], items, total: snapshot.coverage === 'unavailable' ? null : filtered.length, nextCursor };
    if (Buffer.byteLength(JSON.stringify(page)) > 256 * 1024) throw new ConsoleError(503, 'page_limit');
    return page;
  }
  return { projects, read };
}
