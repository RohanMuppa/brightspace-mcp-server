# Troubleshooting

**Where to find logs:** MCP clients log the server's stderr themselves. On **macOS**, Claude Desktop writes to `~/Library/Logs/Claude/mcp*.log` (one file per server, plus `mcp.log` for the client itself). On **Windows**, it's `%APPDATA%\Claude\logs`, or `%LOCALAPPDATA%\Claude-Data\<package>\logs` for newer Microsoft Store installs, which keep their data (including `claude_desktop_config.json`) there instead. Other clients vary — check their own logs or output panel for the `brightspace-mcp-server` process.

**Works in a terminal but not in the client:** the client launches the server as its own subprocess, which doesn't inherit your shell's environment. Common causes: the native credential store is locked (a GUI app started before you unlocked your keyring or logged into macOS won't get a Keychain prompt the way a terminal does), `HOME` or `PATH` differ for GUI-launched processes versus your shell, or `npx` resolves a different cached version than the one on your `PATH`. To check, run the exact registered command (`npx -y brightspace-mcp-server@latest`, or `cmd /c npx -y brightspace-mcp-server@latest` on Windows) from a fresh terminal with no extra environment set, and compare.

**Every call fails with `Transport closed`:** that client's own server process has stopped (each client launches its own, so another client can keep working). The server's log says why: the client closed the connection, or the server exited with an error code. Restart or reconnect the Brightspace server in that client's MCP settings, or restart the client. A stray internal error is logged and no longer stops the server.

**Using the [shared server](shared-server.md) and every chat fails at once:** the `http` server is not running (clients never start it), or the chat's `D2L_HTTP_TOKEN` doesn't match the server's (it answers `401`). Look at the terminal running `http`: start it again if it stopped, and check that both see the same token. A `403` means the request came from a web page or through a host name other than `127.0.0.1` or `localhost`, which the server refuses on purpose.

**Which version am I running:** ask the assistant anything that calls `get_server_info` — it reports the running version, Node runtime, platform, config and session paths, school URL, whether a credential is stored, the local timezone and UTC offset (`localTimezone`, `utcOffsetMinutes`), who the session is signed in as when known (`signedInAs: { uniqueName, displayName }`), what Microsoft remembered (`microsoftSession`: stay-signed-in and its expiry, plus whether "Don't ask again" was ticked, already on, not offered, or left off because `D2L_REMEMBER_MFA` isn't set, with a `note` explaining that staying signed in to Microsoft doesn't by itself skip 2FA), and `requests` (lightweight counters: responses by status class, network errors, cache hits/misses, coalesced in-flight joins, and token refreshes) — all without contacting Brightspace or revealing secrets. On a source checkout, that version comes from the local `build/` output, so it only reflects your latest `npm run build`, not what's on npm.

**`npx` fails with `EPERM` on macOS:** run it from your home folder — macOS blocks `npx` from Documents, Desktop, or Downloads without Files and Folders permission. Grant access in System Settings → Privacy & Security → Files and Folders, or run elsewhere.

**Stuck on MFA:** a missed approval pauses automatic sign-in for 5 minutes; `npx -y brightspace-mcp-server@latest auth` retries immediately, takes over a stuck sign-in, or asks for a code. See [Signing in](sign-in.md), and [what each sign-in message means](#what-each-sign-in-message-means) below.

**Running from a source checkout or fork:** when a newer release is published, the server tells a source checkout to `git pull` and `npm run build` rather than to install the npm package. For a fork you maintain, set `D2L_NO_UPDATE_CHECK=1` in the server's environment to turn off upstream update notices.

**Using a client the wizard doesn't configure:** search your client's docs for how to add an MCP server; the command to register is `npx -y brightspace-mcp-server@latest` (on **Windows**, `cmd /c npx -y brightspace-mcp-server@latest`). You still need to run `npx -y brightspace-mcp-server@latest setup` first to save your credentials. For Codex Desktop and CLI: `codex mcp add brightspace -- npx -y brightspace-mcp-server@latest` (they share one user configuration; restart the desktop app or start a new CLI session). For Claude Code: `claude mcp add --scope user brightspace -- npx -y brightspace-mcp-server@latest`. Claude Desktop uses a separate configuration, which the setup wizard can update automatically.

## What each sign-in message means

When a sign-in can't finish in the chat, the assistant gets one of the kinds below (`AuthFailureKind` in `src/auth/auth-runner.ts`). Each kind has a text, from `src/tools/tool-helpers.ts`, that tells the assistant what to do next (`mfaPending` also carries the number to enter). The terminal `auth` run prints the same failure as a message and an exit code:

| Exit code | Kind | Source |
|-----------|------|--------|
| 0 | signed in | `src/auth/auth-exit-code.ts` |
| 1 | `failed` (also any code the server doesn't recognize) | `src/auth/auth-runner.ts` |
| 2 | `busy` | `src/auth/auth-exit-code.ts` |
| 3 | `cooldown` | `src/auth/auth-exit-code.ts` |
| 4 | `unsupported` (the chat shows `mfaHeld` instead when Microsoft held every prompt) | `src/auth/auth-runner.ts` |
| 5 | `secureStorage` | `src/auth/auth-exit-code.ts` |
| 6 | `transport` | `src/auth/auth-exit-code.ts` |
| 7 | `cooldown` (an MFA approval wasn't completed) | `src/auth/auth-exit-code.ts` |
| 8 | `browserInstall` | `src/auth/auth-exit-code.ts` |
| 9 | `dependencyMissing` | `src/auth/auth-exit-code.ts` |
| 10 | `stuck` | `src/auth/auth-exit-code.ts` |

### `mfaPending`

**When:** the sign-in is waiting for you to approve it. The answer shows a number to type into Microsoft Authenticator, or says to approve on your phone (Duo, or a tenant that shows no number).

**What is happening:** the sign-in has sent the prompt and waits up to 5 minutes for it. If the number expires or you deny it, the sign-in asks Microsoft for a new number by itself (see [When a number expires](sign-in.md#when-a-number-expires)).

**What to do:** approve on your phone, and give the user the number as text in the reply. Call the tool again straight away. Each call waits up to 45 seconds and returns when the sign-in completes. If the answer says the sign-in is already in progress, another call (possibly in another chat) has the number; retry once it completes. The line "to be asked less often" appears only when both 2FA shortcuts are off (see [Fewer 2FA prompts](sign-in.md#fewer-2fa-prompts)).

*Source: `src/tools/tool-helpers.ts` (`mfaPending` text, `MFA_ALREADY_REPORTED`), `src/auth/auth-runner.ts`.*

### `mfaHeld`

**When:** Microsoft shows **"We're having trouble verifying your account"** instead of a number. The answer says Microsoft is holding a new prompt and to try again in a minute.

**What is happening:** an earlier prompt for your account is still open. Microsoft refuses a new one until that prompt expires, up to 5 minutes after it was sent. The sign-in asks again every minute, so the hold ends with the first new number. Details are in [When Microsoft holds a prompt](sign-in.md#when-microsoft-holds-a-prompt).

**What to do:** tell the user nothing is waiting for approval yet. Call the tool again; each call waits up to 45 seconds for the new number. If a prompt you didn't start shows on the phone, the user should deny it. Cancelling the sign-in doesn't make Microsoft send one sooner.

*Source: `MFA_HELD_TEXT` and `HELD_RETRY_MS` in `src/auth/purdue-sso.ts`, `mfaHeldFailure` in `src/auth/auth-runner.ts`, `mfaHeld` text in `src/tools/tool-helpers.ts`.*

### `automaticPending`

**When:** the sign-in is entering a verification code itself, from an authenticator key saved with `setup` option 3 (or `D2L_TOTP_SECRET`). It shows about 15 seconds into the sign-in.

**What is happening:** no phone approval is being requested, so there is nothing for the user to approve.

**What to do:** don't ask the user to approve anything. Call the tool again right away. The call joins the same sign-in and returns when it completes.

*Source: `automaticPendingFailure` in `src/auth/auth-runner.ts`, `automaticPending` text in `src/tools/tool-helpers.ts`.*

### `inProgress`

**When:** a call has waited 55 seconds and the sign-in is still starting, before any prompt. The browser is opening, or the school's login pages are loading. A retry that joins a sign-in from another process can get this too.

**What is happening:** no prompt has been sent yet. Calling again picks up the same sign-in and doesn't start a second one.

**What to do:** call again right away. Don't ask the user to do anything yet.

*Source: `CALL_BUDGET_MS` and `withinCallBudget` in `src/auth/auth-runner.ts`, `inProgress` text in `src/tools/tool-helpers.ts`.*

### `cancelled`

**When:** the sign-in you were waiting on was stopped. `sign_out` cancelled it, its process was killed from outside, or the process that owned it closed.

**What is happening:** its prompt or number no longer works. Microsoft keeps that prompt open for up to 5 minutes and sends the account no other until then, so a new number can take that long.

**What to do:** call the tool again to start a new sign-in. Give the user the new number when an answer carries one.

*Source: `cancelledFailure` in `src/auth/auth-runner.ts`, `cancelled` text in `src/tools/tool-helpers.ts`, `src/tools/sign-out.ts`.*

### `cooldown`

**When:** automatic sign-in is paused because an MFA prompt went unanswered. Exit codes 3 and 7 both mean this.

**What is happening:** a 5-minute pause is saved in `auth-status.json` in the session folder (`MFA_COOLDOWN_MS` in `src/auth/auth-cooldown.ts`). Until it ends, tool calls send no prompt and get this answer. When it ends, the next call starts a new sign-in and sends a new prompt. A missed prompt starts the pause whichever way the sign-in was started, including a terminal `auth` run (see [the Ctrl-C known issue](#stopping-auth-with-ctrl-c-known-issue)).

**What to do:** wait out the 5 minutes, or run `npx -y brightspace-mcp-server@latest auth` from your home folder to sign in now. `auth` doesn't check the pause, and it shows the number to enter.

*Source: `src/auth/auth-cooldown.ts`, `recordMfaFailure` call in `src/auth/browser-auth.ts`, `cooldown` text in `src/tools/tool-helpers.ts`.*

### `timeout`

**When:** the background sign-in was stopped because nobody approved its prompt in time, or it ran past its overall limit (about 18 minutes).

**What is happening:** the prompt it sent no longer works. When the stop comes because nobody was waiting on the sign-in, the process is killed at once and no cooldown is recorded, so the next call starts a fresh sign-in (`watchAttention` in `src/auth/auth-runner.ts`).

**What to do:** don't open a window to retry; a window doesn't skip the prompt. Call the tool again to start a new sign-in, or run `auth` in a terminal from your home folder to finish it with the number visible.

*Source: `watchAttention` and `AUTH_TIMEOUT_MS` in `src/auth/auth-runner.ts`, `timeout` text in `src/tools/tool-helpers.ts`.*

### `busy`

**When:** exit code 2. Another process is already signing in for this account, and this call can't join it. This is usually a terminal `auth` run.

**What is happening:** only one sign-in runs per account at a time. The lock is in the session folder. Nothing new was started.

**What to do:** let that sign-in finish, then try again. To take that attempt over now, run `auth` in a terminal from your home folder.

*Source: `busy` text in `src/tools/tool-helpers.ts`, `AuthenticationInProgressError` in `src/auth/auth-lock.ts`.*

### `unsupported`

**When:** exit code 4. The login page asks for something a headless sign-in can't supply from the chat, usually a code from an authenticator app when no key is saved, or a step this sign-in flow doesn't know. It also covers a sign-in that ended before reaching a supported MFA step, such as one interrupted before its prompt.

**What is happening:** the sign-in can't finish without you. A failed automatic-code sign-in also shows up here, and it starts the same 5-minute cooldown as a missed prompt.

**What to do:** run `auth` in a terminal from your home folder and sign in there. It asks for the code in the terminal. If your school asks for something this server doesn't support, [open an issue](https://github.com/RohanMuppa/brightspace-mcp-server/issues).

*Source: `unsupported` text in `src/tools/tool-helpers.ts`, `UnsupportedAuthenticationError` in `src/auth/browser-auth.ts`.*

### `secureStorage`

**When:** exit code 5. The operating system's credential store is locked or unavailable, so the saved password can't be read.

**What is happening:** the sign-in stops before it types the password. The saved session is not changed.

**What to do:** unlock your keychain or keyring (on a Mac, log in or unlock Keychain Access). Then try again. On a Mac, choose **Always Allow** when Keychain asks.

*Source: `NativeCredentialStoreError` in `src/auth/credential-store.ts`, `secureStorage` text in `src/tools/tool-helpers.ts`.*

### `transport`

**When:** exit code 6. Brightspace or Microsoft could not be reached: a network failure, or a server error or rate limit while getting the API token.

**What is happening:** this is not a bad password or a missed prompt. The saved session is kept.

**What to do:** call `sign_in` once more without a window; a window doesn't help. If it fails again, check the connection and try again in a few minutes.

*Source: `BrowserAuthTransportError` in `src/auth/browser-auth.ts`, `transport` text in `src/tools/tool-helpers.ts`.*

### `stuck`

**When:** exit code 10. The school's sign-in page did not settle on a login step the server knows, even though Brightspace could be reached.

**What is happening:** the saved session is kept. If the sign-in had not yet sent a prompt, the server retries it once by itself. If a prompt had been sent, it doesn't retry, so you don't get a second prompt.

**What to do:** call `sign_in` again. No window is needed.

*Source: `BrowserAuthStuckError` in `src/auth/browser-auth.ts`, `retryableStuck` in `src/auth/auth-runner.ts`, `stuck` text in `src/tools/tool-helpers.ts`.*

### `failed`

**When:** exit code 1, any exit code the server doesn't recognize, or the sign-in process couldn't start at all.

**What is happening:** the sign-in failed for a reason that has no more specific kind. The full reason goes to the log.

**What to do:** run `auth` in a terminal from your home folder. It prints the cause, as "caused by" lines under the failure. If the saved school or username is wrong, run `setup`.

*Source: `failed` text in `src/tools/tool-helpers.ts`, the `failures` table in `src/auth/auth-runner.ts`.*

### `browserInstall`

**When:** exit code 8. Chromium is missing and could not be restored.

**What to do:** run the `repair` command the message prints. `npx -y brightspace-mcp-server@latest repair` does the same. Repair signs in to nothing.

*Source: `PLAYWRIGHT_INSTALL_HINT` in `src/utils/browser-install.ts`.*

### `dependencyMissing`

**When:** exit code 9. Playwright's package code is missing from this install.

**What to do:** run the npm command the message prints to restore the declared dependencies, then the `repair` command after it. `doctor` shows the same steps.

*Source: `dependencyRepairHint` in `src/utils/browser-install.ts`.*

### Other answers from `sign_in` and `sign_out`

These aren't failure kinds, but they show up in the same place:

- **"Already signed in…, nothing was changed"**: the saved session is still valid. Call the tool you need.
- **"Nothing to do… authenticates with a credential from its configuration (`D2L_ACCESS_TOKEN` or `D2L_SESSION_COOKIE`)"**: the server can't start a sign-in when a pasted token or cookie is in use. Paste a fresh value (see [No browser? Paste a session cookie or token](sign-in.md#no-browser-paste-a-session-cookie-or-token)).
- **"This server cannot start a sign-in itself"**: run `auth` in a terminal instead.
- **"No password is saved… nothing to type"**: no password is saved, so a sign-in with no window can only time out. Ask for a window, or run `setup` to save a password.
- **"A browser window is opening…"**: the user has to finish the sign-in in that window, including any 2FA, and then say so.
- **`sign_out`: "Not signed out: a sign-in that sign_out can't cancel is in progress"**: a sign-in started in a terminal is still running. Let the user finish or close it, then ask again.

*Source: `src/tools/sign-in.ts` (`ALREADY`, `ENV_CREDENTIAL`, `NO_RUNNER`, `NEEDS_PASSWORD_FOR_HEADLESS`, `WINDOW_*`), `src/tools/sign-out.ts` (`IN_PROGRESS`).*

## Stopping `auth` with Ctrl-C (known issue)

Tracked in [issue #428](https://github.com/RohanMuppa/brightspace-mcp-server/issues/428). Until it is fixed, this is what happens:

- If you press Ctrl-C while `auth` is waiting for approval, the run ends with "MFA approval failed or timed out" (exit code 7). That is not what happened: you stopped it.
- That message records the 5-minute automatic cooldown (`recordMfaFailure` in `src/auth/browser-auth.ts`). Background sign-ins from your AI app then pause for 5 minutes, and say so.
- Running `auth` again works right away. The explicit run skips the cooldown check (`src/auth/browser-auth.ts`, `options.automatic` only), so you don't have to wait the 5 minutes to retry it yourself.
- Ctrl-C before the approval step gives "Automatic sign-in stopped before a supported MFA challenge completed" (exit code 4), and records no cooldown.

Source: the SIGINT handler in `attemptAuthentication` (`src/auth/browser-auth.ts`). The login catch in `src/auth/purdue-sso.ts` (Microsoft sign-in) turns an interrupted approval into an MFA approval error. The CUNY and Javeriana flows (`src/auth/cuny-sso.ts`, `src/auth/javeriana-sso.ts`) raise the same error; other sign-in flows were not checked for this.

## Logs and bug reports

**Where output goes.** `log()` in `src/utils/logger.ts` writes only to stderr. There is no log file by default. Where that stderr ends up depends on what started the process:

- An AI app that starts the server keeps its stderr in its own log (see the top of this page).
- The shared background server writes its stderr to `runtime.log` under `<session dir>/shared-runtime/<hash>/` (`src/runtime-relay.ts`). See [the shared server](shared-server.md).
- `auth`, `setup`, `doctor`, `repair` and `sync` print to your terminal.
- The dev activity log is written only when `D2L_DEV_MODE=true` (below).

`log()` redacts tokens, cookies and passwords before printing, but the text it prints can still include school URLs and error messages.

**Dev activity log (`D2L_DEV_MODE`).** Set `D2L_DEV_MODE=true` (exactly `true`) in the server's environment and restart it. Records go to JSONL files in `dev-activity` under the account's session folder, `~/.d2l-session/accounts/<account-hash>/`.

- It records: tool names, start and finish times, durations, success or a fixed error category, and sign-in events such as a prompt being seen, stage timings, and recovery IDs.
- It doesn't record: arguments, results, course IDs, URLs, account names, passwords, cookies, tokens, MFA codes or numbers, or raw error messages.

Keep the files private anyway. Tool names and timestamps still describe what you did. Full list: [docs/dev-mode.md](dev-mode.md).

**What to put in a bug report:**

1. **The version.** Ask your assistant which version of the Brightspace server it is running. It answers from `get_server_info` (`version`).
2. **The `auth` output,** if the problem is sign-in: everything the terminal printed, from the `=== Brightspace Authentication v… ===` line to the end. Check it for anything you don't want public before you post it.
3. **The dev activity log,** from a run where the problem happened, with `D2L_DEV_MODE=true` set and the server restarted first.

Then [open an issue](https://github.com/RohanMuppa/brightspace-mcp-server/issues) and paste these in.

## Startup, browser and password-store problems

**The app says the server timed out while starting:** open the app's MCP server log. Each startup step prints a timestamped `Startup: ...` line before it begins and `done in N ms` when it ends, and a step still running after 10 seconds prints `Startup: still ...` once. The last such line names the step it was stuck in, often the saved-password lookup in your password store. These lines never include your username, password or cookies.

**Browser removed during disk cleanup:** sign-in restores a missing Chromium download once and retries automatically. It uses the installed Playwright dependency's browser revision and keeps your saved credentials, MFA enrollment and sessions. Downloads have a two-minute limit; an offline or failed repair returns an installation error instead of asking you to reset credentials.

**Repair the browser without signing in:** run `npx -y brightspace-mcp-server@latest repair` (or `brightspace-mcp-server repair` for a global install; add `--json` for automation). It verifies the full browser and a real headless launch, and does not register clients, change school settings or start sign-in. Browser downloads are disposable. Files inside an installed package's `node_modules` are dependency code: if they were deleted, `doctor` prints an npm command that restores the package's declared dependencies. Browser repair never runs npm or upgrades packages on its own.

## Output details worth knowing

- `get_course_content` reports `isAvailable`, `availabilityStatus` (`available`, `not_yet_open`, `ended`, `hidden`, or `locked`), `availabilityMessage`, `startDate`, and `endDate` for modules and topics. The effective release window includes restrictions inherited from enclosing modules.
- When a content-file download returns 403 or 404, `download_file` checks topic metadata and the course table of contents. Confirmed restrictions return `{ success: false, available: false, reason, message, startDate, endDate }` so the assistant can explain when content opens or why it has closed. Unexplained 404s and server/network failures retain their original errors.
- When course content or announcements are converted to markdown, `javascript:`/`data:` links are rendered as plain text (the link itself is dropped, not followed) and D2L's per-session query parameters (`d2lSessionVal`, `d2lSecureSessionVal`, and the cache-busting `_`) are stripped from any remaining links and images before they reach the assistant.
- Every due date in `get_assignments` and `get_upcoming_due_dates` carries a `dueIn` relative time ("in 3 days") next to it.

Building against this server or opening a PR? See [STABILITY.md](../STABILITY.md) for what's safe to rely on and what counts as a breaking change.
