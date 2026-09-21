import { afterEach, describe, expect, it, vi } from "vitest";
import { DuoMfaHandler, isDuoPrompt } from "../../src/auth/duo-mfa.js";
import { AUTH_COMMAND } from "../../src/utils/commands.js";

interface DuoPageOptions {
  url?: string;
  verificationCode?: string;
  passcode?: boolean;
  verifyButton?: boolean;
}

function makePage(options: DuoPageOptions = {}) {
  const fill = vi.fn(async () => {});
  const click = vi.fn(async () => {});
  const press = vi.fn(async () => {});
  const page = {
    url: vi.fn(() => options.url ?? "https://api-123.duosecurity.com/frame/v4/auth"),
    getByText: vi.fn(() => ({ first: () => ({
      isVisible: async () => Boolean(options.verificationCode),
      textContent: async () => options.verificationCode ?? null,
    }) })),
    getByRole: vi.fn((role: string) => ({ first: () => ({
      isVisible: async () => role === "textbox" ? Boolean(options.passcode) : options.verifyButton !== false,
      fill,
      click,
      press,
    }) })),
  };
  return { page, fill, click, press };
}

function captureWarnings() {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.includes("[WARN]")) lines.push(first);
  });
  return lines;
}

describe("DuoMfaHandler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("recognizes Duo prompts without trusting lookalike hosts", () => {
    expect(isDuoPrompt(makePage().page as never)).toBe(true);
    const lookalike = makePage({ url: "https://duosecurity.com.example.org/auth" });
    expect(isDuoPrompt(lookalike.page as never)).toBe(false);
  });

  it("announces approval and a verified-push code once", async () => {
    const lines = captureWarnings();
    const { page } = makePage({ verificationCode: "1234" });
    const handler = new DuoMfaHandler({});

    await handler.handle(page as never);
    await handler.handle(page as never);

    expect(lines.filter(line => line.includes("Duo MFA approval"))).toHaveLength(1);
    expect(lines.filter(line => line.includes("Duo verification code: 1234"))).toHaveLength(1);
  });

  it("submits a passcode once through the terminal callback", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, fill, click } = makePage({ passcode: true });
    const handler = new DuoMfaHandler({ requestMfaCode });

    await handler.handle(page as never);
    await handler.handle(page as never);

    expect(requestMfaCode).toHaveBeenCalledOnce();
    expect(fill).toHaveBeenCalledWith("123456");
    expect(click).toHaveBeenCalledOnce();
  });

  it("directs non-interactive passcode entry to the auth CLI", async () => {
    const { page } = makePage({ passcode: true });
    await expect(new DuoMfaHandler({}).handle(page as never)).rejects.toThrow(`Run \`${AUTH_COMMAND}\``);
  });

  it("leaves passcode entry to a visible browser", async () => {
    const { page, fill } = makePage({ passcode: true });
    await new DuoMfaHandler({ headless: false }).handle(page as never);
    expect(fill).not.toHaveBeenCalled();
  });
});
