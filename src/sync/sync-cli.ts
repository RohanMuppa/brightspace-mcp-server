/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * `sync` — download every file of a course into folders named after its
 * modules, from a terminal or a scheduler, using the saved sign-in.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { D2LApiClient } from "../api/index.js";
import { SyncInputError, syncCourse, type ExistingMode, type SyncResult } from "./course-sync.js";
import { sensitiveDestination, sensitiveDestinationMessage } from "../utils/sensitive-paths.js";
import { sanitizeError } from "../tools/tool-helpers.js";
import { summarizeSync } from "./summary.js";
import { notify, setApprovalNotificationsSuppressed, type NotifyOptions } from "../utils/notify.js";
import { AuthError } from "../utils/errors.js";

export const SYNC_USAGE = `Usage: brightspace-mcp-server sync --course <id> --dest <dir> [options]

Download every file in a course's Content area into <dir>, in folders named
after the course's modules. Run it again to fetch only what is new.

Options:
  --course <id>        Course (org unit) id. Required.
  --dest <dir>         Directory to save into; created if it does not exist. Required.
  --existing <mode>    skip (default): leave files already there alone
                       replace: download them again over the old copy
                       keep_both: save a differing copy as "name (1).ext"
  --module <id>        Only this module and the modules inside it
  --dry-run            List what would be downloaded; download nothing
  --notify             Show a system notification (macOS) when files were downloaded
                       or the sign-in has expired; quiet when nothing changed
                       (turn off everywhere with D2L_NOTIFY=0)
  --json               Print only the result as JSON on stdout (progress on stderr)
  --max-files <n>      Most files to download in one run (default 300)
  --help               Show this help

Exit status: 0 everything done, 1 something failed or was not attempted
(including a lost sign-in), 2 usage error.
`;

export interface ParsedSyncArgs {
  courseId: number;
  destination: string;
  existing: ExistingMode;
  moduleId?: number;
  dryRun: boolean;
  json: boolean;
  notify: boolean;
  maxFiles?: number;
}

const FLAGS_WITH_VALUE = new Set(["--course", "--dest", "--existing", "--module", "--max-files"]);
const FLAGS_ALONE = new Set(["--dry-run", "--json", "--notify", "--help"]);

const wholeNumber = (value: string | undefined): number | null =>
  value !== undefined && /^\d+$/.test(value) && Number(value) > 0 && Number.isSafeInteger(Number(value)) ? Number(value) : null;

/** Read the arguments after `sync`. An `error` is a usage error. */
export function parseSyncArgs(argv: string[]): ParsedSyncArgs | { help: true } | { error: string } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].startsWith("--") && argv[i].includes("=")
      ? [argv[i].slice(0, argv[i].indexOf("=")), argv[i].slice(argv[i].indexOf("=") + 1)]
      : [argv[i], undefined];
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

  const courseId = wholeNumber(values.get("--course"));
  if (courseId === null) return { error: "--course must be a course id (a whole number)." };
  const dest = values.get("--dest");
  if (dest === undefined || dest.trim() === "") return { error: "--dest is required: the directory to save the course into." };
  const existing = values.get("--existing") ?? "skip";
  if (existing !== "skip" && existing !== "replace" && existing !== "keep_both") {
    return { error: "--existing must be skip, replace or keep_both." };
  }
  let moduleId: number | undefined;
  if (values.has("--module")) {
    const parsed = wholeNumber(values.get("--module"));
    if (parsed === null) return { error: "--module must be a module id (a whole number)." };
    moduleId = parsed;
  }
  let maxFiles: number | undefined;
  if (values.has("--max-files")) {
    const parsed = wholeNumber(values.get("--max-files"));
    if (parsed === null) return { error: "--max-files must be a whole number of at least 1." };
    maxFiles = parsed;
  }
  return {
    courseId,
    destination: path.resolve(dest),
    existing,
    ...(moduleId !== undefined ? { moduleId } : {}),
    dryRun: flags.has("--dry-run"),
    json: flags.has("--json"),
    notify: flags.has("--notify"),
    ...(maxFiles !== undefined ? { maxFiles } : {}),
  };
}

export interface SyncCliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface SyncCliDeps {
  /** The API client on the saved sign-in. */
  createClient: () => Promise<D2LApiClient>;
  /** Aborts the run (Ctrl-C, SIGTERM): it stops cleanly and the exit status is 130. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** Shows a notification for `--notify`; the system one by default. Must not throw. */
  notify?: (options: NotifyOptions) => Promise<unknown>;
  /** Resolves after `ms`; bounds the course-name lookup for a notification. Tests inject one that never resolves or at once. */
  wait?: (ms: number) => Promise<void>;
}

/** One printable line of at most 300 characters: no control or escape characters from whatever text came back. */
export function cleanLine(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}

const exitCodeFor = (result: SyncResult): number =>
  result.failed.length === 0 && result.notAttempted === 0 && !result.authError ? 0 : 1;

const MAX_LABEL = 60;
const NAME_LOOKUP_MS = 5000;

/**
 * A course name is text an instructor controls, so it never leads a notification and is dropped
 * when it reads like an approval or sign-in prompt ("Approve 47 in Microsoft Authenticator").
 */
const LOOKS_LIKE_PROMPT = /approve|authenticator|sign[\s-]*in|log[\s-]*in|password|passcode|verif|\b(mfa|2fa|duo|otp)\b/i;

/** The notification's name for a course: `Course "<name>"`, or `Course <id>` when the name is missing or unsafe. */
export function courseNotificationLabel(name: unknown, courseId: number): string {
  const clean = typeof name === "string" ? cleanLine(name).replace(/"/g, "'") : "";
  if (clean === "" || LOOKS_LIKE_PROMPT.test(clean)) return `Course ${courseId}`;
  const chars = Array.from(clean);
  return `Course "${chars.length > MAX_LABEL ? `${chars.slice(0, MAX_LABEL - 1).join("")}\u2026` : clean}"`;
}

/** Files really downloaded: the sync's own feedback.md writes are counted in `downloaded` but are not course files. */
export function newFileCount(result: SyncResult): number {
  const feedback = (result.assignments?.feedbackWritten ?? 0) + (result.assignments?.feedbackRefreshed ?? 0);
  return Math.max(0, result.downloaded.length - feedback);
}

/** True when the run left anything unchecked: "could not read it" is never "nothing new" (AGENTS.md). */
export function leftUnchecked(result: SyncResult): boolean {
  return (
    result.failed.length > 0 || result.notAttempted > 0 || result.stopped !== undefined || result.tocTruncated === true ||
    Boolean(result.assignments?.listUnreadable) || Boolean(result.announcements?.listUnreadable) ||
    (result.assignments?.unknown.length ?? 0) > 0 || (result.announcements?.unknown.length ?? 0) > 0
  );
}

/** The notification text for a finished run, or null when there is nothing to say. */
export function syncNotificationMessage(result: SyncResult, label: string): string | null {
  const count = newFileCount(result);
  const unchecked = leftUnchecked(result);
  if (count > 0) return `${label}: ${count} new ${count === 1 ? "file" : "files"}${unchecked ? "; some could not be checked" : ""}`;
  return unchecked ? `${label}: could not check everything for new files` : null;
}

/** The course's label for a notification. The lookup can stall on a re-sign-in, so it waits at most NAME_LOOKUP_MS, then uses the id. */
async function courseLabel(client: D2LApiClient, courseId: number, wait: (ms: number) => Promise<void>): Promise<string> {
  const fallback = `Course ${courseId}`;
  const lookup = (async () => {
    try {
      const course = await client.get<{ Name?: unknown }>(client.lp(`/courses/${courseId}`));
      return courseNotificationLabel(course?.Name, courseId);
    } catch {
      return fallback;
    }
  })();
  return Promise.race([lookup, wait(NAME_LOOKUP_MS).then(() => fallback)]);
}

/** Run `sync` and return the process exit code. */
export async function runSync(argv: string[], io: SyncCliIO, deps: SyncCliDeps): Promise<number> {
  const args = parseSyncArgs(argv);
  if ("help" in args) {
    io.stdout(SYNC_USAGE);
    return 0;
  }
  if ("error" in args) {
    // Under --json stdout carries the error as JSON as well, so a script parses one thing.
    if (argv.includes("--json")) io.stdout(`${JSON.stringify({ error: cleanLine(args.error) })}\n`);
    io.stderr(`${args.error}\n\n${SYNC_USAGE}`);
    return 2;
  }

  const report = (message: string, code: number): number => {
    if (args.json) io.stdout(`${JSON.stringify({ error: message })}\n`);
    io.stderr(`${message}\n`);
    return code;
  };

  const tell = args.notify ? (deps.notify ?? ((options: NotifyOptions) => notify(options))) : undefined;
  const signInNeeded = async (): Promise<void> => {
    await tell?.({ title: "Brightspace", message: "Brightspace sign-in needed" }).catch(() => {});
  };

  // sync does not wait for a sign-in: it reports "sign-in needed" and stops, so an
  // "Approve NN" notification for the attempt it abandons would only mislead.
  const quietApprovals = args.notify;
  if (quietApprovals) setApprovalNotificationsSuppressed(true);
  try {
    // Checked before anything is created: a refused destination must leave no folder behind.
    const protectedReason = await sensitiveDestination(args.destination);
    if (protectedReason) return report(cleanLine(sensitiveDestinationMessage(args.destination, protectedReason)), 2);
    // An existing file is not a destination: say so rather than failing inside mkdir.
    const existing = await fs.stat(args.destination).catch(() => null);
    if (existing && !existing.isDirectory()) return report(cleanLine(`Destination is not a directory: ${args.destination}`), 2);
    // A real run may create the destination; a dry run creates nothing.
    if (!args.dryRun) await fs.mkdir(args.destination, { recursive: true });
    const client = await deps.createClient();
    const result = await syncCourse(client, {
      courseId: args.courseId,
      destination: args.destination,
      existing: args.existing,
      moduleId: args.moduleId,
      dryRun: args.dryRun,
      maxFiles: args.maxFiles,
      sleep: deps.sleep,
      signal: deps.signal,
      onProgress: (event) => {
        const detail = event.type === "failed" ? `: ${event.error}` : event.bytes !== undefined ? ` (${event.bytes} bytes)` : "";
        io.stderr(`${cleanLine(`${event.type} ${event.path}${detail}`)}\n`);
      },
    });
    if (args.json) {
      io.stdout(`${JSON.stringify(result)}\n`);
      io.stderr(`${summarizeSync(result)}\n`);
    } else {
      io.stdout(`${summarizeSync(result)}\n`);
    }
    // A run the user cancelled says nothing: they are at the keyboard.
    if (tell && !args.dryRun && !deps.signal?.aborted && result.stopped !== "cancelled") {
      if (result.authError) {
        await signInNeeded();
      } else if (newFileCount(result) > 0 || leftUnchecked(result)) {
        const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => void setTimeout(resolve, ms).unref()));
        const label = await courseLabel(client, args.courseId, wait);
        const message = syncNotificationMessage(result, label);
        if (message) await tell({ title: "Brightspace", message, ...(newFileCount(result) > 0 ? { openPath: args.destination } : {}) }).catch(() => {});
      }
    }
    if (deps.signal?.aborted) {
      io.stderr("Interrupted. Files already saved are kept; run it again to continue.\n");
      return 130;
    }
    return exitCodeFor(result);
  } catch (error) {
    if (error instanceof SyncInputError) return report(cleanLine(error.message), 2);
    if (error instanceof AuthError) await signInNeeded();
    else if (tell && !args.dryRun && !deps.signal?.aborted) await tell({ title: "Brightspace", message: `Course ${args.courseId}: could not check for new files` }).catch(() => {});
    // The tools' own wording for each kind of failure; the raw message may carry a response body or URL.
    const first = sanitizeError(error).content[0];
    return report(cleanLine(`Could not sync the course: ${first.type === "text" ? first.text : "unexpected error"}`), 1);
  } finally {
    if (quietApprovals) setApprovalNotificationsSuppressed(false);
  }
}

/** Entry point for `brightspace-mcp-server sync`. */
export async function main(version: string): Promise<void> {
  const { loadConfig } = await import("./../utils/config.js");
  const { createRuntime } = await import("../server.js");
  // Ctrl-C and SIGTERM stop the run cleanly (no partial file, no lock left); a second one stops at once.
  const interrupt = new AbortController();
  const onSignal = (): void => {
    if (interrupt.signal.aborted) process.exit(130);
    interrupt.abort("cancelled");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const code = await runSync(process.argv.slice(3), {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
  }, {
    createClient: async () => createRuntime(await loadConfig({ credentials: true }), version).apiClient,
    signal: interrupt.signal,
  });
  process.exitCode = code;
}
