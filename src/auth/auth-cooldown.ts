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
    const status = JSON.parse(content) as { retryAt?: number };
    if (typeof status.retryAt === "number" && status.retryAt > Date.now()) throw new AuthenticationCooldownError(status.retryAt);
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
