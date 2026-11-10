/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Where a download may be written. The destination is chosen through an AI
 * client, and the file and folder names inside it come from a course, so a
 * destination that is the home folder, a hidden folder (where settings and
 * credentials live), an application-data folder or a system folder would let
 * a course plant files where they do real harm. Everything else is allowed:
 * the user's folders, cloud-sync folders, temp folders, /srv, /data,
 * /workspace, /opt, external drives.
 *
 * The rule is judged on the native real path, so a symbolic link into a
 * refused place is refused. The person who runs the server can allow more
 * with D2L_DOWNLOAD_ROOTS (see downloadRootsFromEnv); a tool argument cannot.
 */

import { lstat, readlink, realpath } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { log } from "./logger.js";

export interface DestinationPolicy {
  /** The user's home directory. Defaults to os.homedir(). */
  home?: string;
  /** Extra allowed roots, with the same standing as D2L_DOWNLOAD_ROOTS. For tests. */
  allowRoots?: string[];
}

let configured: DestinationPolicy = {};

/** Set the policy for this process. Only tests call it: production uses the defaults. */
export function configureDestinationPolicy(policy: DestinationPolicy): void {
  configured = policy;
}

// The native variant expands Windows 8.3 short names; fs/promises has none.
const realpathNative = promisify(realpath.native);
const lstatAsync = promisify(lstat);
const readlinkAsync = promisify(readlink);

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const fold = (p: string): string => (caseInsensitive ? p.toLowerCase() : p);

/** \\?\ and \\.\ paths skip Windows' own name handling, so they are not accepted. */
const DEVICE_PREFIX = /^[\\/]{2}[?.][\\/]/;

class LinkLoopError extends Error {}

const MAX_LINK_DEPTH = 40;

/**
 * The native real path of `target` (8.3 names expanded on Windows). A part
 * that does not exist yet is kept as written, but a dangling symbolic link is
 * followed to where it points, so what is judged is where a write would land.
 */
async function resolveReal(target: string, depth = 0): Promise<string> {
  if (depth > MAX_LINK_DEPTH) throw new LinkLoopError();
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await realpathNative(current), ...[...tail].reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP") throw new LinkLoopError();
      // "Not there yet" and "a folder above it that this user may not look into" (/root for a normal user)
      // are judged by the nearest part that can be resolved, plus the rest of the path as written.
      // Anything else is not guessed past: the caller gets the error and refuses.
      if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM" && code !== "ENOTDIR") throw error;
    }
    const link = await lstatAsync(current).then((stat) => (stat.isSymbolicLink() ? stat : null), () => null);
    if (link) {
      const pointsAt = path.resolve(path.dirname(current), await readlinkAsync(current));
      return path.join(await resolveReal(pointsAt, depth + 1), ...[...tail].reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    tail.push(path.basename(current));
    current = parent;
  }
}

/** The components of `child` below `parent`, or null when it is not inside it. */
function below(child: string, parent: string): string[] | null {
  const rel = path.relative(fold(parent), fold(child));
  if (rel === "") return [];
  if (rel.split(path.sep)[0] === ".." || path.isAbsolute(rel)) return null;
  // Original case, so a later check sees the real names.
  return path.relative(parent, child).split(path.sep);
}

const components = (p: string): string[] => path.relative(path.parse(p).root, p).split(path.sep).filter(Boolean);
const lower = (s: string): string => s.toLowerCase();

const WINDOWS_SYSTEM_FOLDERS = new Set(["windows", "program files", "program files (x86)", "programdata", "system volume information", "$recycle.bin"]);
const POSIX_SYSTEM_FOLDERS = ["/etc", "/usr", "/bin", "/sbin", "/System", "/Library", "/Applications", "/boot", "/dev", "/proc", "/sys", "/private/etc"];
/** Temporary folders under /var (macOS keeps its per-user temp there), the only part of it that is allowed. */
const VAR_TEMP_FOLDERS = ["/var/folders", "/var/tmp", "/private/var/folders", "/private/var/tmp"];

const REFUSED_DEVICE = "it is a Windows device path (\\\\?\\ or \\\\.\\)";
const REFUSED_ROOT = "it is the root of a drive";
const REFUSED_HOME = "it is your home directory itself";

/**
 * True when any AppData folder in the path is not just the way to its own
 * Local\Temp. AppData holds applications' data and the Startup folder; only
 * Temp is allowed, and an AppData that appears again below a Temp folder (a
 * fake home kept in Temp) is judged on its own.
 */
function appDataOutsideTemp(names: string[]): boolean {
  return names.some((name, i) => name === "appdata" && !(names[i + 1] === "local" && names[i + 2] === "temp"));
}

/** Why a real path is refused by the built-in rules, or null. `home` is a real path. */
async function refusedByRules(real: string, home: string): Promise<string | null> {
  const parts = components(real);
  const hiddenPart = parts.find((part) => part.startsWith("."));
  if (hiddenPart !== undefined) return `its path goes through the hidden folder "${hiddenPart}", where settings and credentials live`;

  const inHome = below(real, home);
  if (process.platform === "darwin" && inHome && inHome.length > 0 && lower(inHome[0]) === "library") {
    const allowed = (inHome.length >= 2 && lower(inHome[1]) === "cloudstorage") || (inHome.length >= 2 && lower(inHome[1]) === "mobile documents");
    if (!allowed) return "it is inside ~/Library, where applications keep their data (only ~/Library/CloudStorage and ~/Library/Mobile Documents are allowed)";
  }

  for (const system of POSIX_SYSTEM_FOLDERS) {
    if (below(real, system) || below(real, await resolveReal(system))) return `it is inside ${system}, a system folder`;
  }
  const first = parts[0] ?? "";
  if (path.sep === "/" && /^lib(32|64|x32)?$/.test(first)) return `it is inside /${first}, a system folder`;
  if (path.sep === "/" && (below(real, "/var") || below(real, "/private/var"))) {
    if (!VAR_TEMP_FOLDERS.some((temp) => below(real, temp) || below(real, `/private${temp}`))) return "it is inside /var, a system folder (only its temporary folders are allowed)";
  }
  if (path.sep === "/" && below(real, "/root") && !(below(home, "/root"))) return "it is inside /root, the administrator's home";

  if (process.platform === "win32") {
    const names = parts.map(lower);
    if (WINDOWS_SYSTEM_FOLDERS.has(names[0] ?? "")) return `it is inside ${parts[0]}, a Windows system folder`;
    if (appDataOutsideTemp(names)) return "it is inside AppData, where applications keep their data and the Startup folder";
  } else {
    // Windows drives seen from WSL: /mnt/c/Windows, /mnt/c/Users/<name>/AppData.
    const wsl = /^\/mnt\/[a-z]\/(.+)$/i.exec(real.split(path.sep).join("/"));
    if (wsl) {
      const names = wsl[1].split("/").map(lower);
      if (WINDOWS_SYSTEM_FOLDERS.has(names[0])) return `it is inside a Windows system folder (${wsl[1].split("/")[0]})`;
      if (appDataOutsideTemp(names)) return "it is inside a Windows AppData folder";
    }
  }
  return null;
}

/**
 * Why `dir` may not be a download destination, or null when it may. Refused:
 * device paths, a drive root, the home folder itself, any path that goes
 * through a hidden (dot) folder, ~/Library (except CloudStorage and Mobile
 * Documents), system folders (/etc, /usr, /bin, /sbin, /System, /Library,
 * /Applications, /boot, /dev, /proc, /sys, /lib*, /var apart from its temp
 * folders, /root, and on Windows or under WSL Windows, Program Files,
 * ProgramData and AppData). A destination inside a root listed in
 * D2L_DOWNLOAD_ROOTS is allowed even where those rules would refuse it,
 * but never a device path, a drive root or the home folder itself.
 */
export async function sensitiveDestination(dir: string, options: DestinationPolicy = {}): Promise<string | null> {
  if (DEVICE_PREFIX.test(dir)) return REFUSED_DEVICE;
  const policy = { ...configured, ...options };
  try {
    const real = await resolveReal(dir);
    if (DEVICE_PREFIX.test(real)) return REFUSED_DEVICE;
    if (path.parse(real).root === real) return REFUSED_ROOT;
    const realHome = await resolveReal(policy.home ?? os.homedir());
    if (fold(real) === fold(realHome)) return REFUSED_HOME;

    const operatorRoots = [...(policy.allowRoots ?? []), ...(await downloadRootsFromEnv(undefined, policy.home))];
    for (const root of operatorRoots) {
      if (below(real, await resolveReal(root))) return null;
    }
    return await refusedByRules(real, realHome);
  } catch (error) {
    if (error instanceof LinkLoopError) return "it involves a symbolic-link loop";
    throw error;
  }
}

const warnedRoots = new Set<string>();

/** Let the next check warn again about an ignored entry. For tests. */
export function resetDownloadRootWarnings(): void {
  warnedRoots.clear();
}

/**
 * The extra allowed roots named by D2L_DOWNLOAD_ROOTS, a path.delimiter
 * separated list, each resolved to its real path. It is read from the
 * server's own environment, which a tool argument cannot set. A listed root
 * overrides every rule above, even inside the home folder (a hidden or
 * ~/Library folder the user really wants), except that an entry which is a
 * relative path, a device path, a drive root, the home folder itself or a
 * folder that holds the home folder is ignored with a warning.
 */
export async function downloadRootsFromEnv(value: string | undefined = process.env.D2L_DOWNLOAD_ROOTS, home: string = os.homedir()): Promise<string[]> {
  const roots: string[] = [];
  const realHome = await resolveReal(home);
  for (const entry of (value ?? "").split(path.delimiter).map((e) => e.trim()).filter(Boolean)) {
    let reason: string | null = null;
    let real = entry;
    if (!path.isAbsolute(entry)) reason = "it is not an absolute path";
    else if (DEVICE_PREFIX.test(entry)) reason = "it is a Windows device path";
    else {
      try {
        real = await resolveReal(entry);
      } catch {
        reason = "it could not be resolved";
      }
      if (!reason && path.parse(real).root === real) reason = "it is the root of a drive";
      else if (!reason && fold(real) === fold(realHome)) reason = "it is your home folder itself";
      else if (!reason && below(realHome, real)) reason = "it contains your home folder";
    }
    if (reason) {
      if (!warnedRoots.has(entry)) {
        warnedRoots.add(entry);
        log("WARN", `[config] Ignoring D2L_DOWNLOAD_ROOTS entry ${JSON.stringify(entry)}: ${reason}.`);
      }
      continue;
    }
    roots.push(real);
  }
  return roots;
}

/** The refusal shown for a protected destination: the rule that refused it, and what to do. */
export function sensitiveDestinationMessage(dir: string, reason: string): string {
  return `Cannot save into ${dir}: ${reason}. Choose a folder such as ~/Documents/Brightspace, or have the person who runs the server add the folder to D2L_DOWNLOAD_ROOTS.`;
}
