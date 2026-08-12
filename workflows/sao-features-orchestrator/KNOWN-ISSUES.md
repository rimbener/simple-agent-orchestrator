# Known issues — sao-features-orchestrator

Deferred findings from review. Each needs a human decision or a larger effort
than a workflow/agent-file edit, so they are recorded here rather than fixed in
place. Update this file as items are resolved — don't empty it.

## 1. `{{feature}}` shell-quoting — RESOLVED

Previously: every script-invoking node spliced `"{{feature}}"` directly into a
bash template (`bootstrap.sh "{{feature}}" <<...`, etc.), raw-interpolated by
the engine and handed whole to `sh -c` — so a `feature` value containing a `"`
could break out of the quotes and run shell **before** `_lib.sh`'s
`require_feature` ever ran inside the spawned script.

This was deferred here first on the (wrong) premise that closing it needed an
engine change. It doesn't: every `bash`/`when_bash` site that touches
`{{feature}}` now captures it through a heredoc into a shell variable —
`read -r feature <<'SAO_FEATURE_EOF_{{run_id}}' ... SAO_FEATURE_EOF_{{run_id}}`
— then passes `"$feature"`, the same pattern already used for `{{task}}`. A
heredoc body is never re-parsed as shell syntax, so this holds regardless of
what characters the value contains; double-quoted variable expansion never
re-opens shell parsing either. Verified empirically (a `feature` value crafted
to break out of `"..."` quoting produces no injection through the new path,
where the same value against the old direct-splice path did). See the
`bootstrap` node's comment in `sao-features-orchestrator.yaml` for the pattern.

## 2. Heredoc delimiter collision — narrowed, not eliminated

Every `{{task}}`/`{{feature}}` heredoc delimiter is keyed to `{{run_id}}`
(`SAO_..._EOF_{{run_id}}`) rather than a fixed string, so a value containing a
line that matches the delimiter can't close the heredoc early and run the rest
of the value as shell **by accident**, and can't do so **deliberately** either
without already knowing `run_id` — which doesn't exist until the run starts,
after `{{task}}`/`{{feature}}` are already fixed on the CLI.

This narrows the risk, it doesn't eliminate it: `run_id` is
`<timestamp-to-the-minute>-<sanitized-workflow-name-slug>-<2 random bytes as
hex>` (`src/state.ts`'s `createRunId`) — roughly 16 bits of real entropy per
run. An attacker who also controls when the run starts (tight enough to guess
the minute) and can read this file could still construct a value that collides
a specific future run's delimiter. Nothing currently checks the interpolated
value for an embedded copy of its own delimiter before the heredoc runs, either
(that check would itself need to run before the vulnerable heredoc — a
chicken-and-egg this workflow-file-only fix doesn't resolve).

**Why this is deferred:** closing it outright needs the engine to give bash
nodes a real stdin channel, so a multi-line value never has to be embedded as
literal script text at all — `src/nodes.ts`'s `runShell` hardcodes
`stdio: ["ignore", "pipe", "pipe"]`, with no path from a workflow file to a
node's real subprocess stdin today. That's an engine change, not a workflow fix.

**Current mitigation:** `{{run_id}}`-keyed delimiters everywhere `{{task}}` or
`{{feature}}` enter a heredoc (both the `bootstrap` node and every node in
Known Issue #1's fix).

## 3. No automated test coverage for `scripts/*.sh`

`bootstrap.sh`, `_lib.sh`, `run-mutation.sh`, `mutation-touched-source.sh`,
`review-ci.sh`, `commit-spec.sh`, `slice-gate.sh`, `finalize.sh`,
`mutation-baseline.sh` have no test suite. The `NO_CHANGED_SOURCE` /
git-diff-error-swallowing bug fixed in `run-mutation.sh`, and the matching
fail-open fix in `mutation-touched-source.sh` (see git history), would have
been caught by a test exercising those branches — they weren't, because
nothing runs these scripts in CI.

**Why this is deferred:** it's a genuine gap, but writing test infrastructure
for bash scripts (a runner, fixtures — likely a temp git repo per test, given
every script assumes a git worktree) is a separate, sizable effort, not a
fix-in-place alongside a doc/workflow edit.

**Scope for whoever picks this up:** at minimum, cover the branches that have
already produced real bugs — `run-mutation.sh`'s three exit paths (clean
mutate, `NO_CHANGED_SOURCE`, and a genuine `git diff` failure) and
`mutation-touched-source.sh`'s three-way predicate (src touched / not touched /
can't tell, which must exit 0).
