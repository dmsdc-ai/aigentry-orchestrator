// ADR §4.8.2 — crash recovery.
// On startup, scan ~/.aigentry/sessions/**/*.tmp.* and unlink (incomplete writes).
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface RecoveryReport {
  scanned: number;
  deleted: string[];
  errors: Array<{ path: string; error: string }>;
}

const TMP_PATTERN = /\.tmp\./;

async function walk(dir: string, report: RecoveryReport): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    report.errors.push({ path: dir, error: (err as Error).message });
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, report);
      continue;
    }
    if (!entry.isFile()) continue;
    report.scanned++;
    if (!TMP_PATTERN.test(entry.name)) continue;
    try {
      await fs.unlink(full);
      report.deleted.push(full);
    } catch (err) {
      report.errors.push({ path: full, error: (err as Error).message });
    }
  }
}

export async function sweepIncompleteWrites(
  sessionsRoot: string,
): Promise<RecoveryReport> {
  const report: RecoveryReport = { scanned: 0, deleted: [], errors: [] };
  await walk(sessionsRoot, report);
  return report;
}
