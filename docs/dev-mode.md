# Dev activity log (optional)

Set `D2L_DEV_MODE=true` in the MCP server's environment and restart the server
to record local tool and authentication activity. It is disabled by default;
other values do not enable it. Logs are JSONL files under the resolved account
session directory's `dev-activity` folder (the same session root configured by
`D2L_SESSION_DIR`). No package update or background polling is needed.

Each executed tool handler records `tool_started` and `tool_finished`, including
UTC timestamp `at`, process `pid`, random `runId` and `callId`, registered tool
name, duration, and success/error outcome. `idleMs` measures time since the
previous handler started; `sinceSuccessMs` measures time since the previous
successful handler finished. These intervals are process-local and omitted
until a prior observation exists. Compare timestamps across files for gaps
that span server restarts. Unknown tools and requests rejected by SDK input
validation never execute a handler and are not included.

Authentication events include `http_response` (status only), `auth_required`,
`token_mint_started` / `token_mint_finished`, `recovery_started`, `mfa_observed`,
and `recovery_finished`. They share the initiating handler's `callId`, including
background recovery that finishes after a tool returns. Concurrent callers
joining an existing recovery share that operation; its events retain the
initiating call's ID. A mint outcome describes the token service response;
`recovery_finished` describes the browser child process outcome.

During background recovery, `auth_phase` records how long each browser sign-in
stage took, as `phase` and `elapsedMs`: `launch` (starting Chromium),
`navigation` (the first Brightspace page load), `silentSso` (waiting for a saved
session to resume), `credentials` (the identity provider's login up to an MFA
challenge), `approvalWait` (from that challenge until the login finished), and
`token` (acquiring the API token). A stage is recorded when it ends, including
when it fails, so the last one shows where a slow or stalled sign-in was.

To investigate inactivity, find the last `http_response` with a 2xx status and
the next 401, `auth_required`, or `mfa_observed`. This bounds when authentication
became unusable; it does **not** reveal the exact expiry time during an idle gap.
A successful tool can answer from cache or local metadata, so tool success alone
does not prove a live authenticated request. This mode never makes extra requests
or triggers login on its own.

Logs exclude arguments, results, course IDs, URLs, account names, passwords,
cookies, tokens, MFA codes/numbers and raw errors. Keep logs private anyway:
tool names and timestamps describe your activity. Writes use restrictive POSIX
permissions where supported; Windows uses the containing directory's ACLs.
Each process/day file stops accepting records at 5 MiB. Existing logs are never
deleted automatically, so manage retention yourself. Write failures produce one
generic stderr warning and do not interrupt tools. Set `D2L_DEV_MODE=false` and
restart to stop recording; existing files remain.
