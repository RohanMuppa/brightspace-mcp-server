/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Where a download may be written. The destination is chosen through an AI
 * client, and the file and folder names inside it come from a course, so the
 * rule is an allowlist: a folder of the user's own (inside their home folder,
 * with no hidden folder in the way) or a removable or external drive. Anything
 * else (system folders, other users' homes, /opt, /var, /Applications, a
 * credential or startup folder such as ~/.kube or ~/Library/LaunchAgents) is
 * refused, so no list of dangerous places has to be kept complete.
 */

import { realpath } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

export interface DestinationPolicy {
  /** The user's home directory. Defaults to os.homedir(). */
  home?: string;
  /** Extra folders that are allowed, with the same no-hidden-folder rule. For tests. */
  allowRoots?: string[];
}

let configured: DestinationPolicy = {};

/** Set the policy for this process. Only tests call it: production uses the defaults. */
export function configureDestinationPolicy(policy: DestinationPolicy): void {
  configured = policy;
}

// The native variant expands Windows 8.3 short names; fs/promises has none.
const realpathNative = promisify(realpath.native);

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const fold = (p: string): string => (caseInsensitive ? p.toLowerCase() : p);

/** \\?\ and \\.\ paths skip Windows' own name handling, so they are not accepted. */
const DEVICE_PREFIX = /^[\\/]{2}[?.][\\/]/;

/** The native real path of `target` (8.3 names expanded on Windows), or of its nearest existing ancestor with the missing tail put back. */
async function resolveReal(target: string): Promise<string> {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await realpathNative(current), ...tail.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      // Any failure but "not there yet" is not guessed past: the caller gets the error and refuses.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** The components of `child` below `parent`, or null when it is not inside it. */
function below(child: string, parent: string): string[] | null {
  const rel = path.relative(fold(parent), fold(child));
  if (rel === "") return [];
  if (rel.split(path.sep)[0] === ".." || path.isAbsolute(rel)) return null;
  // Original case, so a message or later check sees the real names.
  return path.relative(parent, child).split(path.sep);
}

const hidden = (components: string[]): boolean => components.some((c) => c.startsWith("."));

const WINDOWS_SYSTEM_FOLDERS = new Set(["windows", "program files", "program files (x86)", "programdata", "system volume information", "$recycle.bin"]);

/**
 * Why `dir` may not be a download destination, or null when it may: it must
 * be inside the user's home folder (not the folder itself, no hidden folder in
 * the path, not ~/Library or AppData) or on a removable or external drive
 * (/Volumes/<name> on macOS, /media and /mnt on Linux, another drive letter on
 * Windows, never its Windows, Program Files or ProgramData). Symbolic links
 * and Windows short names are resolved first.
 */
export async function sensitiveDestination(dir: string, options: DestinationPolicy = {}): Promise<string | null> {
  if (DEVICE_PREFIX.test(dir)) return "it is a Windows device path";
  const real = await resolveReal(dir);
  if (DEVICE_PREFIX.test(real)) return "it is a Windows device path";
  if (path.parse(real).root === real) return "it is the root of a drive";

  const policy = { ...configured, ...options };
  const realHome = await resolveReal(policy.home ?? os.homedir());

  const inHome = below(real, realHome);
  if (inHome) {
    if (inHome.length === 0) return "it is your home directory itself";
    if (hidden(inHome)) return "it is, or is inside, a hidden folder, where settings and credentials live";
    if (process.platform === "darwin" && fold(inHome[0]) === "library") return "it is inside ~/Library, where applications keep their data";
    if (process.platform === "win32") {
      if (fold(inHome[0]) === "appdata") return "it is inside AppData, where applications keep their data";
      for (const variable of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
        if (variable && below(real, await resolveReal(variable))) return "it is inside AppData, where applications keep their data";
      }
    }
    return null;
  }

  for (const allowed of policy.allowRoots ?? []) {
    const inside = below(real, await resolveReal(allowed));
    if (inside && !hidden(inside)) return null;
  }

  if (process.platform === "darwin") {
    const volume = below(real, "/Volumes");
    // /Volumes/Macintosh HD is a link to "/", which the real path has already left.
    if (volume && volume.length >= 1 && !hidden(volume)) return null;
  } else if (process.platform === "win32") {
    const drive = path.parse(real).root;
    const system = `${process.env.SystemDrive ?? "C:"}\\`;
    const rest = below(real, drive) ?? [];
    if (fold(drive) !== fold(system) && rest.length >= 1 && !hidden(rest) && !WINDOWS_SYSTEM_FOLDERS.has(rest[0].toLowerCase())) return null;
  } else {
    for (const mount of ["/media", "/mnt"]) {
      const volume = below(real, mount);
      if (volume && volume.length >= 1 && !hidden(volume)) return null;
    }
  }
  return "it is not inside your home folder or on an external drive";
}

/** The refusal shown for a protected destination. */
export function sensitiveDestinationMessage(dir: string, reason: string): string {
  return `Cannot save into ${dir}: ${reason}. Choose a folder of your own, such as ~/Documents/Brightspace.`;
}
