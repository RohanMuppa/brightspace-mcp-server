# Brightspace MCP Server

> **By [Rohan Muppa](https://github.com/rohanmuppa), ECE @ Purdue**

Talk to your Brightspace courses with AI. Ask about grades, due dates, quizzes, announcements, and more. Works with Claude Desktop, Claude Code, Cursor, ChatGPT Desktop, Windsurf, and any MCP client.

This is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects your AI to D2L Brightspace so it can pull your grades, assignments, syllabus, and course content on demand.

Connects to D2L Brightspace. Automatic login supports Purdue's Microsoft Entra flow and SUNY campus selection. Other schools need a compatible automated sign-in flow; unsupported login pages return an actionable error.

<p align="center">
  <img src="https://raw.githubusercontent.com/RohanMuppa/brightspace-mcp-server/main/docs/how-it-works.svg" alt="Architecture diagram" width="100%">
</p>

## Try It

> "Download my lecture slides and turn them into interactive flashcards"
> "Grab every assignment rubric and build me a visual dashboard of what I need to hit for an A"

## Install

**You need:** [Node.js 20+](https://nodejs.org/) and an available native credential store: macOS Keychain, Windows Credential Manager, or Linux Secret Service. Linux requires `secret-tool` and an unlocked desktop keyring. Install `libsecret-tools` on Debian/Ubuntu, or the package providing `secret-tool` on your distribution. A container or SSH session without Secret Service cannot persist authentication in v2.

**Option 1: Let your AI do it**

Paste this into Claude Code, Cursor, Windsurf, Copilot, Codex, or any AI coding assistant:

```
Install brightspace-mcp-server for me by following
https://github.com/RohanMuppa/brightspace-mcp-server/blob/main/LLMs.md
(use --purdue if I'm at Purdue, or --suny if I'm at a SUNY campus).
```

**Option 2: Run it yourself**

```bash
npx -y brightspace-mcp-server@latest setup
```

Purdue students can add `--purdue` to skip entering the school URL:

```bash
npx -y brightspace-mcp-server@latest setup --purdue
```

SUNY campuses share one Brightspace site, so `--suny` also asks which campus
you're at and skips SUNY's campus picker when you sign in:

```bash
npx -y brightspace-mcp-server@latest setup --suny
```

The wizard saves your password in the native credential store and runs login in a headless browser. At Purdue, approve Microsoft Authenticator using the number printed in the terminal. No browser window opens. The wizard can configure Claude Desktop and Cursor. Restart your AI client when it finishes.

Any other D2L school: run `setup` without a flag and paste your Brightspace URL (for example `https://yourschool.brightspace.com`).

<details>
<summary>Using a different client? Configure it manually.</summary>

Search your client's docs for how to add an MCP server. The server command to register is:

```
npx -y brightspace-mcp-server@latest
```

On **Windows**, npx must be wrapped: `cmd /c npx -y brightspace-mcp-server@latest`

You still need to run `npx -y brightspace-mcp-server@latest setup` first to save your credentials.

</details>

## Session Expired?

Returning the next day normally requires no action. The server renews short-lived API tokens over HTTPS using the saved Brightspace session. If that session ends, a headless browser restores your saved Microsoft session and tries silent SSO. If Microsoft requires sign-in, your saved credentials are entered automatically and you complete MFA on your phone.

Your school's policy controls when MFA is required. There is no local 24-hour cutoff, and the server no longer discards browser state after one hour. A network outage preserves the saved session and returns a temporary error.

If you miss an MFA request, automatic browser authentication waits four hours before trying again. Existing tokens and HTTP token renewal still work. Browser-based SSO also pauses because Microsoft can send another phone prompt during a redirect, even without a password submission. Run this command in a terminal to retry immediately and see the MFA number:

```bash
npx -y brightspace-mcp-server@latest auth
```

**MFA at Purdue** is Microsoft Authenticator number matching: enter the terminal-displayed number on your phone. The MCP also sends authentication progress as logging notifications to clients that display them. Some desktop clients hide server logs, so use the terminal command above if the number is not visible. Unsupported identity-provider pages require a supported sign-in handler; the server does not silently open a visible browser.

## Upgrading to 2.0.0

- Restart existing MCP processes after upgrading. v1 and v2 should not authenticate simultaneously against the same session directory.
- Named accounts use separate directories below `~/.d2l-session/accounts/`, keyed by school and username. The first v2 login for a named account may require MFA because v1 browser state does not prove which username it belongs to. Switching accounts never replays another account's cookies.
- On first use, the server moves a v1 config password into the native credential store, verifies it, then removes it from `config.json`. Tokens and browser storage migrate to authenticated encryption using a new random key in that store.
- A locked or unavailable credential store stops migration and preserves existing files. Unlock it and retry. macOS may ask you to allow the Node executable to access Keychain.
- After migration, the old storage snapshot is moved to Trash. After successful browser authentication, the inactive `browser-data` profile is also moved to Trash. Those legacy copies remain recoverable there; existing `.corrupted.*` backups are not automatically removed.
- The server uses a fresh browser context for each authentication attempt. It saves only encrypted browser storage, with no permanent Chromium profile.
- Keep `D2L_SESSION_DIR` on this computer's local filesystem. Sharing it through NFS or a network drive is unsupported; its encryption key belongs to this operating-system account.
- `D2L_HEADLESS` remains recognized for compatibility; v2 authentication always runs headlessly. Environment-supplied passwords remain accepted as input and are saved in native secure storage. Remove old password values from your own `.env` or client configuration after migration.
- If you change your password, run `setup` again. If the encryption key was deleted, restore the native credential entry or use a new session directory and authenticate. Unreadable saved sessions are preserved rather than silently replaced.

## What You Can Ask About

| Topic | Examples |
|-------|---------|
| Grades | "Am I passing all my classes?" · "Compare my grades across all courses" |
| Assignments | "What's due in the next 48 hours?" · "Summarize every assignment I haven't turned in yet" · "Give me the link to submit HW 4" |
| Quizzes | "Which quizzes close this week?" · "Is Quiz 3 timed, and does it have a grace period?" |
| Assignment files | "What does the lab 4 spec actually ask for?" · "Summarize the rubric attached to the project" |
| Exams | "Is there a midterm in the gradebook that isn't on my assignments list?" |
| Announcements | "Did any professor post something important today?" · "What did my CS prof announce this week?" |
| Course content | "Find the midterm review slides" · "Download every PDF from Module 5" |
| Roster | "Who are the TAs for ECE 264?" · "Get me my instructor's email" |
| Discussions | "What are people saying in the final project thread?" · "Summarize the latest discussion posts" |
| Planning | "Build me a study schedule based on my upcoming due dates" · "Which class needs the most attention right now?" |

## Security

- Your school URL and username live in `~/.brightspace-mcp/config.json`. Your password lives in the native credential store. macOS and Windows use `@napi-rs/keyring`; Linux uses `secret-tool` directly to require Secret Service without a temporary kernel-key fallback. Linux secrets travel through stdin, never command-line arguments.
- Each account directory stores `session.json` for access tokens and `storage-state.encrypted.json` for cookies and browser storage. Both use AES-256-GCM with a random key held in the native credential store. The application never writes new plaintext password or browser-state snapshots. `D2L_SESSION_DIR` changes the local root of these account directories.
- On Unix, session files are mode 0600 and their directory is mode 0700. Security also depends on your operating-system account: software running as you may be able to access the same credential store. Runtime memory and recoverable v1 files in Trash are outside the encrypted-file guarantee.
- All traffic to Brightspace is HTTPS.
- On startup the server asks the npm registry whether a newer version exists. When running through `npx`, it clears this package's own stale npx cache directories so the next start downloads the new version. It never installs anything itself. Set `D2L_NO_UPDATE_CHECK=1` to turn the check off.
- Read only: this server never submits, posts, or changes anything in Brightspace.

## Contributing & Forking

Want to add your school, build a new tool, or fix something? Fork the repo, make your changes, and open a pull request. If it gets merged, it ships to every user automatically.

```bash
git clone https://github.com/RohanMuppa/brightspace-mcp-server.git
cd brightspace-mcp-server
npm install
npm run dev       # tsc in watch mode
npm test          # vitest, must be green before you open a PR
```

**Add your school:** Add a preset to `SCHOOL_PRESETS` in `src/setup.ts`. If your school's login flow is different, add a handler in `src/auth/`.

**Add a new tool:** Create a file in `src/tools/`, add the schema in `schemas.ts`, export it in `src/tools/index.ts`, and register it in `src/index.ts`. Use any existing tool as a template.

**Run your own version:** You can also fork and run it independently. Clone it, build it, and point your AI client to the local `build/index.js` instead of using `npx`. No npm needed. Just know that forks don't receive updates from this repo automatically. If your changes could help others, consider opening a PR.

Licensed under the MIT License.

## Updates

Automatic, in both places it matters.

**The MCP server** is registered as `npx -y brightspace-mcp-server@latest`, so your AI client pulls the newest version every time it starts a session.

**The auth CLI** updates itself too. If you installed globally with `npm install -g`, that copy stays at whatever version you installed it at — npm never revisits it. So when the CLI notices it is behind, it re-runs itself through `npx -y brightspace-mcp-server@latest auth` and you get the current code. You are not prompted and there is nothing to confirm.

One caveat worth knowing: a re-exec runs the newest code, it does not overwrite the old copy on disk. `npm ls -g` will still report the version you installed. To actually replace it:

```bash
npm install -g brightspace-mcp-server@latest
npx clear-npx-cache
```

Then restart your AI client. The server and the CLI both check npm on startup, and the server re-checks every few hours, so you get told when either one falls behind — including when they disagree with each other.

Set `D2L_NO_UPDATE_CHECK=1` to switch all of this off.

## What's new in 2.0.0

- Headless saved-credential login and terminal MFA, with silent session reuse across restarts.
- Native secure credential storage and encrypted browser-state migration from v1.
- Removed the one-hour browser-state cutoff and destructive profile recovery.
- Process-level authentication coordination, failed-MFA cooldown, and transport errors that preserve your session.
- Publishing waits for the test matrix on macOS, Windows, and Linux.

Authentication recovery patterns were informed by [Brightspace Bar](https://github.com/DavidChen-006/Brightspace-Bar), distributed under the MIT license.

## What's new in 1.6.1

- Your saved login now survives a network change. The session file was encrypted with a key derived from the machine hostname, which on campus wifi is a DHCP name that changes with the lease. When it changed, the saved session became unreadable and you were sent back through a full MFA login. Upgrading costs one final login, then it stops.

## What's new in 1.6.0

- **Read the files attached to an assignment.** The spec PDF, the starter workbook, the rubric. Ask what an assignment requires and the answer comes from the actual document, not just its one-line description. Handles PDF, Word, Excel, and PowerPoint.
- The roster no longer hides people: a class larger than the limit now reports the true total and says it was truncated, and the limit can be raised.
- Fixed a case where a class list or course list could stop short of the last page.

## What's new in 1.5.0

- Token refresh no longer opens a browser: the access token is re-minted from your session cookie in about 200 ms.
- Silent re-login when your Microsoft session is still alive, and a fast fallback to the credential login when it is not.
- The Microsoft Authenticator number match is printed in the terminal, so headless logins can be approved.
- `get_upcoming_due_dates` reads due dates from assignments and quizzes directly. It no longer reports a quiz as due on the day it opens.
- Every assignment, quiz, and due date carries a `url` that opens the item in Brightspace.
- Gradebook columns with no matching assignment or quiz (a proctored midterm, for example) are surfaced as `gradeOnly` items.
- Unpublished announcements are hidden, and announcements sort by the date they were scheduled to post.
- A dead session is detected even when Brightspace answers with HTTP 200, so re-login triggers instead of a confusing network error.
- SUNY preset (`--suny`) and a more robust Microsoft Entra login, contributed by the community.

---

Proudly made for Boilermakers by [Rohan Muppa](https://github.com/rohanmuppa) 🚂

[Report a bug](https://github.com/rohanmuppa/brightspace-mcp-server/issues) · MIT · Copyright 2026 Rohan Muppa
