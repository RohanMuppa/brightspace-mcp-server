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

To confirm a release: `npm view brightspace-mcp-server version` shows the new number, and `gh release view v<version>` finds the release.

## Rules the publish step obeys

- **Publishing is serialized.** The job uses `concurrency: publish-npm` with no cancelling.
- **Only a newer version is published.** `npm publish` runs only when `package.json`'s version is semver-greater than `npm view brightspace-mcp-server version`. The comparison is full semver precedence.
- **A lookup failure stops the job.** An `npm view` failure other than E404 fails the job. It never falls back to `0.0.0`.
- **Prereleases stay off `latest`.** A version containing `-` is published with `--tag next`.
- **A version already on npm is skipped.**
- **`npm view` stdout and stderr are read separately**, so an `npm warn` line cannot corrupt the version that was read.

**Why:** two PRs merged back to back on 2026-11-09 (#413 and #422) ran their publish jobs at the same time. The run for the older commit finished last and left npm's `latest` one version behind what had been published. The rules above came from that (#425). `tests/release/publish-workflow.test.ts` checks them.

## CI

`.github/workflows/ci.yml` runs the build and `npm run test:run` on macOS, Ubuntu and Windows with Node 22 and 24. It installs with `npm ci --ignore-scripts`, so no Chromium is downloaded and no test in the default suite may need a browser. Browser tests run only with `BRIGHTSPACE_TEST_BROWSER=1`.
