/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Tells the user, mid-call, which MFA challenge to complete. */
export type MfaAnnouncer = (numberMatch: string | undefined) => void;

const announcers = new AsyncLocalStorage<MfaAnnouncer | undefined>();

/**
 * The announcer for the tool call currently running, if its client can be
 * told about an MFA challenge before the call returns. The API client's
 * re-auth hook hands this to AuthRunner.run(), which then keeps the call
 * waiting on the sign-in instead of answering "call this tool again".
 */
export function currentMfaAnnouncer(): MfaAnnouncer | undefined {
  return announcers.getStore();
}

/**
 * The text of the mid-call notice. numberMatch is the 1-3 digit value
 * AuthRunner parsed from a strictly matched marker, never free child output.
 */
function challengeNotice(numberMatch: string | undefined): string {
  const step = numberMatch
    ? `Open Microsoft Authenticator and enter ${numberMatch} within 5 minutes.`
    : "Approve the sign-in request on your phone (Microsoft Authenticator or Duo).";
  return `${step} Waiting for the sign-in to finish…`;
}

/**
 * Make every tool registered on this server from here on announce MFA
 * challenges mid-call.
 *
 * A client that sends a progress token with tools/call can show progress
 * messages while the call is still open, so the challenge goes out as a
 * progress notification on that call. A client that sends none gets no
 * announcer, and its calls keep answering the moment a challenge appears.
 */
export function relayMfaChallenges(server: McpServer): void {
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, callback: (...args: any[]) => unknown) =>
    register(name, config as never, ((...args: any[]) => {
      // The request context is always the handler's last argument.
      const extra = args[args.length - 1];
      const progressToken = extra?._meta?.progressToken;
      let progress = 0;
      const announce: MfaAnnouncer | undefined = progressToken === undefined
        ? undefined
        : (numberMatch) => {
            progress += 1;
            void extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress, message: challengeNotice(numberMatch) },
            }).catch(() => {});
          };
      return announcers.run(announce, () => callback(...args));
    }) as never)) as typeof server.registerTool;
}
