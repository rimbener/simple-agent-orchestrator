#!/usr/bin/env bash
#
# Shared helpers for the sao-features-orchestrator scripts. Sourced, never executed.

die() {
  echo "error: $*" >&2
  exit 1
}

# The feature name becomes a path segment (docs/features/<feature>, tmp/<feature>)
# and a commit scope, so it is validated before it is ever joined into a path —
# the same discipline RUN_ID_PATTERN applies to run ids in src/state.ts.
require_feature() {
  [ -n "${1:-}" ] || die "missing <feature> argument"
  case "$1" in
    -*) die "invalid feature name '$1' — must not start with '-'" ;;
    *[!a-z0-9-]*) die "invalid feature name '$1' — use kebab-case [a-z0-9-]" ;;
  esac
}
