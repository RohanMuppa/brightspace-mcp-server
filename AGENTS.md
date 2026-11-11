# Brightspace MCP Server: rules for contributors

For people and AI agents changing this repository. `CLAUDE.md` imports this file, so every agent reads the same rules. Installing the server for someone instead? That is [LLMs.md](LLMs.md).

The server lets an AI app read a student's Brightspace courses. It signs in through a headless Playwright browser, so sign-in is what users run into most and what breaks most often.

## Read before you change

Find the area you are changing. Read its doc first, and update that doc in the same PR.

| You are changing | Read first | Also update when a user would notice |
|------------------|------------|--------------------------------------|
| Sign-in: `src/auth/`, `src/auth-cli.ts`, sign-in text in `src/tools/tool-helpers.ts` | [docs/internals/sign-in.md](docs/internals/sign-in.md) | `docs/sign-in.md`, `docs/troubleshooting.md` |
| Downloads and course sync: `src/sync/`, `src/utils/download-helpers.ts`, `src/utils/sensitive-paths.ts` | [docs/internals/downloads.md](docs/internals/downloads.md) | README "Download a whole course" |
| A tool's arguments or output: `src/tools/` | [docs/reference/tools.md](docs/reference/tools.md), [STABILITY.md](STABILITY.md) | README tool list, for a new tool |
| A command or flag: `src/index.ts`, `src/setup/`, `src/doctor.ts`, `src/repair.ts` | [docs/reference/cli.md](docs/reference/cli.md) | [LLMs.md](LLMs.md), for anything the install steps use |
| A setting, a saved file or an environment variable: `src/utils/config.ts` | [docs/reference/settings.md](docs/reference/settings.md) | `.env.example`; README "Settings you might want" |
| A school preset: `src/setup/presets.ts` | [Adding a school](docs/internals/architecture.md#adding-a-school) | the school tables in `README.md` and `LLMs.md` |
| The shared server: `src/runtime-relay.ts`, `src/shared-runtime.ts`, `src/http-server.ts` | [docs/internals/architecture.md](docs/internals/architecture.md) | `docs/shared-server.md` |
| CI, versions, publishing: `.github/workflows/` | [docs/internals/releasing.md](docs/internals/releasing.md) | |

New to the code? Start with [docs/internals/architecture.md](docs/internals/architecture.md).

## Where each fact lives

Every fact has one home. Everywhere else links to it.

| Doc | Reader | Holds |
|-----|--------|-------|
| `README.md` | a student | what it does, install, schools, things to ask, common settings |
| `LLMs.md` | an agent installing it for a student | the install steps, and nothing else |
| `docs/sign-in.md`, `docs/troubleshooting.md`, `docs/shared-server.md`, `docs/dev-mode.md` | a student with a question or a problem | how to use it and how to fix it |
| `docs/reference/` | anyone who needs the exact behaviour | every tool, command and setting |
| `docs/internals/` | someone changing the code | how it works and why it is that way |
| `STABILITY.md` | someone building on the server | what will not break |
| `CHANGELOG.md` | anyone asking "did this change?" | what changed in each version |

## How to keep the docs true

- **One home.** Do not paste a fact into a second file. Link to its home.
- **Write the reason next to the rule.** When the code does something because of a failure someone hit, add a `**Why:**` line with the issue or PR number, and the date for anything seen on a live school. The next person must be able to tell a deliberate rule from an accident.
- **Delete what stopped being true** in the same PR. History goes in `CHANGELOG.md`, not in "previously" notes.
- **A doc that misled you is a bug.** If you wrote something wrong because a doc or an example pointed you there, fix that doc or example in the same PR. Fix the cause, not only your change.
- **`LLMs.md` and this file stay short.** Both are read in full every time, so both have a word limit that CI enforces. Detail goes in `docs/`.

## Changing behaviour

- **Additive only** for everything in [STABILITY.md](STABILITY.md): tool names, response fields, flags, settings, files on disk. Add a field; never rename, remove or repurpose one.
- **"Could not read it" is never "there is none."** A request that failed, or a sign-in still in progress, must not come back as an empty list or a zero. Keep the response shape callers already get and add a field that says what is unknown, plus a notice.
- **A running agent sees only tool descriptions and tool answers.** It never reads these docs. Guidance an agent needs while using the server (relay this number, call again now) belongs in the tool text, mainly `src/tools/tool-helpers.ts`.

## Every PR

- `npm run build` and `npm run test:run` pass.
- Docs updated as above, or the PR says the change is not user-visible.
- A change that ships to users (anything under `src/`, `README.md` or `package.json`) bumps `version` in `package.json`, `package-lock.json` and `server.json`, and adds a line under that version in `CHANGELOG.md`. See [docs/internals/releasing.md](docs/internals/releasing.md).
- Commit subjects are conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`.
- No AI attribution anywhere: no `Co-Authored-By` trailers and no "Generated with" lines in commits, PR text, code comments or docs.
- Browser tests are opt-in behind `BRIGHTSPACE_TEST_BROWSER=1`. CI installs with `npm ci --ignore-scripts` and has no Chromium, so nothing in the default suite may need one.

## What CI checks for you

`tests/docs/` runs in `npm run test:run`. It fails, and names what to fix, when:

- a relative link or `#anchor` in a tracked Markdown file points at nothing;
- a doc names a `src/` or `tests/` path that does not exist;
- `LLMs.md` or `AGENTS.md` grows past its word limit;
- `CHANGELOG.md` has no entry for the version in `package.json`;
- an `AuthFailureKind` is missing from `docs/sign-in.md` and `docs/troubleshooting.md`;
- a `D2L_*` variable the code reads is missing from `docs/reference/settings.md`, or from the docs a user reads;
- a school preset is missing from `README.md` or `LLMs.md`, or a tool is missing from `README.md` or `docs/reference/tools.md`.

These check names and links, not wording. Whether the text is right is still a review job.
