# Signing in

There's no login step — asking a question signs you in. This page covers what happens when a session lapses, how MFA is handled, the per-school details, and the browser-free escape hatches.

## Normal days

Tokens renew over HTTPS, and a background browser silently replays your saved Microsoft session (silent SSO) if it lapses.

## When MFA is asked

The number to approve shows up right in the tool's response, and sign-in finishes in the background — approve it, call the tool again, and use the newest number if one goes stale. TOTP apps (Google Authenticator, etc.) get prompted via the terminal; visible-browser mode opens a window instead, though automatic recovery during a tool call still runs headless unless you set `D2L_HEADLESS=false`.

If a second app (say Claude Desktop and a terminal session) is signed in to the same account, it waits on the first app's sign-in instead of asking again: approve the number once and both carry on.

**Duo:** sign-in auto-answers "Is this your device?" with **yes**, since a headless run has nobody to click it — this also makes Duo remember the device, so skip it on shared machines. Set `D2L_DUO_PASSCODE` to swap the push for a typed passcode.

To be asked less often, see [Fewer 2FA prompts](#fewer-2fa-prompts).

## Passwordless sign-in

Setup no longer offers this; it always saves your password. It is still available for anyone who sets `D2L_PASSWORDLESS=true` in their AI client's config for this server: sign-in then submits only your username, no password is read, and Microsoft's passwordless phone approval (the number you type into Authenticator) is the whole sign-in. Microsoft Entra only, and passwordless phone sign-in must already be on in Microsoft Authenticator.

Every sign-in then needs your phone, including automatic ones after a session expires, so it doesn't suit anything unattended. If Microsoft asks for a password anyway, sign-in stops with an error naming `D2L_PASSWORDLESS`; remove the setting and rerun `setup`.

## Fewer 2FA prompts

`setup` asks one question: **How often do you want to approve sign-ins on your phone?** The default is the safest answer. The other two are opt-in, and neither is for a shared computer.

| | 1. Every time | 2. Remember this computer | 3. This computer answers code requests |
|---|---|---|---|
| What it does | Nothing is skipped. | Ticks Microsoft's **"Don't ask again"** box when your school offers it. | Types the 6-digit code for you when Microsoft asks for one. |
| What you'll notice | You approve every sign-in Microsoft asks about. | Fewer prompts. How long it lasts is your school's setting, so you still approve now and then. | Automatic sign-ins finish with nothing from your phone. |
| Needs | Nothing (default). | Nothing extra. | The authenticator **setup key** (steps below), about 2 minutes. |
| Where it lives | | `rememberMfa` in `config.json` (`D2L_REMEMBER_MFA` overrides it). | Your operating system's credential store, next to your password (`D2L_TOTP_SECRET` for CI and containers with none). |

Option 3 also turns option 2 on, so you get both. It only helps when Microsoft asks for a 6-digit code: if your school only sends a number to approve and offers no code option, sign-in falls back to your phone exactly as it does today. If you pick 3 and press Enter without pasting a key, `setup` says so and saves option 2.

**Turn on:** run `npx -y brightspace-mcp-server@latest setup` again and pick 2 or 3. `setup` shows what is on now ("Currently: 2 — remember this computer") and Enter keeps it.

**Turn off:** run `setup` again and pick **1**. If an authenticator key is saved, `setup` then asks whether to remove it from this computer's credential store (default yes); answering no keeps the key, which means Microsoft's code requests are still answered automatically. Check what is on any time with `npx -y brightspace-mcp-server@latest doctor`.

**Shared computer:** pick 1. Option 2 lets anyone using your account here skip the second factor, and option 3 puts your password and second factor on the same machine.

### Getting the setup key

Microsoft calls it a *software OATH token*. Only the **setup key** works; a code showing in your app right now will not.

1. Go to <https://mysignins.microsoft.com> → **Security info** → **Add sign-in method** → **Authenticator app**.
2. Choose **I want to use a different authenticator app**, then **Next**.
3. On the QR page, click **Can't scan image?** Microsoft shows a **secret key**. Copy it.
4. Finish enrollment in whatever app you normally use, so you still have the factor on your phone.
5. Run `setup`, pick option 3, and paste the key (or the whole `otpauth://` link) at the authenticator prompt.

Purdue allows this and documents it in its own knowledge base (KB 2219). Other schools may not, so check your own IT policy first.

### Details

- **Remember this device:** `get_server_info` shows whether the box was ticked, already on, not offered, or left alone. How often MFA is asked at all is your school's sign-in frequency setting, the same approval you'd see in a regular browser.
- **Saved key:** it is never written to `config.json` and never logged (neither is any code generated from it). `D2L_TOTP_SECRET` is weaker, because anything that can read this process's environment gets your second factor.
- **The tradeoff, plainly:** a password and a second factor on the same computer are one factor on that computer. This still defeats someone who has only your password, from anywhere else, and it changes nothing about your other devices, but it defends against nothing already running as you on this machine. That is why it is opt-in.
- **If your tenant offers no way to type a code,** sign-in gives up on the code after half a minute and goes back to announcing the approval for you to tap, exactly as it does with no key saved. A Duo challenge is left alone (Duo codes come from a different enrollment), and so is Microsoft's passwordless approval view, where the phone *is* the first factor and no code can stand in for it. If Microsoft shows that approval view only because phone sign-in is turned on in your Authenticator app, and you have a password saved with the `passwordless` option off, sign-in takes "Use your password instead" so the code can answer the second factor that follows.
- **Signing out early** keeps a saved key, so the next sign-in can finish without you; see [Signing out early](#signing-out-early).

## If it gets stuck

A missed MFA approval pauses automatic sign-in for 5 minutes. This retries immediately, takes over a stuck sign-in, or asks for a code:

```bash
npx -y brightspace-mcp-server@latest auth
```

Run it from your home folder — macOS blocks `npx` from Documents, Desktop, or Downloads without Files and Folders permission (`EPERM`). Grant access in System Settings → Privacy & Security → Files and Folders, or run elsewhere.

## Signing out early

To end the saved session before it lapses (on a shared computer, say) or to force a fresh sign-in, run:

```bash
npx -y brightspace-mcp-server@latest auth --logout
```

This deletes the saved session files for your configured account on this computer (it prints their names), so the next question, or `auth`, does a full sign-in. It keeps your saved password, `config.json`, and any authenticator or credential-store entries. It is a local sign-out only: it does not sign you out of Microsoft or Brightspace on their servers, so a browser you used elsewhere stays signed in.

Or just ask your AI app to sign you out of Brightspace; it does the same thing.

Other AI apps open on this computer are signed out too and will ask you to sign in on their next question. (An app you opened before updating may keep answering for up to an hour; quit and reopen it to sign it out right away.) Your saved password and authenticator key stay, so with a saved authenticator key the next sign-in can finish without you; on a shared computer, also delete the saved `brightspace-mcp-server` entries from your computer's password store (Keychain Access on a Mac, Credential Manager on Windows). If a sign-in is in progress it refuses and deletes nothing: wait for it to finish, then run it again. With nothing saved it says so and succeeds, so it is safe to run twice.

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
| Any other D2L school | none | Run `setup` with no flag and paste your Brightspace URL (for example `https://yourschool.brightspace.com`). If the login page isn't recognized, answer 2 ("Another way") to setup's sign-in question: the page then opens for you to finish by hand when you sign in with `setup` or `auth`. With 1, an unrecognized page stops with an error. |

The setup wizard saves your password in the native credential store and asks how you confirm it's you: 1, a phone app (tap Approve or type a code in the terminal), or 2, another way such as a text message, which shows you the sign-in page to finish yourself. The page only opens when you sign in with `setup` or `auth`; automatic sign-ins later always run in the background. It can also configure Claude Desktop, Cursor, Codex Desktop and CLI, and Claude Code when installed — restart your AI client when it finishes.

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
