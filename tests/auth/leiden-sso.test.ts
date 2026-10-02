import { describe, expect, it, vi } from "vitest";
import { createSSOFlow, UnsupportedAuthenticationError } from "../../src/auth/sso-flow.js";
import { LEIDEN_ENTRA_ENTITY_ID, LeidenSSOFlow, isLeidenBrightspace } from "../../src/auth/leiden-sso.js";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";
import type { AppConfig } from "../../src/types/index.js";

const LEIDEN_URL = "https://brightspace.universiteitleiden.nl";
const WAYF = "https://engine.surfconext.nl/authentication/idp/single-sign-on/key:20230503?SAMLRequest=fixture";
const LEIDEN_ENTRY = `.wayf__idp[data-entityid="${LEIDEN_ENTRA_ENTITY_ID}"]`;

function fixture(url: string, visible: string[]) {
  const clicks: string[] = [];
  const page = {
    url: () => url,
    locator: vi.fn((selector: string) => ({ first: () => ({
      isVisible: async () => visible.includes(selector),
      click: async () => { clicks.push(selector); },
    }) })),
  };
  return { page, clicks };
}

describe("Leiden sign-in entry point", () => {
  it("routes only Leiden's exact Brightspace host to its handler", () => {
    expect(isLeidenBrightspace(LEIDEN_URL)).toBe(true);
    expect(isLeidenBrightspace(`${LEIDEN_URL}.example.org`)).toBe(false);
    expect(isLeidenBrightspace("not a url")).toBe(false);
    expect(createSSOFlow({ baseUrl: LEIDEN_URL } as AppConfig)).toBeInstanceOf(LeidenSSOFlow);
  });

  it("picks the Leiden Entra account on the SURFconext picker", async () => {
    const { page, clicks } = fixture(WAYF, ["#wayf_search", LEIDEN_ENTRY]);
    await new LeidenSSOFlow({ baseUrl: LEIDEN_URL }).selectIdentityProvider(page as never);
    expect(clicks).toEqual([LEIDEN_ENTRY]);
  });

  it("leaves pages other than the picker alone", async () => {
    for (const url of [
      "https://login.microsoftonline.com/ca2a7f76-dbd7-4ec0-9108-6b3d524fb7c8/saml2",
      "http://engine.surfconext.nl/authentication/idp/single-sign-on",
      "https://engine.surfconext.nl.example.org/authentication/idp/single-sign-on",
      `${LEIDEN_URL}/d2l/home`,
    ]) {
      const { page, clicks } = fixture(url, ["#wayf_search", LEIDEN_ENTRY]);
      await new LeidenSSOFlow({ baseUrl: LEIDEN_URL }).selectIdentityProvider(page as never);
      expect(clicks).toEqual([]);
    }
  });

  it("does nothing on the SURFconext redirect back to Brightspace", async () => {
    const { page, clicks } = fixture("https://engine.surfconext.nl/authentication/sp/consume-assertion", []);
    await new LeidenSSOFlow({ baseUrl: LEIDEN_URL }).selectIdentityProvider(page as never);
    expect(clicks).toEqual([]);
  });

  it("fails clearly when SURFconext stops offering the Leiden account", async () => {
    const { page, clicks } = fixture(WAYF, ["#wayf_search"]);
    await expect(new LeidenSSOFlow({ baseUrl: LEIDEN_URL }).selectIdentityProvider(page as never))
      .rejects.toBeInstanceOf(UnsupportedAuthenticationError);
    expect(clicks).toEqual([]);
  });

  it("hands the Microsoft sign-in to the shared flow", async () => {
    const login = vi.spyOn(PurdueSSOFlow.prototype, "login").mockResolvedValue(true);
    const { page, clicks } = fixture(WAYF, ["#wayf_search", LEIDEN_ENTRY]);
    await expect(new LeidenSSOFlow({ baseUrl: LEIDEN_URL, username: "u", password: "p" }).login(page as never)).resolves.toBe(true);
    expect(clicks).toEqual([LEIDEN_ENTRY]);
    expect(login).toHaveBeenCalledOnce();
    login.mockRestore();
  });
});
