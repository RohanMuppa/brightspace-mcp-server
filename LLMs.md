# LLMs.md

Guide for AI agents (Claude, Cursor, Windsurf, Copilot, Codex, etc.) helping a user install, use, or contribute to `brightspace-mcp-server`.

## Read the README first

Before anything else, read [README.md](https://github.com/RohanMuppa/brightspace-mcp-server/blob/main/README.md) for general context on what this project is, who it's for, and what a user can do with it. This file (LLMs.md) picks up from there with the concrete steps and codebase map you'll need to actually get things done.

## What this project is

An MCP (Model Context Protocol) server that connects an AI client to D2L Brightspace so it can read grades, assignments, announcements, syllabus, roster, discussions, and course content on demand.

Distributed on npm as `brightspace-mcp-server`. Register it as `npx -y brightspace-mcp-server@latest` so each client start pulls the newest version. Always include the `@latest` tag: without it npx prefers a binary already on PATH and will silently run an old global install instead. The auth CLI re-execs itself through the pinned command when it detects it is stale.

## Installing it for a user

Installing takes three stages: you do everything you can, the person signs in, then you check it worked (issue #258). Only stage 2 needs the person. Stop and report back if a stage fails.

### 1. Prepare everything yourself (no prompts)

Check `node --version` first. If Node is missing or below v22, tell the user to install the LTS from https://nodejs.org/ and stop. Then ask the user, in chat, which school they're at and the username they sign in with. Don't ask for their password; only stage 2 takes it, typed by them.

```bash
npx -y brightspace-mcp-server@latest setup --purdue --prepare --username <their username> --json
```

How to run it:

- **School:** use the school's flag: `--purdue`, `--suny`, `--western`, `--tudelft`, `--cuny`, `--leiden`, `--mcgill`, `--ngeeann` or `--javeriana`. For any other school, use `--url <their Brightspace address>` instead.
- **SUNY campus:** add `--campus "<campus>"` if you know it. Otherwise stage 2 asks.
- **Timeout:** allow several minutes. A first run can download Chromium (about 200 MB).

What it does, all without a prompt:
- checks Node, the native credential store, Chromium (downloading it when missing, unless `--no-browser-install`) and that the school is reachable;
- saves the public settings to `~/.brightspace-mcp/config.json`, with no password. It only saves once the school is reachable, so a mistyped `--url` can't replace a working setup, and it leaves alone a config that still holds an older version's password;
- registers the server in every AI app it finds: Claude Desktop, Cursor and Antigravity by editing their config files, and Codex and Claude Code through their own CLIs, at user scope.
  - An existing `brightspace` entry that runs something else is left alone and reported. Pass `--replace` to change it.
  - An entry that connects by URL to the shared local server (`http://127.0.0.1:<port>/mcp`, see the README's "One server for all your chats") is a deliberate setup: it is reported as set up (`shared_http`, with its `url`) and kept, auth settings included. Don't pass `--replace` for it unless the person asks to go back to one copy per chat.

Running it again changes nothing that is already right.

With `--json`, stdout is one JSON object. Progress lines go to stderr.
- `state`:
  - `ready_for_sign_in` (exit 0): go to stage 2.
  - `signed_in` (exit 0): a saved sign-in already works; skip to stage 3.
  - `needs_input` (exit 1): no school was given.
  - `blocked` (exit 1): fix each step whose `ok` is false, then rerun.
- `steps[]`: `{id, ok, blocking, line}`.
- `apps[]`: one `outcome` per app: `added`, `current`, `shared_http` (uses the shared server by URL; carries `url`), `replaced`, `different_left` or `failed`.
- `restart[]`: the apps that need restarting to load the server.
- `next`: `{command, needsHuman, instructions}`.

For any other client (Windsurf, Copilot, Zed, Continue, etc.), register `npx -y brightspace-mcp-server@latest` yourself. On Windows that is `cmd /c npx -y brightspace-mcp-server@latest`. Config formats and paths differ per client and change over time, so check the client's current docs rather than guessing.

### 2. Hand the sign-in to the person

`next.command` is the person's step, for example:

```bash
npx -y brightspace-mcp-server@latest setup --purdue --sign-in
```

It uses what stage 1 saved and asks only what needs them:
- their username or SUNY campus, if you didn't pass them;
- their password, or whether to keep one already saved;
- how they confirm sign-in:
  - 1: a phone app, either an approval or a code typed in the terminal. Chromium stays hidden.
  - 2: another way, such as a text message. This saves `headless: false`, and the sign-in page opens for them to finish. Automatic re-auth later stays hidden either way.
- how often to approve.

Then it signs in and prints `Setup complete!`. If sign-in doesn't finish, it exits 1 and prints the same command to run again. Rerunning is always safe.

It needs a terminal: without one it exits 2 rather than waiting for typing. So never run it in your own background shell; hand it over like this:

- **Run it where the user can type.** That means a visible terminal they control: a terminal tab or panel your app shows them, or one they open themselves (Terminal on macOS, PowerShell on Windows).
- **Say exactly where it is and what to do first.** Name the place the way they see it ("the terminal panel on the right, titled *brightspace setup*"), and link it if your app supports that. Tell them to click inside it before typing, because keystrokes go to the chat box until they do. Tell them to press Enter after each answer.
- **Warn them about the password prompt.** Only asterisks appear as they type, and they still press Enter. Then it asks how they confirm sign-in and waits for the approval on their phone.
- **Don't take "done" on faith.** Read the terminal yourself if you can. It is finished only when it prints `Setup complete!`. If it is still on a prompt, tell the user which question it is waiting on and where to answer it. Don't just ask again whether they are done. Don't offer a one-click "I'm done" reply: a beginner will click it before they have typed anything.
- **If typing in your panel doesn't work,** give them the one command to paste into their own terminal app, and say how to open that app.

The interactive wizard, `setup --purdue` with no mode flag, still works for a person setting up alone. It asks everything, registers apps before asking "Sign in now?", and also needs a terminal.

### 3. Verify

```bash
npx -y brightspace-mcp-server@latest doctor --json
```

`allOk: true` means the setup, the saved sign-in and one real course-list request all worked. Each failed check's `line` names its fix.

Then tell the user to fully quit and reopen the apps in `restart`, and ask a question such as "What's due this week?". Calling `get_my_courses` from the restarted app is the end-to-end check.

## Auth

There is no authentication step and no tool to check one. Call the tool that answers the user's question; if no valid session exists, the request signs in first and then proceeds. Never tell the user to authenticate before asking something, and never call a tool purely to establish a session.

A sign-in that cannot be completed comes back as the tool's own error, naming the cause and what to do: a locked credential store, a paused MFA cooldown, an unsupported login page, a network outage. Relay that text. Only the cooldown and unsupported cases need the terminal command below.

Concurrent tool calls on a cold session share one sign-in, so firing several tools at once is safe and produces a single MFA prompt.

## Re-auth

Access tokens are re-minted from the stored session cookie without a browser. When browser authentication is required, setup's MFA choice controls whether Chromium stays hidden for approval or terminal code entry, or opens for other interaction. Automatic MCP authentication cannot read a code from stdio; tell the user to run the explicit command below, which prompts without echoing the code into MCP logs. Missed approval pauses automatic browser authentication for five minutes. HTTP token renewal remains allowed, and the explicit command bypasses the cooldown. A tool call that triggers browser auth does not block for the whole approval window: it returns within seconds of an MFA challenge appearing, with the number to enter (or, on tenants that never show one, a plain "approve on your phone") in the tool's own error text — relay that text verbatim, tell the user to approve it, and call the tool again immediately — do not wait for the user to say they have approved: sign-in keeps running in the background and the retry polls it for up to 45 seconds (never past 55 seconds from the retry's start), returning the result as soon as the sign-in completes or the same number-to-enter error if it has not yet; keep calling until it succeeds or a different error is reported. When the client sends a progress token with the tool call, the challenge goes out as a progress notification on that call instead, and the call keeps waiting up to 45 seconds for the sign-in, never past 55 seconds from the start of authentication (so it answers inside the common 60-second client timeout): an approval in that window completes the original request; past it, the call returns the same number-to-enter error. No call waits more than 55 seconds even before a challenge appears: a sign-in still opening the browser or the school's login pages by then returns a "still starting in the background" error and keeps running — call the tool again right away; the retry joins the same sign-in (no second MFA prompt) and returns the number as soon as one appears. Network errors and locked native storage should be reported without retrying MFA.

The number can change mid-wait: if the request times out or is denied before approval, the server asks Microsoft (or Duo) for another one and the next tool response carries the new number — always relay the latest one, not one from an earlier call. Running the explicit auth command in a terminal also takes over a stuck background sign-in immediately, rather than waiting for it to finish or time out. A background sign-in nobody is waiting on is stopped 45 seconds after the last call that polled it (or relayed its number) was answered, without starting the MFA cooldown, so the next call starts a fresh sign-in with a fresh number. Several server processes (one per MCP client window) can share one session store; a call in a process whose sign-in finds another process's sign-in holding the lock is answered with that sign-in's number instead of a bare "already in progress". While MFA is pending, call one Brightspace tool at a time: a client that holds parallel results until the whole batch finishes can keep the number from the user until it is too late.

On a Duo tenant, a device-trust prompt ("Is this your device?") gating the push is answered yes automatically, which also makes Duo skip its device check on later logins from this machine — worth mentioning to a user signing in from a shared computer. `D2L_DUO_PASSCODE` switches from waiting for a push to typing a Duo Mobile passcode.

On Microsoft Entra's MFA page (number match or verification code, on `login.microsoftonline.com` only), the "Don't ask again for N days" checkbox is ticked once when remember-MFA is on, before the number is announced or a code is asked for, and an already-checked box is left alone. Remember-MFA is `setup` option 2 or 3 (default: option 1, off) saved as `rememberMfa` in `config.json`; `D2L_REMEMBER_MFA` overrides it either way (env > config.json > `false`). This is opt-in and off by default: unless it is turned on the box is left alone and the outcome is recorded as `off`. The window is the tenant's setting; a tenant that never shows the box simply keeps asking. A sign-in that fails after Entra renewed its cookies still saves the browser state when those cookies are strictly newer than the saved ones; any other failure leaves the saved state untouched. `get_server_info` reports `microsoftSession` — `staySignedIn`, `staySignedInExpires`, `rememberMfa` (`ticked`, `already`, `absent`, `unknown`, or `off`), `rememberMfaAt`, and `note`, a plain sentence saying that stay-signed-in alone doesn't skip 2FA and what the `rememberMfa` outcome means for it (#227) — read from a plain summary (`microsoft-session.json`, no cookie values) beside the browser state, and omits it when no browser state is saved.

Passwordless sign-in is shelved: `setup` no longer asks about it, always saves a password, and drops a `passwordless` value carried over in `config.json`. Only `D2L_PASSWORDLESS` (or a hand-edited `passwordless` in `config.json`) turns it on (env > config.json > `false`). When on, `loadConfig` reads no saved password; the default Entra flow counts a username alone as credentials, submits only the username, and waits on Microsoft's passwordless approval view (the "Use your password instead" link or `#idRemoteNGC_*` markers) as an MFA challenge instead of clicking through to the password page, announcing its number like number match. A password page in this mode fails at once with an error naming `D2L_PASSWORDLESS`. Every sign-in then needs a phone approval, so it is for interactive use only.

Automatic verification-code sign-in is opt-in per account: `setup` option 3 takes an authenticator
setup key or `otpauth://` URI, `saveSecureConfig` normalizes and stores it in the native credential
store under a `totp:`-prefixed account (never in `config.json` — `saveConfigStore` throws on it, as
it does for a password), and `loadConfig` reads it back as `totpUri` whenever a username is
configured. `D2L_TOTP_SECRET` overrides the stored value and is documented as weaker (process
environment, not the OS keychain); an unreadable credential store is treated as "no enrollment", not
a startup failure. With `totpUri` set, the Entra MFA loop clicks "Use a verification code" (falling
back to "sign in another way" / "I can't use my ... right now", each control at most once per login),
verifies the account Microsoft is displaying before typing anything, and submits an RFC 6238 code
generated locally — waiting out the rest of the period rather than submitting a code with under five
seconds of life or resubmitting a rejected one. The gate is the identity provider and the challenge
on screen, never a school URL: it never engages off `login.microsoftonline.com`, after a Duo
challenge, or on Microsoft's passwordless approval view, and if Entra offers no way to reach a code
within 30 seconds the login falls back to the ordinary announce-and-approve path. Fifteen seconds in,
the flow reports progress (`AUTH_AUTOMATIC_PENDING` on the auth child's stdout, and a
`{"kind":"automatic"}` challenge in the lock directory for other processes to relay), which reaches a
tool call as the `automaticPending` failure kind: "no phone approval is being requested, retry to
join the same login". A failed automatic sign-in records the same MFA cooldown. Dev mode logs
`mfa_method_selected` and `mfa_code_submitted` (no code, no seed). Neither the seed nor any generated
code is ever logged. Security: the seed beside the password collapses two factors into one on that
machine — it still defeats a remote attacker holding only the password, and defends against nothing
running as that user, which is why it ships off by default.

Visible mode applies to the manual `auth` command, whose window remains open for up to five minutes when automatic credential handling is unavailable or the identity provider needs direct interaction. Automatic recovery spawned by `AuthRunner` runs headless unless `D2L_HEADLESS` is set explicitly. Rerunning setup preserves the existing hidden or visible preference as the default choice.

```bash
npx -y brightspace-mcp-server@latest auth
```

### Fewer 2FA prompts (the two opt-in shortcuts)

`setup` asks ONE multiple-choice question, "How often do you want to approve sign-ins on your phone?", right after the MFA-method question: **1** every time (default, safest), **2** remember this computer (`rememberMfa` / `D2L_REMEMBER_MFA`, ticks Microsoft's "Don't ask again" box), **3** this computer answers Microsoft's code requests itself (a **saved authenticator key** in the OS keychain, or `D2L_TOTP_SECRET`; the server types the 6-digit code itself; also sets `rememberMfa` true). Options 2 and 3 are opt-in and not for shared computers, and 3 only helps when Microsoft asks for a code (otherwise sign-in falls back to the phone). The detail is in one place: [docs/sign-in.md#fewer-2fa-prompts](docs/sign-in.md#fewer-2fa-prompts), including the steps for getting the key from https://mysignins.microsoft.com. Send users there rather than re-explaining. Turn on by rerunning `setup` and picking 2 or 3; turn off by rerunning it and picking 1. Wording and the question itself (`askShortcutQuestion`, driven through a small `ShortcutIO` so it is testable) live in `src/utils/two-factor-shortcuts.ts`, shared by `setup`, the MFA tip, and `doctor`:

- Picking 1 or 2 while a key is saved asks "Remove the saved authenticator key from this computer? (yes/no) [yes]" and, on yes, deletes it after the config is saved (`deleteStoredTotpUri`). Picking 3 with no key saved shows a short how-to and the hidden key prompt; Enter with no key saves option 2 and says so. With a key already saved, an explicit 3 offers a replacement (Enter keeps it). On a rerun `setup` prints "Currently: N" and makes it the Enter default; a key saved without remember-this-device keeps remember off on Enter. The question is asked for every school and mode (no per-school gating exists: whether a code can be typed is only known at sign-in time); `askShortcutQuestion` takes an `applicable` pair and renumbers or skips if that ever changes. The key is never printed.
- A pending MFA approval message (`mfaPending` in `src/tools/tool-helpers.ts`) ends with one "Tip for the user: to be asked less often, rerun `setup`" line carrying the docs link, only when both options are off. It is never added when either is on, to a duplicate in the same batch, or to any other failure kind. `src/index.ts` records the state at startup with `setActiveShortcuts`; until then no tip is shown.
- `doctor` prints one `2FA shortcuts: remember this device on/off, authenticator key saved/not saved` line after its checks (informational: it never changes the exit code), plus the docs link when both are off. It only checks that a key exists and never reads the key into any output; if the credential store cannot be read it says "not checked".

## Sign out early (`sign_out` / `auth --logout`)

When the user wants to end the saved session before it lapses (a shared computer, handing the machine on, forcing a fresh sign-in), either call the `sign_out` tool (only when they explicitly ask; it runs the same deletion in-process) or have them run:

```bash
npx -y brightspace-mcp-server@latest auth --logout
```

It resolves the account's session directory exactly as sign-in does (`D2L_SESSION_DIR` override, else the configured or default `~/.d2l-session`, plus `accounts/<account-hash>/` only when a username is configured) and deletes `session.json`, `storage-state.encrypted.json`, and `microsoft-session.json` there, plus a plaintext `storage-state.json` if an old install left one. It prints the names it removed. The next tool call, or `auth`, does a full sign-in.

It never touches the saved password, `config.json`, any authenticator or credential-store entry (the session encryption key stays and is reused), other accounts' directories, or the MFA cooldown record. This is a local sign-out only: it does not log out of Microsoft or D2L on their servers. Every MCP server already running on this computer notices on its next request: before using its in-memory token or a cached response it checks that `session.json` still exists, and treats a deleted one as signed out. Two exceptions: a server started with `D2L_ACCESS_TOKEN` or `D2L_SESSION_COOKIE` is never signed out by a deleted file (it has no saved session), and a server older than this check keeps its in-memory token and cached answers, up to about an hour (the token lifetime). A user on an old version should quit and reopen their AI app to drop that right away.

It holds the sign-in lock while deleting and never takes over a running sign-in. If a sign-in is in progress it deletes nothing, says so, and exits 2 (the code `auth` uses for the same case); with nothing to clear it says so and exits 0; any other failure exits 1.

`sign_out` (`src/tools/sign-out.ts`) calls the same `clearSavedSession(config.sessionDir)` and then `apiClient.clearCache()` and `tokenManager.forgetSession()` (drops this process's in-memory token, touches no files), and answers in plain text rather than JSON. Outcomes: signed out (lists the files removed, what was kept, and says other Brightspace apps on this computer are signed out and sign in again from scratch on their next question, and that a saved password or authenticator key can make that sign-in finish with little or no approval); already signed out (no saved session); sign-in in progress (the sign-in lock is held, or `AuthRunner.busy()` says this process has a sign-in child that has not exited yet, which covers the moment before the child takes the lock; nothing deleted, ask again after it finishes; not flagged as an error); `D2L_ACCESS_TOKEN`/`D2L_SESSION_COOKIE` in use (nothing deleted, remove the setting from the client config or `.env`); a file that could not be deleted, `session.json` included (`isError`, names the file, try again); any other failure (`isError`, fixed text with no raw error; the detail goes to the log). Never call it to recover from an error or to retry a sign-in.

## Browser-free sign-in (`D2L_SESSION_COOKIE` / `D2L_ACCESS_TOKEN`)

Two opt-in environment variables bypass the Playwright browser entirely, for Docker, headless Linux, WSL without a display, or a tenant whose MFA requires a hardware key. Neither changes anything for a user who doesn't set them.

- **`D2L_ACCESS_TOKEN`** — a pre-issued Bearer token (admin-issued Valence token, or one minted by a TA script). Used directly on every request.
- **`D2L_SESSION_COOKIE`** — the `d2lSessionVal` and `d2lSecureSessionVal` cookies copied from a logged-in browser. Accepts either the cookie-header form (`"d2lSessionVal=...; d2lSecureSessionVal=..."`, extra cookies and either order are fine) or just the two values separated by a semicolon (`"<d2lSessionVal>;<d2lSecureSessionVal>"`). It is sent on every request via the client's existing cookie-based auth (the `cookie:` prefix in `D2LApiClient.buildAuthHeaders`) rather than minted into a Bearer JWT — minting needs an XSRF token that only a live browser page can produce, which a pasted cookie never carries.

**Precedence:** `D2L_ACCESS_TOKEN` > `D2L_SESSION_COOKIE` > the normal stored-credential browser flow. Both are validated at config load (`src/utils/config.ts`) regardless of which one wins, so a typo in the losing variable still fails loudly at startup rather than silently falling back.

**Validation:** both values are rejected at config load — not silently trimmed or ignored — if they contain a CR, LF, or NUL character, or have leading/trailing whitespace. Neither value is ever logged (see the redaction rules in `src/utils/logger.ts`).

**No renewal, by design:** a token built from either variable is handed back by `TokenManager.getToken()` with a far-future `expiresAt` (there is no real expiry to track) and `source: "env"`. The only thing that can end it is Brightspace itself answering 401, at which point `TokenManager` returns `null` instead of the same rejected value, and `D2LApiClient` throws an error telling the user to paste a fresh cookie or token — it never spawns `AuthRunner`/`auth-cli`, because there is no stored credential to drive a browser login from. `src/index.ts` only wires `AuthRunner` and the normal "session expired" message when neither variable is set.

## Available tools

Registered in `src/tools/index.ts`, schemas in `src/tools/schemas.ts`:

| Tool | Purpose |
|------|---------|
| `get_my_courses` | List enrolled courses, each with `startDate`/`endDate` (the enrollment's `Access.StartDate`/`Access.EndDate`) alongside the existing fields — emitted unconditionally, independent of `currentOnly` |
| `get_my_grades` | Grades for a course or all courses |
| `get_assignments` | Assignments with due dates and submission status |
| `get_assignment_rubric` | Full rubric table (criteria groups, levels, points, descriptions) for a dropbox assignment, plus the student's own graded outcome per criterion when the tenant exposes it |
| `get_upcoming_due_dates` | Due dates across all courses within a window |
| `get_calendar_events` | Course calendar events (exams, labs, schedule changes, hand-made deadlines) in a window, default the next 7 days |
| `get_announcements` | Recent course announcements, with each one's attached files (`attachments`). `body` is the full post as markdown converted from D2L's Html (links, lists, tables and embedded-content addresses kept), falling back to D2L's plain Text only for a text-only post; `pagination.truncated` means more posts remain, never that a body was cut |
| `get_syllabus` | Syllabus document for a course |
| `get_course_content` | Module tree and content topics; module descriptions are Markdown preserving embedded links (with plain-text fallback); a module that links course files from its description also carries `courseFiles`, the paths to pass to `download_file` as `coursePath` |
| `get_discussions` | Discussion forums and recent posts |
| `search_course` | Keyword search across a course's content (modules/topics/file names), announcements, and discussion forums/topics in one call |
| `get_roster` | Classlist for a course |
| `get_my_groups` | The current user's project/discussion groups in a course, with each group's members |
| `get_classlist_emails` | Emails of classmates and instructors |
| `download_file` | Get a file attachment — course content (`topicId`), a file an instructor linked by path inside a module description rather than adding as a topic (`coursePath`: `Notes/Lecture 1.pdf` or the `quickLink.d2l?...type=coursefile` URL from `get_course_content`; fetched with the saved web session, so it needs a signed-in session), a submission (`folderId` + `fileId`), or an announcement attachment (`newsId` + `fileId`). `downloadPath` is optional: omit it to get the file back inline in the tool response (extracted text for PDFs/Office docs, an image block for jpeg/png/gif/webp, capped at 10MB / 400k extracted characters), or pass an absolute host path to save it to disk (streamed, up to 2GB) |
| `get_assignment_files` | Read the files attached to an assignment (spec, rubric, starter workbook) and return their text |
| `get_announcement_files` | Read the files attached to an announcement (prompts, rubric, updated schedule) and return their text |
| `get_video_transcript` | Transcript of a video embedded in course content (Kaltura, YouTube), with timestamps |
| `get_server_info` | Running version, Node runtime, platform, config and session paths, school URL, whether a credential is stored, the server's local timezone and UTC offset (`localTimezone`, `utcOffsetMinutes`), `signedInAs` (`uniqueName`/`displayName`) once known, `microsoftSession` (what Microsoft remembered) once a browser sign-in is saved, and `requests` (lightweight API client counters) — no network call, no secrets |
| `get_dropbox_folders` | Every assignment (dropbox) folder in a course, with due dates, submission type, visibility, and whether rubrics are attached |
| `get_dropbox_submissions` | Instructor/TA: every student's (or group's) submission to a dropbox folder — submitter, submitted date, late status, files, and feedback/grading status |
| `get_dropbox_user_submissions` | Instructor/TA: all submissions made by one specific student (or group) in a dropbox folder |
| `get_dropbox_feedback` | Feedback saved for a dropbox folder — score, graded state, feedback text, rubric assessment. Omit `entityType`/`entityId` to read the signed-in student's own released feedback; pass them (instructor/TA) for any user or group |
| `get_rubrics_for_object` | The full rubric table (criteria, levels, points) attached to a dropbox folder |
| `download_dropbox_submission_file` | Instructor/TA: download one file from a student's (or group's) dropbox submission |
| `sign_out` | Delete this computer's saved Brightspace session for the configured account (the in-chat `auth --logout`), then clear this server's response cache and in-memory token. Call it ONLY when the user explicitly asks to sign out or log out of Brightspace — never to fix an error, as part of another answer, or to retry a sign-in. Annotated `destructiveHint: true` (not read-only), so clients ask first. Plain-text result; no arguments |

These twenty-six are the whole surface. An available-update notice, when there is one, rides along as a second text block on the first successful result.

Of the `get_dropbox_*`/`download_dropbox_submission_file` tools above, `get_dropbox_submissions`, `get_dropbox_user_submissions`, `get_dropbox_feedback` (when given another user's or a group's id), and `download_dropbox_submission_file` are instructor/TA-side: they read every student's submissions and feedback for a course, which Brightspace only grants to course staff. A student account calling one of those gets a clear "Instructor or TA access required for this course" note (403) rather than a generic or broken-looking error. `get_dropbox_folders` and `get_rubrics_for_object` read the same folder-listing endpoint a student's own client uses, so they are not gated the same way. `get_dropbox_feedback` called with no `entityType`/`entityId` reads the student's own feedback (`feedback/user/{whoami id}`), which D2L documents as visible to the learner once released: a 403 or 404 there is reported as "not released / not graded", not as a missing staff role. A 404 (no folders, no submissions, folder not found) comes back as an empty list/null with an explanatory `note`, not a failure. They are read-only — there is no tool in this server that posts a grade or feedback back to Brightspace.

`download_file`'s two response modes (`src/tools/download-file.ts`): disk mode (`downloadPath` given) keeps the same JSON shape, with an additive `mode: "disk"` field; it streams the body to a hidden temporary file in the target directory (`secureStreamDownload`), type-checks it there, and renames it into place, so it is capped at 2GB rather than the 50MB that bounds in-memory inline downloads. Inline mode (`downloadPath` omitted, and now the default) returns `mode: "inline"` content directly in the tool response instead: extracted text (via the existing `pdf-extractor.ts`/`zip-extract.ts`) for PDFs and `.docx`/`.xlsx`/`.pptx`, an `ImageContent` block for `jpeg`/`png`/`gif`/`webp`, and a short description pointing back to disk mode for anything else. It deliberately never emits an MCP `EmbeddedResource` — some clients route an embedded `application/pdf` into a document pipeline that rejects PDFs containing JBIG2-compressed images (common in scanned academic PDFs) and can fail the whole tool response. Inline responses are capped at 10MB and 400,000 characters of extracted text, each with an explicit truncation/oversize message naming `downloadPath` as the way to get the full file. `validateFileType`'s magic-byte allowlist is enforced in both modes. `download_dropbox_submission_file` (`src/tools/download-dropbox-submission-file.ts`) always saves to disk and goes through the same `secureStreamDownload` path and 2GB `DISK_MAX_FILE_SIZE` cap (listed size, Content-Length, and bytes actually received).

`search_course` reuses the same fetchers as `get_course_content`, `get_announcements`, and `get_discussions` (`fetchRootContent`/`buildContentTree`, `fetchCourseNews`, `fetchForums`/`fetchForumTopics`) rather than hitting the API a second way, so results share their cache. It scores in-memory term matches, case-insensitive and tokenized on non-alphanumerics: a result matching every query term always outranks one matching only some, and within that tier a title match outranks a body-only match. One source failing (e.g. a 403 on discussions) is skipped rather than failing the whole search, and named in the response's `note`.

`get_roster`'s default staff-only view (`includeStudents=false`) tries Purdue's own instructor/TA role IDs first; on a tenant where that returns nobody, it falls back to matching `ClasslistRoleDisplayName` case-insensitively against instructor/professor/lecturer/teaching assistant/coordinator/grader/TA and reports that in the response's `roleFilter` field.

`get_server_info`'s `requests` field is `D2LApiClient.stats()`: `statusClasses` (counts for `2xx`/`401`/`403`/`404`/`429`/`5xx`, plus `other` for anything outside that list), `networkErrors`, `cacheHits`/`cacheMisses`, `coalescedJoins`, and `tokenRefreshes`. It is a snapshot of this process only (resets on restart), additive to the existing fields, and never carries a URL, username, or token. `coalescedJoins` comes from request coalescing in `D2LApiClient.get()`: a GET already in flight for the same unresolved path is joined instead of issuing a second fetch, which matters because Claude Desktop fans out tool calls in parallel and the tools themselves fan out per course. A TTL'd call that joins an in-flight request for the same path counts as both a cache miss (it wasn't served from the cache) and a coalesced join (it didn't issue its own fetch) -- the two counters overlap rather than partition the calls.

### Available prompts

Registered in `src/prompts/index.ts` (one file per prompt, same shape as `src/tools/`). A client that
shows server-provided prompts in a picker (e.g. Claude Desktop) surfaces these as one-click starting
points; each renders a single user message that names the tools above by their real names:

| Prompt | Arguments | What it does |
|--------|-----------|--------------|
| `weekly_briefing` | none | 7-day briefing of due dates, new announcements, and grade changes across all courses |
| `grade_audit` | `courseId` (optional) | Analyzes grades for one course, or all of them, flagging missing/low items |
| `study_planner` | `daysAhead` (optional, default 7) | Plans study time from upcoming due dates and calendar events |
| `course_summary` | `courseId` (required) | Syllabus, content outline, assignments, and grades for one course |

`get_video_transcript` takes courseId+topicId (from `get_course_content`) or a direct videoUrl, and pages long transcripts via offset/maxChars (assignment files currently truncate extracted text without continuation) (maxChars is capped at 100000 per call; pass back `nextOffset` as `offset` until `truncated` is false to read the whole transcript). It supports Kaltura (e.g. Purdue's BoilerCast) via an anonymous widget session against the Kaltura API — no Brightspace session is needed or used for the transcript itself — and YouTube via its InnerTube player endpoint, asked as a mobile client (`src/utils/transcript/youtube.ts`). The client identity is load-bearing: caption URLs issued to a browser page are stamped `exp=xpe` and need a proof-of-origin token this server cannot mint, so they serve an empty body, while the mobile clients' URLs are stamped `exp=xpo` and serve captions as-is. The retired `timedtext?type=list` endpoint now answers HTTP 200 with an empty body for every video, which is why it is no longer used. Shorts, `/live/`, `/v/` and `youtube-nocookie.com` links all resolve. Auto-dubbed videos add *audio* tracks that share one caption list, so the default audio track's own caption choice is honoured; there is no transcript of synthesised dub speech. When the topic URL is a relative Brightspace LTI quickLink (`/d2l/...`), the tool requests it with the user's session and reads the LTI launch page (`src/utils/transcript/lti.ts`) for the video URL, taking a Kaltura KAF partner ID from the launch's `oauth_consumer_key` when the URL leaves it out. It also follows the `<d2l-lti-launch lti-launch-url>` element Brightspace's quickLink page renders to the tool launch, and reads an LTI 1.3 launch's `target_link_uri` on a hosted KAF host (`<partner>-<n>.kaf.kaltura.com`, which names the partner ID), which is how Purdue's BoilerCast launches today (#281); a launch that names no video returns `hasTranscript: false` with a message saying the LTI link could not be resolved. Panopto, YuJa, Echo360, and Vimeo are detected but not yet implemented: the tool names the platform and says so rather than returning an empty result. A video with no caption track also returns `hasTranscript: false` with an explanation, not an error — but a caption track that was listed and then served an empty or unreadable body is reported as a failure, not as an absent transcript, since the captions do exist. Every failure keeps its message as the first content block and adds a second, JSON block with `videoUrl` (session params stripped), `platform`, `hasTranscript: false`, a `reason` (`sign_in_required` for a YouTube sign-in or bot check, `access_blocked` for a caption download YouTube refused, `unavailable`, or `fetch_failed`) and a `recovery` sentence; a sign-in or bot check is never worked around, and the recovery is the user opening the link in their own browser and pasting YouTube's "Show transcript" text. A no-captions answer carries `reason: "no_captions"`.

`get_announcements` accepts count from 1 to 50 (default 10) and offset (default 0). Read pagination.nextOffset and continue until null. Without modifiedSince, content[0] remains the announcement array and a separate JSON text block contains pagination; with modifiedSince, pagination is a field in the response object. Pagination includes returned, total matching posts fetched, truncated, coverageComplete, and unavailableCourseIds. If a course could not be read, coverageComplete is false even when nextOffset is null: recover access and restart from offset 0. Offsets apply after filtering and global newest-first sorting. New or edited posts can shift offsets between calls; use stable course/filter arguments and reconcile announcement IDs when archiving.

Quiz attempt counts are unavailable to students on the Purdue tenant: `/quizzes/{id}/attempts/` answers 403. Those quizzes carry `attemptsAvailable: false` with null counts rather than a fabricated zero.

Assignment rows additionally carry `submissionStatus` (`"submitted"` / `"not_submitted"` / `"unknown"`) and quiz rows carry `attemptStatus` (`"known"` / `"unknown"`), with a `submissionStatusNote`/`attemptStatusNote` set only when unknown: any non-404 failure on the submission lookup (a 403, a 5xx, …), or a `ContentMetadataOnly` quiz whose attempts route is never called at all, means Brightspace simply did not return the data — not that nothing was submitted or attempted — so these additive fields separate a genuine empty answer from one Brightspace never gave. When the submission lookup is refused for an individual assignment, the student's own feedback page (`folder_user_view_feedback.d2l`) is read with the stored session cookie; if it lists a submission ID the row says `"submitted"` with `submissionSource: "feedbackPage"` (and `submission` stays `null`, since the page gives no file metadata), otherwise it stays `"unknown"`.

Assignments, quizzes, and due dates each carry a `url` field linking into Brightspace. For group assignment folders, `get_assignments`, `get_assignment_files` (discovery and file-reading), and `get_upcoming_due_dates` resolve the learner's group within the folder's `GroupTypeId` category using the same cached membership helper as `get_my_groups`. Individual folders (missing or null `GroupTypeId`, per [D2L's folder reference](https://docs.valence.desire2learn.com/res/dropbox.html#Dropbox.DropboxFolder)) use `grpid=0`; group folders use their actual group identifier. Missing, inaccessible, or ambiguous membership (or invalid non-null group category metadata) returns the course home with `urlKind: "course-home"` and a `urlNote` directing the learner to Assignments. A resolved folder has `urlKind: "assignment"`. The due-date tool still makes no submission, feedback, or attempt requests. `get_assignments` also returns `gradeOnly` items for gradebook columns that match no assignment or quiz, such as a proctored exam. `get_upcoming_due_dates` reads `DueDate` from assignments, `DueDate ?? EndDate` from quizzes,, `DueDate` from discussion topics (`type: "discussion"`), and each course's calendar events (`type: "event"`, `dueDate` = the event's start, plus `endDate` and `location` when set). A topic with no `DueDate` is an ungraded forum and is excluded. Brightspace generates a calendar event for every dated assignment, quiz, and discussion; an event generated from an item already in the list is dropped, so each deadline appears once, while hand-made events (exams, labs) always stay.

`get_assignments` finds a course's quizzes through three routes and merges them by quiz id: the paged `/quizzes/` list (`source: "quizList"`), quiz topics in `/content/toc` that the list omits (`source: "courseContent"`), and gradebook columns whose `AssociatedTool.ToolItemId` names a quiz neither route listed (`source: "gradebook"`; accepted only when `GET /quizzes/{id}` answers with a `GradeItemId` equal to that column's id, so a discussion or survey sharing the id is never mistaken for a quiz). **Behavior change:** a gradebook column linked to a quiz the list omits used to appear as a `gradeOnly` row; when that quiz is readable it now appears as a quiz row (`type: "quiz"`, the quiz id, `source: "gradebook"`) instead, with the quiz's dates and attempts. Gradebook-only rows now appear on tenants that send only the documented string `GradeType` (previously only a numeric `GradeObjectTypeId` matched), and never for hidden grade columns (`GradeObject.IsHidden`), the columns of hidden assignment folders, or the columns of quizzes with `IsActive: false`. At most 30 content quizzes per course have their own record or topic read; the rest are listed from the table of contents alone (`detailsStatus: "unavailable"`) and `quizCoverage` is `incomplete` with a note saying so. A column whose quiz cannot be read stays a `gradeOnly` row, and a `gradeOnly` row named like a quiz should be treated as a quiz whose details could not be read. A gradebook column counts as student-scored when its documented string `GradeType` is `Numeric`, `PassFail`, `SelectBox` or `Text` (a numeric `GradeObjectTypeId` of 1 to 4 is still accepted as a fallback); calculated, formula and category columns are ignored. The table of contents is requested with `ignoreDateRestrictions=true` (documented as open to students, supported from LE 1.67) because D2L's default view hides every module or topic outside its date window, which is where a closed or not-yet-open quiz lives; only a 400, 403 or 404 on that request falls back to the plain view, while a 429, a 5xx or a network failure counts the content as unread without a second request. A quiz topic is recognized by `ActivityType` 4, `TypeIdentifier` `Quiz`, a `type=quiz` quickLink, or a `/lms/quizzing/user/quiz_*` Url; its id comes from `ToolItemId`, a numeric `ActivityId`, or the Url's `qi=`, and failing those, from the gradebook column the topic's `GradeItemId` names (when that column's tool agrees with the topic's `ToolId`), so the topic and its column are one quiz. Hidden and broken topics are skipped. An `IsExempt` topic (D2L: "the user is exempt from the topic") is kept and its row carries `exempt: true`. A topic that still has no id is listed with `id: null`, its `topicId`, and a content-viewer `url`, unless a listed quiz already has the same title; the same id-less quiz linked from several modules (same title and link) is one row, and a gradebook column with the same title is treated as that quiz rather than listed again. Only an explicit `IsActive: false` hides a quiz; closed quizzes stay listed. Quizzes found without the quiz API carry no attempt data (`attemptStatus: "unknown"`), never an inferred zero, and a 404 from the attempts route only counts as zero attempts for a quiz the course's quiz list returned. Additive quiz-row fields, each present only when it applies: `availability` (`notYetOpen`, `open` or `closed`, from the quiz's own start and end dates; omitted when it has none), `detailsStatus: "unavailable"` with a `detailsStatusNote` (the row was built from course-content metadata alone because Brightspace would not return the quiz's details, which happens for closed, not-yet-open or special-access quizzes), and `exempt: true`. Gradebook probes are bounded: with a known quiz tool (from a listed quiz's column or a content quiz topic's `ToolId`) only that tool's columns are asked, at most 20 per course; with none known, at most 5. A probe that answered 404 or 403 is not repeated for ten minutes (per signed-in client; never for a 401 or 5xx). Each course also carries `quizCoverage` (`"complete"` or `"incomplete"`, with a `quizCoverageNote` when incomplete): incomplete means a source could not be read, including the content table of contents falling back to the default date-restricted view; a 404 on the quiz list (a course without the quiz tool) counts as answered and empty. `complete` means every source answered, not that every quiz is guaranteed to be listed: a quiz absent from all three is invisible to this tool, and an absent quiz must never be reported as missed or not taken.

`get_assignment_rubric` takes `courseId` and `assignmentId` (the dropbox folder id `get_assignments` already returns). It reads the folder's embedded `Assessment.Rubrics` first, falling back to the `/rubrics?objectType=Dropbox&objectId=` listing when a tenant omits them there. The student's own graded outcome is read from the same `myFeedback` route `get_assignments` already calls — never the unstable per-assessment rubric route — and is merged in per criterion when the tenant exposes it. A folder that 403s or 404s, or carries no rubric at all, answers `{ rubrics: [], note }` rather than an error.

Public instructor feedback is normalized from HTML to Markdown, with plain text as a fallback; private comments are never returned. Dropbox assignments preserve `feedback.score` and `feedback.feedback` and add `feedback.rubricAssessments` (rubric id, overall score/comment, and criterion outcomes when supplied). When the `myFeedback` read returns nothing (it is not a route D2L documents) and work was submitted, `get_assignments` falls back to the documented routes for the learner's own feedback: the `Feedback` D2L embeds in `submissions/mysubmissions/` (EntityDropbox, "Existing feedback will also be included if published"), then `feedback/user/{id}` for individual folders; draft (`IsGraded: false`) feedback is ignored, and `feedbackSource` (`myFeedback`, `submission`, or `user`) says which route answered. Assignment `feedbackStatus` distinguishes `retrieved` (the API returned a feedback record), `restricted` (403), `unavailable` (404 or null response), and `error` (another failed read). Grade rows add `gradeObjectId`, `feedbackStatus` (`retrieved` when public comments were returned, otherwise `unavailable`), and `feedbackUrl`. Assignments also add `feedbackCommentsStatus` (`retrieved` when overall or rubric comments were returned, otherwise `unavailable`), so a score-only record never implies that comments were retrieved. Assignments add a course gradebook `feedbackUrl`; grade rows preserve the linked quiz's `feedbackUrl` when present and otherwise use the gradebook URL. Both tools add `feedbackStatusNote` when comments were not returned. These URLs provide a place to check published feedback; they are not per-evaluation links. A null comment, missing feedback API record, or permission failure does not prove that published feedback is absent in Brightspace. No HTML pages are scraped and no restricted quiz viewer is opened by these tools.

Every `dueDate`/`DueDate`-style field in `get_assignments` and `get_upcoming_due_dates` carries an additive `dueIn` string next to it — a relative rendering ("in 3 days", "yesterday", "in 2 hours") computed with `Intl.RelativeTimeFormat`, so a caller never has to do its own date math against the raw ISO timestamp. `dueIn` is `null` wherever the due date itself is `null` (e.g. a `gradeOnly` row) or unparseable; `dueDate`/`DueDate` is never modified.

A dropbox assignment in `get_assignments` carries an additive `linkAttachments: [{ name, url }]` array when the instructor attached one or more URL links to the folder (D2L's `LinkAttachments`), mapped from `Title`/`Href`; a link with no `Href` is dropped. The field is omitted entirely, not an empty array, for the common case of a folder with no link attachments, so existing callers reading the assignment shape see no change.

The all-courses branch of `get_my_grades` returns an additive top-level `restrictedCourses: [{ courseId, courseName, gradeUrl }]` array for courses where the tenant's grade API answers 403 (an institutional access policy, not missing enrollment) — `gradeUrl` is the course's gradebook deep link (`gradebookUrl()` in `src/utils/deep-links.ts`). These courses are no longer silently dropped, and `courses` itself is unchanged. The single-course form of `get_my_grades` keeps the same plain error-result shape on a 403, but the error text now names the same gradebook URL so the student can open their grades directly. Any other per-course failure (a 404, a 5xx, a network error) puts the course in a `failedCourses: [{ courseId, courseName, gradeUrl }]` array with a `notice`, both present only when something failed, so a course is never missing from the result without a trace (#245).

A `get_my_grades` row scored from a quiz (matched by the quiz list's `GradeItemId`) carries an additive `feedbackUrl` — the quiz's page (`quizUrl()`) — and, when the gradebook `comments` is null, a `feedbackNote` saying feedback may still exist on the quiz's submissions page, which the student API cannot read and which can require a restricted viewer such as Respondus LockDown Browser. A null `comments` without `feedbackNote` means no comment was returned and no quiz association was resolved; it never proves published feedback is absent. Rows not linked to a quiz keep their gradebook source and retrieval status. A refused quiz list loses only the quiz association; grades and gradebook source links remain available.

`download_file`'s magic-byte allowlist (`ALLOWED_MIME_TYPES` in `src/utils/file-validator.ts`) also accepts archives beyond zip: `application/x-7z-compressed`, `application/gzip` (plus the legacy alias `application/x-gzip`, kept the way `application/x-zip-compressed` already sits beside `application/zip`), `application/x-tar`, and `application/x-bzip2` — so starter-code and resource archives in those formats download instead of being refused outright.

`get_calendar_events` takes optional `courseId`, `from`/`to` (ISO 8601 with offset; default now → now + 7 days), and `includeGenerated` (default `false`). Each event is `{ id, title, courseId, courseName, start, end?, location?, description? (markdown), url, generatedFrom? }`, sorted by `start`; `generatedFrom: { type, id }` marks an event Brightspace generated from another item (`type` is `assignment`, `quiz`, `discussion`, `module`, `topic`, …) and those are hidden unless `includeGenerated` is true. It reads `/calendar/events/myEvents/`, the per-user feed that honours event visibility. A course whose calendar fails to load still lets the others return, and a second text block in `content[1]` names its course id so the list is not read as complete.

`get_course_content` topics and modules, and `get_announcements` items, carry a `lastModified` field (D2L's `LastModifiedDate`, or `null` when the tenant didn't send one). Both tools also accept an optional `modifiedSince` (ISO 8601 datetime, e.g. `2026-01-15T00:00:00Z`) that returns only items at or after that timestamp — useful for "what's new since I last checked" instead of re-fetching everything. A malformed value is a validation error naming the expected format, not a silently empty result. An item with no `lastModified` is always included rather than excluded, the same way a null due date is never treated as "not due" elsewhere in this server — dropping it silently would be indistinguishable from data loss. For `get_course_content`, a module is kept whenever any descendant topic matches, even if the module's own timestamp doesn't, so a matched topic never arrives with no surrounding context; the module's own `children` array reflects only the topics that matched. Passing `modifiedSince` adds `modifiedSince`, `returned`, and `filteredOut` to the response so a caller can tell "nothing changed" apart from "the filter was wrong"; omitting it leaves the response shape exactly as before (a bare array for `get_announcements`).

While a sign-in is still being worked on in the background, `get_assignments`, `get_my_grades`, `get_upcoming_due_dates`, `get_calendar_events`, `get_announcements`, and `get_roster` report it rather than silently returning an empty or partial result that reads as a real measurement — but never by changing a response's documented shape. `get_my_grades`, `get_roster`, and a `get_announcements` call that passed `modifiedSince` already answer with an object, so `authPending: true`, a `notice` string, and (for the tools that aggregate courses) `unavailableCourseIds` join the rest of that JSON. The tools that normally answer with a bare array — `get_upcoming_due_dates`, `get_calendar_events`, and `get_announcements` without `modifiedSince` — keep returning that same array, holding whatever courses did answer, as `content[0]`; the notice (naming which course ids are unavailable) is appended as a second text block in `content[1]` instead of changing `content[0]`'s shape. `get_roster`'s non-`includeStudents` view keeps whichever of the instructor/TA routes did answer rather than discarding it just because the other is still pending.

## Codebase map

```
src/
  index.ts                  Entrypoint: subcommand routing, stdio server (default) or `http`
  server.ts                 Shared runtime (session, sign-in, API client) and the McpServer factory that registers every tool and prompt
  http-server.ts            `http`: stateless Streamable HTTP on 127.0.0.1 with Host/Origin, bearer token, and body checks
  setup.ts                  `setup`: interactive wizard and `--sign-in`; routes `--prepare`
  setup/
    args.ts                 setup's flags and modes (wizard, --prepare, --sign-in)
    presets.ts              School presets (`--purdue`, ...) and lookup by URL
    config.ts               Saved-settings merge shared by every mode
    clients.ts              AI apps setup registers in (one list for wizard and prepare)
    prepare.ts              `setup --prepare`: no-prompt install steps for agents, JSON result
  auth-cli.ts               Manual reauth (CLI subcommand `auth`; `auth --logout` ends the saved session)
  doctor.ts                 Beginner diagnostic (CLI subcommand `doctor`)
  update.ts                 Self-update checker
  tools/
    index.ts                Tool registry
    schemas.ts              Zod input schemas for every tool
    tool-helpers.ts         Shared helpers (course resolution, formatting)
    get-*.ts                One file per tool
    download-file.ts        Binary download + file-type detection
    content-availability.ts Shared release-window logic (hidden/locked/not_yet_open/ended)
    topic-availability.ts   Explains a download_file failure using topic/TOC availability metadata
  prompts/
    index.ts                Prompt registry
    weekly-briefing.ts      weekly_briefing prompt
    grade-audit.ts          grade_audit prompt
    study-planner.ts        study_planner prompt
    course-summary.ts       course_summary prompt
  api/
    client.ts               HTTP client wrapping the Valence/D2L API. lp()/le()
                            leave the version as a {lp}/{le} placeholder that
                            get()/getRaw() substitute, so discovery and sign-in
                            happen on the first request rather than at startup
    version-discovery.ts    Resolves per-product API versions
    cache.ts                In-memory response cache
    rate-limiter.ts         Token-bucket limiter
    errors.ts               API error taxonomy
    types.ts                D2L response types
  auth/
    auth-runner.ts          Orchestrates reauth on 401/expiry; `busy()` is true while this process has a sign-in child running (used by `sign_out`)
    browser-auth.ts         Playwright-driven login flow
    sso-flow.ts             Picks the login flow for the configured host
    purdue-sso.ts           Default SSO handler (Shibboleth, CAS, Entra forms)
    suny-sso.ts             SUNY campus selection
    cuny-sso.ts             CUNY Login (Oracle OAM) credentials and authenticator code
    mcgill-sso.ts           McGill myCourses SAML entry point, then shared Entra flow
    javeriana-sso.ts        Javeriana Cali (MobilityGuard OneGate) credentials and authenticator code
    session-store.ts        AES-256-GCM token persistence and v1 migration
    browser-state-store.ts  Encrypted cookie and browser storage persistence
    credential-store.ts     Native password and encryption-key storage
    auth-lock.ts            Process-shared authentication and write locks
    logout.ts               `auth --logout`: deletes the saved session files under the sign-in lock (shared with the `sign_out` tool)
    mfa-challenge.ts        Pending MFA challenge shared with other processes through the lock directory
    auth-cooldown.ts        Failed-MFA automatic retry policy
    token-manager.ts        Token refresh and validation; `forgetSession()` drops the in-memory token without touching files (used by `sign_out`)
  utils/
    config-store.ts         ~/.brightspace-mcp/config.json reader/writer
    config.ts               Resolved config (store + env fallback)
    course-filter.ts        Filter enrolled vs archived courses, and (currentOnly) vs out-of-term courses
    course-files.ts         Course-file path rules shared by download_file (`coursePath`) and get_course_content (`courseFiles`)
    download-helpers.ts     Stream-to-disk with validation
    browser-install.ts      Chromium check (prepare, doctor), install via the bundled Playwright, missing-browser hint
    file-validator.ts       Magic-byte file-type checks
    saved-session.ts        Read-only saved sign-in checks shared by doctor and prepare
    html-attributes.ts      Quote-aware tag attribute reading and entity decoding for raw D2L HTML
    html-converter.ts       HTML to Markdown via turndown
    pdf-extractor.ts        PDF text extraction via unpdf
    logger.ts               Structured logging
    update-checker.ts       npm version comparison
    two-factor-shortcuts.ts The one "how often do you approve sign-ins" setup question, plus shared wording/state (setup, MFA tip, doctor)
    errors.ts               User-facing error taxonomy
  types/                    Shared TypeScript types
```

## Commands

| Command | What it does |
|---------|--------------|
| `npx -y brightspace-mcp-server@latest setup` | Interactive setup wizard (needs a terminal) |
| `npx -y brightspace-mcp-server@latest setup --purdue --prepare --username <u> --json` | For AI agents: everything but the password and sign-in, with no prompts — checks, Chromium download, settings, registering AI apps. Takes `--url`, `--campus`, `--replace`, `--no-browser-install`. See [Installing it for a user](#installing-it-for-a-user) |
| `npx -y brightspace-mcp-server@latest setup --purdue --sign-in` | The person's last install step: password, how they confirm sign-in, then sign-in. Uses what `--prepare` saved |
| `npx -y brightspace-mcp-server@latest setup --help` | Every setup flag |
| `npx -y brightspace-mcp-server@latest setup --purdue` | Setup with Purdue preset |
| `npx -y brightspace-mcp-server@latest setup --suny` | Setup with SUNY preset (also asks for campus) |
| `npx -y brightspace-mcp-server@latest setup --cuny` | Setup with CUNY preset |
| `npx -y brightspace-mcp-server@latest setup --mcgill` | Setup with McGill preset |
| `npx -y brightspace-mcp-server@latest setup --ngeeann` | Setup with Ngee Ann Polytechnic preset |
| `npx -y brightspace-mcp-server@latest setup --javeriana` | Setup with Javeriana Cali preset |
| `npx -y brightspace-mcp-server@latest auth` | Manual reauth |
| `npx -y brightspace-mcp-server@latest auth --logout` | Delete this computer's saved session so the next call does a full sign-in. Keeps the password, `config.json`, and credential-store entries. Local only |
| `npx -y brightspace-mcp-server@latest doctor` | Diagnose a broken setup — Node version, Chromium, saved config, credential store, Brightspace reachability, saved sign-in, a real course-list call, and installed version, each as a ✓/✗ line with one plain-English next step, then one informational line on the 2FA shortcuts (remember this device, saved authenticator key). `--json` prints `{checks, allOk, notes}` instead |
| `npx -y brightspace-mcp-server@latest` | Run the MCP server (registered in AI client config) |
| `npx -y brightspace-mcp-server@latest http` | Opt-in: one shared Streamable HTTP server at `http://127.0.0.1:18765/mcp` for every client on the computer, instead of one stdio process per chat. Needs `D2L_HTTP_TOKEN`; takes `--port`. The user starts it and keeps it running; clients connect by URL and never start it, and a second copy on a taken port exits with an error. Ctrl+C lets calls in progress finish. Setup steps: [README](README.md#one-server-for-all-your-chats-optional) |
| `npm run build` | Compile TypeScript to `build/` |
| `npm run dev` | Watch-mode TypeScript compile |
| `npm run test` | Run Vitest suite |
| `npm run test:run` | Run Vitest once |

## Environment variables

Every setting the server reads from the environment. All are optional; `setup` writes the usual ones to `~/.brightspace-mcp/config.json`, and an environment value overrides the saved one (env > `config.json` > default, resolved in `src/utils/config.ts`). A `.env` file in the working directory is loaded too. Boolean settings accept `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`; anything else is ignored with a `[config]` warning and the next source wins. `tests/release/env-docs.test.ts` fails if `src/` reads a `D2L_*` variable this table does not name.

| Variable | Default | What it does |
|----------|---------|--------------|
| `D2L_BASE_URL` | `https://purdue.brightspace.com` | The school's Brightspace URL. Must be HTTPS with no embedded credentials; only the origin is kept |
| `D2L_USERNAME` | from `config.json` | Sign-in username. Also selects the account's session directory (`accounts/<account-hash>/`) |
| `D2L_PASSWORD` | none | Sign-in password. Copied into the OS credential store for the account on startup, never to a file. Ignored when passwordless sign-in is on |
| `D2L_SESSION_DIR` | `~/.d2l-session` | Root of the per-account session directories. `~` is expanded |
| `D2L_TOKEN_TTL` | `3600` | Seconds an access token is used before it is re-minted. Must be a whole positive number; anything else is ignored with a warning |
| `D2L_HEADLESS` | `true` | `false` shows the browser during sign-in, for MFA methods that need a click. Automatic recovery stays headless unless this is set explicitly |
| `D2L_REMEMBER_MFA` | `false` | Tick Microsoft Entra's "Don't ask again" box (see [Re-auth](#re-auth)) |
| `D2L_PASSWORDLESS` | `false` | Microsoft Entra passwordless phone approval; no password is read or saved (see [Re-auth](#re-auth)) |
| `D2L_TOTP_SECRET` | none | Authenticator setup key or `otpauth://` link for Entra code challenges. For CI and containers only; weaker than the keychain entry `setup` saves |
| `D2L_DUO_PASSCODE` | unset | Any non-empty value makes Duo type a Duo Mobile passcode instead of waiting for a push |
| `D2L_CAMPUS` | from `config.json` | Campus on a shared multi-campus instance (SUNY). `setup --suny` asks for it |
| `D2L_ACCESS_TOKEN` | none | Pre-issued Bearer token; skips the browser (see [Browser-free sign-in](#browser-free-sign-in-d2l_session_cookie--d2l_access_token)) |
| `D2L_SESSION_COOKIE` | none | Pasted `d2lSessionVal`/`d2lSecureSessionVal` cookies; skips the browser (same section) |
| `D2L_INCLUDE_COURSES` | all | Comma-separated course (org unit) ids to keep. Applies to multi-course tools; an explicit `courseId` argument bypasses it |
| `D2L_EXCLUDE_COURSES` | none | Comma-separated course ids to hide |
| `D2L_ACTIVE_ONLY` | `true` | Hide inactive enrollments and courses D2L reports as closed (`CanAccess: false`) |
| `D2L_CURRENT_ONLY` | `false` | Keep only courses whose `Access.StartDate`–`Access.EndDate` window contains now, like Brightspace's "Current Courses" widget. Courses with neither date are dropped |
| `D2L_NO_UPDATE_CHECK` | unset | Any non-empty value turns off the npm new-version notice and the auth CLI's self-update re-exec |
| `D2L_DEV_MODE` | unset | Exactly `true` adds local, content-free activity diagnostics (failure categories, HTTP operations and correlated authentication); normal stderr logging is unchanged ([docs/dev-mode.md](docs/dev-mode.md)) |
| `D2L_HTTP_TOKEN` | none | `http` only, and required there: the bearer token every request to the shared server must carry. At least 32 characters; never logged ([README](README.md#one-server-for-all-your-chats-optional)) |
| `D2L_HTTP_PORT` | `18765` | `http` only: the port on 127.0.0.1. `--port` overrides it |

## Storage locations

| Path | Contents | Permissions |
|------|----------|-------------|
| `~/.brightspace-mcp/config.json` | School URL, username, and public settings | 0600 |
| `~/.d2l-session/accounts/<account-hash>/session.json` | Encrypted access token, session cookies, and XSRF token (AES-256-GCM) | 0600 |
| `~/.d2l-session/accounts/<account-hash>/storage-state.encrypted.json` | Encrypted cookies and browser storage | 0600 |
| Native operating-system credential store | Password and random encryption key | OS access controls |

Environment values override stored configuration. An environment password is native-store input; the application does not rewrite the user's `.env` or client configuration. Account hashes bind saved state to school and username. Legacy unnamed state stays in the session root and is not replayed for a newly configured account. On upgrade, v1 secrets migrate only after verified secure writes. Retired v1 browser data may remain recoverable in Trash.

A `config.json` that is corrupt or unreadable (bad permissions, truncated write, hand-edited garbage) does not crash the server at startup: `loadConfig()` logs a `[config] WARN` naming the file and the failure, then continues as if no config.json existed, so environment variables still configure the server.

## Adding a school

Add a preset to `SCHOOL_PRESETS` in `src/setup.ts`. If the school uses a non-standard login flow (SAML, Shibboleth, custom SSO), add a handler in `src/auth/` alongside `purdue-sso.ts` and register it in `createSSOFlow()` in `src/auth/sso-flow.ts`.

## Adding a tool

1. Create `src/tools/<name>.ts` using an existing tool as a template.
2. Add the input schema to `src/tools/schemas.ts`.
3. Export it from `src/tools/index.ts`.
4. Register it in `src/index.ts`.
5. If it only reads, give its config `annotations: { readOnlyHint: true }`. Claude Code runs unmarked tools one at a time, which holds a batch behind a sign-in. Leave it off for a tool that can write a file (a `downloadPath` argument): clients also use it to skip permission prompts.

Build paths with `apiClient.lp()`, `le()`, or `leGlobal()` and nothing else. They return a template carrying a `{lp}`/`{le}` placeholder, which `get()` and `getRaw()` substitute after discovering the versions, so a new tool gets lazy discovery and sign-in without asking for them. A hand-written path with a literal version skips discovery and will break when the tenant moves.

## Release workflow

Publishing is automated by GitHub Actions on push to `main` when `version` in `package.json` changes, after the reusable CI matrix passes on macOS, Windows, and Linux. Keep `package.json`, the lockfile, and `server.json` versions aligned. Create the GitHub release only from the verified published commit.

Always bump `version` in `package.json` in the same commit as any code or docs change. The Action skips publish if the version is unchanged, which means users will not receive the update via `npx ...@latest`.

## Stability guarantees

Before renaming a tool, removing or renaming a response field, or changing a CLI flag, an env var, or an on-disk path, read [STABILITY.md](./STABILITY.md). It lists exactly what outside integrations and PRs may rely on; changes there need to be additive.

Instructor-provided assignment handouts use `download_file` with `courseId`, `folderId`, `fileId`, and `source: "assignmentAttachment"`. `get_assignment_files` includes these arguments as `downloadArgs` on each attachment. Omit `downloadPath` for inline text, or supply an absolute host directory to save the original file. Leaving `source` unspecified preserves downloads of your own submissions.
