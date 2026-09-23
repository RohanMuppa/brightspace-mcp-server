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
  passcode?: boolean;
  verifyButton?: boolean;
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
    getByRole: vi.fn((role: string) => ({ first: () => ({
      isVisible: async () => role === "textbox" ? Boolean(options.passcode) : options.verifyButton !== false,
      fill,
      click,
      press,
    }) })),
  };
  return { page, state, fill, click, press };
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
