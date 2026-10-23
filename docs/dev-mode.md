# Dev activity log (optional)

## Logging modes

| Mode | Destination | Content |
| --- | --- | --- |
| Normal (default) | Server stderr, captured by the MCP client | Concise startup, session renewal, sign-in progress and warnings/errors. Existing token redaction applies. |
| Developer (`D2L_DEV_MODE=true`) | Normal stderr plus local `dev-activity/*.jsonl` | Structured, allowlisted diagnostics below. This does not enable unrestricted DEBUG output or copy stderr into the activity files. |

Developer mode is independent of the normal stderr log level. It adds no network
requests, browser launches or authentication attempts. Enable it on the server;
automatic authentication children inherit it. Restart existing MCP connections
after changing the setting. Upgrading the package also requires reconnecting so
the running process loads the new logging implementation.

Set `D2L_DEV_MODE=true` in the MCP server's environment and restart the server
to record local tool and authentication activity. It is disabled by default;
other values do not enable it. Logs are JSONL files under the resolved account
session directory's `dev-activity` folder (the same session root configured by
`D2L_SESSION_DIR`). No package update or background polling is needed.

After configuration loads, each server/auth CLI process emits `run_started` with its package `version`,
`nodeVersion` and `role` (`server` or `auth`). Existing older files lack this
record; an installed package's current version does not identify an old run.

Each executed tool handler records `tool_started` and `tool_finished`, including
UTC timestamp `at`, process `pid`, random `runId` and `callId`, registered tool
name, duration, and success/error outcome. `idleMs` measures time since the
previous handler started; `sinceSuccessMs` measures time since the previous
successful handler finished. These intervals are process-local and omitted
until a prior observation exists. Compare timestamps across files for gaps
that span server restarts. Unknown tools and requests rejected by SDK input
validation never execute a handler and are not included.

Failed handlers also record an allowlisted `errorKind`: `validation`,
`destinationMissing`, `permissionDenied`, `notFound`, `unsupportedFormat`,
`tooLarge`, `authentication`, `transport`, `rateLimited`, `providerBlocked` or
`unknown`. Typed exceptions retain their category when converted to an MCP
error result. Handled validation, missing-file/destination, oversized-file and
permission failures carry explicit categories too. Direct error results without
a known category use `unknown`;
the logger never guesses from user-facing text. Successful results omit it.

Authentication events include `http_response`, `auth_required`,
`token_mint_started` / `token_mint_finished`, `recovery_started`, `mfa_observed`,
and `recovery_finished`. They share the initiating handler's `callId`, including
background recovery that finishes after a tool returns. Concurrent callers
joining an existing recovery share that operation; its events retain the
initiating call's ID. A mint outcome describes the token service response;
`recovery_finished` describes the browser child process outcome. `auth_required`
distinguishes `missingToken` from `rejectedToken`; normal stderr also briefly
explains which condition triggered renewal.

`http_response` includes the status, time to response headers (`elapsedMs`), and
an allowlisted semantic `operation`, such as `quizAttempts`, `dropboxSubmissions`
or `dropboxFeedback`. Detail/file operations are separate from lists (for example,
`quiz`, `contentFile`, `dropboxAttachment`, `submissionFile`, `newsAttachment`),
and syllabus discovery identifies `rubrics`, `overview`, `overviewAttachment`,
`ltiLinks` and `quickLink`. Paths, identifiers and queries are never recorded.
`http_failed` records a transport failure while fetching/reading a response;
each retry is a separate attempt. `cache_hit` and `http_coalesced` identify a
cached result or a request joined to an existing GET. Optional HTTP failures can
coexist with a successful tool result: inspect the result's coverage/unknown
fields before inferring missing submissions, feedback or quiz attempts.

`token_mint_response` records the token service's status (when received) and
classification: `http401`, `expiredStub`, `expiredRedirect`, `invalidPayload`,
`serviceUnavailable` or `transport`. A successful response has no reason.
The response body and redirect URL are never recorded. This distinguishes a
proven dead session from a temporary service failure; it cannot reveal the
school's internal expiry policy or the exact expiry instant during idle time.

Each launched authentication child gets a random `recoveryId`, shared by the
parent's recovery/phase events and the child's own records. Join by that ID
instead of timestamp proximity or PID. A joined caller does not create a new
recovery. A child relaying a separate process's lock/MFA challenge is still a
separate attempt; its ID does not identify that other lock owner's process.

The child also records `browser_state_loaded` (`statePresent`, without the saved
state, or `outcome: error` if it could not be read), `silent_sso_finished` (`ssoResult`: `resumed`, `loginRequired` or
`unavailable`), and `mfa_remembered` (`rememberMfa`: `ticked`, `already`, `absent`,
`off` or `unknown`). The MFA value describes this run's observation; `unknown`
does not mean a previously saved preference was cleared. `mfa_code_submitted`
means the automatic code flow submitted a code, not that a person was prompted.

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
