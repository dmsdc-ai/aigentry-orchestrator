// The init manifest — set A of SPEC 2026-08-15-npm-init-environment §3.5.
//
// This is the SINGLE literal path list. `init` iterates it to materialise a control
// workspace; tests/packaging/T96_ship_set_agreement.sh holds it against the REAL tarball
// (`npm pack --dry-run --json`) and against `git ls-files`. Three lists must agree or the
// install ships something init cannot find, or init copies something that is not shipped.
//
// Paths are repo-relative and resolve identically inside the published package, because
// package.json `files[]` (§3.4) reproduces exactly these roots.
//
// Rule 39 — re-measured at implementation time against the spec's counts:
//   bin/**  38 (spec §3.1 said 35): the tree carried 36 at 02135be — bin/telepty-bus-bridge.sh
//           landed in 9434a41, after the spec was measured — plus the 2 files of bin/init/.
//   tooling/instructions/**  12, as specified.
//   Governance layer 51 (spec said 48; delta is exactly the bin/** delta above).

/** Set A. Every path init promises the installed package contains, and copies. */
const MANIFEST = [
  // ---- bin/** — `git ls-files bin`, complete. T96 assertion 4 pins this to the tree.
  "bin/ask.sh",
  "bin/boot-prepare.mjs",
  "bin/dispatch-cleanup-scheduler.sh",
  "bin/dispatch-registry.py",
  "bin/dispatch-tracker.sh",
  "bin/dispatch-verify.sh",
  "bin/dispatch.sh",
  "bin/emit-telemetry.mjs",
  "bin/hitl.sh",
  "bin/init/cli.mjs",
  "bin/init/manifest.mjs",
  "bin/inject-handler.sh",
  "bin/install-instructions.sh",
  "bin/install-launchd.sh",
  "bin/lib/platform-unix.sh",
  "bin/lib/platform-windows.sh",
  "bin/lib/platform.sh",
  "bin/lib/telepty-auth.sh",
  "bin/lib/telepty-listing.sh",
  "bin/lib/workspace-host.sh",
  "bin/open-session.sh",
  "bin/orchestrator-boot.sh",
  "bin/orchestrator-bridge-auditor.sh",
  "bin/orchestrator-report-target.sh",
  "bin/policy.py",
  "bin/session-cleanup.sh",
  "bin/session-comms-auditor.sh",
  "bin/session-layout.py",
  "bin/session-probe.py",
  "bin/session-reconciler.sh",
  "bin/session-start.sh",
  "bin/snyk-scan.sh",
  "bin/spawn-telemetry-report.sh",
  "bin/telepty-bus-bridge.sh",
  "bin/tq-focus.sh",
  "bin/tq-status.sh",
  "bin/tq-track.sh",
  "bin/trust-path.sh",

  // ---- Doctrine. Owner-confirmed 2026-08-15 (§9.2): the full set ships.
  "AGENTS.md",
  "CLAUDE.md",
  "docs/rules.md",
  "docs/templates/dispatch-ref-checklist.md",
  "docs/templates/dispatch-ref-template.md",

  // ---- The one skill this repo owns (ADR 2026-07-26 §2 — it names 8 bin/ paths by path).
  // init additionally writes a COPY at .claude/skills/orchestrate-turn/SKILL.md (§2.3);
  // this repo's own .claude/skills/orchestrate-turn is a git symlink and is NOT shipped.
  ".agents/skills/orchestrate-turn/SKILL.md",

  ".claude/settings.json",
  ".claude/hooks/post-dispatch-verify-reminder.sh",

  "tooling/dispatch-prelude/README.md",
  "tooling/dispatch-prelude/generator.sh",
  "tooling/dispatch-prelude/lint.sh",
  "tooling/dispatch-prelude/template.md",

  "git-hooks/pre-push",

  // ---- Scaffold source for ~/.aigentry (§2.5), read by bin/install-instructions.sh.
  // These land in the workspace too: install-instructions.sh resolves its source as
  // "$SCRIPT_DIR/../tooling/instructions", so a workspace without them would hold a
  // broken copy of the script (§2.2 — "the layout the scripts already assume").
  "tooling/instructions/common.md",
  "tooling/instructions/CONSTITUTION.md",
  "tooling/instructions/config.template.json",
  "tooling/instructions/roles/analyst.md",
  "tooling/instructions/roles/architect.md",
  "tooling/instructions/roles/builder.md",
  "tooling/instructions/roles/coder.md",
  "tooling/instructions/roles/logger.md",
  "tooling/instructions/roles/orchestrator.md",
  "tooling/instructions/roles/researcher.md",
  "tooling/instructions/roles/reviewer.md",
  "tooling/instructions/roles/tester.md",
];

/** The scaffold layer (§3.2) — the 12 above. Everything else is the governance layer (§3.1). */
const SCAFFOLD_PREFIX = "tooling/instructions/";

/** Tarball paths under these roots must all appear in MANIFEST (T96 assertion 2):
 *  nothing ships into the governance surface without init placing it. */
const GOVERNANCE_ROOTS = [
  "bin/",
  "docs/rules.md",
  "docs/templates/",
  ".agents/",
  ".claude/",
  "tooling/",
  "git-hooks/",
  "AGENTS.md",
  "CLAUDE.md",
];

/** Not governance: the library payload plus the files npm always includes. */
const TARBALL_EXEMPT = ["package.json", "README.md", "README.tmpl.md", "LICENSE", "dist/"];

/** §4.2's template variables. #6 and #7 are two occurrences of one token, so five
 *  host-specific values reduce to four distinct tokens. A survivor after step 6 is exit 7.
 *
 *  Deliberately NOT "any {{…}}": the shipping set carries runtime placeholders that must
 *  survive init untouched — {{ORCHESTRATOR_REPORT_TARGET}} (substituted by bin/dispatch.sh
 *  at inject time, #690) and tooling/dispatch-prelude/template.md's {{SESSION_ID}} et al.
 *  Measured: 9 files carry such tokens. Grepping for "{{" would make init always exit 7. */
const TEMPLATE_TOKENS = ["{{CONSTITUTION_PATH}}", "{{CONTROL_WORKSPACE}}", "{{DEVICE_ID}}", "{{CREATED_AT}}"];

/** Files whose token literals ARE their content, not placeholders in it. Substituting them
 *  corrupts the mechanism: bin/init/** is the substitution engine (this list lives in it),
 *  and config.template.json is the template init reads and substitutes INTO ~/.aigentry/
 *  config.json — the copy is substituted, the template must stay a template. Exempt from
 *  both the rewrite and the survivor assertion of §5 step 6. */
const isSubstitutionExempt = (rel) =>
  rel.startsWith("bin/init/") || rel === "tooling/instructions/config.template.json";

/** Executable bit must survive the copy (§5 step 3). */
const isExecutable = (p) => p.startsWith("bin/") || p === "git-hooks/pre-push";

/** state/ skeleton (§2.4) — created empty, never shipped. */
const STATE_DIRS = ["dispatch", "hitl/pending", "hitl/decided", "telemetry", "session-comms", "test-reports"];

/** ~/.aigentry runtime dirs init mkdir -p's (§2.5, table row 4).
 *
 *  SPEC DEVIATION, forced and named: §2.5 lists six dirs, the sixth being the dedup sidecar
 *  directory. That sidecar was RETIRED by telepty#60 Stage A / 0.8.0, and
 *  tests/dispatch/T69_registry_single_writer_invariant.sh:43-49 fails the build if any file
 *  under bin/ so much as names it outside bin/dispatch-registry.py's archival op. Creating it
 *  on every fresh install would resurrect a retired path. Five dirs, not six. */
const AIGENTRY_DIRS = ["role-sandbox", "sessions", "telemetry", "warp-surfaces", "git-hooks"];

/** Keys in ~/.aigentry/config.json owned by other ecosystem components (§2.5) — never written. */
const FOREIGN_CONFIG_KEYS = [
  "remoteUrl",
  "remoteConsent",
  "remoteConsentAt",
  "authMethod",
  "provider",
  "repoName",
  "deviceId",
  "lastSyncAt",
];

export {
  MANIFEST,
  SCAFFOLD_PREFIX,
  GOVERNANCE_ROOTS,
  TARBALL_EXEMPT,
  TEMPLATE_TOKENS,
  isSubstitutionExempt,
  isExecutable,
  STATE_DIRS,
  AIGENTRY_DIRS,
  FOREIGN_CONFIG_KEYS,
};
