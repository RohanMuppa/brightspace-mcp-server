# Downloads and course sync internals

This file explains how file downloads and the whole-course sync work inside the server, and why each rule exists. The code writes files that a remote course chose onto the student's disk, so most rules here are security rules. Read a rule and its reason before you change the code that enforces it.

The arguments that callers pass are in [the tool reference](../reference/tools.md). The student-facing description is the "Download a whole course" section of the [README](../../README.md). Paths below are relative to `src/` unless they start with `docs/`.

## Where a download may be saved

Every write to disk goes through `sensitiveDestination` in `src/utils/sensitive-paths.ts`. The policy is a refuse list. Any folder is allowed except the places listed under Refused.

**Refused:**

These refusals were added in 5.2.0. Earlier versions accepted these destinations.

- Device paths, `\\?\` and `\\.\`. They skip Windows' own name handling.
- A filesystem or drive root.
- The home directory itself. Folders inside it are allowed.
- Any path with a component that starts with `.`, anywhere in the path. Examples: `~/.ssh`, `~/.config`, `project/.git/hooks`.
  **Why:** settings and credentials live in hidden folders. The check runs on the real path, so a link into a hidden folder is refused too.
- On macOS, `~/Library`, except `~/Library/CloudStorage/**` and `~/Library/Mobile Documents/**`.
  **Why:** applications keep their data in `~/Library`.
- System folders: `/etc`, `/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/Applications`, `/boot`, `/dev`, `/proc`, `/sys`, `/private/etc`, and `/lib`, `/lib32`, `/lib64`, `/libx32`.
- `/var`, except its temporary folders `/var/folders` and `/var/tmp`, and their `/private/var` forms.
- `/root`, unless the home directory is inside it. Any other user is refused `/root`.
- On Windows, the first folder below a drive: `Windows`, `Program Files`, `Program Files (x86)`, `ProgramData`, `System Volume Information`, `$Recycle.Bin`.
- On Windows, any `AppData` folder in the path, except `AppData\Local\Temp`.
- Under WSL, `/mnt/<letter>/` followed by any of the Windows folders above, and any `AppData` folder below the drive, except `AppData\Local\Temp`.
  **Why:** the destination is chosen through an AI client, and the names inside it come from a course. A destination that is the home folder, a hidden folder, an application-data folder or a system folder would let a course plant files where they do real harm.

**Allowed:**

Everything not refused. The code's comments name `/tmp`, `/private/tmp`, `/var/folders`, `/srv`, `/data`, `/workspace` and `/workspaces`, `/opt`, `/mnt`, `/media`, `/run/media`, `/Volumes`, cloud-sync folders and external drives.

**D2L_DOWNLOAD_ROOTS:**

- It is read from the server's own environment. A tool argument cannot set it. See the [settings reference](../reference/settings.md).
  **Why:** the person who runs the server decides what is allowed.
- It is a list separated by `path.delimiter`: `:` on macOS and Linux, `;` on Windows. Each entry is resolved to its real path.
- A destination inside an entry is allowed, even where a refusal above would apply. That includes hidden folders and `~/Library`.
- It cannot allow a device path, a drive root or the home directory itself.
- These entries are ignored, and a `[config]` warning is logged once per entry: a relative path, a device path, a drive root, the home directory, a folder that contains the home directory, and a path that cannot be resolved.

**How the path is judged:**

- The rule is judged on the native real path. Windows 8.3 short names are expanded. A symbolic link into a refused place is refused.
  **Why:** the rule judges where a write would land, not the name that was typed.
- A part of the path that does not exist yet is kept as written.
- A dangling symbolic link is followed to where it points.
- A link loop is refused with the reason "it involves a symbolic-link loop". A loop is an `ELOOP` error, or more than 40 nested link resolutions.
- While resolving, `ENOENT`, `EACCES`, `EPERM` and `ENOTDIR` are not errors. The nearest part that resolves is used, with the rest of the path as written. Any other error is thrown. It is not turned into a refusal.

**Error kind:**

- `download_file`, `get_syllabus` and `download_dropbox_submission_file` check first. They answer with error kind `destination`. The text comes from `sensitiveDestinationMessage`, which names the rule and suggests `~/Documents/Brightspace` or `D2L_DOWNLOAD_ROOTS`.
- `download_course_files` and `sync` throw `SyncInputError` with the same text. The tool answers with kind `invalidInput`. The CLI exits 2.
- The writers check again. A refusal there is `DownloadError` kind `forbiddenDestination`. Its message does not name the rule.

**Where it is enforced:**

- `assertAllowedDestination` in `src/utils/download-helpers.ts` runs first in `secureDownload` and in `secureStreamDownload`.
  **Why:** every write to disk starts there, so the rule is enforced once for all tools.
- Tools that write through these helpers: `download_file`, `download_dropbox_submission_file` and `download_course_files`. The `sync` command also writes through them. `get_syllabus` uses `secureDownload`. The others use `secureStreamDownload`.
- The sync checks the destination before it takes the lock or creates any folder.

## One file: download_file

`download_file` is in `src/tools/download-file.ts`. It has two response modes. The mode follows `downloadPath`. Inline mode is the default.

### Disk mode (`downloadPath` given)

- The tool checks first. The path must be absolute, must exist and must be a directory. It is not created. Then the destination rules above run.
- Listed sizes are checked before any fetch for submission, attachment and announcement files. A size over the cap is refused with `tooLarge`.
- A Content-Length over 2 GB is refused before the body is read.
- The body streams into a hidden temporary file, `.download-<uuid>.part`, in the target folder. It is type-checked there. Then it is published under its final name.
- Publishing:
  - A replacement, which only the sync makes (`replaceExisting`), uses `rename`.
  - Otherwise the file gets its name with `link`. `link` fails if the name exists, so nothing is overwritten.
  - Filesystems without hard links (FAT, exFAT, some network shares) use `copyFile` with `COPYFILE_EXCL`.
  - If the name is taken, the next free name is used, with up to 100 attempts. The form is `name(1).ext`, with no space.
  **Why:** `rename` overwrites. Two downloads could pick the same free name. The later rename would then silently replace the earlier file.
- The temporary file is removed in a `finally`. A refused or failed download leaves nothing behind.
- A killed process can leave its `.part` file. Only a later course sync removes it. See the sync section.
- The cap is 2 GB (`DISK_MAX_FILE_SIZE`). The stream fails with `tooLarge` once the body passes it.
- **Short body (`incomplete`):**
  - When a Content-Length is known and fewer bytes arrive, the download fails with `incomplete`. Nothing is published.
  - A connection cut that `fetch` reports only as "terminated" is also `incomplete`, when the body is short.
  - The check is skipped when there is no Content-Length. It is also skipped when Content-Encoding is anything other than `identity`. `fetch` decodes the body, but the header counts the encoded bytes.
  **Why:** a dropped connection must not publish a truncated file that a later sync would take for the whole one.
- **Empty file:** a body of 0 bytes fails with kind `empty`, "File is empty (0 bytes)". A response with no body at all fails with kind `undetectableType` instead.
- **Recording:** after a content topic (`topicId`) is published, its absolute path and size go in the saved-topic ledger. The answer waits for the ledger for at most 500 ms (`RECORD_WAIT_MS`); if another process holds the lock, the answer goes out and the record lands when the lock is free. See [What is already saved](#what-is-already-saved). Other targets record nothing.

### Inline mode (`downloadPath` omitted)

- The body is read into memory, up to 50 MB (`MAX_FILE_SIZE`). Content-Length is checked first.
- A file over 10 MB (`INLINE_MAX_SIZE`) is refused with error kind `rejectedFile`. The message says to give an absolute `downloadPath`.
  **Why:** base64 encoding adds about 33% overhead, so the cap keeps the response well under typical MCP response-size limits.
- The file type is checked against the same allowlist as disk mode.
- The response is a text block of JSON metadata, followed by content. The metadata has `mode: "inline"`, `filename`, `originalFilename`, `mimeType`, `size` and `representation`.
  - PDF: text extracted by `pdf-extractor.ts`. With no text layer, `representation` is `pdf_text_extraction_failed`, and the note asks for `downloadPath`.
  - `.docx`, `.xlsx` and `.pptx`: text read by `zip-extract.ts` (`officeDocumentText`). With no text, `representation` is `office_text_extraction_failed`.
  - `image/jpeg`, `image/png`, `image/gif` and `image/webp`: an `ImageContent` block, with `representation: "image"`. An image over 3.5 MB (`INLINE_IMAGE_MAX_SIZE`) is not sent as an image. It gets `binary_description_only`.
  - `text/plain`, `text/csv`, `text/html` and `application/json`: the text, decoded as UTF-8, with `representation: "text"`.
  - Anything else, such as zip, legacy Office, SVG, video or audio: `binary_description_only`, with a note to use disk mode.
- Extracted or plain text is capped at 400,000 characters (`INLINE_TEXT_MAX_CHARS`). Cut text ends with a note that names `downloadPath`.
- The code never emits an MCP `EmbeddedResource`.
  **Why:** some clients send an embedded `application/pdf` into a document pipeline that rejects PDFs with JBIG2-compressed images. That can fail the whole tool response.
- **Why** for the image cap: base64 would push a large image past the model API's per-image limit, and that fails the whole response.

### Other single-file writers

- `download_dropbox_submission_file` always saves to disk. It uses `secureStreamDownload` and the 2 GB `DISK_MAX_FILE_SIZE` cap. It checks the listed size, the Content-Length, and the bytes actually received.
- `download_file` with `folderId` and `fileId` reads `/dropbox/folders/{folderId}/submissions/mysubmissions/` and finds the file in any submission. Some schools answer with EntityDropbox entries (`{ Entity, Status, Feedback, Submissions: [{ Id, Files }] }`) instead of a flat list.
  - `flattenDropboxSubmissions` (`src/utils/dropbox-submissions.ts`) unwraps both. The download URL uses the id of the inner submission that owns the file.
  - `get_assignments` and the three instructor submission tools use the same helper.

**Why:** reported 2026-11-19 from a live course. `get_assignments` listed a submission file but `download_file` answered "not found" with an empty list for all 7 submissions, because it read `Files` off the outer entry.

### Names in single-file downloads

- `validateDownloadPath` decodes the name once, then sanitises it. A bare `%` makes the decode fail, and the raw name is used. A path that leaves the folder is refused with `pathTraversal`.
- A name from a `filename*=` Content-Disposition header is already decoded by `parseContentDispositionFilename`. It is then decoded again by `validateDownloadPath`.

### File-type allowlist

The check reads magic bytes with `file-type`. It does not trust the extension. It runs in both modes: `validateFileType` in memory, and `validateFileTypeOfFile` on disk. The list is `ALLOWED_MIME_TYPES` in `src/utils/file-validator.ts`.

- Documents: `application/pdf`; `.docx`, `.pptx` and `.xlsx`; and the legacy `application/msword`, `application/vnd.ms-powerpoint` and `application/vnd.ms-excel`.
- Images: `image/png`, `image/jpeg`, `image/gif`, `image/webp` and `image/svg+xml`.
- Text: `text/plain`, `text/csv` and `text/html`.
- Data: `application/json`.
- Archives: `application/zip`, `application/x-zip-compressed`, `application/x-7z-compressed`, `application/gzip`, `application/x-gzip`, `application/x-tar` and `application/x-bzip2`.
  - The non-zip archives mean that starter-code and resource archives download instead of being refused outright.
  - `application/x-gzip` is a legacy alias. It sits beside `application/gzip` the way `application/x-zip-compressed` sits beside `application/zip`.
- Media: `video/mp4`, `audio/mpeg` and `audio/wav`.
- **Why:** the allowlist "prevents execution of potentially malicious file types (executables, scripts)."

Special cases:

- **OLE2 (CFB) files.** `file-type` reports every OLE2 container as `application/x-cfb`. That covers `.doc`, `.xls`, `.ppt` and `.msi`. The declared extension decides:
  - `.doc` and `.dot` are `application/msword`.
  - `.xls` and `.xlt` are `application/vnd.ms-excel`.
  - `.ppt`, `.pot` and `.pps` are `application/vnd.ms-powerpoint`.
  - Any other CFB file is refused with `unsupportedType`.
  **Why:** allowing `application/x-cfb` outright would let a `.msi` installer through under a `.doc` name.
- **SVG.** `file-type` has no SVG detector. An SVG with an XML prolog is reported as `application/xml`. A `.svg` name admits it as `image/svg+xml`. Any other XML is refused.
  **Why:** without this, every ordinary `.svg` download failed.
- **No magic bytes.** A file is text if it decodes as UTF-8 and has no NUL byte.
  - HTML starts with `<!doctype html` or `<html`.
  - SVG without a prolog starts with `<svg` or `<!doctype svg`.
  - Anything else is refused with `undetectableType`.
  - On disk, the file is streamed through the same checks. Only the first 64 characters are kept for the sniff.
- **Empty bodies.** The in-memory and on-disk checks refuse a 0-byte body with `undetectableType`. The stream path reports 0 bytes as `empty` first.
  **Why:** the UTF-8 fallback would otherwise accept an empty body as `text/plain` and write a zero-byte file.
- **Legacy names.** A legacy Office file saved under the wrong extension gets its real extension. For example, a `.xls` requested as `Grades.xlsx` is saved as `Grades.xls`. The response then carries a note.

The error kinds are a closed set in `src/utils/download-errors.ts`: `unsupportedType`, `undetectableType`, `badFilename`, `pathTraversal`, `tooLarge`, `incomplete`, `forbiddenDestination` and `empty`.

## A whole course: download_course_files and sync

The tool is `src/tools/download-course-files.ts`. The `sync` command is in `src/sync/sync-cli.ts`, and its flags are in the [CLI reference](../reference/cli.md). Both call `syncCourse` in `src/sync/course-sync.ts`. A rerun is a sync: files that are already there are skipped by default.

### Building the plan

- The sync reads `/content/toc` once per run, fresh.
  **Why:** "a cached copy would hide what the instructor added since the last run."
- Each module becomes a folder, named after its title, or `Module <id>` when it has none. Each File topic becomes a file in the folder of its module.
- Within one folder, module folders are named first, and files after.
  **Why:** "a file can never claim a module's name."
- A table of contents is cut off at 32 levels, and at 50,000 modules and topics. Modules at depth 32 are not read. When this happens, the answer says the table was truncated.
- `moduleId` limits the plan to that module and the modules inside it. That module becomes the top folder. An unknown module is an input error: `invalidInput` in the tool, exit 2 in the CLI.
- Only File topics are downloaded. Other topics are counted, not failed:
  - `broken`: `IsBroken` is true, a File topic has no Url, or the topic has no usable id.
  - `media`: `TypeIdentifier` is `ContentService`. This is embedded media, which `download_file` cannot fetch.
  - `link`: `TypeIdentifier` is `link`, or `TopicType` is 2 or 3.
  - `other`: anything else, such as quizzes and discussions.
  - A File topic has `TypeIdentifier` `file` or `TopicType` 1, with a non-empty Url.
- `unavailable`: a File topic that is locked, hidden, not yet open or ended. This is found when the file request answers 403 or 404 and the topic's metadata explains why (`checkTopicAvailability`). A 403 or 404 that is not explained is a failure.

### Names

Names are in `src/sync/names.ts`.

- The base name comes from the upload name in the topic's Url. The query and fragment are removed.
- A percent-encoded name is decoded once. Any `%XX` that is still left becomes `_`.
  **Why:** "a valid %XX escape left in a name would be decoded a second time by anything that decodes names, so none is left."
- If there is no usable base name, the topic title is used with the Url's extension.
- `sanitizeComponent` makes one safe path component:
  - Invisible and format characters are removed. These are bidi controls, zero-width and joiner characters, tags, variation selectors and invisible fillers.
  - `< > : " / \ | ? *`, control characters, noncharacters, private-use and unassigned code points become `_`.
  - A lone surrogate becomes U+FFFD.
  - Leading combining marks and whitespace are removed. Trailing dots and spaces are removed.
  - The result is NFC normalised.
  - A leading dot becomes `_` followed by the rest of the name.
    **Why:** "a course can never create a dot-folder or dot-file ('.ssh', '.zshrc') in the destination."
  - Windows device names are prefixed with `_`. These are `CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `COM0` to `COM9` and `LPT0` to `LPT9`, including the superscript-digit forms. The test uses the part before the first dot.
    **Why:** Windows reserves the part before the first dot, so `NUL.tar.gz` is as bad as `NUL`.
  - An empty name, `.` or `..` becomes the fallback: `File <id>` or `Module <id>`.
- Length: at most 150 characters (`MAX_NAME_CHARS`) and at most 240 bytes (`MAX_NAME_BYTES`). The extension is kept if it is 20 characters or fewer.
  **Why:** a filesystem caps a name at 255 bytes. The 240-byte limit leaves room for ` (99)` and the downloader's own checks.
- On Windows, the full path must fit in 250 characters (`WINDOWS_PATH_BUDGET`). Names are shortened in up to six rounds, to at least 16 characters. A file that is still too long fails with "The path is too long (over 250 characters)". Elsewhere there is no limit, unless `pathBudget` is set.
  **Why:** the classic Windows path limit is 260.
  - Each module and topic keeps its own name cap. Only the folders and file on a path that is over the budget are shortened. A path that fits keeps its full names, however long another path in the course is. A folder shared by several files is shortened once, for all of them.
  - Each round's new cap is scaled from the longest name on the over-long path, and is always below that name. So a path only a few characters over still gets shorter every round.
  **Why:** one cap for the whole course let a single deep path cut every name in the course to about 30 characters (#453). The scaling was taken from the 150-character cap instead of the real names, so a path a little over the budget never got shorter and failed. Do not bring back a course-wide cap.

**Duplicates:**

- Names are compared the way the filesystem compares them. The key is `foldKey` (`src/sync/names.ts`): NFC, then a full case fold. So `ß` and `SS`, `ς` and `σ`, `ſ` and `s`, and `ﬁ` and `fi` are the same name.
- A repeat becomes `name (2).ext`, then `name (3).ext`, and so on. Numbering resumes where the last repeat of the same name stopped, so n repeats take n steps.
- The sync puts a space before the number. Single-file downloads do not (`name(1).ext`).
  **Why:** "Notes.pdf" and "notes.pdf" cannot overwrite each other on macOS or Windows.

### Folders and links

- Each folder on the way down is checked one at a time with `lstat`.
  - A symbolic link is refused, not followed.
  - A file in the way is refused.
  - A missing folder is created one level at a time. This happens in real runs only.
  **Why:** "a link planted in the destination cannot send a download somewhere else."
- The destination itself is resolved to its real path first. The folders below it are then checked as above.
- A folder name that contains `/`, `\` or a NUL byte is refused.
- If the filesystem reports the path as too long (`ENAMETOOLONG`), the file fails.

### The manifest

The manifest is `.brightspace-sync.json` in the destination root. It is written with mode `0600`, atomically.

- Shape: `version: 1`, then `courses`, then the course id, then the topic id. An optional `extras` key holds the assignment and announcement files (see [Beyond Content](#beyond-content-assignments-and-announcements)). Each entry has `path`, `bytes`, `size` and `mtimeMs`. `path` is relative to the destination, with `/` separators.
- `size` and `mtimeMs` are recorded from the file as the sync left it.
- The manifest is written every 25 files or every 2 seconds. It is also written at the end of every run, however the run ends.
- It is read at the start. A missing manifest is empty. A manifest that cannot be read is treated as empty, with a warning.
- An entry is dropped if its path is absolute, has `\` or a NUL byte, has an empty, `.` or `..` part, or is over 4096 characters.
- A file is found again by its topic id, not its name.
  **Why:** "a file's name is not a reliable key." The name on disk can differ from the planned name, because an extension is corrected from the real type. One new topic can also shift the `(n)` numbering.
- A file is unchanged only when its size matches the entry and its mtime matches within 1 ms. An entry with no recorded size or mtime never matches.

### Existing files: `existing`

The modes are `skip`, `replace` and `keep_both`. The CLI flag is `--existing`.

- `skip` (default): a file already on disk is skipped. Nothing is overwritten.
- `replace`: only a file that the manifest records for this topic, and that is still unchanged, can be overwritten.
  - Only that exact name is replaced. If the saved name must change, the new file is written beside the old one.
  - A file that is not in the manifest, an edited file, and an entry without recorded state are all skipped.
  - The check runs again just before the rename.
  **Why:** "only files this sync wrote are ever replaced." An edited file differs in size or mtime, so annotations are never overwritten.
  **Why** for the second check: "minutes can pass between planning and the rename: an edit made meanwhile turns the replace into a copy beside the file."
- `keep_both`: the new copy is saved as `name (1).ext`, the lowest free number, beside the existing file.
  - If a copy with the same size already exists, the new copy is skipped as a duplicate.
  - When the size is not known before the download, the copy is deleted after it arrives, if a same-size copy exists.
- A file at the planned name that the manifest assigns to another topic is not used. The new file takes the next free `name (n).ext`, starting at 2.
- A file at the planned name that no manifest entry claims is the user's file. It counts as present.

### Lock

- A real run takes `.brightspace-sync.lock` in the destination root before any other work. A dry run takes no lock.
- The lock holds `pid`, `startedAt` and a random token. Release removes the file only if the token still matches.
- A second sync into the same folder fails with "Another sync into this folder is already running (process N)." That is `invalidInput` in the tool and exit 2 in the CLI.
- A lock is stale when its process is gone, when it is older than 1 hour, when it cannot be read, when it has no start time, or when its start time is in the future.
- Only one process may remove a stale lock. It does so through a guard file, `.brightspace-sync.lock.takeover`, which is created exclusively. A guard older than 30 seconds is treated as stale. The lock is read again before it is removed. There are up to 60 attempts.
  **Why:** "two running together would plan the same names and race each other's writes and manifest."

### Partial files

- A real run starts by removing `.download-<uuid>.part` files left by a killed run. Only regular files with that exact name, and older than 1 hour by mtime, are removed.
- Nothing is followed through a symbolic link. Hidden folders are not walked. The walk stops at 64 levels or 50,000 entries.
- Each run that removes any file logs a line at INFO.

### Limits, deadlines and cancel

- `maxFiles`: the number of files attempted in this run. Files already on disk do not count. Files past the cap are reported as not attempted.
- `maxTotalMB`: the bytes saved in this run.
  - A file whose Content-Length is larger than the bytes left is not started. It is not attempted, and the run stops.
  - With no Content-Length, the stream itself stops at the bytes left.
- `maxMinutes`: a wall-clock deadline for the call. When it passes, the run stops cleanly and the rest are not attempted. The tool has this limit. The CLI has no time limit.
- A client cancel reaches the sync through the stdio relay. The relay aborts the request's POST when the client sends `notifications/cancelled`. The runtime then ends the tool's signal. The run stops cleanly, and the files saved are kept.
- The CLI stops cleanly on SIGINT or SIGTERM, with exit 130. A second signal exits at once.
- The signal reaches the TOC read and every file request. It also ends a backoff wait at once, so a hung request does not hold the run.
- Progress: when the client sends a progress token, each handled file sends a `notifications/progress`. `progress` is the files handled so far, and `total` is the files in the plan. The message is the event type and the quoted path.
- With `--json`, the CLI prints only the result object on stdout. Progress and the summary go to stderr.

### Retries

- The API client already retries 429, 5xx and network errors. It honours `Retry-After` (`src/api/retry.ts`). The sync does not repeat those, because that "would multiply the attempts."
- The sync retries only these. It pauses 1.5 seconds, then 4 seconds, and makes at most 3 requests per file.
  - `incomplete`: the body ended early.
  - HTTP status 408 or 425.
  - A stream that is cut or stalls: the message is `terminated`, the error is a `TimeoutError`, or the code starts with `ECONN`, `ETIMEDOUT`, `EPIPE` or `UND_ERR`.
- Sign-in errors, network errors from the client, and every other error are not retried.

### Failure messages

Each failed file gets one short reason, from `describeFailure`:

- 429: Brightspace is rate limiting requests.
- Other API errors: "Brightspace answered N". A 403 adds "(access denied)", and a 404 adds "(file not found)".
- A network error: "Could not connect to Brightspace".
- A name or path the filesystem refuses: the path is too long, or the file system does not accept the name.
- A dropped connection: "The connection to Brightspace dropped".
- Anything else: "Unexpected error". The raw error is logged as a warning.

Nothing from a response body or header is echoed into the message.

### A lost sign-in

- A sign-in failure stops the run. This covers a 401, and an auth process or token refresh failure.
- The sign-in guidance goes in `authError`. The file in progress, and every file after it, count as not attempted. Files already saved are kept.
- If the table of contents itself cannot be read because of the sign-in, nothing is attempted.
- The tool answer is an error. The CLI exits 1.

### Counts in the answer

The answer is text. Its first line reads "Course N saved to D: X downloaded, Y already on disk, Z failed, W not attempted."

- Not-file counts are listed separately: web links, embedded video and media, broken items, other non-file items, empty files, and files that are locked or not yet released. The answer says these Content items are not files, so they are not missing from the Content sync.
- The answer always ends with a scope line (`CONTENT_ONLY_SCOPE` in `src/sync/summary.ts`): the sync covers the Content area only, and it names the tool for each thing it skipped (`NOT_COVERED`). `download_course_files`, `get_unsaved_course_files` and the `sync` command all carry it; `get_unsaved_course_files` also returns `NOT_COVERED` as `notCovered`.
  **Why:** reported 2026-11-19 from a live course (PR #467). An agent asked to "pull everything" read "These are not missing from the sync" as "the course is saved" and never downloaded the student's own submissions, which this tool does not look at.
- A 0-byte file is counted as empty. This happens when the response has no body or a Content-Length of 0, and also when the body turns out to be 0 bytes. Empty files are not written, and they are not failures.
- Names in the answer are JSON-quoted. The answer says once that they come from the course. Each list shows at most 20 names.
- The tool is not annotated read-only, because it writes files.

### Beyond Content: assignments and announcements

Added in 5.2.21. The options are in the [tool reference](../reference/tools.md#download_course_files). The `sync` command has no flag for them.

- The phases run inside the same `runSync` call as the Content loop, after it, in `src/sync/submissions-sync.ts` and `src/sync/announcements-sync.ts`.
- Every file goes through one `saveOne` closure in `course-sync.ts`, which the Content loop also uses. It owns the checks: existing file, ownership, the path budget, the file and byte caps, dry run, duplicate, empty, retries and the sign-in stop. `downloadOne` takes an `open` function, so a topic, a submission file and an attachment share what happens after the request.
  **Why:** a second set of caps and checks would drift from the first. One `maxFiles` and one byte budget cover the whole call.
- A phase checks `stopped()` before its first request and before each folder. If the run had stopped, or the file cap was reached, it returns `notRun` and reads nothing. If a stop lands on its list request, it is `notRun` too. A folder it was inside when a stop hit is `foldersPartlySaved` and gets no `feedback.md`.
  **Why:** a phase that reads nothing must not come back as "0 assignments read", which is what "there are none" looks like (review of #470).
- `feedback.md` goes through `saveText`. It is not a download, so it does not use the file cap, but it respects stop and cancel.
- A file listed but not saved is described by what it was in `feedback.md`: could not be saved, empty on Brightspace (0 bytes), or not saved yet because the run stopped.
- The student's submissions and feedback are read by `readMySubmissions` and `readMyFeedback` in `src/utils/dropbox-submissions.ts`, which `get_assignments` also calls, so both read the same routes the same way. A 404 on `mysubmissions` is a known "nothing submitted". Any other failure is not known.
  **Why:** a refused read used to look like an empty one (#447). The sync records it as `unknown` and writes "unknown (reason)" in `feedback.md`.
- `readMyFeedback` also says when its fallback routes failed (`fallbackUnknown`): the user lookup or `feedback/user/{me}` answering anything but a 404 with no feedback found. `get_assignments` ignores the field, so its output is unchanged. The sync treats it as feedback unknown.
  **Why:** otherwise a 403 or 500 on the fallback read "not graded yet" into `feedback.md` as a fact.
- A group folder's student feedback route is not tried, so its feedback is `unknown`, and the files are saved under `submission files/`.
  **Why:** the student route can answer with a groupmate's record, and no file must be called "your submission" when someone else made it.
- A missing field is unknown: a list that is absent, null or not an array is "Brightspace's answer had no file list", and only a present empty array is none. A submission, folder or announcement with no usable id is counted in `unknown` rather than dropped.
- Feedback attachments are fetched only for released feedback (`IsGraded` not false), and the signed-in user lookup for them gets the abort signal.
- Submission files come from `/dropbox/folders/{folder}/submissions/{submission}/files/{file}`, with no `/download` suffix (2026-11-19: the suffixed route answers 404 on a live school; the plain route was confirmed on a live course). Feedback attachments come from `/dropbox/folders/{folder}/feedback/user/{userId}/attachments/{file}`, listed by the feedback record's `Files`. That route is documented but has not been confirmed on a live school, so a failure there is `unknown`, never "none".
- Names: every remote name goes through `sanitizeComponent` and a `NameSet`, and is planned inside the path budget: when there is one (Windows), the folder name gets 40% of the room left and the file name the rest, each at least 16 characters, with the extension kept. An assignment's and an announcement's folder is recorded by id in the manifest, so a rename on Brightspace keeps the same folder. A resubmission with the same file name becomes `name (2).ext`.
- The top-level folders: existing Content is never moved. The extras take the first free name (`Assignments`, else `Assignments (2)`, and so on), judged against the names Content plans, the paths already in the Content manifest, and, the first time a root is chosen, a listing of the destination. Any file, folder or link there counts, compared with `foldKey` (case and Unicode folded) on every platform. The choice is recorded in the manifest and reused.
  **Why:** a student's destination already had his own `assignments` folder, which on a case-insensitive disk is the same folder as `Assignments`, so the extras were merged into it. A folder synced on Linux may be opened on macOS or Windows later. A destination that cannot be listed adds nothing: the Content path reports a destination it cannot use.
- A name the extras have recorded is reserved when Content is planned, in every run (options on or off, `moduleId` or not). A module that would share it, and has nothing saved under that name, is planned under the next free name.
  - A module added later named like the recorded root is saved as `Assignments (2)`.
  - A module that was on disk as `Assignments` before the extras were used keeps that name, because the extras chose `Assignments (2)`.
  - A module a 5.2.21 sync saved as `Assignments (2)` keeps getting new topics there, even with the options off.
  **Why:** renaming or splitting a Content module on the day an option is turned on would move a student's existing files, and two runs must never disagree about where a topic goes (review of #470).
- Manifest: an `extras` key beside `courses`, `extras[courseId] = { assignmentsRoot, announcementsRoot, assignments: { [folderId]: { dir, feedback?: { path, size, mtimeMs, hash }, files } }, announcements: { [newsId]: { dir, files } } }`.
  - `files` keys are `sub:<submissionId>:<fileId>`, `asg:<fileId>`, `fb:<fileId>`, and the attachment id for an announcement.
  - On load, a root must be one folder name, a record's `dir` must be exactly `<root>/<one folder>` for its kind, and every file and feedback path must sit inside that `dir`. Anything else is dropped as not ours, with the other validation of ids, keys and relative paths.
  - A manifest with an `extras` of the wrong type, or records of the wrong type, loads as extras that hold nothing; the Content entries still load.
  - `entries(courseId)` stays Content-only, so `get_unsaved_course_files` and the ledger never see these files.
  - The key is written only when it holds something.
  **Why:** a manifest is read back from disk and says which files the sync may overwrite. A hand-edited or foreign path must never point at Content files or outside the destination.
  **Why:** an older server rewrites the manifest without `extras`. The files are then on disk with no record, which the sync reads as the student's own, so nothing is overwritten.
- Folders made by 5.2.21: that version recorded no root and always used the fixed names. When a course's `extras` has no recorded root for a kind, and any record of that kind has a `dir` directly under the fixed name (`Assignments` or `Announcements`), that name is adopted as the root. Each record under it is kept, and each record elsewhere is dropped on its own.
  **Why:** without this, 5.2.22 would disown what 5.2.21 saved: `feedback.md` would never refresh again and `keep_both` would duplicate files.
- 5.2.21 planned a Content module called `Assignments` as `Assignments (2)`. With the adopted root `Assignments` reserved, it is planned as `Assignments (2)` again, so a topic already recorded is found by its topic id and path, and a new topic of that module goes to the same folder. Nothing is downloaded again or moved.
- Known limit: after an older server dropped `extras`, `existing: keep_both` saves a numbered copy of each extra file on every rerun that is not the same size as the one on disk, since the sync no longer knows the file is its own. Under `skip` and `replace` nothing is duplicated or replaced. The same applies to the extras folder: with no recorded root, the folder already on disk counts as taken, so the next run writes into `Assignments (2)` and leaves the old one untouched.
- `feedback.md`: the text is rendered, hashed with SHA-256 and compared with the manifest's hash. The same hash writes nothing. A different hash rewrites the file atomically in place, in every `existing` mode, when the file is still as the sync wrote it (`unchangedSinceSync`).
  - Dates are shown in the server's time zone (the same source as `get_server_info`'s `localTimezone`, via `src/utils/timezone.ts`), written with `Intl.DateTimeFormat` and an explicit zone, followed by the instant as received. Only an ISO instant with a `Z` or an offset is read; anything else is written as received. Changing the zone changes the text, so the hash differs and `feedback.md` is rewritten once (if the student has not edited it).
  - If the student edited it, `skip` and `replace` leave it and count it. `keep_both` writes `feedback (2).md`, records that as the tracked file, and refreshes it in place from then on. If the tracked copy is edited too, it is left alone and counted: there is never a third copy.
  - A tracked file the student deleted is written again at the tracked path; an untracked `feedback.md` is never taken for it.
  - Instructor text is a blockquote with every line prefixed. All remote text (feedback, rubric cells, assignment, rubric, file and submitter names, dates, reasons) goes through one rule: characters a viewer could turn into structure, a link or markup are written as character references, and nothing of ours is wrapped around remote text.
  - The references: `& < > [ ] ` @ \ |` (as `&amp;`, `&lt;`, `&gt;` and numeric ones), the first slash of `//`, and the dot after a leading `www`. A line start is changed too: indentation, `#`, `~`, runs of `- + * _ =` and `1.` numbers. Images become `(image: alt)` and links `text (url)`, escaped. Names stay JSON-quoted, with the same characters as `\u` escapes. Decimals, abbreviations and file names (`18.5/20`, `e.g.`, `report.pdf`) are left as written.
  - Direction and invisible controls are stripped (not the joiners emoji need). At most 200 rubric rows per rubric and 300 kB (bytes) per file. Over the cap, the status lines and the file sections are always written and only the long free text is cut at a line end, with a note; the rubrics keep up to half of the room.
  - A test renders the produced file with a real Markdown engine (markdown-it, raw HTML and linkify on) for a matrix of payloads in every position and asserts there is no link, no image, no raw element and the same structure the server wrote. Add a payload there when a new way is found. Bare domains (`evil.com`) are not escaped: only some engines link them (a fuzzy-link extra, not CommonMark or GFM), so the test turns that option off and the file does not defend against it.
  **Why:** the comments are written by someone else and the file is read by an agent and rendered by a viewer, so it must stay data and must not fetch anything.
- `includeSyllabus` was not added. `get_syllabus` cannot say reliably that a course has no syllabus file (it may live in an external tool), so a saved copy could not be told from "none". The syllabus stays in the "not covered" line.
- The saved-topics ledger and `recordSyncRoot` count Content entries only.

### Dry run

- `dryRun` reads the table of contents and the manifest, then lists the planned names. It writes nothing. It takes no lock, creates no folder and removes no partial file.
- The tool needs the folder to exist. The CLI's dry run does not create the folder, so it can name one that does not exist yet.

### The `sync` command

- A real run creates `--dest` if it is missing. It does this after the destination check, so a refused path leaves no folder behind. The tool does not create its folder.
- The CLI applies the 5 GB byte default. It has no time limit.
- Exit codes:
  - 0: everything done.
  - 1: something failed or was not attempted, including a lost sign-in.
  - 2: a usage error, a refused destination, a sync already running into the folder, or an unknown module.
  - 130: interrupted by SIGINT or SIGTERM.

## What is already saved

`get_unsaved_course_files` (`src/tools/get-unsaved-course-files.ts`) answers "which content topics do I not have yet?" by topic id. Its state comes from two places, joined in `readSavedState` (`src/sync/saved-topics.ts`).

**The ledger** is `saved-topics.json` next to `config.json`, in `~/.brightspace-mcp/`. It is written atomically with mode `0600`.

- Shape: `version: 1`, then `schools`, then the school's origin, then `courses` (course id, then topic id) and `syncRoots` (course id, then a list of folders). Each topic entry has `path` (absolute), `size`, `savedAt` and, when the saver knew it, `lastModified`.
- A topic can also be marked by the student with `mark_course_files_saved` (`src/tools/mark-course-files-saved.ts`). That entry has `marked: true`. With a path it is an ordinary entry plus `marked`. Without one it has no `path`, only `marked`, `size` 0 and `savedAt`.
- `download_file` writes an entry when it publishes a content topic to disk. It does not know the topic's `lastModified` without another request, so it leaves it out.
- `syncCourse` adds its destination folder to `syncRoots` at the end of a real run, next to the final manifest save, at most 20 per course.
  - It runs however the run ends (done, deadline, cancel, an error), and never before the first download.
  - A dry run adds nothing.
  - Only a folder that holds saves is added: the run saved something, or the manifest already has entries for the course. A run that saved nothing into a folder with none would otherwise leave a folder that is later reported as not found.
  **Why at the end:** taking the ledger lock can wait up to 3 seconds, and the run's deadline is already counting. Done first, it used up the time of a short deadline and a run downloaded nothing (the release verify on Windows, 5.2.15). The wait now comes after the downloads.
- Entries are read back as untrusted input: a path that is not absolute, or holds a NUL byte, is dropped, and so is any course or topic key that is not digits.

**Marked entries and older servers:**

- The ledger stays at `version: 1`. A marked entry with a path is, to 5.2.15 and 5.2.16, an ordinary entry (absolute path, size, savedAt). One without a path is skipped by them, so the topic reads as unsaved there. That is the safe direction: it errs toward listing the topic.
- **Why not version 2:** the version guard makes an older server report the whole ledger as unreadable and refuse to record anything, which would break every download record on a machine where an older server also runs (an `npx` copy that has not updated). Bumping would punish the common case to protect a rare one.
- **The cost:** a ledger entry's `path` is now optional. An older server (5.2.15 or 5.2.16) that rewrites the ledger drops path-less marks, and strips the `marked` flag from pathed ones, so those read as ordinary saves afterwards. The student marks them again. Newer servers keep what they read.
- `markTopics` and `unmarkTopics` use the same lock as every other write, but report a failure to the caller instead of logging it (`enqueueStrict`).
- `allUnsaved` is computed from the same diff as `get_unsaved_course_files` (`diffCourse`) and is refused when that diff is incomplete: a damaged ledger, an unreadable manifest, a cut-off table. Marking "everything unsaved" on partial knowledge would hide topics the student does not have.
- A mark without a path never replaces an entry that has one. A mark with a path does not replace a `download_file` record whose file is still there (reported as `alreadyRecorded`), and a replaced record keeps its `lastModified`.
- A call that would record nothing does not lock or write. `unmarkTopics` reads the ledger first, and returns without the lock when none of the topics is recorded, so a damaged ledger is never moved aside by a no-op.
- The lock wait is an option passed in (`LedgerWriteOptions.lockWaitMs`), not module state. Tests pass it through `registerMarkCourseFilesSaved`.
- **Network and device paths.** `isNetworkOrDevicePath` (`src/utils/sensitive-paths.ts`) is a string test for a leading `\\` or `//`, so it covers UNC and `\\?\`/`\\.\` paths on every platform.
  - It is applied to a mark's `path`, to the `syncFolder` argument, and to ledger entries and remembered sync folders when the ledger is loaded (the entry is dropped).
  - **Why:** the ledger paths are statted on every `get_unsaved_course_files` call, and statting a UNC path on Windows makes the machine authenticate to that host.
  - A mapped drive letter is allowed: the string cannot tell it from a local drive, and the person mapped it.

**Why a per-user ledger, and not the nearest `.brightspace-sync.json`:**

- A student who saves with `download_file`, `downloadPath` and `customFilename` has no sync folder at all. The manifest is rooted in a destination folder and holds paths relative to it, so there is nothing "nearest" to find, and a later `downloadPath` elsewhere would never see the entry.
- A manifest entry means "this sync wrote the file", and `existing: replace` may overwrite such a file. A file the student named and filed by hand must never become one. Writing into the manifest would widen what `replace` can overwrite, which is a safety rule (see [Existing files](#existing-files-existing)).
- The ledger is keyed by school as well as course, because two schools can reuse a course id. A manifest sits in one folder and cannot say which school wrote it.
- **Why not copy sync results into the ledger:** a sync's files are already in its manifest, in the format and code that exist. The ledger remembers the folder and reads the manifest in place (`SyncManifest.load`, with `entries()`), so there is one record of each fact and an old sync is found as soon as its folder is passed as `syncFolder`.

**Writing it safely:**

- `recordSavedTopic` and `recordSyncRoot` catch every error and log a warning. The save is reported as it happened. A record that could not be written shows later as unsaved, which errs toward downloading again, never toward claiming a file is saved.
- Every read-modify-write holds a cross-process lock, `saved-topics.json.lock`, taken like the sync's folder lock (`src/sync/lock.ts`): an exclusive create with a random token, and a stale owner (dead process, or older than 30 seconds) removed only by the holder of a short-lived `.takeover` guard. A writer waits up to 3 seconds; past that it logs and skips.
  **Why:** two servers (Claude Desktop and Cursor) or a server and the `sync` command write the same file. Each would read the old file, and the later rename would drop the other's entry. Writers in one process also take turns in a queue.
- A ledger that is not valid JSON, or not a ledger, is moved aside to `saved-topics.json.corrupt-<time>` under the lock, and a new one starts.
- A ledger with a `version` other than 1, or one that cannot be read for another reason (permissions), is never rewritten and never moved aside. Reads report it as unreadable.

**Reading it: "could not read" is never "there is none":**

- A missing ledger or manifest is empty. One that exists and cannot be read goes in `stateUnreadable`, `complete` is `false`, and the notice says the unsaved topics may already be saved. `SyncManifest.unreadable` carries this for a manifest: invalid JSON, and also a file that parses but has no `courses` object (`{}`, `[]`, `courses` as an array). The sync itself still starts from empty in those cases.
- **A set-aside ledger stays visible.** While any `saved-topics.json.corrupt-<time>` file sits next to the ledger, every read reports it in `stateUnreadable` (with `where` naming the file), `complete` is `false`, and the notice says earlier saves are unknown.
  **Why:** the new ledger starts empty, so without this the tool would report every earlier save as unsaved and say nothing was wrong. To clear it, the student checks what they have, then deletes the `.corrupt-` file (it is in `~/.brightspace-mcp/`).
- A sync folder the ledger remembers that is not found (moved, deleted, a drive not connected) is reported as `stateUnreadable` with source `syncFolder`, not read as an empty manifest. A `syncFolder` argument that does not exist is an `invalidInput` error.
- The course tree is read fresh with `GET /content/toc`, as the sync does, and planned with the sync's own `planFiles`, so both tools agree on what a file topic is. A failed read is an error answer, never an empty list. A table cut off at the sync's limits sets `tocTruncated`.
- **"Saved" means something regular exists at the recorded path.** The size is not compared, so an edited or replaced file still counts as saved. `ENOENT` and `ENOTDIR` put the topic in `savedFileMissing`, unless the file's folder is not found either: then it is `couldNotCheck`, so an unmounted drive or a moved folder is not reported as a deleted file. Any other error is `couldNotCheck` too. A topic recorded in several places is saved when any copy exists, and unchecked outranks missing.
- **`syncFolder` opens one file.** It only ever reads `<folder>/.brightspace-sync.json`, for that call, and never returns file contents. It is not remembered (the tool is read-only and a caller must not be able to plant folders), so a caller passes it on every call.
- **Keys are untrusted.** The ledger and the manifest are read from disk, and the manifest from a caller-supplied folder. A course or topic key must be digits (`/^\d+$/`), and the maps have no prototype, so `__proto__` cannot reach `Object.prototype`.
- **The skip limit.** With `existing: skip`, a file already at the planned path that no manifest entry claims counts as present and is skipped (see [Existing files](#existing-files-existing)).
  - The sync writes no entry for it. Recording it would claim a file the sync does not know came from this topic, and an entry in the manifest would let `replace` overwrite it.
  - So `get_unsaved_course_files` lists that topic as unsaved until it is downloaded once under a recorded save.
  - The tool text says unsaved means "no record of saving", and tells the agent to ask before downloading everything again.
- **Counters add up.** `planFiles` counts every module and topic it reads (`modulesSeen`, `topicsSeen`), every entry that was not an object (`unreadEntries`) and topics by `TypeIdentifier/TopicType` (`typeCounts`). Each topic seen is a file in the plan or one of `link`, `media`, `broken`, `other`, so `topicsSeen` = files + those four. `get_unsaved_course_files` returns them as `tableOfContents`, and the sync summary prints the total.
  - A live course (5.2.16) reported 138 files and 4 links for a table that `get_course_content` counted as 153 topics, with 12 quiz quickLinks in one module. Every topic the walk reads lands in a counter, so the missing topics were not in the `/content/toc` response, or were in a shape the walk does not read. The code and the fake cannot say which, or why. `tableOfContents` lets the next live run show it: `topicTypes` names what the table holds, and `unreadEntries` counts what it could not read.
  - The note in the answer says that a topic missing from the table is in none of the lists. It does not claim a cause. With `moduleId` the counters cover that module only, and the note says so.
  - `topicTypes` keys are `TypeIdentifier/TopicType`, or just `TypeIdentifier` when the table has no `TopicType` (/content/toc often omits it), or `unknown` when it has no identifier. The sync summary does not print these keys.
  - They come from the course: only strings and numbers are used, each part is reduced to word characters, spaces, dots and dashes, `TypeIdentifier` is cut to 40 characters and `TopicType` to 10, and past 50 distinct keys the rest count under `other`.
  - The mark tool takes its file ids and its other ids from the same `planFiles` reading (`Plan.topicIds`), so a file topic past the cut-off is not refused as "not a file topic".
- The tool leaves out the `unavailable` count that the sync reports: it does not read each topic's release state, so it would always be 0. Its text says a listed topic may not be open yet, and that `download_file` explains why.
- **Why by topic id:** a file uploaded weeks before release keeps its old `lastModified`, and un-hiding does not change it. A `modifiedSince` filter on `get_course_content` missed a homework PDF that way. No date can find it, so the tool descriptions (`FIND_NEW_FILES_GUIDANCE` in `src/tools/tool-helpers.ts`) tell the agent to use this tool and never to conclude a file is absent from `modifiedSince`.
- Tests: `tests/sync/saved-topics.test.ts`. The test setup (`tests/setup/ledger-isolation.ts`) points the home directory at a temporary folder, and removes it afterwards, so no test writes the real ledger.

## Limits at a glance

| Limit | Value | Set in |
|---|---|---|
| Files per call, tool (`maxFiles`) | 300 default; 1 to 5000 | `DownloadCourseFilesSchema` in `src/tools/schemas.ts`; `DEFAULT_MAX_FILES` in `src/sync/course-sync.ts` |
| Files per run, CLI (`--max-files`) | 300 default; a whole number of at least 1 | `DEFAULT_MAX_FILES` in `src/sync/course-sync.ts` |
| Bytes per call, tool (`maxTotalMB`) | 5120 MB default; 1 to 1048576 | `DownloadCourseFilesSchema` in `src/tools/schemas.ts` |
| Bytes per run, CLI | 5 GB (`DEFAULT_MAX_TOTAL_BYTES`) | `src/sync/course-sync.ts` |
| Time limit (`maxMinutes`) | 8 minutes default; 1 to 120. None in the CLI | `DownloadCourseFilesSchema` in `src/tools/schemas.ts`; `deadlineMs` in `src/tools/download-course-files.ts` |
| Retry pauses | 1.5 s, then 4 s; at most 3 requests per file | `RETRY_DELAYS_MS` in `src/sync/course-sync.ts` |
| Statuses the sync retries | 408, 425 | `RETRYABLE_STATUSES` in `src/sync/course-sync.ts` |
| TOC depth | Modules at depth 32 are not read | `MAX_DEPTH` in `src/sync/course-sync.ts` |
| TOC size | 50,000 modules and topics | `MAX_TOC_NODES` in `src/sync/course-sync.ts` |
| Name length | 150 characters | `MAX_NAME_CHARS` in `src/sync/names.ts` |
| Name size | 240 bytes | `MAX_NAME_BYTES` in `src/sync/names.ts` |
| Extension kept in a name | 20 characters or fewer | `MAX_EXTENSION_CHARS` in `src/sync/names.ts` |
| Shortest shortened name | 16 characters | `MIN_NAME_CHARS` in `src/sync/course-sync.ts` |
| Windows full path | 250 characters (Windows only) | `WINDOWS_PATH_BUDGET` in `src/sync/course-sync.ts` |
| Manifest save | Every 25 files or 2 seconds, and at the end | `MANIFEST_BATCH_FILES`, `MANIFEST_BATCH_MS` in `src/sync/course-sync.ts` |
| Sync folders remembered per course | 20 | `MAX_SYNC_ROOTS` in `src/sync/saved-topics.ts` |
| Manifest path length | 4096 characters | `validRelativePath` in `src/sync/manifest.ts` |
| Manifest mtime match | 1 ms | `unchangedSinceSync` in `src/sync/manifest.ts` |
| Stale lock | 1 hour | `STALE_LOCK_MS` in `src/sync/lock.ts` |
| Takeover guard | Stale after 30 seconds; up to 60 attempts | `TAKEOVER_STALE_MS` and the attempt loop in `src/sync/lock.ts` |
| Stale partial file | Older than 1 hour | `PARTIAL_MAX_AGE_MS` in `src/sync/cleanup.ts` |
| Partial-file walk | 64 levels; 50,000 entries | `MAX_DEPTH`, `MAX_VISITED` in `src/sync/cleanup.ts` |
| Link resolutions before a loop | 40 | `MAX_LINK_DEPTH` in `src/utils/sensitive-paths.ts` |
| Filename numbering | 100 attempts | `resolveFilenameConflict` and `publishExclusively` in `src/utils/download-helpers.ts` |
| Disk download | 2 GB | `DISK_MAX_FILE_SIZE` in `src/utils/file-validator.ts` |
| In-memory download read | 50 MB | `MAX_FILE_SIZE` in `src/utils/file-validator.ts` |
| Inline response | 10 MB | `INLINE_MAX_SIZE` in `src/tools/download-file.ts` |
| Inline image | 3.5 MB | `INLINE_IMAGE_MAX_SIZE` in `src/tools/download-file.ts` |
| Inline text | 400,000 characters | `INLINE_TEXT_MAX_CHARS` in `src/tools/download-file.ts` |
| Sniffed text head | 64 characters | `TEXT_HEAD_CHARS` in `src/utils/file-validator.ts` |
