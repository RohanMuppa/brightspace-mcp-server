import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AUTH_PHASES, type AuthPhase } from "../auth/auth-phases.js";
import { diagnosticErrorKind, ERROR_KINDS, HTTP_OPERATIONS, type DiagnosticErrorKind } from "./diagnostic-fields.js";

type Event = "tool_started" | "tool_finished" | "http_response" | "auth_required"
  | "token_mint_started" | "token_mint_finished" | "recovery_started"
  | "mfa_observed" | "recovery_finished" | "auth_phase"
  | "mfa_method_selected" | "mfa_code_submitted" | "run_started" | "browser_state_loaded"
  | "silent_sso_finished" | "mfa_remembered" | "http_failed" | "token_mint_response"
  | "cache_hit" | "http_coalesced";
type Outcome = "success" | "error" | "sessionExpired" | "transport";
interface Fields {
  elapsedMs?: number; status?: number; outcome?: Outcome; reason?: string; phase?: AuthPhase;
  errorKind?: DiagnosticErrorKind; operation?: typeof HTTP_OPERATIONS[number];
  statePresent?: boolean; ssoResult?: "resumed" | "loginRequired" | "unavailable";
  rememberMfa?: "ticked" | "already" | "absent" | "unknown" | "off";
  version?: string; nodeVersion?: string; role?: "server" | "auth";
}
interface CallContext { callId: string; tool: string; errorKind?: DiagnosticErrorKind }
const calls = new AsyncLocalStorage<CallContext>();
const recoveries = new AsyncLocalStorage<string>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let parentRecoveryId: string | undefined;
const runId = randomUUID();
const MAX_BYTES = 5 * 1024 * 1024;
let directory: string | undefined;
let warned = false;
let lastStart: number | undefined;
let lastSuccess: number | undefined;

/** Explicit opt-in; separate from ordinary stderr debugging. */
export function configureDevActivity(sessionDir: string, runtime?: { version: string; role: "server" | "auth" }): void {
  directory = process.env.D2L_DEV_MODE === "true" ? join(sessionDir, "dev-activity") : undefined;
  const inherited = runtime?.role === "auth" ? process.env.D2L_DEV_RECOVERY_ID : undefined;
  parentRecoveryId = inherited && UUID.test(inherited) ? inherited : undefined;
  lastStart = lastSuccess = undefined;
  warned = false;
  if (runtime) devActivity("run_started", { ...runtime, nodeVersion: process.versions.node });
}

/** One identifier per child attempt, surviving an early MFA response. */
export function withRecoveryActivity<T>(work: () => T): T {
  return recoveries.run(randomUUID(), work);
}

/** Pass only the generated correlation ID, never tool inputs, to the child. */
export function recoveryActivityEnvironment(): Record<string, string> {
  const id = recoveries.getStore();
  return directory && id ? { D2L_DEV_RECOVERY_ID: id } : {};
}

/** Called before a tool converts a typed exception to a user-facing result. */
export function recordToolFailure(error: unknown): void {
  recordToolFailureKind(diagnosticErrorKind(error));
}

export function recordToolFailureKind(kind: DiagnosticErrorKind): void {
  const context = calls.getStore();
  if (context && (ERROR_KINDS as readonly string[]).includes(kind)) context.errorKind = kind;
}

/** No arbitrary text, errors, URLs, request arguments or response content. */
export function devActivity(event: Event, fields: Fields = {}): void {
  write(event, fields);
}

function write(event: Event, fields: Fields, context = calls.getStore(), idleMs?: number, sinceSuccessMs?: number): void {
  if (!directory) return;
  if (!["tool_started", "tool_finished", "http_response", "auth_required", "token_mint_started",
    "token_mint_finished", "recovery_started", "mfa_observed", "recovery_finished", "auth_phase",
    "mfa_method_selected", "mfa_code_submitted", "run_started", "browser_state_loaded",
    "silent_sso_finished", "mfa_remembered", "http_failed", "token_mint_response",
    "cache_hit", "http_coalesced"].includes(event)) return;
  const at = new Date().toISOString();
  const record: Record<string, unknown> = { at, runId, pid: process.pid, event };
  if (context) Object.assign(record, { callId: context.callId, tool: context.tool });
  const recoveryId = recoveries.getStore() ?? parentRecoveryId;
  if (recoveryId) record.recoveryId = recoveryId;
  for (const [key, value] of Object.entries({ elapsedMs: fields.elapsedMs, status: fields.status, idleMs, sinceSuccessMs })) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) record[key] = value;
  }
  if (["success", "error", "sessionExpired", "transport"].includes(fields.outcome ?? "")) record.outcome = fields.outcome;
  if (["busy", "cooldown", "unsupported", "secureStorage", "transport", "timeout", "failed", "mfaPending",
    "automaticPending", "inProgress", "http401", "expiredRedirect", "expiredStub", "invalidPayload",
    "serviceUnavailable", "missingToken", "rejectedToken"].includes(fields.reason ?? "")) record.reason = fields.reason;
  if ((AUTH_PHASES as readonly string[]).includes(fields.phase ?? "")) record.phase = fields.phase;
  if ((ERROR_KINDS as readonly string[]).includes(fields.errorKind ?? "")) record.errorKind = fields.errorKind;
  if ((HTTP_OPERATIONS as readonly string[]).includes(fields.operation ?? "")) record.operation = fields.operation;
  if (typeof fields.statePresent === "boolean") record.statePresent = fields.statePresent;
  if (["resumed", "loginRequired", "unavailable"].includes(fields.ssoResult ?? "")) record.ssoResult = fields.ssoResult;
  if (["ticked", "already", "absent", "unknown", "off"].includes(fields.rememberMfa ?? "")) record.rememberMfa = fields.rememberMfa;
  if (["server", "auth"].includes(fields.role ?? "")) record.role = fields.role;
  for (const key of ["version", "nodeVersion"] as const) {
    const value = fields[key];
    if (typeof value === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) record[key] = value;
  }
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
      const context: CallContext = { callId: randomUUID(), tool: /^[a-zA-Z0-9_-]{1,100}$/.test(name) ? name : "other" };
      const started = Date.now();
      write("tool_started", {}, context, lastStart === undefined ? undefined : started - lastStart,
        lastSuccess === undefined ? undefined : started - lastSuccess);
      lastStart = started;
      return calls.run(context, async () => {
        let outcome: Outcome = "error";
        try {
          const result = await callback(...args);
          if (!(result as { isError?: boolean } | undefined)?.isError) {
            outcome = "success";
            lastSuccess = Date.now();
          }
          return result;
        } catch (error) {
          recordToolFailure(error);
          throw error;
        } finally {
          write("tool_finished", { outcome, elapsedMs: Date.now() - started,
            ...(outcome === "error" ? { errorKind: context.errorKind ?? "unknown" } : {}) });
        }
      });
    }) as never)) as typeof server.registerTool;
}
