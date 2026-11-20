# Releasing

How a change reaches users, for anyone merging a PR or touching `.github/workflows/`.

## What you do

1. Bump `version` in `package.json`. Keep `package-lock.json` (two fields) and `server.json` (every version field) on the same number.
2. Add a new section for that version at the top of [CHANGELOG.md](../../CHANGELOG.md), headed with the version and today's date, with a line written for someone who uses the server. `tests/docs/doc-structure.test.ts` fails when the version in `package.json` has no entry.
3. Merge to `main` once CI passes on the head commit.

Every PR that ships takes its own version number. If another PR merged first and took the number you chose, merge `main` into your branch and take the next one. Never add your line to a version that is already on `main`: that version is already published.

A PR needs the bump when it changes what ships in the npm package: anything under `src/`, `README.md`, or `package.json`. Users run `npx -y brightspace-mcp-server@latest`, so they get a change only after a publish, and the workflow skips publishing when the version is unchanged. A PR that touches only tests, CI or files under `docs/` does not need one.

## What happens next

`.github/workflows/publish.yml` runs on every push to `main`. Its `publish` job runs `.github/scripts/npm-release.sh`, which makes every npm decision.

- It publishes only when `version` in `package.json` changed, and only after the CI matrix passes on macOS, Windows and Linux.
- A stable version reaches users in three steps:
  1. `npm publish --tag staged`. The version is on npm, but `latest` still points at the previous one, so `npx -y brightspace-mcp-server@latest` keeps serving the previous version.
  2. `.github/scripts/wait-for-npm.sh` polls npm every 20 seconds, up to 15 minutes, until the metadata for the exact version exists and the `dist.tarball` URL in it answers 200.
  3. `npm dist-tag add brightspace-mcp-server@<version> latest`. The script then reads `dist-tags.latest` back, for up to 5 minutes, until it shows the version, and removes the `staged` tag.
- A prerelease (a version containing `-`) is published with `--tag next` and stops there.
- Once npm is done, the `github-release` job tags that run's commit `v<version>` and creates the GitHub release with generated notes, and the `registry` job publishes `server.json` to the MCP Registry. Both run only when the `publish` job's `published` output is `true`.

To confirm a release:
- `npm view brightspace-mcp-server dist-tags` shows `latest` on the new version and no `staged`.
- The tarball downloads: `curl -sSL -o /dev/null -w '%{http_code}\n' "$(npm view brightspace-mcp-server@<version> dist.tarball)"` prints `200`.
- `gh release view v<version>` finds the release.

## Rules the publish step obeys

- **Publishing is serialized.** The workflow uses `concurrency: publish-npm` with no cancelling.
- **`latest` moves only to a version that can be downloaded.** A stable version is never published as `latest`. The tag is moved afterwards, and only once the tarball answers 200.
- **Only a newer version is published.** `npm publish` runs only when `package.json`'s version is semver-greater than npm's `latest`. The comparison is full semver precedence (`.github/scripts/semver-newer.mjs`).
- **`latest` never moves backwards.** The script reads `latest` again after the tarball wait, right before moving it. If a newer version took `latest` in the meantime, it leaves the tag alone and ends with a warning and `published=false`.
- **A lookup failure stops the job.** An `npm view` failure other than E404 fails the job. It never falls back to `0.0.0`.
- **`npm view` stdout and stderr are read separately**, so an `npm warn` line cannot corrupt the version that was read.
- **Prereleases stay off `latest`.** They never get the `staged` tag or the tarball wait either.
- **`published` means finished, and is `true` once per release.** It is `true` when this run left the version as `latest` (or published a prerelease), and `false` when it changed nothing. If the script fails, the job fails and the jobs after it are skipped. The `staged` tag is what marks a release as unfinished, which is how a re-run knows whether there is work left:

  | npm when the run starts | What the run does | `published` |
  |---|---|---|
  | version not on npm, newer than `latest` | publish as `staged`, wait, promote | `true` |
  | version on npm, newer than `latest` | wait, promote (no second publish) | `true` |
  | version is `latest`, `staged` still on it | remove `staged` | `true` |
  | version is `latest`, no `staged` | nothing: the release is finished | `false` |
  | version older than `latest` | nothing | `false` |

- **Only the run for the published commit finishes a release.** The second and third rows apply only when the commit npm recorded for the version (`gitHead`) is the run's commit. A later push that did not change the version prints a warning and changes nothing, so the GitHub release never tags a commit the package was not built from.
- **The MCP Registry publish waits for the tarball too.** The `registry` job runs the same `wait-for-npm.sh` before its publish step, so a prerelease, or a re-run of that job alone, cannot reach a publish that would be refused. If npm never serves the tarball the job fails with an error. The job is `continue-on-error`, so that does not fail the workflow.

**Why:** on 2026-11-19 npm reported a new version as `latest` before the version could be downloaded, twice. In that window a fresh `npx brightspace-mcp-server@latest` could not start.

- 5.2.16: the tarball URL answered 404 for about 5 minutes.
- 5.2.18: npm had no metadata for the version for about 3 minutes, then served the metadata with a 404 tarball for about 5 more.
- 5.2.14, the same day: the MCP Registry publish got a 400 three times, because the old wait step gave up after 2 minutes.

`tests/release/publish-workflow.test.ts` runs the script against a fake registry for each row above and each failure below.

**Why:** two PRs merged back to back on 2026-11-09 (#413 and #422) ran their publish jobs at the same time. The run for the older commit finished last and left npm's `latest` one version behind what had been published. Serialized publishing and the newer-only rule came from that (#425).

## A release that is stuck

A stuck release is a failed `publish` job, with `npm view brightspace-mcp-server dist-tags` showing `staged` on the new version and `latest` on the previous one. Users are unaffected: they still get the previous version. There is no GitHub release and no MCP Registry entry for the new version yet. The job's error says which of these happened and prints the command to promote by hand.

| The error says | What happened | What to do |
|---|---|---|
| npm never served the tarball | 15 minutes passed without a 200 | Re-run the failed job. It skips the publish, waits again and promotes. |
| npm refused to move `latest` | `npm dist-tag add` failed, most likely because the `NPM_TOKEN` secret may not change dist-tags | Run `npm dist-tag add brightspace-mcp-server@<version> latest` as a maintainer, then re-run the failed job. |
| npm accepted the move but still reports the old `latest` | npm did not show the new tag within 5 minutes | Check `npm view brightspace-mcp-server dist-tags`, promote by hand if `latest` is still old, then re-run the failed job. |

Re-run the job after promoting by hand: the re-run finds the version as `latest` with `staged` still on it, removes `staged` and reports `published=true`, so the GitHub release and the MCP Registry publish run. Do not remove `staged` by hand before that re-run, or the re-run reads the release as finished and skips both.

If the script cannot remove `staged` after a release, it prints a warning and the release still succeeds. Remove the tag with `npm dist-tag rm brightspace-mcp-server staged`. While it stays, re-running that workflow run repeats the `github-release` job (which skips a release that exists) and the `registry` job (which the MCP Registry refuses for a version it already has, shown as a failed job that does not fail the workflow).

**Not yet verified:** whether the `NPM_TOKEN` secret may change dist-tags. It is an access token, not OIDC trusted publishing, and a granular token with write access to the package normally can, but nothing has moved a tag with it yet. The first stable release after this change is the test. If it fails with "npm refused to move `latest`", promote by hand as above and give the token that permission. Delete this paragraph once a release has promoted itself.

If a newer version ships before a stuck release is finished, re-running the stuck job changes nothing: `latest` never moves backwards, so the job warns and skips. That version then has no GitHub release and no MCP Registry entry unless someone creates them by hand. Users lose nothing, since the newer version contains it.

## CI

`.github/workflows/ci.yml` runs the build and `npm run test:run` on macOS, Ubuntu and Windows with Node 22 and 24. It installs with `npm ci --ignore-scripts`, so no Chromium is downloaded and no test in the default suite may need a browser. Browser tests run only with `BRIGHTSPACE_TEST_BROWSER=1`.
