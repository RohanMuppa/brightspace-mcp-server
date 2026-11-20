# Changelog

What changed in each published version, newest first. Every PR that ships to users adds a line under its version here ([how](docs/internals/releasing.md)). Write the line for someone who uses the server: say what they will notice, not what the code does.

A change that can break something a caller relied on is marked **Changed behaviour**. What may and may not change is in [STABILITY.md](STABILITY.md).

Entries up to 5.2.1 were generated from the merged PR titles. Versions before 5.0.0 are in the [GitHub releases](https://github.com/RohanMuppa/brightspace-mcp-server/releases) and the git history.

## 5.2.21 (2026-11-19)

- feat: `download_course_files` can now save the whole course in one call. New options `includeSubmissions` (your own submitted files, a `feedback.md` per assignment with the score, comments and rubric, and the feedback attachments Brightspace lists), `includeAssignmentFiles` (the instructor's attachments), `includeAnnouncementFiles`, and `everything: true` to turn all three on. They are all off by default, so a call without them behaves as before. Files go under `Assignments/` and `Announcements/` in the destination, and a rerun skips what is on disk and refreshes `feedback.md` after grading unless you edited it. Anything Brightspace did not answer is reported as unknown, never as none. The syllabus is still separate (`get_syllabus`).

## 5.2.20 (2026-11-19)

- fix: `download_file` with `folderId` and `fileId`, and `download_dropbox_submission_file`, now request a submission file from the route Brightspace actually serves. They asked for a path ending in `/download`, which Brightspace answers with "not found", so no submission file could be downloaded on any school.

## 5.2.19 (2026-11-19)

- fix: `download_file` with `folderId` and `fileId` now saves your own submission files on schools where Brightspace nests them one level down, instead of answering "not found" with an empty file list. The same fix applies to `get_dropbox_submissions`, `get_dropbox_user_submissions` and `download_dropbox_submission_file`. When a submission has no files, the answer says so.
- fix: `download_course_files`, `get_unsaved_course_files` and the `sync` command now say they cover the Content area only, and name the tools for what they skip: your own submissions and feedback, assignment and announcement attachments, the syllabus. "These are not missing from the sync" no longer reads as "the whole course is saved". `get_unsaved_course_files` adds a `notCovered` field; every existing field is unchanged.

## 5.2.18 (2026-11-19)

- fix: `get_unsaved_course_files` labels the topic types in `tableOfContents.topicTypes` as `File` and `Link` when Brightspace gives no numeric type, instead of `File/?` and `Link/?`. A topic with no type at all is `unknown`. The key is `File/1` only when both parts exist, and the answer's note says what the two parts are.

## 5.2.17 (2026-11-19)

- feat: tell the server which course files you already have. The new `mark_course_files_saved` tool records topics as saved without downloading them (with the path of your copy if you know it, or just the topic), can mark everything currently unsaved when you say so, and can undo a mark. `get_unsaved_course_files` counts these in `savedCount` and shows them in `markedSavedCount`, since the server never checked a file for them. It also now gives each entry's `title` and `lastModified`, and a `tableOfContents` block (`topics`, `modules`, `unreadEntries`, `topicTypes`) so the counts can be checked: the topics listed in `nonFileCounts` plus `fileTopicCount` add up to `tableOfContents.topics`, and if `get_course_content` shows more topics than that, Brightspace's table of contents does not include them. `download_course_files` prints the same total. A network path (`\\host\share` or `//host/share`) is refused for a mark and for `syncFolder`, and dropped from the saved record, so a request cannot make the computer contact another host. A mark with a path is shown as marked and its file is still checked, a mark never replaces a download's record while its file exists, and a mark or unmark that changes nothing no longer rewrites the saved record.

## 5.2.16 (2026-11-19)

- fix: `download_course_files` and `sync` no longer wait for the saved-files record before downloading. 5.2.15 took a lock on that record first, which on a slow or busy computer could use up a short time limit so that nothing downloaded. The folder is now remembered when the run ends, and only if it holds saved files. `download_file` also no longer waits more than half a second for that record before answering.

## 5.2.15 (2026-11-19)

- feat: a reliable "what don't I have yet" for a course, by Brightspace topic id instead of dates. The new `get_unsaved_course_files` tool lists the course's file topics you have not saved, treats files saved by `download_file` (into any folder, under any name) and by `download_course_files` or `sync` as saved, lists a saved file you deleted under `savedFileMissing`, and says so (`complete: false`, `stateUnreadable`, a notice) instead of returning "nothing new" when a record or the course's contents could not be read. `download_file` now records each content topic it saves to disk in `~/.brightspace-mcp/saved-topics.json`. The tool also says when records could not be trusted: a damaged ledger is set aside and reported (`stateUnreadable`, `complete: false`) until you delete the set-aside file, a sync folder or drive that is not found is not read as "not saved", and unsaved is described as "no record of saving", so a file you have from another source is not downloaded again without asking. The `get_course_content`, `download_file` and `download_course_files` descriptions now tell the agent to use it, and never to conclude a file is absent from `modifiedSince`, which cannot see a file uploaded before it was released.

## 5.2.14 (2026-11-19)

- fix: `get_course_content` with `moduleTitle` now finds modules nested inside other modules, such as "HW12" inside "Homeworks". Each match comes back with its full contents and a `path`. When no title matches, a notice says so and points to `search_course`. With `modifiedSince`, each module now lists the topics the filter dropped in `hiddenByFilter` (and counts dropped sub-modules in `hiddenModulesByFilter`), and a notice and the tool description say a file uploaded early and released later is missed, so the filter must not be used to conclude a file is absent.

## 5.2.13 (2026-11-19)

- fix: `get_upcoming_due_dates` now lists an assignment whose instructor set only an availability end date and no due date. It shows as `type: "assignment"` with that end date as `dueDate` and as `endDate`. Before, it was missing from the list, or showed up only as a generic "Availability Ends" calendar event when the course calendar could be read. This matches how quizzes already fall back to their end date (#460).

## 5.2.11 (2026-11-17)

- fix: `get_announcements` across all courses no longer lets "couldn't read this course" pass for "no new announcements". A course whose announcements Brightspace refused or failed to return is now named in `unreadCourses` (with its name and HTTP status) and in a notice telling the agent not to report it as empty, instead of appearing only as a bare id in `pagination.unavailableCourseIds` (#456).

## 5.2.10 (2026-11-16)

- fix: `download_course_files` on Windows no longer cuts every file and folder name to about 30 characters because one path somewhere in the course was too long. Only the names on a path that is actually over the length limit are shortened now, so files like "Minimum Technology Requirements.html" keep their full names, and a path just a few characters over the limit is shortened to fit instead of failing as too long (#453).

## 5.2.8 (2026-11-16)

- fix: a group assignment whose group membership Brightspace refused or failed to return no longer says "Brightspace did not identify a unique group". In `get_assignments`, `get_assignment_files` and `get_upcoming_due_dates` that row still links to the course home, but now carries `groupMembershipUnavailable: true` and a `urlNote` that says the membership couldn't be read, so the agent doesn't tell you that you have no group (#451).

## 5.2.7 (2026-11-15)

- fix: `get_syllabus` now finds a syllabus tool (e.g. Simple Syllabus) set up as an LTI 1.3 (LTI Advantage) link, and lists it in `externalSyllabusSources`. When it finds no external source, `externalSyllabusDiscovery` now says the course navbar wasn't checked (`notChecked: ["course-navbar"]`), because Brightspace has no API for navbar links, so an empty answer is no longer read as "this course has no syllabus" (#449). **Changed behaviour:** in that case `externalSyllabusDiscovery` is now present with `complete: false`, and a course with no overview no longer gets the message "No syllabus/overview found for this course."

## 5.2.6 (2026-11-15)

- fix: `get_assignments` no longer lets "couldn't read the assignment list" pass for "no assignments due". A course whose assignment (dropbox) list Brightspace refused or failed now carries `assignmentListUnavailable` and `assignmentListNote`, and without `courseId` a course that couldn't be read at all is named in `unreadCourses` and the `notice` instead of vanishing from the answer (#447).

## 5.2.5 (2026-11-14)

- fix: `get_available_groups` now says in `note` why each open sign-up is in `unreadCategories`: it names the category and course, says whether Brightspace refused access (403) or found no group list (404), and says open groups there aren't listed, so the agent doesn't report that sign-up as full or closed (#433).

## 5.2.4 (2026-11-13)

- fix: `get_my_groups` no longer lets "couldn't read the groups" pass for "you're in no group". It adds `groupsUnavailable` when Brightspace refuses the course's group list, and `unreadCategories` when it refuses some categories, and on a 403 the note says membership is unknown (#442).

## 5.2.3 (2026-11-12)

- fix: when Brightspace refuses `get_dropbox_folders` or `get_rubrics_for_object`, the error no longer says "Instructor or TA access required", because students can read that list. It says you may not be enrolled in that course, or the course may hide its Assignments tool, and suggests checking the course id with `get_my_courses` (#437).

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
