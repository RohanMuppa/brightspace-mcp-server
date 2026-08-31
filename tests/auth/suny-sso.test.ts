import { describe, it, expect, vi } from "vitest";
import { SunySSOFlow, isSunyBrightspace } from "../../src/auth/suny-sso.js";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";
import { createSSOFlow } from "../../src/auth/sso-flow.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * SUNY campuses share one Brightspace tenant behind one Shibboleth IdP, so a
 * campus has to be chosen at idm.suny.edu before the campus sign-in form
 * appears. The configured campus is resolved against SUNY's own dropdown
 * rather than a copy of the campus table kept here, so the list cannot go
 * stale. Codes and labels below are the real ones SUNY serves.
 */

const SUNY_URL = "https://mylearning.suny.edu";
const IDM_URL = "https://idm.suny.edu/security/login/loginForm.do";

const CAMPUS_OPTIONS: Array<[string, string]> = [
  ["", "Select Campus..."],
  ["28010", "Albany"],
  ["28260", "Purchase"],
  ["28270", "SUNY Poly"],
];

function makePage(url: string, options: Array<[string, string]> | null = CAMPUS_OPTIONS) {
  return {
    url: vi.fn(() => url),
    goto: vi.fn(async () => null),
    waitForSelector: vi.fn(async () => {
      if (!options) throw new Error("Timeout waiting for campus dropdown");
      return {};
    }),
    $$eval: vi.fn(async (_selector: string, fn: (nodes: unknown[]) => unknown) =>
      fn((options ?? []).map(([value, label]) => ({ value, textContent: label }))),
    ),
    selectOption: vi.fn(async () => []),
    click: vi.fn(async () => {}),
  };
}

const selectCampus = (flow: SunySSOFlow, page: unknown): Promise<void> =>
  (flow as any).selectCampus(page);
const startSamlLogin = (flow: SunySSOFlow, page: unknown): Promise<void> =>
  (flow as any).startSamlLogin(page);

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: SUNY_URL,
    sessionDir: "/tmp/does-not-matter",
    tokenTtl: 3600,
    headless: true,
    courseFilter: {} as AppConfig["courseFilter"],
    ...overrides,
  };
}

describe("isSunyBrightspace", () => {
  it("matches the shared SUNY host exactly", () => {
    expect(isSunyBrightspace(SUNY_URL)).toBe(true);
    expect(isSunyBrightspace("https://mylearning.suny.edu/d2l/home")).toBe(true);
  });

  it("does not match other schools or lookalike hosts", () => {
    expect(isSunyBrightspace("https://purdue.brightspace.com")).toBe(false);
    // A substring check would wrongly accept this one.
    expect(isSunyBrightspace("https://mylearning.suny.edu.example.com")).toBe(false);
    expect(isSunyBrightspace("not a url")).toBe(false);
  });
});

describe("createSSOFlow", () => {
  it("routes the shared SUNY instance to the SUNY flow", () => {
    expect(createSSOFlow(makeConfig())).toBeInstanceOf(SunySSOFlow);
  });

  it("leaves every other school on the default flow", () => {
    const config = makeConfig({ baseUrl: "https://purdue.brightspace.com" });
    expect(createSSOFlow(config)).toBeInstanceOf(PurdueSSOFlow);
  });
});

describe("SunySSOFlow.selectCampus", () => {
  it.each([
    ["exact name", "SUNY Poly", "28270"],
    ["numeric code", "28270", "28270"],
    ["different casing", "suny poly", "28270"],
    ["name prefix", "Alb", "28010"],
  ])("resolves a campus by %s", async (_label, configured, expected) => {
    const page = makePage(IDM_URL);
    const flow = new SunySSOFlow({ campus: configured });

    await selectCampus(flow, page);

    expect(page.selectOption).toHaveBeenCalledWith("select#campus", expected);
    expect(page.click).toHaveBeenCalledOnce();
  });

  it("leaves the page alone when no campus is configured", async () => {
    const page = makePage(IDM_URL);
    const flow = new SunySSOFlow({});

    await selectCampus(flow, page);

    expect(page.selectOption).not.toHaveBeenCalled();
    expect(page.click).not.toHaveBeenCalled();
  });

  it("leaves the page alone when the configured campus matches nothing", async () => {
    const page = makePage(IDM_URL);
    const flow = new SunySSOFlow({ campus: "Nowhere University" });

    await selectCampus(flow, page);

    expect(page.selectOption).not.toHaveBeenCalled();
  });

  it("never selects the placeholder option", async () => {
    const page = makePage(IDM_URL);
    const flow = new SunySSOFlow({ campus: "Select Campus..." });

    await selectCampus(flow, page);

    expect(page.selectOption).not.toHaveBeenCalled();
  });

  it("skips the dropdown entirely away from SUNY's identity provider", async () => {
    const page = makePage("https://login.microsoftonline.com/common/oauth2/authorize");
    const flow = new SunySSOFlow({ campus: "SUNY Poly" });

    await selectCampus(flow, page);

    expect(page.waitForSelector).not.toHaveBeenCalled();
  });

  it("is not fooled by SUNY's own host inside a redirect parameter", async () => {
    // Once the campus is remembered, Microsoft's URL still carries an
    // idm.suny.edu return address; a substring check would wait here for a
    // dropdown that is never coming.
    const page = makePage(
      "https://login.microsoftonline.com/common/login?redirectUrl=https%3A%2F%2Fidm.suny.edu%2Fidp",
    );
    const flow = new SunySSOFlow({ campus: "SUNY Poly" });

    await selectCampus(flow, page);

    expect(page.waitForSelector).not.toHaveBeenCalled();
  });

  it("continues to the sign-in form when the campus was already remembered", async () => {
    const page = makePage(IDM_URL, null);
    const flow = new SunySSOFlow({ campus: "SUNY Poly" });

    await expect(selectCampus(flow, page)).resolves.toBeUndefined();
    expect(page.selectOption).not.toHaveBeenCalled();
  });
});

describe("SunySSOFlow.startSamlLogin", () => {
  it("bypasses the shadow-DOM campus selector via SUNY's SAML endpoint", async () => {
    const page = makePage(`${SUNY_URL}/d2l/login?target=%2fd2l%2fhome`);
    const flow = new SunySSOFlow({});

    await startSamlLogin(flow, page);

    expect(page.goto).toHaveBeenCalledWith(
      `${SUNY_URL}/d2l/lp/auth/saml/initiate-login?entityId=https://idm.suny.edu/shibboleth/idp/`,
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
  });

  it("does not re-navigate once past the selector", async () => {
    const page = makePage("https://login.microsoftonline.com/common/oauth2/authorize");
    const flow = new SunySSOFlow({});

    await startSamlLogin(flow, page);

    expect(page.goto).not.toHaveBeenCalled();
  });
});
