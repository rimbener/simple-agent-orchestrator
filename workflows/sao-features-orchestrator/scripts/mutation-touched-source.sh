#!/usr/bin/env bash
#
# `when_bash` predicate: exit 0 (→ run the delta re-review) only when killing
# mutants changed production source.
#
#   mutation-touched-source.sh <feature>
#
# tests/ is not src/, so this is exactly "the fix was not test-only" — a
# strengthened test changes no behavior and needs no re-review.
#
# Note the sao contract: a non-zero exit here SKIPS the node, it never fails the
# run. That is why a missing baseline still exits non-zero — but says why first.
set -euo pipefail

. "$(dirname "$0")/_lib.sh"

feature="${1:-}"
require_feature "$feature"

baseline="tmp/$feature/mut-start-sha"
[ -f "$baseline" ] || die "missing $baseline — mutation-baseline.sh did not run"

git diff --name-only "$(cat "$baseline")"..HEAD -- src | grep -qE '\.ts$'
