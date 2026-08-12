#!/usr/bin/env bash
#
# `when_bash` predicate: exit 0 (→ run the delta re-review) when killing mutants
# changed production source — OR when this script cannot tell for sure.
#
#   mutation-touched-source.sh <feature>
#
# tests/ is not src/, so "touched" is exactly "the fix was not test-only" — a
# strengthened test changes no behavior and needs no re-review.
#
# The sao contract: a non-zero exit here SKIPS the node, it never fails the run —
# and `when_bash` has no channel to distinguish "legitimately false" from
# "errored"; the engine treats every non-zero exit as the former (src/nodes.ts
# `evaluateWhenBash`). So every error path below exits 0 (run the review) rather
# than non-zero (skip it): a missing baseline or a failed git diff must never
# collapse into the same "nothing to review" outcome as a genuine test-only fix.
# `reviewer_engineering`'s delta-review mode computes the same diff itself and
# will surface a missing/corrupt baseline as a finding — a far better outcome
# than this predicate silently skipping a review a real src/ change needed.
set -euo pipefail

. "$(dirname "$0")/_lib.sh"

feature="${1:-}"
require_feature "$feature"

baseline="tmp/$feature/mut-start-sha"
if [ ! -f "$baseline" ]; then
  echo "warning: missing $baseline — mutation-baseline.sh did not run; running the delta review to be safe" >&2
  exit 0
fi

if ! touched="$(git diff --name-only "$(cat "$baseline")"..HEAD -- src)"; then
  echo "warning: git diff against baseline $(cat "$baseline") failed — running the delta review to be safe" >&2
  exit 0
fi

printf '%s\n' "$touched" | grep -qE '\.ts$'
