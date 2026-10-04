// #1166 r1 supplement child (tester-owned, test-only). Runs the REAL withIndexLock from
// INDEX_LOCK_JS. Same instrumentation convention as index-lock-strict.test.ts: wrap the
// default fs export + syncBuiltinESMExports. Only calls on the exact `${target}.lock`
// are counted / faulted; staging files and all other fs ops are real.
// FAULT: none | unlink-eacces | read-enoent (lock exists but every read says vanished)
//        | unlink-noop (sweep "succeeds", lock stays) | unlink-enoent (sweep says "already swept", lock stays)
// argv: <target> <timeoutMs>
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const [target, timeoutArg] = process.argv.slice(2);
const { withIndexLock } = await import(pathToFileURL(process.env.INDEX_LOCK_JS).href);
const lockPath = `${target}.lock`;
const fault = process.env.FAULT ?? "none";
const counts = { link: 0, read: 0, unlink: 0 };
const errno = (code, syscall, p) =>
  Object.assign(new Error(`${code}: injected, ${syscall} '${p}'`), { code, syscall, path: p });

const { link, readFile, unlink } = fs;
fs.link = async (from, to) => {
  if (to === lockPath) counts.link++;
  return link(from, to);
};
fs.readFile = async (p, ...rest) => {
  if (p === lockPath) {
    counts.read++;
    if (fault === "read-enoent") throw errno("ENOENT", "open", p);
  }
  return readFile(p, ...rest);
};
fs.unlink = async (p) => {
  if (p === lockPath) {
    counts.unlink++;
    if (fault === "unlink-eacces") throw errno("EACCES", "unlink", p);
    if (fault === "unlink-enoent") throw errno("ENOENT", "unlink", p);
    if (fault === "unlink-noop") return;
  }
  return unlink(p);
};
syncBuiltinESMExports();

const t0 = performance.now();
const send = (msg) => process.send?.({ ...msg, fault, elapsedMs: Math.round((performance.now() - t0) * 10) / 10, counts });
const hb = setInterval(() => send({ ev: "hb" }), 50);
send({ ev: "before" });
try {
  const value = await withIndexLock(target, async () => "entered", { timeoutMs: Number(timeoutArg) });
  send({ ev: "after", outcome: "resolved", value });
} catch (err) {
  send({ ev: "after", outcome: "rejected", message: String(err?.message) });
}
clearInterval(hb);
process.disconnect?.();
