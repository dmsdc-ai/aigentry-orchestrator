// Exact installed-package acceptance. T138–T141 assertion bodies are retained below.
// Run with Node 20.20.0, INSTALLED_PACKAGE_ROOT, absolute PYTHON_BINARY, and private TMPDIR outside Git.
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, appendFileSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

assert.equal(process.version, 'v20.20.0', 'exact acceptance runtime required');
assert.ok(process.env.INSTALLED_PACKAGE_ROOT, 'INSTALLED_PACKAGE_ROOT required');
assert.ok(process.env.PYTHON_BINARY && isAbsolute(process.env.PYTHON_BINARY), 'explicit absolute PYTHON_BINARY required');
const pythonBinary = realpathSync(process.env.PYTHON_BINARY);
accessSync(pythonBinary, constants.X_OK);
assert.ok(lstatSync(pythonBinary).isFile(), 'PYTHON_BINARY must resolve to an executable file');
const REPO = realpathSync(process.env.INSTALLED_PACKAGE_ROOT);
const admin = resolve(dirname(fileURLToPath(import.meta.url)), '../../.aigentry-report-ir1171');
const input = join(admin, 'input');
const identity = JSON.parse(readFileSync(join(input, 'installed-identity.json'), 'utf8'));
assert.equal(REPO, realpathSync(identity.packageRoot), 'only exact staged installed package');
const PROFILE = join(input, 'router-tests/model-routing-profile.md');
const ROUTER = join(REPO, 'bin/model-router.mjs');
assert.ok(process.env.TMPDIR, 'private TMPDIR required');
const privateTmp = realpathSync(process.env.TMPDIR);
for (let p = privateTmp; ; p = dirname(p)) {
    assert.equal(existsSync(join(p, '.git')), false, `TMPDIR under Git ancestor ${p}`);
    if (p === dirname(p)) break;
}
const runRoot = mkdtempSync(join(privateTmp, 'ir1171-'));
const evidence = mkdtempSync(join(admin, 'run-'));
const parentEnv = { ...process.env };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n');
const log = value => appendFileSync(join(evidence, 'commands.jsonl'), JSON.stringify(value) + '\n');
const pythonEnv = { HOME: runRoot, TMPDIR: runRoot, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', PYTHONDONTWRITEBYTECODE: '1' };
const pythonStart = Date.now();
const pythonProbe = spawnSync(pythonBinary, ['--version'], { cwd: runRoot, env: pythonEnv, encoding: 'utf8', timeout: 5000 });
log({ case: 'runtime-preflight', command: pythonBinary, argv: ['--version'], envNames: Object.keys(pythonEnv).sort(),
    status: pythonProbe.status, signal: pythonProbe.signal, error: pythonProbe.error?.code, timeoutMs: 5000,
    elapsedMs: Date.now() - pythonStart, stdout: pythonProbe.stdout, stderr: pythonProbe.stderr });
assert.equal(pythonProbe.error, undefined, 'PYTHON_BINARY version probe must complete');
assert.equal(pythonProbe.status, 0, pythonProbe.stderr);
assert.match(pythonProbe.stdout, /^Python 3\./, 'Python 3 required by installed registry');
function inventory(root, rel = '') {
    return readdirSync(join(root, rel)).sort().flatMap(name => {
        const path = join(rel, name), full = join(root, path), stat = lstatSync(full);
        if (stat.isSymbolicLink()) return [{ path, link: readlinkSync(full) }];
        if (stat.isDirectory()) return inventory(root, path);
        return [{ path, bytes: stat.size, sha256: sha(readFileSync(full)) }];
    });
}
const moduleRoot = resolve(REPO, '../..');
const before = inventory(moduleRoot);
save('product-and-dependencies-before.json', before);
const members = JSON.parse(readFileSync(join(input, 'member-hashes.json'), 'utf8'));
for (const member of members) assert.equal(sha(readFileSync(join(REPO, member.path))), member.tarSHA256, member.path);
save('identity.json', { task: 1171, sid: 'ir1171-tester', attempt: process.env.AIGENTRY_WORKER_ATTEMPT,
    operation: 'ir1171-v1', node: process.version, executable: process.execPath, packageRoot: REPO,
    pythonBinaryInput: process.env.PYTHON_BINARY, pythonBinary, pythonVersion: pythonProbe.stdout.trim(),
    artifactSHA256: '6eb1c00c8aec5f6b9dcbdb49b9c5ed11e769db81cbbe4f329a99253c691b5965',
    manifestFiles: members.length, inventoryEntries: before.length, inventorySHA256: sha(JSON.stringify(before)),
    runRoot, evidence, parentEnvNames: Object.keys(parentEnv).sort(),
    security: 'Snyk pending tls652; unchanged known native TLS failure not rerun; no clearance' });
console.log(`ACK task=1171 sid=ir1171-tester attempt=${process.env.AIGENTRY_WORKER_ATTEMPT} operation=ir1171-v1 evidence=${evidence}`);
const cases = [], failedGroups = new Set();
let activeCase = '', fixtureNumber = 0;
function test(name, body) {
    const row = { id: cases.length + 1, name, status: 'pending' };
    cases.push(row);
    nodeTest(name, async t => {
        const group = name.split(':')[0];
        if (failedGroups.has(group)) { row.status = 'skip'; row.reason = 'dependent group stopped after failure'; t.skip(row.reason); return; }
        activeCase = name;
        try { await body(t); row.status = 'pass'; }
        catch (error) { row.status = 'fail'; row.error = error.stack; failedGroups.add(group); throw error; }
    });
}
after(() => {
    const afterFiles = inventory(moduleRoot);
    save('product-and-dependencies-after.json', afterFiles);
    save('cases.json', cases);
    save('preservation.json', { byteIdentical: JSON.stringify(before) === JSON.stringify(afterFiles),
        parentEnvironmentUnchanged: JSON.stringify(parentEnv) === JSON.stringify(process.env),
        beforeSHA256: sha(JSON.stringify(before)), afterSHA256: sha(JSON.stringify(afterFiles)) });
    save('harness-hash.json', { sha256: sha(readFileSync(fileURLToPath(import.meta.url))) });
    assert.deepEqual(afterFiles, before, 'installed product and parent dependencies must remain byte-identical');
    assert.deepEqual({ ...process.env }, parentEnv, 'parent environment unchanged');
});
const { geminiBinary } = await import(pathToFileURL(join(REPO, 'dist/src/session/boot-adapter/gemini.js')));

function runProduct(fixtureRoot, argv, env, timeout) {
    const start = Date.now();
    const result = spawnSync(process.execPath, argv, { cwd: join(fixtureRoot, 'project'), env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
    log({ case: activeCase, fixtureRoot, command: process.execPath, argv, envNames: Object.keys(env).sort(),
        status: result.status, signal: result.signal, error: result.error?.code, timeoutMs: timeout,
        elapsedMs: Date.now() - start, stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.error, undefined, `harness command failed: ${result.error?.message}`);
    return result;
}

function fixture() {
    const root = mkdtempSync(join(runRoot, `fixture-${++fixtureNumber}-`));
    const bin = join(root, "bin"), home = join(root, "home"), aig = join(root, "aig");
    const ref = join(root, "ref.md"), queue = join(root, "queue.json");
    for (const dir of [bin, home, join(aig, "instructions/roles"), join(root, "state"), join(root, "project")])
        mkdirSync(dir, { recursive: true });
    const script = (name, body) => {
        const file = join(bin, name);
        const record = `const portStarted = Date.now();
const portRecord = event => require('node:fs').appendFileSync(process.env.PORT_LOG, JSON.stringify({port: ${JSON.stringify(name)}, argv: process.argv.slice(2), envNames: Object.keys(process.env).sort(), ...event}) + '\\n');
portRecord({event: 'start'});
process.on('exit', status => portRecord({event: 'exit', status, elapsedMs: Date.now() - portStarted}));`;
        writeFileSync(file, "#!" + process.execPath + "\n" + record + "\n" + body + "\n", { mode: 0o755 });
        return file;
    };
    writeFileSync(join(home, ".claude.json"), "{}");
    writeFileSync(join(aig, "instructions/common.md"), "# COMMON\nFIXTURE-COMMON\n");
    writeFileSync(join(aig, "instructions/roles/coder.md"), "# CODER\nFIXTURE-ROLE\n");
    writeFileSync(ref, "Implement the fixture router. TASK-FIRST-4KB\n");
    writeFileSync(queue, JSON.stringify({ tasks: [{ id: 1083, status: "pending", note: "seed" }] }));
    writeFileSync(join(root, "state/active.json"), '{"schema_version":2,"generation":0,"dispatches":[]}');
    const classifier = script("classifier", `
const fs = require('node:fs');
fs.appendFileSync(process.env.COUNTER, 'call\\n');
fs.writeFileSync(process.env.PROMPT_LOG, fs.readFileSync(0, 'utf8'));
fs.writeFileSync(process.env.CLASSIFIER_ARGS, JSON.stringify({ argv: process.argv.slice(2),
  env: { MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS, CLAUDE_EFFORT: process.env.CLAUDE_EFFORT } }));
if (process.env.CLASSIFIER_HANG === '1') setInterval(() => {}, 1000);
else { process.stdout.write(process.env.CLASSIFIER_REPLY || 'invalid'); process.exit(Number(process.env.CLASSIFIER_EXIT || 0)); }
`);
    for (const cli of ["claude", "codex", "gemini", "grok", "agy"])
        script(cli, `
if (process.argv[2] === '--version') console.log('9.9.9');
else if (process.argv[2] === '--help') console.log('--model --dangerously-skip-permissions --prompt-interactive');
else { console.error('TEST TRIPWIRE: attempted real CLI launch'); process.exit(99); }
`);
    const telepty = script("telepty", `
if (process.argv[2] === 'list') console.log(process.env.LIVE_SESSIONS || JSON.stringify([{id: 'router-fixture', command: process.env.OBSERVED_CLI || 'codex'}]));
else if (process.argv[2] === 'inject') {
  require('node:fs').writeFileSync(process.env.PARENT_MODEL_LOG, process.env.AIGENTRY_CODEX_MODEL || '');
  console.log('stub inject OK');
}
else process.exit(99);
`);
    const open = script("open-session", `
require('node:fs').appendFileSync(process.env.OPEN_LOG + '.calls', 'open\\n');
require('node:fs').writeFileSync(process.env.OPEN_LOG, JSON.stringify({args: process.argv.slice(2),
  model: process.env.AIGENTRY_CODEX_MODEL, grokModel: process.env.AIGENTRY_GROK_MODEL,
  codexEffort: process.env.AIGENTRY_CODEX_EFFORT}));
`);
    const probe = script("probe", "console.log('{\"ready\":true}')");
    const telemetry = script("telemetry", "require('node:fs').appendFileSync(process.env.TELEMETRY_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')");
    // No ambient variables are copied: all child environment values are fixture-owned.
    const ambient = { LANG: "C", LC_ALL: "C", PYTHONDONTWRITEBYTECODE: "1" };
    const env = { ...ambient, HOME: home, AIGENTRY_HOME: aig,
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: join(root, "tmp"), PORT_LOG: join(root, "ports.jsonl"), TELEPTY: telepty, OPEN_SESSION_SH: open, SESSION_PROBE_PY: probe,
        EMIT_TELEMETRY_MJS: telemetry, AIGENTRY_TASK_QUEUE: queue, AIGENTRY_TASK_GATE: "hard",
        AIGENTRY_SESSIONS_ROOT: join(aig, "sessions"), DISPATCH_STATE_DIR: join(root, "state"),
        AIGENTRY_GIT_HOOKS_DIR: join(root, "hooks"), AIGENTRY_GIT_HOOK_SOURCE_DIR: join(REPO, "git-hooks"),
        CODEX_HOME: join(root, "codex-home"), GEMINI_CLI_HOME: join(root, "gemini-home"),
        AIGENTRY_ROUTER_PROFILE: PROFILE, AIGENTRY_ROUTER_CLASSIFIER: classifier,
        AIGENTRY_CLAUDE_MODEL: "", AIGENTRY_CODEX_MODEL: "", AIGENTRY_GROK_MODEL: "", AIGENTRY_GEMINI_MODEL: "",
        AIGENTRY_GEMINI_BINARY: "agy", AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS: "0",
        AIGENTRY_SHIM_SCRIPT_DIR: "", DISPATCH_SCRIPT_DIR: "", DISPATCH_REGISTRY_PY: join(REPO, "bin/dispatch-registry.py"),
        COUNTER: join(root, "counter"), PROMPT_LOG: join(root, "prompt"), CLASSIFIER_ARGS: join(root, "classifier-args"),
        PARENT_MODEL_LOG: join(root, "parent-model"),
        CLASSIFIER_REPLY: '{"label":"gpt-6-astra","reason":"implementation","confidence":0.9}',
        CLASSIFIER_EXIT: "0", CLASSIFIER_HANG: "0", OPEN_LOG: join(root, "open.json"), TELEMETRY_LOG: join(root, "telemetry.jsonl") };
    const router = (args = [], overrides = {}) => runProduct(root, [ROUTER, "--role", "coder", "--profile", PROFILE, ...args], { ...env, ...overrides }, 20000);
    const dispatch = (args = [], overrides = {}) => runProduct(root, [join(REPO, "dist/src/dispatch/cli.js"), "--ref", ref, "--task", "1083", "--no-verify-started", "--timeout-ms", "500", ...args], { ...env, ...overrides }, 22000);
    for (const dir of [env.TMPDIR, env.CODEX_HOME, env.GEMINI_CLI_HOME]) mkdirSync(dir, { recursive: true });
    for (const command of ['ps', 'kill', 'pkill', 'killall', 'launchctl', 'open', 'osascript', 'cmux', 'tmux', 'curl', 'wget', 'ssh', 'npm', 'npx'])
        script(command, "console.error('TEST TRIPWIRE: forbidden command'); process.exit(99)");
    script('git', "process.exit(1)"); // Branch telemetry sees no Git project.
    script('node', `
const cp = require('node:child_process');
const r = cp.spawnSync(process.execPath, process.argv.slice(2), {stdio: 'inherit', env: process.env});
process.exit(r.status ?? 99);
`);
    script('python3', `
const r = require('node:child_process').spawnSync(${JSON.stringify(pythonBinary)}, process.argv.slice(2), {stdio: 'inherit', env: process.env});
process.exit(r.status ?? 99);
`);
    env.REPORT_TARGET_SH = script('report-target', "console.log('fixture-orchestrator')");
    appendFileSync(join(evidence, 'fixtures.jsonl'), JSON.stringify({case: activeCase, root}) + '\n');
    // #1084: a live worker shows up in `telepty list` as its guard launcher; the CLI kind is its `exec -a` line.
    const liveLauncher = (cli) => { const file = join(root, `live-${cli}-launcher.sh`); writeFileSync(file, `#!/usr/bin/env bash\nexec -a ${cli} ${cli} "$@"\n`); return file; };
    return { root, bin, aig, ref, queue, env, script, router, dispatch, liveLauncher,
        spawnArgs: ["--spawn-and-dispatch", "--track", "router", "--name", "fixture", "--cwd", join(root, "project")],
        calls: () => { try {
            return readFileSync(env.COUNTER, "utf8").trim().split("\n").length;
        }
        catch {
            return 0;
        } },
        cleanup: () => {} }; // Retain fixture evidence, including failed runs.
}

// Assertions adapted verbatim from T138-model-router-fallback.test.js
for (const [name, overrides] of [
    ["label outside allowlist", { CLASSIFIER_REPLY: '{"label":"invented-model","reason":"x","confidence":1}' }],
    ["unparsable output", { CLASSIFIER_REPLY: "not json" }],
    ["nonzero exit", { CLASSIFIER_EXIT: "2" }],
    ["invalid confidence", { CLASSIFIER_REPLY: '{"label":"gpt-6-astra","reason":"x","confidence":2}' }],
    ["15-second timeout", { CLASSIFIER_HANG: "1" }],
])
    test(`T138: ${name} falls back to the role table`, () => {
        const f = fixture();
        try {
            const r = f.router(["--ref", f.ref], overrides);
            assert.equal(r.status, 0, r.stderr);
            const route = JSON.parse(r.stdout);
            assert.deepEqual([route.decided_by, route.cli, route.model, route.label], ["table", "codex", "gpt-6-astra", "gpt-6-astra"]);
            assert.equal(r.stderr.trim().split("\n").length, 1);
            assert.equal(r.stdout.trim().split("\n").length, 1);
            assert.equal(f.calls(), 1);
        }
        finally {
            f.cleanup();
        }
    });
// #1084: dispatch's cap fallback order comes from the router (the only profile parser), on request only.
test("T138: --candidates 1 lists the role table pick then profile order; default shape unchanged", () => {
    const f = fixture();
    try {
        const labels = (r) => JSON.parse(r.stdout).candidates.map((c) => c.label);
        const r = f.router(["--candidates", "1"]);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(labels(r), ["gpt-6-astra", "opus-5", "grok-4.6", "gemini"]);
        assert.deepEqual(JSON.parse(r.stdout).candidates[1], { cli: "claude", model: "claude-opus-5[1m]", label: "opus-5" });
        assert.deepEqual(labels(f.router(["--role", "nobody", "--candidates", "1"])), ["opus-5", "gpt-6-astra", "grok-4.6", "gemini"]);
        assert.equal("candidates" in JSON.parse(f.router().stdout), false);
        assert.equal(f.calls(), 0);
    }
    finally {
        f.cleanup();
    }
});

// Assertions adapted verbatim from T139-model-router-selection.test.js
test("T139: valid classifier JSON maps each allowlisted label exactly", () => {
    const f = fixture();
    try {
        for (const [label, cli, model] of [["opus-5", "claude", "claude-opus-5[1m]"],
            ["gpt-6-astra", "codex", "gpt-6-astra"], ["grok-4.6", "grok", "grok-4.6"], ["gemini", "gemini", "gemini-3.8-flash-high"]]) {
            const r = f.router(["--ref", f.ref], { CLASSIFIER_REPLY: JSON.stringify({ label, reason: "fixture mapping", confidence: 0.8 }) });
            assert.equal(r.status, 0, r.stderr);
            assert.deepEqual(JSON.parse(r.stdout), { label, cli, model, reason: "fixture mapping", confidence: 0.8, decided_by: "llm" });
            assert.equal(r.stderr, "");
        }
    }
    finally {
        f.cleanup();
    }
});
test("T139: missing/malformed profile uses emergency Opus without classifier", () => {
    const f = fixture();
    try {
        const invalid = join(f.root, "invalid.md");
        writeFileSync(invalid, "not front matter");
        for (const profile of [join(f.root, "missing.md"), invalid]) {
            const r = f.router(["--profile", profile, "--ref", f.ref]);
            assert.equal(r.status, 0, r.stderr);
            const route = JSON.parse(r.stdout);
            assert.deepEqual([route.decided_by, route.label, route.cli, route.model], ["table", "opus-5", "claude", "claude-opus-5[1m]"]);
            assert.equal(r.stderr.trim().split("\n").length, 1);
        }
        assert.equal(f.calls(), 0);
    }
    finally {
        f.cleanup();
    }
});
test("T139: no ref uses role table; unknown role uses Opus", () => {
    const f = fixture();
    try {
        for (const [role, label] of [["architect", "opus-5"], ["analyst", "opus-5"], ["researcher", "gemini"],
            ["coder", "gpt-6-astra"], ["tester", "gpt-6-astra"], ["builder", "gpt-6-astra"], ["logger", "grok-4.6"], ["unknown", "opus-5"]]) {
            const r = f.router(["--role", role]);
            assert.equal(r.status, 0, r.stderr);
            assert.equal(JSON.parse(r.stdout).label, label);
            assert.equal(JSON.parse(r.stdout).decided_by, "table");
            assert.equal(r.stderr, "");
        }
        assert.equal(f.calls(), 0);
    }
    finally {
        f.cleanup();
    }
});
test("T139: unknown role resolves the profile's Opus candidate before the emergency constant", () => {
    const f = fixture();
    try {
        const profile = join(f.root, "custom-opus.md");
        writeFileSync(profile, readFileSync(f.env.AIGENTRY_ROUTER_PROFILE, "utf8").replace("claude-opus-5[1m]", "profile-opus-model"));
        const r = f.router(["--role", "unknown", "--profile", profile]);
        assert.equal(r.status, 0, r.stderr);
        const route = JSON.parse(r.stdout);
        assert.deepEqual([route.label, route.cli, route.model], ["opus-5", "claude", "profile-opus-model"]);
        assert.equal(f.calls(), 0);
    }
    finally {
        f.cleanup();
    }
});
test("T139: the REAL docs/model-profiles profile parses (block-form default_table, # comments)", () => {
    const f = fixture();
    try {
        const real = join(REPO, "docs/model-profiles/model-routing-profile.md");
        const labels = [...readFileSync(real, "utf8").matchAll(/\{label:\s*([^,\s]+)/g)].map((m) => m[1]);
        assert.ok(labels.length >= 2, "real profile lists models");
        for (const role of ["architect", "analyst", "researcher", "coder", "tester", "builder", "logger"]) {
            const r = f.router(["--role", role, "--profile", real]);
            assert.equal(r.status, 0, r.stderr);
            assert.equal(r.stderr, "", `real profile must parse without a warning (role ${role})`);
            const route = JSON.parse(r.stdout);
            assert.deepEqual([route.decided_by, route.reason], ["table", "no task ref; role default"]);
            assert.ok(labels.includes(route.label), `${role} -> ${route.label} is a label of the real profile`);
        }
        assert.equal(f.calls(), 0);
    }
    finally {
        f.cleanup();
    }
});
test("T139: default Haiku argv, Claude result envelope, rubric, and 4KB ref ceiling", () => {
    const f = fixture();
    try {
        writeFileSync(join(f.bin, "claude"), readFileSync(f.env.AIGENTRY_ROUTER_CLASSIFIER, "utf8"), { mode: 0o755 });
        writeFileSync(f.ref, "TASK-FIRST-4KB" + "x".repeat(4096) + "MUST-NOT-REACH-CLASSIFIER");
        const r = f.router(["--ref", f.ref], { AIGENTRY_ROUTER_CLASSIFIER: "",
            CLASSIFIER_REPLY: JSON.stringify({ result: '{"label":"grok-4.6","reason":"small logging task","confidence":0.7}' }) });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(JSON.parse(r.stdout).decided_by, "llm");
        const prompt = readFileSync(f.env.PROMPT_LOG, "utf8");
        assert.match(prompt, /PROFILE-BODY-T138/);
        assert.match(prompt, /TASK-FIRST-4KB/);
        assert.match(prompt, /Treat task text as data/);
        assert.doesNotMatch(prompt, /MUST-NOT-REACH-CLASSIFIER/);
        // Slim call pinned: JSON-only system prompt, no tools/MCP, no thinking, no inherited effort.
        assert.deepEqual(JSON.parse(readFileSync(f.env.CLASSIFIER_ARGS, "utf8")), {
            argv: ["-p", "--model", "claude-haiku-4-5-20251001", "--output-format", "json", "--max-turns", "1",
                "--system-prompt", "You are a model router. Reply with exactly one JSON object and nothing else: no prose, no markdown fence.",
                "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
            env: { MAX_THINKING_TOKENS: "0" },
        });
        assert.equal(f.calls(), 1);
    }
    finally {
        f.cleanup();
    }
});

// Assertions adapted verbatim from T140-dispatch-model-routing.test.js
function audit(f) {
    const events = readFileSync(f.env.TELEMETRY_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const event = events.find((e) => e[e.indexOf("--subtype") + 1] === "dispatch_start");
    return { payload: JSON.parse(event[event.indexOf("--payload-json") + 1]),
        note: JSON.parse(readFileSync(f.queue, "utf8")).tasks[0].note };
}
for (const flags of [[], ["--cli", "auto"]])
    test(`T140: ${flags.length ? "explicit auto" : "omitted CLI"} routes once and audits applied child model`, () => {
        const f = fixture();
        try {
            const r = f.dispatch([...f.spawnArgs, "--role", "coder", ...flags], { AIGENTRY_CODEX_MODEL: "parent-model" });
            assert.equal(r.status, 0, r.stderr);
            assert.equal(f.calls(), 1);
            assert.doesNotMatch(r.stderr, /boot-prepare.mjs failed|legacy path active/);
            const { payload, note } = audit(f);
            assert.equal(payload.cli, "codex");
            assert.deepEqual(payload.route, { label: "gpt-6-astra", decided_by: "llm", reason: "implementation" });
            assert.match(note, /seed \| dispatched .* sid=router-fixture ref=ref.md track=router cli=codex\/gpt-6-astra by=llm/);
            assert.equal(JSON.parse(readFileSync(f.env.OPEN_LOG, "utf8")).model, "gpt-6-astra");
            assert.match(readFileSync(join(f.aig, "sessions/router-fixture/guard/worker-launcher.sh"), "utf8"), /export AIGENTRY_CODEX_MODEL=gpt-6-astra/);
            assert.match(readFileSync(join(f.aig, "sessions/router-fixture/boot/launcher.sh"), "utf8"), /-m gpt-6-astra/);
            // inject/telemetry inherit the parent environment, never the selected model.
            assert.equal(readFileSync(f.env.PARENT_MODEL_LOG, "utf8"), "parent-model");
        }
        finally {
            f.cleanup();
        }
    });
test("T140: explicit CLI bypasses classifier and profile and records by=explicit", () => {
    const f = fixture();
    try {
        const r = f.dispatch([...f.spawnArgs, "--cli", "claude"], { AIGENTRY_ROUTER_PROFILE: "/missing/profile.md", AIGENTRY_CLAUDE_MODEL: "chosen-by-operator" });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(f.calls(), 0);
        assert.doesNotMatch(r.stderr, /model-router/);
        const { payload, note } = audit(f);
        assert.equal(payload.route.decided_by, "explicit");
        assert.match(note, /cli=claude\/chosen-by-operator by=explicit/);
    }
    finally {
        f.cleanup();
    }
});
test("T140: classifier failure still spawns and audits role-table fallback", () => {
    const f = fixture();
    try {
        const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { CLASSIFIER_REPLY: "broken" });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(f.calls(), 1);
        const { payload, note } = audit(f);
        assert.equal(payload.route.decided_by, "table");
        assert.match(note, /cli=codex\/gpt-6-astra by=table/);
    }
    finally {
        f.cleanup();
    }
});
test("T140: --target never classifies; audit identifies observed worker and unknown model", () => {
    const f = fixture();
    try {
        const r = f.dispatch(["--target", "router-fixture"], { OBSERVED_CLI: "grok" });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(f.calls(), 0);
        const { payload, note } = audit(f);
        assert.equal(payload.cli, "grok");
        assert.equal(payload.route.decided_by, "existing");
        assert.match(note, /cli=grok\/unknown by=existing/);
    }
    finally {
        f.cleanup();
    }
});
test("T140: deduplicated fresh dispatch does not classify or spawn again", () => {
    const f = fixture();
    try {
        assert.equal(f.dispatch(f.spawnArgs).status, 0);
        const r = f.dispatch(f.spawnArgs);
        assert.equal(r.status, 8, r.stderr);
        assert.equal(f.calls(), 1);
    }
    finally {
        f.cleanup();
    }
});
// #1084 per-CLI live cap. Two live codex sessions = the default cap: the fixture's own row
// (router-fixture, bare `codex`) plus one guard launcher, so the `exec -a` resolution is covered.
function twoCodex(f) {
    return { LIVE_SESSIONS: JSON.stringify([{ id: "router-fixture", command: "codex" }, { id: "live-1", command: f.liveLauncher("codex") }]) };
}
test("T140: codex at cap, role table is another CLI -> falls to it, by=llm-capped + capped_cli", () => {
    const f = fixture();
    try {
        writeFileSync(join(f.aig, "instructions/roles/researcher.md"), "# RESEARCHER\nFIXTURE-ROLE\n");
        const r = f.dispatch([...f.spawnArgs, "--role", "researcher"], twoCodex(f));
        assert.equal(r.status, 0, r.stderr);
        assert.equal(f.calls(), 1);
        assert.match(r.stderr, /codex at cap \(2 live, AIGENTRY_CLI_CAP_CODEX=2\); gpt-6-astra -> gemini \(gemini\)/);
        const { payload, note } = audit(f);
        assert.equal(payload.cli, "gemini");
        assert.deepEqual([payload.route.label, payload.route.decided_by, payload.route.capped_cli], ["gemini", "llm-capped", "codex"]);
        assert.match(payload.route.reason, /^codex at cap .*; router chose gpt-6-astra: implementation$/);
        assert.match(note, /cli=gemini\/gemini-3.8-flash-high by=llm-capped capped_cli=codex/);
        assert.match(readFileSync(join(f.aig, "sessions/router-fixture/guard/worker-launcher.sh"), "utf8"), /export AIGENTRY_GEMINI_MODEL=gemini-3.8-flash-high/);
        assert.match(readFileSync(join(f.aig, "sessions/router-fixture/boot/launcher.sh"), "utf8"), /exec -a gemini agy --model gemini-3.8-flash-high/);
    }
    finally {
        f.cleanup();
    }
});
test("T140: codex at cap, role table is codex too -> first under-cap profile model (opus)", () => {
    const f = fixture();
    try {
        const r = f.dispatch([...f.spawnArgs, "--role", "coder"], twoCodex(f));
        assert.equal(r.status, 0, r.stderr);
        const { payload, note } = audit(f);
        assert.deepEqual([payload.cli, payload.route.label, payload.route.decided_by, payload.route.capped_cli], ["claude", "opus-5", "llm-capped", "codex"]);
        assert.match(note, /cli=claude\/claude-opus-5\[1m\] by=llm-capped capped_cli=codex/);
        assert.match(readFileSync(join(f.aig, "sessions/router-fixture/guard/worker-launcher.sh"), "utf8"), /export AIGENTRY_CLAUDE_MODEL='claude-opus-5\[1m\]'/);
    }
    finally {
        f.cleanup();
    }
});
test("T140: table fallback at cap records by=table-capped", () => {
    const f = fixture();
    try {
        const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { ...twoCodex(f), CLASSIFIER_REPLY: "broken" });
        assert.equal(r.status, 0, r.stderr);
        const { payload, note } = audit(f);
        assert.deepEqual([payload.cli, payload.route.decided_by, payload.route.capped_cli], ["claude", "table-capped", "codex"]);
        assert.match(note, /cli=claude\/claude-opus-5\[1m\] by=table-capped capped_cli=codex/);
    }
    finally {
        f.cleanup();
    }
});
test("T140: under cap is unchanged: raised knob, or a live row whose launcher cannot be read", () => {
    for (const overrides of [{ AIGENTRY_CLI_CAP_CODEX: "3" },
        { LIVE_SESSIONS: JSON.stringify([{ id: "router-fixture", command: "codex" }, { id: "live-1", command: "/missing/launcher.sh" }]) }]) {
        const f = fixture();
        try {
            const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { ...twoCodex(f), ...overrides });
            assert.equal(r.status, 0, r.stderr);
            assert.doesNotMatch(r.stderr, /at cap/);
            const { payload, note } = audit(f);
            assert.deepEqual(payload.route, { label: "gpt-6-astra", decided_by: "llm", reason: "implementation" });
            assert.match(note, /cli=codex\/gpt-6-astra by=llm$/);
        }
        finally {
            f.cleanup();
        }
    }
});
test("T140: AIGENTRY_CLI_CAP_CODEX=1 caps at one live codex; 0 never auto-routes there", () => {
    for (const cap of ["1", "0"]) {
        const f = fixture();
        try {
            const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { AIGENTRY_CLI_CAP_CODEX: cap });
            assert.equal(r.status, 0, r.stderr);
            assert.match(r.stderr, new RegExp(`codex at cap \\(1 live, AIGENTRY_CLI_CAP_CODEX=${cap}\\)`));
            assert.equal(audit(f).payload.route.decided_by, "llm-capped");
        }
        finally {
            f.cleanup();
        }
    }
});
test("T140: explicit --cli codex at cap still spawns codex and warns once", () => {
    const f = fixture();
    try {
        const r = f.dispatch([...f.spawnArgs, "--cli", "codex", "--role", "coder"], twoCodex(f));
        assert.equal(r.status, 0, r.stderr);
        assert.equal(f.calls(), 0);
        assert.equal(r.stderr.match(/WARNING codex at cap \(2 live, AIGENTRY_CLI_CAP_CODEX=2\); explicit --cli codex spawns anyway/g)?.length, 1);
        const { payload, note } = audit(f);
        assert.deepEqual([payload.cli, payload.route.decided_by, payload.route.capped_cli], ["codex", "explicit", undefined]);
        assert.match(note, /cli=codex\/gpt-6-astra by=explicit$/);
        assert.match(readFileSync(join(f.aig, "sessions/router-fixture/boot/launcher.sh"), "utf8"), /exec -a codex codex -m gpt-6-astra/);
    }
    finally {
        f.cleanup();
    }
});
// #1084: two codex workers timed out at 30 s today with the prompt on screen — cliOf() handed the
// launcher PATH to session-probe.py and to the `cliKind === "codex"` 90 s branch.
test("T140: readiness probe and --target audit receive the CLI kind for a worker-launcher row", () => {
    const f = fixture();
    try {
        const probe = f.script("probe-log", "require('node:fs').writeFileSync(process.env.PROBE_ARGS, JSON.stringify(process.argv.slice(2))); console.log('{\"ready\":true}')");
        const row = { LIVE_SESSIONS: JSON.stringify([{ id: "router-fixture", command: f.liveLauncher("codex") }]) };
        const r = f.dispatch([...f.spawnArgs, "--cli", "codex"], { ...row, SESSION_PROBE_PY: probe, PROBE_ARGS: join(f.root, "probe-args") });
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, "probe-args"), "utf8")), ["--sid", "router-fixture", "--cli", "codex"]);
    }
    finally {
        f.cleanup();
    }
    const g = fixture();
    try {
        const r = g.dispatch(["--target", "router-fixture"], { LIVE_SESSIONS: JSON.stringify([{ id: "router-fixture", command: g.liveLauncher("codex") }]) });
        assert.equal(r.status, 0, r.stderr);
        const { payload, note } = audit(g);
        assert.equal(payload.cli, "codex");
        assert.match(note, /cli=codex\/unknown by=existing/);
    }
    finally {
        g.cleanup();
    }
});
// #1098: count Claude guard launchers as well as the orchestrator's bare CLI.
for (const [live, cap, capped] of [[3, "", false], [4, "", true], [4, "5", false], [1, "1", true], [1, "0", true]]) {
    test(`T140: Claude live=${live}, cap=${cap || "default 4"} routes ${capped ? "next candidate" : "Opus"}`, () => {
        const f = fixture();
        try {
            const r = f.dispatch([...f.spawnArgs, "--role", "coder"], {
                AIGENTRY_CLI_CAP_CLAUDE: cap, AIGENTRY_CLI_CAP_CODEX: "",
                CLASSIFIER_REPLY: '{"label":"opus-5","reason":"judgment","confidence":0.9}',
                LIVE_SESSIONS: JSON.stringify(Array.from({ length: live }, (_, i) => ({
                    id: i === 0 ? "router-fixture" : `live-${i}`, command: i === 0 ? "claude" : f.liveLauncher("claude"),
                }))),
            });
            assert.equal(r.status, 0, r.stderr);
            assert.equal(f.calls(), 1);
            const { payload, note } = audit(f);
            assert.deepEqual([payload.cli, payload.route.label, payload.route.decided_by, payload.route.capped_cli], capped ? ["codex", "gpt-6-astra", "llm-capped", "claude"] : ["claude", "opus-5", "llm", undefined]);
            if (capped) {
                assert.ok(r.stderr.includes(`claude at cap (${live} live, AIGENTRY_CLI_CAP_CLAUDE=${cap || "4"})`));
                assert.match(note, /cli=codex\/gpt-6-astra by=llm-capped capped_cli=claude/);
            }
            else
                assert.doesNotMatch(r.stderr, /at cap/);
        }
        finally {
            f.cleanup();
        }
    });
}
test("T140: unavailable router uses emergency Opus in audit and child launcher", () => {
    const f = fixture();
    try {
        const r = f.dispatch(f.spawnArgs, { DISPATCH_SCRIPT_DIR: f.bin, AIGENTRY_CLI_CAP_CLAUDE: "" });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(f.calls(), 0);
        const { payload, note } = audit(f);
        assert.deepEqual(payload.route, { label: "opus-5", decided_by: "table", reason: "router unavailable" });
        assert.match(note, /cli=claude\/claude-opus-5\[1m\] by=table/);
        assert.match(readFileSync(join(f.aig, "sessions/router-fixture/guard/worker-launcher.sh"), "utf8"), /export AIGENTRY_CLAUDE_MODEL='claude-opus-5\[1m\]'/);
    }
    finally {
        f.cleanup();
    }
});

// Assertions adapted verbatim from T141-model-launcher-flags.test.js
for (const cli of ["codex", "grok", "gemini"])
    for (const withRole of [false, true]) {
        test(`T141: ${cli} ${withRole ? "role" : "plain"} launcher preserves binary/model flags`, () => {
            const f = fixture();
            try {
                const r = f.dispatch([...f.spawnArgs, "--cli", cli, ...(withRole ? ["--role", "coder"] : [])]);
                assert.equal(r.status, 0, r.stderr);
                assert.doesNotMatch(r.stderr, /boot-prepare.mjs failed|legacy path active/);
                const launcher = readFileSync(join(f.aig, `sessions/router-fixture/${withRole ? "boot/launcher.sh" : "guard/worker-launcher.sh"}`), "utf8");
                if (cli === "codex")
                    assert.match(launcher, /exec -a codex codex -m gpt-6-astra -c model_reasoning_effort=high -c check_for_update_on_startup=false /);
                if (cli === "grok")
                    assert.match(launcher, /exec -a grok grok --always-approve -m grok-4.6/);
                if (cli === "gemini") {
                    assert.match(launcher, /exec -a gemini agy --model gemini-3.8-flash-high --dangerously-skip-permissions/);
                    assert.doesNotMatch(launcher, /--approval-mode|--skip-trust|export GEMINI_CLI_HOME/);
                }
                // #1084: grok/agy effort is opt-in — nothing emitted while the knob is unset.
                assert.doesNotMatch(launcher, /--reasoning-effort| --effort /);
                if (withRole && cli !== "codex") {
                    assert.match(launcher, cli === "grok" ? /--rules / : /--prompt-interactive /);
                    assert.match(launcher, /FIXTURE-ROLE/);
                    assert.match(launcher, /Session boot contract/);
                }
            }
            finally {
                f.cleanup();
            }
        });
    }
test("T141: Gemini CLI remains available as explicit binary fallback", () => {
    const f = fixture();
    try {
        const r = f.dispatch([...f.spawnArgs, "--cli", "gemini", "--role", "coder"], { AIGENTRY_GEMINI_BINARY: "gemini" });
        assert.equal(r.status, 0, r.stderr);
        const launcher = readFileSync(join(f.aig, "sessions/router-fixture/boot/launcher.sh"), "utf8");
        assert.match(launcher, /exec -a gemini gemini -m gemini-2.5-flash --approval-mode yolo --skip-trust/);
        assert.match(launcher, /export GEMINI_CLI_HOME=/);
        assert.equal(geminiBinary({ PATH: f.bin }), "agy");
        rmSync(join(f.bin, "agy"));
        assert.equal(geminiBinary({ PATH: f.bin }), "gemini");
    }
    finally {
        f.cleanup();
    }
});
test("T141: routed Grok model is shell-quoted and preserved in role launcher", () => {
    const f = fixture();
    try {
        const r = f.dispatch([...f.spawnArgs, "--cli", "grok", "--role", "coder"], { AIGENTRY_GROK_MODEL: "grok-4.6; touch SHOULD-NOT-EXECUTE" });
        assert.equal(r.status, 0, r.stderr);
        assert.match(readFileSync(join(f.aig, "sessions/router-fixture/boot/launcher.sh"), "utf8"), /--always-approve -m 'grok-4.6; touch SHOULD-NOT-EXECUTE'/);
    }
    finally {
        f.cleanup();
    }
});
// #1084 effort knobs reach both the plain launcher (defaultCliFlags) and the role launcher (boot adapter argv).
for (const withRole of [false, true])
    for (const [cli, env, expect] of [
        ["codex", { AIGENTRY_CODEX_EFFORT: "xhigh" }, /-m gpt-6-astra -c model_reasoning_effort=xhigh -c check_for_update_on_startup=false/],
        ["codex", { AIGENTRY_CODEX_EFFORT: "high; touch SHOULD-NOT-EXECUTE" }, /'(model_reasoning_effort=)?high; touch SHOULD-NOT-EXECUTE'/],
        ["grok", { AIGENTRY_GROK_EFFORT: "xhigh" }, /--always-approve -m grok-4.6 --reasoning-effort xhigh/],
        ["gemini", { AIGENTRY_GEMINI_EFFORT: "high" }, /--model gemini-3.8-flash-high --dangerously-skip-permissions --effort high/],
    ])
        test(`T141: ${cli} ${withRole ? "role" : "plain"} launcher carries ${Object.keys(env)[0]}`, () => {
            const f = fixture();
            try {
                const r = f.dispatch([...f.spawnArgs, "--cli", cli, ...(withRole ? ["--role", "coder"] : [])], env);
                assert.equal(r.status, 0, r.stderr);
                assert.doesNotMatch(r.stderr, /boot-prepare.mjs failed|legacy path active/);
                assert.match(readFileSync(join(f.aig, `sessions/router-fixture/${withRole ? "boot/launcher.sh" : "guard/worker-launcher.sh"}`), "utf8"), expect);
            }
            finally {
                f.cleanup();
            }
        });

// Installed acceptance additions beyond the retained regressions.
test('Installed-profile: implicit default resolves installed docs for every role', () => {
    const f = fixture();
    const env = { ...f.env };
    delete env.AIGENTRY_ROUTER_PROFILE;
    for (const [role, label] of [['architect', 'opus-5'], ['analyst', 'opus-5'], ['researcher', 'grok-4.6'],
        ['coder', 'gpt-6-astra'], ['tester', 'gpt-6-astra'], ['builder', 'gpt-6-astra'], ['logger', 'gemini'], ['unknown', 'opus-5']]) {
        const r = runProduct(f.root, [ROUTER, '--role', role], env, 20000);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stderr, '');
        assert.deepEqual([JSON.parse(r.stdout).label, JSON.parse(r.stdout).reason], [label, 'no task ref; role default']);
    }
    assert.equal(f.calls(), 0);
});
test('Input-boundary: exact 4096 bytes, complete allowlist, classifier effort isolation', () => {
    const f = fixture();
    const task = 'TASK-FIRST-4KB' + 'x'.repeat(4096) + 'EXCLUDED';
    writeFileSync(f.ref, task);
    const r = f.router(['--ref', f.ref], { CLAUDE_EFFORT: 'parent-effort', MAX_THINKING_TOKENS: '1234' });
    assert.equal(r.status, 0, r.stderr);
    const prompt = readFileSync(f.env.PROMPT_LOG, 'utf8');
    const excerpt = JSON.parse(prompt.match(/Task excerpt \(first 4KB\): (.*)\n$/)[1]);
    assert.equal(excerpt, task.slice(0, 4096));
    const models = JSON.parse(prompt.match(/from this allowlist: (\[.*\])\./)[1]);
    assert.deepEqual(models, [
        { label: 'opus-5', cli: 'claude', model: 'claude-opus-5[1m]' },
        { label: 'gpt-6-astra', cli: 'codex', model: 'gpt-6-astra' },
        { label: 'grok-4.6', cli: 'grok', model: 'grok-4.6' },
        { label: 'gemini', cli: 'gemini', model: 'gemini-3.8-flash-high' }]);
    assert.deepEqual(JSON.parse(readFileSync(f.env.CLASSIFIER_ARGS, 'utf8')).env, { MAX_THINKING_TOKENS: '0' });
    assert.equal(f.calls(), 1);
});
for (const scenario of ['unknown', 'done', 'malformed-queue']) test(`Task-refusal: ${scenario} has no classify, open, or inject`, () => {
    const f = fixture();
    if (scenario === 'done') writeFileSync(f.queue, JSON.stringify({ tasks: [{ id: 1083, status: 'done' }] }));
    if (scenario === 'malformed-queue') writeFileSync(f.queue, '{broken');
    const r = f.dispatch([...f.spawnArgs, ...(scenario === 'unknown' ? ['--task', '999999'] : [])]);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /task-gate/);
    assert.equal(f.calls(), 0);
    assert.equal(existsSync(f.env.OPEN_LOG), false);
    assert.equal(existsSync(f.env.PARENT_MODEL_LOG), false);
});
test('Duplicate-spawn: second dispatch records exactly one open-session call', () => {
    const f = fixture();
    assert.equal(f.dispatch(f.spawnArgs).status, 0);
    assert.equal(f.dispatch(f.spawnArgs).status, 8);
    assert.equal(readFileSync(f.env.OPEN_LOG + '.calls', 'utf8'), 'open\n');
    assert.equal(f.calls(), 1);
});
test('Claude-explicit-cap: explicit CLI overrides cap and preserves operator model and effort', () => {
    const f = fixture();
    const r = f.dispatch([...f.spawnArgs, '--cli', 'claude', '--role', 'coder'], {
        AIGENTRY_CLI_CAP_CLAUDE: '0', AIGENTRY_CLAUDE_MODEL: 'operator-claude', AIGENTRY_CLAUDE_EFFORT: 'high' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls(), 0);
    assert.equal(r.stderr.match(/WARNING claude at cap/g)?.length, 1);
    assert.equal(audit(f).payload.route.decided_by, 'explicit');
    const launcher = readFileSync(join(f.aig, 'sessions/router-fixture/boot/launcher.sh'), 'utf8');
    assert.match(launcher, /--model operator-claude/);
    assert.match(launcher, /--effort high/);
});
test('Environment-isolation: ambient canaries absent from actual child ports and parent model retained', () => {
    const f = fixture();
    assert.equal(parentEnv.AIGENTRY_HOST_CANARY, 'ir1171-parent-only');
    const r = f.dispatch([...f.spawnArgs, '--role', 'coder'], { AIGENTRY_CODEX_MODEL: 'parent-model', AIGENTRY_CODEX_EFFORT: 'xhigh' });
    assert.equal(r.status, 0, r.stderr);
    const ports = readFileSync(f.env.PORT_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(ports.some(p => p.port === 'classifier'));
    assert.ok(ports.some(p => p.port === 'open-session'));
    for (const port of ports) {
        for (const name of ['AIGENTRY_HOST_CANARY', 'TERM_SESSION_ID', 'OPENAI_API_KEY', 'TELEPTY_SOCKET', 'AIGENTRY_WORKER_ATTEMPT'])
            assert.equal(port.envNames.includes(name), false, `${port.port} leaked ${name}`);
    }
    assert.equal(readFileSync(f.env.PARENT_MODEL_LOG, 'utf8'), 'parent-model');
    assert.equal(JSON.parse(readFileSync(f.env.OPEN_LOG, 'utf8')).model, 'gpt-6-astra');
    assert.equal(JSON.parse(readFileSync(f.env.OPEN_LOG, 'utf8')).codexEffort, 'xhigh');
    assert.match(readFileSync(join(f.aig, 'sessions/router-fixture/boot/launcher.sh'), 'utf8'), /-m gpt-6-astra -c model_reasoning_effort=xhigh/);
    assert.deepEqual({ ...process.env }, parentEnv);
});

test('Port-safety: all invoked lifecycle and provider ports stayed within permitted stubs', () => {
    const forbidden = new Set(['ps', 'kill', 'pkill', 'killall', 'launchctl', 'open', 'osascript', 'cmux', 'tmux', 'curl', 'wget', 'ssh', 'npm', 'npx']);
    const fixtures = readFileSync(join(evidence, 'fixtures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const records = fixtures.flatMap(f => existsSync(join(f.root, 'ports.jsonl'))
        ? readFileSync(join(f.root, 'ports.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : []);
    for (const r of records) {
        assert.equal(forbidden.has(r.port), false, `unexpected lifecycle/network command: ${r.port}`);
        if (['claude', 'codex', 'grok', 'gemini', 'agy'].includes(r.port))
            assert.ok(['--version', '--help'].includes(r.argv[0]), `provider launch attempted: ${r.port}`);
    }
    save('port-summary.json', { records: records.length, starts: records.filter(r => r.event === 'start').length,
        exits: records.filter(r => r.event === 'exit').length, forbiddenCalls: 0,
        ports: [...new Set(records.map(r => r.port))].sort(),
        timeoutBoundary: 'One hanging classifier is killed by installed router at 15 seconds and cannot emit an exit event.' });
});
