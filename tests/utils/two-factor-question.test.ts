import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SHORTCUTS_DOCS_URL,
  askShortcutQuestion,
  type ShortcutIO,
  type ShortcutQuestionInput,
} from "../../src/utils/two-factor-shortcuts.js";

// A made-up base32 key. Never a real one: the tests assert it is never printed.
const KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

interface Run {
  io: ShortcutIO;
  /** Every printed line and every prompt with its answer; hidden answers are masked. */
  transcript: string[];
  prompts: string[];
  secretPrompts: string[];
}

/** Scripted terminal: `answers` are consumed in order by both ask and askSecret. */
function script(answers: string[]): Run {
  const queue = [...answers];
  const run: Run = { io: undefined as unknown as ShortcutIO, transcript: [], prompts: [], secretPrompts: [] };
  run.io = {
    async ask(prompt) {
      const a = queue.shift();
      if (a === undefined) throw new Error(`unexpected prompt: ${prompt}`);
      run.prompts.push(prompt);
      run.transcript.push(prompt + a);
      return a;
    },
    async askSecret(prompt) {
      const a = queue.shift();
      if (a === undefined) throw new Error(`unexpected secret prompt: ${prompt}`);
      run.secretPrompts.push(prompt);
      run.transcript.push(prompt + (a ? "*".repeat(a.length) : ""));
      return a;
    },
    print(line) {
      run.transcript.push(line);
    },
  };
  return run;
}

const first: ShortcutQuestionInput = { username: "alice", rememberMfa: false, keySaved: false, savedConfig: false };
const text = (r: Run) => r.transcript.join("\n");

describe("the one 2FA question: wording", () => {
  it("asks one multiple-choice question with the three options and the shared-computer warning", async () => {
    const r = script([""]);
    await askShortcutQuestion(r.io, first);
    const t = text(r);
    expect(t).toContain("How often do you want to approve sign-ins on your phone?");
    expect(t).toContain("1. Every time Microsoft asks (default, safest)");
    expect(t).toContain("2. Less often: Microsoft remembers this computer for a while (your school decides how long)");
    expect(t).toContain("3. Almost never: this computer answers Microsoft's code requests itself (needs a key from Microsoft, about 2 minutes)");
    expect(t).toContain("Options 2 and 3 are not for shared computers.");
    expect(t).toContain(`Details: ${SHORTCUTS_DOCS_URL}`);
    expect(r.prompts).toEqual(["  Choose 1, 2 or 3 [1]: "]);
  });

  it("keeps the real facts in short extra lines", async () => {
    const r = script([""]);
    await askShortcutQuestion(r.io, first);
    const t = text(r);
    expect(t).toContain("Don't ask again");
    expect(t).toContain("you still approve now and then");
    expect(t).toContain("stores a key next to your password");
    expect(t).toContain("on this computer the two factors become one");
    expect(t).toContain("still stops anyone who only has your password");
    expect(t).toContain("only when Microsoft asks for a 6-digit code");
    expect(t).toContain("only sends a number to approve");
    expect(t).toContain("falls back to your phone");
    // Short: the question plus its notes stay a handful of lines.
    expect(r.transcript.length).toBeLessThanOrEqual(12);
  });

  it("re-asks on an invalid choice", async () => {
    const r = script(["9", "x", "1"]);
    const a = await askShortcutQuestion(r.io, first);
    expect(a).toEqual({ rememberMfa: false, removeKey: false });
    expect(text(r)).toContain("Please enter 1, 2 or 3.");
  });
});

describe("the one 2FA question: each choice", () => {
  it("1 (and Enter on a first run): remember off, no key", async () => {
    for (const reply of ["1", ""]) {
      const r = script([reply]);
      expect(await askShortcutQuestion(r.io, first)).toEqual({ rememberMfa: false, removeKey: false });
      expect(r.secretPrompts).toEqual([]);
      expect(text(r)).toContain("Every sign-in will ask for the second factor.");
    }
  });

  it("2: remember on, and never prompts for a key", async () => {
    const r = script(["2"]);
    expect(await askShortcutQuestion(r.io, first)).toEqual({ rememberMfa: true, removeKey: false });
    expect(r.secretPrompts).toEqual([]);
  });

  it("3 with a valid key: remember on, shows the how-to, returns a normalized enrollment", async () => {
    const r = script(["3", KEY]);
    const a = await askShortcutQuestion(r.io, first);
    expect(a).toEqual({
      rememberMfa: true,
      removeKey: false,
      totpUri: `otpauth://totp/alice?secret=${KEY}`,
    });
    const t = text(r);
    expect(t).toContain("https://mysignins.microsoft.com");
    expect(t).toContain("I want to use a different authenticator app");
    expect(t).toContain("Can't scan image?");
    expect(r.secretPrompts).toHaveLength(1);
  });

  it("3 re-asks on a malformed key, then accepts a good one", async () => {
    const r = script(["3", "not a key!!", KEY]);
    const a = await askShortcutQuestion(r.io, first);
    expect(a?.totpUri).toBe(`otpauth://totp/alice?secret=${KEY}`);
    expect(r.secretPrompts).toHaveLength(2);
    expect(text(r)).toContain("That is not a setup key");
  });

  it("3 then Enter with no key saved says it equals option 2 and saves as option 2", async () => {
    const r = script(["3", ""]);
    const a = await askShortcutQuestion(r.io, first);
    expect(a).toEqual({ rememberMfa: true, removeKey: false });
    expect(text(r)).toContain("Without a key, option 3 is the same as option 2");
    expect(text(r)).toContain("saved as option 2");
  });
});

describe("the one 2FA question: a key is already saved", () => {
  const saved: ShortcutQuestionInput = { username: "alice", rememberMfa: true, keySaved: true, savedConfig: true };

  it.each([["1", false], ["2", true]])("%s asks to remove it and removes on yes (default)", async (choice, remember) => {
    for (const reply of ["", "yes", "y"]) {
      const r = script([choice, reply]);
      expect(await askShortcutQuestion(r.io, saved)).toEqual({ rememberMfa: remember, removeKey: true });
      expect(r.prompts[1]).toBe("  Remove the saved authenticator key from this computer? (yes/no) [yes]: ");
    }
  });

  it.each([["1", false], ["2", true]])("%s keeps it on no, and says codes are still answered automatically", async (choice, remember) => {
    const r = script([choice, "no"]);
    expect(await askShortcutQuestion(r.io, saved)).toEqual({ rememberMfa: remember, removeKey: false });
    expect(text(r)).toContain("still answered automatically");
  });

  it("re-asks the remove question on an unclear answer", async () => {
    const r = script(["1", "maybe", "no"]);
    await askShortcutQuestion(r.io, saved);
    expect(text(r)).toContain("Please enter yes or no.");
  });

  it("3 with Enter keeps the saved key and asks for no new one beyond that", async () => {
    const r = script(["3", ""]);
    expect(await askShortcutQuestion(r.io, saved)).toEqual({ rememberMfa: true, removeKey: false });
    expect(r.secretPrompts).toHaveLength(1);
    expect(r.secretPrompts[0]).toContain("Enter to keep");
    expect(text(r)).not.toContain("mysignins");
    expect(text(r)).toContain("Keeping the saved key");
  });

  it("3 with a new key replaces the saved one", async () => {
    const r = script(["3", KEY]);
    const a = await askShortcutQuestion(r.io, saved);
    expect(a?.totpUri).toBe(`otpauth://totp/alice?secret=${KEY}`);
    expect(a?.removeKey).toBe(false);
  });
});

describe("the one 2FA question: running setup again", () => {
  it.each([
    [{ rememberMfa: false, keySaved: false }, "1", "Currently: 1 — every time"],
    [{ rememberMfa: true, keySaved: false }, "2", "Currently: 2 — remember this computer"],
    [{ rememberMfa: true, keySaved: true }, "3", "Currently: 3 — this computer answers code requests"],
  ])("shows what is on now and makes it the Enter default (%j)", async (state, n, line) => {
    const r = script([""]);
    const a = await askShortcutQuestion(r.io, { username: "alice", savedConfig: true, ...state });
    expect(text(r)).toContain(line);
    expect(r.prompts[0]).toBe(`  Choose 1, 2 or 3 [${n}]: `);
    expect(a?.rememberMfa).toBe(state.rememberMfa);
  });

  it("does not claim a current state on the very first run", async () => {
    const r = script([""]);
    await askShortcutQuestion(r.io, first);
    expect(text(r)).not.toContain("Currently:");
  });

  it("Enter on 'remember' with no key does not ask about keys at all", async () => {
    const r = script([""]);
    const a = await askShortcutQuestion(r.io, { username: "alice", rememberMfa: true, keySaved: false, savedConfig: true });
    expect(a).toEqual({ rememberMfa: true, removeKey: false });
    expect(r.secretPrompts).toEqual([]);
    expect(r.prompts).toHaveLength(1);
  });

  it("Enter never turns remember-this-device on for someone who only had a key saved", async () => {
    const r = script([""]);
    const a = await askShortcutQuestion(r.io, { username: "alice", rememberMfa: false, keySaved: true, savedConfig: true });
    expect(a).toEqual({ rememberMfa: false, removeKey: false });
  });
});

describe("the one 2FA question: which options apply", () => {
  it("skips the question entirely when neither applies", async () => {
    const r = script([]);
    expect(await askShortcutQuestion(r.io, { ...first, applicable: { remember: false, key: false } })).toBeNull();
    expect(r.transcript).toEqual([]);
  });

  it("offers only 'every time' and 'remember' (renumbered) when the key does not apply", async () => {
    const r = script(["2"]);
    const a = await askShortcutQuestion(r.io, { ...first, applicable: { remember: true, key: false } });
    expect(a).toEqual({ rememberMfa: true, removeKey: false });
    expect(text(r)).not.toContain("3.");
    expect(text(r)).toContain("Option 2 is not for shared computers.");
    expect(r.prompts).toEqual(["  Choose 1 or 2 [1]: "]);
  });

  it("offers only 'every time' and the key (as 2) when remember does not apply", async () => {
    const r = script(["2", KEY]);
    const a = await askShortcutQuestion(r.io, { ...first, applicable: { remember: false, key: true } });
    expect(a).toEqual({ rememberMfa: false, removeKey: false, totpUri: `otpauth://totp/alice?secret=${KEY}` });
    expect(text(r)).toContain("2. Almost never");
  });

  it("with no remember option, an empty key falls back to option 1", async () => {
    const r = script(["2", ""]);
    const a = await askShortcutQuestion(r.io, { ...first, applicable: { remember: false, key: true } });
    expect(a).toEqual({ rememberMfa: false, removeKey: false });
    expect(text(r)).toContain("same as option 1");
  });
});

describe("the one 2FA question: secrets", () => {
  it("never prints the key, in any form, on any path", async () => {
    const paths: [string[], ShortcutQuestionInput][] = [
      [["3", KEY], first],
      [["3", `otpauth://totp/alice?secret=${KEY}`], first],
      [["3", "bad", KEY], first],
      [["3", KEY], { ...first, keySaved: true, rememberMfa: true, savedConfig: true }],
      [["1", "yes"], { ...first, keySaved: true, rememberMfa: true, savedConfig: true }],
    ];
    for (const [answers, input] of paths) {
      const r = script(answers);
      await askShortcutQuestion(r.io, input);
      expect(text(r)).not.toContain(KEY);
      expect(text(r)).not.toContain("otpauth://totp");
    }
  });
});

describe("the one 2FA question: transcripts", () => {
  it("first run, choosing 3 with a key", async () => {
    const r = script(["3", KEY]);
    await askShortcutQuestion(r.io, first);
    expect(text(r)).toMatchSnapshot();
  });

  it("rerun with option 2 on, pressing Enter", async () => {
    const r = script([""]);
    await askShortcutQuestion(r.io, { username: "alice", rememberMfa: true, keySaved: false, savedConfig: true });
    expect(text(r)).toMatchSnapshot();
  });
});

describe("the one 2FA question: docs", () => {
  const read = (p: string) => readFileSync(path.join(__dirname, "..", "..", p), "utf-8");

  it("describe the single question, its three options, and turning off by picking 1", () => {
    for (const file of ["docs/sign-in.md", "README.md", "LLMs.md"]) {
      const t = read(file);
      expect(t).toContain("How often do you want to approve sign-ins on your phone?");
    }
    const doc = read("docs/sign-in.md");
    expect(doc).toContain("1. Every time");
    expect(doc).toContain("2. Remember this computer");
    expect(doc).toContain("3. This computer answers code requests");
    expect(doc).toContain("pick **1**");
    expect(doc).toContain("remove it from this computer's credential store");
    expect(doc).not.toContain("answer **no** to remember-this-device");
  });
});
