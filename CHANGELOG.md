# Changelog

What changed in each published version, newest first. Every PR that ships to users adds a line under its version here ([how](docs/internals/releasing.md)). Write the line for someone who uses the server: say what they will notice, not what the code does.

A change that can break something a caller relied on is marked **Changed behaviour**. What may and may not change is in [STABILITY.md](STABILITY.md).

Entries up to 5.2.1 were generated from the merged PR titles. Versions before 5.0.0 are in the [GitHub releases](https://github.com/RohanMuppa/brightspace-mcp-server/releases) and the git history.

## 5.3.0 (unmerged)

- feat: macOS notifications for the sign-in approval number and for new course files (`sync --notify`). `D2L_NOTIFY=0` turns them off.
- feat: `schedule` runs a course sync every day through a per-user launchd agent (macOS).

## 5.2.2 (2026-11-11)

- docs: one short install page for agents (`LLMs.md`), one rules file for contributors (`AGENTS.md`), and the tool, command and setting reference moved to `docs/reference/` and `docs/internals/`. The install prompt in the README is now one sentence.
- docs: this changelog.
- chore: log lines no longer state a hand-counted number of tools.
- ci: tests fail on a broken doc link, a doc naming a file that is gone, an install page that grows past its limit, or a version with no changelog entry.

## 5.2.1 (2026-11-10)

- fix: say when get_course_content couldn't read completion progress (#431) (#432)
- docs: explain every sign-in message, add contributor rules, and fail CI when docs drift (#430)

## 5.2.0 (2026-11-09)

- feat: download or sync a whole course: the `download_course_files` tool and the `sync` command (#425)
- **Changed behaviour:** every tool that saves to disk (`download_file`, `download_dropbox_submission_file`, `get_syllabus`, `download_course_files`, the `sync` command) now refuses some destinations it used to accept: the home folder itself, a drive root, any path through a hidden (dot) folder, `~/Library` outside `CloudStorage` and `Mobile Documents`, system folders, the Windows system folders and `AppData`, and device paths. Everything else still works. An operator can allow a folder anyway with `D2L_DOWNLOAD_ROOTS`. The full list is in [docs/internals/downloads.md](docs/internals/downloads.md).
- feat: a new download error kind, `empty`, reports a 0-byte file as empty on Brightspace instead of "format could not be identified".
- feat: `get_course_content` marks `ContentService` topics (embedded video) with `embeddedMedia: true`.
- fix: a download that ends before its Content-Length is reported as incomplete and leaves nothing behind.
- ci: publishing is serialized and only ever moves npm's `latest` forward.

## 5.1.44 (2026-11-09)

- fix: give a resent MFA number its own approval window (#426)

## 5.1.43 (2026-11-09)

- fix: register Claude Desktop where the Windows Store app reads its config (#422)
- ci: create the GitHub release when a version is published to npm (#413)

## 5.1.42 (2026-11-07)

- fix: fail dropbox submission tools on a rejected credential (#420) (#421)

## 5.1.41 (2026-11-06)

- fix: say when get_assignment_rubric couldn't read the rubric (#418) (#419)

## 5.1.40 (2026-11-06)

- feat: add Memorial University of Newfoundland (--mun) sign-in (#416)

## 5.1.39 (2026-11-05)

- fix: say when get_syllabus couldn't read the syllabus attachment (#415)

## 5.1.38 (2026-11-04)

- chore: release 5.1.38 so the trash 10 dependency cleanup reaches npm (#411)
- chore: bump trash to 10 to drop glob 7, inflight and minimatch 3 (#408)

## 5.1.37 (2026-11-04)

- fix: say when get_classlist_emails leaves out people with a hidden email (#410)

## 5.1.36 (2026-11-03)

- fix: say when get_roster couldn't read a course's instructors or TAs (#389)
- feat: add get_available_groups for groups a student can still join (#404)
- fix: list group member names when the classlist is unreadable (#403)
- fix: stop a terminal window flashing on Windows when a session expires (#396)

## 5.1.35 (2026-11-03)

- fix: say when get_course_content couldn't read a module's contents (#406)

## 5.1.34 (2026-11-02)

- fix: say when get_discussions couldn't read a forum's topics or a topic's posts (#399)

## 5.1.33 (2026-11-02)

- fix: say when get_roster couldn't read a course's instructors or TAs (#397)

## 5.1.32 (2026-11-01)

- fix: say why get_my_groups member names are null when the classlist can't be read (#394)

## 5.1.31 (2026-10-31)

- chore: drop the unused cacheTTLs client option and turn on unused-code checks (#392)

## 5.1.30 (2026-10-30)

- chore: dependency updates

## 5.1.29 (2026-10-29)

- fix: stop false "could not be reached" sign-in failures and needless sign-in windows (#385)

## 5.1.28 (2026-10-29)

- fix: say when get_upcoming_due_dates couldn't read a course's assignments, quizzes, discussions or calendar (#384)

## 5.1.27 (2026-10-28)

- fix: cap how far Office text extraction inflates a ZIP so a crafted attachment can't exhaust memory (#381)

## 5.1.26 (2026-10-28)

- feat: add a sign_in tool so an AI app can start a sign-in itself (#379)

## 5.1.25 (2026-10-27)

- fix: keep a tag's later attributes when an earlier quoted value contains ">" (#378)

## 5.1.24 (2026-10-27)

- fix: leave a quiz's bestScore null while its attempts await grading instead of reporting 0 (#375)
- fix: reject normalized authorities in enforced course-file links (#373)

## 5.1.23 (2026-10-25)

- fix: let auth --logout cancel a background sign-in an AI app started, as sign_out does (#369)

## 5.1.22 (2026-10-25)

- fix: report a pending or refused sign-in from search_course, course files and doctor instead of hiding it (#368)

## 5.1.21 (2026-10-25)

- fix: say what a retry and sign_out do to the MFA prompt, and report when Microsoft holds a new one back (#354)

## 5.1.20 (2026-10-25)

- fix: tell the user to paste a fresh credential when D2L_SESSION_COOKIE or D2L_ACCESS_TOKEN is rejected (#366)

## 5.1.19 (2026-10-25)

- feat: mint a Bearer token from D2L_SESSION_COOKIE over plain HTTP (#357)

## 5.1.18 (2026-10-25)

- fix: read a discussion topic from its forum's topic list and report forbidden posts as unavailable (#365)

## 5.1.17 (2026-10-25)

- fix: decode each HTML character reference once so an encoded ampersand stays literal (#361)
- fix: update locked transitive deps so npm audit passes again (#363)

## 5.1.16 (2026-10-24)

- fix: keep an out-of-range numeric character reference as written instead of throwing (#353)

## 5.1.15 (2026-10-24)

- fix: replace a shared runtime left behind when its pid or port now belongs to another process (#348)

## 5.1.14 (2026-10-24)

- fix: warn on malformed D2L_INCLUDE_COURSES / D2L_EXCLUDE_COURSES instead of showing every course (#343)

## 5.1.13 (2026-10-24)

- test: retry the install smoke test's rename while Windows still holds the folder (#359)

## 5.1.12 (2026-10-24)

- chore: dependency updates

## 5.1.11 (2026-10-24)

- test: keep a runtime from an earlier test out of the next one, and give cleanup time (#358)

## 5.1.10 (2026-10-24)

- fix: stop pagination on an unparseable absolute Next link instead of losing fetched pages (#325)

## 5.1.9 (2026-10-24)

- test: time out the idle-restart test at 60 s and print where it waited (#356)

## 5.1.8 (2026-10-24)

- fix: restore missing Chromium automatically and add installation-scoped repair (#346)

## 5.1.7 (2026-10-24)

- docs: say download_file disk destinations must already exist (#335)

## 5.1.6 (2026-10-24)

- fix: join auth child dev activity to its parent recovery and record the runtime version (#332)

## 5.1.5 (2026-10-23)

- fix: name the operation behind each dev activity HTTP status (#330)

## 5.1.4 (2026-10-23)

- test: name a leaked runtime on Windows instead of failing on a held temp folder (#351)

## 5.1.3 (2026-10-23)

- feat: record a safe error category for failed tools in the dev activity log (#331)

## 5.1.2 (2026-10-23)

- fix: read the credential store once at startup, in the shared runtime (#350)

## 5.1.1 (2026-10-23)

- feat: log timestamped startup phases before credential-store lookups (#313)

## 5.1.0 (2026-10-23)

- feat: start or reuse one shared runtime from the normal stdio command (#310)

## 5.0.13 (2026-10-23)

- fix: accept /content/enforced links as download_file coursePath (#309)

## 5.0.12 (2026-10-22)

- fix(setup): hide credentials in changed stdio registration diagnostics (#305)

## 5.0.11 (2026-10-22)

- fix: fail with usage on an unknown subcommand instead of starting stdio (#306)

## 5.0.10 (2026-10-22)

- fix: stop setup diagnostics from printing headers and URL secrets of HTTP registrations (#298)

## 5.0.9 (2026-10-22)

- fix: keep an app that uses the shared HTTP server as set up instead of suggesting stdio (#302)

## 5.0.8 (2026-10-22)

- fix: tell shared HTTP users to restart the server, not the client, to update (#301)

## 5.0.7 (2026-10-22)

- fix: finish an interrupted update instead of reporting Already up to date (#300)

## 5.0.6 (2026-10-22)

- fix: refuse to update a dirty, off-main, or diverged checkout and fast-forward only (#297)

## 5.0.5 (2026-10-21)

- fix: update a git checkout to the latest npm release instead of unreleased main (#299)

## 5.0.4 (2026-10-21)

- feat: give get_video_transcript failures a structured reason and recovery path (#283) (#286)

## 5.0.3 (2026-10-21)

- fix: read the student's feedback page when the submission list is refused (#282) (#287)

## 5.0.2 (2026-10-21)

- fix: get BoilerCast transcripts through Brightspace's LTI 1.3 launch (#281) (#314)

## 5.0.1 (2026-10-21)

- fix: save legacy Office originals that download_file was refusing as application/x-cfb when customFilename has a modern extension (#288)

## 5.0.0 (2026-10-21)

- chore!: require Node.js 22, dropping Node 20 (#289)
