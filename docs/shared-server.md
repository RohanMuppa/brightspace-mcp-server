# Shared server

Most people never need this page. Every chat already shares one Brightspace server, with nothing to set up. Read on only if you use Codex, or want one server you start yourself and point every chat at.

## Automatic (the default)

Each chat launches the usual command, but that command is only a small relay. The first question from any chat starts one shared background server for this computer, and every other chat (Claude Desktop, Codex, Cursor, …) uses it. That means one sign-in, one saved session and one cache. Two chats starting at the same moment still end up with one server, and closing a chat never interrupts another chat's question.

After 10 minutes with no question running, the shared server stops by itself, and the next question starts it again. Change the wait with `D2L_RUNTIME_IDLE_SECONDS`. Chats share a server only when they use the same `D2L_*` settings and the same package version. Its log is `runtime.log` under `<session dir>/shared-runtime/<hash>/` (the session dir is `~/.d2l-session` by default).

## Running the shared server yourself (optional)

You run **one** copy and point every chat at it by URL. It uses the same saved password, saved session and sign-in as before, and a question that needs a sign-in still signs in once for every chat.

1. **Make a secret token, once.** Chats must present it, so other programs and web pages can't read your grades:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Save it as a user environment variable named `D2L_HTTP_TOKEN` (at least 32 characters), where both the server and Codex can see it. On Windows: Start → "Edit environment variables for your account" → New. On macOS or Linux: add `export D2L_HTTP_TOKEN=<token>` to your shell profile (`~/.zshrc` or `~/.bashrc`). A Codex app launched from the Dock may not read that profile, so start it from a terminal. The server never prints the token.
2. **Start the server and leave it running** in its own terminal:
   ```bash
   npx -y brightspace-mcp-server@latest http
   ```
   It listens on `http://127.0.0.1:18765/mcp`, on this computer only. Pick another port with `--port 18766` or `D2L_HTTP_PORT`, and use that port in the URL below. Start it once per login: chats never start it, and a second copy on the same port stops at once with "already in use". Nothing signs in at startup. From a source checkout, run `npm run build` first, then `node build/index.js http`.
3. **Point Codex at it.** In `~/.codex/config.toml`, replace the `command` and `args` lines of your `[mcp_servers.brightspace]` entry with:
   ```toml
   [mcp_servers.brightspace]
   url = "http://127.0.0.1:18765/mcp"
   bearer_token_env_var = "D2L_HTTP_TOKEN"
   ```
   (`env_http_headers = { "Authorization" = "D2L_HTTP_AUTHORIZATION" }` also works, if that variable holds `Bearer <token>`.) A project's own `.codex/config.toml` overrides this one, so remove any `brightspace` entry there too. Rerunning `setup` recognizes this entry and keeps it.
4. **Restart Codex.** Chats already open keep the old per-chat server until Codex restarts. If calls fail after you stop or restart the shared server, start a new chat or restart Codex.

Things that change:

- **Settings go to the server, not to Codex.** A URL entry has no process to pass an `env` table to, so set `D2L_*` values in the terminal that runs `http`, in a `.env` file in the directory you start it from, or through `setup`.
- **Sign-in messages appear in the server's terminal.** The number to approve still comes back in the chat's answer.
- **Stopping:** press Ctrl+C. Questions already running finish first; press Ctrl+C again to stop at once.
- **Updating:** restart the server, not Codex. Stop it, then start the same `http` command again with the same `D2L_HTTP_TOKEN`, port and settings. From a source checkout, run `npm run update` first.

Any other MCP client that can connect to a Streamable HTTP URL with a bearer token can share this server. To go back to the automatic shared server, put the `command`/`args` entry back (rerun `setup` and say yes when it offers to switch Codex back) and stop the server you started.

Tool and setting reference: [LLMs.md](../LLMs.md). Common problems: [troubleshooting](troubleshooting.md).
