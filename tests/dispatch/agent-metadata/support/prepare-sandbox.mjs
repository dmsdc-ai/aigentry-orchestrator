// Driver: run the REAL compiled prepareWorkerSandbox (dist/, AGENT_METADATA_DIST) inside a hermetic
// child env. argv[2] = JSON {scopeFile, task, sid, cli, roleCwd, argv, stagingRoot, launch?}.
// It never executes the launcher: it only stages files. Prints {launcher, manifest, hash}.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Shared with the report fixture; callers supply only their owned roots and synthetic credentials.
export async function prepareSandboxFixture(a, dist, controlRoots) {
  const load = rel => import(pathToFileURL(path.join(dist, "src", rel)).href);
  const ws = await load("session/worker-sandbox.js");
  const scope = ws.loadWorkerScope(a.scopeFile, a.task, a.sid);
  const prepare = (argv = a.argv, binding, managed) => ws.prepareWorkerSandbox(
    scope, a.cli, a.roleCwd, argv, a.stagingRoot, a.roleCwd, undefined, a.launch,
    binding, controlRoots, managed);
  // Let the actual producer own early refusal ordering, before credential acquisition or setup.
  if (!["darwin", "linux"].includes(process.platform) || a.cli !== "claude" ||
      !a.argv.length || path.basename(a.argv[0]) !== a.cli || ws.claudeToolPolicyViolation(a.argv)) {
    return prepare();
  }
  const oauth = await load("session/claude-worker-oauth.js");
  const { input } = oauth.acquireClaudeOAuthInput(process.env);
  if (!input) return prepare();
  try {
    const grants = await load("environment/grants.js");
    const helpers = await load("environment/helper-env.js");
    // The stage remains exactly where the caller put it. Never repair a mismatched sid/root.
    const home = path.dirname(path.dirname(a.stagingRoot));
    if (a.stagingRoot !== path.join(home, "sessions", scope.sid)) throw new Error("ENV_BINDING_POLICY_REFUSED");
    // Initialize only a new environment; missing/malformed config in existing state must refuse.
    let missing = false;
    try { fs.lstatSync(path.join(home, "environment")); }
    catch (e) { if (e.code !== "ENOENT") throw e; missing = true; }
    if (missing) grants.upgradeConfig(home, 0);
    const ctx = grants.controllerContext(home);
    const runtime = helpers.captureManagedRuntime(process.env, path.join(ctx.home, "environment"));
    // Resolve a bare fixture CLI on the supplied hermetic PATH, without executing it. Keep
    // absolute argv[0] and every remaining argument unchanged; the real producer checks identity.
    let executable = a.argv[0];
    if (!path.isAbsolute(executable)) {
      executable = (runtime.base.PATH ?? "").split(path.delimiter).map(dir => path.join(dir, a.argv[0]))
        .find(file => {
          try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
          catch { return false; }
        });
      if (!executable) throw new Error(`SANDBOX_EXECUTABLE_MISSING: ${a.argv[0]}`);
    }
    const realpath = fs.realpathSync(executable), st = fs.statSync(realpath);
    const binding = { cli: "claude", path: executable, realpath, dev: st.dev, ino: st.ino,
      size: st.size, mtimeMs: st.mtimeMs, version: "9.9.9", versionSource: "operator-declared" };
    const config = grants.currentConfig(ctx);
    const existing = Object.entries(config.projectEnrollments).find(([, e]) => e.canonicalRoot === a.roleCwd);
    const enrollment = existing ? { id: existing[0], revision: config.revision }
      : grants.enrollProject(ctx, a.roleCwd, config.revision);
    // Existing disabled/revoked bindings and changed executable identities are not replaced.
    const hasBinding = Object.values(config.bindings).some(b => b.projectEnrollmentIds.includes(enrollment.id));
    const bindingId = hasBinding ? undefined : grants.createBinding(ctx, enrollment.id, binding, enrollment.revision).id;
    const selection = grants.resolveBinding(ctx, a.roleCwd, binding, bindingId);
    return prepare([executable, ...a.argv.slice(1)], binding, { ctx, selection, runtime, input });
  } finally {
    // prepareGrant consumes the OwnedInput once. Failures never reacquire it or retry a claim.
    input.dispose();
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await prepareSandboxFixture(JSON.parse(process.argv[2]), process.env.AGENT_METADATA_DIST);
  process.stdout.write(JSON.stringify(r) + "\n");
}
