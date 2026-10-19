import * as fs from "node:fs";
import * as path from "node:path";

const MAX_RECEIPT = 4096;

/** The manifest binds the filename; this descriptor binds both publications to one inode. */
export function openWorkerReceipt(receipt: string, manifest: string): { publish(value: object): void; close(): void } {
  const parent = path.dirname(manifest);
  if (path.basename(manifest) !== "manifest.json" || receipt !== path.join(parent, "receipt.json") ||
      fs.realpathSync(parent) !== parent) throw new Error("SANDBOX_RECEIPT_UNSAFE");
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.uid !== process.geteuid?.() || (parentStat.mode & 0o077) !== 0) {
    throw new Error("SANDBOX_RECEIPT_UNSAFE");
  }
  const flags = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  let fd: number;
  try {
    fd = fs.openSync(receipt, flags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    fd = fs.openSync(receipt, flags);
  }
  const same = (a: fs.Stats, b: fs.Stats): boolean => a.dev === b.dev && a.ino === b.ino;
  const check = (): void => {
    // lstat never follows a replaced final component. The fd never reopens it.
    const dir = fs.lstatSync(parent), file = fs.lstatSync(receipt), held = fs.fstatSync(fd);
    if (!same(dir, parentStat) || !dir.isDirectory() || dir.uid !== process.geteuid?.() ||
        (dir.mode & 0o077) !== 0 || !same(file, held) || !held.isFile() || held.nlink !== 1 ||
        held.uid !== process.geteuid?.() || (held.mode & 0o777) !== 0o600 || held.size > MAX_RECEIPT) {
      throw new Error("SANDBOX_RECEIPT_UNSAFE");
    }
  };
  try { check(); } catch (e) { fs.closeSync(fd); throw e; }
  return {
    publish(value: object): void {
      check();
      const data = Buffer.from(JSON.stringify(value));
      if (data.length > MAX_RECEIPT) throw new Error("SANDBOX_RECEIPT_TOO_LARGE");
      fs.ftruncateSync(fd, 0);
      for (let offset = 0; offset < data.length;) {
        const n = fs.writeSync(fd, data, offset, data.length - offset, offset);
        if (n <= 0) throw new Error("SANDBOX_RECEIPT_WRITE_FAILED");
        offset += n;
      }
      fs.fsyncSync(fd);
      check();
    },
    close(): void { fs.closeSync(fd); },
  };
}

// Path checks detect ordinary replacement, and held-fd writes cannot follow a new final symlink.
// Node has no openat here: a same-user actor that can rename the parent between checks remains a race.
