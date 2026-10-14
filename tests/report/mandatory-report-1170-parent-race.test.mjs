// #1170: exercise the actual package helper while the worker replaces its request pathname.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidate = path.resolve(here, "..", "..");
const source = path.join(candidate, "src/report/outbox.ts");
const emission = path.join(candidate, "dist/src/report/outbox.js");
const helper = path.join(candidate, "bin/report-outbox-read.py");
const self = fileURLToPath(import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
process.umask(0o077);
const boundFiles = [source, emission, self, helper];
const boundHashes = boundFiles.map(file => sha256(fs.readFileSync(file)));
const python = (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter)
  .filter(dir => path.isAbsolute(dir))
  .map(dir => path.join(dir, "python3"))
  .find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
assert.ok(python, "selected parent-race test requires Python 3");
assert.ok(fs.statSync(python).isFile());
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parent-race-")));
fs.chmodSync(fixture, 0o700);
const root = path.join(fixture, "attempt");
const sid = "mr1170-parent-race", attempt = randomUUID(), requestId = randomUUID();
const home = path.join(root, "home"), requestDir = path.join(home, "report-outbox", requestId);
const sentinelDir = path.join(fixture, "outside");
fs.mkdirSync(requestDir, {recursive:true,mode:0o700});
fs.mkdirSync(sentinelDir, {mode:0o700});
const raw = Buffer.from(JSON.stringify({sid,attempt}));
fs.writeFileSync(path.join(root, "manifest.json"), raw, {mode:0o600});
const digest = sha256(raw);
const challenge = randomBytes(32).toString("base64url"), itemName = "REPORT-1.md";
const itemBytes = (body) => Buffer.from(
  `AIGENTRY_REPORT v1 request_id=${requestId} challenge=${challenge} kind=REPORT seq=1\n`+
  `${body}\nAIGENTRY_REPORT_END ${requestId} REPORT-1\n`);
const workerBytes = itemBytes("worker-owned");
const sentinelBytes = itemBytes(`synthetic-outside-${randomBytes(12).toString("hex")}`);
const itemPath = path.join(requestDir,itemName), sentinelPath = path.join(sentinelDir,itemName);
fs.writeFileSync(itemPath,workerBytes,{mode:0o600});
fs.writeFileSync(sentinelPath,sentinelBytes,{mode:0o600});
const identity = p => {
  const st=fs.statSync(p);
  return {dev:st.dev,ino:st.ino,mode:st.mode&0o777,size:st.size,sha256:sha256(fs.readFileSync(p))};
};
const sentinelBefore=identity(sentinelPath);
assert.equal(sentinelBefore.mode,0o600);
const outbox=await import(pathToFileURL(emission).href);
const envelope=await import(pathToFileURL(path.join(candidate,"dist/src/report/envelope.js")).href);
const invoke = (script,args) => {
  const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try { return spawnSync(python,args,{encoding:"utf8",timeout:10000,maxBuffer:8*1024*1024,
    env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C"},stdio:["ignore","pipe","pipe",fd]}); }
  finally {fs.closeSync(fd);}
};
const argv=[requestId,sid,attempt,digest];

test("verified request parent cannot redirect helper item open/read to outside sentinel",()=>{
  try {
  const direct=outbox.scanAnchoredOutbox(root,digest,sid,attempt,requestId);
  assert.equal(direct.status,"ok");
  assert.deepEqual(direct.entries.map(e=>e.name),[itemName]);
  assert.ok(direct.entries[0].bytes.equals(workerBytes));
  assert.equal(envelope.parseItem(direct.entries[0].bytes,
    {requestId,challengeSha256:sha256(challenge),kind:"REPORT",seq:1}).ok,true);

  const backup=path.join(root,"saved-request");
  const probe=`
import json, os, runpy, sys
helper, request, sid, attempt, digest, request_dir, backup, sentinel_dir, sentinel_path = sys.argv[1:]
original_stat, original_open, original_read = os.stat, os.open, os.read
trace = {"swapped": False, "opened_sentinel": False, "read_sentinel": False, "opened_original": False}
sentinel = original_stat(sentinel_path)
def stat_hook(name, *args, **kwargs):
    if name == "REPORT-1.md" and kwargs.get("dir_fd") is not None and not trace["swapped"]:
        os.rename(request_dir, backup)
        os.symlink(sentinel_dir, request_dir)
        trace["swapped"] = True
    return original_stat(name, *args, **kwargs)
def open_hook(name, flags, *args, **kwargs):
    fd = original_open(name, flags, *args, **kwargs)
    if name == "REPORT-1.md":
        st = os.fstat(fd)
        trace["opened_sentinel"] = (st.st_dev, st.st_ino) == (sentinel.st_dev, sentinel.st_ino)
        trace["opened_original"] = not trace["opened_sentinel"]
    return fd
def read_hook(fd, count):
    st = os.fstat(fd)
    if (st.st_dev, st.st_ino) == (sentinel.st_dev, sentinel.st_ino):
        trace["read_sentinel"] = True
    return original_read(fd, count)
os.stat, os.open, os.read = stat_hook, open_hook, read_hook
os.supports_dir_fd.add(stat_hook)
os.supports_dir_fd.add(open_hook)
os.supports_follow_symlinks.add(stat_hook)
sys.argv = [helper, request, sid, attempt, digest]
try:
    runpy.run_path(helper, run_name="__main__")
finally:
    os.stat, os.open, os.read = original_stat, original_open, original_read
    if trace["swapped"]:
        os.unlink(request_dir)
        os.rename(backup, request_dir)
    print(json.dumps(trace), file=sys.stderr)
`;
  const raced=invoke(probe,["-I","-S","-c",probe,helper,...argv,requestDir,backup,sentinelDir,sentinelPath]);
  assert.equal(raced.status,0,raced.stderr);
  const trace=JSON.parse(raced.stderr.trim().split("\n").at(-1));
  const result=JSON.parse(raced.stdout);
  assert.equal(trace.swapped,true,JSON.stringify({trace,result}));
  assert.equal(trace.opened_sentinel,false);
  assert.equal(trace.read_sentinel,false);
  assert.equal(trace.opened_original,true);
  assert.equal(result.status,"ok");
  assert.equal(Buffer.from(result.entries[0].bytes_b64,"base64").equals(workerBytes),true);
  assert.deepEqual(identity(sentinelPath),sentinelBefore);
  assert.equal(fs.realpathSync(requestDir),requestDir);
  assert.deepEqual(boundFiles.map(file => sha256(fs.readFileSync(file))), boundHashes,
    "source, emitted reader, helper and running test bytes stay fixed during the probe");
  process.stdout.write(`PARENT_RACE_CONTROL ${JSON.stringify({positiveRead:true,intercepted:true,
    openedSentinel:false,readSentinel:false,sentinelUnchanged:true})}\n`);
  } finally {
    fs.rmSync(fixture, {recursive:true,force:true});
  }
});
