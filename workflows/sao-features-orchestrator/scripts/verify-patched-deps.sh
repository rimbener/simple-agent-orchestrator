#!/usr/bin/env bash
#
# Assert the tree was installed with bun and every patch in patches/ actually
# landed in node_modules. Runs at the top of every gate — it is a few greps.
#
# This exists because of a real, expensive failure. Something ran `pnpm install` in
# a run worktree. pnpm reads `pnpm.patchedDependencies`; this repo declares the
# patch under bun's top-level `patchedDependencies`, so pnpm silently ignored it.
# The unpatched @zed-industries/agent-client-protocol then sent `session/set_mode`
# where `session/set_model` was meant, two opencode tests hung to their 5s timeout,
# and StrykerJS — which refuses to start on a red suite — could not run at all. The
# symptom (a mutation gate that never runs) is several steps from the cause (a
# lockfile), so the loop below turns it into one line of output.
set -euo pipefail

# A foreign lockfile means a foreign installer touched this tree. bun.lock is the
# only one this repo ships.
for stray in pnpm-lock.yaml yarn.lock package-lock.json; do
  [ -e "$stray" ] && {
    echo "error: $stray present — this repo installs with bun, and another package" >&2
    echo "       manager will not apply patches/ (bun's patchedDependencies key is" >&2
    echo "       bun-specific). Remove it and re-run 'bun install'." >&2
    exit 1
  }
done

[ -d patches ] || exit 0

for patch in patches/*.patch; do
  [ -e "$patch" ] || continue

  # `+++ b/dist/acp.js` -> dist/acp.js — the file the patch edits, relative to the
  # package root.
  target="$(awk '/^\+\+\+ b\//{ sub(/^\+\+\+ b\//, ""); print; exit }' "$patch")"
  # patches/@zed-industries%2Fagent-client-protocol@0.4.5.patch -> the package dir.
  # %2F is an encoded "/" in the scoped name; the trailing @version is not a path.
  pkg="$(basename "$patch" .patch)"
  pkg="${pkg%@*}"
  pkg="${pkg//%2F//}"

  installed="node_modules/$pkg/$target"
  [ -n "$target" ] && [ -f "$installed" ] || {
    echo "error: $patch targets $pkg/$target, which is not installed" >&2
    exit 1
  }

  # The first added line of the patch. If it is absent from the installed file, the
  # patch did not apply — whatever the lockfile claims.
  added="$(awk '/^\+[^+]/{ sub(/^\+/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); print; exit }' "$patch")"
  [ -n "$added" ] || {
    echo "error: $patch has no added lines — cannot verify it applied" >&2
    exit 1
  }

  grep -qF "$added" "$installed" || {
    echo "error: $patch did NOT apply to $installed" >&2
    echo "       expected to find: $added" >&2
    echo "       run 'bun install' (and check no other package manager ran here)." >&2
    exit 1
  }
done

echo "patched deps ok"
