#!/usr/bin/env bash
#
# PR prep — guard the durable review trail, then commit the phase-3/4 artifacts.
#
#   finalize.sh <feature>
set -euo pipefail

. "$(dirname "$0")/_lib.sh"

feature="${1:-}"
require_feature "$feature"

# The review trail is the retro's only evidence — a 0-byte artifact here means an
# agent emptied a file it was told to keep.
for f in review-spec.md review-slice.md review.md mutation.md dod.md; do
  p="docs/features/$feature/$f"
  if [ -e "$p" ] && [ ! -s "$p" ]; then
    die "empty review artifact: $p — the durable trail was wiped"
  fi
done

# review.md / mutation.md / dod.md are written by agents that never commit.
# Nothing staged is not an error — sao's own finalize auto-commit sweeps up
# whatever is left, and an unconditional `git commit` would fail the node.
git add -A
git diff --cached --quiet \
  || git commit -m "chore($feature): done — review, mutation and DoD artifacts"
