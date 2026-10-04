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

// Reason strings the native module may emit (private_storage.c). Any other
// string is treated as a malformed result so arbitrary text is never forwarded.
const NATIVE_REASONS = new Set([
  'ok', 'path_grammar', 'invalid_argument', 'not_found', 'already_exists',
  'ancestor_open_failed', 'ancestor_query_failed', 'ancestor_reparse_point',
  'ancestor_not_directory', 'open_failed', 'create_failed', 'type_query_failed',
  'attributes_query_failed', 'reparse_point', 'not_directory', 'not_regular_file',
  'link_count', 'volume_query_failed', 'acl_not_persistent',
  'final_path_query_failed', 'final_path_unrecognized', 'final_path_mismatch',
  'final_path_compare_failed', 'security_query_failed', 'owner_mismatch',
  'dacl_absent', 'dacl_null', 'dacl_not_protected', 'dacl_invalid', 'dacl_empty',
  'ace_unsupported', 'ace_foreign_allow', 'owner_ace_missing',
  'identity_query_failed', 'size_query_failed', 'size_limit', 'size_changed',
  'read_failed', 'write_failed', 'short_write', 'flush_failed', 'close_failed',
  'token_open_failed', 'token_query_failed', 'token_sid_invalid',
  'descriptor_build_failed', 'alloc_failed', 'internal_error',
]);

function unavailable(reason) {
  return Object.freeze({ status: 'unavailable', reason, win32Error: 0 });
}

// Create results always carry `created`: false (native never ran), the native
// boolean when one survived, or null (UNKNOWN: the side effect may have happened).
function createFailure(reason, created) {
  return Object.freeze({ status: 'unavailable', reason, win32Error: 0, created });
}

/**
 * Rebuilds a native result into a fixed shape. Anything unexpected fails closed.
 * `bytes` is kept only for readPrivateFile with status 'ok'.
 * Each raw property is read exactly once; callers run this inside try/catch so a
 * throwing getter/proxy cannot escape. `created` is the value already read by invoke.
 */
function normalize(raw, { withBytes, withCreated }, created) {
  const invalid = () =>
    withCreated ? createFailure('native_result_invalid', created) : unavailable('native_result_invalid');
  if (raw === null || typeof raw !== 'object') return invalid();
  const status = raw.status;
  const reason = raw.reason;
  const win32Error = raw.win32Error;
  if (typeof status !== 'string' || !STATUSES.includes(status)) return invalid();
  if (typeof reason !== 'string' || !NATIVE_REASONS.has(reason)) return invalid();
  if (!Number.isInteger(win32Error) || win32Error < 0 || win32Error > 0xffffffff) {
    return invalid();
  }
  const out = { status, reason, win32Error };
  if (withCreated) {
    if (created === null) return invalid();
    out.created = created;
  }
  if (status === 'ok') {
    const volumeSerial = raw.volumeSerial;
    const fileId = raw.fileId;
    if (typeof volumeSerial !== 'string' || !HEX16.test(volumeSerial) ||
        typeof fileId !== 'string' || !HEX32.test(fileId)) {
      return invalid();
    }
    out.volumeSerial = volumeSerial;
    out.fileId = fileId;
    if (withBytes) {
      const bytes = raw.bytes;
      if (!Buffer.isBuffer(bytes)) return invalid();
      out.bytes = bytes;
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
    // For create calls the side effect is UNKNOWN: never claim false, never retry.
    return shape.withCreated ? createFailure('native_threw', null) : unavailable('native_threw');
  }
  let created = null;
  try {
    if (shape.withCreated && raw !== null && typeof raw === 'object') {
      // Read first and alone, so a valid native boolean survives later shape errors.
      const value = raw.created;
      if (typeof value === 'boolean') created = value;
    }
    return normalize(raw, shape, created);
  } catch {
    return shape.withCreated
      ? createFailure('native_result_invalid', created)
      : unavailable('native_result_invalid');
  }
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
      if (!validPath(path)) return createFailure('invalid_argument', false);
      return invoke(native.createPrivateDir, [path], { withBytes: false, withCreated: true });
    },
    createPrivateFileExclusive(path, bytes) {
      let valid;
      try {
        valid = validPath(path) && validBytes(bytes);
      } catch {
        valid = false; // e.g. a proxy/subclass whose prototype or byteLength access throws
      }
      if (!valid) return createFailure('invalid_argument', false);
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
