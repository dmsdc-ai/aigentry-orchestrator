import type { Resolution } from "./resolve.js";
import { CATALOG } from "./descriptors.js";
export function awareness(resolved: Resolution) {
  return {
    version: 2, revision: resolved.revision,
    settings: Object.entries(resolved.provenance).map(([id, source]) => ({ id, source })),
    catalog: CATALOG,
    capabilities: { nonsecretSettings: "supported", configMutation: process.platform === "win32" ? "protection-unavailable" : "posix-private-path-required",
      secretDelivery: "S2-pending", readerClosure: "S3-pending", nativeAcceptance: "S4-pending",
      codexExternalChatGPTTokens: "app-server-interface-known; TUI-supplier-eligibility-unverified" },
    readiness: "configuration-only; authentication-unobserved",
  };
}
