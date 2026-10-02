# LLMs.md

Guide for AI agents (Claude, Cursor, Windsurf, Copilot, Codex, etc.) helping a user install, use, or contribute to `brightspace-mcp-server`.

## Read the README first

Before anything else, read [README.md](https://github.com/RohanMuppa/brightspace-mcp-server/blob/main/README.md) for general context on what this project is, who it's for, and what a user can do with it. This file (LLMs.md) picks up from there with the concrete steps and codebase map you'll need to actually get things done.

## What this project is

An MCP (Model Context Protocol) server that connects an AI client to D2L Brightspace so it can read grades, assignments, announcements, syllabus, roster, discussions, and course content on demand.

Distributed on npm as `brightspace-mcp-server`. Register it as `npx -y brightspace-mcp-server@latest` so each client start pulls the newest version. Always include the `@latest` tag: without it npx prefers a binary already on PATH and will silently run an old global install instead. The auth CLI re-execs itself through the pinned command when it detects it is stale.

## Installing it for a user

Follow these steps in order. Stop and report back if any step fails.

### 1. Verify Node.js 20+ and native secure storage

```bash
node --version
```

If Node is missing or below v20, tell the user to install the LTS from https://nodejs.org/ and stop. Require macOS Keychain, Windows Credential Manager, or an unlocked Linux Secret Service with `secret-tool` (`libsecret-tools` on Debian/Ubuntu). Linux uses libsecret directly; secrets pass through stdin, and temporary kernel-key storage is never used. v2 has no plaintext credential fallback.

### 2. Run the setup wizard

```bash
npx -y brightspace-mcp-server@latest setup
```

If the user is at Purdue, use the preset:

```bash
npx -y brightspace-mcp-server@latest setup --purdue
```

If the user is at a SUNY campus, use the SUNY preset. It also asks which campus
they attend, which lets sign-in skip SUNY's shared campus picker:

```bash
npx -y brightspace-mcp-server@latest setup --suny
```

If the user is at a CUNY campus, use the CUNY preset. Their username is the
full CUNY Login address, and sign-in asks in the terminal for the code from
their authenticator app. CUNY requires that code on every full sign-in, so
when the Brightspace session ends the user reruns `auth` in a terminal:

```bash
npx -y brightspace-mcp-server@latest setup --cuny
```

The wizard:

- prompts for the school's Brightspace URL (skipped with `--purdue`, `--suny`, or `--cuny`)
- asks whether MFA uses device approval, terminal code entry, or a visible browser, then authenticates accordingly
- saves the password in the native credential store and public settings in `~/.brightspace-mcp/config.json` (0600)
- writes the encrypted session below `~/.d2l-session/accounts/<account-hash>/` (AES-256-GCM)
- auto-configures Claude Desktop and Cursor, and uses their own CLIs to configure Codex and Claude Code when detected

Wait for the user to finish login and MFA before continuing.

### 3. Register the MCP server in the user's AI client

The server command to register is:

```
npx -y brightspace-mcp-server@latest
```

On **Windows**, wrap with cmd: `cmd /c npx -y brightspace-mcp-server@latest`.

Claude Desktop and Cursor are auto-configured by the setup wizard. When their CLIs are installed, Codex Desktop and CLI are configured together through `codex mcp add`, and Claude Code is configured at user scope through `claude mcp add --scope user`. For any other client (Windsurf, Copilot, Zed, Continue, etc.), look up the client's current MCP config format and file path, then add an entry with the command above. Config formats and paths differ per client and change over time, so verify against current client docs rather than guessing.

### 4. Restart the AI client

Tell the user to fully quit and reopen their AI client so it picks up the new MCP server.

## Auth

There is no authentication step and no tool to check one. Call the tool that answers the user's question; if no valid session exists, the request signs in first and then proceeds. Never tell the user to authenticate before asking something, and never call a tool purely to establish a session.

A sign-in that cannot be completed comes back as the tool's own error, naming the cause and what to do: a locked credential store, a paused MFA cooldown, an unsupported login page, a network outage. Relay that text. Only the cooldown and unsupported cases need the terminal command below.

Concurrent tool calls on a cold session share one sign-in, so firing several tools at once is safe and produces a single MFA prompt.

## Re-auth

Access tokens are re-minted from the stored session cookie without a browser. When browser authentication is required, setup's MFA choice controls whether Chromium stays hidden for approval or terminal code entry, or opens for other interaction. Automatic MCP authentication cannot read a code from stdio; tell the user to run the explicit command below, which prompts without echoing the code into MCP logs. Missed approval pauses automatic browser authentication for five minutes. HTTP token renewal remains allowed, and the explicit command bypasses the cooldown. A tool call that triggers browser auth does not block for the whole approval window: it returns within seconds of an MFA challenge appearing, with the number to enter (or, on tenants that never show one, a plain "approve on your phone") in the tool's own error text — relay that text verbatim, tell the user to approve it, and call the tool again once they have; sign-in keeps running in the background in the meantime and the retry picks up its result. Network errors and locked native storage should be reported without retrying MFA.

The number can change mid-wait: if the request times out or is denied before approval, the server asks Microsoft (or Duo) for another one and the next tool response carries the new number — always relay the latest one, not one from an earlier call. Running the explicit auth command in a terminal also takes over a stuck background sign-in immediately, rather than waiting for it to finish or time out.

On a Duo tenant, a device-trust prompt ("Is this your device?") gating the push is answered yes automatically, which also makes Duo skip its device check on later logins from this machine — worth mentioning to a user signing in from a shared computer. `D2L_DUO_PASSCODE` switches from waiting for a push to typing a Duo Mobile passcode.

On Microsoft Entra's MFA page (number match or verification code, on `login.microsoftonline.com` only), the "Don't ask again for N days" checkbox is ticked once when `D2L_REMEMBER_MFA=true` is set, before the number is announced or a code is asked for, and an already-checked box is left alone. This is opt-in and off by default: without the variable the box is left alone and the outcome is recorded as `off`. The window is the tenant's setting; a tenant that never shows the box simply keeps asking. A sign-in that fails after Entra renewed its cookies still saves the browser state when those cookies are strictly newer than the saved ones; any other failure leaves the saved state untouched. `get_server_info` reports `microsoftSession` — `staySignedIn`, `staySignedInExpires`, `rememberMfa` (`ticked`, `already`, `absent`, `unknown`, or `off`), `rememberMfaAt` — read from a plain summary (`microsoft-session.json`, no cookie values) beside the browser state, and omits it when no browser state is saved.

Visible mode applies to the manual `auth` command, whose window remains open for up to five minutes when automatic credential handling is unavailable or the identity provider needs direct interaction. Automatic recovery spawned by `AuthRunner` runs headless unless `D2L_HEADLESS` is set explicitly. Rerunning setup preserves the existing hidden or visible preference as the default choice.

```bash
npx -y brightspace-mcp-server@latest auth
```

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
| `get_my_courses` | List enrolled courses |
| `get_my_grades` | Grades for a course or all courses |
| `get_assignments` | Assignments with due dates and submission status |
| `get_upcoming_due_dates` | Due dates across all courses within a window |
| `get_calendar_events` | Course calendar events (exams, labs, schedule changes, hand-made deadlines) in a window, default the next 7 days |
| `get_announcements` | Recent course announcements, with each one's attached files (`attachments`) |
| `get_syllabus` | Syllabus document for a course |
| `get_course_content` | Module tree and content topics |
| `get_discussions` | Discussion forums and recent posts |
| `get_roster` | Classlist for a course |
| `get_classlist_emails` | Emails of classmates and instructors |
| `download_file` | Download a file attachment (PDF, slides, etc.) to disk — course content (`topicId`), a submission (`folderId` + `fileId`), or an announcement attachment (`newsId` + `fileId`) |
| `get_assignment_files` | Read the files attached to an assignment (spec, rubric, starter workbook) and return their text |
| `get_announcement_files` | Read the files attached to an announcement (prompts, rubric, updated schedule) and return their text |
| `get_video_transcript` | Transcript of a video embedded in course content (Kaltura, YouTube), with timestamps |
| `get_server_info` | Running version, Node runtime, platform, config and session paths, school URL, whether a credential is stored, `microsoftSession` (what Microsoft remembered) once a browser sign-in is saved, and `requests` (lightweight API client counters) — no network call, no secrets |

These sixteen are the whole surface. An available-update notice, when there is one, rides along as a second text block on the first successful result.

`get_server_info`'s `requests` field is `D2LApiClient.stats()`: `statusClasses` (counts for `2xx`/`401`/`403`/`404`/`429`/`5xx`, plus `other` for anything outside that list), `networkErrors`, `cacheHits`/`cacheMisses`, `coalescedJoins`, and `tokenRefreshes`. It is a snapshot of this process only (resets on restart), additive to the existing fields, and never carries a URL, username, or token. `coalescedJoins` comes from request coalescing in `D2LApiClient.get()`: a GET already in flight for the same unresolved path is joined instead of issuing a second fetch, which matters because Claude Desktop fans out tool calls in parallel and the tools themselves fan out per course. A TTL'd call that joins an in-flight request for the same path counts as both a cache miss (it wasn't served from the cache) and a coalesced join (it didn't issue its own fetch) -- the two counters overlap rather than partition the calls.

`get_video_transcript` takes courseId+topicId (from `get_course_content`) or a direct videoUrl, and pages long transcripts via offset/maxChars the same way `get_assignment_files` pages extracted text. It supports Kaltura (e.g. Purdue's BoilerCast) via an anonymous widget session against the Kaltura API — no Brightspace session is needed or used — and YouTube via its public timedtext endpoint. Panopto, YuJa, Echo360, and Vimeo are detected but not yet implemented: the tool names the platform and says so rather than returning an empty result. A video with no caption track also returns `hasTranscript: false` with an explanation, not an error.

Quiz attempt counts are unavailable to students on the Purdue tenant: `/quizzes/{id}/attempts/` answers 403. Those quizzes carry `attemptsAvailable: false` with null counts rather than a fabricated zero.

Assignments, quizzes, and due dates each carry a `url` field that deep-links into Brightspace. `get_assignments` also returns `gradeOnly` items for gradebook columns that match no assignment or quiz, such as a proctored exam. `get_upcoming_due_dates` reads `DueDate` from assignments, `DueDate ?? EndDate` from quizzes,, `DueDate` from discussion topics (`type: "discussion"`), and each course's calendar events (`type: "event"`, `dueDate` = the event's start, plus `endDate` and `location` when set). A topic with no `DueDate` is an ungraded forum and is excluded. Brightspace generates a calendar event for every dated assignment, quiz, and discussion; an event generated from an item already in the list is dropped, so each deadline appears once, while hand-made events (exams, labs) always stay.

`get_calendar_events` takes optional `courseId`, `from`/`to` (ISO 8601 with offset; default now → now + 7 days), and `includeGenerated` (default `false`). Each event is `{ id, title, courseId, courseName, start, end?, location?, description? (markdown), url, generatedFrom? }`, sorted by `start`; `generatedFrom: { type, id }` marks an event Brightspace generated from another item (`type` is `assignment`, `quiz`, `discussion`, `module`, `topic`, …) and those are hidden unless `includeGenerated` is true. It reads `/calendar/events/myEvents/`, the per-user feed that honours event visibility. A course whose calendar fails to load is skipped; the others still return.

`get_course_content` topics and modules, and `get_announcements` items, carry a `lastModified` field (D2L's `LastModifiedDate`, or `null` when the tenant didn't send one). Both tools also accept an optional `modifiedSince` (ISO 8601 datetime, e.g. `2026-01-15T00:00:00Z`) that returns only items at or after that timestamp — useful for "what's new since I last checked" instead of re-fetching everything. A malformed value is a validation error naming the expected format, not a silently empty result. An item with no `lastModified` is always included rather than excluded, the same way a null due date is never treated as "not due" elsewhere in this server — dropping it silently would be indistinguishable from data loss. For `get_course_content`, a module is kept whenever any descendant topic matches, even if the module's own timestamp doesn't, so a matched topic never arrives with no surrounding context; the module's own `children` array reflects only the topics that matched. Passing `modifiedSince` adds `modifiedSince`, `returned`, and `filteredOut` to the response so a caller can tell "nothing changed" apart from "the filter was wrong"; omitting it leaves the response shape exactly as before (a bare array for `get_announcements`).

## Codebase map

```
src/
  index.ts                  MCP server entrypoint, registers tools
  setup.ts                  Setup wizard (CLI subcommand `setup`)
  auth-cli.ts               Manual reauth (CLI subcommand `auth`)
  update.ts                 Self-update checker
  tools/
    index.ts                Tool registry
    schemas.ts              Zod input schemas for every tool
    tool-helpers.ts         Shared helpers (course resolution, formatting)
    get-*.ts                One file per tool
    download-file.ts        Binary download + file-type detection
    content-availability.ts Shared release-window logic (hidden/locked/not_yet_open/ended)
    topic-availability.ts   Explains a download_file failure using topic/TOC availability metadata
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
    auth-runner.ts          Orchestrates reauth on 401/expiry
    browser-auth.ts         Playwright-driven login flow
    sso-flow.ts             Picks the login flow for the configured host
    purdue-sso.ts           Default SSO handler (Shibboleth, CAS, Entra forms)
    suny-sso.ts             SUNY campus selection
    cuny-sso.ts             CUNY Login (Oracle OAM) credentials and authenticator code
    session-store.ts        AES-256-GCM token persistence and v1 migration
    browser-state-store.ts  Encrypted cookie and browser storage persistence
    credential-store.ts     Native password and encryption-key storage
    auth-lock.ts            Process-shared authentication and write locks
    auth-cooldown.ts        Failed-MFA automatic retry policy
    token-manager.ts        Token refresh and validation
  utils/
    config-store.ts         ~/.brightspace-mcp/config.json reader/writer
    config.ts               Resolved config (store + env fallback)
    course-filter.ts        Filter enrolled vs archived courses
    download-helpers.ts     Stream-to-disk with validation
    file-validator.ts       Magic-byte file-type checks
    html-converter.ts       HTML to Markdown via turndown
    pdf-extractor.ts        PDF text extraction via unpdf
    logger.ts               Structured logging
    update-checker.ts       npm version comparison
    errors.ts               User-facing error taxonomy
  types/                    Shared TypeScript types
```

## Commands

| Command | What it does |
|---------|--------------|
| `npx -y brightspace-mcp-server@latest setup` | Interactive setup wizard |
| `npx -y brightspace-mcp-server@latest setup --purdue` | Setup with Purdue preset |
| `npx -y brightspace-mcp-server@latest setup --suny` | Setup with SUNY preset (also asks for campus) |
| `npx -y brightspace-mcp-server@latest setup --cuny` | Setup with CUNY preset |
| `npx -y brightspace-mcp-server@latest auth` | Manual reauth |
| `npx -y brightspace-mcp-server@latest` | Run the MCP server (registered in AI client config) |
| `npm run build` | Compile TypeScript to `build/` |
| `npm run dev` | Watch-mode TypeScript compile |
| `npm run test` | Run Vitest suite |
| `npm run test:run` | Run Vitest once |

## Storage locations

| Path | Contents | Permissions |
|------|----------|-------------|
| `~/.brightspace-mcp/config.json` | School URL, username, and public settings | 0600 |
| `~/.d2l-session/accounts/<account-hash>/session.json` | Encrypted access token, session cookies, and XSRF token (AES-256-GCM) | 0600 |
| `~/.d2l-session/accounts/<account-hash>/storage-state.encrypted.json` | Encrypted cookies and browser storage | 0600 |
| Native operating-system credential store | Password and random encryption key | OS access controls |

Environment values override stored configuration. An environment password is native-store input; the application does not rewrite the user's `.env` or client configuration. Account hashes bind saved state to school and username. Legacy unnamed state stays in the session root and is not replayed for a newly configured account. On upgrade, v1 secrets migrate only after verified secure writes. Retired v1 browser data may remain recoverable in Trash.

## Adding a school

Add a preset to `SCHOOL_PRESETS` in `src/setup.ts`. If the school uses a non-standard login flow (SAML, Shibboleth, custom SSO), add a handler in `src/auth/` alongside `purdue-sso.ts` and register it in `createSSOFlow()` in `src/auth/sso-flow.ts`.

## Adding a tool

1. Create `src/tools/<name>.ts` using an existing tool as a template.
2. Add the input schema to `src/tools/schemas.ts`.
3. Export it from `src/tools/index.ts`.
4. Register it in `src/index.ts`.

Build paths with `apiClient.lp()`, `le()`, or `leGlobal()` and nothing else. They return a template carrying a `{lp}`/`{le}` placeholder, which `get()` and `getRaw()` substitute after discovering the versions, so a new tool gets lazy discovery and sign-in without asking for them. A hand-written path with a literal version skips discovery and will break when the tenant moves.

## Release workflow

Publishing is automated by GitHub Actions on push to `main` when `version` in `package.json` changes, after the reusable CI matrix passes on macOS, Windows, and Linux. Keep `package.json`, the lockfile, and `server.json` versions aligned. Create the GitHub release only from the verified published commit.

Always bump `version` in `package.json` in the same commit as any code or docs change. The Action skips publish if the version is unchanged, which means users will not receive the update via `npx ...@latest`.

## Stability guarantees

Before renaming a tool, removing or renaming a response field, or changing a CLI flag, an env var, or an on-disk path, read [STABILITY.md](./STABILITY.md). It lists exactly what outside integrations and PRs may rely on; changes there need to be additive.
