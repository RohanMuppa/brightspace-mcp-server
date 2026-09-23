import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";
import { UnsupportedAuthenticationError } from "../../src/auth/sso-flow.js";

const USERNAME = "student@example.edu";
const PASSWORD = "dummy-password";
const PURDUE = "https://purdue.brightspace.com";

interface PageOptions {
  emailSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  passwordDelayMs?: number;
  missing?: "email" | "next" | "password" | "submit";
  detachAfterNext?: boolean;
  /** How many leading Next clicks Microsoft leaves on the email step. */
  nextLandsAfter?: number;
}

/** Render each Entra stage independently, including a delayed password field. */
function makePage(options: PageOptions = {}) {
  let phase: "email" | "password" | "done" = "email";
  let sinceNext = 0;
  let nextClicks = 0;
  const actions: string[] = [];
  const email = {
    isVisible: vi.fn(async () => phase === "email" && options.missing !== "email"),
    fill: vi.fn(async (_value: string) => { actions.push("email"); }),
  };
  const password = {
    isVisible: vi.fn(async () => phase === "password" && sinceNext >= (options.passwordDelayMs ?? 0) && options.missing !== "password"),
    fill: vi.fn(async (_value: string) => { actions.push("password"); }),
  };
  const next = {
    isVisible: vi.fn(async () => phase === "email" && options.missing !== "next"),
    click: vi.fn(async () => {
      actions.push("next");
      nextClicks += 1;
      if (nextClicks > (options.nextLandsAfter ?? 0)) phase = "password";
      if (options.detachAfterNext) throw new Error("Element detached after navigation");
    }),
  };
  const submit = {
    isVisible: vi.fn(async () => phase === "password" && options.missing !== "submit"),
    click: vi.fn(async () => { actions.push("submit"); phase = "done"; }),
  };
  const absent = {
    isVisible: vi.fn(async () => false),
    fill: vi.fn(async () => { throw new Error("Cannot fill an absent field"); }),
    click: vi.fn(async () => { throw new Error("Cannot click an absent button"); }),
  };
  const page = {
    locator: vi.fn((selector: string) => ({
      first: () => {
        if (selector === (options.emailSelector ?? "input[type=email]")) return email;
        if (selector === (options.passwordSelector ?? "input[type=password]")) return password;
        if (selector === (options.submitSelector ?? "#idSIButton9")) return phase === "email" ? next : submit;
        return absent;
      },
    })),
    waitForTimeout: vi.fn(async (milliseconds: number) => {
      vi.advanceTimersByTime(milliseconds);
      if (phase === "password") sinceNext += milliseconds;
    }),
  };
  return { page, actions, email, password, next, submit };
}

const enterCredentials = (flow: PurdueSSOFlow, page: unknown): Promise<void> =>
  (flow as any).enterCredentials(page);

describe("PurdueSSOFlow credential choreography ported from Brightspace Bar", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("performs email, Next, password, then submit in that order", async () => {
    const form = makePage();
    await enterCredentials(new PurdueSSOFlow({ username: USERNAME, password: PASSWORD }), form.page);
    expect(form.actions).toEqual(["email", "next", "password", "submit"]);
    expect(form.email.fill).toHaveBeenCalledWith(USERNAME);
    expect(form.password.fill).toHaveBeenCalledWith(PASSWORD);
    expect(form.next.click).toHaveBeenCalledOnce();
    expect(form.submit.click).toHaveBeenCalledOnce();
  });

  it("waits for the password field after Next changes before the field appears", async () => {
    const form = makePage({ passwordDelayMs: 1000 });
    await enterCredentials(new PurdueSSOFlow({ username: USERNAME, password: PASSWORD }), form.page);
    expect(form.actions).toEqual(["email", "next", "password", "submit"]);
    expect(form.page.waitForTimeout).toHaveBeenCalledTimes(4);
    expect(form.page.waitForTimeout).toHaveBeenNthCalledWith(1, 250);
    expect(form.password.fill).toHaveBeenCalledOnce();
  });

  it("can submit only the public account name before deciding whether a password is needed", async () => {
    const form = makePage({ passwordDelayMs: 500 });
    const flow = new PurdueSSOFlow({ username: "student", password: PASSWORD, baseUrl: PURDUE });

    await expect(flow.identifyAccount(form.page as never)).resolves.toBe(true);
    expect(form.actions).toEqual(["email", "next"]);
    expect(form.email.fill).toHaveBeenCalledWith("student@purdue.edu");

    await enterCredentials(flow, form.page);
    expect(form.actions).toEqual(["email", "next", "password", "submit"]);
  });

  // clickWhenReady swallows a click error on purpose, because Entra usually
  // detaches the button once it has navigated. When it has NOT navigated, the
  // account hint was never accepted and the email field is still on screen.
  // Trusting the latch there burns the whole 30-second password timeout on a
  // page still asking for a username, and blames a missing password field.
  it("re-submits the account name when Microsoft kept the email step on screen", async () => {
    const form = makePage({ nextLandsAfter: 1 });
    const flow = new PurdueSSOFlow({ username: USERNAME, password: PASSWORD });

    await expect(flow.identifyAccount(form.page as never)).resolves.toBe(true);
    expect(form.actions).toEqual(["email", "next"]);

    await enterCredentials(flow, form.page);
    expect(form.actions).toEqual(["email", "next", "email", "next", "password", "submit"]);
  });

  it("does not re-submit the account name once the email step is gone", async () => {
    const form = makePage({ passwordDelayMs: 500 });
    const flow = new PurdueSSOFlow({ username: USERNAME, password: PASSWORD });

    await expect(flow.identifyAccount(form.page as never)).resolves.toBe(true);
    await enterCredentials(flow, form.page);
    expect(form.actions).toEqual(["email", "next", "password", "submit"]);
  });

  it("supports Microsoft's loginfmt and passwd field-name fallbacks", async () => {
    const form = makePage({ emailSelector: "input[name=loginfmt]", passwordSelector: "input[name=passwd]" });
    await enterCredentials(new PurdueSSOFlow({ username: USERNAME, password: PASSWORD }), form.page);
    expect(form.actions).toEqual(["email", "next", "password", "submit"]);
    expect(form.page.locator).toHaveBeenCalledWith("input[name=loginfmt]");
    expect(form.page.locator).toHaveBeenCalledWith("input[name=passwd]");
  });

  it.each(["#idSIButton9", "input[type=submit]", "button[type=submit]"])(
    "supports the %s submit selector without inspecting English button labels",
    async (submitSelector) => {
      const form = makePage({ submitSelector });
      await enterCredentials(new PurdueSSOFlow({ username: USERNAME, password: PASSWORD }), form.page);
      expect(form.actions).toEqual(["email", "next", "password", "submit"]);
    },
  );

  it("expands a Purdue career account to its Microsoft sign-in name", async () => {
    const form = makePage();
    await enterCredentials(new PurdueSSOFlow({ username: "student", password: PASSWORD, baseUrl: PURDUE }), form.page);
    expect(form.email.fill).toHaveBeenCalledWith("student@purdue.edu");
  });

  it("preserves an explicitly supplied full sign-in name", async () => {
    const form = makePage();
    await enterCredentials(new PurdueSSOFlow({ username: USERNAME, password: PASSWORD }), form.page);
    expect(form.email.fill).toHaveBeenCalledWith(USERNAME);
  });

  it("never appends Purdue's domain for another school", async () => {
    const form = makePage();
    await enterCredentials(new PurdueSSOFlow({ username: "student", password: PASSWORD, baseUrl: "https://school.example" }), form.page);
    expect(form.email.fill).toHaveBeenCalledWith("student");
  });

  it.each([
    ["email", [], "email field"],
    ["next", ["email"], "email submit button"],
    ["password", ["email", "next"], "password field"],
    ["submit", ["email", "next", "password"], "password submit button"],
  ] as const)("stops with a typed unsupported error when %s is missing", async (missing, actions, message) => {
    const form = makePage({ missing });
    const flow = new PurdueSSOFlow({ username: USERNAME, password: PASSWORD });
    const attempt = enterCredentials(flow, form.page);
    await expect(attempt).rejects.toBeInstanceOf(UnsupportedAuthenticationError);
    await expect(attempt).rejects.toThrow(message);
    expect(form.actions).toEqual(actions);
    expect(form.page.waitForTimeout).toHaveBeenCalledTimes(120);
  });

  it("continues when the Next click detaches its button after navigating", async () => {
    const form = makePage({ detachAfterNext: true });
    await enterCredentials(new PurdueSSOFlow({ username: USERNAME, password: PASSWORD }), form.page);
    expect(form.actions).toEqual(["email", "next", "password", "submit"]);
  });

  it("rejects missing saved credentials before interacting with the page", async () => {
    const form = makePage();
    await expect(enterCredentials(new PurdueSSOFlow({ username: USERNAME }), form.page)).rejects.toThrow("Password is required");
    expect(form.actions).toEqual([]);
    expect(form.page.locator).not.toHaveBeenCalled();
  });
});

describe("Purdue campus routing ported from Brightspace Bar", () => {
  it("clicks Purdue's live campus control instead of assuming its destination", async () => {
    const click = vi.fn(async () => {});
    const goto = vi.fn();
    const page = {
      url: () => "https://purdue.brightspace.com/d2l/login",
      getByText: vi.fn(() => ({ first: () => ({ isVisible: async () => true, click }) })),
      goto,
    };

    await new PurdueSSOFlow({ baseUrl: PURDUE }).prepareLogin(page as never);

    expect(page.getByText).toHaveBeenCalledWith(/Purdue West Lafayette/i);
    expect(click).toHaveBeenCalledOnce();
    expect(goto).not.toHaveBeenCalled();
  });

  it("uses the known SAML endpoint only when the campus control is unavailable", async () => {
    const goto = vi.fn(async () => {});
    const page = {
      url: () => "https://purdue.brightspace.com/d2l/login",
      getByText: vi.fn(() => ({ first: () => ({ isVisible: async () => false }) })),
      goto,
    };

    await new PurdueSSOFlow({ baseUrl: PURDUE }).prepareLogin(page as never);

    expect(goto).toHaveBeenCalledWith(
      "https://purdue.brightspace.com/d2l/lp/auth/saml/initiate-login?entityId=https://idp.purdue.edu/idp/shibboleth",
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );
  });
});
