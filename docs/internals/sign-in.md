# Sign-in internals

This file explains how sign-in works inside the server, and why. It covers the code under `src/auth/` and the sign-in text in `src/tools/tool-helpers.ts`. It is for an agent or developer about to change either one. Read the rules first, because many of them came from a live failure on a real school tenant, and the dates and issue numbers sit beside each rule.

The student-facing guides are [../sign-in.md](../sign-in.md) and [../troubleshooting.md](../troubleshooting.md). They hold the how-to steps, so this file links to them instead of repeating those steps. The tool reference is at [../reference/tools.md](../reference/tools.md), and the settings are at [../reference/settings.md](../reference/settings.md).

## What an agent using the tools must do

- There is no authentication step and no tool to check one.
- Call the tool that answers the user's question. If no valid session exists, the request signs in first and then goes on.
- Never tell the user to authenticate before asking something.
- Never call a tool only to establish a session.
- Relay a sign-in error text as given. It names the cause and the next step. Causes include a locked credential store, a paused MFA cooldown, an unsupported login page, and a network outage.
- When a tool answer carries a number, relay that text as given. Tell the user to approve it, then call the tool again right away.
- Before any sign-in has started, firing several tools at once is safe. Concurrent calls on a cold session share one sign-in and produce a single MFA prompt.
- Once an answer has shown an MFA number, call one Brightspace tool at a time until sign-in finishes. See [How long a call waits](#how-long-a-call-waits) for why.
- Only some failures need the terminal command (`auth`). The tool texts in `src/tools/tool-helpers.ts` name it for `cooldown`, `unsupported`, `busy`, `timeout` and `failed`.
- These rules reach a running agent only through the tool answers in `src/tools/tool-helpers.ts`. A running agent never reads this file. If you change a rule here, change the matching answer text too.

## Limits at a glance

Each value below was checked against the code on 2026-11-11. The code is the authority: if a value here disagrees with it, fix this table.

| Name | Value | File |
|------|-------|------|
| `MFA_APPROVAL_WINDOW_MS` | 5 minutes, for each number | `src/auth/mfa-challenge.ts` |
| `MFA_MAX_RESENDS` | 2 resends per sign-in | `src/auth/mfa-challenge.ts` |
| `MFA_MAX_WAIT_MS` | 15 minutes (window times 1 + resends) | `src/auth/mfa-challenge.ts` |
| `AUTH_TIMEOUT_MS` | 18 minutes (`MFA_MAX_WAIT_MS` plus 3 minutes) | `src/auth/auth-runner.ts` |
| `MFA_POLL_MS` | 45 seconds per call | `src/auth/auth-runner.ts` |
| `CALL_BUDGET_MS` | 55 seconds per call, the cap | `src/auth/auth-runner.ts` |
| `ABANDON_MS` | 45 seconds (equal to `MFA_POLL_MS`) | `src/auth/auth-runner.ts` |
| `SIBLING_GRACE_MS` | 1.5 seconds | `src/auth/auth-runner.ts` |
| `WAVE_MS` | 5 seconds | `src/auth/auth-runner.ts` |
| `SIBLING_CHAIN_MS` | 20 seconds | `src/auth/auth-runner.ts` |
| `MFA_COOLDOWN_MS` | 5 minutes | `src/auth/auth-cooldown.ts` |
| `HELD_RETRY_MS` | 1 minute between asks during a hold | `src/auth/purdue-sso.ts` |
| `MAX_HELD_RETRIES` | 6 asks during a hold | `src/auth/purdue-sso.ts` |
| `MFA_TIMEOUT_MS` | equal to `MFA_APPROVAL_WINDOW_MS` (5 minutes) | `src/auth/purdue-sso.ts` |
| `MAX_RESENDS` | equal to `MFA_MAX_RESENDS` (2) | `src/auth/purdue-sso.ts` |
| `AUTOMATIC_PENDING_NOTICE_MS` | 15 seconds | `src/auth/purdue-sso.ts` |
| `AUTOMATIC_FALLBACK_MS` | 30 seconds | `src/auth/purdue-sso.ts` |
| `MIN_CODE_LIFETIME_S` | 5 seconds | `src/auth/purdue-sso.ts` |
| `VISIBLE_LOGIN_TIMEOUT_MS` | 5 minutes | `src/auth/browser-auth.ts` |
| `TAKEOVER_WAIT_MS` | 10 seconds | `src/auth/auth-lock.ts` |

## Tokens and when a browser is needed

- Access tokens are re-minted from the stored session cookie. No browser is needed for that.
- When browser authentication is required, setup's MFA choice decides how Chromium runs.
  - It stays hidden for approval or terminal code entry.
  - Or it opens for other interaction.
- Automatic MCP authentication cannot read a code from stdio. Tell the user to run the explicit command below.
  - The explicit command prompts for the code without echoing it into MCP logs.

```bash
npx -y brightspace-mcp-server@latest auth
```

- Network errors and locked native storage are reported without retrying MFA.

## How long a call waits

- A tool call that triggers browser auth does not block for the whole approval window.
- It returns within seconds of an MFA challenge appearing.
- The answer carries the number to enter. On tenants that never show a number, it says "approve on your phone" instead.
- The text is in the tool's own error text. Relay it verbatim, tell the user to approve it, and call the tool again immediately.
- Do not wait for the user to say they have approved. Sign-in keeps running in the background.
- The retry polls the sign-in for up to 45 seconds. It never goes past 55 seconds from the retry's start.
- The retry returns the result as soon as the sign-in completes.
- If the sign-in has not completed, the retry returns the same number-to-enter error.
- Keep calling until the tool succeeds or reports a different error.

**Progress tokens**

- When the client sends a progress token with the call, the challenge goes out as a progress notification on that call instead.
- The call keeps waiting up to 45 seconds for the sign-in. It never goes past 55 seconds from the start of authentication.
- **Why:** this lets it answer inside the common 60-second client timeout.
- An approval in that window completes the original request.
- Past that window, the call returns the same number-to-enter error.

**Still starting**

- No call waits more than 55 seconds, even before a challenge appears.
- A sign-in that is still opening the browser or the school's login pages returns a "still starting in the background" error. It keeps running.
- Call again right away. The retry joins the same sign-in, with no second MFA prompt. It returns the number as soon as one appears.
- The `inProgress` answer text is in `src/tools/tool-helpers.ts`.
- The relayed case uses `STILL_SIGNING_IN` in `src/auth/auth-runner.ts`. That text says "still running", not "still starting".

**Parallel batches**

- While MFA is pending, call one Brightspace tool at a time.
- **Why:** a client that holds parallel results until the whole batch finishes can keep the number from the user until it is too late.
- The code comment on `MFA_SOLO_CALL` in `src/tools/tool-helpers.ts` cites issue #199.

**Sibling and wave calls**

- A call that arrives within 1.5 seconds of an MFA answer is treated as a sibling in a queued batch, not as a retry (`SIBLING_GRACE_MS`).
- Sibling answers can chain for up to 20 seconds (`SIBLING_CHAIN_MS`).
- Calls that arrive within 5 seconds of a batch's first call count as that batch (`WAVE_MS`).
- The code comments cite issues #199 and #212.
- **Why:** a queued batch would otherwise make each call wait up to 45 seconds for an approval the user cannot give yet.

## MFA numbers and resends

- The Microsoft number can change while the sign-in waits. This happens when the number-match request expires, or when it is denied before approval.
- **Seen live:** the request expired at about five minutes, on 2026-11-08. Earlier tenants showed one or two minutes.
- The background sign-in then asks Microsoft for another number by itself. The resend is in `src/auth/purdue-sso.ts`.
  - It resends at most twice per sign-in.
  - It applies to Microsoft number match only. Duo does not resend.
- Each new number gets its own full five minutes. The wait deadline moves to the resend time plus five minutes.
  - So a sign-in waits at most 15 minutes in all. `MFA_MAX_WAIT_MS` in `src/auth/mfa-challenge.ts` sets this.
  - The parent's `AUTH_TIMEOUT_MS` is that plus three minutes.
- **Why:** a resent number is a new number, so it gets a new window. A resend should not cut the user's time short.
- The next tool response carries the new number. Always relay the latest number, not one from an earlier call.
- The tool text is in `MFA_NEW_NUMBER` in `src/tools/tool-helpers.ts`.
- On macOS the number is also shown as a system notification, sent from `publishChallenge` in `src/auth/auth-runner.ts` through `src/utils/notify.ts`. The same number is not repeated within 2 minutes, and a number counts as shown only after the notification was sent. `D2L_NOTIFY=0` turns it off.
  **Why:** a background sign-in can ask for approval when no chat is showing the answer, so the number reached nobody (#424).

## Microsoft's held prompt

This is the only full explanation in this file. Other sections point here.

- Microsoft sometimes shows a page that says "having trouble verifying your account". The list is headed "Verify your identity".
- The code matches the text with `MFA_HELD_TEXT` in `src/auth/purdue-sso.ts`.
- **Cause:** an earlier prompt for the account is still open. Microsoft refuses a new prompt until that one expires, up to five minutes after it was sent.
- Microsoft's `BeginAuth` call answers the sign-in request with `UserAuthFailedDuplicateRequest`, error `500121`.
  - **Seen live:** on Purdue's tenant, 2026-10-25.
- The sign-in (`PurdueSSOFlow` in `src/auth/purdue-sso.ts`) recognises the page and reports `AUTH_MFA_HELD` once. The marker is `MFA_HELD_MARKER` in `src/auth/mfa-challenge.ts`.
- Callers hear `mfaHeld`. The answer gives the real wait, not "still starting".
- During the hold, the sign-in asks Microsoft again once a minute, through its Authenticator option.
  - The option is "Approve a request on my Microsoft Authenticator app". The code matches it with `PUSH_METHOD_LABEL` in `src/auth/purdue-sso.ts`.
  - It asks up to six times. `HELD_RETRY_MS` is one minute, and `MAX_HELD_RETRIES` is six.
  - It asks only while the page names the configured account.
- A request during the hold sends nothing. Asking sooner is refused the same way.
- The first ask after the earlier prompt expires sends one new prompt. Its number ends the hold. The next answer carries that number.

**What the answers say**

- The `mfaHeld` answer text says that the earlier number no longer works. Relay only the newest number.
- The same text says that, if a prompt the user did not start shows on their phone, the user should deny it.
- Cancelling the sign-in does not make Microsoft send a prompt sooner. Call the tool again, and the call joins the sign-in.
- The message-by-message guidance is in [What each sign-in message means](../troubleshooting.md#what-each-sign-in-message-means).

## Cooldown after a missed prompt

- A missed MFA approval pauses automatic browser authentication for five minutes. The pause length is `MFA_COOLDOWN_MS` in `src/auth/auth-cooldown.ts`.
- The pause is saved in `auth-status.json` in the session folder.
- During the pause, calls send no prompt at all. They get the `cooldown` answer.
- When the pause ends, the next call starts a new sign-in and sends a new prompt.
- HTTP token renewal is still allowed during the pause. Only automatic browser authentication is paused.
- The explicit `auth` command bypasses the pause. The check runs only for automatic attempts (`options.automatic` in `src/auth/browser-auth.ts`).
- A failed automatic code sign-in records the same cooldown (`recordMfaFailure` in `src/auth/browser-auth.ts`).
- Exit codes 3 and 7 both mean cooldown. See [Failure kinds and exit codes](#failure-kinds-and-exit-codes).

## Background sign-ins, sharing and cancelling

- A sign-in keeps running after the tool call returns. Later calls poll it.
- Neither a retry nor a tool call that times out or is cancelled sends a new prompt.
  - The background sign-in keeps running and keeps waiting on the prompt already sent.
  - It waits for up to five minutes. A resent number restarts that five minutes.
  - The next call joins it.
- A background sign-in that nobody is waiting on stops 45 seconds after the last call that polled it, or relayed its number, was answered.
  - It stops without starting the MFA cooldown. The next call starts a fresh sign-in.
  - **Why:** an unanswered prompt should not hold the browser and the cross-process lock for the whole five-minute window.
  - The code is `abandonDelayMs` and `ABANDON_MS` in `src/auth/auth-runner.ts`.
  - A caller that is still waiting keeps the sign-in alive. Otherwise the 45 seconds count from the last time anyone attended to it.
- The stop uses SIGKILL, not SIGTERM. A graceful stop would run the MFA failure path, which records the cooldown.
  - **Why:** the user never had a chance to answer (code comment in `src/auth/auth-runner.ts`).
- **Note:** the five-minute wait and the 45-second stop both apply. Read together, the five-minute wait holds while a caller keeps polling. With no caller, the 45-second rule stops the sign-in.
- Cancelling with `sign_out` does not get a new prompt sooner. See [Microsoft's held prompt](#microsofts-held-prompt).
- The tool texts say all of this. `MFA_SAME_PROMPT`, `MFA_NEW_NUMBER` and `MFA_NO_FASTER` in `src/tools/tool-helpers.ts` cover it, and so does the `mfaHeld` guidance.
  - So a model has no gap to fill with a guess.
  - **Why:** without these texts, a model filled the gap itself. It told a user that a timed-out call would make the server send a new push.

## Several processes and the lock

- Several server processes can share one session store. There is one process per MCP client window.
- The sign-in lock is `.auth.lock` in the session folder (`authLockPath` in `src/auth/mfa-challenge.ts`). Only the lock holder can sign in.
- The owner writes its challenge into the lock directory. The challenge goes away with the lock.
- A call in a process whose sign-in finds another process's sign-in holding the lock is answered with that sign-in's number. It is not a bare "already in progress".
  - The contender reads the challenge back and relays it (`relayChallenge` in `src/auth/mfa-challenge.ts`).
- A call that cannot join another process's sign-in gets `busy`, which is exit code 2. See the failure kinds below.
- The explicit `auth` command takes over a stuck background sign-in. It does not wait for that sign-in to finish or time out.
  - **Note:** the takeover sends SIGTERM, then waits up to 10 seconds for the owner to let go of the lock (`TAKEOVER_WAIT_MS` in `src/auth/auth-lock.ts`).

## Duo

- On a Duo tenant, a device-trust question gates the push. The question is "Is this your device?".
- The sign-in answers yes automatically. The code clicks the "Yes, this is my device" button (`answerDeviceQuestion` in `src/auth/duo-mfa.ts`).
  - **Why:** nothing proceeds until the question is answered, and the MFA deadline then expires (code comment in `src/auth/duo-mfa.ts`).
- Answering yes also makes Duo remember this device. Later logins from this machine skip Duo's device check.
  - Mention this to a user who signs in from a shared computer.
- `D2L_DUO_PASSCODE` switches from waiting for a push to typing a Duo Mobile passcode (`src/auth/duo-mfa.ts`).
- Duo does not resend a number.
- The automatic code path never engages after a Duo challenge.

## Remember this device

- On Microsoft Entra's MFA page, the "Don't ask again for N days" checkbox is ticked once when remember-MFA is on.
  - This applies to number match and to the verification-code page, on `login.microsoftonline.com` only.
  - The tick happens before the number is announced or a code is asked for.
  - A box that is already checked is left alone.
- Remember-MFA is `setup` option 2 or 3. The default is option 1, which is off.
  - It is saved as `rememberMfa` in `config.json`.
  - `D2L_REMEMBER_MFA` overrides it either way. The order is env, then `config.json`, then `false`.
- This is opt-in and off by default. Unless it is turned on, the box is left alone and the outcome is recorded as `off`.
- The window length is the tenant's setting. A tenant that never shows the box keeps asking.
- A sign-in that fails after Entra renewed its cookies still saves the browser state, when those cookies are strictly newer than the saved ones.
  - Any other failure leaves the saved state untouched.
- `get_server_info` reports `microsoftSession`. It has these fields:
  - `staySignedIn` and `staySignedInExpires`.
  - `rememberMfa`, with the values `ticked`, `already`, `absent`, `unknown`, or `off`.
  - `rememberMfaAt`.
  - `note`, a plain sentence. It says that staying signed in alone does not skip 2FA, and what the `rememberMfa` outcome means for it.
  - **Why:** users read "stay signed in" as "no 2FA" (#227).
- The summary is read from `microsoft-session.json`, which holds no cookie values. It sits beside the browser state.
- The `microsoftSession` field is left out when no browser state is saved.

## Authenticator key (automatic codes)

- This is opt-in per account. `setup` option 3 takes an authenticator setup key or an `otpauth://` URI.
- `saveSecureConfig` (`src/utils/secure-config.ts`) normalises the key and stores it in the native credential store, under a `totp:`-prefixed account.
  - It is never written to `config.json`. `saveConfigStore` throws on it, as it does for a password.
- `loadConfig` reads it back as `totpUri` whenever a username is configured.
- `D2L_TOTP_SECRET` overrides the stored value.
  - It is documented as weaker, because it lives in the process environment and not in the OS keychain.
- An unreadable credential store is treated as "no enrollment". It is not a startup failure (`src/utils/config.ts`).
- With `totpUri` set, the Entra MFA loop clicks "Use a verification code".
  - If that control is missing, it tries "sign in another way" or "I can't use my ... right now".
  - Each control is tried at most once per login.
- It verifies the account Microsoft is showing before it types anything.
- It submits an RFC 6238 code that it generates locally.
  - It waits out the rest of the period rather than submit a code with under five seconds of life (`MIN_CODE_LIFETIME_S`).
  - It never resubmits a rejected code.
- The gate is the identity provider and the challenge on screen. It is never a school URL.
  - It never engages off `login.microsoftonline.com`.
  - It never engages after a Duo challenge.
  - It never engages on Microsoft's passwordless approval view.
- If Entra offers no way to reach a code within 30 seconds (`AUTOMATIC_FALLBACK_MS`), the login falls back to the ordinary announce-and-approve path.
- Fifteen seconds in (`AUTOMATIC_PENDING_NOTICE_MS`), the flow reports progress.
  - It prints `AUTH_AUTOMATIC_PENDING` on the auth child's stdout (`AUTOMATIC_PENDING_MARKER`).
  - It writes a `{"kind":"automatic"}` challenge into the lock directory, so other processes can relay it.
  - A tool call receives this as the `automaticPending` failure kind. The text is "no phone approval is being requested, retry to join the same login".
- A failed automatic sign-in records the same MFA cooldown.
- Dev mode logs `mfa_method_selected` and `mfa_code_submitted`. It never logs the code or the seed.
- **Security:** the seed beside the password collapses two factors into one on that machine.
  - It still defeats a remote attacker who holds only the password.
  - It defends against nothing already running as that user.
  - That is why it ships off by default.

## Fewer 2FA prompts (the setup question)

- `setup` asks one multiple-choice question: "How often do you want to approve sign-ins on your phone?"
- The question comes right after the MFA-method question.
- The choices are:
  - **1, every time.** This is the default and the safest.
  - **2, remember this computer.** It sets `rememberMfa` (`D2L_REMEMBER_MFA` overrides it), and ticks Microsoft's "Don't ask again" box.
  - **3, this computer answers Microsoft's code requests itself.** It uses a saved authenticator key from the OS keychain, or `D2L_TOTP_SECRET`. The server types the 6-digit code. It also sets `rememberMfa` to true.
- Options 2 and 3 are opt-in. Neither is for a shared computer.
- Option 3 only helps when Microsoft asks for a code. Otherwise sign-in falls back to the phone.
- The steps for getting the key are in [the sign-in guide](../sign-in.md#fewer-2fa-prompts). They start at `https://mysignins.microsoft.com`.
- Send users to that guide. Do not re-explain the steps.
- To turn it on, rerun `setup` and pick 2 or 3. To turn it off, rerun `setup` and pick 1.
- The wording and the question live in `src/utils/two-factor-shortcuts.ts`.
  - `askShortcutQuestion` drives the question through a small `ShortcutIO`, so it can be tested.
  - `setup`, the MFA tip and `doctor` all share this file.
- If a key is saved and the user picks 1 or 2, `setup` asks "Remove the saved authenticator key from this computer? (yes/no) [yes]".
  - On yes, the key is deleted after the config is saved (`deleteStoredTotpUri`).
- Picking 3 with no key saved shows a short how-to, then the hidden key prompt.
  - Enter with no key saves option 2, and `setup` says so.
- With a key already saved, an explicit 3 offers a replacement. Enter keeps the key.
- On a rerun, `setup` prints "Currently: N" and makes that choice the Enter default.
- A key saved without remember-this-device keeps remember off on Enter.
- The question is asked for every school and every mode. There is no per-school gating, because whether a code can be typed is known only at sign-in time.
  - `askShortcutQuestion` takes an `applicable` pair. It renumbers or skips the question if that ever changes.
- The key is never printed.
- **MFA tip:** a pending MFA approval message (`mfaPending` in `src/tools/tool-helpers.ts`) ends with one line.
  - The line reads "Tip for the user: to be asked less often, rerun setup", with the docs link.
  - It appears only when both options are off.
  - It is never added when either option is on, to a duplicate in the same batch, or to any other failure kind.
- `src/index.ts` records the state at startup with `setActiveShortcuts`. Until then, no tip is shown.
- `doctor` prints one line after its checks: `2FA shortcuts: remember this device on/off, authenticator key saved/not saved`.
  - The line is informational. It never changes the exit code.
  - When both options are off, it adds the docs link.
  - It checks only that a key exists, and never reads the key into its output.
  - If the credential store cannot be read, it says "not checked".

## Passwordless (shelved)

- Passwordless sign-in is shelved.
- `setup` no longer asks about it. It always saves a password.
- `setup` drops a `passwordless` value that was carried over in `config.json`.
- Only `D2L_PASSWORDLESS` turns it on. A hand-edited `passwordless` value in `config.json` also does. The order is env, then `config.json`, then `false`.
- When it is on:
  - `loadConfig` reads no saved password.
  - The default Entra flow counts a username alone as credentials. It submits only the username.
  - It waits on Microsoft's passwordless approval view as an MFA challenge. It does not click through to the password page.
  - The view is recognised by the "Use your password instead" link or the `#idRemoteNGC_*` markers.
  - It announces its number the same way as number match.
- A password page in this mode fails at once. The error names `D2L_PASSWORDLESS`.
- Every sign-in then needs a phone approval. This mode is for interactive use only.

## Visible browser mode

- Visible mode applies to the manual `auth` command.
  - Its window stays open for up to five minutes (`VISIBLE_LOGIN_TIMEOUT_MS`).
  - It does so when automatic credential handling is unavailable, or when the identity provider needs direct interaction.
- Automatic recovery started by `AuthRunner` runs headless. The exception is when `D2L_HEADLESS` is set explicitly.
  - The runner sets `D2L_HEADLESS` to true before the inherited environment, so an explicit value wins (`src/auth/auth-runner.ts`).
- Rerunning `setup` keeps the existing hidden or visible preference as the default choice.
- The manual command is:

```bash
npx -y brightspace-mcp-server@latest auth
```

- A visible window requested by `sign_in` goes through `requestVisibleBrowser`. See [The `sign_in` tool](#the-sign_in-tool).

## The `sign_in` tool

- `sign_in` (`src/tools/sign-in.ts`) is the only way an AI app can start a sign-in.
  - **Why:** before it, recovery ran only as a side effect of another tool getting a 401.
  - The documented fix for a first sign-in was to open a window. A window was reachable only through a CLI flag or `D2L_HEADLESS`.
  - Neither can be set from a chat, so an assistant could only tell the user to run a terminal command.
- It reads the saved session first, with `TokenManager.getToken` and `isValid`.
  - If the session is valid, it returns without starting anything.
  - So calling it speculatively costs the user no MFA approval.
  - Otherwise it calls `AuthRunner.run()`.
- Window rule when `visible` is left out:
  - A window opens exactly when the school's sign-in flow reports no credentials.
  - The test is `createSSOFlow(config).hasCredentials()`. It is true for a username plus a saved password, or for Purdue's passwordless mode.
  - **Why:** a headless sign-in with nothing to sign in with can only wait and time out.
- `visible: false` with no credentials is refused outright. The answer is `NEEDS_PASSWORD_FOR_HEADLESS`, so the timeout is not spent.
- A window is requested with `AuthRunner.requestVisibleBrowser()`.
  - It sets `D2L_HEADLESS=false` on the next child the runner starts.
  - It is one-shot.
  - It is placed after `...process.env`, so an explicit request wins over an inherited value.
  - It is opt-in, because background recovery must never open a browser over the user's work on its own.
- A call that joins a sign-in already in flight keeps that sign-in's mode. So `busy()` is checked before a window is promised.
- A window is for the user's own hands only. That means no saved password, or the user asks to see one.
  - The `visible` description and the failure answers say never to pass `visible: true` after a `transport`, `stuck` or `timeout` failure.
  - **Why:** the saved password is typed in the background, so a window adds nothing.
- When a window opens, the answer says why: it was requested, or no password is saved.
- A requested window that joined a running sign-in says that no window was opened.

## Failure kinds and exit codes

The exit codes come from `src/auth/auth-exit-code.ts`. The kinds come from the `failures` table in `src/auth/auth-runner.ts`.

| Exit code | Kind | Notes |
|-----------|------|-------|
| 0 | signed in | The normal exit. No failure code is set. |
| 1 | `failed` | Also any code the server does not recognise. |
| 2 | `busy` | `AUTH_IN_PROGRESS`. It becomes `mfaPending`, `automaticPending` or `inProgress` when a challenge was seen or relayed. |
| 3 | `cooldown` | `AUTH_COOLDOWN`. |
| 4 | `unsupported` | `AUTH_UNSUPPORTED`. It becomes `mfaHeld` when a held prompt was seen. |
| 5 | `secureStorage` | `NativeCredentialStoreError`. |
| 6 | `transport` | `AUTH_TRANSPORT`. |
| 7 | `cooldown` | An MFA approval was not completed (`MfaApprovalError`). |
| 8 | `browserInstall` | Chromium is missing and could not be restored. |
| 9 | `dependencyMissing` | Playwright's package code is missing. |
| 10 | `stuck` | `AUTH_STUCK`. |

- The kinds `mfaPending`, `automaticPending`, `inProgress`, `cancelled` and `timeout` have no exit code of their own. The server sets them itself, and the tool answers them.
- Each `AuthFailureKind` maps to its own answer. The answer names the next step. The text is in `src/tools/tool-helpers.ts`.
- `cooldown`, `mfaHeld` and `mfaPending` say that waiting is the fix.
- `mfaPending` and `automaticPending` are not marked as errors. **Why:** a prompt awaiting approval is progress, not a failure.
- The full message for each kind is in [What each sign-in message means](../troubleshooting.md#what-each-sign-in-message-means).

**transport and stuck**

- `transport` (exit 6) is a real network or server failure. Examples are DNS failure, a refused connection, HTTP 5xx or 429, and a dead browser.
  - The saved session is kept.
  - The answer says to call `sign_in` once more, without `visible`.
  - A window opens by itself only when no password is saved.
- `stuck` (exit 10) is `BrowserAuthStuckError`. It is a subclass of `BrowserAuthTransportError`, with code `AUTH_STUCK`, in `src/auth/browser-auth.ts`.
  - Brightspace answered, but the school's sign-in page never settled on anything the flow could act on, within the silent-SSO budget.
  - The answer says "call sign_in again — no window is needed".
- A page that navigates while it is being read is "not ready yet", not a failure.
  - Playwright errors such as "Execution context was destroyed", "Cannot find context", or "frame was detached" make the server poll again.
  - The session check after a sign-in reads the page that arrived once more before it gives up (`NAVIGATION_RACE` in `src/auth/browser-auth.ts`).
- `AuthRunner` retries a `stuck` child once by itself. It does this only if that child never showed a number, an automatic-code notice, or a held prompt.
  - **Why:** a retry must never send a second MFA prompt.
- Exit codes live in `src/auth/auth-exit-code.ts`.
- The `Authentication failed:` line in `src/auth-cli.ts` is followed by one `caused by:` line per cause.
  - Each cause is its first line, with URLs cut to their origin (`src/auth/error-cause.ts`).


## Signing out

Use `sign_out` only when the user asks to sign out, or asks to cancel a waiting sign-in. Never call it on your own to recover from an error.

- The user can run this command instead:

```bash
npx -y brightspace-mcp-server@latest auth --logout
```

**What `auth --logout` deletes**

- It resolves the session folder the way sign-in does.
  - `D2L_SESSION_DIR` is used if it is set.
  - Otherwise the configured or default `~/.d2l-session` is used.
  - It adds `accounts/<account-hash>/` only when a username is configured.
- It deletes these files in that folder: `session.json`, `storage-state.encrypted.json` and `microsoft-session.json`.
- It also deletes a plaintext `storage-state.json` if an old install left one.
- It prints the names of the files it removed.
- The next tool call, or `auth`, does a full sign-in.

**What it keeps**

- It never touches the saved password.
- It never touches `config.json`.
- It never touches any authenticator or credential-store entry. The session encryption key stays and is reused.
- It never touches other accounts' directories.
- It never touches the MFA cooldown record.

**Scope**

- This is a local sign-out only. It does not log out of Microsoft or Brightspace on their servers.
- Every MCP server already running on this computer notices on its next request.
  - Before it uses its in-memory token or a cached response, it checks that `session.json` still exists.
  - A deleted file means signed out.
- Two exceptions:
  - A server started with `D2L_ACCESS_TOKEN` or `D2L_SESSION_COOKIE` is never signed out by a deleted file. It has no saved session.
  - A server older than this check keeps its in-memory token and cached answers, up to about an hour, which is the token lifetime.
- A user on an old version should quit and reopen their AI app.

**Stopping a background sign-in first**

- Before deleting, it stops a background sign-in that an AI app started for this session. It does this the same way `sign_out` does (`stopAutomaticSignIn`).
- It says so, and mentions the 5-minute wait for a new prompt.
- It stops only a verified `auth-cli.js --automatic` owner. It never does this on Windows.
- It holds the sign-in lock while it deletes. It never takes over a running sign-in.

**Exit codes for `auth --logout` (`runLogout` in `src/auth/logout.ts`)**

- If a sign-in it cannot stop is in progress, it deletes nothing, says so, and exits 2. A terminal `auth` run is one case. Any sign-in on Windows is the other. Exit 2 is the code `auth` uses for the same case.
- With nothing to clear, it says so and exits 0.
- Any other failure exits 1.

**`sign_out` (`src/tools/sign-out.ts`)**

1. It cancels a sign-in that is still waiting on MFA. There are two kinds of sign-in it can cancel.
   - This server's own sign-in, through `AuthRunner.cancel()`.
     - It SIGKILLs the child, its Chromium descendants, and its process group.
     - The MFA loop's failure path never runs, so no cooldown is recorded.
     - Every call waiting on that sign-in gets a `cancelled` error at once. This holds for calls here and for calls behind the shared HTTP server.
     - Those calls do not ride out the 5-minute window.
   - Another server process on this computer, through `stopAutomaticSignIn`.
     - Only a live owner is stopped. Its lock mode must be `automatic`, and `ps` must show its command line as an `auth-cli.js --automatic` child.
     - **Why:** so a reused PID is never killed.
     - This check is unavailable on Windows, so nothing is stopped there.
     - That other server answers its own waiting calls `cancelled`, because its child closed on SIGKILL.
     - A caller relaying a sign-in whose owner died gets `cancelled` too.
     - The dead owner's lock is reclaimed by the deletion that follows. The next tool call starts a new sign-in at once.
2. A cancelled sign-in does not get a new prompt sooner. See [Microsoft's held prompt](#microsofts-held-prompt).
3. A terminal `auth` run (lock mode `explicit`) is never cancelled.
4. It calls `clearSavedSession(config.sessionDir)`.
5. It calls `apiClient.clearCache()` and `tokenManager.forgetSession()`. The second drops this process's in-memory token and touches no files.
6. It answers in plain text, not JSON.

**`sign_out` answers**

- A cancelled sign-in is reported first. The text begins "Cancelled the Brightspace sign-in that was waiting for approval".
  - Then comes either the sign-out report, or "There was no saved session to remove."
  - It also says that the next question can take up to 5 minutes to show a new number.
- Signed out: it lists the files removed and what was kept.
  - It says other Brightspace apps on this computer are signed out, and sign in again from scratch on their next question.
  - It says a saved password or authenticator key can make that sign-in finish with little or no approval.
- Already signed out: there was no saved session.
- Cannot cancel: the lock is still held after cancelling, for example by a terminal `auth` run.
  - Nothing is deleted. Ask again after it finishes.
  - This is not flagged as an error.
- `D2L_ACCESS_TOKEN` or `D2L_SESSION_COOKIE` is in use: nothing is deleted. Remove the setting from the client config or `.env`.
- A file that cannot be deleted, `session.json` included: the answer is `isError`. It names the file and says to try again.
- Any other failure: the answer is `isError`, with fixed text and no raw error. The detail goes to the log.

`auth --logout` cancels the same way for a background sign-in that another app started. It has no server of its own to cancel.

## Browser-free sign-in

Two opt-in environment variables skip the Playwright browser entirely. They suit Docker, headless Linux, WSL without a display, or a tenant whose MFA requires a hardware key. Neither changes anything for a user who does not set them.

- **`D2L_ACCESS_TOKEN`** is a pre-issued Bearer token. It is an admin-issued Valence token, or one minted by a TA script. It is used directly on every request.
- **`D2L_SESSION_COOKIE`** holds the `d2lSessionVal` and `d2lSecureSessionVal` cookies copied from a logged-in browser.
  - It accepts the cookie-header form, `"d2lSessionVal=...; d2lSecureSessionVal=..."`. Extra cookies are fine, and either order works.
  - It also accepts just the two values, separated by a semicolon: `"<d2lSessionVal>;<d2lSecureSessionVal>"`.
  - It is sent on every request through the client's existing cookie auth, with the `cookie:` prefix in `D2LApiClient.buildAuthHeaders`.
  - It is not minted into a Bearer JWT. **Why:** minting needs an XSRF token, which only a live browser page can produce. A pasted cookie never carries one.

**Precedence**

- `D2L_ACCESS_TOKEN` beats `D2L_SESSION_COOKIE`. Both beat the normal stored-credential browser flow.
- Both are validated at config load (`src/utils/config.ts`), whichever one wins.
  - **Why:** a typo in the losing variable still fails loudly at startup, rather than falling back silently.

**Validation**

- Both values are rejected at config load. They are not trimmed or ignored.
  - The rejection applies if a value contains a CR, an LF, or a NUL character.
  - It also applies if a value has leading or trailing whitespace.
- Neither value is ever logged. The redaction rules are in `src/utils/logger.ts`.

**No renewal, by design**

- A token built from either variable is returned by `TokenManager.getToken()`.
  - It carries a far-future `expiresAt`, because there is no real expiry to track.
  - Its `source` is `"env"`.
- Only Brightspace can end it. When Brightspace answers 401, `TokenManager` returns `null` instead of the rejected value.
- `D2LApiClient` then throws an error that tells the user to paste a fresh cookie or token.
- It never starts `AuthRunner` or `auth-cli`, because there is no stored credential to drive a browser login from.
- `src/index.ts` wires up `AuthRunner` and the normal "session expired" message only when neither variable is set.
