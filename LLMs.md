# LLMs.md

Guide for AI agents (Claude, Cursor, Windsurf, Copilot, Codex, etc.) helping a user install, use, or contribute to `brightspace-mcp-server`.

## Read the README first

Before anything else, read [README.md](https://github.com/RohanMuppa/brightspace-mcp-server/blob/main/README.md) for general context on what this project is, who it's for, and what a user can do with it. This file (LLMs.md) picks up from there with the concrete steps and codebase map you'll need to actually get things done.

## What this project is

An MCP (Model Context Protocol) server that connects an AI client to D2L Brightspace so it can read grades, assignments, announcements, syllabus, roster, discussions, and course content on demand.

Distributed on npm as `brightspace-mcp-server`. Users run it via `npx`, so they always get the latest version.

## Installing it for a user

Follow these steps in order. Stop and report back if any step fails.

### 1. Verify Node.js 18+

```bash
node --version
```

If Node is missing or below v18, tell the user to install the LTS from https://nodejs.org/ and stop.

### 2. Run the setup wizard

```bash
npx brightspace-mcp-server setup
```

If the user is at Purdue, use the preset:

```bash
npx brightspace-mcp-server setup --purdue
```

If the user is at a SUNY campus, use the SUNY preset. It also asks which campus
they attend, which lets sign-in skip SUNY's shared campus picker:

```bash
npx brightspace-mcp-server setup --suny
```

The wizard:
- prompts for the school's Brightspace URL (skipped with `--purdue` or `--suny`)
- launches a Playwright Chromium browser for login and MFA (Duo push, etc.)
- saves credentials to `~/.brightspace-mcp/config.json` (0600)
- writes the encrypted session to `~/.d2l-session/session.json` (AES-256-GCM)
- auto-configures Claude Desktop and Cursor if detected

Wait for the user to finish login and MFA before continuing.

### 3. Register the MCP server in the user's AI client

The server command to register is:

```
npx -y brightspace-mcp-server@latest
```

On **Windows**, wrap with cmd: `cmd /c npx -y brightspace-mcp-server@latest`.

Claude Desktop and Cursor are auto-configured by the setup wizard. For any other client (Windsurf, Copilot, Codex, Zed, Continue, etc.), look up the client's current MCP config format and file path, then add an entry with the command above. Config formats and paths differ per client and change over time, so verify against current client docs rather than guessing.

### 4. Restart the AI client

Tell the user to fully quit and reopen their AI client so it picks up the new MCP server.

## Re-auth

Sessions auto-reauthenticate on expiry. If auto-reauth fails (missed Duo push, expired cookies, stale locks), run:

```bash
npx brightspace-mcp-server auth
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
| `download_file` | Download a file attachment (PDF, slides, etc.) |

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
    client.ts               HTTP client wrapping the Valence/D2L API
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
    session-store.ts        AES-256-GCM session persistence
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
| `npx brightspace-mcp-server setup` | Interactive setup wizard |
| `npx brightspace-mcp-server setup --purdue` | Setup with Purdue preset |
| `npx brightspace-mcp-server setup --suny` | Setup with SUNY preset (also asks for campus) |
| `npx brightspace-mcp-server auth` | Manual reauth |
| `npx -y brightspace-mcp-server@latest` | Run the MCP server (registered in AI client config) |
| `npm run build` | Compile TypeScript to `build/` |
| `npm run dev` | Watch-mode TypeScript compile |
| `npm run test` | Run Vitest suite |
| `npm run test:run` | Run Vitest once |

## Storage locations

| Path | Contents | Permissions |
|------|----------|-------------|
| `~/.brightspace-mcp/config.json` | School URL, user identity | 0600 |
| `~/.d2l-session/session.json` | Encrypted session cookies | 0600 |

`.env` fallback is supported for CI and dev, but the config store takes precedence.

## Adding a school

Add a preset to `SCHOOL_PRESETS` in `src/setup.ts`. If the school uses a non-standard login flow (SAML, Shibboleth, custom SSO), add a handler in `src/auth/` alongside `purdue-sso.ts` and register it in `createSSOFlow()` in `src/auth/sso-flow.ts`.

## Adding a tool

1. Create `src/tools/<name>.ts` using an existing tool as a template.
2. Add the input schema to `src/tools/schemas.ts`.
3. Export it from `src/tools/index.ts`.
4. Register it in `src/index.ts`.

## Release workflow

Publishing is automated by GitHub Actions on push to `main` when `version` in `package.json` changes.

Always bump `version` in `package.json` in the same commit as any code or docs change. The Action skips publish if the version is unchanged, which means users will not receive the update via `npx ...@latest`.
