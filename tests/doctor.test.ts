import { describe, it, expect, vi } from "vitest";
import { runDoctorChecks, readOnlySessionStore, type DoctorDeps } from "../src/doctor.js";
import { SETUP_COMMAND, AUTH_COMMAND, GLOBAL_INSTALL_COMMAND, CLEAR_NPX_CACHE_COMMAND } from "../src/utils/commands.js";
import { TokenManager } from "../src/auth/token-manager.js";
import { SessionStore } from "../src/auth/session-store.js";
import { AuthenticationInProgressError } from "../src/auth/auth-lock.js";
import type { TokenData } from "../src/types/index.js";

/**
 * doctor is a beginner-facing diagnostic: one line per check, a plain-English
 * next step on every ✗, and checks downstream of a failure are reported as
 * skipped rather than cascading into confusing errors. Every external
 * dependency is injected (the same seam get_server_info uses for
 * readSignedInIdentity), so these tests never touch the filesystem, the
 * native credential store, or the network.
 */

const STORE = { baseUrl: "https://purdue.brightspace.com", username: "student42" };

function deps(overrides: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    nodeVersion: "v22.11.0",
    platform: "darwin",
    env: {},
    configStoreExists: () => true,
    loadConfigStore: () => ({ ...STORE }),
    getStoredPassword: async () => "a-password",
    getStoredTotpUri: async () => null,
    discoverVersions: async () => ({ lp: "1.50", le: "1.90" }),
    getSessionToken: async () => ({ accessToken: "tok", capturedAt: 0, expiresAt: 0, source: "cache" as const }),
    countCourses: async () => ({ count: 4, hasMore: false }),
    fetchLatestVersion: async () => "3.9.9",
    chromiumStatus: async () => ({ headless: "present" as const, visible: true }),
    installKind: "npx-cache",
    installedVersion: "3.9.9",
    ...overrides,
  };
}

const idOf = (result: Awaited<ReturnType<typeof runDoctorChecks>>, id: string) =>
  result.checks.find((c) => c.id === id)!;

describe("doctor: all-pass path", () => {
  it("passes every check and reports a clean exit", async () => {
    const result = await runDoctorChecks(deps());
    expect(result.allOk).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual([
      "node", "browser", "config", "credential", "network", "session", "courses", "version",
    ]);
  });

  it("reports the course count from the real call", async () => {
    const result = await runDoctorChecks(deps({ countCourses: async () => ({ count: 7, hasMore: false }) }));
    expect(idOf(result, "courses").line).toBe("✓ Found 7 courses on Brightspace");
  });

  it("uses singular 'course' for exactly one", async () => {
    const result = await runDoctorChecks(deps({ countCourses: async () => ({ count: 1, hasMore: false }) }));
    expect(idOf(result, "courses").line).toBe("✓ Found 1 course on Brightspace");
  });

  it("says 'at least N' when the first page reports more are available", async () => {
    const result = await runDoctorChecks(deps({ countCourses: async () => ({ count: 20, hasMore: true }) }));
    expect(idOf(result, "courses").line).toBe("✓ Found at least 20 courses on Brightspace");
  });

  it("reports the config line with the account and school", async () => {
    const result = await runDoctorChecks(deps());
    expect(idOf(result, "config").line).toBe("✓ Setup found — signed in as student42 at https://purdue.brightspace.com");
  });
});

describe("doctor: (a) Node version", () => {
  it("fails on Node below 22 with an install link", async () => {
    const result = await runDoctorChecks(deps({ nodeVersion: "v20.19.0" }));
    const check = idOf(result, "node");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("v20.19.0");
    expect(check.line).toContain("too old");
    expect(check.line).toContain("https://nodejs.org/");
    expect(result.allOk).toBe(false);
  });

  it("passes on exactly Node 22", async () => {
    const result = await runDoctorChecks(deps({ nodeVersion: "v22.0.0" }));
    expect(idOf(result, "node").ok).toBe(true);
  });
});

describe("doctor: (b) config file", () => {
  it("fails with 'run setup' when no config file exists", async () => {
    const result = await runDoctorChecks(deps({ configStoreExists: () => false }));
    const check = idOf(result, "config");
    expect(check.ok).toBe(false);
    expect(check.line).toContain(SETUP_COMMAND);
  });

  it("fails when the config file has no username", async () => {
    const result = await runDoctorChecks(
      deps({ loadConfigStore: () => ({ baseUrl: "https://purdue.brightspace.com" }) })
    );
    expect(idOf(result, "config").ok).toBe(false);
  });

  it("fails when the config file has no baseUrl", async () => {
    const result = await runDoctorChecks(deps({ loadConfigStore: () => ({ username: "student42" }) }));
    expect(idOf(result, "config").ok).toBe(false);
  });

  it("fails when the config file cannot be parsed", async () => {
    const result = await runDoctorChecks(
      deps({
        loadConfigStore: () => {
          throw new Error("Unexpected token");
        },
      })
    );
    expect(idOf(result, "config").ok).toBe(false);
    expect(idOf(result, "config").line).toContain(SETUP_COMMAND);
  });

  it("skips every downstream check with a clear reason when config fails", async () => {
    const result = await runDoctorChecks(deps({ configStoreExists: () => false }));
    const expectedNames: Record<string, string> = {
      credential: "Credential store",
      network: "Brightspace reachability",
      session: "Saved sign-in",
      courses: "Course list",
    };
    for (const [id, name] of Object.entries(expectedNames)) {
      const check = idOf(result, id);
      expect(check.ok).toBe(false);
      expect(check.line).toContain("Skipped");
      // Each skipped line is prefixed with the name of the check that was skipped.
      expect(check.line.startsWith(`✗ ${name}: Skipped`)).toBe(true);
    }
    // version is independent of setup and still runs
    expect(idOf(result, "version").ok).toBe(true);
  });
});

describe("doctor: (c) credential store", () => {
  it("names the sign-in step when no password is saved (prepare saves none)", async () => {
    const result = await runDoctorChecks(deps({ getStoredPassword: async () => null }));
    const check = idOf(result, "credential");
    expect(check.ok).toBe(false);
    expect(check.line).toContain(`${SETUP_COMMAND} --purdue --sign-in`);
  });

  it("explains the unlocked keyring on Linux when the store throws", async () => {
    const result = await runDoctorChecks(
      deps({
        platform: "linux",
        getStoredPassword: async () => {
          throw new Error("Linux requires secret-tool and an unlocked Secret Service. Install libsecret-tools (Debian/Ubuntu) or your distribution's libsecret tools, unlock the desktop keyring, then retry.");
        },
      })
    );
    const check = idOf(result, "credential");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("secret-tool");
    expect(check.line).toContain("keyring");
  });

  it("names the sign-in step on a non-Linux store failure", async () => {
    const result = await runDoctorChecks(
      deps({
        platform: "darwin",
        getStoredPassword: async () => {
          throw new Error("The native credential store is locked or unavailable.");
        },
      })
    );
    const check = idOf(result, "credential");
    expect(check.ok).toBe(false);
    expect(check.line).toContain(SETUP_COMMAND);
    expect(check.line).not.toContain("secret-tool");
  });
});

describe("doctor: (d) school URL reachability", () => {
  it("fails with a plain next step when the API does not answer", async () => {
    const result = await runDoctorChecks(
      deps({
        discoverVersions: async () => {
          throw new Error("ECONNREFUSED");
        },
      })
    );
    const check = idOf(result, "network");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("https://purdue.brightspace.com");
    expect(check.line).toContain("internet connection");
  });
});

describe("doctor: (e) saved session / token without a browser", () => {
  it("fails when no token can be produced", async () => {
    const result = await runDoctorChecks(deps({ getSessionToken: async () => null }));
    const check = idOf(result, "session");
    expect(check.ok).toBe(false);
    expect(check.line).toContain(AUTH_COMMAND);
  });

  it("fails cleanly when getSessionToken throws", async () => {
    const result = await runDoctorChecks(
      deps({
        getSessionToken: async () => {
          throw new Error("token service request failed");
        },
      })
    );
    expect(idOf(result, "session").ok).toBe(false);
  });

  it("skips the courses check with a sign-in-specific reason when session fails", async () => {
    const result = await runDoctorChecks(deps({ getSessionToken: async () => null }));
    const check = idOf(result, "courses");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("Skipped");
    expect(check.line).toContain("sign-in");
  });
});

describe("doctor: (f) one real course-list call", () => {
  it("fails with the underlying error message", async () => {
    const result = await runDoctorChecks(
      deps({
        countCourses: async () => {
          throw new Error("API error (403) at /enrollments: Forbidden");
        },
      })
    );
    const check = idOf(result, "courses");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("Forbidden");
  });

  it("truncates a long error body, strips newlines, and drops URLs", async () => {
    const htmlBody =
      "API error (403) at https://purdue.brightspace.com/d2l/api/lp/1.50/enrollments/myenrollments/?orgUnitTypeId=3:\n" +
      "<html>\n<body>\n" +
      "Forbidden. ".repeat(30);
    const result = await runDoctorChecks(
      deps({
        countCourses: async () => {
          throw new Error(htmlBody);
        },
      })
    );
    const check = idOf(result, "courses");
    expect(check.ok).toBe(false);
    expect(check.line).not.toContain("\n");
    expect(check.line).not.toContain("https://");
    // The whole line (not just the error detail) stays well short of printing the raw ~300-char body.
    expect(check.line.length).toBeLessThan(220);
  });

  it("never runs the course check when getSessionToken already failed", async () => {
    let called = false;
    await runDoctorChecks(
      deps({
        getSessionToken: async () => null,
        countCourses: async () => {
          called = true;
          return { count: 1, hasMore: false };
        },
      })
    );
    expect(called).toBe(false);
  });
});

describe("doctor: (g) version check", () => {
  it("passes and reports up to date", async () => {
    const result = await runDoctorChecks(deps({ installedVersion: "3.9.9", fetchLatestVersion: async () => "3.9.9" }));
    const check = idOf(result, "version");
    expect(check.ok).toBe(true);
    expect(check.line).toContain("latest version");
    expect(check.line).toContain("3.9.9");
  });

  it("fails and names both versions plus an npx-cache next step", async () => {
    const result = await runDoctorChecks(
      deps({ installedVersion: "3.9.9", fetchLatestVersion: async () => "3.10.0", installKind: "npx-cache" })
    );
    const check = idOf(result, "version");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("3.9.9");
    expect(check.line).toContain("3.10.0");
    expect(check.line).toContain(CLEAR_NPX_CACHE_COMMAND);
  });

  it("tells a global npm install to upgrade with the global-install command", async () => {
    const result = await runDoctorChecks(
      deps({ installedVersion: "3.9.9", fetchLatestVersion: async () => "3.10.0", installKind: "npm-install" })
    );
    expect(idOf(result, "version").line).toContain(GLOBAL_INSTALL_COMMAND);
  });

  it("tells a source checkout to git pull and rebuild", async () => {
    const result = await runDoctorChecks(
      deps({ installedVersion: "3.9.9", fetchLatestVersion: async () => "3.10.0", installKind: "source-checkout" })
    );
    const check = idOf(result, "version");
    expect(check.ok).toBe(false);
    expect(check.line).toContain("npm run build");
  });

  it("notes a source checkout even when it is up to date", async () => {
    const result = await runDoctorChecks(
      deps({ installedVersion: "3.9.9", fetchLatestVersion: async () => "3.9.9", installKind: "source-checkout" })
    );
    const check = idOf(result, "version");
    expect(check.ok).toBe(true);
    expect(check.line).toContain("source checkout");
  });

  it("passes quietly when the registry cannot be reached — never fails for being offline", async () => {
    const result = await runDoctorChecks(deps({ fetchLatestVersion: async () => null }));
    const check = idOf(result, "version");
    expect(check.ok).toBe(true);
    expect(check.line).toContain("offline");
  });

  it("passes quietly when fetchLatestVersion itself throws", async () => {
    const result = await runDoctorChecks(
      deps({
        fetchLatestVersion: async () => {
          throw new Error("network down");
        },
      })
    );
    expect(idOf(result, "version").ok).toBe(true);
  });
});

describe("doctor: 2FA shortcuts line", () => {
  const URL = "https://github.com/RohanMuppa/brightspace-mcp-server/blob/main/docs/sign-in.md#fewer-2fa-prompts";

  it("reports both off, with the docs link, and does not change allOk or the check list", async () => {
    const result = await runDoctorChecks(deps({ getStoredTotpUri: async () => null }));
    expect(result.notes).toEqual([
      `2FA shortcuts: remember this device off, authenticator key not saved. Want fewer prompts? See ${URL}`,
    ]);
    expect(result.allOk).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual([
      "node", "browser", "config", "credential", "network", "session", "courses", "version",
    ]);
  });

  it("reports a saved key and remember-device from config.json, without the link", async () => {
    const result = await runDoctorChecks(deps({
      loadConfigStore: () => ({ ...STORE, rememberMfa: true }),
      getStoredTotpUri: async () => "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
    }));
    expect(result.notes).toEqual(["2FA shortcuts: remember this device on, authenticator key saved."]);
  });

  it("lets D2L_REMEMBER_MFA override config.json", async () => {
    const result = await runDoctorChecks(deps({
      env: { D2L_REMEMBER_MFA: "true" },
      getStoredTotpUri: async () => null,
    }));
    expect(result.notes[0]).toContain("remember this device on");
    const off = await runDoctorChecks(deps({
      env: { D2L_REMEMBER_MFA: "false" },
      loadConfigStore: () => ({ ...STORE, rememberMfa: true }),
      getStoredTotpUri: async () => null,
    }));
    expect(off.notes[0]).toContain("remember this device off");
  });

  it("counts D2L_TOTP_SECRET as a saved key without reading the keychain", async () => {
    const getStoredTotpUri = vi.fn(async () => null);
    const result = await runDoctorChecks(deps({ env: { D2L_TOTP_SECRET: "JBSWY3DPEHPK3PXP" }, getStoredTotpUri }));
    expect(result.notes[0]).toContain("authenticator key saved");
    expect(getStoredTotpUri).not.toHaveBeenCalled();
  });

  it("says the key was not checked when the credential store cannot be read", async () => {
    const result = await runDoctorChecks(deps({ getStoredTotpUri: async () => { throw new Error("locked"); } }));
    expect(result.notes).toEqual(["2FA shortcuts: remember this device off, authenticator key not checked."]);
  });

  it("is omitted when setup is missing (nothing to report)", async () => {
    const result = await runDoctorChecks(deps({ configStoreExists: () => false }));
    expect(result.notes).toEqual([]);
  });

  it("never prints the key or anything derived from it", async () => {
    const secret = "otpauth://totp/Purdue:student42?secret=JBSWY3DPEHPK3PXP&issuer=Purdue";
    const result = await runDoctorChecks(deps({ getStoredTotpUri: async () => secret }));
    const all = [...result.checks.map((c) => c.line), ...result.notes].join("\n");
    expect(all).not.toContain("JBSWY3DPEHPK3PXP");
    expect(all).not.toContain("otpauth");
    const viaEnv = await runDoctorChecks(deps({ env: { D2L_TOTP_SECRET: "JBSWY3DPEHPK3PXP" } }));
    expect([...viaEnv.checks.map((c) => c.line), ...viaEnv.notes].join("\n")).not.toContain("JBSWY3DPEHPK3PXP");
  });
});

describe("doctor: never prints secrets", () => {
  it("never includes the password in any line, even on failure", async () => {
    const result = await runDoctorChecks(
      deps({ getStoredPassword: async () => "super-secret-password-value" })
    );
    const text = result.checks.map((c) => c.line).join("\n");
    expect(text).not.toContain("super-secret-password-value");
  });

  it("never includes a raw token value", async () => {
    const result = await runDoctorChecks(
      deps({ getSessionToken: async () => ({ accessToken: "secret-jwt-value", capturedAt: 0, expiresAt: 0, source: "cache" as const }) })
    );
    const text = result.checks.map((c) => c.line).join("\n");
    expect(text).not.toContain("secret-jwt-value");
  });
});

describe("doctor: env-based configuration (Docker/headless, no config.json)", () => {
  it("passes config and credential checks from D2L_BASE_URL + D2L_ACCESS_TOKEN alone", async () => {
    const result = await runDoctorChecks(
      deps({
        configStoreExists: () => false,
        env: { D2L_BASE_URL: "https://school.example", D2L_ACCESS_TOKEN: "a-token" },
        getStoredPassword: async () => {
          throw new Error("must not check the credential store when an env token is set");
        },
      })
    );
    expect(idOf(result, "config").ok).toBe(true);
    expect(idOf(result, "config").line).toContain("https://school.example");
    const credential = idOf(result, "credential");
    expect(credential.ok).toBe(true);
    expect(credential.line).toContain("D2L_ACCESS_TOKEN");
  });

  it("passes via D2L_SESSION_COOKIE too, and never reaches the password store", async () => {
    const result = await runDoctorChecks(
      deps({
        configStoreExists: () => false,
        env: { D2L_BASE_URL: "https://school.example", D2L_SESSION_COOKIE: "d2lSessionVal=a;d2lSecureSessionVal=b" },
        getStoredPassword: async () => {
          throw new Error("must not be called");
        },
      })
    );
    const credential = idOf(result, "credential");
    expect(credential.ok).toBe(true);
    expect(credential.line).toContain("D2L_SESSION_COOKIE");
  });

  it("D2L_BASE_URL / D2L_USERNAME override a saved config.json", async () => {
    const result = await runDoctorChecks(deps({ env: { D2L_USERNAME: "otheruser" } }));
    expect(idOf(result, "config").ok).toBe(true);
    expect(idOf(result, "config").line).toContain("otheruser");
  });

  it("passes the env credential through to the session and course checks", async () => {
    let sessionEnvToken: string | undefined;
    let courseEnvToken: string | undefined;
    const result = await runDoctorChecks(
      deps({
        configStoreExists: () => false,
        env: { D2L_BASE_URL: "https://school.example", D2L_ACCESS_TOKEN: "a-token" },
        getSessionToken: async (_baseUrl, _sessionDir, envAccessToken) => {
          sessionEnvToken = envAccessToken;
          return { accessToken: "a-token", capturedAt: 0, expiresAt: 0, source: "env" as const };
        },
        countCourses: async (_baseUrl, _sessionDir, envAccessToken) => {
          courseEnvToken = envAccessToken;
          return { count: 2, hasMore: false };
        },
      })
    );
    expect(idOf(result, "session").ok).toBe(true);
    expect(idOf(result, "courses").ok).toBe(true);
    expect(sessionEnvToken).toBe("a-token");
    expect(courseEnvToken).toBe("a-token");
  });

  it("still fails the config check when no base URL is available anywhere", async () => {
    const result = await runDoctorChecks(deps({ configStoreExists: () => false, env: { D2L_ACCESS_TOKEN: "a-token" } }));
    expect(idOf(result, "config").ok).toBe(false);
  });

  it("still fails when there is a base URL but neither a username nor an env credential", async () => {
    const result = await runDoctorChecks(
      deps({ configStoreExists: () => false, env: { D2L_BASE_URL: "https://school.example" } })
    );
    expect(idOf(result, "config").ok).toBe(false);
  });
});

describe("doctor: read-only session-store wiring (doctor must never write session.json)", () => {
  const STALE_TOKEN: TokenData = {
    accessToken: "stale-access-token",
    tenantOrigin: "https://school.example",
    capturedAt: 0,
    expiresAt: 0, // already expired, so TokenManager attempts a mint from it
    source: "browser",
    cookieHeader: "d2lSessionVal=x; d2lSecureSessionVal=y",
    csrfToken: "csrf-token",
  };

  it("never calls the real SessionStore's write-shaped methods, even on a sessionExpired mint", async () => {
    const store = new SessionStore("/does/not/matter");
    vi.spyOn(store, "peek").mockResolvedValue(STALE_TOKEN);
    const loadSpy = vi.spyOn(store, "load");
    const saveSpy = vi.spyOn(store, "save");
    const clearSpy = vi.spyOn(store, "clear");
    const saveIfCurrentSpy = vi.spyOn(store, "saveIfCurrent");
    const clearIfCurrentSpy = vi.spyOn(store, "clearIfCurrent");

    const tokenManager = new TokenManager({
      baseUrl: "https://school.example",
      sessionStore: readOnlySessionStore(store),
      mint: async () => ({ ok: false, reason: "sessionExpired" }),
    });

    await expect(tokenManager.getToken()).resolves.toBeNull();

    // The real SessionStore's own load/save/clear/saveIfCurrent/clearIfCurrent
    // — the ones that take the write lock, migrate a v1 record, or trash
    // session.json — are never reached. Only peek() is.
    expect(loadSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(saveIfCurrentSpy).not.toHaveBeenCalled();
    expect(clearIfCurrentSpy).not.toHaveBeenCalled();
  });

  it("never writes on a successful mint either", async () => {
    const store = new SessionStore("/does/not/matter");
    vi.spyOn(store, "peek").mockResolvedValue(STALE_TOKEN);
    const saveIfCurrentSpy = vi.spyOn(store, "saveIfCurrent");

    const tokenManager = new TokenManager({
      baseUrl: "https://school.example",
      sessionStore: readOnlySessionStore(store),
      mint: async () => ({ ok: true, accessToken: "fresh-jwt" }),
    });

    const token = await tokenManager.getToken();
    expect(token?.accessToken).toBe("fresh-jwt");
    expect(saveIfCurrentSpy).not.toHaveBeenCalled();
  });

  it("does not throw even when the real store's load() would hit an in-progress auth lock", async () => {
    const store = new SessionStore("/does/not/matter");
    vi.spyOn(store, "peek").mockResolvedValue(STALE_TOKEN);
    // If doctor ever called the real load() — the write-lock path a live sign-in
    // can be holding — this would reject. It must never be reached.
    vi.spyOn(store, "load").mockRejectedValue(new AuthenticationInProgressError());

    const tokenManager = new TokenManager({
      baseUrl: "https://school.example",
      sessionStore: readOnlySessionStore(store),
      mint: async () => ({ ok: true, accessToken: "fresh-jwt" }),
    });

    await expect(tokenManager.getToken()).resolves.not.toBeNull();
  });
});

describe("doctor: an install prepare got ready", () => {
  it("names the sign-in step, not the AI app, when nothing is saved yet", async () => {
    const result = await runDoctorChecks(deps({ getStoredPassword: async () => null, getSessionToken: async () => null }));
    expect(idOf(result, "session").line).toBe(
      `✗ Not signed in yet — run this in a terminal: ${SETUP_COMMAND} --purdue --sign-in`,
    );
  });
});

describe("doctor: Chromium", () => {
  it("fails with the prepare command when a browser sign-in needs is missing", async () => {
    const result = await runDoctorChecks(deps({ chromiumStatus: async () => ({ headless: "missing", visible: true }) }));
    const check = idOf(result, "browser");
    expect(check.ok).toBe(false);
    expect(check.line).toContain(`${SETUP_COMMAND} --prepare`);
    expect(result.allOk).toBe(false);
  });

  it("passes when a test launch was blocked for another reason but both browsers exist", async () => {
    const result = await runDoctorChecks(deps({ chromiumStatus: async () => ({ headless: "unknown", visible: true, detail: "sandbox" }) }));
    expect(idOf(result, "browser").ok).toBe(true);
  });

  it("doesn't require Chromium when an environment credential signs in", async () => {
    const result = await runDoctorChecks(deps({
      env: { D2L_SESSION_COOKIE: "d2lSessionVal=a; d2lSecureSessionVal=b" },
      chromiumStatus: async () => ({ headless: "missing", visible: false }),
    }));
    expect(idOf(result, "browser").ok).toBe(true);
  });

  it("reports a check that throws as a problem, not a crash", async () => {
    const result = await runDoctorChecks(deps({ chromiumStatus: async () => { throw new Error("boom"); } }));
    expect(idOf(result, "browser").ok).toBe(false);
  });
});
