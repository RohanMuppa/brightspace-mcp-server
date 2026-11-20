#!/usr/bin/env bash
# Waits until the npm registry serves both the metadata of one exact version and
# a 200 from that version's tarball URL. npm can report a version minutes before
# its tarball can be downloaded (see docs/internals/releasing.md).
#
#   wait-for-npm.sh <package> <version>
#
# Exits 0 once both hold, 1 when they never do. It prints progress only: the
# caller owns the error message, because what a timeout means differs per job.
set -uo pipefail

NAME=$1
VERSION=$2
ATTEMPTS=${NPM_WAIT_ATTEMPTS:-45}
INTERVAL=${NPM_WAIT_INTERVAL:-20}
URL="https://registry.npmjs.org/${NAME}/${VERSION}"

for i in $(seq 1 "$ATTEMPTS"); do
  TARBALL=$(curl -sS --max-time 30 "$URL" 2>/dev/null | jq -r '.dist.tarball // empty' 2>/dev/null || true)
  if [ -z "$TARBALL" ]; then
    echo "attempt $i of $ATTEMPTS: npm has no metadata for $NAME@$VERSION yet"
  else
    CODE=$(curl -sSL --max-time 120 -o /dev/null -w '%{http_code}' "$TARBALL" 2>/dev/null || true)
    if [ "$CODE" = "200" ]; then
      echo "npm serves $NAME@$VERSION and its tarball ($TARBALL)"
      exit 0
    fi
    echo "attempt $i of $ATTEMPTS: metadata is there but the tarball answered ${CODE:-no response}"
  fi
  if [ "$i" -lt "$ATTEMPTS" ]; then sleep "$INTERVAL"; fi
done
exit 1
