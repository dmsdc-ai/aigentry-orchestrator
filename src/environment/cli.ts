import * as fs from "node:fs";
import * as path from "node:path";
import { bootstrapEnvironment } from "./bootstrap.js";
import { profileName, type Settings } from "./contract.js";
import { CATALOG, DESCRIPTORS, descriptor, validateSetting } from "./descriptors.js";
import { configPath, environmentHome, mutateConfig, readConfig, recoverWriterLock } from "./storage.js";
import { abortExplicitReceipt, abortGrant, controllerContext, createBinding, disableProject, enrollProject, inspectGrants,
  reapExpired, reclaimGrants, revokeBinding, rotateGrants, upgradeConfig } from "./grants.js";
import { parseDeclaredVersion } from "./executable-version.js";
import { readLegacy, resolveSettings } from "./resolve.js";

export const ENV_USAGE = "aigentry-orchestrator env locate | list --json | explain ID | doctor --json | schema upgrade --expected-revision N | project enroll ABS --expected-revision N | project disable ID --expected-revision N | binding create --descriptor claude.worker.oauth --project ID --expected-revision N | binding disable ID --expected-revision N | grants inspect --json | grants rotate/reclaim --expected-revision N --expected-generation G [--limit L] | grants abort GRANT_ID | grants abort-explicit SID ATTEMPT | grants reap --limit L | grants recover-lock | set ID VALUE --expected-revision N [--profile NAME | --project ABS] | unset ID --expected-revision N [--profile NAME | --project ABS] | profile select NAME --expected-revision N";
export function environmentCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): { code: number; out: string; err: string } {
  const json = (v: unknown) => ({ code: 0, out: JSON.stringify(v) + "\n", err: "" });
  try {
    const home = environmentHome(env);
    const [cmd, ...args] = argv;
    if (cmd === "--help" && args.length === 0) return { code: 0, out: ENV_USAGE + "\n", err: "" };
    if (cmd === "locate" && (args.length === 0 || (args.length === 1 && args[0] === "--json"))) return json({ home, config: configPath(home) });
    if ((cmd === "list" || cmd === "doctor") && args.length === 1 && args[0] === "--json") {
      const b = bootstrapEnvironment(env, { targetCwd: process.cwd() });
      if (cmd === "doctor") return json(b.awareness);
      // All descriptors are nonsecret; awareness itself includes provenance only.
      return json({ revision: b.resolution.revision, settings: DESCRIPTORS.map((d) => ({ id: d.id, value: b.resolution.values[d.id] ?? null, source: b.resolution.provenance[d.id] ?? "caller-default" })), catalog: CATALOG });
    }
    if (cmd === "explain" && args.length === 1) {
      const publicRecord = CATALOG.find(d => d.id === args[0]);
      if (publicRecord) return json({ ...publicRecord, configured: readConfig(home).version === 2 &&
        publicRecord.id === "claude.worker.oauth" && Object.keys((readConfig(home) as import("./contract.js").ConfigV2).bindings).length > 0 });
      const d = descriptor(args[0]!);
      const b = bootstrapEnvironment(env, { targetCwd: process.cwd() });
      return json({ id: d.id, revision: b.resolution.revision, source: b.resolution.provenance[d.id] ?? "caller-default", editable: "nonsecret", aliases: d.aliases });
    }
    const number = (v: string | undefined): number => {
      if (!v || !/^(0|[1-9][0-9]*)$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error("ENV_USAGE");
      return Number(v);
    };
    const revision = (tail: readonly string[]): number => {
      if (tail.length !== 2 || tail[0] !== "--expected-revision") throw new Error("ENV_USAGE");
      return number(tail[1]);
    };
    if (cmd === "schema" && args[0] === "upgrade") return json({ revision: upgradeConfig(home, revision(args.slice(1))).revision });
    if (cmd === "project" && args[0] === "enroll" && args[1]) {
      const r = enrollProject(controllerContext(home), args[1], revision(args.slice(2)));
      return json({ enrollmentId: r.id, revision: r.revision });
    }
    if (cmd === "project" && args[0] === "disable" && args[1]) {
      return json({ revision: disableProject(controllerContext(home), args[1], revision(args.slice(2))) });
    }
    if (cmd === "binding" && args[0] === "disable" && args[1]) {
      return json({ revision: revokeBinding(controllerContext(home), args[1], revision(args.slice(2))) });
    }
    if (cmd === "binding" && args[0] === "create" && args[1] === "--descriptor" && args[2] === "claude.worker.oauth" &&
        args[3] === "--project" && args[4]) {
      const expected = revision(args.slice(5));
      const c = readConfig(home);
      if (c.version !== 2) throw new Error("ENV_SCHEMA_UPGRADE_REQUIRED");
      const declared = parseDeclaredVersion(c.settings["claude.version"]);
      const binary = c.settings["claude.executable"];
      if (!declared || !binary || !path.isAbsolute(binary) || path.basename(binary) !== "claude") throw new Error("ENV_BINDING_POLICY_REFUSED");
      const real = fs.realpathSync.native(binary), st = fs.statSync(real);
      if (!st.isFile() || st.dev !== declared.dev || st.ino !== declared.ino || st.size !== declared.size || st.mtimeMs !== declared.mtimeMs) throw new Error("ENV_BINDING_POLICY_REFUSED");
      const result = createBinding(controllerContext(home), args[4], { cli: "claude", path: binary, realpath: real,
        dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, version: declared.version,
        versionSource: "operator-declared" }, expected);
      return json({ bindingId: result.id, locatorId: result.locatorId, revision: result.revision });
    }
    if (cmd === "grants" && args[0] === "inspect" && args[1] === "--json" && args.length === 2) {
      return json(inspectGrants(controllerContext(home)));
    }
    if (cmd === "grants" && args[0] === "recover-lock" && args.length === 1) {
      return json({ recovered: recoverWriterLock(controllerContext(home).home) });
    }
    if (cmd === "grants" && args[0] === "abort" && args[1] && args.length === 2) {
      return json({ terminalized: abortGrant(controllerContext(home), args[1]) });
    }
    if (cmd === "grants" && args[0] === "abort-explicit" && args[1] && args[2] && args.length === 3) {
      return json({ terminalized: abortExplicitReceipt(controllerContext(home), args[1], args[2]) });
    }
    if (cmd === "grants" && args[0] === "reap" && args[1] === "--limit" && args.length === 3) {
      return json({ terminalized: reapExpired(controllerContext(home), number(args[2])) });
    }
    if (cmd === "grants" && (args[0] === "rotate" || args[0] === "reclaim") &&
        args[1] === "--expected-revision" && args[3] === "--expected-generation") {
      const ctx = controllerContext(home), expected = number(args[2]), generation = number(args[4]);
      if (args[0] === "rotate" && args.length === 5) {
        const next = rotateGrants(ctx, expected, generation);
        return json({ revision: next.revision, authorityGeneration: next.authorityGeneration,
          retiredRecords: next.retiredRecords });
      }
      if (args[0] === "reclaim" && args[5] === "--limit" && args.length === 7) {
        return json({ reclaimed: reclaimGrants(ctx, expected, generation, number(args[6])) });
      }
      throw new Error("ENV_USAGE");
    }
    const rest = [...args];
    let id: string | undefined, value: string | undefined, selected: string | undefined;
    if (cmd === "set" || cmd === "unset") {
      id = rest.shift(); descriptor(id ?? "");
      if (cmd === "set") value = validateSetting(id!, rest.shift());
    } else if (cmd === "profile" && rest.shift() === "select") selected = profileName(rest.shift());
    else throw new Error("ENV_USAGE");
    let expected: number | undefined, profile: string | undefined, project: string | undefined;
    while (rest.length) {
      const flag = rest.shift(), v = rest.shift();
      if (flag === "--expected-revision" && expected === undefined && v !== undefined && /^(0|[1-9][0-9]*)$/.test(v)) expected = Number(v);
      else if (flag === "--profile" && profile === undefined && selected === undefined) profile = profileName(v);
      else if (flag === "--project" && project === undefined && selected === undefined && v !== undefined && path.isAbsolute(v)) {
        project = fs.realpathSync.native(v);
        if (project !== path.normalize(v) || !fs.statSync(project).isDirectory()) throw new Error("ENV_PROJECT_NOT_CANONICAL");
      } else throw new Error("ENV_USAGE");
    }
    if (expected === undefined || !Number.isSafeInteger(expected)) throw new Error("ENV_EXPECTED_REVISION_REQUIRED");
    if (profile && project) throw new Error("ENV_SCOPE_CONFLICT");
    const next = mutateConfig(home, expected, (c) => {
      if (selected !== undefined) {
        if (!Object.hasOwn(c.profiles, selected)) throw new Error("ENV_PROFILE_MISSING");
        c.selectedProfile = selected;
      } else {
        let target: Settings = c.settings;
        if (profile) { if (!Object.hasOwn(c.profiles, profile)) c.profiles[profile] = {}; target = c.profiles[profile]!; }
        if (project) { if (!Object.hasOwn(c.projects, project)) c.projects[project] = {}; target = c.projects[project]!; }
        if (cmd === "unset") delete target[id!]; else target[id!] = value!;
      }
      resolveSettings({ config: c, env, targetCwd: project ?? process.cwd(), legacy: readLegacy(home),
        ...(cmd === "set" ? { flags: { [id!]: value! } } : {}) });
      return c;
    });
    return json({ revision: next.revision });
  } catch (e) {
    // OS paths and supplied values never escape the diagnostic boundary.
    const message = e instanceof Error && e.message.startsWith("ENV_") ? e.message : "ENV_IO_REFUSED";
    return { code: 2, out: "", err: message + "\n" };
  }
}
