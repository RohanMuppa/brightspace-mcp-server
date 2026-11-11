# Stability

What outside integrations and PRs may rely on, and what counts as a breaking change.

The rule across all of it: **additive only**. New tools, new optional parameters and new response fields are fine. Renaming an existing tool, removing or renaming a field a caller already gets back, or changing the shape of existing output is not. The rule for contributors is "Changing behaviour" in [AGENTS.md](AGENTS.md#changing-behaviour). Anything that does change is recorded in [CHANGELOG.md](CHANGELOG.md).

## Tools

Every tool name in [docs/reference/tools.md](docs/reference/tools.md) is stable, as is every field its response carries today (defined in `src/tools/` and `src/tools/schemas.ts`). A field can be added. It is never removed, renamed, or repurposed to mean something else.

## Runtime

Node.js 22 or newer (`engines` in `package.json`). 5.0.0 dropped Node 20, because file-type 22 requires Node 22. CI tests Node 22 and 24 on macOS, Ubuntu and Windows.

## Commands

The full description of each command is in [docs/reference/cli.md](docs/reference/cli.md). These parts are stable:

- **`setup`**
  - Every school flag (from `SCHOOL_PRESETS` in `src/setup/presets.ts`; the list is the README's school table). New presets may be added. An existing flag's school and behaviour will not change.
  - `--prepare`, `--sign-in`, `--url`, `--username`, `--campus`, `--json`, `--replace` and `--no-browser-install`.
  - `--prepare --json` prints `{state, school?, steps, apps, restart, next}`. Its `state` values and those fields follow the additive-only rule.
  - Since 4.0.0, an unknown flag is an error (exit 2) instead of being ignored. The wizard and `--sign-in` exit 2 when stdin is not a terminal, instead of waiting for typing.
- **`auth`**: manual sign-in, with no required flags. `auth --logout` deletes this computer's saved session. `--automatic` is internal and not a user flag.
- **`sync`**: `--course`, `--dest`, `--existing`, `--module`, `--dry-run`, `--json`, `--max-files`, and exit codes 0, 1, 2 and 130.
- **`doctor`**: `--json` prints `{checks: [{id, ok, line}], allOk, notes}`. Check ids may be added (4.0.0 added `browser`).
- **`repair`**: `--json`.
- **`http`**: since 4.1.0, one shared MCP server over Streamable HTTP on `127.0.0.1` (`/mcp`), default port 18765 (`--port` or `D2L_HTTP_PORT`). Requires `D2L_HTTP_TOKEN` (at least 32 characters) as a bearer token on every request.
- **No command**: runs the MCP server over stdio. This stays the default.

## Settings

Every environment variable in [docs/reference/settings.md](docs/reference/settings.md) is stable in name and meaning. All are optional, and an environment value always overrides `config.json`.

## Files on disk

- `~/.brightspace-mcp/config.json` (0600). Keys: `baseUrl`, `username`, `campus`, `sessionDir`, `tokenTtl`, `headless`, `rememberMfa`, `passwordless`, `includeCourses`, `excludeCourses`, `activeOnly`, `currentOnly`. No plaintext password; the password lives in the OS credential store.
- `~/.d2l-session/accounts/<account-hash>/session.json` and `storage-state.encrypted.json` (AES-256-GCM, 0600). `<account-hash>` is `sha256([origin, username])`. Used only when a username is configured; otherwise state sits directly under `~/.d2l-session/`.
- `.brightspace-sync.json` in a synced course folder: the manifest a sync keeps, keyed by course id and topic id.

These paths, and the key and field names in them, are load-bearing for anything that reads this server's state directly. Adding a key is fine. Removing or repurposing one is a breaking change.
