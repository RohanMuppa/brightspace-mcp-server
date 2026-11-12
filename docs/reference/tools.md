# Tool reference

This file describes each tool the server registers: its arguments, the fields it returns, and its limits. Tool names and existing response fields are stable, and any change must be additive, as [STABILITY.md](../../STABILITY.md) sets out.

| Tool | Purpose |
|------|---------|
| [`get_my_courses`](#get_my_courses) | Enrolled courses, with enrollment start and end dates |
| [`get_my_grades`](#get_my_grades) | Grades for one course or all courses |
| [`get_upcoming_due_dates`](#get_upcoming_due_dates) | Due dates across courses in a window |
| [`get_calendar_events`](#get_calendar_events) | Course calendar events in a window |
| [`get_assignments`](#get_assignments) | Assignments and quizzes with due dates and submission status |
| [`get_assignment_rubric`](#get_assignment_rubric) | Rubric for a dropbox assignment, with your outcome per criterion |
| [`get_assignment_files`](#get_assignment_files) | Read the files attached to an assignment as text |
| [`get_rubrics_for_object`](#get_rubrics_for_object) | Full rubric table for a dropbox folder |
| [`get_announcements`](#get_announcements) | Recent announcements, with their attachments |
| [`get_announcement_files`](#get_announcement_files) | Read the files attached to an announcement as text |
| [`get_discussions`](#get_discussions) | Discussion forums and recent posts |
| [`get_course_content`](#get_course_content) | Module tree and content topics |
| [`search_course`](#search_course) | Keyword search across course content, announcements and discussions |
| [`get_syllabus`](#get_syllabus) | Syllabus document for a course |
| [`get_video_transcript`](#get_video_transcript) | Transcript of an embedded video, with timestamps |
| [`download_file`](#download_file) | Get one file, inline or saved to disk |
| [`download_course_files`](#download_course_files) | Download every file of a course into a folder |
| [`get_roster`](#get_roster) | Classlist for a course |
| [`get_my_groups`](#get_my_groups) | Your project and discussion groups, with members |
| [`get_available_groups`](#get_available_groups) | Groups you can still join yourself |
| [`get_classlist_emails`](#get_classlist_emails) | Emails of classmates and instructors |
| [`get_dropbox_folders`](#get_dropbox_folders) | Every dropbox (assignment) folder in a course |
| [`get_dropbox_submissions`](#get_dropbox_submissions) | Staff: every submission to a dropbox folder |
| [`get_dropbox_user_submissions`](#get_dropbox_user_submissions) | Staff: one student's or group's submissions to a folder |
| [`get_dropbox_feedback`](#get_dropbox_feedback) | Saved feedback for a dropbox folder |
| [`download_dropbox_submission_file`](#download_dropbox_submission_file) | Staff: download one file from a submission |
| [`sign_in`](#sign_in) | Start a sign-in from chat |
| [`sign_out`](#sign_out) | Cancel a pending sign-in, delete the saved session |
| [`get_server_info`](#get_server_info) | Version, runtime, config paths, sign-in state and request counters |

Tools are registered in `src/tools/index.ts`, and their input schemas are in `src/tools/schemas.ts`. Each tool has its own file in `src/tools/`. Code paths in this file are relative to the repository root.

## Courses and grades

### get_my_courses

- Code: `src/tools/get-my-courses.ts`.
- Arguments: `activeOnly` (boolean, optional). Omit it to use the server's configured setting, which is true unless changed (`D2L_ACTIVE_ONLY` or `config.json`). The schema has no default, so a default here would override that setting.
- Each course has `id`, `name`, `code`, `role`, `isActive`, `canAccess`, `startDate`, `endDate` and `lastAccessed`.
- `startDate` and `endDate` are the enrollment's `Access.StartDate` and `Access.EndDate`. They are always present, whatever `activeOnly` is.

### get_my_grades

- Code: `src/tools/get-my-grades.ts`.
- Arguments: `courseId` (optional). Omit it for grades in all enrolled courses.
- Single course: a 403 keeps the plain error-result shape. The error text names the course's gradebook URL, so the student can open grades directly.
- All courses: the `courses` array is unchanged. Two more arrays can appear:
  - `restrictedCourses: [{ courseId, courseName, gradeUrl }]` lists courses where the grade API answers 403. This is an institutional access policy, not a missing enrollment. These courses are no longer silently dropped.
  - `failedCourses: [{ courseId, courseName, gradeUrl }]` lists any other per-course failure (404, 5xx, network error). It comes with a `notice`. Both arrays are present only when something failed. A course is never missing without a trace (#245).
- `gradeUrl` is the course gradebook deep link from `gradebookUrl()` in `src/utils/deep-links.ts`.
- A row scored from a quiz (matched by the quiz list's `GradeItemId`) has `feedbackUrl` set to the quiz page (`quizUrl()`).
- When the gradebook `comments` is null, the row also has `feedbackNote`. It says feedback may still exist on the quiz's submissions page. The student API cannot read that page, and it can need a restricted viewer such as Respondus LockDown Browser.
- A null `comments` with no `feedbackNote` means no comment was returned and no quiz was linked. It never proves that published feedback is absent.
- Rows not linked to a quiz keep their gradebook source and retrieval status.
- A refused quiz list loses only the quiz link. Grades and gradebook links still come back.
- Grade rows also carry the feedback fields in [Feedback fields](#feedback-fields).

### get_upcoming_due_dates

- Code: `src/tools/get-upcoming-due-dates.ts`.
- Arguments: `daysAhead` (1 to 90, default 7) and `courseId` (optional, one course only).
- Items come from four sources:
  - Assignments: `DueDate`.
  - Quizzes: `DueDate ?? EndDate`.
  - Discussion topics: `DueDate`, with `type: "discussion"`. A topic with no `DueDate` is an ungraded forum and is left out.
  - Calendar events: `type: "event"`. `dueDate` is the event start. `endDate` and `location` are added when set.
- Brightspace makes a calendar event for every dated assignment, quiz and discussion. An event made from an item already in the list is dropped, so each deadline appears once. Hand-made events (exams, labs) always stay.
- The tool makes no submission, feedback or attempt requests.
- Each due date has `dueIn` ([Shared behaviour](#duein)). Each item has `url` ([Links into Brightspace](#links-into-brightspace)).
- If a course's data is still loading in the background, see [Background sign-in](#background-sign-in).

### get_calendar_events

- Code: `src/tools/get-calendar-events.ts`.
- Returns course calendar events in a window, such as exams, labs, schedule changes and hand-made deadlines.
- Arguments:
  - `courseId` (optional). Omit it for all enrolled courses.
  - `from` and `to` (ISO 8601 with offset). They default to now and to 7 days after `from`.
  - `includeGenerated` (default `false`).
- Each event is `{ id, title, courseId, courseName, start, end?, location?, description? (markdown), url, generatedFrom? }`. Events are sorted by `start`.
- `generatedFrom: { type, id }` marks an event that Brightspace made from another item. `type` is `assignment`, `quiz`, `discussion`, `module`, `topic`, and so on.
- Events with `generatedFrom` are hidden unless `includeGenerated` is true.
- The tool reads `/calendar/events/myEvents/`, the per-user feed that honours event visibility.
- A course whose calendar fails does not stop the others. A second text block in `content[1]` names the failed course id, so the list is not read as complete.

## Assignments and rubrics

### get_assignments

- Code: `src/tools/get-assignments.ts`.
- Arguments: `courseId` (optional). Omit it for all enrolled courses.
- Due dates carry `dueIn` ([Shared behaviour](#duein)) and `url` and `urlKind` ([Links into Brightspace](#links-into-brightspace)).
- Gradebook-only items: `gradeOnly` rows are gradebook columns that match no assignment or quiz, such as a proctored exam.

**Dropbox assignments**

- `linkAttachments: [{ name, url }]` is added when the instructor attached URL links to the folder (D2L's `LinkAttachments`). The values come from `Title` and `Href`. A link with no `Href` is dropped.
- The field is left out entirely, not sent as an empty array, when a folder has no link attachments.
- `feedback.score` and `feedback.feedback` are kept.
- `feedback.rubricAssessments` holds the rubric id, the overall score and comment, and the criterion outcomes when supplied.
- Public instructor feedback is converted from HTML to Markdown, with plain text as the fallback. Private comments are never returned.
- Feedback routes: `myFeedback` is not a route D2L documents. When it returns nothing and work was submitted, the tool tries two documented routes in order:
  - The `Feedback` D2L embeds in `submissions/mysubmissions/` (EntityDropbox, "Existing feedback will also be included if published").
  - `feedback/user/{id}`, for individual folders.
- Draft feedback (`IsGraded: false`) is ignored.
- `feedbackSource` says which route answered: `myFeedback`, `submission` or `user`.
- Status fields and feedback links are in [Feedback fields](#feedback-fields).

**Submissions and attempts**

- `submissionStatus` is `"submitted"`, `"not_submitted"` or `"unknown"`. `submissionStatusNote` is set only when it is `"unknown"`.
- `"unknown"` covers any non-404 failure on the submission lookup (403, 5xx and so on). It also covers a `ContentMetadataOnly` quiz, whose attempts route is never called. It means Brightspace did not return the data. It does not mean nothing was submitted.
- When the submission lookup is refused for one assignment, the student's feedback page (`folder_user_view_feedback.d2l`) is read with the stored session cookie.
  - If the page lists a submission ID, the row says `"submitted"` with `submissionSource: "feedbackPage"`. `submission` stays `null`, because the page gives no file details.
  - Otherwise the status stays `"unknown"`.
- Quiz rows carry `attemptStatus` (`"known"` or `"unknown"`). `attemptStatusNote` is set only when it is `"unknown"`.
- On the Purdue tenant, students cannot read quiz attempt counts. `/quizzes/{id}/attempts/` answers 403. Those quizzes carry `attemptsAvailable: false` and null counts, not a fabricated zero.
- A 404 from the attempts route counts as zero attempts only for a quiz that the course's quiz list returned.
- Quizzes found without the quiz API carry no attempt data (`attemptStatus: "unknown"`). Their attempt count is never inferred as zero.

**Quiz rows: extra fields**

- `availability` is `notYetOpen`, `open` or `closed`. It comes from the quiz's own start and end dates. It is omitted when the quiz has neither.
- `detailsStatus: "unavailable"` and `detailsStatusNote` mean the row was built from course-content metadata alone. Brightspace would not return the quiz's details. This happens for closed, not-yet-open or special-access quizzes. It also happens for content quizzes past the cap in [Quiz discovery](#quiz-discovery).
- `exempt: true` marks a quiz the user is exempt from.
- `quizCoverage` is `"complete"` or `"incomplete"` for each course. `quizCoverageNote` is set when it is `"incomplete"`.
  - `incomplete` means a source could not be read. This includes the content table of contents falling back to the default date-restricted view.
  - A 404 on the quiz list (a course without the quiz tool) counts as answered and empty.
  - `complete` means every source answered. It does not mean every quiz is listed. A quiz absent from all three routes is invisible to this tool. An absent quiz must never be reported as missed or not taken.

#### Quiz discovery

- The tool finds a course's quizzes through three routes and merges them by quiz id:
  - The paged `/quizzes/` list. The row source is `source: "quizList"`.
  - Quiz topics in `/content/toc` that the list omits. The row source is `source: "courseContent"`.
  - Gradebook columns whose `AssociatedTool.ToolItemId` names a quiz that neither route listed. The row source is `source: "gradebook"`.
- A gradebook column is accepted as a quiz only when `GET /quizzes/{id}` answers with a `GradeItemId` equal to that column's id. A discussion or survey that shares the id is never taken for a quiz.
- **Behaviour change:** a gradebook column linked to a quiz that the list omits used to appear as a `gradeOnly` row. When that quiz is readable, it now appears as a quiz row (`type: "quiz"`, the quiz id, `source: "gradebook"`). The row has the quiz's dates and attempts.
- Gradebook-only rows now appear on tenants that send only the documented string `GradeType`. Before, only a numeric `GradeObjectTypeId` matched.
- Gradebook-only rows never appear for:
  - Hidden grade columns (`GradeObject.IsHidden`).
  - The columns of hidden assignment folders.
  - The columns of quizzes with `IsActive: false`.
- A column counts as student-scored when its string `GradeType` is `Numeric`, `PassFail`, `SelectBox` or `Text`. A numeric `GradeObjectTypeId` of 1 to 4 is still accepted as a fallback. Calculated, formula and category columns are ignored.
- A column whose quiz cannot be read stays a `gradeOnly` row. A `gradeOnly` row named like a quiz should be treated as a quiz whose details could not be read.
- At most 30 content quizzes per course have their own record or topic read. The rest are listed from the table of contents alone, with `detailsStatus: "unavailable"`. `quizCoverage` is then `incomplete`, with a note that says so.
- The table of contents is requested with `ignoreDateRestrictions=true`. D2L documents that students may use it, and it is supported from LE 1.67. D2L's default view hides every module or topic outside its date window, and a closed or not-yet-open quiz lives there.
- Only a 400, 403 or 404 on that request falls back to the plain view. A 429, a 5xx or a network failure counts the content as unread. There is no second request.
- A quiz topic is recognised by any of:
  - `ActivityType` 4.
  - `TypeIdentifier` `Quiz`.
  - A `type=quiz` quickLink.
  - A `/lms/quizzing/user/quiz_*` Url.
- The quiz id comes from `ToolItemId`, a numeric `ActivityId`, or the Url's `qi=`. If none of those give an id, the id comes from the gradebook column named by the topic's `GradeItemId`, when that column's tool agrees with the topic's `ToolId`. The topic and its column are then one quiz.
- Hidden and broken topics are skipped.
- An `IsExempt` topic (D2L: "the user is exempt from the topic") is kept, with `exempt: true`.
- A topic with no id is listed with `id: null`, its `topicId`, and a content-viewer `url`. It is not listed if a listed quiz already has the same title.
- The same id-less quiz linked from several modules (same title and link) is one row. A gradebook column with the same title is treated as that quiz, not listed again.
- Only an explicit `IsActive: false` hides a quiz. Closed quizzes stay listed.
- Gradebook probes are bounded:
  - With a known quiz tool (from a listed quiz's column, or a content quiz topic's `ToolId`), only that tool's columns are asked about, at most 20 per course.
  - With no known tool, at most 5 are asked about.
- A probe that answered 404 or 403 is not repeated for ten minutes. The rule is per signed-in client. A 401 or 5xx is never cached this way.
- If a course's data is still loading in the background, see [Background sign-in](#background-sign-in).

### get_assignment_rubric

- Code: `src/tools/get-assignment-rubric.ts`.
- Returns the full rubric table for a dropbox assignment: criteria groups, levels, points and descriptions.
- Arguments: `courseId` and `assignmentId` (the dropbox folder id that `get_assignments` returns).
- The rubric comes from the folder's embedded `Assessment.Rubrics`. If the tenant omits them there, the tool falls back to the `/rubrics?objectType=Dropbox&objectId=` listing.
- The student's own graded outcome comes from the same `myFeedback` route that `get_assignments` calls. It is never read from the per-assessment rubric route, which is unstable.
- The outcome is merged in per criterion when the tenant exposes it.
- A folder that answers 403 or 404, or has no rubric at all, returns `{ rubrics: [], note }`. It is not an error.

### get_assignment_files

- Code: `src/tools/get-assignment-files.ts`.
- Reads the files attached to an assignment, such as the spec, rubric or starter workbook, and returns their text.
- Arguments:
  - `courseId` (required).
  - `folderId` (optional). Omit it to list every assignment in the course that has attachments.
  - `fileId` (optional, requires `folderId`). Omit it to list files without reading them.
  - `extractText` (default `true`). Works for PDF, DOCX, XLSX, PPTX and plain text.
  - `maxChars` (default 12000, max 100000). The response reports whether the text was truncated.
- Assignment files currently truncate extracted text without continuation.
- Each attachment carries `downloadArgs`. Pass these to `download_file` to save the original handout. See [download_file](#download_file).

### get_rubrics_for_object

- Code: `src/tools/get-rubrics-for-object.ts`.
- Arguments: `courseId` and `folderId`.
- Returns the full rubric table for a dropbox folder: criteria, levels and points.
- Read-only.
- A 404 on the folder listing returns `rubrics: []`, `folderName: null` and a note.
- Gating: see [Instructor and TA access](#instructor-and-ta-access).

## Announcements and discussions

### get_announcements

- Code: `src/tools/get-announcements.ts`.
- Arguments:
  - `courseId` (optional). Omit it for recent announcements across all courses.
  - `count` (1 to 50, default 10).
  - `offset` (default 0).
  - `modifiedSince` (optional ISO 8601 datetime). See [lastModified and modifiedSince](#lastmodified-and-modifiedsince).
- Each announcement has its `attachments` listed.
- `body` is the full post as Markdown, converted from D2L's Html. Links, lists, tables and embedded-content addresses are kept. D2L's plain `Text` is used only for a text-only post.
- `pagination.truncated` means more posts remain. It never means that a body was cut.
- To page through results, read `pagination.nextOffset` and continue until it is null.
- Response shape:
  - Without `modifiedSince`, `content[0]` is the announcement array. A separate JSON text block holds `pagination`.
  - With `modifiedSince`, `pagination` is a field in the response object.
- `pagination` has `returned`, `total` (matching posts fetched), `truncated`, `coverageComplete` and `unavailableCourseIds`. It also has `offset`, `count` and `nextOffset`.
- If a course could not be read, `coverageComplete` is false, even when `nextOffset` is null. Recover access, then restart from offset 0.
- Offsets apply after filtering and after the global newest-first sort.
- New or edited posts can shift offsets between calls. Use the same course and filter arguments on every call. Reconcile announcement IDs when archiving.
- If a course's data is still loading in the background, see [Background sign-in](#background-sign-in).

### get_announcement_files

- Code: `src/tools/get-announcement-files.ts`.
- Reads the files attached to an announcement, such as prompts, a rubric or an updated schedule, and returns their text.
- Arguments:
  - `courseId` (required).
  - `newsId` (optional). Omit it to list every announcement in the course that has attachments.
  - `fileId` (optional, requires `newsId`). Omit it to list files without reading them.
  - `extractText` (default `true`). Works for PDF, DOCX, XLSX, PPTX and plain text.
  - `maxChars` (default 12000, max 100000).
- Read-only.
- To download an attachment, use `download_file` with `newsId` and `fileId`.

### get_discussions

- Code: `src/tools/get-discussions.ts`.
- Arguments:
  - `courseId` (required).
  - `forumId` (optional). Returns topics and posts for that forum. Omit it for all forums.
  - `topicId` (optional, requires `forumId`). Returns posts for that topic.
- Returns discussion forums and recent posts.
- A 403 on discussions does not fail [search_course](#search_course). That tool skips the source and names it in `note`.

## Course content

### get_course_content

- Code: `src/tools/get-course-content.ts`.
- Arguments:
  - `courseId` (required).
  - `typeFilter`: `file`, `link`, `html`, `video` or `all`. Default `all`.
  - `moduleTitle` (optional). A case-insensitive substring match on module titles. Children of matching modules are included in full.
  - `maxDepth` (1 to 10, optional). Depth 1 returns top-level modules with direct children only.
  - `modifiedSince` (optional). See [lastModified and modifiedSince](#lastmodified-and-modifiedsince).
- Modules and topics carry `lastModified`.
- A module is kept when any descendant topic matches, even if the module's own timestamp does not match. The module's `children` array shows only the topics that matched.
- `ContentService` topics (embedded video) carry `embeddedMedia: true` and a `note`. The note says `download_file` cannot fetch them.
- Module descriptions are Markdown. Embedded links are kept, with a plain-text fallback.
- A module that links course files from its description also carries `courseFiles`. These are the paths to pass to `download_file` as `coursePath`.
- A module whose contents could not be read, and that the parent listing did not embed, has these fields:
  - `children: null`.
  - `childrenUnavailable: { status, reason }`.
  - It is kept under any `typeFilter` or `modifiedSince`.
  - The response adds a `notice`. The module never looks empty.
- A pending or expired sign-in fails the call. It does not return a partial tree.

### search_course

- Code: `src/tools/search-course.ts`.
- Arguments:
  - `courseId` (required).
  - `query` (2 to 200 characters). For example, `midterm review slides`.
  - `limit` (default 10, max 50). Results are returned highest score first.
- Searches modules, topics, file names, announcements, and discussion forums and topics, all in one call.
- It reuses the fetchers of `get_course_content`, `get_announcements` and `get_discussions`: `fetchRootContent`/`buildContentTree`, `fetchCourseNews`, and `fetchForums`/`fetchForumTopics`. Results share their cache, so the tool does not hit the API a second way.
- Scoring uses in-memory term matches. Matching is case-insensitive and tokenised on non-alphanumeric characters.
- A result that matches every query term always ranks above one that matches only some terms.
- Within the same tier, a title match ranks above a body-only match.
- One failing source (for example, a 403 on discussions) is skipped, not fatal. The response's `note` names it.

### get_syllabus

- Code: `src/tools/get-syllabus.ts`.
- Arguments:
  - `courseId` (required).
  - `downloadPath` (optional). An absolute path to an existing directory where the attachment is saved. See [Writing to disk](#writing-to-disk).
- Returns the syllabus document for a course.

### get_video_transcript

- Code: `src/tools/get-video-transcript.ts`.
- Arguments:
  - `courseId` (optional). Required with `topicId` unless `videoUrl` is given.
  - `topicId` (optional, requires `courseId`). The content topic id from `get_course_content`.
  - `videoUrl` (optional). A direct video URL, for example the `url` field that `get_course_content` returned.
  - `offset` (default 0). A character offset to resume from. Pass back `nextOffset` as `offset`.
  - `maxChars` (default 12000, max 100000).
- Returns a transcript of a video embedded in course content, with timestamps.
- Maximum per call: `maxChars` is capped at 100000 per call. Pass back `nextOffset` as `offset` until `truncated` is false to read the whole transcript.
- Supported platforms:
  - Kaltura, for example Purdue's BoilerCast. The tool uses an anonymous widget session against the Kaltura API. No Brightspace session is needed or used for the transcript itself.
  - YouTube, through its InnerTube player endpoint, requested as a mobile client (`src/utils/transcript/youtube.ts`).
- The client identity is required. Caption URLs issued to a browser page are stamped `exp=xpe`. They need a proof-of-origin token that this server cannot mint, so they serve an empty body. The mobile clients' URLs are stamped `exp=xpo` and serve captions as they are.
- The retired `timedtext?type=list` endpoint now answers HTTP 200 with an empty body for every video. For that reason it is no longer used.
- Shorts, `/live/`, `/v/` and `youtube-nocookie.com` links all resolve.
- Auto-dubbed videos add audio tracks that share one caption list. The default audio track's own caption choice is used. There is no transcript of synthesised dub speech.
- Brightspace LTI quickLinks (a relative `/d2l/...` URL):
  - The tool requests the URL with the user's session and reads the LTI launch page (`src/utils/transcript/lti.ts`) for the video URL.
  - It takes a Kaltura KAF partner ID from the launch's `oauth_consumer_key` when the URL leaves the partner ID out.
  - It follows the `<d2l-lti-launch lti-launch-url>` element that Brightspace's quickLink page renders to the tool launch.
  - It reads an LTI 1.3 launch's `target_link_uri` on a hosted KAF host (`<partner>-<n>.kaf.kaltura.com`). That host names the partner ID. This is how Purdue's BoilerCast launches today (#281).
  - A launch that names no video returns `hasTranscript: false`. The message says the LTI link could not be resolved.
- Detected but not implemented: Panopto, YuJa, Echo360 and Vimeo. The tool names the platform and says so. It never returns an empty result for them.
- A video with no caption track returns `hasTranscript: false` with an explanation. It is not an error.
- A caption track that was listed, but then served an empty or unreadable body, is a failure. It is not reported as an absent transcript, because the captions do exist.
- Every failure has these parts:
  - The message is the first content block.
  - A second, JSON block follows. It has `videoUrl` (session parameters stripped), `platform`, `hasTranscript: false`, a `reason`, and a `recovery` sentence.
- The `reason` values are:
  - `sign_in_required`: a YouTube sign-in or bot check.
  - `access_blocked`: a caption download that YouTube refused.
  - `unavailable`.
  - `fetch_failed`.
  - A no-captions answer carries `reason: "no_captions"`.
- The tool never works around a sign-in or bot check. The recovery is for the user to open the link in their own browser and paste YouTube's "Show transcript" text.

### download_file

- Code: `src/tools/download-file.ts`.
- Read this entry for the arguments and the result. For destination rules, the manifest, file-type checks and how it is built, see [downloads.md](../internals/downloads.md).
- Arguments:
  - `courseId` (required).
  - One target. Use one of these:
    - `topicId`: a course content file.
    - `coursePath`: a file an instructor linked inside a module or page description, instead of adding it as a topic. Maximum 1024 characters.
    - `folderId` and `fileId`: a dropbox submission. Use `source` to pick another kind (below).
    - `newsId` and `fileId`: an announcement attachment. `newsId` requires `fileId`.
  - `source` (optional): `submission` (the default) or `assignmentAttachment`. Do not combine `source` with `topicId` or `newsId`. Do not combine `coursePath` with `topicId`, `folderId` or `newsId`.
  - `coursePath` accepts any of these forms:
    - A path such as `Notes/Lecture 1.pdf`.
    - The `quickLink.d2l?...type=coursefile` URL that `get_course_content` returns.
    - A `/content/enforced/<course folder>/...` link, as `get_assignments` returns it.
    - The file is fetched with the saved web session, so it needs a signed-in session.
  - `downloadPath` (optional). Omit it for an inline result. Give an absolute path to an existing host directory to save the file to disk. See [Writing to disk](#writing-to-disk).
  - `customFilename` (optional, max 255 characters). Include the extension. The default is the original Brightspace filename.
- Result field `mode` is `"inline"` or `"disk"`. A disk result has the same JSON shape as before, with `mode: "disk"` added.
- Inline result:
  - PDFs and `.docx`, `.xlsx` and `.pptx` files return extracted text.
  - `jpeg`, `png`, `gif` and `webp` images return an image block.
  - Anything else returns a short description. The description points back to disk mode.
  - It never sends an MCP `EmbeddedResource`.
  - Limits: 10MB of file and 400,000 characters of extracted text. Each limit has an explicit truncation or oversize message. The message names `downloadPath` as the way to get the full file.
- Disk result: a streamed download, up to 2GB.
- Instructor handouts (`source: "assignmentAttachment"`):
  - Use `courseId`, `folderId`, `fileId` and `source: "assignmentAttachment"`.
  - `get_assignment_files` gives these arguments as `downloadArgs` on each attachment.
  - Omit `downloadPath` for inline text. Give an absolute host directory to save the original file.
  - Leaving `source` unset downloads your own submissions.
- No `readOnlyHint` annotation is set.

### download_course_files

- Code: `src/tools/download-course-files.ts`.
- Read this entry for the arguments and the result. For destination rules, the manifest, name cleaning, retries and how it is built, see [downloads.md](../internals/downloads.md).
- Downloads every File topic of a course (from `/content/toc`) into `downloadPath`. Folders are named after the course's modules. A rerun is a sync.
- Arguments:
  - `courseId` (required).
  - `downloadPath` (required). An absolute path to an existing directory. Ask the user where to save before calling. Never guess a directory.
  - `existing`: `skip` (default), `replace` or `keep_both`. See the rules below.
  - `moduleId` (optional). Limits the download to one module and the modules inside it. Use a module id from `get_course_content`.
  - `dryRun` (default `false`). Lists the planned files. Nothing is downloaded or created. Use it first on a large course.
  - `maxFiles` (default 300, 1 to 5000). Files already on disk do not count.
  - `maxMinutes` (default 8, 1 to 120). A wall-clock deadline. When it passes, the call stops cleanly. Call again to continue.
  - `maxTotalMB` (default 5120, 1 to 1048576). Counts `Content-Length` before any write.
- `existing` rules:
  - `skip`: leave a file alone. Running the tool again only fetches what is new. It never overwrites the user's annotated copies.
  - `replace`: download again over the old copy.
  - `keep_both`: save the new copy as `name (1).ext` beside the old one, unless a copy of the same size is already there.
- A file that is present but not recorded in the manifest is the user's own and is skipped. So is a file that was edited since the sync, or whose manifest entry has no recorded size or mtime. Under `keep_both`, a copy is saved beside such a file, never over it.
- Limits and stops: files that are over the limits are reported as not attempted (`notAttempted` in the result). Call again to continue.
- A cancel from the client stops the run the same way.
- A client that sent a progress token gets a `notifications/progress` message for each file.
- A second call into the same folder while one is running is refused.
- A lost session (401) stops the run with sign-in guidance. The rest count as not attempted.
- Locked or unreleased topics count as `unavailable`, not as failures.
- Text result: the answer counts downloaded, already on disk, failed and not attempted. It also says what was not a file (links, embedded media, broken, other).
- A 0-byte file is counted as `emptyOnBrightspace`, not as a failure.
- No `readOnlyHint` annotation is set. The tool writes files.

## People and groups

### get_roster

- Code: `src/tools/get-roster.ts`.
- Arguments:
  - `courseId` (required).
  - `includeStudents` (default `false`). The default returns instructors and TAs only.
  - `searchTerm` (optional, max 200 characters). Filters by name.
  - `limit` (default 100, max 1000).
- Default staff-only view (`includeStudents=false`): the tool first tries Purdue's own instructor and TA role IDs.
- If that returns nobody, the tool falls back. It matches `ClasslistRoleDisplayName` case-insensitively against instructor, professor, lecturer, teaching assistant, coordinator, grader, or TA. The response's `roleFilter` field reports that the fallback was used. 
- The response reports the true total and whether the result was truncated.
- If a course's data is still loading in the background, see [Background sign-in](#background-sign-in).

### get_my_groups

- Code: `src/tools/get-my-groups.ts`.
- Argument: `courseId` (required).
- Returns the current user's project and discussion groups in a course, with each group's members.
- The group membership lookup is cached. [Links into Brightspace](#links-into-brightspace) uses the same lookup.

### get_available_groups

- Code: `src/tools/get-available-groups.ts`.
- Arguments:
  - `courseId` (optional). Omit it to check courses that started in the last 12 months.
  - `includeOlder` (default `false`). Without `courseId`, also checks older and undated courses. Schools that never close a course keep years of finished courses whose sign-ups still look open.
- Returns groups the current user can still join themselves, with spots left and when sign-up closes.
- If a course is still loading in the background, the response sets `authPending: true` and `unavailableCourseIds`. See [Background sign-in](#background-sign-in).

### get_classlist_emails

- Code: `src/tools/get-classlist-emails.ts`.
- Argument: `courseId` (required).
- Returns the emails of classmates and instructors.
- Read-only.

## Dropbox (instructors and TAs)

These tools are read-only views of a course's dropbox folders. Most of them are staff-only. See [Instructor and TA access](#instructor-and-ta-access).

### get_dropbox_folders

- Code: `src/tools/get-dropbox-folders.ts`.
- Argument: `courseId` (required).
- Returns every dropbox (assignment) folder in a course, with its due dates, submission type, visibility, and whether rubrics are attached.
- Use it to find the `folderId` values that the other dropbox tools need.
- A 404 returns `folders: []` with the note "No dropbox folders found for this course."
- Students can read this list, so the tool is not gated to staff. A 403 is a `permission` error that names the likely causes: the student is not enrolled in that course, or the course hides its Assignments tool from their role. See [Instructor and TA access](#instructor-and-ta-access).

### get_dropbox_submissions

- Code: `src/tools/get-dropbox-submissions.ts`.
- Arguments:
  - `courseId` (required).
  - `folderId` (required).
  - `activeOnly` (default `false`). When true, skips submissions that already have feedback published with a score.
  - `ignoreFeedback` (default `false`). When true, omits the feedback status from each entry, to make the response smaller.
  - `limit` (default 100, max 1000).
- Returns every student's or group's submission to a folder. Each entry has the submitter, the submitted date, the late status, the files, and the feedback or grading status.
- The response reports the true total and whether the result was truncated.
- Feedback is fetched only for the returned slice.
- Staff-only.

### get_dropbox_user_submissions

- Code: `src/tools/get-dropbox-user-submissions.ts`.
- Arguments:
  - `courseId` (required).
  - `folderId` (required).
  - `userId` (required). A Brightspace user ID, or a group ID for a group folder.
  - `ignoreFeedback` (default `false`). When true, omits the feedback status from the response.
- Returns every submission made by one student or group in a dropbox folder.
- Staff-only.

### get_dropbox_feedback

- Code: `src/tools/get-dropbox-feedback.ts`.
- Arguments:
  - `courseId` (required).
  - `folderId` (required).
  - `entityType` (optional): `user` or `group`. It says whether `entityId` is a user or a group.
  - `entityId` (optional). The user or group whose feedback to read.
- Omit both `entityType` and `entityId` to read your own feedback.
- Returns the saved feedback for a folder: the score, the graded state, the feedback text, and the rubric assessment.
- Own feedback comes from `feedback/user/{whoami id}`. D2L documents it as visible to the learner once it is released.
- A 403 on your own read returns an error. Its text says Brightspace refused the read. It says the feedback has not been released yet, or that this course does not expose it through the API. It asks you to check the assignment in Brightspace.
- A 404 on your own read returns `feedback: null`. The note says the submission has not been graded yet, or its feedback has not been released.
- Reading another user's or a group's feedback is staff-only. A 403 there returns the instructor and TA error. A 404 returns `feedback: null` with the note "No feedback found. This submission has not been graded yet."
- Read-only. No tool in this server posts a grade or feedback back to Brightspace.

### download_dropbox_submission_file

- Code: `src/tools/download-dropbox-submission-file.ts`.
- Arguments:
  - `courseId` (required).
  - `folderId` (required).
  - `submissionId` (required). From `get_dropbox_submissions` or `get_dropbox_user_submissions`.
  - `fileId` (required). A file ID within that submission.
  - `downloadPath` (required). An absolute path to an existing directory. See [Writing to disk](#writing-to-disk).
  - `customFilename` (optional, max 255 characters). The default is the original submission filename.
- Always saves to disk.
- It streams through `secureStreamDownload` (`src/utils/download-helpers.ts`).
- The 2GB cap is `DISK_MAX_FILE_SIZE` (`src/utils/file-validator.ts`). The cap is checked against three values: the listed size, the `Content-Length`, and the bytes actually received.
- Staff-only.

## Account and sign-in

### sign_in

- Code: `src/tools/sign-in.ts`.
- Argument: `visible` (boolean, optional). Opens a browser window so the user can sign in by hand.
- Behaviour, by case:
  - If the saved session is still valid, the call does nothing.
  - If no password is saved, a visible browser window opens. A headless run has nothing to type, so it would only time out.
  - Otherwise, a background sign-in runs. The response reports the MFA number that the user must approve.
- When to pass `visible`:
  - Omit it. A window then opens by itself only when no password is saved on this computer.
  - Pass `true` only when the user asks for a window, or when an error says a step needs the user's own hands (an unsupported sign-in, or no saved password).
  - Do not pass `true` after a "could not be reached", stuck or timeout failure. Call `sign_in` again. The saved password is typed in the background, and a window adds nothing.
  - Pass `false` to insist on a background sign-in.
- Every answer says whether to call again. A cooldown, a held prompt and an unapproved number all need waiting rather than a retry.
- For how the sign-in works, see [sign-in.md](../internals/sign-in.md). For the user's guide, see [sign-in.md](../sign-in.md).

### sign_out

- Code: `src/tools/sign-out.ts`.
- No arguments. The result is plain text.
- Cancels a sign-in that is still waiting for MFA approval on this computer.
  - This does not get a new prompt sooner. Microsoft sends the account no other until the one already sent expires, up to 5 minutes after it was sent.
- Deletes this computer's saved Brightspace session for the configured account. This is the in-chat `auth --logout`.
- Clears this server's response cache and the in-memory token.
- Call it only when the user explicitly asks to sign out or log out of Brightspace.
  - Never call it on its own to fix an error, to get a new prompt, or as part of another answer.
- Annotated `destructiveHint: true` and `readOnlyHint: false`, so clients ask first.

### get_server_info

- Code: `src/tools/get-server-info.ts`.
- No arguments.
- Makes no network call and returns no secrets.
- Fields:
  - The running version, the Node runtime, and the platform.
  - The config and session paths, the configured school URL, and whether a credential is stored.
  - `localTimezone` and `utcOffsetMinutes`, from the server's local timezone.
  - `signedInAs` (`uniqueName` and `displayName`), once known.
  - `microsoftSession`, once a browser sign-in has been saved. It says what Microsoft remembered. It is omitted when there is no saved state.
  - `requests`, the API client counters described below.
- `requests` is `D2LApiClient.stats()`:
  - `statusClasses`: counts for `2xx`, `401`, `403`, `404`, `429` and `5xx`. `other` counts anything outside that list.
  - `networkErrors`.
  - `cacheHits` and `cacheMisses`.
  - `coalescedJoins`.
  - `tokenRefreshes`.
- The counters are a snapshot of this process only. They reset on restart. The field is additive to the existing fields. It never carries a URL, username or token.
- `coalescedJoins` comes from request coalescing in `D2LApiClient.get()`. A GET that is already in flight for the same unresolved path is joined, instead of sending a second fetch. This matters because Claude Desktop fans out tool calls in parallel, and the tools fan out per course.
- A TTL'd call that joins an in-flight request for the same path counts as both a cache miss and a coalesced join. The two counters overlap. They do not split the calls between them.

## Shared behaviour

### dueIn

- Applies to: `get_assignments`, `get_upcoming_due_dates`.
- Every `dueDate` or `DueDate` field in these tools has an additive `dueIn` string next to it.
- `dueIn` is a relative text, such as "in 3 days", "yesterday" or "in 2 hours". It is computed with `Intl.RelativeTimeFormat` (`src/utils/due-in.ts`). A caller never has to do date arithmetic on the raw ISO timestamp.
- `dueIn` is `null` where the due date is `null` (for example, a `gradeOnly` row), or where the date cannot be parsed.
- The `dueDate` and `DueDate` values are never changed.

### Background sign-in

- Applies to: `get_assignments`, `get_my_grades`, `get_upcoming_due_dates`, `get_calendar_events`, `get_announcements`, `get_roster`, and `get_available_groups`.
- While a sign-in is still in progress in the background, these tools report it. They do not return an empty or partial result that looks like a real measurement.
- The tools never change a response's documented shape to report it.
- Tools that already answer with an object (`get_my_grades`, `get_roster`, and `get_announcements` with `modifiedSince`) add these fields to the JSON:
  - `authPending: true`.
  - A `notice` string.
  - For tools that combine courses, `unavailableCourseIds`.
- Tools that normally answer with a bare array (`get_upcoming_due_dates`, `get_calendar_events`, and `get_announcements` without `modifiedSince`) keep returning the same array. It holds the courses that did answer, as `content[0]`.
  - The notice names the unavailable course ids. It is added as a second text block in `content[1]`. The shape of `content[0]` does not change.
- `get_roster`'s non-`includeStudents` view keeps whichever instructor or TA route did answer. It does not discard that route just because the other is still pending.
- `get_available_groups` sets `authPending: true` and `unavailableCourseIds` when a course is pending.

### lastModified and modifiedSince

- Applies to: `get_course_content`, `get_announcements`.
- Topics and modules in `get_course_content`, and items in `get_announcements`, carry a `lastModified` field. It is D2L's `LastModifiedDate`, or `null` when the tenant did not send one.
- Both tools accept an optional `modifiedSince`. It is an ISO 8601 datetime, for example `2026-01-15T00:00:00Z`. Only items at or after that timestamp are returned. This is useful for "what is new since I last checked".
- A malformed value is a validation error that names the expected format. It is never a silently empty result.
- An item with no `lastModified` is always included, not excluded. Dropping it silently would look the same as data loss. The server treats a null due date the same way everywhere else.
- Passing `modifiedSince` adds `modifiedSince`, `returned` and `filteredOut` to the response. A caller can then tell "nothing changed" apart from "the filter was wrong".
- Omitting `modifiedSince` leaves the response shape unchanged. For `get_announcements`, that means a bare array.

### Links into Brightspace

- Applies to: `get_assignments`, `get_upcoming_due_dates`, and `get_assignment_files`.
- Assignments, quizzes and due dates each carry a `url` field that links into Brightspace.
- For group assignment folders, `get_assignments`, `get_assignment_files` (both discovery and file reading), and `get_upcoming_due_dates` resolve the learner's group. They look within the folder's `GroupTypeId` category. They use the same cached membership helper as `get_my_groups`.
- Individual folders (missing or null `GroupTypeId`) use `grpid=0`. Group folders use their actual group identifier. See [D2L's folder reference](https://docs.valence.desire2learn.com/res/dropbox.html#Dropbox.DropboxFolder).
- If membership is missing, inaccessible or ambiguous, or the group category metadata is invalid, the tool returns the course home. That result has `urlKind: "course-home"` and a `urlNote` that directs the learner to Assignments.
- A resolved folder has `urlKind: "assignment"`.

### Feedback fields

- Applies to: `get_assignments`, `get_my_grades`.
- On assignment rows, `feedbackStatus` is one of:
  - `retrieved`: the API returned a feedback record.
  - `restricted`: the read returned 403.
  - `unavailable`: the read returned 404 or a null response.
  - `error`: another read failed.
- Grade rows carry `gradeObjectId`, `feedbackStatus` and `feedbackUrl`.
  - `feedbackStatus` is `retrieved` when public comments were returned. Otherwise it is `unavailable`.
  - `feedbackUrl` is the quiz's `feedbackUrl` when the row is linked to a quiz. Otherwise it is the gradebook URL.
- Assignment rows carry `feedbackCommentsStatus`. It is `retrieved` when overall or rubric comments were returned, and `unavailable` otherwise. A score-only record never implies that comments were retrieved.
- Both tools add `feedbackStatusNote` when comments were not returned.
- Assignments also carry a course gradebook `feedbackUrl`.
- The feedback URLs point to a place where published feedback can be checked. They are not per-evaluation links.
- A null comment, a missing feedback record, or a permission failure does not prove that published feedback is absent in Brightspace.
- These tools do not scrape HTML pages. They do not open a restricted quiz viewer.

### Instructor and TA access

- Applies to: `get_dropbox_submissions`, `get_dropbox_user_submissions`, `get_dropbox_feedback` (when given another user's or a group's id), and `download_dropbox_submission_file`.
- These tools read every student's submissions and feedback for a course. Brightspace grants that only to course staff.
- A student who calls one of them gets the note "Instructor or TA access required for this course" with a 403, rather than a generic or broken-looking error.
- `get_dropbox_folders` and `get_rubrics_for_object` read the same folder listing that a student's own client reads. They are not gated up front.
  - A 403 from that list is a `permission` error, but it does not say "Instructor or TA access required". It says Brightspace refused to list the course's assignment folders. It names the likely causes (not enrolled in that course, or Assignments hidden from the student's role) and points to `get_my_courses` (`src/tools/get-dropbox-folders.ts`, `src/tools/get-rubrics-for-object.ts`).
    - **Why:** students can read this list, so the staff-only message sent them the wrong way (#437).
- A 404 (no folders, no submissions, folder not found) returns an empty list or null with an explanatory `note`. It is not a failure.
- All dropbox tools are read-only. No tool in this server posts a grade or feedback back to Brightspace.

### Writing to disk

- Applies to: `download_file` (disk mode), `download_course_files`, `download_dropbox_submission_file`, `get_syllabus` (when `downloadPath` is given).
- `downloadPath` must be an absolute path to a directory that already exists. The server does not create it. Create the folder first if needed.
- Every tool that writes to disk applies the destination rules. The rules, the manifest, name cleaning and the implementation are in [downloads.md](../internals/downloads.md).

### Update notice

- Applies to: every tool.
- An available-update notice, when there is one, rides along as a second text block on the first successful result.

## Prompts

The server registers these prompts in `src/prompts/index.ts`. Each prompt has its own file in `src/prompts/`, with the same shape as the files in `src/tools/`.

Clients that show server prompts in a picker (for example Claude Desktop) show these as one-click starting points. Each prompt renders one user message. The message names the tools above by their real names.

| Prompt | Arguments | What it does |
|--------|-----------|--------------|
| `weekly_briefing` | none | 7-day briefing of due dates, new announcements, and grade changes across all courses |
| `grade_audit` | `courseId` (optional) | Analyzes grades for one course, or all of them, flagging missing or low items |
| `study_planner` | `daysAhead` (optional, default 7) | Plans study time from upcoming due dates and calendar events |
| `course_summary` | `courseId` (required) | Syllabus, content outline, assignments, and grades for one course |

Registration and files:

- `src/prompts/index.ts` registers the prompts.
- `src/prompts/weekly-briefing.ts`, `src/prompts/grade-audit.ts`, `src/prompts/study-planner.ts` and `src/prompts/course-summary.ts` each define one prompt.
