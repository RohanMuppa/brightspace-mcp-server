import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";
import { SunySSOFlow } from "../../src/auth/suny-sso.js";
import { WesternSSOFlow } from "../../src/auth/western-sso.js";

/**
 * Entra's "Don't ask again for N days" checkbox on the MFA page. KMSI only
 * keeps the session; this box is what suppresses the second factor, and it
 * has to be ticked before the phone approval lands because the page
 * navigates the instant it does.
 */

const BASE_URL = "https://purdue.brightspace.com";
const ENTRA_URL = "https://login.microsoftonline.com/common/SAS/BeginAuth";
const NUMBER_MATCH_BOX = "#idChkBx_SAOTCAS_TD";
const CODE_BOX = "#idChkBx_SAOTCC_TD";

interface Checkbox { checked: boolean }

interface PageSetup {
  url?: string;
  /** Number-match page by default; "code" shows the verification-code page. */
  page?: "number" | "code";
  /** Checkboxes keyed by id selector. */
  boxes?: Record<string, Checkbox>;
  /** A checkbox reachable only through its "Don't ask again" label. */
  labelled?: Checkbox;
  boxAppearsAtPoll?: number;
  mfaPolls?: number;
}

/** One MFA poll on the given page, then verified Brightspace home on the next. */
function makePage(setup: PageSetup) {
  let poll = 0;
  const events: string[] = [];
  const checks: string[] = [];
  const onEntra = () => poll < (setup.mfaPolls ?? 1);
  const box = (name: string, target: Checkbox | undefined) => ({
    isVisible: async () => onEntra() && poll >= (setup.boxAppearsAtPoll ?? 0) && target !== undefined,
    isChecked: async () => target?.checked ?? false,
    check: async () => {
      checks.push(name);
      events.push("check");
      if (target) target.checked = true;
    },
  });
  const locatorTarget = (selector: string) => {
    if (setup.boxes && selector in setup.boxes) return box(selector, setup.boxes[selector]);
    return {
      isVisible: async () => {
        if (!onEntra()) return false;
        if (selector === "#idRichContext_DisplaySign") return setup.page !== "code";
        if (selector === "#idDiv_SAOTCAS_Title") return setup.page !== "code";
        if (selector === "#idDiv_SAOTCC_Title" || selector === "#idTxtBx_SAOTCC_OTC") return setup.page === "code";
        if (selector === "#idSubmit_SAOTCC_Continue") return setup.page === "code";
        return false;
      },
      textContent: async () => (selector === "#idRichContext_DisplaySign" ? "42" : null),
      click: async () => {},
      fill: async () => {},
      press: async () => {},
    };
  };
  const page = {
    url: () => (onEntra() ? setup.url ?? ENTRA_URL : `${BASE_URL}/d2l/home`),
    locator: (selector: string) => ({ first: () => locatorTarget(selector) }),
    getByText: () => ({ first: () => ({ isVisible: async () => false, textContent: async () => null }) }),
    getByRole: () => ({ first: () => ({ isVisible: async () => false, click: async () => {} }) }),
    getByLabel: (pattern: RegExp) => ({
      first: () => box(`label:${pattern.source}`, pattern.test("Don't ask again for 90 days") ? setup.labelled : undefined),
    }),
    context: () => ({ cookies: async () => (onEntra() ? [] : [{ name: "d2lSessionVal", value: "live" }]) }),
    evaluate: async () => !onEntra(),
    waitForTimeout: async (milliseconds: number) => {
      poll += 1;
      vi.advanceTimersByTime(milliseconds);
    },
  };
  return { page, events, checks };
}

function captureInfo(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.includes("remember-MFA")) lines.push(first);
  });
  return lines;
}

/** Opted in unless a test says otherwise; `rememberMfa: undefined` is the real default (off). */
function flowFor(options: { rememberMfa?: boolean; events?: string[]; requestMfaCode?: () => Promise<string> } = {}) {
  return new PurdueSSOFlow({
    baseUrl: BASE_URL,
    rememberMfa: "rememberMfa" in options ? options.rememberMfa : true,
    requestMfaCode: options.requestMfaCode,
    onMfaChallenge: () => options.events?.push("announce"),
  });
}

const handleMFA = (flow: PurdueSSOFlow, page: unknown): Promise<void> => (flow as any).handleMFA(page);

describe("Entra remember-MFA checkbox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ticks an unchecked box exactly once", async () => {
    const { page, checks } = makePage({ boxes: { [NUMBER_MATCH_BOX]: { checked: false } } });
    await handleMFA(flowFor(), page);
    expect(checks).toEqual([NUMBER_MATCH_BOX]);
  });

  it("ticks a checkbox rendered after the first challenge without delaying its announcement", async () => {
    const { page, checks, events } = makePage({
      boxes: { [NUMBER_MATCH_BOX]: { checked: false } }, boxAppearsAtPoll: 1, mfaPolls: 2,
    });
    const flow = flowFor({ events });
    await handleMFA(flow, page);
    expect(checks).toEqual([NUMBER_MATCH_BOX]);
    expect(events).toEqual(["announce", "check"]);
    expect(flow.rememberMfaResult()?.outcome).toBe("ticked");
  });

  it("ticks the box before the number is announced", async () => {
    const { page, events } = makePage({ boxes: { [NUMBER_MATCH_BOX]: { checked: false } } });
    await handleMFA(flowFor({ events }), page);
    expect(events).toEqual(["check", "announce"]);
  });

  it("logs and records a ticked box", async () => {
    const lines = captureInfo();
    const { page } = makePage({ boxes: { [NUMBER_MATCH_BOX]: { checked: false } } });
    const flow = flowFor();
    await handleMFA(flow, page);
    expect(lines.some(line => line.includes("Entra remember-MFA checkbox: ticked"))).toBe(true);
    expect(flow.rememberMfaResult()).toEqual({ outcome: "ticked", at: "2026-10-01T12:00:00.000Z" });
  });

  it("leaves an already-checked box alone", async () => {
    const lines = captureInfo();
    const { page, checks } = makePage({ boxes: { [NUMBER_MATCH_BOX]: { checked: true } } });
    const flow = flowFor();
    await handleMFA(flow, page);
    expect(checks).toEqual([]);
    expect(lines.some(line => line.includes("Entra remember-MFA checkbox: already checked"))).toBe(true);
    expect(flow.rememberMfaResult()?.outcome).toBe("already");
  });

  it("records a tenant that offers no box and still finishes number match", async () => {
    const lines = captureInfo();
    const events: string[] = [];
    const { page, checks } = makePage({});
    const flow = flowFor({ events });
    await expect(handleMFA(flow, page)).resolves.toBeUndefined();
    expect(checks).toEqual([]);
    expect(events).toEqual(["announce"]);
    expect(lines.some(line => line.includes("Entra remember-MFA checkbox: not offered by tenant"))).toBe(true);
    expect(flow.rememberMfaResult()?.outcome).toBe("absent");
  });

  it("falls back to the box's \"Don't ask again\" label when Entra renames the id", async () => {
    const labelled = { checked: false };
    const { page } = makePage({ labelled });
    await handleMFA(flowFor(), page);
    expect(labelled.checked).toBe(true);
  });

  it("does nothing off login.microsoftonline.com", async () => {
    const { page, checks } = makePage({
      url: "https://login.microsoftonline.com.evil.example/common/SAS/BeginAuth",
      boxes: { [NUMBER_MATCH_BOX]: { checked: false } },
    });
    const flow = flowFor();
    await handleMFA(flow, page);
    expect(checks).toEqual([]);
    expect(flow.rememberMfaResult()).toBeUndefined();
  });

  it.each([
    ["is unset (the default)", undefined],
    ["is false", false],
  ])("leaves the box alone and records \"off\" when the opt-in %s", async (_label, rememberMfa) => {
    const lines = captureInfo();
    const events: string[] = [];
    const { page, checks } = makePage({ boxes: { [NUMBER_MATCH_BOX]: { checked: false } } });
    const flow = flowFor({ rememberMfa, events });
    await handleMFA(flow, page);
    expect(checks).toEqual([]);
    expect(events).toEqual(["announce"]);
    expect(flow.rememberMfaResult()).toEqual({ outcome: "off", at: "2026-10-01T12:00:00.000Z" });
    expect(lines.some(line => line.includes("Entra remember-MFA checkbox: off (set D2L_REMEMBER_MFA=true"))).toBe(true);
  });

  it("records \"off\" only once per login", async () => {
    const { page } = makePage({ boxes: { [NUMBER_MATCH_BOX]: { checked: false } } });
    const flow = flowFor({ rememberMfa: undefined });
    await handleMFA(flow, page);
    const first = flow.rememberMfaResult();
    vi.setSystemTime(new Date("2026-10-01T12:05:00Z"));
    await (flow as any).rememberMfaDevice(page);
    expect(flow.rememberMfaResult()).toBe(first);
  });

  it("ticks the verification-code page's box before asking for the code", async () => {
    const events: string[] = [];
    const { page, events: pageEvents } = makePage({ page: "code", boxes: { [CODE_BOX]: { checked: false } } });
    const flow = flowFor({
      requestMfaCode: async () => {
        events.push(...pageEvents, "code requested");
        return "123456";
      },
    });
    await handleMFA(flow, page);
    expect(events).toEqual(["check", "code requested"]);
    expect(flow.rememberMfaResult()?.outcome).toBe("ticked");
  });
});

describe("Entra remember-MFA result through wrapped flows", () => {
  afterEach(() => vi.restoreAllMocks());

  const result = { outcome: "ticked" as const, at: "2026-10-01T12:00:00.000Z" };

  it.each([
    ["SUNY", () => new SunySSOFlow({ campus: "Albany" })],
    ["Western", () => new WesternSSOFlow({ baseUrl: "https://westernu.brightspace.com" })],
  ])("%s reports what its inner Entra flow recorded", (_name, build) => {
    vi.spyOn(PurdueSSOFlow.prototype, "rememberMfaResult").mockReturnValue(result);
    expect(build().rememberMfaResult()).toEqual(result);
  });
});
