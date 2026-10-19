import * as fs from "node:fs";
import * as path from "node:path";
import { assertFixtureRoot } from "./fixture.js";
import { controllerContext, createBinding, enrollProject, resolveBinding, revokeBinding, upgradeConfig } from "../../../src/environment/grants.js";
import { currentConfig } from "../../../src/environment/grants.js";
import { captureManagedRuntime } from "../../../src/environment/helper-env.js";
import { OwnedInput } from "../../../src/environment/owned-input.js";
import { prepareWorkerSandbox, type WorkerScope } from "../../../src/session/worker-sandbox.js";
import type { ExecutableBinding } from "../../../src/session/model-decision.js";

const root = process.env.R2_FIXTURE_ROOT;
try { assertFixtureRoot(root); }
catch { throw new Error("R2_FIXTURE_ROOT_REFUSED"); }
const host = path.join(root, "host"), central = path.join(host, ".aigentry");
const infoFile = path.join(root, "managed-info.json");
const mode = process.argv[2];

if (mode === "prepare") {
  const project = path.join(root, "project"), bin = path.join(root, "bin");
  fs.mkdirSync(host, { mode: 0o700 }); fs.mkdirSync(central, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "tmp"), { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 }); fs.mkdirSync(bin, { mode: 0o700 });
  const provider = path.join(bin, "claude");
  const recorder = `#!${process.execPath}\n` +
    `const fs=require('node:fs'),path=require('node:path');\n` +
    `const root=${JSON.stringify(root)};\n` +
    `const file=path.join(root,'provider-'+process.pid+'.json');\n` +
    `const record={selected:process.env.CLAUDE_CODE_OAUTH_TOKEN==='fixture-token',` +
    `other:!!process.env.AWS_SECRET_ACCESS_KEY,argv:process.argv.slice(2),` +
    `fd3:(()=>{try{return !!fs.fstatSync(3)}catch{return false}})()};\n` +
    `fs.writeFileSync(file,JSON.stringify(record)+'\\n',{flag:'wx',mode:0o600});\n`;
  fs.writeFileSync(provider, recorder, { flag: "wx", mode: 0o700 });
  const stat = fs.statSync(provider);
  const executable: ExecutableBinding = { cli: "claude", path: provider, realpath: provider,
    dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
    version: "1.0.0", versionSource: "operator-declared" };
  upgradeConfig(central, 0);
  const ctx = controllerContext(central), enrollment = enrollProject(ctx, project, 1);
  const created = createBinding(ctx, enrollment.id, executable, enrollment.revision);
  const selection = resolveBinding(ctx, project, executable, created.id);
  const runtime = captureManagedRuntime({ PATH: `${bin}:/usr/bin:/bin`, LANG: "C", LC_ALL: "C" },
    path.join(central, "environment"));
  const sid = "r2-worker", scope: WorkerScope = { version: 1, task: "1233", sid,
    read: [project], write: [project], domains: [] };
  const staged = prepareWorkerSandbox(scope, "claude", project,
    [provider, "--model", "fixture-model", "--effort", "high"], path.join(central, "sessions", sid),
    project, undefined, undefined, executable, { noAccess: [], noWrite: [] },
    { ctx, selection, runtime, input: OwnedInput.fromBytes(Buffer.from("fixture-token", "ascii")) });
  const manifest = JSON.parse(fs.readFileSync(staged.manifest, "utf8")) as { delivery: { grantId: string }; attempt: string };
  const info = { ...staged, bindingId: created.id, grantId: manifest.delivery.grantId,
    attempt: manifest.attempt, central, provider, project, sid };
  fs.writeFileSync(infoFile, JSON.stringify(info) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ manifest: staged.manifest, hash: staged.hash }) + "\n");
} else if (mode === "revoke") {
  const info = JSON.parse(fs.readFileSync(infoFile, "utf8")) as { bindingId: string };
  const ctx = controllerContext(central);
  process.stdout.write(JSON.stringify({ revision: revokeBinding(ctx, info.bindingId, currentConfig(ctx).revision) }) + "\n");
} else throw new Error("R2_DRIVER_MODE_REFUSED");
