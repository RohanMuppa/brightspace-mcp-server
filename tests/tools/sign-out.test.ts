import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { acquireProcessLock } from "../../src/auth/auth-lock.js";
import { authLockPath } from "../../src/auth/mfa-challenge.js";
import { clearSavedSession, RemoveError } from "../../src/auth/logout.js";
import { registerSignOut } from "../../src/tools/sign-out.js";
import { acceptOmittedArguments } from "../../src/tools/omitted-arguments.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * sign_out is `auth --logout` for a chat window: it deletes this computer's
 * saved session for the configured account and empties the API client's
 * cache. Every test points it at a temporary session directory.
 */

const SESSION_FILES = ["session.json", "storage-state.encrypted.json", "microsoft-session.json"];

let dir: string;
let clearCache: ReturnType<typeof vi.fn>;
let forgetSession: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sign-out-test-"));
  clearCache = vi.fn();
  forgetSession = vi.fn();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  baseUrl: "https://school.example",
  sessionDir: dir,
  tokenTtl: 3600,
  headless: true,
  username: "student42",
  password: "hunter2-secret",
  courseFilter: { activeOnly: true },
  ...overrides,
});

async function seed(files = SESSION_FILES): Promise<void> {
  for (const name of files) await fs.writeFile(path.join(dir, name), `${name} contents`);
}

const exists = (file: string) => fs.access(path.join(dir, file)).then(() => true, () => false);

type Clear = Parameters<typeof registerSignOut>[5];
type Runner = { cancel(): Promise<boolean> };
type StopElsewhere = Parameters<typeof registerSignOut>[6];

async function connect(appConfig: AppConfig, clear?: Clear, authRunner?: Runner, stopElsewhere?: StopElsewhere) {
  const server = new McpServer({ name: "sign-out-test", version: "1" });
  acceptOmittedArguments(server); // as src/index.ts does: this test calls sign_out without an arguments field
  registerSignOut(server, appConfig, { clearCache } as any, { forgetSession }, authRunner, clear, stopElsewhere);
  const client = new Client({ name: "sign-out-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function signOut(appConfig: AppConfig, clear?: Clear, authRunner?: Runner, stopElsewhere?: StopElsewhere) {
  const { client, close } = await connect(appConfig, clear, authRunner, stopElsewhere);
  try {
    const result = await client.callTool({ name: "sign_out" });
    const blocks = result.content as Array<{ type: string; text: string }>;
    return { text: blocks[0].text, isError: result.isError === true };
  } finally {
    await close();
  }
}

describe("sign_out registration", () => {
  it("is listed with a title, an empty input schema, and destructive, non-read-only annotations", async () => {
    const { client, close } = await connect(config());
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "sign_out")!;
      expect(tool).toBeDefined();
      expect(tool.title).toBe("Sign Out of Brightspace");
      expect(tool.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.inputSchema.properties ?? {}).toEqual({});
    } finally {
      await close();
    }
  });

  it("tells the model to call it only when the user explicitly asks", async () => {
    const { client, close } = await connect(config());
    try {
      const { tools } = await client.listTools();
      const description = tools.find((entry) => entry.name === "sign_out")!.description!;
      expect(description).toMatch(/only when the user explicitly asks/i);
      expect(description).toMatch(/never call it on your own to fix an error/i);
      // Cancelling cannot get a new prompt sooner: Microsoft holds the account's
      // MFA until the earlier prompt expires (seen live, 2026-10-25).
      expect(description).toMatch(/doesn't get a new prompt sooner/);
      expect(description).not.toMatch(/get a new prompt now|starts a new sign-in right away/);
      expect(description).toMatch(/sign in again from scratch/);
      expect(description).not.toMatch(/with MFA/);
    } finally {
      await close();
    }
  });
});

describe("sign_out", () => {
  it("deletes the saved session and says what was kept, who else is signed out, and what the next sign-in looks like", async () => {
    await seed();
    const { text, isError } = await signOut(config());

    expect(isError).toBe(false);
    expect(text).toContain("Signed out of Brightspace on this computer.");
    expect(text).toContain("Removed: session.json, storage-state.encrypted.json, microsoft-session.json");
    expect(text).toContain(
      "Kept (if you set them up): your saved password, your settings, and your authenticator key."
    );
    expect(text).toContain(
      "Other Brightspace apps open on this computer are signed out too and will sign in again from scratch on their next question."
    );
    expect(text).toContain("may keep answering for up to an hour; quit and reopen it to sign it out right away.");
    expect(text).toMatch(/that next sign-in may just ask you to approve it, or finish on its own if you saved an authenticator key/);
    expect(text).toMatch(/On a shared computer, also delete the saved "brightspace-mcp-server" entries/);
    expect(text).toMatch(/does not sign you out of Microsoft or Brightspace on other devices/);
    expect(text).not.toMatch(/MFA/);
    for (const name of SESSION_FILES) expect(await exists(name)).toBe(false);
  });

  it("is plain text, not JSON", async () => {
    await seed();
    const { text } = await signOut(config());
    expect(() => JSON.parse(text)).toThrow();
  });

  it("clears the API client's cache", async () => {
    await seed();
    await signOut(config());
    expect(clearCache).toHaveBeenCalledTimes(1);
  });

  it("drops this process's in-memory token after clearing", async () => {
    await seed();
    await signOut(config());
    expect(forgetSession).toHaveBeenCalledTimes(1);
  });

  it("leaves other files in the session directory alone", async () => {
    await seed();
    await fs.writeFile(path.join(dir, "mfa-cooldown.json"), "keep me");
    await signOut(config());
    expect(await exists("mfa-cooldown.json")).toBe(true);
  });

  it("says there was no saved session when there is nothing to clear, and is not an error", async () => {
    await fs.mkdir(dir, { recursive: true });
    const { text, isError } = await signOut(config());

    expect(isError).toBe(false);
    expect(text).toBe(
      "You're already signed out of Brightspace on this computer; there was no saved session to remove."
    );
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(forgetSession).toHaveBeenCalledTimes(1);
  });

  it("says there was no saved session when the session directory does not exist", async () => {
    const { text, isError } = await signOut(config({ sessionDir: path.join(dir, "missing") }));
    expect(isError).toBe(false);
    expect(text).toMatch(/already signed out/);
  });

  it("deletes nothing and tells the model not to retry when a sign-in it can't cancel holds the lock, without an error flag", async () => {
    await seed();
    const release = await acquireProcessLock(authLockPath(dir));
    try {
      const { text, isError } = await signOut(config());

      expect(isError).toBe(false);
      expect(text).toBe(
        "Not signed out: a sign-in that sign_out can't cancel is in progress on this computer (one started in a terminal with `auth`, for example), so nothing was deleted and it was left running. Tell the user to finish or close that sign-in, then ask again; do not call sign_out again on your own."
      );
    } finally {
      await release();
    }
    for (const name of SESSION_FILES) expect(await exists(name)).toBe(true);
    expect(clearCache).not.toHaveBeenCalled();
    expect(forgetSession).not.toHaveBeenCalled();
  });

  it("cancels this server's waiting sign-in before deleting, and says how long a new prompt can take", async () => {
    await seed();
    const order: string[] = [];
    const cancel = vi.fn(async () => { order.push("cancel"); return true; });
    const clear = vi.fn(async (sessionDir: string) => { order.push("clear"); return clearSavedSession(sessionDir); });
    const { text, isError } = await signOut(config(), clear, { cancel }, async () => false);

    expect(isError).toBe(false);
    expect(order).toEqual(["cancel", "clear"]);
    expect(text).toMatch(/^Cancelled the Brightspace sign-in that was waiting for approval, so the prompt or number from it no longer works\.\nSigned out of Brightspace on this computer\./);
    expect(text).toContain("Microsoft keeps that prompt open for up to 5 minutes after sending it");
    expect(text).not.toContain("starts a new sign-in right away");
    for (const name of SESSION_FILES) expect(await exists(name)).toBe(false);
  });

  it("reports a cancel even when there was no saved session to remove", async () => {
    const { text } = await signOut(config(), async () => ({ removed: [] }), { cancel: async () => false }, async () => true);

    expect(text).toBe(
      "Cancelled the Brightspace sign-in that was waiting for approval, so the prompt or number from it no longer works.\n" +
      "There was no saved session to remove.\n" +
      "Microsoft keeps that prompt open for up to 5 minutes after sending it and sends this account no other until then, so the next Brightspace question can take that long to show a new number to approve."
    );
  });

  it("signs out normally when no sign-in is running", async () => {
    await seed();
    const { text } = await signOut(config(), undefined, { cancel: async () => false }, async () => false);
    expect(text).toMatch(/^Signed out of Brightspace on this computer\./);
    expect(text).not.toContain("Cancelled");
    for (const name of SESSION_FILES) expect(await exists(name)).toBe(false);
  });

  // The PID in owner.json comes from a file: a process that is not this
  // package's sign-in child (here, the test runner itself) must never be killed.
  it("leaves an automatic lock owner alone unless it is a sign-in child, and deletes nothing", async () => {
    await seed();
    await fs.mkdir(authLockPath(dir), { recursive: true });
    await fs.writeFile(path.join(authLockPath(dir), "owner.json"), JSON.stringify({ pid: process.pid, host: "h", nonce: "n", mode: "automatic" }));
    const { text, isError } = await signOut(config());

    expect(isError).toBe(false);
    expect(text).toMatch(/^Not signed out: a sign-in that sign_out can't cancel is in progress/);
    for (const name of SESSION_FILES) expect(await exists(name)).toBe(true);
  });

  it.each([
    ["D2L_ACCESS_TOKEN", { envAccessToken: "pasted-token" }],
    ["D2L_SESSION_COOKIE", { envSessionCookie: "d2lSessionVal=a; d2lSecureSessionVal=b" }],
  ])("deletes nothing and says it cannot remove a credential from configuration (%s)", async (_name, env) => {
    await seed();
    const { text, isError } = await signOut(config(env as Partial<AppConfig>));

    expect(isError).toBe(false);
    expect(text).toMatch(/Nothing was signed out/);
    expect(text).toMatch(/credential from its configuration/);
    expect(text).toMatch(/sign_out cannot remove that/);
    expect(text).toMatch(/client configuration or a \.env file/);
    expect(text).toMatch(/remove that setting and restart the app/);
    expect(text).not.toContain("pasted-token");
    for (const name of SESSION_FILES) expect(await exists(name)).toBe(true);
    expect(clearCache).not.toHaveBeenCalled();
    expect(forgetSession).not.toHaveBeenCalled();
  });

  it("reports an incomplete sign-out naming the file when one cannot be deleted", async () => {
    // A directory where a file belongs cannot be unlinked.
    await fs.mkdir(path.join(dir, "storage-state.encrypted.json"));
    await fs.writeFile(path.join(dir, "session.json"), "x");

    const { text, isError } = await signOut(config());

    expect(isError).toBe(true);
    expect(text).toMatch(/^Sign-out is incomplete: storage-state\.encrypted\.json could not be deleted/);
    expect(text).toMatch(/ask to sign out again to finish/);
    expect(text).not.toContain(dir);
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(forgetSession).toHaveBeenCalledTimes(1);
  });

  it("gives the same incomplete guidance when session.json itself cannot be deleted", async () => {
    // A non-empty directory where the file belongs cannot be unlinked, on any platform.
    await fs.mkdir(path.join(dir, "session.json"));
    await fs.writeFile(path.join(dir, "session.json", "inner"), "x");

    const { text, isError } = await signOut(config());

    expect(isError).toBe(true);
    expect(text).toMatch(/^Sign-out is incomplete: session\.json could not be deleted/);
    expect(text).not.toContain("Could not clear the saved session");
    expect(text).not.toContain(dir);
  });

  it("reports the file from a RemoveError without leaking the underlying cause", async () => {
    const { text, isError } = await signOut(config(), async () => {
      throw new RemoveError("session.json", new Error(`EPERM: unlink '${dir}/session.json'`));
    });
    expect(isError).toBe(true);
    expect(text).toContain("session.json could not be deleted");
    expect(text).not.toContain("EPERM");
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(forgetSession).toHaveBeenCalledTimes(1);
  });

  it("reports an unexpected failure as a fixed error text that leaks neither the message nor a path", async () => {
    const { text, isError } = await signOut(config(), async () => {
      throw new Error(`disk exploded at ${dir}/session.json`);
    });
    expect(isError).toBe(true);
    expect(text).toBe(
      "Could not clear the saved session because of an unexpected error. Nothing more was changed; try again, or run `npx -y brightspace-mcp-server@latest auth --logout` in a terminal to see the details."
    );
    expect(text).not.toContain("disk exploded");
    expect(text).not.toContain(dir);
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(forgetSession).toHaveBeenCalledTimes(1);
  });

  it("does not touch the real home directory: it only ever uses the configured session directory", async () => {
    const clear = vi.fn(async () => ({ removed: [] as string[] }));
    await signOut(config(), clear);
    expect(clear).toHaveBeenCalledWith(dir);
  });
});
