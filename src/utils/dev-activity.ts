import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AUTH_PHASES, type AuthPhase } from "../auth/auth-phases.js";
import { ERROR_KINDS, errorKind, resultErrorKind, type ErrorKind } from "./error-kind.js";

type Event = "tool_started" | "tool_finished" | "http_response" | "auth_required"
  | "token_mint_started" | "token_mint_finished" | "recovery_started"
  | "mfa_observed" | "recovery_finished" | "auth_phase"
  | "mfa_method_selected" | "mfa_code_submitted" | "run_started";
type Outcome = "success" | "error" | "sessionExpired" | "transport";
interface Fields { elapsedMs?: number; status?: number; outcome?: Outcome; reason?: string; phase?: AuthPhase; errorKind?: ErrorKind; operation?: HttpOperation; recoveryId?: string }

const API = String.raw`^/d2l/api/l[pe]/[^/]+/`;
const COURSE = API + String.raw`\d+/`;
/** First match wins; a path that matches none is "other". Matched on the path alone, query dropped. */
const HTTP_OPERATIONS = [
  ["versions", "^/d2l/api/versions/"],
  ["whoami", API + "users/whoami"],
  ["enrollments", API + "enrollments/"],
  ["groups", COURSE + String.raw`groupcategories/\d+/groups/`],
  ["groupCategories", COURSE + "groupcategories/"],
  ["ltiLinks", API + "lti/link/"],
  ["quizList", COURSE + "quizzes/?$"],
  ["quizAttempts", COURSE + String.raw`quizzes/\d+/attempts/`],
  ["quiz", COURSE + "quizzes/"],
  ["dropboxFolders", COURSE + "dropbox/folders/?$"],
  ["dropboxSubmissions", COURSE + String.raw`dropbox/folders/\d+/submissions/`],
  ["dropboxFeedback", COURSE + String.raw`dropbox/folders/\d+/feedback/`],
  ["dropboxAttachment", COURSE + String.raw`dropbox/folders/\d+/attachments/`],
  ["dropboxFolder", COURSE + "dropbox/folders/"],
  ["dropboxFeedbackPage", "^/d2l/lms/dropbox/user/folder_user_view_feedback"],
  ["rubrics", COURSE + "rubrics"],
  ["grades", COURSE + "grades/"],
  ["contentFile", COURSE + String.raw`content/topics/\d+/file`],
  ["content", COURSE + "content/"],
  ["newsAttachment", COURSE + String.raw`news/\d+/attachments/`],
  ["news", COURSE + "news/"],
  ["discussions", COURSE + "discussions/"],
  ["overviewAttachment", COURSE + "overview/attachment"],
  ["overview", COURSE + "overview"],
  ["classlist", COURSE + "classlist/"],
  ["quickLink", "^/d2l/common/dialogs/quickLink/"],
  // The LTI launch page a video quickLink leads to (get_video_transcript).
  ["ltiLaunch", String.raw`^/d2l/le/lti/\d+/toolLaunch/`],
] as const;
export type HttpOperation = typeof HTTP_OPERATIONS[number][0] | "other";
const OPERATION_PATTERNS = HTTP_OPERATIONS.map(([name, pattern]) => [name, new RegExp(pattern)] as const);
const OPERATION_NAMES: readonly string[] = [...HTTP_OPERATIONS.map(([name]) => name), "other"];

/** Names what a request was for without keeping its endpoint, IDs or query. */
export function httpOperation(path: string): HttpOperation {
  const bare = path.split(/[?#]/, 1)[0]!;
  return OPERATION_PATTERNS.find(([, pattern]) => pattern.test(bare))?.[0] ?? "other";
}
interface CallContext { callId: string; tool: string }
/** What a process says about itself once, so runs can be told apart across upgrades. */
export interface RunInfo { version: string; role: "server" | "auth" }
/** Names one background recovery; the parent passes it to its auth child so their events join. */
export const RECOVERY_ID_ENV = "D2L_RECOVERY_ID";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const calls = new AsyncLocalStorage<CallContext>();
const runId = randomUUID();
const MAX_BYTES = 5 * 1024 * 1024;
let directory: string | undefined;
let warned = false;
/** Set in an auth child: the parent recovery every event of this process belongs to. */
let processRecoveryId: string | undefined;
let lastStart: number | undefined;
let lastSuccess: number | undefined;

/** Explicit opt-in; separate from ordinary stderr debugging. */
export function configureDevActivity(sessionDir: string, run?: RunInfo): void {
  directory = process.env.D2L_DEV_MODE === "true" ? join(sessionDir, "dev-activity") : undefined;
  lastStart = lastSuccess = undefined;
  warned = false;
  const inherited = process.env[RECOVERY_ID_ENV];
  processRecoveryId = inherited && ID.test(inherited) ? inherited : undefined;
  if (run) write("run_started", {}, undefined, undefined, undefined, run);
}

/** A fresh, non-secret id for one recovery; see RECOVERY_ID_ENV. */
export function newRecoveryId(): string {
  return randomUUID();
}

/** No arbitrary text, errors, URLs, request arguments or response content. */
export function devActivity(event: Event, fields: Fields = {}): void {
  write(event, fields);
}

function write(event: Event, fields: Fields, context = calls.getStore(), idleMs?: number, sinceSuccessMs?: number,
  run?: RunInfo): void {
  if (!directory) return;
  if (!["run_started", "tool_started", "tool_finished", "http_response", "auth_required", "token_mint_started",
    "token_mint_finished", "recovery_started", "mfa_observed", "recovery_finished", "auth_phase",
    "mfa_method_selected", "mfa_code_submitted"].includes(event)) return;
  const at = new Date().toISOString();
  const record: Record<string, unknown> = { at, runId, pid: process.pid, event };
  if (context) Object.assign(record, context);
  // A child's inherited id wins: it is the one its parent recorded.
  const recoveryId = processRecoveryId ?? fields.recoveryId;
  if (recoveryId && ID.test(recoveryId)) record.recoveryId = recoveryId;
  if (run) {
    if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/.test(run.version)) record.version = run.version;
    record.node = process.versions.node;
    if (run.role === "server" || run.role === "auth") record.role = run.role;
  }
  for (const [key, value] of Object.entries({ elapsedMs: fields.elapsedMs, status: fields.status, idleMs, sinceSuccessMs })) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) record[key] = value;
  }
  if (["success", "error", "sessionExpired", "transport"].includes(fields.outcome ?? "")) record.outcome = fields.outcome;
  if (["busy", "cooldown", "unsupported", "secureStorage", "transport", "timeout", "failed", "mfaPending",
    "automaticPending", "inProgress", "mfaHeld"].includes(fields.reason ?? "")) record.reason = fields.reason;
  if ((AUTH_PHASES as readonly string[]).includes(fields.phase ?? "")) record.phase = fields.phase;
  if ((ERROR_KINDS as readonly string[]).includes(fields.errorKind ?? "")) record.errorKind = fields.errorKind;
  if (OPERATION_NAMES.includes(fields.operation ?? "")) record.operation = fields.operation;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `activity-${at.slice(0, 10)}-${process.pid}-${runId}.jsonl`);
    let size = 0;
    try { size = statSync(file).size; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const line = JSON.stringify(record) + "\n";
    if (size + Buffer.byteLength(line) <= MAX_BYTES) appendFileSync(file, line, { mode: 0o600 });
  } catch {
    if (!warned) {
      warned = true;
      console.error("[WARN] Dev activity could not be saved; tool execution continues.");
    }
  }
}

/** Wraps registered handlers, composing with the MFA progress relay. */
export function trackToolActivity(server: McpServer): void {
  if (!directory) return;
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, callback: (...args: any[]) => unknown) =>
    register(name, config as never, (async (...args: any[]) => {
      // Tool names come from registration, never the client's arguments.
      const context = { callId: randomUUID(), tool: /^[a-zA-Z0-9_-]{1,100}$/.test(name) ? name : "other" };
      const started = Date.now();
      write("tool_started", {}, context, lastStart === undefined ? undefined : started - lastStart,
        lastSuccess === undefined ? undefined : started - lastSuccess);
      lastStart = started;
      return calls.run(context, async () => {
        let outcome: Outcome = "error";
        let kind: ErrorKind | undefined;
        try {
          const result = await callback(...args);
          if ((result as { isError?: boolean } | undefined)?.isError) {
            kind = resultErrorKind(result);
          } else {
            outcome = "success";
            lastSuccess = Date.now();
          }
          return result;
        } catch (error) {
          kind = errorKind(error);
          throw error;
        } finally {
          write("tool_finished", { outcome, errorKind: kind, elapsedMs: Date.now() - started });
        }
      });
    }) as never)) as typeof server.registerTool;
}
