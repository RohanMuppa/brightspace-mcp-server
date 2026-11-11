# Architecture

How the server is put together, for someone about to change it. The rules for contributing are in [AGENTS.md](../../AGENTS.md).

## What it is

An MCP (Model Context Protocol) server that connects an AI app to D2L Brightspace, so the app can read grades, assignments, announcements, the syllabus, the roster, discussions and course content on demand. It only reads; the two exceptions are the tools that save files to the student's disk.

It is published on npm as `brightspace-mcp-server` and started by AI apps as `npx -y brightspace-mcp-server@latest`, so each app start picks up the newest version.

## How a request travels

```
AI app ──stdio──▶ relay (src/runtime-relay.ts)
                    │  one per app window; starts the runtime if none answers
                    ▼
                  shared runtime (src/shared-runtime.ts, src/server.ts)
                    │  one per account + settings + version: one sign-in, one session, one cache
                    ▼
                  tool (src/tools/<name>.ts)
                    ▼
                  API client (src/api/client.ts) ──HTTPS──▶ Brightspace
                    │  on 401 or an expired token
                    ▼
                  AuthRunner (src/auth/auth-runner.ts)
                    │  starts a child process: auth-cli --automatic
                    ▼
                  headless Chromium signs in (src/auth/browser-auth.ts and the school's flow)
```

- **The relay and the runtime are separate processes.** Every chat window starts its own relay, and they all share one runtime, so closing one chat never interrupts another. Details for users: [docs/shared-server.md](../shared-server.md).
- **Nothing signs in at startup.** `lp()` and `le()` in the API client return a path with a `{lp}` or `{le}` placeholder. `get()` and `getRaw()` fill it in on the first request, which is when API versions are discovered and sign-in happens.
- **Sign-in runs in a child process** so a tool call can return within a client's timeout while the sign-in carries on, and so several server processes can share one sign-in. How that works, and every rule it obeys, is in [sign-in.md](sign-in.md).
- **Tokens are re-minted without a browser** from the saved session cookie (`src/auth/token-manager.ts`, `src/auth/token-mint.ts`). A browser is needed only when that session has ended.

## Where things are

Named here are the files you are most likely to need. Every folder is listed; not every file is.

### `src/` top level

| File | What it is |
|------|------------|
| `src/index.ts` | Entry point: routes subcommands, then runs the stdio relay (default), `runtime` or `http` |
| `src/runtime-relay.ts` | Default stdio command: relays each message to the shared runtime, starting one (detached `runtime <dir>`) when none answers |
| `src/shared-runtime.ts` | `runtime`: the one shared runtime per settings and version (owner lock, 0600 state file with port and random token, idle stop) |
| `src/server.ts` | The shared runtime's session, sign-in and API client, and the McpServer factory that registers every tool and prompt |
| `src/http-server.ts` | `http`: stateless Streamable HTTP on 127.0.0.1 with Host/Origin, bearer token and body checks |
| `src/setup.ts` | `setup`: the interactive wizard and `--sign-in`; routes `--prepare` |
| `src/auth-cli.ts` | `auth`: manual sign-in; `auth --logout` ends the saved session; `--automatic` is the background child |
| `src/doctor.ts` | `doctor`: the beginner diagnostic |
| `src/repair.ts` | `repair`: restore and verify Chromium |
| `src/update.ts` | Self-update checker |

### `src/setup/`: install

| File | What it is |
|------|------------|
| `src/setup/args.ts` | `setup`'s flags and modes (wizard, `--prepare`, `--sign-in`) |
| `src/setup/presets.ts` | School presets (`--purdue`, ...) and lookup by URL |
| `src/setup/config.ts` | Saved-settings merge shared by every mode |
| `src/setup/clients.ts` | The AI apps setup registers in (one list for wizard and prepare) |
| `src/setup/prepare.ts` | `setup --prepare`: no-prompt install steps for agents, with a JSON result |

### `src/auth/`: sign-in and saved sessions

Read [sign-in.md](sign-in.md) before changing anything here.

| File | What it is |
|------|------------|
| `src/auth/auth-runner.ts` | Runs a sign-in on a 401 or expiry by starting the child process. `cancel()` and `stopAutomaticSignIn()` stop a waiting sign-in (used by `sign_out`); `requestVisibleBrowser()` makes the next child open a window (used by `sign_in`) |
| `src/auth/browser-auth.ts` | The Playwright-driven login |
| `src/auth/sso-flow.ts` | Picks the login flow for the configured host (`createSSOFlow()`) |
| `src/auth/purdue-sso.ts` | The default flow: Shibboleth, CAS and Microsoft Entra forms, including the MFA wait loop |
| `src/auth/duo-mfa.ts` | Duo prompts |
| `src/auth/totp.ts` | Authenticator codes generated locally (RFC 6238) |
| `src/auth/suny-sso.ts`, `cuny-sso.ts`, `mcgill-sso.ts`, `mun-sso.ts`, `javeriana-sso.ts`, `leiden-sso.ts`, `tudelft-sso.ts`, `western-sso.ts` | One file per school whose sign-in differs from the default |
| `src/auth/mfa-challenge.ts` | The pending MFA challenge, shared with other processes through the lock directory; the MFA time limits |
| `src/auth/auth-lock.ts` | Sign-in and write locks shared between processes |
| `src/auth/auth-cooldown.ts` | The pause on automatic sign-in after a missed MFA prompt |
| `src/auth/auth-exit-code.ts` | The exit code `auth-cli` ends with for each failure (AuthRunner maps it back to a failure kind) |
| `src/auth/auth-phases.ts` | The sign-in stages the child reports durations for |
| `src/auth/error-cause.ts` | One sanitized `caused by:` line per error cause for the auth log |
| `src/auth/token-manager.ts` | Token refresh and validation; `forgetSession()` drops the in-memory token without touching files (used by `sign_out`) |
| `src/auth/token-mint.ts`, `src/auth/xsrf-fetch.ts` | Minting an access token from the session cookie over plain HTTP |
| `src/auth/session-store.ts` | AES-256-GCM token persistence and v1 migration |
| `src/auth/browser-state-store.ts`, `src/auth/encrypted-store.ts` | Encrypted cookie and browser storage persistence |
| `src/auth/microsoft-session.ts` | The plain summary of what Microsoft remembered (`microsoft-session.json`) |
| `src/auth/credential-store.ts` | Native password and encryption-key storage |
| `src/auth/logout.ts` | `auth --logout`: stops another app's waiting background sign-in, then deletes the saved session files under the sign-in lock (shared with the `sign_out` tool) |
| `src/auth/legacy-state.ts`, `src/auth/legacy-profile.ts` | Migration from older on-disk layouts |

### `src/api/`: talking to Brightspace

| File | What it is |
|------|------------|
| `src/api/client.ts` | HTTP client wrapping the Valence/D2L API, with lazy version discovery and sign-in |
| `src/api/version-discovery.ts` | Resolves per-product API versions |
| `src/api/paginate.ts` | Bookmark pagination, bounded by a page ceiling |
| `src/api/retry.ts` | Retry with backoff, jitter and Retry-After |
| `src/api/cache.ts` | In-memory response cache |
| `src/api/rate-limiter.ts` | Token-bucket limiter |
| `src/api/errors.ts` | API error taxonomy |
| `src/api/types.ts` | D2L response types |

### `src/tools/` and `src/prompts/`: what the AI app can call

What each tool takes and returns is in [docs/reference/tools.md](../reference/tools.md).

| File | What it is |
|------|------------|
| `src/tools/index.ts` | Tool registry |
| `src/tools/schemas.ts` | Zod input schemas for every tool |
| `src/tools/get-*.ts`, `src/tools/search-course.ts`, `src/tools/sign-in.ts`, `src/tools/sign-out.ts` | One file per tool |
| `src/tools/tool-helpers.ts` | Shared helpers, and the text a tool answers with when sign-in is pending or failed |
| `src/tools/mfa-relay.ts` | Sends an MFA challenge to the client as a progress notification while the call is still running |
| `src/tools/resolve-courses.ts` | Which courses a call covers, and their names |
| `src/tools/download-file.ts` | Binary download and file-type detection; `openContentTopic` is the topic download the course sync reuses |
| `src/tools/download-course-files.ts` | The `download_course_files` tool, a thin wrapper over `src/sync/course-sync.ts` |
| `src/tools/attachment-reader.ts` | Reads an attached file as text, for assignments and announcements |
| `src/tools/content-availability.ts` | Shared release-window logic (hidden, locked, not yet open, ended) |
| `src/tools/topic-availability.ts` | Explains a `download_file` failure using topic and table-of-contents availability data |
| `src/tools/omitted-arguments.ts` | Lets a client leave `arguments` off a call |
| `src/prompts/index.ts` | Prompt registry; one file per prompt beside it |

### `src/sync/`: whole-course download

Read [downloads.md](downloads.md) before changing anything here.

| File | What it is |
|------|------------|
| `src/sync/course-sync.ts` | The whole-course download shared by `download_course_files` and `sync`: reads `/content/toc` once, plans folders and files, retries, stops on a lost session |
| `src/sync/manifest.ts` | `.brightspace-sync.json`: what a sync wrote, by course and topic; the only files `replace` may overwrite |
| `src/sync/lock.ts` | `.brightspace-sync.lock`: one sync at a time per destination |
| `src/sync/names.ts` | Cross-platform name sanitising and duplicate numbering |
| `src/sync/cleanup.ts` | Removes `.download-<uuid>.part` files a killed run left behind |
| `src/sync/summary.ts` | The compact plain-text summary of a sync result |
| `src/sync/sync-cli.ts` | `sync` argument parsing, output, exit codes and `--notify` |
| `src/sync/schedule-cli.ts` | `schedule` (macOS): a per-user launchd agent that runs `sync --notify` daily; `--list`, `--remove`. launchctl and the filesystem are injected for tests |
| `src/sync/errors.ts` | `SyncInputError`: a bad argument, as opposed to a failed request |

### `src/utils/`: shared pieces

| File | What it is |
|------|------------|
| `src/utils/config.ts` | Resolved config: saved settings plus environment |
| `src/utils/config-store.ts`, `src/utils/secure-config.ts` | `~/.brightspace-mcp/config.json` reader and writer; saving secrets to the credential store |
| `src/utils/commands.ts` | The canonical command strings shown to users, all pinned to `@latest` |
| `src/utils/sensitive-paths.ts` | Where a download may be saved: the list of refused destinations, enforced by the shared download helpers |
| `src/utils/download-helpers.ts`, `src/utils/download-errors.ts` | Stream-to-disk with validation, and the typed download failures |
| `src/utils/file-validator.ts` | Magic-byte file-type checks |
| `src/utils/course-filter.ts` | Enrolled versus archived courses, and current versus out-of-term |
| `src/utils/course-files.ts` | Course-file path rules shared by `download_file` (`coursePath`) and `get_course_content` (`courseFiles`) |
| `src/utils/deep-links.ts`, `src/utils/session-params.ts` | Links into the Brightspace web UI, with per-session parameters stripped |
| `src/utils/html-converter.ts`, `src/utils/html-attributes.ts` | HTML to Markdown, and quote-aware attribute reading for raw D2L HTML |
| `src/utils/pdf-extractor.ts`, `src/utils/zip-extract.ts` | Text out of PDFs and Office files |
| `src/utils/transcript/` | Video transcripts: platform detection, Kaltura, YouTube, LTI launch pages, captions |
| `src/utils/two-factor-shortcuts.ts` | The one "how often do you approve sign-ins" setup question, plus the wording shared by setup, the MFA tip and doctor |
| `src/utils/browser-install.ts` | Chromium check, install through the bundled Playwright, and the missing-browser hint |
| `src/utils/saved-session.ts` | Read-only saved sign-in checks shared by doctor and prepare |
| `src/utils/mcp-client-cli.ts` | Registering the server through the Codex and Claude Code CLIs |
| `src/utils/install-sites.ts`, `src/utils/update-checker.ts`, `src/utils/self-update.ts` | Finding stale copies of the package, the new-version notice, and the auth CLI re-running itself on the newest version |
| `src/utils/dev-activity.ts` | The optional content-free activity log ([docs/dev-mode.md](../dev-mode.md)) |
| `src/utils/notify.ts` | macOS notifications through `/usr/bin/osascript`. Text is passed as arguments, never inside the script; it never throws. `notifyApprovalNumber()` fires once per distinct number. `D2L_NOTIFY=0` turns it off |
| `src/utils/logger.ts` | Logging to stderr, with secrets redacted |
| `src/utils/errors.ts`, `src/utils/error-kind.ts` | User-facing error text, and the closed set of failure categories |
| `src/utils/atomic-write.ts`, `src/utils/process-guard.ts`, `src/utils/startup-phase.ts` | Half-written-file protection, crash protection for the server process, timed startup steps |

`src/types/` holds shared TypeScript types.

## Adding a tool

1. Create `src/tools/<name>.ts`, using an existing tool as a template.
2. Add the input schema to `src/tools/schemas.ts`.
3. Export it from `src/tools/index.ts`.
4. Register it in `src/server.ts`, next to the other `register*` calls.
5. Add it to [docs/reference/tools.md](../reference/tools.md) and to the README's tool list. `tests/docs/doc-coverage.test.ts` fails until both name it.
6. If it only reads, give its config `annotations: { readOnlyHint: true }`.

Rules a new tool must follow:

- **Build paths with `apiClient.lp()`, `le()` or `leGlobal()` and nothing else.** They return a template carrying a `{lp}` or `{le}` placeholder, which `get()` and `getRaw()` substitute after discovering the versions, so a new tool gets lazy discovery and sign-in without asking for them. **Why:** a hand-written path with a literal version skips discovery and breaks when the school moves to a new version.
- **Mark a read-only tool `readOnlyHint: true`.** **Why:** Claude Code runs unmarked tools one at a time, which holds a whole batch behind a sign-in.
- **Leave `readOnlyHint` off a tool that can write a file** (one with a `downloadPath` argument). **Why:** clients also use the hint to skip permission prompts.
- **Report a failed or pending read as unknown, never as empty.** See "Changing behaviour" in [AGENTS.md](../../AGENTS.md#changing-behaviour).

## Adding a school

1. Add a preset to `SCHOOL_PRESETS` in `src/setup/presets.ts` (`src/setup.ts` re-exports it).
2. Add its `--<flag>` to the school tables in `README.md` and `LLMs.md`. `tests/docs/doc-coverage.test.ts` fails until both name it.
3. Add any quirks to "Per-school notes" in [docs/sign-in.md](../sign-in.md#per-school-notes).
4. If the school's login is not handled by the default flow (SAML, Shibboleth, custom SSO), add a handler in `src/auth/` beside `src/auth/purdue-sso.ts` and register it in `createSSOFlow()` in `src/auth/sso-flow.ts`.
