# Project Rules

## When Adding a New Feature

1. Update `README.md` to document the feature
2. Update the architecture SVG at `docs/how-it-works.svg` if the feature changes how the system works
3. Bump the version in `package.json` before publishing

## Commit Format

`{type}: {description}` (e.g., `feat: add course search tool`)

No Co-Authored-By lines. No phase/plan numbers.

## npm Publishing

- Auto-publishes via GitHub Actions on push to main (when version in package.json changes)
- NPM_TOKEN secret in GitHub repo settings (expires Apr 21, 2026)
- README and description on npm are baked in at publish time, so always publish after README changes
- The MCP client config uses `npx brightspace-mcp-server@latest` so users auto-update
- Always bump the version in package.json BEFORE or IN THE SAME COMMIT as any code or docs change. Never push code changes to main without a version bump. If you forget, the GitHub Action will skip publishing and users will not get the update.

## Architecture

- Config store: `~/.brightspace-mcp/config.json` (falls back to `.env`)
- Session tokens: `~/.d2l-session/session.json` (AES-256-GCM encrypted)
- Auth: Playwright-based browser login with Duo MFA support
- Auto-reauth on token expiry via `AuthRunner`
- CLI subcommands: `setup`, `auth`, default (MCP server)
- School presets: `--purdue` and `--suny` flags (extensible via `SCHOOL_PRESETS` in `src/setup.ts`; per-school login handlers are registered in `src/auth/sso-flow.ts`)
