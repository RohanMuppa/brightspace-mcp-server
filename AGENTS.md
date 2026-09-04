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
- Publishing authenticates with a granular npm access token that has 2FA bypass enabled, stored as the NPM_TOKEN repo secret. npm is restricting such tokens, so the durable fix is Trusted Publishing (OIDC), which needs a one-time registration on the npmjs.com package settings page and then no secret at all.
- Release checklist: bump the version in package.json AND server.json in the same commit (tests/release/server-json.test.ts enforces it), run `npm test`, push main, confirm the Publish workflow is green, then confirm `npm view brightspace-mcp-server version` shows the new version.
- README and description on npm are baked in at publish time, so always publish after README changes
- The MCP client config uses `npx brightspace-mcp-server@latest` so users auto-update
- Always bump the version in package.json BEFORE or IN THE SAME COMMIT as any code or docs change. Never push code changes to main without a version bump. If you forget, the GitHub Action will skip publishing and users will not get the update.

## Architecture

- Config store: `~/.brightspace-mcp/config.json` (falls back to `.env`)
- Session tokens: `~/.d2l-session/session.json` (AES-256-GCM encrypted)
- Auth: Playwright-based browser login. Purdue uses Microsoft Entra with number-match MFA (the number is scraped and logged); other schools may use Duo or their own MFA app
- Token refresh: `src/auth/token-mint.ts` re-mints the JWT from the stored session cookie plus XSRF token over HTTP, so the browser is only launched when the D2L session itself has expired
- Auto-reauth on token expiry via `AuthRunner`
- CLI subcommands: `setup`, `auth`, default (MCP server)
- School presets: `--purdue` and `--suny` flags (extensible via `SCHOOL_PRESETS` in `src/setup.ts`; per-school login handlers are registered in `src/auth/sso-flow.ts`)
