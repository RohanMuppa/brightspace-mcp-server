import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import trash from "trash";
import { log } from "../utils/logger.js";

/** Retire only the known v1 profile after both encrypted state and token persistence succeed. */
export async function retireLegacyProfile(sessionDir: string): Promise<void> {
  const profile = path.join(sessionDir, "browser-data");
  try {
    const stat = await fs.lstat(profile);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    await fs.access(path.join(sessionDir, "storage-state.encrypted.json"));
    try {
      const owner = await fs.readlink(path.join(profile, "SingletonLock"));
      const match = /^(.*)-(\d+)$/.exec(owner);
      if (!match || match[1] !== os.hostname()) return;
      try {
        process.kill(Number(match[2]), 0);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    await trash([profile], { glob: false });
    log("INFO", "Moved the retired v1 browser-data profile to Trash. It can be restored there.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log("WARN", "Could not retire the inactive v1 browser profile. It was preserved.");
    }
  }
}
