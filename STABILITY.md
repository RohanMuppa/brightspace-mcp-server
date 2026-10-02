# Stability

What outside integrations and PRs may rely on, and what counts as a breaking change.
The rule across all of it: **additive only**. New tools, new optional parameters, and
new response fields are fine. Renaming an existing tool, removing or renaming a field
a caller already gets back, or changing the shape of existing output is not — see
`CLAUDE.md`'s "Changing behavior".

## Tools

Every tool name listed in `LLMs.md` ("Available tools") is stable, as is every field its
response carries today (defined in `src/tools/*.ts` and `src/tools/schemas.ts`). A field
can be added; it is never removed, renamed, or repurposed to mean something else.

## CLI subcommands

- `setup` — interactive wizard. School-preset flags come from `SCHOOL_PRESETS` in
  `src/setup.ts`: `--purdue`, `--suny`, `--western`, `--cuny`, `--tudelft` today. New
  presets may be added; an existing flag's school and behavior won't change.
- `auth` — manual re-authentication, no required flags. `--automatic` is internal
  (used by `AuthRunner` to retry in the background) and not a documented user flag.
- No subcommand — runs the MCP server itself.

## Environment variables

All are optional; env always overrides `config.json`.

| Variable | Meaning |
|---|---|
| `D2L_USERNAME` | Brightspace login username |
| `D2L_PASSWORD` | Brightspace password (fed into the native credential store, not stored in plaintext) |
| `D2L_BASE_URL` | School's Brightspace origin (must be `https://`, no embedded credentials) |
| `D2L_SESSION_DIR` | Root directory for session state (default `~/.d2l-session`) |
| `D2L_TOKEN_TTL` | Access token lifetime in seconds (default `3600`) |
| `D2L_HEADLESS` | Run browser auth without a visible window (default `true`) |
| `D2L_REMEMBER_MFA` | Tick Microsoft Entra's "Don't ask again" box during MFA (default off; opt-in) |
| `D2L_CAMPUS` | Campus selector for a shared multi-campus tenant (e.g. SUNY) |
| `D2L_DUO_PASSCODE` | Use a typed Duo Mobile passcode instead of waiting for a push |
| `D2L_INCLUDE_COURSES` | Comma-separated course ID whitelist |
| `D2L_EXCLUDE_COURSES` | Comma-separated course ID blacklist |
| `D2L_ACTIVE_ONLY` | Only show active (non-archived) courses (default `true`) |
| `D2L_NO_UPDATE_CHECK` | Set to any value to switch off the background npm update check and its update notices |

## On-disk layout

- `~/.brightspace-mcp/config.json` (0600) — keys: `baseUrl`, `username`, `campus`,
  `sessionDir`, `tokenTtl`, `headless`, `includeCourses`, `excludeCourses`, `activeOnly`.
  No plaintext password; the password lives in the OS credential store.
- `~/.d2l-session/accounts/<account-hash>/session.json` and
  `storage-state.encrypted.json` (AES-256-GCM, 0600) — `<account-hash>` is
  `sha256([origin, username])`. Used only when a username is configured; otherwise
  state sits directly under `~/.d2l-session/`.

Both paths, and the key/field names in them, are load-bearing for anything that reads
this server's state directly. Adding a key is fine; removing or repurposing one is a
breaking change.
