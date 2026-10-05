# Signing in

There's no login step — asking a question signs you in. This page covers what happens when a session lapses, how MFA is handled, the per-school details, and the browser-free escape hatches.

## Normal days

Tokens renew over HTTPS, and a background browser silently replays your saved Microsoft session (silent SSO) if it lapses.

## When MFA is asked

The number to approve shows up right in the tool's response, and sign-in finishes in the background — approve it, call the tool again, and use the newest number if one goes stale. TOTP apps (Google Authenticator, etc.) get prompted via the terminal; visible-browser mode opens a window instead, though automatic recovery during a tool call still runs headless unless you set `D2L_HEADLESS=false`.

**Duo:** sign-in auto-answers "Is this your device?" with **yes**, since a headless run has nobody to click it — this also makes Duo remember the device, so skip it on shared machines. Set `D2L_DUO_PASSCODE` to swap the push for a typed passcode.

**Microsoft "Don't ask again":** answering yes to `setup`'s "Remember this device" question (saved as `rememberMfa` in `config.json`; `D2L_REMEMBER_MFA` overrides it) makes the server tick that box when your school offers it, so later sign-ins can skip the second factor; how long that lasts is the school's setting, not the server's. It is off by default — leave it off on a shared machine — and `get_server_info` shows whether the box was ticked, offered, or left alone. How often you're asked for MFA at all is your school's sign-in frequency setting, the same approval you'd see in a regular browser.

## If it gets stuck

A missed MFA approval pauses automatic sign-in for 5 minutes. This retries immediately, takes over a stuck sign-in, or asks for a code:

```bash
npx -y brightspace-mcp-server@latest auth
```

Run it from your home folder — macOS blocks `npx` from Documents, Desktop, or Downloads without Files and Folders permission (`EPERM`). Grant access in System Settings → Privacy & Security → Files and Folders, or run elsewhere.

## Per-school notes

| School | Preset | Notes |
|--------|--------|-------|
| Purdue | `--purdue` | Microsoft Entra: number matching, authenticator code, or visible browser. |
| SUNY | `--suny` | Campuses share one Brightspace site; the preset asks which campus you're at and skips SUNY's campus picker at sign-in. |
| Western University | `--western` | Microsoft Entra. |
| TU Delft | `--tudelft` | Use your NetID, not your student email. Headless NetID username and password sign-in only, including automatic re-authentication when the saved session expires; it does not support MFA or any other interactive step. If your account requires one, [open an issue](https://github.com/RohanMuppa/brightspace-mcp-server/issues). |
| CUNY | `--cuny` | Sign in with your full CUNY Login address (`firstname.lastname01@login.cuny.edu`); authentication asks in the terminal for the 6-digit code from your authenticator app. CUNY asks for that code on every full sign-in, so when your Brightspace session ends, run `npx -y brightspace-mcp-server@latest auth` in a terminal again. |
| Leiden University | `--leiden` | Sign in with your full Microsoft address (for example `s1234567@vuw.leidenuniv.nl`). The flow picks Leiden University (Entra) on SURFconext's account page, then uses the same Microsoft sign-in as Purdue. Leiden normally asks for a code from your authenticator app, which `auth` prompts for in the terminal. |
| McGill University | `--mcgill` | Microsoft Entra; myCourses sends you straight to Entra via SAML. |
| Javeriana Cali | `--javeriana` | MobilityGuard OneGate: password, then an authenticator code that `auth` prompts for in the terminal. Headless sign-in needs the terminal prompt; otherwise use the visible browser. |
| Ngee Ann Polytechnic | `--ngeeann` | Plain Microsoft Entra, no extra steps. |
| Any other D2L school | none | Run `setup` with no flag and paste your Brightspace URL (for example `https://yourschool.brightspace.com`). An unsupported login page falls back to a visible browser window you complete by hand. |

The setup wizard saves your password in the native credential store and asks how you'll complete MFA: wait for approval or number matching, enter a terminal code from an authenticator app, or use a visible browser for other interactive methods. It can also configure Claude Desktop, Cursor, Codex Desktop and CLI, and Claude Code when installed — restart your AI client when it finishes.

## No browser? Paste a session cookie or token

The normal setup drives a real (usually hidden) browser through sign-in, which doesn't work in Docker, headless Linux, WSL without a display, or on a tenant whose MFA requires a hardware security key. Two environment variables skip the browser entirely; set one and leave the normal setup untouched:

- **`D2L_SESSION_COOKIE`** — the `d2lSessionVal` and `d2lSecureSessionVal` cookies from a browser tab where you're already signed in to Brightspace. In Chrome DevTools: open your Brightspace site, **F12 → Application → Cookies**, find `d2lSessionVal` and `d2lSecureSessionVal`, and set the variable to either form:
  ```bash
  export D2L_SESSION_COOKIE="d2lSessionVal=<value>; d2lSecureSessionVal=<value>"
  # or just the two values, in that order:
  export D2L_SESSION_COOKIE="<d2lSessionVal>;<d2lSecureSessionVal>"
  ```
- **`D2L_ACCESS_TOKEN`** — a pre-issued Bearer token (an admin-issued Valence token, or one minted by a TA script):
  ```bash
  export D2L_ACCESS_TOKEN="<token>"
  ```

Set either in your MCP client's `env` config instead of a shell export if you're not running the server from a terminal. If both are set, `D2L_ACCESS_TOKEN` wins.

If this is a Docker or other headless setup with no `~/.brightspace-mcp/config.json` on disk, also set **`D2L_BASE_URL`** to your school's Brightspace URL — with no config file to read it from, the server otherwise defaults to Purdue's.

**The catch:** neither one renews itself. A pasted session cookie dies at D2L's own idle timeout (the same timeout that would eventually log you out in a browser), and a pre-issued token dies whenever it expires or is revoked. When that happens the server does **not** fall back to a browser login — it answers with an error telling you to paste a fresh value. There's no in-between: this is a deliberate escape hatch for environments that can't run a browser at all, not a way to skip typing your password once.

## What's stored where

Your password is saved in your operating system's native credential store (macOS Keychain, Windows Credential Manager, or Linux Secret Service) — never in a plaintext file. Session state on disk is encrypted with AES-256-GCM. None of the server's tools submit, edit, or delete anything in your courses; they only read. The second factor itself (an approval tap, a number match, or a TOTP code) stays on your phone or authenticator app — the server never sees or stores it.
