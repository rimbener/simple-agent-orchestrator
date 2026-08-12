# Known issues — sao-features-orchestrator

Deferred findings from review. Each needs a human decision or a larger effort
than a workflow/agent-file edit, so they are recorded here rather than fixed in
place. Update this file as items are resolved — don't empty it.

## 1. `{{feature}}` isn't pattern-validated before it reaches a shell

Every script-invoking node splices `"{{feature}}"` into a bash template
(`bootstrap.sh "{{feature}}" <<...`, `run-mutation.sh "{{feature}}"`, etc.).
That template is raw-interpolated by the engine and handed whole to `sh -c`
(`src/nodes.ts`'s `runShell`) — so a `feature` value containing a `"` can break
out of the quotes and run shell **before** `_lib.sh`'s `require_feature` (the
kebab-case check) ever runs inside the spawned script. By the time the script's
own validation would reject it, the injection already happened.

`src/schema.ts`'s `inputSchema` has no value-pattern field — only the workflow
`inputs:` **name** is regex-checked (`INPUT_NAME_PATTERN`), never the value a
`--var` supplies at run time. There is no existing engine hook a workflow author
can use to validate an input's value before it is first interpolated.

**Why this is deferred, not fixed:** closing it properly means adding a
value-pattern option to `inputSchema` (e.g. `pattern:` on an `inputs:` entry) —
a new config surface in `src/schema.ts`. Per this repo's minimalism rule, that's
a human decision (implementer.md rule 1), not something to add unilaterally
while fixing workflow files.

**Options, for whoever picks this up:**
- Add `pattern:` (a regex string) to the `inputs:` schema, validated at parse
  time (`sao validate`) before any node's template is ever interpolated — closes
  it for every workflow, not just this one.
- Or: narrower, sao-features-orchestrator-only mitigation — none exists without
  the engine change, since every node that uses `{{feature}}` runs a bash
  template, and `sh -c` sees the fully-interpolated string before any script
  code executes.

**Current mitigation:** none beyond documentation. In practice `feature` is
supplied by the human invoking `sao run ... --var feature=<kebab-name>` on
their own machine — the same trust boundary as any other CLI flag they type —
so this is a defense-in-depth gap, not demonstrated to be reachable by a less-
trusted caller today. It becomes a real risk the moment something automated
(a bot, a webhook-driven caller) starts supplying `feature` on this workflow's
behalf.

## 2. No automated test coverage for `scripts/*.sh`

`bootstrap.sh`, `_lib.sh`, `run-mutation.sh`, `mutation-touched-source.sh`,
`review-ci.sh`, `commit-spec.sh`, `slice-gate.sh`, `finalize.sh`,
`mutation-baseline.sh` have no test suite. The `NO_CHANGED_SOURCE` /
git-diff-error-swallowing bug fixed in `run-mutation.sh` (see git history) would
have been caught by a test exercising that branch — it wasn't, because nothing
runs these scripts in CI.

**Why this is deferred:** it's a genuine gap, but writing test infrastructure
for bash scripts (a runner, fixtures — likely a temp git repo per test, given
every script assumes a git worktree) is a separate, sizable effort, not a
fix-in-place alongside a doc/workflow edit.

**Scope for whoever picks this up:** at minimum, cover the branches that have
already produced real bugs — `run-mutation.sh`'s three exit paths (clean
mutate, `NO_CHANGED_SOURCE`, and a genuine `git diff` failure) and
`mutation-touched-source.sh`'s predicate (src touched / not touched / missing
baseline).
