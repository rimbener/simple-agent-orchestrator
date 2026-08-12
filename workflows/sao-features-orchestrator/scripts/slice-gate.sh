#!/usr/bin/env bash
#
# Per-slice gate: a slice is not green until types and the unit suite both pass.
# This repo has no linter — this is the whole gate.
#
# `test:orchestrator` is plain `bun test` plus --only-failures: passing tests are
# hidden, which changes neither selection nor exit code but keeps 650+ green lines
# out of the agent's context. Deliberately NOT the :ci variant — this runs up to
# once per slice (8 iterations), and --rerun-each would add ~17 min per feature on
# the inner loop for a signal that belongs in the review round.
set -euo pipefail

bun run typecheck
bun run test:orchestrator
