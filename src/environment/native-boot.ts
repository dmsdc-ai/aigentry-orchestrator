import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

/** A trusted platform boundary. Fakes can supply proofs without reading a host boot ID. */
export interface MaintenanceProofAdapter {
  bootIdentity(): string | null;
  offlineQuiescence(home: string): boolean;
}

const bootId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const nativeMaintenanceProof: MaintenanceProofAdapter = {
  bootIdentity(): string | null {
    if (process.platform === "linux") {
      try {
        const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        return bootId.test(value) ? value.toLowerCase() : null;
      } catch { return null; }
    }
    if (process.platform === "darwin") {
      const result = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        encoding: "utf8", timeout: 1000, maxBuffer: 128,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      });
      const value = result.status === 0 ? result.stdout.trim() : "";
      return bootId.test(value) ? value.toLowerCase() : null;
    }
    return null;
  },
  // S4 must admit a real controller-owned offline procedure for the platform.
  // An empty lock and same-boot lock cannot be cleared from a PID or age guess.
  offlineQuiescence(_home: string): boolean { return false; },
};
