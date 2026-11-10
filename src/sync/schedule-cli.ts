/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * `schedule` — run `sync --notify` for one course every day at a set time,
 * through a per-user launchd agent (macOS only; #424). Nothing here needs
 * administrator rights: the agent lives in ~/Library/LaunchAgents.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { sensitiveDestination, sensitiveDestinationMessage } from "../utils/sensitive-paths.js";
import { cleanLine } from "./sync-cli.js";

export const SCHEDULE_USAGE = `Usage: brightspace-mcp-server schedule --course <id> --dest <dir> --at HH:MM [--existing <mode>]
       brightspace-mcp-server schedule --list
       brightspace-mcp-server schedule --remove --course <id>

Run "sync --notify" for a course every day at a set time, as a per-user
launchd agent (macOS only). A notification shows when files arrive or the
sign-in has expired.

Options:
  --course <id>        Course (org unit) id. Required to add or remove.
  --dest <dir>         Directory to save into, under the same rules as sync. Required to add.
  --at HH:MM           Time of day, 24-hour, local time. Required to add.
  --existing <mode>    skip (default), replace or keep_both, as for sync
  --list               Show the schedules this tool created
  --remove             Stop and delete the schedule for --course
  --help               Show this help

Adding a schedule for a course that already has one replaces it.
Exit status: 0 done, 1 failed, 2 usage error or not supported on this system.
`;

export const LABEL_PREFIX = "com.brightspace-mcp-server.sync.";

export interface LaunchctlResult { code: number; stderr: string }

export interface ScheduleFs {
  mkdir: (dir: string, options: { recursive: true; mode?: number }) => Promise<unknown>;
  readdir: (dir: string) => Promise<string[]>;
  readFile: (file: string) => Promise<string>;
  writeFileAtomic: (file: string, data: string, options: { mode: number }) => Promise<void>;
  rm: (file: string) => Promise<void>;
  exists: (file: string) => Promise<boolean>;
}

export interface ScheduleDeps {
  platform: NodeJS.Platform;
  uid: number;
  /** ~/Library/LaunchAgents */
  agentsDir: string;
  /** Where the agent's stdout/stderr log goes. */
  logDir: string;
  nodePath: string;
  scriptPath: string;
  launchctl: (args: string[]) => Promise<LaunchctlResult>;
  fs: ScheduleFs;
  /** The destination rule `sync` uses: a reason when refused, else null. */
  checkDestination: (dir: string) => Promise<string | null>;
}

export interface ScheduleIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export type ParsedScheduleArgs =
  | { help: true }
  | { error: string }
  | { action: "list" }
  | { action: "remove"; courseId: number }
  | { action: "add"; courseId: number; destination: string; hour: number; minute: number; existing: string };

const FLAGS_WITH_VALUE = new Set(["--course", "--dest", "--at", "--existing"]);
const FLAGS_ALONE = new Set(["--list", "--remove", "--help"]);

const wholeNumber = (value: string | undefined): number | null =>
  value !== undefined && /^\d+$/.test(value) && Number(value) > 0 && Number.isSafeInteger(Number(value)) ? Number(value) : null;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function parseScheduleArgs(argv: string[]): ParsedScheduleArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].startsWith("--") ? argv[i].indexOf("=") : -1;
    const flag = eq >= 0 ? argv[i].slice(0, eq) : argv[i];
    const inline = eq >= 0 ? argv[i].slice(eq + 1) : undefined;
    if (FLAGS_ALONE.has(flag) && inline === undefined) {
      flags.add(flag);
    } else if (FLAGS_WITH_VALUE.has(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) return { error: `${flag} needs a value.` };
      values.set(flag, value);
    } else {
      return { error: flag.startsWith("--") ? `Unknown option: ${flag}` : `Unexpected argument: ${flag}` };
    }
  }
  if (flags.has("--help")) return { help: true };
  if (flags.has("--list") && flags.has("--remove")) return { error: "Use --list or --remove, not both." };

  if (flags.has("--list")) {
    return values.size > 0 ? { error: "--list takes no other options." } : { action: "list" };
  }
  const courseId = wholeNumber(values.get("--course"));
  if (courseId === null) return { error: "--course must be a course id (a positive whole number)." };
  if (flags.has("--remove")) {
    return values.size > 1 ? { error: "--remove takes only --course." } : { action: "remove", courseId };
  }
  const dest = values.get("--dest");
  if (dest === undefined || dest.trim() === "") return { error: "--dest is required: the directory to save the course into." };
  if (CONTROL.test(dest)) return { error: "--dest must not contain control characters." };
  const at = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(values.get("--at") ?? "");
  if (!at) return { error: "--at must be a time of day as HH:MM, 24-hour (for example 08:00)." };
  const existing = values.get("--existing") ?? "skip";
  if (existing !== "skip" && existing !== "replace" && existing !== "keep_both") {
    return { error: "--existing must be skip, replace or keep_both." };
  }
  return { action: "add", courseId, destination: path.resolve(dest), hour: Number(at[1]), minute: Number(at[2]), existing };
}

/** Escape a value for an XML text node or attribute. */
export function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const xmlUnescape = (text: string): string =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export const labelFor = (courseId: number): string => `${LABEL_PREFIX}${courseId}`;

export interface PlistInput {
  courseId: number;
  destination: string;
  existing: string;
  hour: number;
  minute: number;
  nodePath: string;
  scriptPath: string;
  logFile: string;
}

export function buildPlist(input: PlistInput): string {
  const args = [input.nodePath, input.scriptPath, "sync", "--course", String(input.courseId), "--dest", input.destination, "--existing", input.existing, "--notify"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(labelFor(input.courseId))}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${input.hour}</integer>
    <key>Minute</key>
    <integer>${input.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.logFile)}</string>
</dict>
</plist>
`;
}

export interface ListedSchedule { courseId: number; time: string; destination: string }

/** Read back one of our plists; null when it is not shaped like one. */
export function parsePlist(text: string, courseId: number): ListedSchedule | null {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  const hour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)?.[1];
  const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)?.[1];
  if (array === undefined || hour === undefined || minute === undefined) return null;
  const args = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => xmlUnescape(m[1]));
  const dest = args[args.indexOf("--dest") + 1];
  if (args.indexOf("--dest") < 0 || dest === undefined) return null;
  return { courseId, time: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`, destination: dest };
}

const OUR_PLIST = new RegExp(`^${LABEL_PREFIX.replace(/\./g, "\\.")}([1-9]\\d*)\\.plist$`);

/** Run `schedule` and return the process exit code. */
export async function runSchedule(argv: string[], io: ScheduleIO, deps: ScheduleDeps): Promise<number> {
  const args = parseScheduleArgs(argv);
  if ("help" in args) {
    io.stdout(SCHEDULE_USAGE);
    return 0;
  }
  if ("error" in args) {
    io.stderr(`${args.error}\n\n${SCHEDULE_USAGE}`);
    return 2;
  }
  if (deps.platform !== "darwin") {
    io.stderr("schedule is not supported yet on this system: it uses macOS launchd. Run sync from your own scheduler (cron, systemd timer or Task Scheduler) with --notify if you like.\n");
    return 2;
  }

  const domain = `gui/${deps.uid}`;
  const plistFor = (courseId: number): string => path.join(deps.agentsDir, `${labelFor(courseId)}.plist`);
  /** Stop a loaded agent: bootout, then the old `unload` when bootout is not available. */
  const unload = async (courseId: number): Promise<void> => {
    const result = await deps.launchctl(["bootout", `${domain}/${labelFor(courseId)}`]).catch(() => ({ code: 1, stderr: "" }));
    if (result.code !== 0) await deps.launchctl(["unload", plistFor(courseId)]).catch(() => undefined);
  };

  try {
    if (args.action === "list") {
      const names = (await deps.fs.readdir(deps.agentsDir).catch(() => [] as string[])).sort();
      const rows: ListedSchedule[] = [];
      for (const name of names) {
        const match = OUR_PLIST.exec(name);
        if (!match) continue;
        const courseId = Number(match[1]);
        const parsed = parsePlist(await deps.fs.readFile(path.join(deps.agentsDir, name)).catch(() => ""), courseId);
        rows.push(parsed ?? { courseId, time: "?", destination: "(unreadable)" });
      }
      if (rows.length === 0) io.stdout("No scheduled syncs.\n");
      for (const row of rows) io.stdout(`${cleanLine(`course ${row.courseId}  daily at ${row.time}  ${row.destination}`)}\n`);
      return 0;
    }

    if (args.action === "remove") {
      const file = plistFor(args.courseId);
      if (!(await deps.fs.exists(file))) {
        io.stderr(`No schedule for course ${args.courseId}.\n`);
        return 1;
      }
      await unload(args.courseId);
      await deps.fs.rm(file);
      io.stdout(`Removed the schedule for course ${args.courseId}.\n`);
      return 0;
    }

    // Checked before anything is written: a refused destination leaves nothing behind.
    const refused = await deps.checkDestination(args.destination);
    if (refused) {
      io.stderr(`${cleanLine(sensitiveDestinationMessage(args.destination, refused))}\n`);
      return 2;
    }
    const logFile = path.join(deps.logDir, `sync-${args.courseId}.log`);
    const file = plistFor(args.courseId);
    await deps.fs.mkdir(deps.agentsDir, { recursive: true });
    await deps.fs.mkdir(deps.logDir, { recursive: true, mode: 0o700 });
    if (await deps.fs.exists(file)) await unload(args.courseId);
    await deps.fs.writeFileAtomic(file, buildPlist({
      courseId: args.courseId, destination: args.destination, existing: args.existing,
      hour: args.hour, minute: args.minute, nodePath: deps.nodePath, scriptPath: deps.scriptPath, logFile,
    }), { mode: 0o644 });
    let loaded = await deps.launchctl(["bootstrap", domain, file]);
    if (loaded.code !== 0) loaded = await deps.launchctl(["load", file]);
    if (loaded.code !== 0) {
      io.stderr(`${cleanLine(`The schedule was written to ${file} but launchctl could not load it: ${loaded.stderr || `exit ${loaded.code}`}`)}\n`);
      return 1;
    }
    if (deps.scriptPath.includes(`${path.sep}_npx${path.sep}`)) {
      io.stderr("Warning: this copy runs from the npx cache, which can be cleaned. Install it globally (npm install -g brightspace-mcp-server) and run schedule again for a lasting schedule.\n");
    }
    io.stdout(`Scheduled course ${args.courseId} daily at ${String(args.hour).padStart(2, "0")}:${String(args.minute).padStart(2, "0")} into ${args.destination}. Log: ${logFile}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${cleanLine(`Could not change the schedule: ${error instanceof Error ? error.message : "unexpected error"}`)}\n`);
    return 1;
  }
}

const realFs: ScheduleFs = {
  mkdir: (dir, options) => fs.mkdir(dir, options),
  readdir: (dir) => fs.readdir(dir),
  readFile: (file) => fs.readFile(file, "utf8"),
  writeFileAtomic: (file, data, options) => writeFileAtomic(file, data, options),
  rm: (file) => fs.rm(file, { force: true }),
  exists: (file) => fs.access(file).then(() => true, () => false),
};

const runLaunchctl = (args: string[]): Promise<LaunchctlResult> =>
  new Promise((resolve) => {
    execFile("/bin/launchctl", args, { timeout: 15000, windowsHide: true }, (error, _stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? (error as unknown as { code: number }).code : 1) : 0;
      resolve({ code, stderr: String(stderr ?? "").trim() });
    });
  });

/** Entry point for `brightspace-mcp-server schedule`. */
export async function main(): Promise<void> {
  const { resolveSessionLocation } = await import("../utils/config.js");
  const entry = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => path.resolve(process.argv[1])) : "";
  process.exitCode = await runSchedule(process.argv.slice(3), {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
  }, {
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    agentsDir: path.join(os.homedir(), "Library", "LaunchAgents"),
    logDir: path.join(resolveSessionLocation().sessionRoot, "logs"),
    nodePath: process.execPath,
    scriptPath: entry,
    launchctl: runLaunchctl,
    fs: realFs,
    checkDestination: (dir) => sensitiveDestination(dir),
  });
}
