#!/usr/bin/env bash
#
# CI for one review round — run ONCE per round by the workflow, never by a
# reviewer. Adds the node-target build to the slice gate, so reviewers judge a
# tree that type-checks, passes its suite, and still bundles for Node >= 20.
set -euo pipefail

bun run typecheck
bun test
bun run build
