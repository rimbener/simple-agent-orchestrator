#!/usr/bin/env bash
#
# PR prep — guard the durable review trail, then commit the phase-3/4 artifacts.
#
#   finalize.sh <feature>
set -euo pipefail

. "$(dirname "$0")/_lib.sh"

feature="${1:-}"
require_feature "$feature"

script_dir="$(cd "$(dirname "$0")" && pwd)"

# Stop the docs viewer on EVERY exit, not just the happy path — the guards below
# die(), and a halted run must not leave a loopback server rooted in a worktree
# that `sao clean` will delete. Restart it any time with:
#   workflows/sao-features-orchestrator/scripts/docs-server.sh start <feature>
trap '"$script_dir/docs-server.sh" stop "$feature" >/dev/null 2>&1 || true' EXIT

# The review trail is the retro's only evidence — a missing or 0-byte artifact
# here means an agent skipped or emptied a file it was told to write and keep.
# review-slice-*.md is one file per slice (never a single accumulating file), so
# it is globbed rather than named, but at least one must exist by this point.
for f in review-spec.md review.md mutation.md dod.md; do
  p="docs/features/$feature/$f"
  if [ ! -e "$p" ]; then
    die "missing review artifact: $p — an agent never wrote the durable trail"
  fi
  if [ ! -s "$p" ]; then
    die "empty review artifact: $p — the durable trail was wiped"
  fi
done

slice_found=0
for p in "docs/features/$feature"/review-slice-*.md; do
  [ -e "$p" ] || continue
  slice_found=1
  if [ ! -s "$p" ]; then
    die "empty review artifact: $p — the durable trail was wiped"
  fi
done
[ "$slice_found" -eq 1 ] || die "missing review artifact: docs/features/$feature/review-slice-*.md — an agent never wrote the durable trail"

# review.md / mutation.md / dod.md are written by agents that never commit.
# Nothing staged is not an error — sao's own finalize auto-commit sweeps up
# whatever is left, and an unconditional `git commit` would fail the node.
git add -A
git diff --cached --quiet \
  || git commit -m "chore($feature): done — review, mutation and DoD artifacts"
