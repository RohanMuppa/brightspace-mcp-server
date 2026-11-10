# Brightspace MCP Server: rules for agents

This server lets an AI client read a student's Brightspace courses. It signs in through a headless Playwright browser, so sign-in behaviour is what users run into most.

## Docs change with the code

A change to user-visible behaviour updates the docs in the same PR. That covers:

- tool output and guidance text (`src/tools/tool-helpers.ts`, tool descriptions and answers)
- `AuthFailureKind` values, or what a sign-in answer tells the user (`src/auth/auth-runner.ts`)
- CLI subcommands and flags (`src/index.ts`, `src/setup/args.ts`, `src/auth-cli.ts`, `src/sync/sync-cli.ts`, `src/doctor.ts`, `src/repair.ts`, `src/http-server.ts`)
- environment variables (`src/utils/config.ts` and any other `process.env` read)
- school presets (`src/setup/presets.ts`)
- the sign-in flow (`src/auth/`)
- defaults and timeouts (MFA windows, `CALL_BUDGET_MS`, `HELD_RETRY_MS`, cooldowns)

If a change is not user-visible (refactors, internal code, tests), say so in the PR checklist.

## Which doc owns what

| Doc | Owns |
|-----|------|
| `README.md` | install, the school table, the tool list, settings a user might change |
| `docs/sign-in.md` | how sign-in works: MFA, numbers and resends, held prompts, 2FA shortcuts, per-school notes, sign-out, what is stored |
| `docs/troubleshooting.md` | what each sign-in message means, known issues, logs and bug reports, startup and browser problems |
| `docs/dev-mode.md` | `D2L_DEV_MODE`: what the activity log records and leaves out |
| `docs/shared-server.md` | the automatic shared server and the `http` command |
| `LLMs.md` | the agent guide: install steps, auth semantics, tool reference, commands, environment variable table, codebase map |
| `.env.example` | every optional setting, commented out, with a one-line description |
| `STABILITY.md` | what outside code may rely on (tool names, fields, flags, env vars, on-disk paths) |

## Enforced by tests

`tests/docs/doc-coverage.test.ts` runs in `npm run test:run`, so CI fails when:

- an `AuthFailureKind` member is not in `docs/sign-in.md` or `docs/troubleshooting.md`
- a `D2L_*` or `BRIGHTSPACE_*` env var read under `src/` is not in `README.md`, `.env.example` or `docs/`
- a `SCHOOL_PRESETS` key is not written as `--<key>` in both `README.md` and `LLMs.md`
- a registered MCP tool name is not in `README.md`

The test checks names, not wording. Accuracy of the text is still a review job.

## Conventions

- Commits use conventional-commit subjects (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`).
- No AI attribution anywhere: no `Co-Authored-By` trailers, no "Generated with" lines, in commits, PR text, code comments or docs.
- Browser tests are opt-in and gated by `BRIGHTSPACE_TEST_BROWSER=1`. The default suite launches no browser.
- CI installs with `npm ci --ignore-scripts` and has no Chromium. Nothing in the default suite may need one.
- Shipping a change to users means bumping `version` in `package.json` (keep `package-lock.json` and `server.json` in step). Publishing is automatic on that bump; see the Release workflow in `LLMs.md`.
- Before you push: `npm run build` and `npm run test:run` must both pass.
