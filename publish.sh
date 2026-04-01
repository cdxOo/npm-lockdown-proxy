#!/usr/bin/env bash
# usage:
#   ./publish.sh          # defaults to patch
#   ./publish.sh minor
#   ./publish.sh major
set -e

BUMP=${1:-patch}

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "usage: $0 [patch|minor|major]"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: uncommitted changes - commit or stash before publishing"
  exit 1
fi

npm version "$BUMP"
npm publish
git push --follow-tags
