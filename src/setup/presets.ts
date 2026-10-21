/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// ── School presets ──────────────────────────────────────────────────

export interface SchoolPreset {
  name: string;
  baseUrl: string;
  usernameLabel: string;
  mfaNote: string;
  /** Asked only by shared instances that host several campuses. */
  campusPrompt?: string;
  /** Shown above the username prompt when the expected format is not obvious. */
  usernameHint?: string;
}

export const SCHOOL_PRESETS: Record<string, SchoolPreset> = {
  tudelft: {
    name: "TU Delft",
    baseUrl: "https://brightspace.tudelft.nl",
    usernameLabel: "TU Delft NetID",
    mfaNote: "NetID sign-in normally runs headlessly without MFA.",
    usernameHint: "Use your NetID, not your student email address.",
  },
  leiden: {
    name: "Leiden University",
    baseUrl: "https://brightspace.universiteitleiden.nl",
    usernameLabel: "Leiden University username",
    mfaNote: "Leiden usually asks for a code from your authenticator app, which you can type here.",
    usernameHint: "Use the full address you sign in to Microsoft with, e.g. s1234567@vuw.leidenuniv.nl.",
  },
  purdue: {
    name: "Purdue University",
    baseUrl: "https://purdue.brightspace.com",
    usernameLabel: "Purdue career account username or full email",
    mfaNote: "Microsoft Authenticator number matching can run without a browser window.",
  },
  suny: {
    name: "SUNY",
    baseUrl: "https://mylearning.suny.edu",
    usernameLabel: "SUNY campus username",
    mfaNote: "Approve the sign-in request from your campus MFA app.",
    campusPrompt: "Which SUNY campus are you at? (e.g. SUNY Poly)",
    usernameHint: "Most campuses want the full sign-in address, e.g. abc123@sunypoly.edu",
  },
  western: {
    name: "Western University",
    baseUrl: "https://westernu.brightspace.com",
    usernameLabel: "Western account username or full email",
    mfaNote: "Approve the sign-in request from your MFA app.",
    usernameHint: "Use your full sign-in address if your Western account requires it.",
  },
  cuny: {
    name: "CUNY",
    baseUrl: "https://brightspace.cuny.edu",
    usernameLabel: "CUNY Login username",
    mfaNote: "Type the 6-digit code from your authenticator app when prompted.",
    usernameHint: "Use your full CUNY Login address, e.g. firstname.lastname01@login.cuny.edu",
  },
  ngeeann: {
    name: "Ngee Ann Polytechnic",
    baseUrl: "https://nplms.polite.edu.sg",
    usernameLabel: "Ngee Ann Polytechnic account username or full email",
    mfaNote: "Approve the sign-in request from your MFA app.",
    usernameHint: "Use your full sign-in address if your Ngee Ann Polytechnic account requires it.",
  },
  mcgill: {
    name: "McGill University",
    baseUrl: "https://mycourses2.mcgill.ca",
    usernameLabel: "McGill username or full email",
    mfaNote: "Approve the sign-in request from your MFA app.",
    usernameHint: "Use your full sign-in address if your McGill account requires it.",
  },
  javeriana: {
    name: "Pontificia Universidad Javeriana Cali",
    baseUrl: "https://auladigital.javerianacali.edu.co",
    usernameLabel: "Javeriana username",
    mfaNote: "OneGate asks for a code from your authenticator app when you sign in.",
  },
};

/** The preset whose school runs at `baseUrl`, compared by origin. */
export function presetForBaseUrl(baseUrl: string): { flag: string; preset: SchoolPreset } | undefined {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
  for (const [flag, preset] of Object.entries(SCHOOL_PRESETS)) {
    if (new URL(preset.baseUrl).origin === origin) return { flag, preset };
  }
  return undefined;
}

/** The preset named by `flag` (no leading dashes), own properties only. */
export function presetForFlag(flag: string): SchoolPreset | undefined {
  const key = flag.toLowerCase();
  // A bare index would make `--constructor` or `--__proto__` resolve to
  // something off `Object.prototype` and hand setup an object with no `baseUrl`.
  return Object.prototype.hasOwnProperty.call(SCHOOL_PRESETS, key) ? SCHOOL_PRESETS[key] : undefined;
}
