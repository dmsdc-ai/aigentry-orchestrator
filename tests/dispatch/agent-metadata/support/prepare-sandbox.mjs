// Driver: run the REAL compiled prepareWorkerSandbox (dist/, AGENT_METADATA_DIST) inside a hermetic
// child env. argv[2] = JSON {scopeFile, task, sid, cli, roleCwd, argv, stagingRoot, launch?}.
// It never executes the launcher: it only stages files. Prints {launcher, manifest, hash}.
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const a = JSON.parse(process.argv[2]);
const dist = process.env.AGENT_METADATA_DIST;
const ws = await import(pathToFileURL(path.join(dist, "src/session/worker-sandbox.js")).href);
const scope = ws.loadWorkerScope(a.scopeFile, a.task, a.sid);
const r = a.launch === undefined
  ? ws.prepareWorkerSandbox(scope, a.cli, a.roleCwd, a.argv, a.stagingRoot, a.roleCwd, undefined)
  : ws.prepareWorkerSandbox(scope, a.cli, a.roleCwd, a.argv, a.stagingRoot, a.roleCwd, undefined, a.launch);
process.stdout.write(JSON.stringify(r) + "\n");
