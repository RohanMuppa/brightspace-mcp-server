# Releasing

How a change reaches users, for anyone merging a PR or touching `.github/workflows/`.

## What you do

1. Bump `version` in `package.json`. Keep `package-lock.json` (two fields) and `server.json` (every version field) on the same number.
2. Add a new section for that version at the top of [CHANGELOG.md](../../CHANGELOG.md), headed with the version and today's date, with a line written for someone who uses the server. `tests/docs/doc-structure.test.ts` fails when the version in `package.json` has no entry.
3. Merge to `main` once CI passes on the head commit.

Every PR that ships takes its own version number. If another PR merged first and took the number you chose, merge `main` into your branch and take the next one. Never add your line to a version that is already on `main`: that version is already published.

A PR needs the bump when it changes what ships in the npm package: anything under `src/`, `README.md`, or `package.json`. Users run `npx -y brightspace-mcp-server@latest`, so they get a change only after a publish, and the workflow skips publishing when the version is unchanged. A PR that touches only tests, CI or files under `docs/` does not need one.

## What happens next

`.github/workflows/publish.yml` runs on every push to `main`.

- It publishes only when `version` in `package.json` changed, and only after the CI matrix passes on macOS, Windows and Linux.
- After a publish, the `github-release` job tags that run's commit `v<version>` and creates the GitHub release with generated notes. Releases therefore come only from a commit that was verified and published.

To confirm a release:
- Check the tarball, not only the version label. `npm view brightspace-mcp-server version` can show the new number while the package cannot be downloaded yet.
- Take the URL from the metadata and request it: `curl -sSL -o /dev/null -w '%{http_code}\n' "$(npm view brightspace-mcp-server@<version> dist.tarball)"` must print `200`.
- `gh release view v<version>` finds the release.

## Rules the publish step obeys

- **Publishing is serialized.** The job uses `concurrency: publish-npm` with no cancelling.
- **Only a newer version is published.** `npm publish` runs only when `package.json`'s version is semver-greater than `npm view brightspace-mcp-server version`. The comparison is full semver precedence.
- **A lookup failure stops the job.** An `npm view` failure other than E404 fails the job. It never falls back to `0.0.0`.
- **Prereleases stay off `latest`.** A version containing `-` is published with `--tag next`.
- **A version already on npm is skipped.**
- **`npm view` stdout and stderr are read separately**, so an `npm warn` line cannot corrupt the version that was read.

- **The MCP Registry publish waits for the tarball.** Before the `registry` job's publish step, a step polls npm every 20 seconds, up to 15 minutes, until two things hold: the metadata for the exact version exists, and the `dist.tarball` URL in that metadata answers 200.
  - If npm never serves both, the step fails the `registry` job with an error. It does not go on to a publish that would be refused. Re-run the job once the tarball answers 200.
  - The job is `continue-on-error`, so this shows as a failed `registry` job and does not fail the workflow or the npm publish.
  - The publish triggers and the GitHub release rule are unchanged: the tag and release still come only from a commit that was verified and published.

**Why:** on 2026-11-19 npm served a new version before it was usable, twice. For 5.2.14 the old wait step gave up after 2 minutes with only a warning, the MCP Registry publish then got a 400 three times, 30 seconds apart, and needed a manual re-run. For 5.2.16 the version label was served while the tarball URL returned 404 for about 5 minutes. `tests/release/publish-workflow.test.ts` checks the step.

**Why:** two PRs merged back to back on 2026-11-09 (#413 and #422) ran their publish jobs at the same time. The run for the older commit finished last and left npm's `latest` one version behind what had been published. The rules above came from that (#425). `tests/release/publish-workflow.test.ts` checks them.

## CI

`.github/workflows/ci.yml` runs the build and `npm run test:run` on macOS, Ubuntu and Windows with Node 22 and 24. It installs with `npm ci --ignore-scripts`, so no Chromium is downloaded and no test in the default suite may need a browser. Browser tests run only with `BRIGHTSPACE_TEST_BROWSER=1`.
