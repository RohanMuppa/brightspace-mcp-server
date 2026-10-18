/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Command-line flags for `setup`. Three modes share one entry point:
 *
 * - wizard (no mode flag): the interactive setup a person runs start to finish.
 * - `--prepare`: everything an AI agent can do without the person — checks,
 *   Chromium, saved settings, registering the server in AI apps. Never reads
 *   stdin and never asks for a password.
 * - `--sign-in`: the person's last step. Uses what prepare saved and asks
 *   only what needs them (password, how they confirm sign-in), then signs in.
 */

import { SCHOOL_PRESETS, presetForFlag, type SchoolPreset } from "./presets.js";

export type SetupMode = "wizard" | "prepare" | "sign-in";

export interface SetupArgs {
  /** The school flag (`purdue`, `suny`, ...) when one was given. */
  school?: string;
  preset?: SchoolPreset;
  mode: SetupMode;
  url?: string;
  username?: string;
  campus?: string;
  json: boolean;
  replace: boolean;
  installBrowser: boolean;
  help: boolean;
}

export type ParsedSetupArgs = { ok: true; args: SetupArgs } | { ok: false; error: string };

const VALUE_FLAGS = new Set(["url", "username", "campus"]);
const BOOLEAN_FLAGS = new Set(["prepare", "sign-in", "json", "replace", "no-browser-install", "help"]);

export const SETUP_USAGE = `Usage: brightspace-mcp-server setup [--<school>] [options]

Schools: ${Object.keys(SCHOOL_PRESETS).map((flag) => `--${flag}`).join(", ")}

Modes:
  (none)                 Interactive setup, start to finish
  --prepare              For AI agents: get everything ready without asking
                         for a password or opening a sign-in (no prompts)
  --sign-in              The last step, for the person: password and sign-in

Options:
  --url <address>        Your school's Brightspace address, when it has no flag above
  --username <name>      The username you sign in with (prepare, sign-in)
  --campus <name>        SUNY campus (prepare, sign-in)
  --json                 Print the prepare result as JSON on stdout
  --replace              Replace a "brightspace" entry that runs something else
  --no-browser-install   Don't download Chromium during prepare
  --help                 Show this help`;

/**
 * Read `setup`'s flags. `argv` is the full process.argv: the subcommand name
 * is skipped when present (`brightspace-mcp-server setup ...`) and absent for
 * the `brightspace-setup` bin. Both `--url x` and `--url=x` work. An unknown
 * flag is an error rather than ignored, so an agent that mistypes `--prepare`
 * is told so instead of landing in a wizard that waits for typing.
 */
export function parseSetupArgs(argv: string[] = process.argv): ParsedSetupArgs {
  const tokens = argv.slice(2);
  if (tokens[0] === "setup") tokens.shift();

  const args: SetupArgs = { mode: "wizard", json: false, replace: false, installBrowser: true, help: false };
  const modes: SetupMode[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-h") {
      args.help = true;
      continue;
    }
    if (!token.startsWith("--")) return { ok: false, error: `Unexpected argument: ${token}` };

    const eq = token.indexOf("=");
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).toLowerCase();
    const inline = eq === -1 ? undefined : token.slice(eq + 1);

    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? tokens[++i];
      if (value === undefined || value.startsWith("--") || !value.trim()) {
        return { ok: false, error: `--${name} needs a value.` };
      }
      if (name === "url") args.url = value.trim();
      else if (name === "username") args.username = value.trim();
      else args.campus = value.trim();
      continue;
    }

    if (inline !== undefined) return { ok: false, error: `--${name} does not take a value.` };

    if (BOOLEAN_FLAGS.has(name)) {
      if (name === "prepare") modes.push("prepare");
      else if (name === "sign-in") modes.push("sign-in");
      else if (name === "json") args.json = true;
      else if (name === "replace") args.replace = true;
      else if (name === "no-browser-install") args.installBrowser = false;
      else args.help = true;
      continue;
    }

    const preset = presetForFlag(name);
    if (!preset) return { ok: false, error: `Unknown option: --${name}` };
    if (args.preset && args.preset !== preset) return { ok: false, error: "Pass only one school flag." };
    args.school = name;
    args.preset = preset;
  }

  if (modes.length > 1) return { ok: false, error: "Use either --prepare or --sign-in, not both." };
  if (modes.length === 1) args.mode = modes[0];
  if (args.preset && args.url) return { ok: false, error: "Pass either a school flag or --url, not both." };
  if (args.json && args.mode !== "prepare") return { ok: false, error: "--json works only with --prepare." };

  return { ok: true, args };
}
