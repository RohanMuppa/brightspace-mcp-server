/**
 * Brightspace MCP Server. Copyright (c) 2026 Rohan Muppa. MIT licensed.
 *
 * The two opt-in ways to be asked for 2FA less often, described in one place.
 * `setup`, the MFA hint in tool responses, and `doctor` all take their wording
 * from here so they cannot drift apart, and all point at the one docs section
 * that explains both options side by side.
 *
 *   A) Remember this device: `rememberMfa` / D2L_REMEMBER_MFA.
 *   B) Saved authenticator key: the OS keychain entry (or D2L_TOTP_SECRET).
 *
 * Both are off by default. Nothing here changes what either one does, and
 * nothing here ever sees, prints, or derives anything from the key itself:
 * callers pass only whether one exists.
 */

import { normalizeTotpEnrollment } from "../auth/totp.js";
import { SETUP_COMMAND } from "./commands.js";

/** The single docs section that explains both options. */
export const SHORTCUTS_DOCS_URL =
  "https://github.com/RohanMuppa/brightspace-mcp-server/blob/main/docs/sign-in.md#fewer-2fa-prompts";

/** Shown in `setup` when option 3 is chosen and no key is saved yet. */
export const KEY_HOWTO_LINES: readonly string[] = [
  "  How to get the key: open https://mysignins.microsoft.com > Security info > Add sign-in method > Authenticator app,",
  "  choose \"I want to use a different authenticator app\", then \"Can't scan image?\" and copy the secret key.",
];

/** The key prompt when no key is saved. Enter means none. */
export const KEY_PROMPT = "  Authenticator setup key or otpauth:// link (Enter = none): ";

/** The key prompt when a key is already saved. Enter keeps it. */
export const KEY_PROMPT_KEEP =
  "  Paste a new setup key or otpauth:// link to replace the saved one (Enter to keep it): ";

// ── The one setup question ──────────────────────────────────────────

/** The three answers, from least to most skipping. */
export type ShortcutChoice = "every" | "remember" | "key";

/** Which options this school and mode can use. Both default to true. */
export interface ShortcutApplicability {
  remember: boolean;
  key: boolean;
}

export interface ShortcutQuestionInput {
  /** Names the account inside a bare setup key; never printed. */
  username: string;
  /** `rememberMfa` as currently saved. */
  rememberMfa: boolean;
  /** Whether a key is already saved for this account. A boolean: the key is never read here. */
  keySaved: boolean;
  /** True when setup has run before, so "Currently: ..." is worth showing. */
  savedConfig: boolean;
  applicable?: ShortcutApplicability;
}

/** The terminal, as the question sees it. `askSecret` must not echo. */
export interface ShortcutIO {
  ask(prompt: string): Promise<string>;
  askSecret(prompt: string): Promise<string>;
  print(line: string, tone?: "plain" | "dim" | "warn"): void;
}

export interface ShortcutAnswer {
  rememberMfa: boolean;
  /** A new enrollment to save. Absent: leave any saved key alone. */
  totpUri?: string;
  /** Delete the saved key from the credential store. */
  removeKey: boolean;
}

const OPTION_TEXT: Record<ShortcutChoice, string> = {
  every: "Every time Microsoft asks",
  remember: "Less often: Microsoft remembers this computer for a while (your school decides how long)",
  key: "Almost never: this computer answers Microsoft's code requests itself (needs a key from Microsoft, about 2 minutes)",
};

const CURRENT_NAME: Record<ShortcutChoice, string> = {
  every: "every time",
  remember: "remember this computer",
  key: "this computer answers code requests",
};

function currentChoice(input: ShortcutQuestionInput): ShortcutChoice {
  return input.keySaved ? "key" : input.rememberMfa ? "remember" : "every";
}

async function askYesNo(io: ShortcutIO, prompt: string, fallback: "yes" | "no"): Promise<boolean> {
  while (true) {
    const answer = (await io.ask(prompt)) || fallback;
    if (/^(y(es)?|no?)$/i.test(answer)) return /^y/i.test(answer);
    io.print("  Please enter yes or no.", "warn");
  }
}

/**
 * The one question setup asks about being asked for 2FA less often. Replaces
 * the old pair (an optional key prompt, then a yes/no remember question).
 *
 * Returns null when no option applies, so nothing is asked. Everything the
 * user types or sees about the key goes through `io`; the key itself is only
 * handed to the normalizer and returned, never printed.
 */
export async function askShortcutQuestion(
  io: ShortcutIO,
  input: ShortcutQuestionInput,
): Promise<ShortcutAnswer | null> {
  const applicable = input.applicable ?? { remember: true, key: true };
  const choices: ShortcutChoice[] = ["every"];
  if (applicable.remember) choices.push("remember");
  if (applicable.key) choices.push("key");
  if (choices.length === 1) return null;

  const numberOf = (c: ShortcutChoice) => choices.indexOf(c) + 1;
  const numbers = choices.map((_, i) => String(i + 1));
  const list = numbers.length === 2 ? "1 or 2" : "1, 2 or 3";
  const current = currentChoice(input);
  const defaultChoice: ShortcutChoice = choices.includes(current) ? current : "every";
  const defaultNumber = String(numberOf(defaultChoice));

  io.print("  How often do you want to approve sign-ins on your phone?");
  for (const c of choices) {
    const suffix = c === "every" ? (defaultChoice === "every" ? " (default, safest)" : " (safest)") : "";
    io.print(`    ${numberOf(c)}. ${OPTION_TEXT[c]}${suffix}`);
  }
  if (choices.includes("remember")) {
    io.print(`  Option ${numberOf("remember")} ticks Microsoft's "Don't ask again" box, so you still approve now and then.`, "dim");
  }
  if (choices.includes("key")) {
    io.print(`  Option ${numberOf("key")} stores a key next to your password, so on this computer the two factors become one. It still stops anyone who only has your password.`, "dim");
    io.print("  It helps only when Microsoft asks for a 6-digit code. If your school only sends a number to approve, sign-in falls back to your phone.", "dim");
  }
  const skipping = choices.slice(1).map(numberOf).join(" and ");
  io.print(`  ${choices.length === 2 ? "Option" : "Options"} ${skipping} ${choices.length === 2 ? "is" : "are"} not for shared computers. Details: ${SHORTCUTS_DOCS_URL}`);
  if (input.savedConfig) {
    io.print(`  Currently: ${numberOf(defaultChoice)} \u2014 ${CURRENT_NAME[defaultChoice]}`, "dim");
  }

  let reply = "";
  let blank = false;
  while (!numbers.includes(reply)) {
    const raw = await io.ask(`  Choose ${list} [${defaultNumber}]: `);
    blank = raw === "";
    reply = raw || defaultNumber;
    if (!numbers.includes(reply)) io.print(`  Please enter ${list}.`, "warn");
  }
  let choice = choices[Number(reply) - 1]!;
  let removeKey = false;
  let totpUri: string | undefined;
  // Someone who saved a key without remember-this-device keeps exactly that on
  // Enter: remembering a device is opt-in and is never switched on by default.
  let rememberMfa =
    (choice === "remember" || (choice === "key" && applicable.remember)) &&
    !(blank && input.keySaved && !input.rememberMfa);

  if (choice === "key") {
    if (input.keySaved) {
      // Enter on "Currently: 3" is a plain keep; only an explicit 3 offers a replacement.
      if (!blank) totpUri = await askForKey(io, input.username, KEY_PROMPT_KEEP);
      if (totpUri === undefined) io.print("  Keeping the saved key.", "dim");
    } else {
      for (const line of KEY_HOWTO_LINES) io.print(line, "dim");
      totpUri = await askForKey(io, input.username, KEY_PROMPT);
      if (totpUri === undefined) {
        choice = applicable.remember ? "remember" : "every";
        rememberMfa = choice === "remember";
        io.print(
          `  No key entered. Without a key, option ${numberOf("key")} is the same as option ${numberOf(choice)}, so it is saved as option ${numberOf(choice)}.`,
          "warn",
        );
      }
    }
  } else if (input.keySaved) {
    io.print(
      "  A key is saved on this computer. Keeping it means Microsoft's code requests are still answered automatically.",
      "dim",
    );
    removeKey = await askYesNo(io, "  Remove the saved authenticator key from this computer? (yes/no) [yes]: ", "yes");
  }

  io.print(
    choice === "every"
      ? "  Every sign-in will ask for the second factor."
      : choice === "remember"
        ? "  Later sign-ins will ask Microsoft not to repeat the second factor on this device."
        : "  This computer will answer Microsoft's code requests itself.",
    "dim",
  );
  return { rememberMfa, removeKey, ...(totpUri ? { totpUri } : {}) };
}

/** Prompt (hidden) until a valid key, or Enter. Undefined means none was given. */
async function askForKey(io: ShortcutIO, username: string, prompt: string): Promise<string | undefined> {
  while (true) {
    const input = await io.askSecret(prompt);
    if (!input) return undefined;
    try {
      return normalizeTotpEnrollment(input, username);
    } catch {
      io.print("  That is not a setup key or otpauth:// link. Paste the enrollment key, or press Enter for none.", "warn");
    }
  }
}

/** What this machine has turned on. Booleans only: no key, no value derived from one. */
export interface ShortcutState {
  rememberMfa: boolean;
  /** "unknown" when the credential store could not be read cheaply. */
  keySaved: boolean | "unknown";
}

let current: { rememberMfa: boolean; keySaved: boolean } | undefined;

/**
 * Record, once at startup, which shortcuts are on. Until this is called the
 * state is unknown and no hint is ever shown, so nothing else is affected.
 */
export function setActiveShortcuts(state: { rememberMfa: boolean; keySaved: boolean }): void {
  current = { rememberMfa: state.rememberMfa, keySaved: state.keySaved };
}

/** Test seam: forget the recorded state. */
export function resetActiveShortcuts(): void {
  current = undefined;
}

/**
 * One short line appended to the MFA approval message, only when the user has
 * neither shortcut on. Empty string otherwise (including when unknown).
 */
export function mfaShortcutTip(): string {
  if (!current || current.rememberMfa || current.keySaved) return "";
  return `Tip for the user: to be asked less often, rerun \`${SETUP_COMMAND}\` - see ${SHORTCUTS_DOCS_URL}`;
}

/** The one `doctor` line. Mentions the docs link only when both are off. */
export function describeShortcuts(state: ShortcutState): string {
  const device = `remember this device ${state.rememberMfa ? "on" : "off"}`;
  const key =
    state.keySaved === "unknown"
      ? "authenticator key not checked"
      : `authenticator key ${state.keySaved ? "saved" : "not saved"}`;
  const bothOff = !state.rememberMfa && state.keySaved === false;
  return `2FA shortcuts: ${device}, ${key}.${bothOff ? ` Want fewer prompts? See ${SHORTCUTS_DOCS_URL}` : ""}`;
}
