# Commands

Every command the package has, with its flags, output and exit codes. Each is run as `npx -y brightspace-mcp-server@latest <command>`. Which flags are stable is in [STABILITY.md](../../STABILITY.md).

Always include `@latest`. Without it, `npx` prefers a copy already on `PATH` and can silently run an old global install. The canonical command strings shown to users come from `src/utils/commands.ts`.

| Command | What it does |
|---------|--------------|
| [`setup`](#setup) | Install: save settings, register AI apps, sign in |
| [`auth`](#auth) | Sign in again from a terminal, or sign out with `--logout` |
| [`sync`](#sync) | Download a whole course into a folder |
| [`doctor`](#doctor) | Check a setup and say what to fix |
| [`repair`](#repair) | Restore the browser sign-in uses |
| [(no command)](#no-command-the-server) | Run the MCP server. This is what AI apps start |
| [`http`](#http) | Run one shared server yourself, over HTTP |

An unknown command exits with an error that lists the valid ones (`src/index.ts`).

## setup

`src/setup.ts`, flags in `src/setup/args.ts`. Three modes share the one command:

| Mode | Who runs it | What it does |
|------|-------------|--------------|
| `setup` (no mode flag) | a person | The interactive wizard. Asks everything, registers AI apps, then asks "Sign in now?" |
| `setup --prepare` | an AI agent | Everything that needs no person: checks, Chromium download, settings, registering AI apps. No prompts, no password, no sign-in (`src/setup/prepare.ts`) |
| `setup --sign-in` | a person | The last install step: password, how they confirm sign-in, then the sign-in. Uses what `--prepare` saved |

The step-by-step install an agent follows, including the `--prepare --json` result, is in [LLMs.md](../../LLMs.md).

**Why three modes:** an install used to be one long interactive wizard that an agent could not run, and a person who gave up at the MFA step ended with no app registered. Splitting it lets the agent do everything first and leaves the person only the sign-in (issue #258).

| Flag | Meaning |
|------|---------|
| `--<school>` | A school preset such as `--purdue`. The list is the school table in the [README](../../README.md#does-my-school-work), from `SCHOOL_PRESETS` in `src/setup/presets.ts`. `--suny` also asks for a campus; `--tudelft` is NetID with no MFA |
| `--url <address>` | The school's Brightspace address, for a school with no preset. Not allowed together with a school flag |
| `--username <name>` | The sign-in username (prepare, sign-in) |
| `--campus <name>` | SUNY campus (prepare, sign-in) |
| `--json` | Print the prepare result as one JSON object on stdout. Only with `--prepare` |
| `--replace` | Replace a `brightspace` entry in an AI app that runs something else |
| `--no-browser-install` | Do not download Chromium during prepare |
| `--help` | Print every flag |

- Both `--url x` and `--url=x` work.
- An unknown flag is an error (exit 2), not ignored, so a mistyped `--prepare` can never fall through to the wizard.
- `--prepare` and `--sign-in` together is an error.
- The wizard and `--sign-in` need a terminal. Without one they exit 2 instead of waiting for typing.

## auth

`src/auth-cli.ts`.

| Form | What it does |
|------|--------------|
| `auth` | Sign in now, in the terminal. Takes over a stuck background sign-in, and is not subject to the cooldown after a missed prompt |
| `auth --logout` | Delete this computer's saved session so the next call does a full sign-in. Keeps the password, `config.json` and credential-store entries. Local only |

The auth CLI re-runs itself through the pinned `@latest` command when it detects that it is a stale copy (`src/utils/self-update.ts`). `D2L_NO_UPDATE_CHECK` turns that off.

Exit codes for each sign-in failure are in `src/auth/auth-exit-code.ts`. How sign-in and sign-out work is in [docs/internals/sign-in.md](../internals/sign-in.md).

## sync

`src/sync/sync-cli.ts`.

```
sync --course <id> --dest <dir> [--existing skip|replace|keep_both] [--module <id>] [--dry-run] [--json] [--max-files <n>]
```

Downloads a whole course into folders named after its modules, using the saved sign-in. A rerun fetches only what is new.

| Flag | Meaning |
|------|---------|
| `--course <id>` | Course (org unit) id. Required |
| `--dest <dir>` | Folder to save into. Created if it does not exist. Required |
| `--existing <mode>` | `skip` (default), `replace` or `keep_both` |
| `--module <id>` | Only this module and the modules inside it |
| `--dry-run` | List what would be downloaded and download nothing |
| `--json` | Print only the result object on stdout. Progress and the summary go to stderr |
| `--max-files <n>` | Most files to download in one run (default 300) |
| `--help` | Print the flags |

| Exit | Meaning |
|------|---------|
| 0 | Everything was done |
| 1 | Something failed or was not attempted. A sign-in lost partway counts |
| 2 | Usage error. An unknown module, a refused destination, or a sync already running into the same folder all count |
| 130 | Stopped by Ctrl-C or SIGTERM, with no partial file left behind |

The CLI has no time limit; the `download_course_files` tool does. The rules for where files may be saved and what `replace` may overwrite are in [docs/internals/downloads.md](../internals/downloads.md).

## doctor

`src/doctor.ts`. Diagnoses a broken setup. It checks, in order: Node version, Chromium, saved config, credential store, Brightspace reachability, saved sign-in, one real course-list call, and the installed version.

- Each check prints one ✓ or ✗ line with one plain-English next step.
- One more line reports the 2FA shortcuts (remember this device, saved authenticator key). It is informational and never changes the exit code.
- `--json` prints `{checks: [{id, ok, line}], allOk, notes}` instead.

## repair

`src/repair.ts`. Restores and verifies this installation's Chromium: a full browser executable plus a real headless launch. It signs in to nothing and changes no AI app's config. `--json` is for automation. For a global install, run `brightspace-mcp-server repair`.

## No command: the server

`npx -y brightspace-mcp-server@latest` is what an AI app's MCP config runs. On Windows the config is `cmd /c npx -y brightspace-mcp-server@latest`.

- It is a stdio relay (`src/runtime-relay.ts`). The first message starts, or reuses, one detached shared runtime per account, settings and package version.
- The runtime lives under `<session dir>/shared-runtime/<hash>/`, with `state.json` and `runtime.log`.
- Every client sharing those settings shares its sign-in, session and cache. Concurrent starts converge on one runtime.
- It stops after `D2L_RUNTIME_IDLE_SECONDS` (default 600) with no request in progress. The next request starts it again.
- Sign-in progress lines go to `runtime.log`. Each call's MFA challenge still reaches the client that made the call.

## http

`src/http-server.ts`. Opt-in: one shared Streamable HTTP server at `http://127.0.0.1:18765/mcp` for every client on the computer, instead of the automatic shared runtime.

- Needs `D2L_HTTP_TOKEN`. Takes `--port` (or `D2L_HTTP_PORT`).
- The person starts it and keeps it running. Clients connect by URL and never start it. A second copy on a taken port exits with an error.
- Ctrl+C lets calls in progress finish.

Setup steps are in [docs/shared-server.md](../shared-server.md).

## Internal entry points

Two entry points are internal and not for people to run. Both are routed in `src/index.ts`.

- `auth --automatic`: the background sign-in the server starts (`src/auth/auth-runner.ts`).
- `runtime <dir>`: the automatic shared runtime (`src/runtime-relay.ts` starts it, `src/shared-runtime.ts` runs it).

## Development scripts

| Script | What it does |
|--------|--------------|
| `npm run build` | Compile TypeScript to `build/` |
| `npm run dev` | Compile in watch mode |
| `npm run test` | Run Vitest in watch mode |
| `npm run test:run` | Run Vitest once. This is what CI runs |
