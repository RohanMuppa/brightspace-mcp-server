import { describe, it, expect, vi } from "vitest";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";

/**
 * Regression tests for enterCredentials() against Microsoft Entra ID.
 *
 * Shibboleth and CAS render the username and password boxes together and one
 * fill-fill-submit pass completes them. Entra looks the same to a selector but
 * is not: its account-name page carries a password box that Playwright reports
 * as visible, while the button only advances to the next view. Filling the
 * password there and pressing that button leaves the browser parked on the
 * sign-in page with both fields populated and nothing submitted, while the
 * flow moves on to wait for an MFA prompt that can never arrive.
 *
 * The button label is what separates the two: "Next" on the account-name page,
 * "Sign in" on the page that follows.
 */

const USERNAME = "student@example.edu";
const PASSWORD = "hunter2";

function makeField(visible: boolean, label = "") {
  return {
    fill: vi.fn(async () => {}),
    isVisible: vi.fn(async () => visible),
    click: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    evaluate: vi.fn(async (fn: (el: unknown) => unknown) =>
      fn({ value: label, textContent: label }),
    ),
  };
}

/**
 * Fake Page. With `entra`, it behaves like Microsoft's two-view form: a
 * password box and a "Next" button up front, replaced by a second password box
 * and a "Sign in" button once the account name is submitted.
 */
function makePage(opts: { entra?: boolean; submitLabel?: string } = {}) {
  const username = makeField(true);
  const accountPassword = makeField(true);
  const signInPassword = makeField(true);
  const nextButton = makeField(true, "Next");
  const signInButton = makeField(true, opts.submitLabel ?? "Sign in");
  let advanced = false;

  nextButton.click = vi.fn(async () => {
    advanced = true;
  });

  const matches = (selector: string) => {
    if (selector.includes("input#username")) return [username];
    if (selector.includes("input#password")) {
      if (!opts.entra) return [signInPassword];
      return advanced ? [signInPassword] : [accountPassword];
    }
    if (selector.includes("_eventId_proceed")) {
      if (!opts.entra) return [signInButton];
      return [advanced ? signInButton : nextButton];
    }
    return [];
  };

  return {
    fields: { username, accountPassword, signInPassword, nextButton, signInButton },
    $: vi.fn(async (selector: string) => matches(selector)[0] ?? null),
    $$: vi.fn(async (selector: string) => matches(selector)),
    waitForSelector: vi.fn(async () => null),
    waitForTimeout: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
  };
}

const enterCredentials = (flow: PurdueSSOFlow, page: unknown): Promise<void> =>
  (flow as any).enterCredentials(page);

describe("PurdueSSOFlow.enterCredentials", () => {
  it("submits the account name before entering the password on Entra", async () => {
    const page = makePage({ entra: true });
    const flow = new PurdueSSOFlow({ username: USERNAME, password: PASSWORD });

    await enterCredentials(flow, page);

    expect(page.fields.username.fill).toHaveBeenCalledWith(USERNAME);
    expect(page.fields.nextButton.click).toHaveBeenCalledOnce();
    // The password belongs to the sign-in view, not the account-name page.
    expect(page.fields.accountPassword.fill).not.toHaveBeenCalled();
    expect(page.fields.signInPassword.fill).toHaveBeenCalledWith(PASSWORD);
    expect(page.fields.signInButton.click).toHaveBeenCalledOnce();
  });

  it("leaves single-page forms on their existing one-pass path", async () => {
    const page = makePage({ submitLabel: "Log In" });
    const flow = new PurdueSSOFlow({ username: USERNAME, password: PASSWORD });

    await enterCredentials(flow, page);

    expect(page.fields.username.fill).toHaveBeenCalledWith(USERNAME);
    expect(page.fields.signInPassword.fill).toHaveBeenCalledWith(PASSWORD);
    expect(page.fields.signInButton.click).toHaveBeenCalledOnce();
    // No account-name hop: the button never said "Next".
    expect(page.fields.nextButton.click).not.toHaveBeenCalled();
  });

  it("treats a button labelled Next as an account-name page whatever the case", async () => {
    const page = makePage({ entra: true });
    page.fields.nextButton.evaluate = vi.fn(async (fn: (el: unknown) => unknown) =>
      fn({ value: "NEXT", textContent: "NEXT" }),
    );
    const flow = new PurdueSSOFlow({ username: USERNAME, password: PASSWORD });

    await enterCredentials(flow, page);

    expect(page.fields.nextButton.click).toHaveBeenCalledOnce();
    expect(page.fields.signInButton.click).toHaveBeenCalledOnce();
  });

  it("still rejects when no password is configured", async () => {
    const page = makePage();
    const flow = new PurdueSSOFlow({ username: USERNAME });

    await expect(enterCredentials(flow, page)).rejects.toThrow(/Password is required/);
  });
});
