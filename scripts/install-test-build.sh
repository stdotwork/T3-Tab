#!/bin/sh
# Installs the T3-Tab helper from the test build published as a GitHub prerelease. It stands in for
# `npx t3-tab@latest setup` until the package is on npm: it downloads the packed helper (the same file `npm pack`
# makes) and runs its `setup`, which copies the helper into your own folder. Works from any folder.
#
#   curl -fsSL https://raw.githubusercontent.com/stdotwork/T3-Tab/proto/t3-panel/scripts/install-test-build.sh | sh
#
# Extra arguments go to `setup`:  ... | sh -s -- --agents
# T3_TAB_HELPER_URL replaces the download address (any address curl can read, such as file:///path/to/helper.tgz).
set -eu

URL="${T3_TAB_HELPER_URL:-https://github.com/stdotwork/T3-Tab/releases/download/helper-test-build/t3-tab-helper.tgz}"

fail() {
  echo "t3-tab: $1" >&2
  exit 1
}

for program in node curl tar; do
  command -v "$program" >/dev/null 2>&1 || fail "$program is needed to install the helper (Node.js 20 or newer: https://nodejs.org)."
done
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || fail "Node.js 20 or newer is needed; this is $(node -v)."

folder=$(mktemp -d)
trap 'rm -rf "$folder"' EXIT INT TERM
curl -fsSL "$URL" -o "$folder/helper.tgz" || fail "could not download $URL"
tar -xzf "$folder/helper.tgz" -C "$folder"
node "$folder/package/dist/cli.js" setup "$@"
