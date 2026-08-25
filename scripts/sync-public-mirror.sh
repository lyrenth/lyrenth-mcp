#!/usr/bin/env bash
#
# Project this directory onto the public mirror working tree.
#
#   npm run sync:mirror        from integrations/lyrenth-mcp
#
# THE RULE (owner, 2026-08-25): integrations/lyrenth-mcp in the monorepo
# is the single source of truth. The public repo
# github.com/lyrenth/lyrenth-mcp is a projection of it, never edited by
# hand. Every change lands here first, then this script copies it out,
# then the owner commits and pushes the mirror. The C-grade scan that
# prompted this rule happened because the mirror had drifted a full
# refactor behind the source.
#
# What it does:
#   1. Refuses to run if the mirror has uncommitted changes, so nothing
#      hand-edited there is silently destroyed (--force overrides, and
#      means "the source already contains everything I care about").
#   2. Builds, then runs the version and tool-surface checks. A tree
#      that fails its own preflight does not get projected.
#   3. rsync --delete of the tracked file set. Anything in the mirror
#      that the source does not have is removed; that is the point.
#
# Never copied: key.pem (the .mcpb signing key: PRIVATE, gitignored
# here, and one sync of it to a public repo is unrecoverable), the
# built .mcpb bundle (release artifact, distributed via Releases),
# node_modules, and the two git trees.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIRROR="${LYRENTH_MCP_MIRROR:-$HOME/servers/lyrenth-mcp-public}"

if [[ ! -d "$MIRROR/.git" ]]; then
    echo "mirror not found at $MIRROR (set LYRENTH_MCP_MIRROR to override)" >&2
    exit 1
fi

if [[ "${1:-}" != "--force" ]] && [[ -n "$(git -C "$MIRROR" status --porcelain)" ]]; then
    echo "mirror at $MIRROR has uncommitted changes:" >&2
    git -C "$MIRROR" status --short >&2
    echo >&2
    echo "If the source already contains everything you care about, re-run" >&2
    echo "with --force. Otherwise port the mirror-side edits into the" >&2
    echo "source first; the mirror is never the place to keep work." >&2
    exit 1
fi

echo "== preflight in the source of truth =="
(cd "$SRC" && npm run preflight)

echo "== projecting onto $MIRROR =="
rsync -a --delete \
    --exclude ".git/" \
    --exclude "node_modules/" \
    --exclude "key.pem" \
    --exclude "*.pem" \
    --exclude "*.mcpb" \
    "$SRC/" "$MIRROR/"

echo "== result =="
git -C "$MIRROR" status --short
echo
echo "Review with: git -C $MIRROR diff"
echo "The owner commits and pushes the mirror; the sync never does."
