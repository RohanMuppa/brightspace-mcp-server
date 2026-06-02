# Brightspace Faculty MCP Server

> **A Faculty-focused fork of the [Purdue Brightspace MCP Server](https://github.com/rohanmuppa/brightspace-mcp-server)**

Manage your courses, grades, and class announcements directly through AI. This project expands the original student-facing server with **Faculty-grade features** and universal **Microsoft SSO support**.

> [!WARNING]
> **Important Disclaimer**: This is an experimental, personally-developed tool. Using AI to interact with educational platforms involves risks of non-deterministic actions (such as posting announcements or retrieving student grades) and external data processing. Please review the [Disclaimer and Intended Use Guide](DISCLAIMER.md) before deployment.

## Overview

This is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects AI assistants (Claude, ChatGPT, Cursor) to Brightspace (D2L). While the original server was built for students, this fork implements **Client-Side Session Emulation** to enable high-permission faculty operations without requiring restricted API keys.

## Installation & Setup

Since this is a custom fork with advanced features, you must install it from source:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/redmondmj/brightspace-mcp-server.git
   cd brightspace-mcp-server
   ```

2. **Install dependencies & secure:**
   ```bash
   npm install
   npm audit fix
   ```

3. **Configure environment:**
   Create a `.env` file in the root directory:
   ```env
   D2L_BASE_URL=https://your-school.brightspace.com
   D2L_USERNAME=your_username
   ```

4. **Initialize Authentication:**
   Run the browser-based auth tool to capture your full session cookies (including CSRF tokens):
   ```bash
   npm run auth
   ```
   *Note: Approve the Duo/MFA request on your phone when prompted.*

5. **Build the project:**
   ```bash
   npm run build
   ```

## Connect to Claude Desktop

Add the following to your `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "brightspace-faculty": {
      "command": "node",
      "args": ["C:/PATH/TO/YOUR/brightspace-mcp-server/build/index.js"],
      "env": {
        "D2L_BASE_URL": "https://your-school.brightspace.com",
        "D2L_USERNAME": "your_username"
      }
    }
  }
}
```
*Replace `C:/PATH/TO/YOUR/` with your actual project path.*

## Multi-Platform Integration

Since this server follows the standard **Model Context Protocol (MCP)**, it works with any compatible AI client. Use the following configurations:

### Gemini CLI
Add this to your `gemini-cli.json` or use the `--mcp` flag:
```bash
gemini --mcp node C:/PATH/TO/YOUR/brightspace-mcp-server/build/index.js
```

### ChatGPT Desktop
1. Open ChatGPT Desktop Settings → **Tools**.
2. Click **Add MCP Tool** → **Add Manually**.
3. Use `node` as the command and the full path to `build/index.js` as the argument.

### Cursor / Antigravity
1. Open Cursor Settings → **Features** → **MCP**.
2. Click **+ Add New MCP Server**.
3. **Name**: `Brightspace Faculty`
4. **Type**: `command`
5. **Command**: `node C:/PATH/TO/YOUR/brightspace-mcp-server/build/index.js`

## Faculty Features

In addition to standard "read" operations, this fork includes tools designed specifically for instructors:

- **Post Announcements**: `create_announcement` allows you to post live news items to your courses using standard HTML or plain text.
- **CSRF-Protected Actions**: Automatically bypasses Brightspace's security tokens to enable "Write" operations that standard API integrations cannot perform.
- **Full Session Authority**: Uses browser session cookies instead of limited API tokens, granting the AI the same permissions you have in the web portal.

## What You Can Ask About

| Topic | Examples |
|-------|---------|
| **Faculty** | "Post an announcement to course 12345 titled 'Reminder' saying 'See you tomorrow!'" |
| **Grades** | "Summarize the current grade distribution for my class" · "Compare my grades across all courses" |
| **Assignments** | "What's due in the next 48 hours?" · "Show me all ungraded submissions" |
| **Course Content** | "Find the latest lecture slides" · "Download every PDF from Module 5" |
| **Class Management** | "Who are the TAs for my course?" · "Get me the student list for ECE 264" |

## Technical Implementation

This project uses **Playwright** to launch an isolated browser context and intercept full session authority. By spoofing `Origin`/`Referer` headers and mirroring specific institutional JSON schemas (dual `Text/Html` bodies), it allows for seamless automation of tools normally restricted to the official D2L web interface.

## Security

- Session tokens are stored locally and encrypted using **AES-256-GCM**.
- No credentials or session data are sent to any third party; communication is strictly between your machine and your school's Brightspace instance.

---

Original project by [Rohan Muppa](https://github.com/rohanmuppa) 🚂
Faculty fork and expansion by [redmondmj](https://github.com/redmondmj)
