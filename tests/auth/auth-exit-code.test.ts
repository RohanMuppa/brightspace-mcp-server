import { describe, it, expect } from "vitest";
import { authExitCode } from "../../src/auth/auth-exit-code.js";
import { BrowserAuthStuckError, BrowserAuthTransportError } from "../../src/auth/browser-auth.js";
import { AuthenticationInProgressError } from "../../src/auth/auth-lock.js";
import { MfaApprovalError, UnsupportedAuthenticationError } from "../../src/auth/sso-flow.js";
import { NativeCredentialStoreError } from "../../src/auth/credential-store.js";
import { BrowserInstallError } from "../../src/utils/browser-install.js";

describe("authExitCode", () => {
  it("gives a stuck sign-in page its own code, not the transport one", () => {
    expect(authExitCode(new BrowserAuthStuckError("stuck"))).toBe(10);
    expect(authExitCode(new BrowserAuthTransportError("offline"))).toBe(6);
  });

  it("keeps the existing codes", () => {
    expect(authExitCode(new AuthenticationInProgressError())).toBe(2);
    expect(authExitCode(new UnsupportedAuthenticationError("no"))).toBe(4);
    expect(authExitCode(new NativeCredentialStoreError())).toBe(5);
    expect(authExitCode(new MfaApprovalError())).toBe(7);
    expect(authExitCode(new BrowserInstallError())).toBe(8);
    expect(authExitCode(new BrowserInstallError(true))).toBe(9);
    expect(authExitCode(new Error("other"))).toBe(1);
    expect(authExitCode(undefined)).toBe(1);
  });
});
