# Install the Brightspace MCP server for someone

You are an AI agent, and a person has asked you to install `brightspace-mcp-server`. It lets their AI app read their Brightspace courses. Follow this page top to bottom. You do steps 1 and 3. Only step 2 needs the person. If a step fails and you cannot fix it yourself, stop and tell them what failed.

Not installing? To change this repository, read [AGENTS.md](AGENTS.md). For what each tool, command and setting does, see [docs/reference/](docs/reference/tools.md).

## Before you start

1. Run `node --version`. If Node is missing or below v22, tell the person to install the LTS from https://nodejs.org/ and stop.
2. Ask the person, in chat, which school they attend and the username they sign in to Brightspace with. Do not ask for their password. They type it themselves in step 2.
3. Find the school's flag:

| School | Flag |
|--------|------|
| Purdue | `--purdue` |
| SUNY | `--suny` |
| Western University | `--western` |
| TU Delft | `--tudelft` |
| CUNY | `--cuny` |
| Leiden University | `--leiden` |
| McGill University | `--mcgill` |
| Memorial University of Newfoundland | `--mun` |
| Javeriana Cali | `--javeriana` |
| Ngee Ann Polytechnic | `--ngeeann` |
| Any other school | `--url <their Brightspace address>`. Ask them for the address |

## Step 1: prepare (you run this, and it asks nothing)

```bash
npx -y brightspace-mcp-server@latest setup <school flag> --prepare --username <their username> --json
```

- For a Purdue student who signs in as `jdoe`, that is `setup --purdue --prepare --username jdoe --json`.
- For SUNY, most campuses want the full sign-in address as the username, such as `abc123@sunypoly.edu`. Add `--campus "<campus>"` only if the person gave you the name the way SUNY's sign-in page lists it, such as `SUNY Poly`. Otherwise leave it out, and step 2 asks them.
- Allow several minutes. A first run can download Chromium (about 200 MB).
- Keep `@latest`. Without it, `npx` can run an old copy that is already installed.

What it does, all without a prompt:

- checks Node, the password store, Chromium (downloading it when missing, unless `--no-browser-install`), and that the school is reachable;
- saves the public settings to `~/.brightspace-mcp/config.json`, with no password. It saves only once the school is reachable, so a mistyped `--url` cannot replace a working setup, and it leaves alone a config that still holds an older version's password;
- registers the server in every AI app it finds: Claude Desktop, Cursor and Antigravity by editing their config files, and Codex and Claude Code through their own CLIs, at user scope.

Running it again changes nothing that is already right.

Stdout is one JSON object. Progress lines go to stderr. Read `state`:

| `state` | Exit | What to do |
|---------|------|------------|
| `ready_for_sign_in` | 0 | Go to step 2 |
| `signed_in` | 0 | A saved sign-in already works. Skip to step 3 |
| `needs_input` | 1 | No school was given. Add the flag or `--url` and run it again |
| `blocked` | 1 | Fix each entry in `steps` whose `ok` is false (its `line` says how), then run it again |

The other fields:

- `steps[]`: `{id, ok, blocking, line}`.
- `apps[]`: one `outcome` per app: `added`, `current`, `shared_http`, `replaced`, `different_left` or `failed`.
- `restart[]`: the apps that must be restarted to load the server.
- `next`: `{command, needsHuman, instructions}`.

Two outcomes to leave as they are:

- `different_left`: the app already has a `brightspace` entry that runs something else. It was left alone. Tell the person, and pass `--replace` only if they want it changed.
- `shared_http` (carries a `url`): the app connects to a shared local server at `http://127.0.0.1:<port>/mcp`. That is a deliberate setup ([docs/shared-server.md](docs/shared-server.md)), so it is reported as set up and kept, auth settings included. Do not pass `--replace` unless the person asks to go back to one copy per chat.

Is their app not one of those five (Windsurf, Copilot, Zed, Continue and so on)? Register the command `npx -y brightspace-mcp-server@latest` in it yourself. On Windows that is `cmd /c npx -y brightspace-mcp-server@latest`. Config formats and paths differ per app and change over time, so check the app's current docs instead of guessing.

## Step 2: sign in (the person runs this)

`next.command` from step 1 is the person's command. Give them that exact string. It looks like this:

```bash
npx -y brightspace-mcp-server@latest setup <school flag> --sign-in
```

It uses what step 1 saved and asks only what needs them:

- their username or SUNY campus, if you did not pass them;
- their password, or whether to keep one already saved;
- how they confirm sign-in:
  - 1: a phone app, either an approval or a code typed in the terminal. Chromium stays hidden. This is the answer for anyone who approves sign-ins in an app such as Microsoft Authenticator or Duo.
  - 2: another way, such as a text message. This saves `headless: false`, and the sign-in page opens for them to finish. Automatic sign-ins later stay hidden either way;
- how often to approve.

Then it signs in and prints `Setup complete!`. If sign-in does not finish, it exits 1 and prints the same command to run again. Running it again is always safe.

It needs a terminal. Without one it exits 2 instead of waiting for typing. So never run it in your own background shell. Hand it over like this:

- **Run it where the person can type.** That means a visible terminal they control: a terminal tab or panel your app shows them, or one they open themselves (Terminal on macOS, PowerShell on Windows).
- **Say exactly where it is and what to do first.** Name the place the way they see it ("the terminal panel on the right, titled *brightspace setup*"), and link it if your app supports that. Tell them to click inside it before typing, because keystrokes go to the chat box until they do. Tell them to press Enter after each answer.
- **Warn them about the password prompt.** Only asterisks appear as they type, and they still press Enter. Then it asks how they confirm sign-in and waits for the approval on their phone.
- **Do not take "done" on faith.** Read the terminal yourself if you can. If you cannot see it, ask them to paste its last few lines. It is finished only when it prints `Setup complete!`. If it is still on a prompt, tell the person which question it is waiting on and where to answer it. Do not just ask again whether they are done. Do not offer a one-click "I'm done" reply: a beginner will click it before they have typed anything.
- **If typing in your panel does not work,** give them the one command to paste into their own terminal app, and say how to open that app.

A person setting up alone can instead run `setup <school flag>` with no mode flag. That interactive wizard asks everything, registers apps before asking "Sign in now?", and also needs a terminal.

## Step 3: verify (you run this)

```bash
npx -y brightspace-mcp-server@latest doctor --json
```

`allOk: true` means the setup, the saved sign-in and one real course-list request all worked. Each failed check's `line` names its fix.

Then tell the person to fully quit and reopen the apps in `restart`, and to ask a question such as "What's due this week?".

The install is done when both are true: `doctor` reports `allOk: true`, and the restarted app answers that question with their real courses (it calls `get_my_courses`).

## After the install

- From here on there is nothing to log in to first. Asking a question signs in when needed, and the answer says so if their phone needs to approve a number. Relay that text, then call the tool again right away.
- If something is wrong later, run `npx -y brightspace-mcp-server@latest doctor` and see [docs/troubleshooting.md](docs/troubleshooting.md).
