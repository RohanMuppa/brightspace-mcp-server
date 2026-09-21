import { describe, expect, it, vi } from "vitest";
import { createSSOFlow } from "../../src/auth/sso-flow.js";
import { WesternSSOFlow, isWesternBrightspace } from "../../src/auth/western-sso.js";
import type { AppConfig } from "../../src/types/index.js";

const WESTERN_URL = "https://westernu.brightspace.com";

describe("Western sign-in entry point", () => {
  it("routes only Western's exact Brightspace host to its handler", () => {
    expect(isWesternBrightspace(WESTERN_URL)).toBe(true);
    expect(isWesternBrightspace(`${WESTERN_URL}.example.org`)).toBe(false);
    expect(createSSOFlow({ baseUrl: WESTERN_URL } as AppConfig)).toBeInstanceOf(WesternSSOFlow);
  });

  it("selects Western's button before the inherited sign-in flow", async () => {
    const click = vi.fn(async () => {});
    const page = {
      url: () => `${WESTERN_URL}/d2l/login`,
      getByRole: vi.fn(() => ({ first: () => ({ isVisible: async () => true, click }) })),
    };
    await new WesternSSOFlow({ baseUrl: WESTERN_URL }).prepareLogin(page as never);
    expect(page.getByRole).toHaveBeenCalledWith("button", { name: "Log in with your Western account" });
    expect(click).toHaveBeenCalledOnce();
  });

  it("does not select a Western button after leaving the login page", async () => {
    const page = { url: () => "https://login.microsoftonline.com/common/login", getByRole: vi.fn() };
    await new WesternSSOFlow({ baseUrl: WESTERN_URL }).prepareLogin(page as never);
    expect(page.getByRole).not.toHaveBeenCalled();
  });
});
