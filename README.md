# Brightspace MCP Server

[![npm version](https://img.shields.io/npm/v/brightspace-mcp-server.svg)](https://www.npmjs.com/package/brightspace-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/brightspace-mcp-server.svg)](https://www.npmjs.com/package/brightspace-mcp-server)
[![CI](https://img.shields.io/github/actions/workflow/status/RohanMuppa/brightspace-mcp-server/ci.yml?branch=main)](https://github.com/RohanMuppa/brightspace-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/RohanMuppa/brightspace-mcp-server.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/node/v/brightspace-mcp-server.svg)](package.json)

**Official repo:** github.com/RohanMuppa/brightspace-mcp-server · [npm](https://www.npmjs.com/package/brightspace-mcp-server) — forks of this README are not maintained.

> **By [Rohan Muppa](https://github.com/rohanmuppa), ECE @ Purdue**

Lets your AI see your Brightspace classes, so you can just ask:

> "What's due this week?" · "Am I passing all my classes?" · "Summarize today's announcements" · "Turn my lecture slides into flashcards"

Works with Claude Desktop, Claude Code, Cursor, ChatGPT Desktop, Windsurf, and any other app that supports [MCP](https://modelcontextprotocol.io) (the standard way to plug tools into an AI). It only **reads** your courses — it never submits, edits, or deletes anything.

<p align="center">
  <img src="https://raw.githubusercontent.com/RohanMuppa/brightspace-mcp-server/main/docs/how-it-works.svg" alt="Architecture diagram" width="100%">
</p>

## Get started in 3 steps

1. **Install [Node.js](https://nodejs.org/)** (version 20 or newer) if you don't have it. Download, run the installer, done.
2. **Open a terminal and run the setup:**
   ```bash
   npx -y brightspace-mcp-server@latest setup
   ```
   It asks for your school's Brightspace address, your username and password, and how you normally do two-factor sign-in (phone approval, authenticator code, or a browser window). Your password goes into your computer's own password store (Keychain on Mac, Credential Manager on Windows), never into a file. At the end it connects itself to Claude Desktop, Cursor, Codex, or Claude Code if you have them.
3. **Restart your AI app and ask it something** — the first question signs you in. If your phone asks you to approve a sign-in, approve it and ask again.

At one of these schools, add the flag and skip typing the address: `--purdue`, `--suny`, `--western`, `--tudelft`, `--cuny`, `--leiden`.

**Rather have the AI install it for you?** Paste this into Claude Code, Cursor, Windsurf, Copilot, or Codex:

```
Install brightspace-mcp-server for me by following
https://github.com/RohanMuppa/brightspace-mcp-server/blob/main/LLMs.md
(use --purdue at Purdue, --suny at SUNY, --tudelft at TU Delft, --cuny at CUNY, or --leiden at Leiden).
```

Using a different AI app? Add the command `npx -y brightspace-mcp-server@latest` to its MCP settings (on Windows: `cmd /c npx -y brightspace-mcp-server@latest`). Exact steps for each app: [docs/troubleshooting.md](docs/troubleshooting.md).

## Does my school work?

If your school uses D2L Brightspace, yes. These have automatic sign-in built in:

| School | Sign-in | Flag |
|--------|---------|------|
| Purdue | Microsoft (phone approval, authenticator code, or browser) | `--purdue` |
| SUNY | Shared site with a campus picker | `--suny` |
| Western University | Microsoft | `--western` |
| TU Delft | NetID (no two-factor) | `--tudelft` |
| CUNY | CUNY Login, authenticator code each time | `--cuny` |
| Leiden University | SURFconext → Microsoft | `--leiden` |
| Any other D2L school | Paste your Brightspace address; if the login page isn't recognized, a browser window opens so you can sign in by hand | none |

School-specific quirks: [docs/sign-in.md](docs/sign-in.md#per-school-notes).

## Things to ask

| About | Try |
|-------|-----|
| Grades | "Am I passing all my classes?" · "Compare my grades across courses" |
| Due dates | "What's due in the next 48 hours?" · "Build me a study schedule for the week" |
| Assignments and rubrics | "What does the lab 4 spec actually ask for?" · "Why did I lose points on the analysis criterion?" |
| Quizzes and exams | "Which quizzes close this week?" · "Is there a midterm in the gradebook that isn't on my assignments list?" |
| Announcements | "Did any professor post something important today?" · "Read the file attached to today's announcement" |
| Course content | "Find the midterm review slides" · "Download every PDF from Module 5" · "Search this course for office hours" |
| People | "Who are the TAs for ECE 264?" · "Who is in my project group?" |
| Discussions | "Summarize the latest posts in the final project thread" |
| Lecture videos | "What did the professor say about pinch-off in Tuesday's recording?" (Kaltura and YouTube) |
| Calendar | "When is my midterm?" · "Is lab cancelled on Thursday?" |

Apps with a prompt picker (like Claude Desktop) also offer four ready-made prompts: `weekly_briefing`, `grade_audit`, `study_planner`, and `course_summary`.

## What it can do

Nineteen read-only tools behind those questions. The ones worth knowing about:

- **Grades** — every course's gradebook with instructor comments, and the hidden "exam" items that only appear in the gradebook.
- **Assignments** — due dates with a plain-words `dueIn` ("in 3 days"), your submissions and the feedback on them, rubric names, and quizzes with attempt counts. While sign-in is still pending it says so instead of returning an empty list.
- **Rubrics** — the full criteria, levels, and points for an assignment, plus your own graded outcome per criterion when your school exposes it.
- **Due dates and calendar** — upcoming deadlines from assignments, quizzes, graded discussions, and the course calendar (exams, labs, review sessions).
- **Announcements** — with attachments you can read or save.
- **Course content** — modules and topics as markdown, file download (PDF, Office, and more), and release windows: it tells you when something opens, has ended, or is hidden instead of a bare error.
- **Search** — content, announcements, and discussions by keyword in one call.
- **Lecture videos** — transcripts for Kaltura and YouTube embeds.
- **People** — roster, instructor and TA emails, and your project or lab groups.
- **Discussions** — forums and topics.
- **Diagnostics** — `get_server_info`: version, timezone, who you're signed in as, whether Microsoft remembered your device, and request counters, all without touching Brightspace.

Sign-in is automatic: silent renewal most days, the MFA number shown in-chat when needed, Duo and authenticator-code support, a visible-browser mode for anything else, an opt-in "remember this device" for Microsoft, and a browser-free mode (paste a session cookie or token) for Docker, WSL, and hardware-key accounts. Links in course content have D2L's session tokens stripped before they reach the AI.

## Settings you might want

All optional, set in your AI app's MCP `env` config or your shell. The full list is in [LLMs.md](LLMs.md).

| Setting | What it does |
|---------|--------------|
| `D2L_REMEMBER_MFA=true` | Tick Microsoft's "Don't ask again" box so later sign-ins skip the second factor (off by default; not for shared computers) |
| `D2L_HEADLESS=false` | Show the browser window during sign-in, for MFA methods that need a click |
| `D2L_DUO_PASSCODE=1` | On Duo, type a passcode instead of waiting for a push |
| `D2L_SESSION_COOKIE` / `D2L_ACCESS_TOKEN` | Skip the browser entirely with a pasted cookie or token ([how](docs/sign-in.md#no-browser-paste-a-session-cookie-or-token)) |
| `D2L_INCLUDE_COURSES` / `D2L_EXCLUDE_COURSES` | Limit which courses the AI sees, by course id |
| `D2L_ACTIVE_ONLY=false` | Include courses whose enrollment has ended |
| `D2L_NO_UPDATE_CHECK=1` | Turn off the new-version notice |

## When it asks you to sign in

There's no separate login — asking a question signs you in, and it stays signed in on its own most days. When your school wants two-factor again, the number to approve shows up right in the answer; approve it on your phone and ask again. If it ever gets stuck, run this in a terminal:

```bash
npx -y brightspace-mcp-server@latest auth
```

How often you're asked is up to your school, not this tool. Everything else about sign-in — Duo, authenticator codes, visible-browser mode, and running without a browser at all (Docker, WSL, hardware keys) — is in [docs/sign-in.md](docs/sign-in.md).

## Something not working?

- **It works in the terminal but not in the app:** the app starts it separately and may not see your password store yet — see [docs/troubleshooting.md](docs/troubleshooting.md).
- **Which version do I have?** Ask your AI "which version of the Brightspace server am I running?"
- **Still stuck?** [Open an issue](https://github.com/RohanMuppa/brightspace-mcp-server/issues) and paste what the terminal printed.

## Is it safe?

Your password is kept in your operating system's password store, never in a plain file. Saved sign-in state is encrypted. Your second factor (the phone tap or code) stays on your phone — this tool never sees or stores it. And it can only read your courses, never change them.

## For developers

Tool reference, response fields, and environment variables: [LLMs.md](LLMs.md). What's safe to build against: [STABILITY.md](STABILITY.md). Licensed under the MIT License.
