#!/usr/bin/env bash
# Publishes the version in package.json to npm and, for a stable version, moves
# `latest` to it only once its tarball can be downloaded. Run from the repo
# root by the `publish` job of .github/workflows/publish.yml. The rules and the
# reasons for them are in docs/internals/releasing.md.
#
# Writes to $GITHUB_OUTPUT:
#   version    the version in package.json
#   published  true when this run brought the release to its finished state on
#              npm, so the GitHub release and the MCP Registry publish should run
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# The dist-tag a stable version is published under before `latest` moves to it.
# It is never removed (the NPM_TOKEN secret may not delete a dist-tag), so it
# always sits on the newest stable version and says nothing about a release.
STAGED_TAG=staged
VERIFY_ATTEMPTS=${NPM_VERIFY_ATTEMPTS:-15}
VERIFY_INTERVAL=${NPM_VERIFY_INTERVAL:-20}

NAME=$(node -p "require('./package.json').name")
CURRENT=$(node -p "require('./package.json').version")
echo "version=$CURRENT" >> "$GITHUB_OUTPUT"

PROMOTE_BY_HAND="npm dist-tag add $NAME@$CURRENT latest"

# Prints one field npm has for a spec, nothing when npm answers E404 (never
# published) or has no such field, and fails on any other error: a registry
# hiccup must not read as "never published".
npm_view() {
  local out err
  err=$(mktemp)
  # stdout and stderr apart: an `npm warn` line must not end up in the answer.
  if out=$(npm view "$1" "$2" 2>"$err"); then
    rm -f "$err"
    printf '%s' "$out"
  elif grep -q "E404" "$err"; then
    rm -f "$err"
  else
    echo "::error::npm view $1 $2 failed: $(cat "$err")" >&2
    rm -f "$err"
    return 1
  fi
}

# Full semver precedence, so prereleases and 5.10 against 5.9 compare correctly.
is_newer() {
  [ "$(node "$HERE/semver-newer.mjs" "$1" "$2")" = "true" ]
}

done_with() {
  echo "published=$1" >> "$GITHUB_OUTPUT"
  exit 0
}

# A release is finished only by the run for the commit it was built from, so
# the GitHub release never tags some later commit. npm records that commit as
# `gitHead`. When npm has none there is nothing to compare, and the run goes on.
PUBLISHED_FROM=
built_from_this_commit() {
  PUBLISHED_FROM=$(npm_view "$NAME@$CURRENT" gitHead) || exit 1
  [ -z "$PUBLISHED_FROM" ] || [ -z "${GITHUB_SHA:-}" ] || [ "$PUBLISHED_FROM" = "$GITHUB_SHA" ]
}

warn_other_commit() {
  echo "::warning::$NAME@$CURRENT is on npm but its release is not finished, and it was published from commit $PUBLISHED_FROM, not this run's $GITHUB_SHA. Nothing was changed. Re-run the publish workflow run of commit $PUBLISHED_FROM to finish it."
}

# Succeeds when the repository has the tag v$CURRENT, which the github-release
# job creates: the mark of a release whose later jobs have run. A lookup that
# fails stops the step: "could not ask" must not read as "no tag".
release_tag_exists() {
  local found
  if ! found=$(git ls-remote --tags origin "refs/tags/v$CURRENT"); then
    echo "::error::Could not ask the repository whether the tag v$CURRENT exists (git ls-remote failed), so this run cannot tell whether the release of $NAME@$CURRENT is finished. Nothing was changed on npm by this check. Re-run this job." >&2
    exit 1
  fi
  [ -n "$found" ]
}

# Waits for the tarball, then moves `latest` to $CURRENT, never backwards.
promote() {
  local latest seen i
  if ! bash "$HERE/wait-for-npm.sh" "$NAME" "$CURRENT"; then
    echo "::error::npm never served the tarball of $NAME@$CURRENT, so \`latest\` was not moved. State of npm: $CURRENT is published but not promoted, \`latest\` is still $PUBLISHED, and people running $NAME@latest are unaffected. To finish, re-run this job: it waits again and then promotes. To promote by hand once the tarball answers 200, run the next command and then re-run this job: $PROMOTE_BY_HAND"
    exit 1
  fi

  # Looked up again, after the wait: `latest` may have moved in the meantime.
  latest=$(npm_view "$NAME" version) || exit 1
  latest=${latest:-0.0.0}
  if [ "$latest" = "$CURRENT" ]; then
    echo "\`latest\` already points at $CURRENT"
  elif is_newer "$CURRENT" "$latest"; then
    if ! npm dist-tag add "$NAME@$CURRENT" latest; then
      echo "::error::npm refused to move \`latest\` to $NAME@$CURRENT (the NPM_TOKEN secret may not be allowed to change dist-tags). State of npm: $CURRENT is published and its tarball downloads, but it is not promoted; \`latest\` is still $latest, and people running $NAME@latest are unaffected. Run the next command as a maintainer, then re-run this job to finish the release: $PROMOTE_BY_HAND"
      exit 1
    fi
  else
    echo "::warning::$NAME@$CURRENT was not promoted: \`latest\` is now $latest, which is newer. \`latest\` never moves backwards."
    done_with false
  fi

  # npm can take a moment to show a tag it has just accepted.
  for i in $(seq 1 "$VERIFY_ATTEMPTS"); do
    seen=$(npm_view "$NAME" dist-tags.latest 2>/dev/null) || seen=
    if [ "$seen" = "$CURRENT" ]; then
      echo "npm reports latest = $CURRENT"
      done_with true
    fi
    echo "attempt $i of $VERIFY_ATTEMPTS: npm reports latest = ${seen:-nothing}, expected $CURRENT"
    if [ "$i" -lt "$VERIFY_ATTEMPTS" ]; then sleep "$VERIFY_INTERVAL"; fi
  done
  echo "::error::npm accepted the move of \`latest\` to $NAME@$CURRENT but still reports latest = ${seen:-nothing}. Check with: npm view $NAME dist-tags. If latest reads $CURRENT there, re-run this job to finish the release. If it does not, run the next command and then re-run this job: $PROMOTE_BY_HAND"
  exit 1
}

PUBLISHED=$(npm_view "$NAME" version) || exit 1
ALREADY=$(npm_view "$NAME@$CURRENT" version) || exit 1
PUBLISHED=${PUBLISHED:-0.0.0}

# A prerelease goes straight to `next` and never touches `latest`.
case "$CURRENT" in
  *-*)
    if [ -n "$ALREADY" ]; then
      echo "Version $CURRENT is already on npm, skipping"
      done_with false
    elif is_newer "$CURRENT" "$PUBLISHED"; then
      npm publish --provenance --access public --tag next
      echo "Published v$CURRENT as next"
      done_with true
    fi
    echo "Version $CURRENT is not newer than npm's $PUBLISHED, skipping"
    done_with false
    ;;
esac

if [ "$CURRENT" = "$PUBLISHED" ]; then
  # `latest` is already this version. That is a finished release once the tag
  # v$CURRENT exists. Without it, `latest` was moved by hand, or an earlier run
  # stopped right after moving it, and the jobs after this one never ran.
  if release_tag_exists; then
    echo "Version $CURRENT is already npm's latest and tagged v$CURRENT, skipping"
    done_with false
  elif built_from_this_commit; then
    echo "Version $CURRENT is already \`latest\` but has no tag v$CURRENT: finishing its release"
    done_with true
  fi
  warn_other_commit
  done_with false
fi

# Only a version newer than npm's `latest`: a run for an older commit that
# finishes late must not publish over, or take `latest` from, a newer release.
if ! is_newer "$CURRENT" "$PUBLISHED"; then
  # Published by this commit's run, never finished, and overtaken since.
  if [ -n "$ALREADY" ] && built_from_this_commit && [ -n "$PUBLISHED_FROM" ] && ! release_tag_exists; then
    echo "::warning::$NAME@$CURRENT was published but its release was never finished, and npm's \`latest\` is now $PUBLISHED, which is newer. Nothing was changed. $CURRENT has no GitHub release and no MCP Registry entry; create them by hand if they are wanted (see docs/internals/releasing.md, \"A release that is stuck\")."
  fi
  echo "Version $CURRENT is not newer than npm's $PUBLISHED, skipping"
  done_with false
fi

if [ -n "$ALREADY" ]; then
  # Published by an earlier run that never got to move `latest`.
  if ! built_from_this_commit; then
    warn_other_commit
    done_with false
  fi
  echo "Version $CURRENT is on npm but \`latest\` is still $PUBLISHED: waiting for its tarball, then promoting"
else
  # Not `latest` yet: npm reports a new version minutes before it serves the tarball.
  npm publish --provenance --access public --tag "$STAGED_TAG"
  echo "Published v$CURRENT as $STAGED_TAG"
fi
promote
