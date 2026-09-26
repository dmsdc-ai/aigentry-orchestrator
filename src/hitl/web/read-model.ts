import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, parse, relative, sep } from 'node:path';

export const validId = (id: string): boolean => id.length <= 240 && /^(destructive|decision|info)-[A-Za-z0-9._-]+-[a-f0-9]{12}$/.test(id);
export type View = 'pending' | 'history';
export interface RequestRow {
  id: string; question: string; subjectSid: string | null; createdAt: string;
  state: string; decision: string | null; decidedAt: string | null;
  binding: 'legacy_unbound'; task: null; purpose: null; scope: null;
}
export interface ReadPage { items: RequestRow[]; warnings: string[]; nextCursor: string | null }
const MAX_FILES = 1000;
const MAX_BYTES = 65536;

function parseRecord(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  const tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{' || token === '[') {
      if (stack.length >= 64) throw new Error('record_depth');
      stack.push(token === '{' ? new Set<string>() : null);
    } else if (token === '}' || token === ']') stack.pop();
    else if (token?.startsWith('"') && tokens[i + 1] === ':') {
      const keys = stack.at(-1);
      const key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) throw new Error('duplicate_key');
      keys.add(key);
    }
  }
  return value;
}

/** Check every configured path component; never follow a source symlink. */
async function directory(path: string): Promise<boolean> {
  if (!isAbsolute(path)) throw new Error('invalid_root');
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

function validate(value: unknown, id: string, view: View): RequestRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_record');
  const row = value as Record<string, unknown>;
  const nullable = (key: string): boolean => row[key] === null || typeof row[key] === 'string';
  if (row['id'] !== id || typeof row['source'] !== 'string' || !/^[A-Za-z0-9._-]+$/.test(row['source']) ||
      !['destructive', 'decision', 'info'].includes(String(row['kind'])) ||
      typeof row['question'] !== 'string' || !row['question'] ||
      typeof row['created_at'] !== 'string' || !Number.isFinite(Date.parse(row['created_at'])) ||
      !nullable('subject_sid') || !nullable('decided_at') || !nullable('context_ref') ||
      !Array.isArray(row['options']) || !row['options'].every(item => typeof item === 'string')) throw new Error('invalid_record');
  const hash = createHash('sha256').update(`${row['source']}|${row['kind']}|${row['question']}`).digest('hex').slice(0, 12);
  if (id !== `${row['kind']}-${row['source']}-${hash}` || row['dedupe_key'] !== hash) throw new Error('invalid_record');
  if (view === 'pending' ? row['status'] !== 'pending' || row['decision'] !== null || row['decided_at'] !== null :
      !((row['status'] === 'approved' && row['decision'] === 'approve') || (row['status'] === 'rejected' && row['decision'] === 'reject')) ||
      typeof row['decided_at'] !== 'string' || !Number.isFinite(Date.parse(row['decided_at']))) throw new Error('invalid_record');
  return { id, question: row['question'], subjectSid: row['subject_sid'] as string | null,
    createdAt: row['created_at'], state: String(row['status']), decision: row['decision'] as string | null,
    decidedAt: row['decided_at'] as string | null, binding: 'legacy_unbound', task: null, purpose: null, scope: null };
}

export async function readRequests(root: string, view: View, limit: number, cursor: string | null = null): Promise<ReadPage> {
  if (!isAbsolute(root) || !['pending', 'history'].includes(view) || !Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== null && !validId(cursor))) throw new Error('invalid_query');
  const result: ReadPage = { items: [], warnings: [], nextCursor: null };
  const folder = join(root, view === 'pending' ? 'pending' : 'decided');
  try {
    if (!await directory(folder)) return result;
    const names: string[] = [];
    const dir = await opendir(folder);
    let count = 0;
    for await (const entry of dir) {
      if (++count > MAX_FILES) { result.warnings.push('file_limit'); break; }
      if (!entry.isFile() || !entry.name.endsWith('.json') || !validId(entry.name.slice(0, -5))) { result.warnings.push('source_unavailable'); continue; }
      names.push(entry.name);
    }
    names.sort();
    for (const name of names) {
      const id = name.slice(0, -5);
      if (cursor !== null && id <= cursor) continue;
      if (result.items.length === limit) { result.nextCursor = result.items.at(-1)?.id ?? null; break; }
      try {
        if (!await directory(folder)) throw new Error('source_unavailable');
        const filename = join(folder, name);
        const before = await lstat(filename);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error('unsafe_file');
        const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size > MAX_BYTES) throw new Error('unsafe_file');
          const bytes = Buffer.alloc(MAX_BYTES + 1);
          let used = 0;
          while (used < bytes.length) {
            const read = await file.read(bytes, used, bytes.length - used, null);
            if (!read.bytesRead) break;
            used += read.bytesRead;
          }
          if (used > MAX_BYTES) throw new Error('file_limit');
          const raw = bytes.subarray(0, used).toString('utf8');
          result.items.push(validate(parseRecord(raw), id, view));
        } finally { await file.close(); }
      } catch { result.warnings.push('record_corrupt_or_unavailable'); }
    }
  } catch { result.warnings.push('source_unavailable'); }
  result.warnings = [...new Set(result.warnings)];
  return result;
}
