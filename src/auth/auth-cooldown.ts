import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { AUTH_COMMAND } from "../utils/commands.js";

/**
 * How long automatic sign-in pauses after a missed MFA prompt.
 *
 * Long enough to stop a hot loop of phone prompts, short enough that tapping
 * the wrong number costs a coffee break rather than an afternoon. This was
 * four hours, which meant one mistyped number disabled background sign-in
 * until dinner, with nothing on screen explaining why.
 */
export const MFA_COOLDOWN_MS = 5 * 60 * 1000;

export class AuthenticationCooldownError extends Error {
  readonly code = "AUTH_COOLDOWN";
  constructor(public readonly retryAt: number) {
    // Say it the way a person would. A timestamp tells someone staring at a
    // stalled chat window nothing they can act on.
    const minutes = Math.max(1, Math.ceil((retryAt - Date.now()) / 60000));
    super(
      `The last sign-in prompt was not approved, so automatic sign-in is paused for ${minutes} more minute${minutes === 1 ? "" : "s"}. ` +
      `To sign in right now, run this in a terminal: ${AUTH_COMMAND}`
    );
    this.name = "AuthenticationCooldownError";
  }
}

/** The recorded retry time, or undefined when the file says nothing usable. */
function readRetryAt(content: string): number | undefined {
  let status: unknown;
  try {
    status = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof status !== "object" || status === null || Array.isArray(status)) return undefined;
  const retryAt = (status as { retryAt?: unknown }).retryAt;
  return typeof retryAt === "number" && Number.isFinite(retryAt) ? retryAt : undefined;
}

/** Non-secret retry metadata. Call only while holding the authentication lock. */
export class AuthCooldown {
  private readonly file: string;
  constructor(sessionDir: string) {
    this.file = path.join(sessionDir, "auth-status.json");
  }

  async assertAllowed(): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const retryAt = readRetryAt(content);
    if (retryAt === undefined) {
      // This file is non-secret retry metadata, and only a readable retryAt is
      // evidence of anything. A truncated or non-object file used to throw out
      // of here, which runs before the sign-in attempt — and the automatic path
      // only clears the file after a sign-in that then never started. One
      // damaged file disabled background sign-in for good, with nothing on
      // screen naming the cause. Discard it and let this attempt proceed.
      await fs.unlink(this.file).catch(() => {});
      return;
    }
    if (retryAt > Date.now()) throw new AuthenticationCooldownError(retryAt);
  }

  async recordMfaFailure(): Promise<void> {
    await this.write({ retryAt: Date.now() + MFA_COOLDOWN_MS });
  }

  async clear(): Promise<void> {
    await this.write({ retryAt: 0 });
  }

  private async write(status: { retryAt: number }): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(status), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, this.file);
  }
}
