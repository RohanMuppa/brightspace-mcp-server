import { readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KEY_HOWTO_LINES,
  KEY_PROMPT,
  KEY_PROMPT_KEEP,
  SHORTCUTS_DOCS_URL,
  describeShortcuts,
  mfaShortcutTip,
  resetActiveShortcuts,
  setActiveShortcuts,
} from "../../src/utils/two-factor-shortcuts.js";
import { SETUP_COMMAND } from "../../src/utils/commands.js";

const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf-8");

afterEach(() => resetActiveShortcuts());

describe("2FA shortcuts: the docs section", () => {
  it("points at one GitHub URL whose anchor is a real heading in docs/sign-in.md", () => {
    expect(SHORTCUTS_DOCS_URL).toBe(
      "https://github.com/RohanMuppa/brightspace-mcp-server/blob/main/docs/sign-in.md#fewer-2fa-prompts",
    );
    expect(read("docs/sign-in.md")).toMatch(/^## Fewer 2FA prompts$/m);
  });

  it("keeps the old anchors out of the repo (README links the new one)", () => {
    for (const file of ["README.md", "LLMs.md", "docs/troubleshooting.md", "docs/sign-in.md"]) {
      expect(read(file)).not.toContain("#answering-code-challenges-without-your-phone");
    }
    expect(read("README.md")).toContain("docs/sign-in.md#fewer-2fa-prompts");
  });
});

describe("2FA shortcuts: setup wizard text", () => {
  it("tells the user how to get the key in two lines", () => {
    expect(KEY_HOWTO_LINES).toHaveLength(2);
    const text = KEY_HOWTO_LINES.join("\n");
    expect(text).toContain("https://mysignins.microsoft.com");
    expect(text).toContain("Security info");
    expect(text).toContain("Add sign-in method");
    expect(text).toContain("Authenticator app");
    expect(text).toContain("I want to use a different authenticator app");
    expect(text).toContain("Can't scan image?");
    expect(text).toContain("secret key");
  });

  it("says Enter means none, or keeps the saved key", () => {
    expect(KEY_PROMPT).toContain("Enter = none");
    expect(KEY_PROMPT_KEEP).toContain("Enter to keep it");
  });

  it("asks the one question through setup.ts, and the old two prompts are gone", () => {
    const setup = read("src/setup.ts");
    expect(setup).toContain("askShortcutQuestion");
    expect(setup).not.toContain("Remember this device so later sign-ins");
    expect(setup).not.toContain("Authenticator setup key or otpauth:// link (optional)");
    expect(setup).not.toContain("Step 3b");
  });
});

describe("2FA shortcuts: MFA hint", () => {
  it("is empty until startup has recorded the state", () => {
    expect(mfaShortcutTip()).toBe("");
  });

  it("shows one line with the setup command and docs link when both options are off", () => {
    setActiveShortcuts({ rememberMfa: false, keySaved: false });
    const tip = mfaShortcutTip();
    expect(tip).toContain("to be asked less often");
    expect(tip).toContain(SETUP_COMMAND);
    expect(tip).toContain(SHORTCUTS_DOCS_URL);
    expect(tip).not.toContain("\n");
  });

  it.each([
    [{ rememberMfa: true, keySaved: false }],
    [{ rememberMfa: false, keySaved: true }],
    [{ rememberMfa: true, keySaved: true }],
  ])("is hidden when either option is on (%j)", (state) => {
    setActiveShortcuts(state);
    expect(mfaShortcutTip()).toBe("");
  });
});

describe("2FA shortcuts: doctor line", () => {
  it("reports both states and adds the docs link when both are off", () => {
    const line = describeShortcuts({ rememberMfa: false, keySaved: false });
    expect(line).toBe(
      `2FA shortcuts: remember this device off, authenticator key not saved. Want fewer prompts? See ${SHORTCUTS_DOCS_URL}`,
    );
  });

  it("omits the link when either is on", () => {
    expect(describeShortcuts({ rememberMfa: true, keySaved: false })).toBe(
      "2FA shortcuts: remember this device on, authenticator key not saved.",
    );
    expect(describeShortcuts({ rememberMfa: false, keySaved: true })).toBe(
      "2FA shortcuts: remember this device off, authenticator key saved.",
    );
  });

  it("says so, and adds no link, when the key could not be checked", () => {
    expect(describeShortcuts({ rememberMfa: false, keySaved: "unknown" })).toBe(
      "2FA shortcuts: remember this device off, authenticator key not checked.",
    );
  });
});
