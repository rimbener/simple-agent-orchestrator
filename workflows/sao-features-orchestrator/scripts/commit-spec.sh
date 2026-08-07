#!/usr/bin/env bash
#
# Commit the spec bundle the human approved at the pipeline's one gate.
#
#   commit-spec.sh <feature>
#
# Deliberately unconditional: nothing to commit here means spec_partner never
# wrote the bundle, and halting the run is the correct signal.
set -euo pipefail

. "$(dirname "$0")/_lib.sh"

feature="${1:-}"
require_feature "$feature"

git add "docs/features/$feature"
git commit -m "docs($feature): approved spec + gherkin contract"
