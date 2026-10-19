import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { TextDecoder } from 'node:util';
import { compareEvidence } from './compare.js';

const INPUT_LIMIT = 8 * 1024 * 1024;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const HELP = 'Usage: aigentry-orchestrator benchmark compare --input ABSOLUTE_JSON_FILE\n'
  + '       aigentry-orchestrator benchmark --help | -h\n';
type CommandResult = { code: number; out: string; err: string };
function refuse(code: number, diagnostic: 'usage-refused' | 'input-refused' | 'output-limit'): CommandResult {
  return { code, out: '', err: JSON.stringify({ code: diagnostic }) + '\n' };
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && a.nlink === 1n && b.nlink === 1n
    && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function readInput(file: string): string {
  if (normalize(file) !== file || realpathSync.native(file) !== file) throw new Error('input-refused');
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(INPUT_LIMIT)) {
    throw new Error('input-refused');
  }
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFile(before, opened)) throw new Error('input-refused');
    const bytes = Buffer.alloc(INPUT_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, Math.min(64 * 1024, bytes.length - length), length);
      if (count === 0) break;
      length += count;
    }
    if (length > INPUT_LIMIT || BigInt(length) !== opened.size
        || !sameFile(opened, fstatSync(fd, { bigint: true }))
        || !sameFile(opened, lstatSync(file, { bigint: true }))
        || realpathSync.native(file) !== file) throw new Error('input-refused');
    // Preserve the exact decoded text, including any BOM, for the closed evidence parser.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

export function benchmarkCommand(args: string[]): { code: number; out: string; err: string } {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { code: 0, out: HELP, err: '' };
  }
  if (args.length !== 3 || args[0] !== 'compare' || args[1] !== '--input'
      || !isAbsolute(args[2]) || args[2].includes('\0')) return refuse(64, 'usage-refused');
  try {
    const result = compareEvidence(readInput(args[2]));
    if (!result.ok) return refuse(65, 'input-refused');
    const comparison = result.value;
    const out = JSON.stringify(comparison) + '\n';
    if (Buffer.byteLength(out, 'utf8') > OUTPUT_LIMIT) return refuse(65, 'output-limit');
    const code = comparison.findings.length > 0 || comparison.findingsTruncated ? 1
      : comparison.incomplete || comparison.performance === 'refused' ? 2 : 0;
    return { code, out, err: '' };
  } catch {
    return refuse(65, 'input-refused');
  }
}
