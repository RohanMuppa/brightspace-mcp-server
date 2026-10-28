import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSignIn } from "../../src/tools/sign-in.js";
import { AuthProcessError, type AuthFailureKind } from "../../src/auth/auth-runner.js";
import { authPendingNotice } from "../../src/tools/tool-helpers.js";
import { acceptOmittedArguments } from "../../src/tools/omitted-arguments.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * sign_in is the counterpart to sign_out: the only way an AI app can start a
 * sign-in itself. What matters in these tests is not that it signs in — the
 * runner is a stub — but what it tells the caller to do next, and that it
 * never asks the user for a 2FA approval it did not need.
 */

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  baseUrl: "https://school.example",
  sessionDir: "/tmp/sign-in-test",
  tokenTtl: 3600,
  headless: true,
  username: "student42",
  password: "hunter2-secret",
  courseFilter: { activeOnly: true },
  ...overrides,
});

let run: ReturnType<typeof vi.fn>;
let busy: ReturnType<typeof vi.fn>;
let requestVisibleBrowser: ReturnType<typeof vi.fn>;
let getToken: ReturnType<typeof vi.fn>;
let isValid: ReturnType<typeof vi.fn>;

beforeEach(() => {
  run = vi.fn().mockResolvedValue(true);
  busy = vi.fn().mockReturnValue(false);
  requestVisibleBrowser = vi.fn();
  getToken = vi.fn().mockResolvedValue(null); // signed out unless a test says otherwise
  isValid = vi.fn().mockReturnValue(true);
});

const runner = () => ({ run, busy, requestVisibleBrowser }) as any;

async function connect(appConfig: AppConfig, authRunner: any = runner()) {
  const server = new McpServer({ name: "sign-in-test", version: "1" });
  acceptOmittedArguments(server);
  registerSignIn(server, appConfig, { getToken, isValid } as any, authRunner);
  const client = new Client({ name: "sign-in-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function signIn(appConfig: AppConfig = config(), args: Record<string, unknown> = {}, authRunner?: any) {
  const { client, close } = await connect(appConfig, authRunner ?? runner());
  try {
    const result = await client.callTool({ name: "sign_in", arguments: args });
    const blocks = result.content as Array<{ type: string; text: string }>;
    return { text: blocks[0].text, isError: result.isError === true };
  } finally {
    await close();
  }
}

const fail = (kind: AuthFailureKind, message = "nope", numberMatch?: string) =>
  ({ run: vi.fn().mockRejectedValue(new AuthProcessError(kind, message, numberMatch)), busy, requestVisibleBrowser }) as any;

describe("sign_in registration", () => {
  it("is listed with a title, a visible flag, and non-destructive annotations", async () => {
    const { client, close } = await connect(config());
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "sign_in")!;
      expect(tool).toBeDefined();
      expect(tool.title).toBe("Sign In to Brightspace");
      expect(tool.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["visible"]);
      expect(tool.description).toMatch(/safe to call first/i);
    } finally {
      await close();
    }
  });
});

describe("sign_in when a session already works", () => {
  it("starts nothing, so the user is never asked to approve a needless prompt", async () => {
    getToken.mockResolvedValue({ accessToken: "t" });
    const { text, isError } = await signIn();
    expect(run).not.toHaveBeenCalled();
    expect(requestVisibleBrowser).not.toHaveBeenCalled();
    expect(text).toMatch(/already signed in/i);
    expect(isError).toBe(false);
  });

  it("signs in when the saved session has expired", async () => {
    getToken.mockResolvedValue({ accessToken: "t" });
    isValid.mockReturnValue(false);
    const { text } = await signIn();
    expect(run).toHaveBeenCalled();
    expect(text).toMatch(/signed in to brightspace/i);
  });

  it("signs in when the saved session cannot be read at all", async () => {
    getToken.mockRejectedValue(new Error("session.json is corrupt"));
    const { text } = await signIn();
    expect(run).toHaveBeenCalled();
    expect(text).toMatch(/signed in to brightspace/i);
  });
});

describe("sign_in window decision", () => {
  it("opens one with no password saved, because a windowless sign-in could only time out", async () => {
    await signIn(config({ password: undefined }));
    expect(requestVisibleBrowser).toHaveBeenCalledOnce();
  });

  it("stays in the background when a password is saved", async () => {
    await signIn(config());
    expect(requestVisibleBrowser).not.toHaveBeenCalled();
  });

  it("opens one on request even with a password saved", async () => {
    await signIn(config(), { visible: true });
    expect(requestVisibleBrowser).toHaveBeenCalledOnce();
  });

  it("refuses visible false with no password instead of waiting out a doomed sign-in", async () => {
    const { text, isError } = await signIn(config({ password: undefined }), { visible: false });
    expect(run).not.toHaveBeenCalled();
    expect(isError).toBe(true);
    expect(text).toMatch(/no password is saved/i);
    expect(text).toMatch(/visible true/i);
  });

  // Purdue's passwordless mode keeps no password but signs in without a
  // window (the user approves on their phone), so it must not be treated as
  // having nothing to sign in with.
  const purduePasswordless = () =>
    config({ baseUrl: "https://purdue.brightspace.com", password: undefined, passwordless: true });

  it("stays in the background for a passwordless account", async () => {
    await signIn(purduePasswordless());
    expect(requestVisibleBrowser).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });

  it("signs a passwordless account in with visible false instead of refusing", async () => {
    const { isError, text } = await signIn(purduePasswordless(), { visible: false });
    expect(run).toHaveBeenCalledOnce();
    expect(isError).toBe(false);
    expect(text).not.toMatch(/no password is saved/i);
  });

  it("opens one when a password is saved but no username is, which a windowless sign-in cannot use", async () => {
    await signIn(config({ username: undefined }));
    expect(requestVisibleBrowser).toHaveBeenCalledOnce();
  });

  it("promises no window it cannot deliver when a sign-in is already running", async () => {
    busy.mockReturnValue(true);
    const { text } = await signIn(config(), { visible: true }, fail("inProgress"));
    expect(requestVisibleBrowser).not.toHaveBeenCalled();
    // No window was promised, so the answer is the plain shared guidance.
    expect(text).not.toMatch(/window is opening/i);
    expect(text).toBe(authPendingNotice(new AuthProcessError("inProgress", "raw message")));
  });
});

describe("sign_in failure answers come from the shared guidance", () => {
  /**
   * Not re-asserted word for word here: that wording belongs to
   * authPendingNotice, beside AUTH_FAILURE_GUIDANCE, and a copy of it in this
   * file is exactly the second source of truth the tool was rewritten to
   * avoid. What matters is that sign_in delegates, including the dynamic MFA
   * number, and does not paraphrase.
   */
  it.each([
    "cooldown", "mfaHeld", "transport", "secureStorage", "browserInstall",
    "unsupported", "timeout", "failed", "cancelled", "busy", "inProgress",
    "dependencyMissing", "automaticPending",
  ] as const)("hands over the guidance for %s verbatim", async (kind) => {
    const error = new AuthProcessError(kind, "raw message");
    const { text } = await signIn(config(), {}, fail(kind));
    expect(text).toBe(authPendingNotice(error));
  });

  it("carries the number to approve, as the shared guidance formats it", async () => {
    const error = new AuthProcessError("mfaPending", "waiting", "42");
    const { text, isError } = await signIn(config(), {}, fail("mfaPending", "waiting", "42"));
    expect(text).toBe(authPendingNotice(error));
    expect(text).toContain("42");
    // A prompt awaiting approval is progress: isError would invite a model to
    // give up rather than call again.
    expect(isError).toBe(false);
  });

  it.each(["mfaPending", "automaticPending", "inProgress"] as const)("does not flag %s as an error", async (kind) => {
    const { isError } = await signIn(config(), {}, fail(kind));
    expect(isError).toBe(false);
  });

  it.each(["cooldown", "transport", "failed", "secureStorage"] as const)("flags %s as an error", async (kind) => {
    const { isError } = await signIn(config(), {}, fail(kind));
    expect(isError).toBe(true);
  });

  it("says a window is open before the guidance, when it opened one", async () => {
    const error = new AuthProcessError("mfaPending", "waiting", "7");
    const { text } = await signIn(config({ password: undefined }), {}, fail("mfaPending", "waiting", "7"));
    expect(text).toMatch(/^A browser window is opening/);
    expect(text).toContain(authPendingNotice(error));
  });

  it("sends an unexpected error through the house path instead of inventing wording", async () => {
    const authRunner = { run: vi.fn().mockRejectedValue(new Error("disk on fire")), busy, requestVisibleBrowser } as any;
    const { text, isError } = await signIn(config(), {}, authRunner);
    expect(isError).toBe(true);
    // sanitizeError's contract: no stack traces, no raw internals.
    expect(text).not.toContain("disk on fire");
  });
});

describe("sign_in when this server cannot sign in", () => {
  it("says a pasted credential is the user's to refresh", async () => {
    const { text } = await signIn(config({ envAccessToken: "pasted" }));
    expect(run).not.toHaveBeenCalled();
    expect(text).toMatch(/D2L_ACCESS_TOKEN/);
  });

  it("points at the terminal when there is no runner", async () => {
    // Registered with no runner at all, as server.ts does when the server
    // authenticates from a pasted credential.
    const server = new McpServer({ name: "sign-in-test", version: "1" });
    acceptOmittedArguments(server);
    registerSignIn(server, config(), { getToken, isValid } as any);
    const client = new Client({ name: "sign-in-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "sign_in", arguments: {} });
      const blocks = result.content as Array<{ type: string; text: string }>;
      // The command it names must be one the shipped CLI accepts.
      expect(blocks[0].text).toMatch(/auth`/);
      expect(blocks[0].text).toMatch(/D2L_HEADLESS=false/);
      expect(blocks[0].text).not.toMatch(/--browser/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
