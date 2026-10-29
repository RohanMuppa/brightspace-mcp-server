/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT: see LICENSE file for details.
 */

import { BrowserInstallError } from "../utils/browser-install.js";
import { NativeCredentialStoreError } from "./credential-store.js";
import { MfaApprovalError } from "./sso-flow.js";

/**
 * The exit code auth-cli ends with for a failed sign-in. AuthRunner
 * maps each code back to a failure kind (see its `failures` table), so the two
 * must stay in step: 2 busy, 3 cooldown, 4 unsupported, 5 secureStorage,
 * 6 transport, 7 MFA not approved, 8/9 browser install, 10 stuck, 1 anything else.
 */
export function authExitCode(error: unknown): number {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return error instanceof BrowserInstallError ? (error.dependencyMissing ? 9 : 8)
    : error instanceof NativeCredentialStoreError ? 5
      : code === "AUTH_IN_PROGRESS" ? 2
        : code === "AUTH_COOLDOWN" ? 3
          : code === "AUTH_UNSUPPORTED" ? 4
            : code === "AUTH_TRANSPORT" ? 6
              : code === "AUTH_STUCK" ? 10
                : error instanceof MfaApprovalError ? 7 : 1;
}
