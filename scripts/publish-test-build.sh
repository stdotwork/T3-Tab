#!/bin/sh
# Builds the helper from this checkout and publishes it as the GitHub prerelease `helper-test-build`, which
# scripts/install-test-build.sh downloads. Run it again after any commit to refresh the prerelease; the tag stays and
# the file is replaced. This is a test build, not a release. Needs `gh` signed in with write access to the repository.
set -eu
cd "$(dirname "$0")/.."

REPO="${T3_TAB_REPO:-stdotwork/T3-Tab}"
TAG=helper-test-build
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
COMMIT="$(git rev-parse --short HEAD)"
[ -z "$(git status --porcelain)" ] || echo "warning: uncommitted changes are in this build" >&2

if command -v pnpm >/dev/null 2>&1; then PNPM="pnpm"; else PNPM="npx --yes pnpm@12.21.0"; fi
$PNPM build

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM
(cd packages/helper && npm pack --silent --pack-destination "$work" >/dev/null)
mv "$work"/t3-tab-*.tgz "$work/t3-tab-helper.tgz"

notes="Test build of the T3-Tab helper from commit $COMMIT of branch $BRANCH. Not a release: it only exists so the helper can be tried before it is on npm. Install it with scripts/install-test-build.sh."
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release edit "$TAG" --repo "$REPO" --prerelease --title "T3-Tab helper test build" --notes "$notes"
else
  gh release create "$TAG" --repo "$REPO" --prerelease --target "$BRANCH" --title "T3-Tab helper test build" --notes "$notes"
fi
gh release upload "$TAG" "$work/t3-tab-helper.tgz" --repo "$REPO" --clobber
echo "Published https://github.com/$REPO/releases/download/$TAG/t3-tab-helper.tgz (commit $COMMIT)"
