// #1166 prototype loader (test-only; not index-lock). Loads oslock.node from an explicit
// absolute path after checking its sha256. Any failure throws
// `oslock: native unavailable (<reason>)` — there is no fallback of any kind.
//
// The hash check proves integrity of a private, immutable artifact only. It is NOT a
// defence against a concurrent attacker who can replace the file between the read and
// dlopen: whoever can write that path can already run code as us.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute } from "node:path";

export const OSLOCK_ABI = "oslock/1";
const EXPORTS = ["abi", "open", "tryLock", "unlock", "close", "identity"];

function unavailable(reason, cause) {
  const err = new Error(`oslock: native unavailable (${reason})`, cause === undefined ? undefined : { cause });
  err.code = "EOSLOCK_UNAVAILABLE";
  err.reason = reason;
  return err;
}

export function loadOsLock({ path = process.env.OSLOCK_NODE, sha256 = process.env.OSLOCK_SHA256 } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) throw unavailable("addon path must be absolute");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw unavailable("expected sha256 missing or malformed");
  }
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    throw unavailable(err?.code === "ENOENT" ? "missing file" : `stat failed: ${err?.code ?? "unknown"}`, err);
  }
  if (!st.isFile()) throw unavailable("not a regular file");
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw unavailable(`read failed: ${err?.code ?? "unknown"}`, err);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== sha256.toLowerCase()) {
    throw unavailable("hash mismatch");
  }
  const mod = { exports: {} };
  try {
    const flag = osConstants.dlopen?.RTLD_NOW;
    if (flag === undefined) process.dlopen(mod, path);
    else process.dlopen(mod, path, flag);
  } catch (err) {
    throw unavailable("dlopen failed", err);
  }
  const addon = mod.exports;
  for (const name of EXPORTS) {
    if (typeof addon?.[name] !== "function") throw unavailable("abi mismatch");
  }
  let abi;
  try {
    abi = addon.abi();
  } catch (err) {
    throw unavailable("abi mismatch", err);
  }
  if (abi !== OSLOCK_ABI) throw unavailable("abi mismatch");
  return Object.freeze(Object.fromEntries(EXPORTS.map((name) => [name, addon[name]])));
}
