# Settings and saved files

Every setting the server reads, and every file it keeps on disk. The handful a student is likely to change are in the README's ["Settings you might want"](../../README.md#settings-you-might-want). Which of these are stable is in [STABILITY.md](../../STABILITY.md).

## How a setting is resolved

- Every setting is optional.
- `setup` writes the usual ones to `~/.brightspace-mcp/config.json`.
- An environment value overrides the saved one: environment, then `config.json`, then the default. This is resolved in `src/utils/config.ts`.
- A `.env` file in the working directory is loaded too. `.env.example` lists every setting with a one-line description.
- Boolean settings accept `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`. Anything else is ignored with a `[config]` warning, and the next source wins.
- Set them in the AI app's MCP `env` block, or in the shell that starts the server.

## Environment variables

`tests/release/env-docs.test.ts` fails when `src/` reads a `D2L_*` variable that these tables do not name.

### Account and sign-in

| Variable | Default | What it does |
|----------|---------|--------------|
| `D2L_BASE_URL` | `https://purdue.brightspace.com` | The school's Brightspace URL. Must be HTTPS with no embedded credentials; only the origin is kept |
| `D2L_USERNAME` | from `config.json` | Sign-in username. Also selects the account's session directory (`accounts/<account-hash>/`) |
| `D2L_PASSWORD` | none | Sign-in password. Copied into the OS credential store for the account on startup, never to a file. Ignored when passwordless sign-in is on |
| `D2L_CAMPUS` | from `config.json` | Campus on a shared multi-campus instance (SUNY). `setup --suny` asks for it |
| `D2L_HEADLESS` | `true` | `false` shows the browser during sign-in, for MFA methods that need a click. Automatic recovery stays headless unless this is set explicitly |
| `D2L_REMEMBER_MFA` | `false` | Tick Microsoft Entra's "Don't ask again" box ([how](../internals/sign-in.md)) |
| `D2L_PASSWORDLESS` | `false` | Microsoft Entra passwordless phone approval; no password is read or saved ([how](../internals/sign-in.md)) |
| `D2L_TOTP_SECRET` | none | Authenticator setup key or `otpauth://` link for Entra code challenges. For CI and containers only; weaker than the keychain entry `setup` saves |
| `D2L_DUO_PASSCODE` | unset | Any non-empty value makes Duo type a Duo Mobile passcode instead of waiting for a push |
| `D2L_ACCESS_TOKEN` | none | Pre-issued Bearer token; skips the browser ([how](../internals/sign-in.md)) |
| `D2L_SESSION_COOKIE` | none | Pasted `d2lSessionVal`/`d2lSecureSessionVal` cookies; skips the browser ([how](../internals/sign-in.md)) |
| `D2L_SESSION_DIR` | `~/.d2l-session` | Root of the per-account session directories. `~` is expanded |
| `D2L_TOKEN_TTL` | `3600` | Seconds an access token is used before it is re-minted. Must be a whole positive number; anything else is ignored with a warning |

### Courses

| Variable | Default | What it does |
|----------|---------|--------------|
| `D2L_INCLUDE_COURSES` | all | Comma-separated course (org unit) ids to keep. Applies to multi-course tools; an explicit `courseId` argument bypasses it |
| `D2L_EXCLUDE_COURSES` | none | Comma-separated course ids to hide |
| `D2L_ACTIVE_ONLY` | `true` | Hide inactive enrollments and courses D2L reports as closed (`CanAccess: false`) |
| `D2L_CURRENT_ONLY` | `false` | Keep only courses whose `Access.StartDate`–`Access.EndDate` window contains now, like Brightspace's "Current Courses" widget. Courses with neither date are dropped |

### Downloads

| Variable | Default | What it does |
|----------|---------|--------------|
| `D2L_DOWNLOAD_ROOTS` | none | Extra folders downloads may use, as a `path.delimiter`-separated list (`:` on macOS and Linux, `;` on Windows). For a server or container that saves outside the home folder (`/data`, `/srv/courses`) |

More on `D2L_DOWNLOAD_ROOTS`:

- Each entry is realpath'd. A destination inside one is allowed even where the built-in refusals would say no, including a hidden or `~/Library` folder inside home.
- It is read from the server's own environment, which a tool argument cannot set.
- A relative entry, a device path, a drive root, the home folder itself, or a folder that holds the home folder is ignored with a `[config]` warning.
- The refusal text names this setting (`src/utils/sensitive-paths.ts`). The refusals themselves are in [docs/internals/downloads.md](../internals/downloads.md).

### Server

| Variable | Default | What it does |
|----------|---------|--------------|
| `D2L_NO_UPDATE_CHECK` | unset | Any non-empty value turns off the npm new-version notice and the auth CLI's self-update re-exec |
| `D2L_DEV_MODE` | unset | Exactly `true` writes a local, content-free activity log ([docs/dev-mode.md](../dev-mode.md)) |
| `D2L_RUNTIME_IDLE_SECONDS` | `600` | Default command only: seconds the shared runtime waits with no request in progress before stopping |
| `D2L_HTTP_TOKEN` | none | `http` only, and required there: the bearer token every request to the shared server must carry. At least 32 characters; never logged ([docs/shared-server.md](../shared-server.md)) |
| `D2L_HTTP_PORT` | `18765` | `http` only: the port on 127.0.0.1. `--port` overrides it |

## Files on disk

| Path | Contents | Permissions |
|------|----------|-------------|
| `~/.brightspace-mcp/config.json` | School URL, username, and public settings | 0600 |
| `~/.d2l-session/accounts/<account-hash>/session.json` | Encrypted access token, session cookies, and XSRF token (AES-256-GCM) | 0600 |
| `~/.d2l-session/accounts/<account-hash>/storage-state.encrypted.json` | Encrypted cookies and browser storage | 0600 |
| `~/.d2l-session/accounts/<account-hash>/microsoft-session.json` | A plain summary of what Microsoft remembered. No cookie values | 0600 |
| `<session dir>/shared-runtime/<hash>/` | The shared runtime's `state.json` (port and random token) and `runtime.log` | 0600 |
| Native operating-system credential store | Password, authenticator key if one was saved, and a random encryption key | OS access controls |

- **`config.json` keys:** `baseUrl`, `username`, `campus`, `sessionDir`, `tokenTtl`, `headless`, `rememberMfa`, `passwordless`, `includeCourses`, `excludeCourses`, `activeOnly`, `currentOnly`. A password or authenticator key is never written there; saving one throws.
- **Account hash:** `<account-hash>` is `sha256([origin, username])`, so saved state is bound to one school and one username. With no username configured, state sits directly under the session directory.
- **Environment password:** an environment password is input for the native store. The server does not rewrite the user's `.env` or AI app configuration.
- **Legacy state:** unnamed state from older versions stays in the session root and is not replayed for a newly configured account. On upgrade, v1 secrets migrate only after verified secure writes. Retired v1 browser data may remain recoverable in the Trash.
- **A broken `config.json` does not stop the server.** If it is corrupt or unreadable (bad permissions, a truncated write, hand-edited garbage), `loadConfig()` logs a `[config] WARN` naming the file and the failure, then continues as if there were no `config.json`, so environment variables still configure the server.

What signing out deletes and keeps is in [docs/internals/sign-in.md](../internals/sign-in.md).
