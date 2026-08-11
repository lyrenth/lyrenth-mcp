#!/usr/bin/env bash
#
# Build the Claude Desktop extension bundle (lyrenth-mcp.mcpb).
#
# A .mcpb is a zip carrying the server, its production dependencies, a
# manifest, and an icon, so a user installs the MCP server by double-clicking
# instead of hand-editing a JSON config. Same code as `npx lyrenth-mcp`; only
# the delivery differs.
#
# Everything is assembled in a scratch directory, so this never disturbs the
# working tree's node_modules (which carries devDependencies the bundle must
# not ship).
#
# Usage:  ./scripts/build-mcpb.sh          # writes ./lyrenth-mcp.mcpb
#
# The output is gitignored: it is a build artifact, rebuilt from this script.
# Keep manifest.json's version in step with package.json; the check below
# fails the build if they drift, because the two are read by different
# installers and a mismatch is invisible until a user reports it.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/lyrenth-mcp.mcpb"

PKG_VERSION="$(node -p "require('./package.json').version")"
MANIFEST_VERSION="$(node -p "require('./manifest.json').version")"
if [ "$PKG_VERSION" != "$MANIFEST_VERSION" ]; then
  echo "version mismatch: package.json is $PKG_VERSION, manifest.json is $MANIFEST_VERSION" >&2
  echo "bump both together, then re-run." >&2
  exit 1
fi

echo "==> building TypeScript"
npm run --silent build

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> staging bundle in $STAGE"
mkdir -p "$STAGE/server"
cp -R dist/. "$STAGE/server/"
cp manifest.json icon.png README.md LICENSE "$STAGE/"

# Production dependencies only. `npm ci --omit=dev` in the staging directory
# resolves them from the committed lockfile, so the bundle is reproducible and
# carries no devDependencies (typescript alone is ~20MB).
#
# --ignore-scripts is required, not cosmetic: package.json carries a `prepare`
# hook that runs tsc, npm runs prepare on install, and with devDependencies
# omitted tsc is not there. Without this the install dies on "tsc: command not
# found" AFTER the build has already succeeded, which reads like a compile
# failure and is not one. The build ran above; the staging copy only needs
# dependency trees.
cp package.json package-lock.json "$STAGE/server/"
( cd "$STAGE/server" && npm ci --omit=dev --ignore-scripts --silent --no-audit --no-fund )

echo "==> packing"
rm -f "$OUT"
npx --yes @anthropic-ai/mcpb@latest pack "$STAGE" "$OUT"

echo
echo "==> verifying"
npx --yes @anthropic-ai/mcpb@latest info "$OUT"
