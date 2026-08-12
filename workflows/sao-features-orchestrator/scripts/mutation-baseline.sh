#!/usr/bin/env bash
#
# Record HEAD before the mutation phase, so the workflow can afterwards ask
# whether killing mutants changed production source (mutation-touched-source.sh).
#
#   mutation-baseline.sh <feature>
set -euo pipefail

. "$(dirname "$0")/_lib.sh"

feature="${1:-}"
require_feature "$feature"

mkdir -p "tmp/$feature"
git rev-parse HEAD > "tmp/$feature/mut-start-sha"
