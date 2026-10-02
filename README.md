# Brightspace MCP Server

> **By [Rohan Muppa](https://github.com/rohanmuppa), ECE @ Purdue**

Talk to your Brightspace courses with AI. Ask about grades, due dates, quizzes, announcements, and more. Works with Claude Desktop, Claude Code, Cursor, ChatGPT Desktop, Windsurf, and any MCP client.

This is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects your AI to D2L Brightspace so it can pull your grades, assignments, syllabus, and course content on demand.

Connects to D2L Brightspace. Automatic login supports Purdue's Microsoft Entra flow, SUNY campus selection, Western University, TU Delft NetID via SURFconext, and CUNY Login. Other schools need a compatible automated sign-in flow; unsupported login pages return an actionable error.

<p align="center">
  <img src="https://raw.githubusercontent.com/RohanMuppa/brightspace-mcp-server/main/docs/how-it-works.svg" alt="Architecture diagram" width="100%">
</p>

## Try It

> "Download my lecture slides and turn them into interactive flashcards"
> "Grab every assignment rubric and build me a visual dashboard of what I need to hit for an A"

## Install

**You need:** [Node.js 20+](https://nodejs.org/) and a native credential store: macOS Keychain, Windows Credential Manager, or Linux Secret Service (requires `secret-tool` and an unlocked keyring — install `libsecret-tools` on Debian/Ubuntu, or your distribution's `secret-tool` package). A container or SSH session without Secret Service can't persist authentication in v2.

**Option 1: Let your AI do it**

Paste this into Claude Code, Cursor, Windsurf, Copilot, Codex, or any AI coding assistant:

```
Install brightspace-mcp-server for me by following
https://github.com/RohanMuppa/brightspace-mcp-server/blob/main/LLMs.md
(use --purdue at Purdue, --suny at SUNY, --tudelft at TU Delft, or --cuny at CUNY).
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

TU Delft students can use `--tudelft` to select the Brightspace URL and NetID login:

```bash
npx -y brightspace-mcp-server@latest setup --tudelft
```

Use your NetID rather than your student email address. The TU Delft flow is headless NetID username and password sign-in only, including automatic re-authentication when the saved session expires; it does not support MFA or any other interactive step. If your account requires one, [open an issue](https://github.com/RohanMuppa/brightspace-mcp-server/issues) — that tenant isn't supported yet.

CUNY students can add `--cuny`. Sign in with your full CUNY Login address
(`firstname.lastname01@login.cuny.edu`); authentication asks in the terminal
for the 6-digit code from your authenticator app. CUNY asks for that code on
every full sign-in, so when your Brightspace session ends, run
`npx -y brightspace-mcp-server@latest auth` in a terminal again:

```bash
npx -y brightspace-mcp-server@latest setup --cuny
```

The wizard saves your password in the native credential store and asks how you'll complete MFA: wait for approval or number matching, enter a terminal code from Google Authenticator or another app, or use a visible browser for other interactive methods. It can also configure Claude Desktop, Cursor, Codex Desktop and CLI, and Claude Code when installed — restart your AI client when it finishes.

Any other D2L school: run `setup` without a flag and paste your Brightspace URL (for example `https://yourschool.brightspace.com`).

<details>
<summary>Using a different client? Configure it manually.</summary>

Search your client's docs for how to add an MCP server. The server command to register is:

```
npx -y brightspace-mcp-server@latest
```

On **Windows**, npx must be wrapped: `cmd /c npx -y brightspace-mcp-server@latest`

You still need to run `npx -y brightspace-mcp-server@latest setup` first to save your credentials.

For Codex Desktop and Codex CLI, run:

```bash
codex mcp add brightspace -- npx -y brightspace-mcp-server@latest
```

Codex Desktop and CLI use the same user configuration on a computer. Restart the desktop app or start a new CLI session after registration.

For Claude Code, run:

```bash
claude mcp add --scope user brightspace -- npx -y brightspace-mcp-server@latest
```

Claude Desktop uses a separate configuration, which the setup wizard can update automatically.

</details>

**Running from a source checkout or fork?** When a newer release is published, the server tells a source checkout to `git pull` and `npm run build` rather than to install the npm package. For a fork you maintain, set `D2L_NO_UPDATE_CHECK=1` in the server's environment to turn off upstream update notices.

## Session Expired?

There's no login step — asking a question signs you in.

**Normal days:** tokens renew over HTTPS, and a background browser silently replays your saved Microsoft session (silent SSO) if it lapses.

**When MFA is asked:** the number to approve shows up right in the tool's response, and sign-in finishes in the background — approve it, call the tool again, and use the newest number if one goes stale. TOTP apps (Google Authenticator, etc.) get prompted via the terminal; visible-browser mode opens a window instead, though automatic recovery during a tool call still runs headless unless you set `D2L_HEADLESS=false`. On Duo, sign-in auto-answers "Is this your device?" with **yes**, since a headless run has nobody to click it — this also makes Duo remember the device, so skip it on shared machines. Set `D2L_DUO_PASSCODE` to swap the push for a typed passcode. On Microsoft's MFA page, setting `D2L_REMEMBER_MFA=true` makes the server tick "Don't ask again" when your school offers it, so later sign-ins can skip the second factor; how long that lasts is the school's setting, not the server's. It is off by default — leave it off on a shared machine — and `get_server_info` shows whether the box was ticked, offered, or left alone.

**If it gets stuck:** a missed MFA approval pauses automatic sign-in for 5 minutes. This retries immediately, takes over a stuck sign-in, or asks for a code:

```bash
npx -y brightspace-mcp-server@latest auth
```

Run it from your home folder — macOS blocks `npx` from Documents, Desktop, or Downloads without Files and Folders permission (`EPERM`). Grant access in System Settings → Privacy & Security → Files and Folders, or run elsewhere.

## What You Can Ask About

| Topic | Examples |
|-------|---------|
| Grades | "Am I passing all my classes?" · "Compare my grades across all courses" |
| Assignments | "What's due in the next 48 hours?" · "Summarize every assignment I haven't turned in yet" · "Give me the link to submit HW 4" |
| Quizzes | "Which quizzes close this week?" · "Is Quiz 3 timed, and does it have a grace period?" |
| Assignment files | "What does the lab 4 spec actually ask for?" · "Summarize the rubric attached to the project" |
| Exams | "Is there a midterm in the gradebook that isn't on my assignments list?" |
| Announcements | "Did any professor post something important today?" · "What did my CS prof announce this week?" · "Any announcements since last Monday?" · "Read the file attached to today's announcement" · "Save the rubric my prof attached to that announcement" |
| Course content | "Find the midterm review slides" · "Download every PDF from Module 5" · "What's new in this course since I last checked?" |
| Roster | "Who are the TAs for ECE 264?" · "Get me my instructor's email" |
| Discussions | "What are people saying in the final project thread?" · "Summarize the latest discussion posts" |
| Video transcripts | "What did the professor say about pinch-off in Tuesday's lecture recording?" · "Summarize last week's BoilerCast video" — works for Kaltura and YouTube embeds; other platforms report that they aren't supported yet |
| Troubleshooting | "Which version of the Brightspace server am I running?" · "Where is my Brightspace config file?" — `get_server_info` reports the version, Node runtime, platform, config and session paths, school URL, whether a credential is stored, and what Microsoft remembered (`microsoftSession`: stay-signed-in and its expiry, plus whether "Don't ask again" was ticked, already on, not offered, or left off because `D2L_REMEMBER_MFA` isn't set), without contacting Brightspace or revealing secrets |
| Calendar | "When is my midterm?" · "What's on my calendar this week?" · "Is lab cancelled on Thursday?" — reads exams, labs, review sessions, and deadlines instructors put only on the course calendar |
| Planning | "Build me a study schedule based on my upcoming due dates" · "Which class needs the most attention right now?" — pulls from assignments, quizzes, graded discussion topics (any topic with a due date), and course calendar events such as exams and labs |

`get_course_content` reports `isAvailable`, `availabilityStatus` (`available`, `not_yet_open`, `ended`, `hidden`, or `locked`), `availabilityMessage`, `startDate`, and `endDate` for modules and topics. The effective release window includes restrictions inherited from enclosing modules.

When a content-file download returns 403 or 404, `download_file` checks topic metadata and the course table of contents. Confirmed restrictions return `{ success: false, available: false, reason, message, startDate, endDate }` so the assistant can explain when content opens or why it has closed. Unexplained 404s and server/network failures retain their original errors.


Licensed under the MIT License.
