#!/usr/bin/env node
// CLI shim so bash sites (inject-handler.sh, dispatch.sh) can emit
// telemetry without inlining `node -e` heredocs. Wraps the built
// `dist/src/telemetry/logger-emit.js` helper so its A1 mapping +
// env-based session/role discovery stays in one place.
//
// Usage:
//   emit-telemetry.mjs --helper lifecycle  --subtype cleanup  --payload-json '{"target":"sid-X"}' [--correlation-id ID]
//   emit-telemetry.mjs --helper dispatch   --subtype dispatch_start --payload-json '{...}'
//   emit-telemetry.mjs --helper report     --subtype report   --payload-json '{...}'
//   emit-telemetry.mjs --kind state-change --payload-json '{...}'      # raw mode
//
// Failure mode: non-zero exit only on argv errors. Telemetry transport
// errors are swallowed by the helper (console.error). The bash caller
// SHOULD NOT condition primary logic on this script's exit code.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const helperUrl = new URL(
  "../dist/src/telemetry/logger-emit.js",
  import.meta.url,
);

let helper;
try {
  helper = await import(helperUrl.href);
} catch (err) {
  // Build artefact missing — degrade quietly so dispatch.sh / inject-handler.sh
  // still work in a clean checkout pre-build.
  console.error(
    `[emit-telemetry] dist/src/telemetry/logger-emit.js not found under ${repoRoot}; skipping emit. (${err.message})`,
  );
  process.exit(0);
}

let payload;
try {
  payload = args["payload-json"] ? JSON.parse(args["payload-json"]) : {};
} catch (err) {
  console.error(`[emit-telemetry] --payload-json is not valid JSON: ${err.message}`);
  process.exit(2);
}

const correlationId = typeof args["correlation-id"] === "string" ? args["correlation-id"] : undefined;
const subtype = typeof args.subtype === "string" ? args.subtype : undefined;
const helperKind = typeof args.helper === "string" ? args.helper : undefined;
const kind = typeof args.kind === "string" ? args.kind : undefined;

if (helperKind === "lifecycle") {
  if (!subtype) { console.error("[emit-telemetry] --subtype required for --helper lifecycle"); process.exit(2); }
  helper.emitLifecycleEvent(subtype, payload, correlationId);
} else if (helperKind === "dispatch") {
  if (!subtype) { console.error("[emit-telemetry] --subtype required for --helper dispatch"); process.exit(2); }
  helper.emitDispatchEvent(subtype, payload, correlationId);
} else if (helperKind === "report") {
  if (!subtype) { console.error("[emit-telemetry] --subtype required for --helper report"); process.exit(2); }
  helper.emitReportEvent(subtype, payload, correlationId);
} else if (kind) {
  helper.emitTelemetry({ kind, payload, ...(correlationId ? { correlation_id: correlationId } : {}) });
} else {
  console.error("[emit-telemetry] one of --helper {lifecycle|dispatch|report} or --kind is required");
  process.exit(2);
}
