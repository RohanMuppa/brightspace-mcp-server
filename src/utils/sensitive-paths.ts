/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Places a download must never be written into. The destination is chosen
 * through an AI client, and the file and folder names inside it come from a
 * course, so a destination that is the home directory or a credential or
 * system folder would let a course plant files where they do real harm.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const fold = (p: string): string => (caseInsensitive ? p.toLowerCase() : p);

/** The real path of `target`, or of its nearest existing ancestor with the missing tail put back. */
async function resolveReal(target: string): Promise<string> {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(fold(parent), fold(child));
  return rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel));
};

/**
 * Why `dir` may not be a download destination, or null when it may: the
 * filesystem root, the home directory itself, or anything inside a credential
 * or system folder (~/.ssh, ~/.gnupg, ~/.aws, ~/.config, ~/Library, /etc,
 * /usr, /bin, /System, C:\Windows, C:\Program Files). Symbolic links are
 * resolved first.
 */
export async function sensitiveDestination(dir: string, home: string = os.homedir()): Promise<string | null> {
  const real = await resolveReal(dir);
  const realHome = await resolveReal(home);

  if (path.parse(real).root === real) return "it is the root of the filesystem";
  if (fold(real) === fold(realHome)) return "it is your home directory itself";

  const inside: Array<[string, string]> = [
    [path.join(realHome, ".ssh"), "it holds SSH keys"],
    [path.join(realHome, ".gnupg"), "it holds GPG keys"],
    [path.join(realHome, ".aws"), "it holds cloud credentials"],
    [path.join(realHome, ".config"), "it holds application settings"],
    [path.join(realHome, "Library"), "it holds application data"],
  ];
  if (process.platform === "win32") {
    const windows = process.env.SystemRoot ?? "C:\\Windows";
    for (const system of [windows, "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)"]) inside.push([system, "it is a system folder"]);
  } else {
    for (const system of ["/etc", "/usr", "/bin", "/sbin", "/System"]) inside.push([system, "it is a system folder"]);
  }
  for (const [protectedDir, reason] of inside) {
    // A folder like /etc is a link on macOS, so its real location is checked too.
    for (const candidate of new Set([protectedDir, await resolveReal(protectedDir)])) {
      if (isInside(real, candidate)) return reason;
    }
  }
  return null;
}

/** The refusal shown for a protected destination. */
export function sensitiveDestinationMessage(dir: string, reason: string): string {
  return `Cannot save into ${dir}: ${reason}. Choose a folder of your own, such as a new folder in Documents.`;
}
