import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authLockPath } from "../../src/auth/mfa-challenge.js";

const stopAutomaticSignIn = vi.fn(async (_lockPath: string) => false);
vi.mock("../../src/auth/auth-runner.js", () => ({ stopAutomaticSignIn: (lockPath: string) => stopAutomaticSignIn(lockPath) }));
const { runLogout } = await import("../../src/auth/logout.js");

// Without an injected stopBackground, logout must ask the real cross-app stop
// about this session's own lock, before it deletes anything.
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "logout-default-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it("asks stopAutomaticSignIn about this session's lock by default", async () => {
  await fs.writeFile(path.join(dir, "session.json"), "x");
  expect(await runLogout({ sessionDir: dir, print: () => {} })).toBe(0);
  expect(stopAutomaticSignIn).toHaveBeenCalledWith(authLockPath(dir));
});
