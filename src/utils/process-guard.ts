/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { EventEmitter } from "node:events";
import { log } from "./logger.js";

/** The slice of `process` the stdio server's lifetime depends on. */
export interface GuardedProcess extends EventEmitter {
  stdin: EventEmitter;
  stdout: EventEmitter;
  exit(code?: number): void;
}

const RECONNECT_HINT =
  "Restart or reconnect the Brightspace MCP server in your MCP client to continue " +
  "(for example, toggle it off and on in the client's MCP settings, or restart the client).";

/**
 * Keep one bad moment from silently killing a stdio MCP server.
 *
 * Each MCP client launches its own server process. When that process dies,
 * the client only ever reports "Transport closed" for every later call, even
 * calls that never touch the network, while another client's process carries
 * on fine. Node's defaults are what kill it: an exception thrown from any
 * event listener, or an EPIPE on stdout with no 'error' listener, ends the
 * process with nothing useful in the client's log.
 *
 * So: a stray exception is logged and the server keeps serving; a stdout pipe
 * the client has already closed ends the process cleanly, since there is no
 * one left to answer; and every other way the process stops says why on
 * stderr, which MCP clients keep as the server's log.
 */
export function guardServerProcess(proc: GuardedProcess = process): void {
  proc.on("uncaughtException", (error) => {
    log("ERROR", "Uncaught exception; the server is still running", error);
  });
  proc.on("unhandledRejection", (reason) => {
    log("ERROR", "Unhandled promise rejection", reason);
  });
  proc.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      log("INFO", "The MCP client closed the connection (stdout pipe closed); shutting down");
      proc.exit(0);
      return;
    }
    log("ERROR", "Writing to the MCP client failed", error);
  });
  proc.stdin.on("end", () => {
    log("INFO", "The MCP client closed stdin; the server will stop");
  });
  proc.on("exit", (code: number) => {
    if (code === 0) return;
    log("ERROR", `Brightspace MCP server exited with code ${code}. ${RECONNECT_HINT}`);
  });
}
