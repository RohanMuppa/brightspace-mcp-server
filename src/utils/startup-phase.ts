/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { log } from "./logger.js";

/** How long a phase may run before one "still waiting" warning is logged. */
const SLOW_PHASE_MS = 10_000;

/**
 * Run one startup step with timestamped stderr lines around it: one before
 * the work starts, one with its duration when it ends, and a single warning
 * if it is still running after SLOW_PHASE_MS. A client whose initialize
 * request times out can then see which step the server was stuck in.
 *
 * The phase name is printed verbatim, so it must never carry a username,
 * URL, or any other account detail.
 */
export async function startupPhase<T>(name: string, work: () => Promise<T>): Promise<T> {
  log("INFO", `Startup: ${name}...`);
  const started = Date.now();
  const slow = setTimeout(() => {
    log("WARN", `Startup: still ${name} after ${SLOW_PHASE_MS / 1000} s`);
  }, SLOW_PHASE_MS);
  slow.unref?.();
  try {
    const result = await work();
    log("INFO", `Startup: ${name} done in ${Date.now() - started} ms`);
    return result;
  } catch (error) {
    log("WARN", `Startup: ${name} failed after ${Date.now() - started} ms`);
    throw error;
  } finally {
    clearTimeout(slow);
  }
}
