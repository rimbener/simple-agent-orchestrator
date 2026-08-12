#!/usr/bin/env bash
#
# CI for one review round — run ONCE per round by the workflow, never by a
# reviewer. Adds the node-target build to the slice gate, so reviewers judge a
# tree that type-checks, passes its suite, and still bundles for Node >= 20.
#
# Uses the :ci variant, which adds `--rerun-each=2`: every test file runs twice, so
# a test that only passes on a clean first pass fails here. That catches the class
# `reviewer_engineering` is told to flag by eye — order-dependent and timing-
# sensitive tests — before it reaches the mutation gate. It roughly 2.5x's the
# suite (50s -> 128s), which is why it lives here (<= 4 runs per feature) and not
# in slice-gate.sh.
set -euo pipefail

bun run typecheck
bun run test:orchestrator:ci
bun run build
