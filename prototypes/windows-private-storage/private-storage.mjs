// Windows private-storage feasibility prototype wrapper (task 1167, CONTRACT r2).
// Isolated prototype: NOT imported by src/hitl/web/auth.ts, not packaged.
// Loads only the explicitly supplied binary, only on win32; fails closed elsewhere.
// No binary search, no download, no install step. See README.md.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import process from 'node:process';

export const ABI_TAG = 'aigentry-private-storage-proto-1';
export const STATUSES = Object.freeze(['ok', 'missing', 'unsafe', 'exists', 'unavailable']);
export const MAX_IO_BYTES = 16 * 1024 * 1024;
export const MAX_PATH_CHARS = 32000;

const FUNCTIONS = Object.freeze([
  'inspectDir',
  'readPrivateFile',
  'createPrivateDir',
  'createPrivateFileExclusive',
]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX32 = /^[0-9a-f]{32}$/;

function unavailable(reason) {
  return Object.freeze({ status: 'unavailable', reason, win32Error: 0 });
}

/**
 * Rebuilds a native result into a fixed shape. Anything unexpected fails closed.
 * `bytes` is kept only for readPrivateFile with status 'ok'.
 */
function normalize(raw, { withBytes, withCreated }) {
  if (raw === null || typeof raw !== 'object') return unavailable('native_result_invalid');
  const { status, reason, win32Error } = raw;
  if (!STATUSES.includes(status) || typeof reason !== 'string') {
    return unavailable('native_result_invalid');
  }
  if (!Number.isInteger(win32Error) || win32Error < 0 || win32Error > 0xffffffff) {
    return unavailable('native_result_invalid');
  }
  const out = { status, reason, win32Error };
  if (withCreated) {
    if (typeof raw.created !== 'boolean') return unavailable('native_result_invalid');
    out.created = raw.created;
  }
  if (status === 'ok') {
    if (!HEX16.test(raw.volumeSerial) || !HEX32.test(raw.fileId)) {
      return unavailable('native_result_invalid');
    }
    out.volumeSerial = raw.volumeSerial;
    out.fileId = raw.fileId;
    if (withBytes) {
      if (!Buffer.isBuffer(raw.bytes)) return unavailable('native_result_invalid');
      out.bytes = raw.bytes;
    }
  }
  return Object.freeze(out);
}

function invoke(fn, args, shape) {
  let raw;
  try {
    raw = fn(...args);
  } catch {
    // Never forward native/engine error text: it is not part of the contract.
    return unavailable('native_threw');
  }
  return normalize(raw, shape);
}

function validPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= MAX_PATH_CHARS;
}

function validMax(max) {
  return Number.isSafeInteger(max) && max >= 0 && max <= MAX_IO_BYTES;
}

function validBytes(bytes) {
  return bytes instanceof Uint8Array && bytes.byteLength <= MAX_IO_BYTES;
}

function bind(native) {
  return Object.freeze({
    inspectDir(path) {
      if (!validPath(path)) return unavailable('invalid_argument');
      return invoke(native.inspectDir, [path], { withBytes: false, withCreated: false });
    },
    readPrivateFile(path, max) {
      if (!validPath(path) || !validMax(max)) return unavailable('invalid_argument');
      return invoke(native.readPrivateFile, [path, max], { withBytes: true, withCreated: false });
    },
    createPrivateDir(path) {
      if (!validPath(path)) return Object.freeze({ ...unavailable('invalid_argument'), created: false });
      return invoke(native.createPrivateDir, [path], { withBytes: false, withCreated: true });
    },
    createPrivateFileExclusive(path, bytes) {
      if (!validPath(path) || !validBytes(bytes)) {
        return Object.freeze({ ...unavailable('invalid_argument'), created: false });
      }
      return invoke(native.createPrivateFileExclusive, [path, bytes], {
        withBytes: false,
        withCreated: true,
      });
    },
  });
}

/**
 * Loads the prototype binary named by the caller.
 * options.binaryPath: absolute drive-letter path to the .node file.
 * options.sha256:     expected lowercase hex sha256 of that file.
 * Returns { status: 'ok', api } or { status: 'unavailable', reason, win32Error: 0 }.
 * The hash check guards packaging/arch mistakes only; the file can change
 * between hashing and loading, and an attacker who can write it is out of scope.
 */
export function loadPrivateStorage(options) {
  if (process.platform !== 'win32') return unavailable('platform_unsupported');
  const binaryPath = options?.binaryPath;
  const expected = options?.sha256;
  if (
    typeof binaryPath !== 'string' ||
    !/^[A-Za-z]:\\/.test(binaryPath) ||
    win32.normalize(binaryPath) !== binaryPath ||
    !binaryPath.toLowerCase().endsWith('.node')
  ) {
    return unavailable('binary_path_invalid');
  }
  if (typeof expected !== 'string' || !SHA256_HEX.test(expected)) {
    return unavailable('binary_hash_invalid');
  }
  let actual;
  try {
    actual = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
  } catch {
    return unavailable('binary_unreadable');
  }
  if (actual !== expected) return unavailable('binary_hash_mismatch');
  const module = { exports: {} };
  try {
    process.dlopen(module, binaryPath);
  } catch {
    return unavailable('load_failed');
  }
  const native = module.exports;
  if (native === null || typeof native !== 'object' || native.abi !== ABI_TAG) {
    return unavailable('abi_mismatch');
  }
  for (const name of FUNCTIONS) {
    if (typeof native[name] !== 'function') return unavailable('abi_mismatch');
  }
  return Object.freeze({ status: 'ok', api: bind(native) });
}
