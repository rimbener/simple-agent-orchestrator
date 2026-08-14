# interactive-select-prompts — spec review

Verdict: **CHANGES_REQUESTED**

Single round (per protocol) — `spec_partner` fixes every finding below; a
finding it cannot resolve is escalated to the human.

**All six resolved** — each carries a `> Resolved` note with what changed.
Contract re-checked after the fixes: 39 scenarios, 39 owned, no tag owned twice
and none orphaned.

## Findings

### 1. [blocker] [resolved] `@s-old-renderings-gone` is asserted true a full slice before it actually is

> **Resolved.** Ownership moved task 3 → task 5, the last task touching a
> rendering site (`src/engine.ts:1098`). `tasks.md` now names all three sites and
> why the assertion sits on the last of them; task 3 states it closes the
> numbered-menu half only; task 2 states the loop's identical string is task 5's.


- **File:** `docs/features/interactive-select-prompts/task-3.md` (scenario
  ownership), cross-checked against `src/engine.ts`.
- **Summary:** Task 3 claims `@s-old-renderings-gone` "lands here because this
  is the last of the two old renderings to go: assert both strings are absent
  from `src/`." That is false given the actual source: the letter-prompt
  string `[a]pprove / [r]eject / or type feedback` exists in **two** places —
  `executeGate` (`src/engine.ts:934`, fixed by task 2) **and** `askLoopGate`
  (`src/engine.ts:1098`, fixed by task 5). Task 5 is slice C, which per
  `tasks.md`'s declared order (`Slice order is A → B → C`) lands **after**
  task 3 (slice B).
- **Failure scenario:** Land slices A and B (tasks 1, 2, 3) and stop. Run
  `grep -n "a\]pprove" src/engine.ts` — it still matches line 1098 inside
  `askLoopGate`, an interactive-loop pause. An automated check for
  `@s-old-renderings-gone` at that point (or any reviewer trusting task 3's
  claim) would be wrong: a human-facing letter menu still renders for
  interactive-loop iterations until task 5 lands.
- **Fix direction:** move `@s-old-renderings-gone` to task 5 (the actual last
  task touching a rendering site), or restate task 3's scope to only cover
  the permission-menu half and add the gate-vocabulary half's closure as an
  explicit condition of task 5.

### 2. [major] [resolved] "Give feedback" follow-up text is silently reparsed through the verdict vocabulary it was chosen to bypass

> **Resolved.** The seam's text answer now carries `from` — the id of the
> `collectsText` entry that collected it, undefined on the piped path (task 1).
> A `from`-tagged answer is taken verbatim and never sees `parseGateReply` /
> `parseLoopReply`; verdict words survive on the piped path only. Task 2 and task
> 5 state both branches, task 5 gives the loop entry the id `sao:feedback`, task 3
> notes permission has no `collectsText` entry, task 6 notes it only ever sees
> untagged text. New scenarios `@s-gate-feedback-keeps-verdict-words` (task 2) and
> `@s-loop-feedback-keeps-verdict-words` (task 5) pin it; spec.md decision 5
> carries the why.


- **File:** `docs/features/interactive-select-prompts/task-2.md` (gate),
  `docs/features/interactive-select-prompts/task-5.md` (loop, silent on the
  parallel path).
- **Summary:** Task 2 states the seam's `{ kind: "text" }` answer — including
  the follow-up text collected *after the human already explicitly chose*
  `Give feedback` from the list — is resolved with "today's `parseGateReply`,
  unchanged vocabulary, so both the piped path and the give-feedback follow-up
  land on one code path." `parseGateReply` (`src/gate.ts`) still treats
  `a/approve/approved/y/yes` and `r/reject/rejected/n/no` as verdicts. So a
  human who picks `Give feedback` and then types literally `yes` or `approve`
  as their answer gets it silently reclassified as a verdict — the node
  resolves to `{ output: "approved" }`, not the typed text.
- **Failure scenario:** At an interactive terminal, a gate's message asks
  "does this look right?"; the human selects `Give feedback` from the list
  intending to answer "yes" as free text. Per task 2's instruction the reply
  is routed through `parseGateReply`, returns `{ kind: "approve" }`, and the
  node's output becomes `"approved"` instead of the literal answer — directly
  contradicting `@s-gate-feedback`'s "the entered text becomes the node's
  output" (no exception carved out), and reintroducing, right after an
  explicit disambiguating list selection, the exact typed-vocabulary ambiguity
  this feature exists to remove.
- Task 5 doesn't even name this problem: the loop's parallel `Write feedback
  instead` (`collectsText`) entry in `askLoopGate`'s choice list is given no
  `id` and no stated handling for its returned `{ kind: "text" }` — an
  implementer has nothing to go on but task 2's (flawed) precedent.

### 3. [minor] [resolved] `spec.md` runs well past the terse-overview budget

> **Resolved.** 5503 → 4622 bytes. The `Mechanism` flowchart is gone — it redrew
> the story's own acceptance-criteria fork, and its other two branches are
> task-5's and task-6's diagrams; spec.md now links to all three. The error
> contract table's per-pause rows moved to the tasks that own them, leaving a
> short `Failure semantics` paragraph for the two cross-cutting guarantees
> (stdin-closed, SIGINT). Decision prose tightened throughout, each keeping its
> why.


- **File:** `docs/features/interactive-select-prompts/spec.md`
- **Summary:** 5503 bytes, ~1.4x the "~4 KB" guideline. The `Mechanism`
  flowchart and the `Error contract` table read as task-level implementation
  detail (the seam's queueing behavior belongs to task 1, the piped-reply
  precedence table belongs to tasks 3/6) rather than terse decisions with
  rationale.

### 4. [minor] [resolved] `@s-old-renderings-gone` filed under the wrong feature heading

> **Resolved.** Moved to `## Feature: Terminal list prompts`, the cross-cutting
> section, and its Then now names both pause types the letter prompt renders at,
> so the scenario reads as spanning features rather than belonging to one.


- **File:** `docs/features/interactive-select-prompts/gherkin-scenarios.md:98`
- **Summary:** The scenario is listed under `## Feature: Gate nodes`, but it
  asserts absence of **both** the gate letter-prompt **and** the permission
  numbered-menu strings, and `tasks.md` assigns its ownership to task 3
  (ACP permission requests) — a different feature section. A cross-cutting
  scenario sitting under a single feature's heading misleads a reader
  correlating headings to ownership (see finding 1, where that exact
  correlation error is what let the sequencing bug through).

### 5. [minor] [resolved] Windows "prompt is usable" half of the story's criterion has no scenario

> **Resolved, covered rather than cut** — the story claims the prompt in scope, so
> cutting it outright was not mine to do. New `@s-windows-prompt-portable` (task
> 1) asserts the prompt path uses no POSIX-only facility and records a manual
> Windows smoke check; task 1 names the one real risk, the `SIGINT` re-raise, and
> why it holds on Windows. What *is* cut is now explicit: spec.md decision 8 and
> the non-goals state there is no Windows CI job, so the guarantee is portability,
> not per-commit coverage.


- **File:** `docs/features/interactive-select-prompts/gherkin-scenarios.md`
  (`@s-windows-installable`), `user-story.md` acceptance criteria
  ("`sao` installs on Windows, **and the list prompt is usable in a Windows
  terminal**").
- **Summary:** `@s-windows-installable` and task 1 verify only package
  metadata (no `os` restriction, raised `engines.node`). Nothing in the
  bundle — scenario or task — addresses the second half of the story's own
  criterion, actual prompt usability on Windows. `spec.md`'s non-goals list
  covers "testing the rest of the CLI on Windows," which is a reasonable
  scope cut, but it doesn't say anything about the *prompt* itself, which the
  story explicitly claims as in scope. Leave as an explicit, named scope cut
  rather than a silent gap.

### 6. [minor] [resolved] Task 6 changes user-facing piped-reply behavior with no README update

> **Resolved.** `README.md` added to task 6's `paths` and its Docs section: how a
> piped reply names a declared option (the exact `id`) and that a verdict word
> wins a collision, written beside the declaration docs task 5 adds.


- **File:** `docs/features/interactive-select-prompts/task-6.md`
- **Summary:** Task 6 adds a new, user-facing addressing mode for piped
  replies to interactive loops (an exact option `id`). Tasks 2, 3 and 5 each
  pair their user-facing behavior change with a `README.md` update; task 6
  updates only `SPEC.md`. A workflow author scripting piped replies to an
  interactive loop has no README-level documentation of how to address a
  declared option.
