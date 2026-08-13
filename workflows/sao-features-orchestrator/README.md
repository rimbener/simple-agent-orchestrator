# sao-features-orchestrator

A sao workflow that takes one feature request for **this** repo — sao itself —
from a rough sentence to a validated, PR-ready branch, with **one human sign-off
on the spec** (`approve-spec`) as the pipeline's only content-approval gate.

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
| **1 — spec** | `grill-and-spec`, `spec-review`, `spec-fixes`, `approve-spec`, `commit-spec` | grill the solution, write the spec bundle + Gherkin contract, review it once automatically, fix every finding, then **the one content sign-off** |
| **2 — build** | `build-slices` | one vertical slice per iteration: implement (TDD) → gate → review → fix → commit |
| **3 — quality** | `full-review`, `mutation-baseline`, `mutation`, `post-mutation-review` | full review (≤ 2 rounds), then mutation (≤ 2 rounds); if killing mutants changed `src/`, re-review that delta |
| **4 — DoD** | `dod`, `finalize` | validate the Definition of Done, close gaps, guard the review trail, commit |

Every gate is **escalate, never fake**: a loop that hits `max_iterations` halts the
run rather than declaring success. That halt is the escalation — fix whatever is
stuck and continue with `sao resume <run-id>`.

Three rules exist because real runs walked straight through them:

- **The mutation gate is 100 % killed *and* zero `NoCoverage`, on the overall
  score.** Stryker also prints a "based on covered code" score, and that one can read
  100 % while whole functions sit untested. A `NoCoverage` mutant routes to the
  implementer exactly like a survivor, and fails the DoD exactly like one.
- **Every dependency added, upgraded or patched gets a written verdict.** A
  `patchedDependencies` entry or a file under `patches/` is unreviewed third-party
  code the repo now maintains; both reviewers must name it, and `dod_validator`
  fails a patch that `review.md` never mentions.
- **A run cut from anything but the branch you are standing on cannot bootstrap.**
  The workflow declares **no `base:`**, so each run is cut from the **current HEAD** —
  whatever branch you are standing on, including this pipeline itself before it is
  merged. There is no separate harness: sao cuts the worktree and branch,
  `state.json` carries the phase, and the node graph is the sequencing. Cutting from
  anything else would leave the worktree without `workflows/`, and `bootstrap` dies
  with exit 127. Override for one run with `--base <ref>`.

## Agents

| Agent | Model | Role |
| --- | --- | --- |
| `story_partner` | opus | owns the **problem** — grills who/what/why/success into `user-story.md`. Never designs |
| `spec_partner` | opus | owns the **solution** — grills the surfaces, error contract, resume and runner semantics; writes the spec bundle + Gherkin. Starts where the user story stops |
| `spec_reviewer` | sonnet | vets the bundle once, pre-gate: testability, traceability, non-goal collisions, unjustified dependencies |
| `implementer` | sonnet | the **only** agent that edits code. Strict TDD, one slice at a time |
| `reviewer_slice` | sonnet | per-slice: correctness, repo rules, CLI surface, docs parity. One round |
| `reviewer_engineering` | sonnet | the sole full reviewer: code · architecture · performance · security |
| `mutation_tester` | haiku | reports the Stryker run faithfully — survivors **and** uncovered mutants. Measures only |
| `dod_validator` | haiku | re-runs every objective check and writes `dod.md`. Validates only |

Agents are referenced by **path** (`agent: ./agents/spec_partner.md`) so they
resolve relative to the workflow file rather than to the repo's own
`.agents/agents/`, which holds a separate, terser set.

### Permissions

`claude -p` is headless, so anything Claude Code marks *"requires approval"* is
auto-denied — there is no human on the other end. Two separate gates matter, and
they are easy to confuse:

- **The Bash sandbox.** Under `acceptEdits`, file edits and non-network Bash
  (`bun test`) run fine, but a command that must leave the sandbox — `bun add`,
  `npm view`, `curl` — is denied.
- **Tool permissions.** `WebSearch` and `WebFetch` are Claude Code *tools*, not
  shell commands; they never touch the Bash sandbox, and are gated separately.
  Both are permission-gated, so headless denies them unless allow-listed.

`allowed_tools` (forwarded as `--allowedTools`) is the lever for both, and it is
**additive** to `permission_mode` — listing a tool pre-approves it without
restricting the agent to only that list. No agent uses `bypassPermissions`.

| Agent | Effective grant |
| --- | --- |
| `implementer` | `WebSearch`, `WebFetch`, `Bash(bun add:*)`, `Bash(bun install:*)`, `Bash(bun remove:*)` |
| everyone else | `WebSearch`, `WebFetch` |

> ⚠ **The cascade is override, not merge.** [`engine.ts`](../../src/engine.ts) resolves
> `allowed_tools` with a `??` chain, so the first non-nullish wins. An agent that
> declares its own list **silently loses** `defaults.allowed_tools` — which is why
> `implementer.md` repeats `WebSearch` and `WebFetch`. Adding an entry to the
> workflow defaults means adding it to every agent that has its own list.

Bash **nodes** are unaffected by any of this: sao runs those itself via `sh -c`,
outside Claude Code's permission system entirely. That is why `bootstrap.sh`'s
`bun install` works while an agent's `bun add` did not.

Only `implementer` installs dependencies, so only it gets the sandbox escape, and
only for the three package commands. A *new* network need — `npm view`, a `curl` to
some registry — will block a slice until you add a line here. That is the deliberate
trade for not handing out `bypassPermissions`. What contains the implementer is the
run's own git worktree and branch: it cannot touch your checkout, and you review the
diff before merging.

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
| `bootstrap.sh <feature>` | `bootstrap` | `bun install`, excludes `tmp/` from git, seeds `docs/features/<feature>/`, records the request as `story.md`, first commit. **Reads the request from stdin**, never argv — it is freeform human text. Stages only `story.md`, so the first commit is exactly the seeded request. Last thing it does is bring up the docs viewer, so its URL is the final line before the first question |
| `docs-server.sh {start\|ensure\|url\|stop} <feature>` | `bootstrap` / `finalize` / `story_partner` / `spec_partner` | serves the run worktree on a loopback port so [`docs/spec-viewer.html`](../../docs/spec-viewer.html) can render `docs/features/<feature>/` while the agents write it — the page polls, so it live-reloads. Prints the URL for the human to click, and `story_partner` / `spec_partner` repeat it on every question by calling `ensure` — idempotent, prints the URL alone, and restarts a server that died, which is the only safe way to get it: `sao resume` does not re-run `bootstrap`, and a SIGKILL or a reboot leaves `docs-server.url` naming a process that is gone. Both agents pre-approve exactly this script in their `allowed_tools`. Port is OS-assigned, so concurrent runs never collide. Once the feature name validates it never fails the node — a viewer that won't start warns and the run continues |
| `commit-spec.sh <feature>` | `commit-spec` | commits the approved spec bundle. Unconditional by design: nothing to commit means the bundle was never written |
| `slice-gate.sh` | `build-slices` step 2 | `bun run typecheck` + `bun run test:orchestrator` — the whole per-slice gate (this repo has no linter) |
| `review-ci.sh` | `full-review` / `post-mutation-review` step 1 | the slice gate at `test:orchestrator:ci` strength, plus `bun run build`, so reviewers judge a tree that still bundles for Node ≥ 20. Run **once per round** by the workflow, never by a reviewer |
| `mutation-baseline.sh <feature>` | `mutation-baseline` | records HEAD to `tmp/<feature>/mut-start-sha` |
| `run-mutation.sh <feature> [base]` | `mutation` step 1 | Stryker scoped to the changed `src/` files; writes `tmp/<feature>/stryker.log`, echoes only the tail. Header documents why `--force` and the hand-re-applied `!src/cli.ts` exclusion are load-bearing |
| `mutation-touched-source.sh <feature>` | `post-mutation-review` `when_bash` | exit 0 if killing mutants changed `src/`, **or** if the script can't tell (missing baseline, failed `git diff`) — errors run the review rather than risk skipping one a real change needed. Non-zero **skips** the node — that is sao's `when_bash` contract, not a failure |
| `finalize.sh <feature>` | `finalize` | fails on any 0-byte review artifact, then commits the phase-3/4 docs (skipping the commit when nothing is staged). Stops the docs viewer from an `EXIT` trap, so a `die()` on a missing artifact stops it too — it is rooted in a worktree `sao clean` will remove |
| `_lib.sh` | sourced by the rest | `die()` and `require_feature()` — the feature name becomes a path segment, so it is pattern-validated before any `join`, the same discipline `RUN_ID_PATTERN` applies to run ids in [`src/state.ts`](../../src/state.ts) |

### Two suite scripts

The gates never call `bun test` directly — they call one of two `package.json`
scripts, so the flags live in one place and every agent reads the same green.

| Script | Flags | Where | Why |
| --- | --- | --- | --- |
| `test:orchestrator` | `--only-failures` | `slice-gate.sh` (≤ 8 runs) | display-only: hides 650+ passing lines from the agent's context without touching selection or exit code |
| `test:orchestrator:ci` | `+ --rerun-each=2` | `review-ci.sh` (≤ 4 runs), `dod_validator` | runs every file **twice**, failing tests that only pass on a clean first pass. ~2.5× the suite (50s → 128s), so it stays off the inner loop |

Neither passes `--pass-with-no-tests`. Bun already exits **1** when it finds no
tests, and in a pipeline built on *escalate, never fake* that default is load-bearing:
a deleted file, a bad glob or a wiped `tests/` must fail the gate, not pass it.

`--rerun-each=2` doubles the reported counts (654 tests report as 1308) — that is the
flag, not suite growth, and `dod_validator` is told so before it records them.

Bash nodes run with the **run worktree** as cwd, so these relative paths resolve
inside the worktree — which means the scripts must be **committed** on the run's
base ref. A worktree contains tracked files only, so uncommitted or untracked
scripts, or a `--base` older than this directory, fail at `bootstrap` with exit
127 (`sh` cannot find the file). Cutting from HEAD makes that the default-correct
case; `sao validate` and `--dry-run` cannot catch it, because they resolve against
your main checkout, where the files are always present.

## The graph is fully serial

Every node declares a `depends_on`, so nothing runs concurrently — deliberately.
The two interactive grillings (`grill-user-story`, `grill-and-spec`) read the
human's answers from stdin, and any node streaming output alongside them would
interleave with the question being asked.

## Artifacts

Everything lands in `docs/features/<feature>/`, and every review file is a
**durable trail** — findings marked `open`/`resolved`, never emptied. `review.md`,
`review-spec.md`, `mutation.md` and `dod.md` accumulate across rounds in one file
each; `tdd-N.md` and `review-slice-N.md` are the exception — one pair **per
slice**, by design, so each build iteration's context stays small and scoped to
that slice's own diff, rather than one growing file across every slice. `finalize.sh`
fails the run if any present file (including every `review-slice-N.md`) is 0 bytes,
and `dod_validator` fails a wiped review file, because the trail is the only
evidence a retro has.

```
story.md               the raw request, verbatim
user-story.md          the grilled user story
spec.md                terse overview (≤ ~4 KB)
tasks.md               task index, by slice
task-1..N.md           one atomic task each
gherkin-scenarios.md   the @s acceptance contract
review-spec.md         pre-gate spec review
tdd-1..N.md            per-slice @s → test map
review-slice-1..N.md   per-slice review trail (one file per slice)
review.md              full review trail
mutation.md            score + surviving mutants
dod.md                 the Definition of Done checklist
```

`tmp/<feature>/` holds run scratch (`mut-start-sha`, `stryker.log`) and is excluded
from git by `bootstrap.sh`, so it never reaches the PR diff.
