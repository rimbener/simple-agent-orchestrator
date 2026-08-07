#!/usr/bin/env bash
#
# Phase 0 — prepare the run worktree for one feature.
#
#   bootstrap.sh <feature>        # the feature request is read from STDIN
#
# Installs dependencies, keeps tmp/ scratch out of git, seeds
# docs/features/<feature>/, and records the request as story.md in the run
# branch's first commit.
set -euo pipefail

. "$(dirname "$0")/_lib.sh"

feature="${1:-}"
require_feature "$feature"

bun install

# Keep tmp/ (mut-start-sha, stryker.log) out of `git add -A` and out of sao's own
# finalize auto-commit, so scratch never reaches the PR diff. `--git-path` resolves
# to the MAIN repo's shared .git/info/exclude — a linked worktree has no private
# one — so this outlives the run: guard it the way sao's own ensureGitExclude does
# (src/state.ts).
exclude="$(git rev-parse --git-path info/exclude)"
grep -qxF "tmp/" "$exclude" 2>/dev/null || echo "tmp/" >> "$exclude"

mkdir -p "docs/features/$feature" "tmp/$feature"

# The request arrives on STDIN, never argv: it is freeform human text and may
# contain quotes, newlines, or anything else a shell would try to interpret.
{
  echo "# $feature"
  echo
  cat
} > "docs/features/$feature/story.md"

# Stage ONLY the file this script wrote, so the run's first commit is exactly the
# seeded request and nothing else. Any `bun install` lockfile churn is left dirty
# and lands in a later commit (commit-spec.sh, or sao's finalize auto-commit).
git add "docs/features/$feature/story.md"
git commit -m "chore($feature): start — seed feature docs"
