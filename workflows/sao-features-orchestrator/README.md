# sao-features-orchestrator

A sao workflow that takes one feature request for **this** repo — sao itself —
from a rough sentence to a validated, PR-ready branch, with **exactly one human
approval**.

```
sao-features-orchestrator.yaml   the pipeline
agents/                        the eight personas it invokes
scripts/                       the checked-in ops every bash node calls
```

## Run it

```bash
bun run dev -- run workflows/sao-features-orchestrator/sao-features-orchestrator.yaml \
  --var feature=resume-backoff "sao resume should back off and retry a locked run"
```

`--var feature=<kebab>` names the feature — it owns `docs/features/<feature>/` and
the commit scope. The freeform text is the request, written to `story.md` at
bootstrap. `sao validate <file>` checks the workflow without running anything, and
`--dry-run` prints the resolved plan.

## The pipeline

| Phase | Nodes | What happens |
| --- | --- | --- |
| **0 — bootstrap** | `bootstrap`, `grill-user-story` | seed `docs/features/<feature>/`, record the raw request, then grill the human into a structured `user-story.md` |
| **1 — spec** | `grill-and-spec`, `spec-review`, `spec-fixes`, `approve-spec`, `commit-spec` | grill the solution, write the spec bundle + Gherkin contract, review it once automatically, fix every finding, then **the one human approval** |
| **2 — build** | `build-slices` | one vertical slice per iteration: implement (TDD) → gate → review → fix → commit |
| **3 — quality** | `full-review`, `mutation-baseline`, `mutation`, `post-mutation-review` | full review (≤ 2 rounds), then mutation (≤ 2 rounds); if killing mutants changed `src/`, re-review that delta |
| **4 — DoD** | `dod`, `finalize` | validate the Definition of Done, close gaps, guard the review trail, commit |

Every gate is **escalate, never fake**: a loop that hits `max_iterations` halts the
run rather than declaring success. That halt is the escalation — fix whatever is
stuck and continue with `sao resume <run-id>`.

There is no separate harness. `base:` + `--base` cut the worktree and branch,
`state.json` carries the phase, and the node graph is the sequencing.

## Agents

| Agent | Model | Role |
| --- | --- | --- |
| `story_partner` | opus | owns the **problem** — grills who/what/why/success into `user-story.md`. Never designs |
| `spec_partner` | opus | owns the **solution** — grills the surfaces, error contract, resume and runner semantics; writes the spec bundle + Gherkin. Starts where the user story stops |
| `spec_reviewer` | sonnet | vets the bundle once, pre-gate: testability, traceability, non-goal collisions, unjustified dependencies |
| `implementer` | sonnet | the **only** agent that edits code. Strict TDD, one slice at a time |
| `reviewer_slice` | sonnet | per-slice: correctness, repo rules, CLI surface, docs parity. One round |
| `reviewer_engineering` | sonnet | the sole full reviewer: code · architecture · performance · security |
| `mutation_tester` | haiku | reports the Stryker run faithfully. Measures only |
| `dod_validator` | haiku | re-runs every objective check and writes `dod.md`. Validates only |

Agents are referenced by **path** (`agent: ./agents/spec_partner.md`) so they
resolve relative to the workflow file rather than to the repo's own
`.agents/agents/`, which holds a separate, terser set.

### Prompts live in the agents, not the YAML

Every node prompt is just `Feature: {{feature}}. Mode: <mode>.` — the procedure for
each mode lives in the agent's own **Modes** table, including when to emit the
loop's completion signal. Only three prompts carry anything more, and only because
the value is genuinely per-run: `{{task}}` (the raw request) and `{{loop.feedback}}`
(the human's last answer) cannot come from an agent file, since agent bodies are
used verbatim with **no `{{...}}` interpolation**.

The modes:

| Agent | Modes |
| --- | --- |
| `story_partner` | `interview` |
| `spec_partner` | `write-bundle` · `fix-spec-findings` · `present-for-approval` |
| `spec_reviewer` | `review` |
| `implementer` | `build-slice` · `fix-slice-findings` · `fix-review-findings` · `kill-mutants` · `close-dod-gaps` |
| `reviewer_slice` | `review-slice` |
| `reviewer_engineering` | `full-review` · `delta-review` |
| `mutation_tester` | `report` |
| `dod_validator` | `validate` |

In a multi-step loop the engine appends the sentinel instruction to the **last AI
step only**, so exactly one mode per loop owns the completion signal — in every
loop here that is the `implementer` step that closes the round.

`story_partner` and `spec_partner` both grill the human back to back, so the
boundary between them is enforced in both files: the story owns the problem, the
spec owns the solution, and `spec_partner` may not re-ask anything `user-story.md`
already answers.

## Scripts index

Every bash node is a one-line call into `scripts/`; no shell logic lives in the
YAML. Each script is runnable and testable on its own.

| Script | Called by | Does |
| --- | --- | --- |
| `bootstrap.sh <feature>` | `bootstrap` | `bun install`, excludes `tmp/` from git, seeds `docs/features/<feature>/`, records the request as `story.md`, first commit. **Reads the request from stdin**, never argv — it is freeform human text. Stages only `story.md`, so the first commit is exactly the seeded request |
| `commit-spec.sh <feature>` | `commit-spec` | commits the approved spec bundle. Unconditional by design: nothing to commit means the bundle was never written |
| `slice-gate.sh` | `build-slices` step 2 | `bun run typecheck` + `bun test` — the whole per-slice gate (this repo has no linter) |
| `review-ci.sh` | `full-review` / `post-mutation-review` step 1 | the slice gate plus `bun run build`, so reviewers judge a tree that still bundles for Node ≥ 20. Run **once per round** by the workflow, never by a reviewer |
| `mutation-baseline.sh <feature>` | `mutation-baseline` | records HEAD to `tmp/<feature>/mut-start-sha` |
| `run-mutation.sh <feature> [base]` | `mutation` step 1 | Stryker scoped to the changed `src/` files; writes `tmp/<feature>/stryker.log`, echoes only the tail. Header documents why `--force` and the hand-re-applied `!src/cli.ts` exclusion are load-bearing |
| `mutation-touched-source.sh <feature>` | `post-mutation-review` `when_bash` | exit 0 only if killing mutants changed `src/`. Non-zero **skips** the node — that is sao's `when_bash` contract, not a failure |
| `finalize.sh <feature>` | `finalize` | fails on any 0-byte review artifact, then commits the phase-3/4 docs (skipping the commit when nothing is staged) |
| `_lib.sh` | sourced by the rest | `die()` and `require_feature()` — the feature name becomes a path segment, so it is pattern-validated before any `join`, the same discipline `RUN_ID_PATTERN` applies to run ids in [`src/state.ts`](../../src/state.ts) |

Bash nodes run with the **run worktree** as cwd, so these relative paths resolve
inside the worktree — which means the scripts must exist on the run's base ref.
Cutting a run from a `--base` older than this directory will fail at `bootstrap`.

## The graph is fully serial

Every node declares a `depends_on`, so nothing runs concurrently — deliberately.
The two interactive grillings (`grill-user-story`, `grill-and-spec`) read the
human's answers from stdin, and any node streaming output alongside them would
interleave with the question being asked.

## Artifacts

Everything lands in `docs/features/<feature>/`, and every review file is a
**durable trail** — findings marked `open`/`resolved`, never emptied, never
per-round copies. `finalize.sh` fails the run if any of them is 0 bytes, and
`dod_validator` fails a wiped review file, because the trail is the only evidence a
retro has.

```
story.md         the raw request, verbatim
user-story.md    the grilled user story
spec.md          terse overview (≤ ~4 KB)
tasks.md         task index, by slice
task-1..N.md     one atomic task each
gherkin-scenarios.md   the @s acceptance contract
review-spec.md   pre-gate spec review
tdd.md           the @s → test map (≤ 8 000 bytes)
review-slice.md  per-slice review trail
review.md        full review trail
mutation.md      score + surviving mutants
dod.md           the Definition of Done checklist
```

`tmp/<feature>/` holds run scratch (`mut-start-sha`, `stryker.log`) and is excluded
from git by `bootstrap.sh`, so it never reaches the PR diff.
