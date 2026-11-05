import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { createSSOFlow } from "../../src/auth/sso-flow.js";
import { MunSSOFlow, isMunBrightspace } from "../../src/auth/mun-sso.js";
import type { AppConfig } from "../../src/types/index.js";

const MUN_URL = "https://online.mun.ca";
const CAS_URL = "https://login.mun.ca/cas/login";
const USER = "test-user";
const SECRET = "test-password";

const html = (route: Route, body: string, headers: Record<string, string> = {}) =>
  route.fulfill({ contentType: "text/html", headers, body: `<!doctype html><html><body>${body}</body></html>` });

// Copies of MUN's real controls, recorded from the live pages on 2026-11-05.
const LANDING = `<a id="mun-login" href="/d2l/custom/cas">MUN Login</a>
  <form hidden><input id="userName" name="userName"><input id="password" name="password" type="password"></form>`;
const CAS_FORM = `<form method="post"><input id="username" name="username" type="text">
  <input id="password" name="password" type="password"><button name="submitBtn" type="submit">LOG IN</button></form>`;
const HOME = `<script>window.D2L = { LP: {} };</script>Home`;

// A fulfilled HTTP redirect leaves the route handler and would reach the real
// site, so these copies redirect by script and every request stays intercepted.
const redirect = (route: Route, to: string) => html(route, `<script>location.replace(${JSON.stringify(to)});</script>`);

describe("MUN flow routing", () => {
  it("picks the MUN flow only for MUN's exact Brightspace host", () => {
    expect(isMunBrightspace(MUN_URL)).toBe(true);
    expect(isMunBrightspace(`${MUN_URL}.example.com`)).toBe(false);
    expect(createSSOFlow({ baseUrl: MUN_URL } as AppConfig)).toBeInstanceOf(MunSSOFlow);
  });
});

// Same switch as browser-live.test.ts: CI installs with --ignore-scripts, so it has no Chromium.
describe.runIf(process.env.BRIGHTSPACE_TEST_BROWSER === "1")("MUN sign-in against copies of its pages", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let casPosts: string[];

  const flow = () => new MunSSOFlow({ baseUrl: MUN_URL, username: USER, password: SECRET, headless: true });

  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser.close(); });

  beforeEach(async () => {
    casPosts = [];
    context = await browser.newContext();
    page = await context.newPage();
    await context.route("**/*", (route) => route.abort());
    await context.route(`${MUN_URL}/d2l/loginh/`, (route) => html(route, LANDING));
    await context.route(`${MUN_URL}/d2l/custom/cas`, (route) => redirect(route, CAS_URL));
    await context.route(`${MUN_URL}/d2l/home`, (route) =>
      html(route, HOME, { "set-cookie": "d2lSessionVal=x; Path=/; Secure" }));
    await context.route(CAS_URL, (route) => {
      if (route.request().method() !== "POST") return html(route, CAS_FORM);
      casPosts.push(route.request().postData() ?? "");
      return redirect(route, `${MUN_URL}/d2l/home`);
    });
  });
  afterEach(async () => { await context.close(); });

  it("clicks the MUN Login button on the landing page", async () => {
    await page.goto(`${MUN_URL}/d2l/loginh/`);
    await flow().prepareLogin(page);
    await page.waitForURL(CAS_URL);
  });

  it("fills MUN's form once and reaches Brightspace", async () => {
    await page.goto(CAS_URL);
    await expect(flow().login(page)).resolves.toBe(true);
    expect(page.url()).toBe(`${MUN_URL}/d2l/home`);
    expect(casPosts).toHaveLength(1);
    expect(casPosts[0]).toContain(`username=${USER}`);
    expect(casPosts[0]).toContain(`password=${SECRET}`);
  });

  it("stops after one try when MUN rejects the password", async () => {
    await context.route(CAS_URL, (route) => {
      if (route.request().method() === "POST") casPosts.push(route.request().postData() ?? "");
      return html(route, CAS_FORM);
    });
    await page.goto(CAS_URL);
    await expect(flow().login(page)).rejects.toThrow(/rejected the saved username or password/);
    expect(casPosts).toHaveLength(1);
  });

  it.each(["https://login.mun.ca.example.com/cas/login", "http://login.mun.ca/cas/login"])(
    "never sends the password to a look-alike page: %s",
    async (fake) => {
      let posted = false;
      let typed: string | undefined;
      await context.route(fake, (route) => {
        if (route.request().method() === "POST") posted = true;
        return html(route, CAS_FORM);
      });
      await page.goto(fake);
      const flowUnderTest = new MunSSOFlow({ baseUrl: MUN_URL, username: USER, password: SECRET, headless: true });
      const clock = setTimeout(() => {
        void page.locator("#password").inputValue()
          .then((value) => { typed = value; })
          .finally(() => page.close());
      }, 1500);
      try {
        await expect(flowUnderTest.login(page)).rejects.toThrow();
      } finally {
        clearTimeout(clock);
      }
      expect(posted).toBe(false);
      expect(typed).toBe("");
    },
  );

  it("answers Yes on Microsoft's Stay signed in page if MUN ever sends the login there", async () => {
    const entra = "https://login.microsoftonline.com/kmsi";
    await context.route(entra, (route) => html(route, `<div>Stay signed in?</div>
      <input id="KmsiCheckboxField" type="checkbox">
      <input id="idSIButton9" type="button" value="Yes" onclick="location.href='${MUN_URL}/d2l/home'">`));
    await context.route(CAS_URL, (route) => {
      if (route.request().method() !== "POST") return html(route, CAS_FORM);
      return redirect(route, entra);
    });
    await page.goto(CAS_URL);
    await expect(flow().login(page)).resolves.toBe(true);
    expect(page.url()).toBe(`${MUN_URL}/d2l/home`);
  }, 20_000);
});
