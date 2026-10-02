import { afterEach, describe, expect, it, vi } from "vitest";
import { DuoMfaHandler, isDuoPrompt } from "../../src/auth/duo-mfa.js";
import { AUTH_COMMAND } from "../../src/utils/commands.js";

/** One text-bearing element on the fake Duo prompt, in DOM order. */
interface FakeNode {
  text: string;
  id?: string;
  className?: string;
  /** Container selectors this node sits inside. Everything is inside body. */
  within?: string[];
}

interface DuoPageOptions {
  url?: string;
  /** Shorthand for a prompt that labels its digits the way Duo does. */
  verificationCode?: string;
  /** Full control over the prompt's text nodes, in DOM order. */
  nodes?: FakeNode[];
  /** Container selectors the page answers to, besides body. */
  containers?: string[];
  /** The passcode field is visible on this page from the very start. */
  passcode?: boolean;
  verifyButton?: boolean;
  /** Duo's remembered-device gate: "Is this your device?" */
  deviceQuestion?: boolean;
  /** Duo's "Other options" menu control, and the "Duo Mobile passcode" choice inside it. */
  otherOptions?: boolean;
  /**
   * The passcode field is hidden until Duo's "Other options" -> "Duo Mobile
   * passcode" walk (openPasscodeEntry in duo-mfa.ts) has been completed, the
   * way Duo's push-first Universal Prompt actually gates it. Mutually
   * exclusive in practice with `passcode` (which is visible unconditionally).
   */
  passcodeBehindOtherOptions?: boolean;
}

/**
 * Selector matching for the handful of forms this module uses. Enough to tell
 * "Duo's verification-code element" apart from "some number on the page",
 * which is the whole point of the scoping tests below.
 */
function matches(node: FakeNode, selector: string): boolean {
  const classes = node.className?.split(/\s+/).filter(Boolean) ?? [];
  if (selector.startsWith("#")) return node.id === selector.slice(1);
  if (selector.startsWith(".")) return classes.includes(selector.slice(1));
  const attribute = /^\[class\*='([^']+)'\]$/.exec(selector);
  if (attribute) return classes.some(name => name.includes(attribute[1]));
  return false;
}

function makePage(options: DuoPageOptions = {}) {
  const fill = vi.fn(async () => {});
  const click = vi.fn(async () => {});
  const press = vi.fn(async () => {});
  const waitForTimeout = vi.fn(async () => {});
  const deviceQuestionClick = vi.fn(async () => {});
  const otherOptionsClick = vi.fn(async () => {});
  const passcodeChoiceClick = vi.fn(async () => {});
  // Flips once "Duo Mobile passcode" has been chosen, the way the real
  // Universal Prompt only reveals the passcode field after that walk.
  let otherOptionsChosen = false;

  const nodes: FakeNode[] = options.nodes ?? (options.verificationCode
    ? [{ text: options.verificationCode, className: "verification-code", within: ["#auth-view"] }]
    : []);
  const containers = new Set([
    "body",
    ...(options.containers ?? []),
    ...nodes.flatMap(node => node.within ?? []),
  ]);

  const handle = (node: FakeNode | undefined, scope?: string) => ({
    isVisible: async () => node !== undefined || (scope !== undefined && containers.has(scope)),
    textContent: async () => node?.text ?? null,
    // Only a container handle is ever asked for its descendants.
    getByText: (pattern: RegExp) => locator(nodes.filter(candidate =>
      pattern.test(candidate.text) &&
      (scope === "body" || (candidate.within ?? []).includes(scope ?? "")),
    )),
    fill,
    click,
    press,
  });

  const locator = (found: FakeNode[], scope?: string) => ({
    first: () => handle(found[0], scope),
    all: async () => found.map(node => handle(node)),
  });

  // Mutable so a test can redirect the browser mid-flow, the way Duo does when
  // its prompt expires while the terminal is still waiting on a person.
  const state = { url: options.url ?? "https://api-123.duosecurity.com/frame/v4/auth" };

  const page = {
    url: vi.fn(() => state.url),
    locator: vi.fn((selector: string) =>
      locator(nodes.filter(node => matches(node, selector)), containers.has(selector) ? selector : undefined)),
    // The unscoped, whole-page text search. Nothing in the handler should use
    // it to read a verification code; the scoping tests below prove that.
    getByText: vi.fn((pattern: RegExp) => locator(nodes.filter(node => pattern.test(node.text)))),
    // Honors the accessible-name filter the handler passes. Ignoring it reports
    // every button as visible, so a handler asking for Duo's "Is this your
    // device?" control would click this page's Verify instead.
    getByRole: vi.fn((role: string, query?: { name?: string | RegExp }) => {
      const matchesName = (candidate: string) => {
        const pattern = query?.name;
        if (pattern === undefined) return true;
        return typeof pattern === "string"
          ? candidate.toLowerCase().includes(pattern.toLowerCase())
          : pattern.test(candidate);
      };
      const passcodeVisible = () => options.passcode || (options.passcodeBehindOtherOptions && otherOptionsChosen);

      if (role === "textbox") {
        return { first: () => ({
          isVisible: async () => Boolean(passcodeVisible()) && matchesName("passcode"),
          fill, click, press,
        }) };
      }
      if (matchesName("Yes, this is my device")) {
        return { first: () => ({
          isVisible: async () => Boolean(options.deviceQuestion),
          fill, press,
          click: deviceQuestionClick,
        }) };
      }
      if (matchesName("Other options")) {
        return { first: () => ({
          isVisible: async () => Boolean(options.otherOptions),
          fill, press,
          click: otherOptionsClick,
        }) };
      }
      if (matchesName("Duo Mobile passcode")) {
        return { first: () => ({
          isVisible: async () => Boolean(options.otherOptions),
          fill, press,
          click: vi.fn(async () => {
            otherOptionsChosen = true;
            await passcodeChoiceClick();
          }),
        }) };
      }
      return { first: () => ({
        isVisible: async () => options.verifyButton !== false && matchesName("Verify"),
        fill,
        click,
        press,
      }) };
    }),
    waitForTimeout,
  };
  return { page, state, fill, click, press, waitForTimeout, deviceQuestionClick, otherOptionsClick, passcodeChoiceClick };
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

  it("reads the code from Duo's own element, not the first number on the page", async () => {
    const lines = captureWarnings();
    // A masked phone number's last four renders before the push code on Duo's
    // "Check for a Duo Push" screen. An unscoped getByText(/^\d{3,6}$/).first()
    // announces 7890 and the push gets denied.
    const { page } = makePage({ nodes: [
      { text: "7890", within: ["#auth-view"] },
      { text: "123", className: "verification-code", within: ["#auth-view"] },
    ] });

    await new DuoMfaHandler({}).handle(page as never);

    expect(lines.filter(line => line.includes("Duo verification code: 123"))).toHaveLength(1);
    expect(lines.some(line => line.includes("7890"))).toBe(false);
  });

  it("announces nothing when the prompt shows competing numbers", async () => {
    const lines = captureWarnings();
    const { page } = makePage({ nodes: [
      { text: "7890", within: ["#auth-view"] },
      { text: "30", within: ["#auth-view"] },
      { text: "456", within: ["#auth-view"] },
    ] });

    await new DuoMfaHandler({}).handle(page as never);

    expect(lines.filter(line => line.includes("Duo verification code"))).toHaveLength(0);
  });

  it("still reads an unlabelled code when the prompt shows only one number", async () => {
    const lines = captureWarnings();
    const { page } = makePage({ nodes: [{ text: "246", within: ["#auth-view"] }] });

    await new DuoMfaHandler({}).handle(page as never);

    expect(lines.filter(line => line.includes("Duo verification code: 246"))).toHaveLength(1);
  });

  it("ignores numbers outside Duo's prompt container", async () => {
    const lines = captureWarnings();
    const { page } = makePage({
      containers: ["#auth-view"],
      // Rendered by the page shell, outside the prompt Duo owns.
      nodes: [{ text: "2026", within: ["body"] }],
    });

    await new DuoMfaHandler({}).handle(page as never);

    expect(lines.filter(line => line.includes("Duo verification code"))).toHaveLength(0);
  });

  it("reports onMfaChallenge with the verified-push code once", async () => {
    const onMfaChallenge = vi.fn();
    const { page } = makePage({ verificationCode: "1234" });
    const handler = new DuoMfaHandler({ onMfaChallenge });

    await handler.handle(page as never);
    await handler.handle(page as never);

    expect(onMfaChallenge).toHaveBeenCalledTimes(1);
    expect(onMfaChallenge).toHaveBeenCalledWith("1234");
  });

  it("reports onMfaChallenge again when Duo issues a changed verification code", async () => {
    // Same fix as purdue-sso.ts: a stale code must not survive for the rest
    // of the login once Duo shows a different one.
    const onMfaChallenge = vi.fn();
    const handler = new DuoMfaHandler({ onMfaChallenge });

    const first = makePage({ verificationCode: "111" });
    await handler.handle(first.page as never);
    const second = makePage({ verificationCode: "222" });
    await handler.handle(second.page as never);

    expect(onMfaChallenge).toHaveBeenCalledTimes(2);
    expect(onMfaChallenge).toHaveBeenNthCalledWith(1, "111");
    expect(onMfaChallenge).toHaveBeenNthCalledWith(2, "222");
  });

  it("reports onMfaChallenge with null for a plain push, with nothing more to say later", async () => {
    const onMfaChallenge = vi.fn();
    const { page } = makePage({});
    const handler = new DuoMfaHandler({ onMfaChallenge });

    await handler.handle(page as never);
    await handler.handle(page as never);

    expect(onMfaChallenge).toHaveBeenCalledTimes(1);
    expect(onMfaChallenge).toHaveBeenCalledWith(null);
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

  it("never types a passcode into a page that left Duo while the prompt waited", async () => {
    const { page, state, fill, press } = makePage({ passcode: true });
    // The prompt blocks on stdin; Duo expires and the browser moves on.
    const requestMfaCode = vi.fn(async () => {
      state.url = "https://login.microsoftonline.com/common/oauth2/authorize";
      return "123456";
    });

    await expect(new DuoMfaHandler({ requestMfaCode }).handle(page as never))
      .rejects.toThrow(/Duo prompt closed/);
    expect(fill).not.toHaveBeenCalled();
    expect(press).not.toHaveBeenCalled();
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

  it("answers Duo's remembered-device question with yes exactly once", async () => {
    const { page, deviceQuestionClick } = makePage({ deviceQuestion: true });
    const handler = new DuoMfaHandler({});

    await handler.handle(page as never);
    await handler.handle(page as never);

    expect(deviceQuestionClick).toHaveBeenCalledOnce();
  });

  describe("D2L_DUO_PASSCODE", () => {
    const originalEnv = process.env.D2L_DUO_PASSCODE;
    afterEach(() => {
      if (originalEnv === undefined) delete process.env.D2L_DUO_PASSCODE;
      else process.env.D2L_DUO_PASSCODE = originalEnv;
    });

    it("walks to Duo's passcode entry and fills it when set, instead of waiting on a push", async () => {
      process.env.D2L_DUO_PASSCODE = "1";
      const requestMfaCode = vi.fn(async () => "123456");
      const { page, otherOptionsClick, passcodeChoiceClick, fill } = makePage({
        otherOptions: true,
        passcodeBehindOtherOptions: true,
      });
      const handler = new DuoMfaHandler({ requestMfaCode });

      await handler.handle(page as never);

      expect(otherOptionsClick).toHaveBeenCalledOnce();
      expect(passcodeChoiceClick).toHaveBeenCalledOnce();
      expect(requestMfaCode).toHaveBeenCalledOnce();
      expect(fill).toHaveBeenCalledWith("123456");
    });

    it("leaves the passcode walk untouched and waits on the push when unset", async () => {
      delete process.env.D2L_DUO_PASSCODE;
      const requestMfaCode = vi.fn(async () => "123456");
      const { page, otherOptionsClick, passcodeChoiceClick, fill } = makePage({
        otherOptions: true,
        passcodeBehindOtherOptions: true,
      });
      const handler = new DuoMfaHandler({ requestMfaCode });

      await expect(handler.handle(page as never)).resolves.toBe(true);

      expect(otherOptionsClick).not.toHaveBeenCalled();
      expect(passcodeChoiceClick).not.toHaveBeenCalled();
      expect(requestMfaCode).not.toHaveBeenCalled();
      expect(fill).not.toHaveBeenCalled();
    });
  });
});
