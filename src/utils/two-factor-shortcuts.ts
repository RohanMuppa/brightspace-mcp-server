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

import { SETUP_COMMAND } from "./commands.js";

/** The single docs section that explains both options. */
export const SHORTCUTS_DOCS_URL =
  "https://github.com/RohanMuppa/brightspace-mcp-server/blob/main/docs/sign-in.md#fewer-2fa-prompts";

/** Shown in `setup` just above the optional authenticator-key prompt. */
export const KEY_HOWTO_LINES: readonly string[] = [
  "  How to get the key: open https://mysignins.microsoft.com > Security info > Add sign-in method > Authenticator app,",
  "  choose \"I want to use a different authenticator app\", then \"Can't scan image?\" and copy the secret key.",
  `  Step-by-step and tradeoffs: ${SHORTCUTS_DOCS_URL}`,
];

/** The `setup` authenticator-key prompt. Enter skips it, or keeps a key saved earlier. */
export const KEY_PROMPT = "  Authenticator setup key or otpauth:// link (Enter = skip, or keep the one already saved): ";

/** Shown in `setup` under the remember-this-device question. */
export const REMEMBER_DEVICE_DIFFERENCE =
  "  Different from the authenticator key above: this ticks Microsoft's \"Don't ask again\" box, so you still approve now and then.";

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
