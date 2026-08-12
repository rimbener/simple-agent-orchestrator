#!/usr/bin/env bash
#
# StrykerJS, scoped to this feature's changed production files.
#
#   run-mutation.sh <feature> [base-ref]     # base-ref defaults to $SAO_BASE_REF
#
# Writes the full run to tmp/<feature>/stryker.log (mutation_tester reads it) and
# echoes only the tail, so a long report never floods the node output.
#
# The flags are load-bearing — do not "simplify" them:
#   --force    stryker.conf.mjs sets `incremental: true`, so without this a mutant
#              that a NEW test now kills is still reported Survived from the cache.
#   --mutate   REPLACES the config's list rather than adding to it, which drops the
#              `!src/cli.ts` exclusion — re-applied by the grep below. cli.ts is only
#              exercised through spawned subprocesses, which `coverageAnalysis:
#              'perTest'` cannot observe, so every mutant in it would be NoCoverage.
#   --reporters clear-text
#              drops the `progress` reporter, which is noise in a non-TTY log.
set -euo pipefail

. "$(dirname "$0")/_lib.sh"

feature="${1:-}"
require_feature "$feature"

base="${2:-${SAO_BASE_REF:-}}"
[ -n "$base" ] || die "no base ref — pass one as \$2 or set SAO_BASE_REF"

mkdir -p "tmp/$feature"
log="tmp/$feature/stryker.log"

# git diff's own failure (bad $base, repo error) must halt loudly — it must never
# collapse into the same empty string as "genuinely no changed files" below.
diff_files="$(git diff --name-only "$base"...HEAD -- src)" \
  || die "git diff against base '$base' failed — bad ref or repo error"

# `|| true`: a no-match grep exits 1, which set -e would turn into a script
# failure instead of the NO_CHANGED_SOURCE branch below. git diff's own failure is
# already caught above, so this can only be swallowing a genuine empty match.
changed="$(printf '%s\n' "$diff_files" \
  | grep -E '\.ts$' \
  | grep -v '^src/cli\.ts$' \
  | paste -sd, - || true)"

if [ -z "$changed" ]; then
  echo "NO_CHANGED_SOURCE — nothing to mutate" | tee "$log"
  exit 0
fi

echo "mutating: $changed"
if ! bunx stryker run --force --mutate "$changed" \
  --reporters clear-text --logLevel warn >"$log" 2>&1; then
  echo "stryker exited non-zero — tail of $log:"
  tail -40 "$log"
  exit 1
fi

tail -40 "$log"
