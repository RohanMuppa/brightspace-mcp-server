# Brightspace MCP Server

> **By [Rohan Muppa](https://github.com/rohanmuppa), ECE @ Purdue**

Talk to your Brightspace courses with AI. Ask about grades, due dates, quizzes, announcements, and more. Works with Claude Desktop, Claude Code, Cursor, ChatGPT Desktop, Windsurf, and any MCP client.

This is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects your AI to D2L Brightspace so it can pull your grades, assignments, syllabus, and course content on demand.

Works with any school that uses D2L Brightspace, including Purdue, SUNY, USC, and hundreds more.

<p align="center">
  <img src="https://raw.githubusercontent.com/RohanMuppa/brightspace-mcp-server/main/docs/how-it-works.svg" alt="Architecture diagram" width="100%">
</p>

## Try It

> "Download my lecture slides and turn them into interactive flashcards"
> "Grab every assignment rubric and build me a visual dashboard of what I need to hit for an A"

## Install

**You need:** [Node.js 18+](https://nodejs.org/) (download the current LTS, 20 or newer)

**Option 1: Let your AI do it**

Paste this into Claude Code, Cursor, Windsurf, Copilot, Codex, or any AI coding assistant:

```
Install brightspace-mcp-server for me by following
https://github.com/RohanMuppa/brightspace-mcp-server/blob/main/LLMs.md
(use --purdue if I'm at Purdue, or --suny if I'm at a SUNY campus).
```

**Option 2: Run it yourself**

```bash
npx brightspace-mcp-server setup
```

Purdue students can add `--purdue` to skip entering the school URL:

```bash
npx brightspace-mcp-server setup --purdue
```

SUNY campuses share one Brightspace site, so `--suny` also asks which campus
you're at and skips SUNY's campus picker when you sign in:

```bash
npx brightspace-mcp-server setup --suny
```

The wizard walks you through login and MFA, auto configures Claude Desktop and Cursor, and prints the config to paste into ChatGPT Desktop if it is installed. Restart your AI client when it finishes.

Any other D2L school: run `setup` without a flag and paste your Brightspace URL (for example `https://yourschool.brightspace.com`).

<details>
<summary>Using a different client? Configure it manually.</summary>

Search your client's docs for how to add an MCP server. The server command to register is:

```
npx -y brightspace-mcp-server@latest
```

On **Windows**, npx must be wrapped: `cmd /c npx -y brightspace-mcp-server@latest`

You still need to run `npx brightspace-mcp-server setup` first to save your credentials.

</details>

## Session Expired?

You should rarely see this. Access tokens are re-minted from your saved session cookie in the background (no browser, about 200 ms), and a browser only opens when the Brightspace session itself has ended, typically after days. If that automatic re-login fails, run:

```bash
npx brightspace-mcp-server auth
```

**MFA at Purdue** is Microsoft Authenticator number matching: a two digit number appears in the browser and is also printed in the terminal. Enter it on your phone. Other schools may use Duo or their own app.

## What You Can Ask About

| Topic | Examples |
|-------|---------|
| Grades | "Am I passing all my classes?" · "Compare my grades across all courses" |
| Assignments | "What's due in the next 48 hours?" · "Summarize every assignment I haven't turned in yet" · "Give me the link to submit HW 4" |
| Quizzes | "How many attempts do I have left on Quiz 3?" · "Which quizzes close this week?" |
| Exams | "Is there a midterm in the gradebook that isn't on my assignments list?" |
| Announcements | "Did any professor post something important today?" · "What did my CS prof announce this week?" |
| Course content | "Find the midterm review slides" · "Download every PDF from Module 5" |
| Roster | "Who are the TAs for ECE 264?" · "Get me my instructor's email" |
| Discussions | "What are people saying in the final project thread?" · "Summarize the latest discussion posts" |
| Planning | "Build me a study schedule based on my upcoming due dates" · "Which class needs the most attention right now?" |

## Security

- Your username and password stay on your machine in `~/.brightspace-mcp/config.json`, readable only by your user (mode 0600). They are typed into your school's real login page and nowhere else.
- Session tokens and cookies live in `~/.d2l-session/`, encrypted with AES-256-GCM.
- All traffic to Brightspace is HTTPS.
- The only other network call is a version check against the npm registry on startup.
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

Automatic. Every time your AI client starts a session, it runs `npx brightspace-mcp-server@latest` which pulls the newest version from npm. No action needed.

If you ever suspect you're on an old version (the auth banner prints the version), clear the npx cache and restart your client:

```bash
npx clear-npx-cache
```

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
