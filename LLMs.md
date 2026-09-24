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

The wizard:

- prompts for the school's Brightspace URL (skipped with `--purdue` or `--suny`)
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

Access tokens are re-minted from the stored session cookie without a browser. When browser authentication is required, setup's MFA choice controls whether Chromium stays hidden for approval or terminal code entry, or opens for other interaction. Automatic MCP authentication cannot read a code from stdio; tell the user to run the explicit command below, which prompts without echoing the code into MCP logs. Missed approval pauses automatic browser authentication for five minutes. HTTP token renewal remains allowed, and the explicit command bypasses the cooldown. Forward the MFA number to the user as it appears and wait for phone approval. Clients may hide server logs, so a terminal is the reliable place to see the number. Network errors and locked native storage should be reported without retrying MFA.

Visible mode remains open for up to five minutes when automatic credential handling is unavailable or the identity provider needs direct interaction. Rerunning setup preserves the existing hidden or visible preference as the default choice.

```bash
npx -y brightspace-mcp-server@latest auth
```

## Available tools

Registered in `src/tools/index.ts`, schemas in `src/tools/schemas.ts`:

| Tool | Purpose |
|------|---------|
| `get_my_courses` | List enrolled courses |
| `get_my_grades` | Grades for a course or all courses |
| `get_assignments` | Assignments with due dates and submission status |
| `get_upcoming_due_dates` | Due dates across all courses within a window |
| `get_announcements` | Recent course announcements |
| `get_syllabus` | Syllabus document for a course |
| `get_course_content` | Module tree and content topics |
| `get_discussions` | Discussion forums and recent posts |
| `get_roster` | Classlist for a course |
| `get_classlist_emails` | Emails of classmates and instructors |
| `download_file` | Download a file attachment (PDF, slides, etc.) to disk |
| `get_assignment_files` | Read the files attached to an assignment (spec, rubric, starter workbook) and return their text |

These twelve are the whole surface. An available-update notice, when there is one, rides along as a second text block on the first successful result.

Quiz attempt counts are unavailable to students on the Purdue tenant: `/quizzes/{id}/attempts/` answers 403. Those quizzes carry `attemptsAvailable: false` with null counts rather than a fabricated zero.

Assignments, quizzes, and due dates each carry a `url` field that deep-links into Brightspace. `get_assignments` also returns `gradeOnly` items for gradebook columns that match no assignment or quiz, such as a proctored exam. `get_upcoming_due_dates` reads `DueDate` from assignments, `DueDate ?? EndDate` from quizzes, and `DueDate` from discussion topics (`type: "discussion"`) rather than the calendar feed. A topic with no `DueDate` is an ungraded forum and is excluded.

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
