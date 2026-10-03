import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Event = "tool_started" | "tool_finished" | "http_response" | "auth_required"
  | "token_mint_started" | "token_mint_finished" | "recovery_started"
  | "mfa_observed" | "recovery_finished";
type Outcome = "success" | "error" | "sessionExpired" | "transport";
interface Fields { elapsedMs?: number; status?: number; outcome?: Outcome; reason?: string }
interface CallContext { callId: string; tool: string }
const calls = new AsyncLocalStorage<CallContext>();
const runId = randomUUID();
const MAX_BYTES = 5 * 1024 * 1024;
let directory: string | undefined;
let warned = false;
let lastStart: number | undefined;
let lastSuccess: number | undefined;

/** Explicit opt-in; separate from ordinary stderr debugging. */
export function configureDevActivity(sessionDir: string): void {
  directory = process.env.D2L_DEV_MODE === "true" ? join(sessionDir, "dev-activity") : undefined;
  lastStart = lastSuccess = undefined;
  warned = false;
}

/** No arbitrary text, errors, URLs, request arguments or response content. */
export function devActivity(event: Event, fields: Fields = {}): void {
  write(event, fields);
}

function write(event: Event, fields: Fields, context = calls.getStore(), idleMs?: number, sinceSuccessMs?: number): void {
  if (!directory) return;
  if (!["tool_started", "tool_finished", "http_response", "auth_required", "token_mint_started",
    "token_mint_finished", "recovery_started", "mfa_observed", "recovery_finished"].includes(event)) return;
  const at = new Date().toISOString();
  const record: Record<string, unknown> = { at, runId, pid: process.pid, event };
  if (context) Object.assign(record, context);
  for (const [key, value] of Object.entries({ elapsedMs: fields.elapsedMs, status: fields.status, idleMs, sinceSuccessMs })) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) record[key] = value;
  }
  if (["success", "error", "sessionExpired", "transport"].includes(fields.outcome ?? "")) record.outcome = fields.outcome;
  if (["busy", "cooldown", "unsupported", "secureStorage", "transport", "timeout", "failed", "mfaPending"].includes(fields.reason ?? "")) record.reason = fields.reason;
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
        try {
          const result = await callback(...args);
          if (!(result as { isError?: boolean } | undefined)?.isError) {
            outcome = "success";
            lastSuccess = Date.now();
          }
          return result;
        } finally {
          write("tool_finished", { outcome, elapsedMs: Date.now() - started });
        }
      });
    }) as never)) as typeof server.registerTool;
}
