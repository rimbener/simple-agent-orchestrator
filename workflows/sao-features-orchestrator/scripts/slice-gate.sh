#!/usr/bin/env bash
#
# Per-slice gate: a slice is not green until types and the unit suite both pass.
# This repo has no linter — this is the whole gate.
set -euo pipefail

bun run typecheck
bun test
