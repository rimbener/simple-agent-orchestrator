# review-slice-5 — Interactive loops present the agent's options

Verdict: **CHANGES_REQUESTED**

## Findings

### 1. [correctness] `src/engine.ts:1159` — no test proves the *right* option's label is fed back, not just the first one — `resolved`

`askLoopGate`'s choice branch does `return { kind: "feedback", text: labelById.get(answer.id)! };` — the whole
point of `@s-loop-option-feeds-label` is that the label matching the **chosen** option reaches
`{{loop.feedback}}`. But every test that exercises this line uses an options array of length
one:

- `@s-loop-options-listed` (`tests/engine-m2.test.ts:765`) declares two options (`sqlite`,
  `postgres`) but never confirms either — it only asserts the built `choices` array, then
  answers `sao:end-loop`.
- `@s-loop-option-feeds-label` (`tests/engine-m2.test.ts:791`) declares a single option
  (`sqlite`) and confirms it.

With only one declared option, `labelById.get(answer.id)!` and a buggy `options[0]!.label`
(or `options.at(-1)!.label`) are indistinguishable — both produce "Use SQLite" regardless of
which id the human actually picked. A mutant (or a real regression) that stops looking up by
`answer.id` and just returns the first/last declared option's label would pass every test in
this slice.

Fix: extend `@s-loop-option-feeds-label` (or add a case) with **two or more** declared
options, confirm the non-first one, and assert its label — not the first one's — becomes
`loop.feedback`.

### 2. [correctness] `src/engine.ts:1162` — the loop's empty/whitespace "write feedback" re-ask is never exercised — `resolved`

`if (answer.text.trim() === "") continue;` inside the `answer.from === "sao:feedback"` branch
is new to this slice (the whole choice-based `askLoopGate` is). The gate's identical pattern
has a dedicated test — `tests/engine-m2.test.ts:1102` (`"an empty give-feedback answer
re-asks the same gate"`) scripts `""` then `"  "` then a real choice, and asserts three
requests were made. No equivalent exists in the `"interactive loop options"` describe block:
`@s-loop-feedback-entry` and `@s-loop-feedback-keeps-verdict-words` both script only
non-empty `from: "sao:feedback"` text.

Because the condition is only ever exercised on non-empty input in this slice's tests, a
`StringLiteral` mutant on the `""` comparison (or deleting the guard outright) survives: the
"true" branch — the one that actually re-asks — is dead as far as coverage goes, even though
`answer.text.trim() === ""` reports covered-by-execution (the false branch always runs).

Fix: add a case (mirroring the gate's) that scripts `{ kind: "text", text: "", from:
"sao:feedback" }` (and/or a whitespace-only answer) followed by a real answer, and assert the
extra `promptChoice` call(s) before the loop advances.

## Not flagged

- [correctness] All nine `@s-loop-*` scenarios plus `@s-old-renderings-gone` map 1:1 to a
  test per `tdd-5.md`, and (aside from the two gaps above) each bites: exact `choices`-array
  equality for ordering (`@s-loop-options-listed`, `@s-loop-no-options-fallback`), an exact
  `AGENT_OPTIONS_INSTRUCTION` presence/absence check across three prompt shapes — plain AI
  node, single-prompt interactive loop, and multi-step loop where only the *last* AI step
  carries it (`@s-loop-instruction-appended`, `tests/engine-m2.test.ts:709`) — and a persisted
  log-file read (not a mock) for the malformed-declaration warning
  (`@s-loop-malformed-fallback`, `tests/engine-m2.test.ts:952`).
- [correctness] `@s-loop-piped-option-id`, `@s-loop-piped-verdict-precedence`,
  `@s-loop-piped-unsignaled-approve-reasks` and `@s-loop-piped-freeform-is-feedback` from
  `gherkin-scenarios.md` are absent from `tdd-5.md`'s map — correctly: `task-6.md` (`status:
  todo`) owns them explicitly ("Untagged `{ kind: "text" }` is the piped line, and that is
  task 6's precedence" — `task-5.md:34-35`). Not a gap in this slice.
- [correctness] The piped path in both `executeGate` and `askLoopGate` is untouched by this
  slice beyond the surrounding refactor — `parseGateReply`/`parseLoopReply` still decide it,
  matching `task-5.md`'s note that `parseLoopReply` is not called on `sao:feedback` answers.
- [minimalism] No new dependency, abstraction or config surface. `src/options.ts` (leaf,
  reviewed/approved in `review-slice-4.md`) is only *consumed* here, not changed. No
  `package.json`/lockfile/`patches/` touched by this slice's diff.
- [minimalism] `PromptUser`/`promptOnTerminal` in `src/gate.ts` are now unreferenced from
  production code (`grep` confirms the only remaining callers are `tests/gate-stdin.test.ts`,
  which exercises the primitive directly) — a consequence of this slice retiring
  `RunWorkflowOptions.promptUser`/`Engine`'s last consumer of it. `src/gate.ts` and
  `tests/gate-stdin.test.ts` are outside `task-5.md`'s `paths:` and untouched by this slice's
  diff, so deleting them is not this slice's call to make unilaterally — noting it for the
  full review rather than blocking here.
- [layering] `src/engine.ts` importing `AGENT_OPTIONS_INSTRUCTION`/`AgentOption`/
  `parseAgentOptions` from `./options` is downward (`engine` → leaf), matching the module
  tree `SPEC.md` documents. No new edge into `nodes`/`runners`.
- [node-target] No Bun-only API; `parseAgentOptions`/`AGENT_OPTIONS_INSTRUCTION` consumption
  is plain string concatenation and array/Map operations.
- [procs] N/A — no subprocess touched by this slice.
- [safety] N/A — `instructedOutput` parsed by `parseAgentOptions` is the agent's own captured
  stdout, already in memory; nothing reaches a filesystem path, argv slot or git refspec.
- [state] No `state.json` shape change — `nodeState.lastFeedback`/`iterations` are pre-existing
  fields, now fed a chosen option's label instead of raw text; resume re-runs the interrupted
  iteration so the agent re-declares options, exactly as `task-5.md` states. Confirmed by
  `tests/engine-m3.test.ts`'s new `@s-loop-reject-entry` resume test.
- [cli-ux] Loop-iteration message stays `\n[${node.id}] iteration ${iteration} — ${status}`,
  same shape as before this slice minus the deleted letter suffix; rendering itself is
  `promptChoice`'s (reviewed in `review-slice-1.md`). The malformed-options warning goes to
  the node's iteration log file (`⚠ ${node.id}: ...`), matching the existing `⚠`-prefixed,
  uncolored convention for log-file (as opposed to terminal-`print`) warnings elsewhere
  (`src/acp.ts:138`, `:290`, `:312`). Both runners: N/A, the `<options>` channel is the agent's
  own output text, nothing runner-specific.
- [docs] `SPEC.md` § *Loop semantics* rewritten for the list/declaration/piped split — matches
  the implementation's list order, the label-not-id feedback, and the malformed-fallback
  behavior; doesn't over-claim task 6's not-yet-built piped-precedence rules. `README.md`'s
  loop node comment and new `<options>` paragraph are both in this slice's diff and consistent
  with the code. The `SPEC.md` Gate-semantics/Permission-requests rewrites and the `options.ts`
  project-structure line visible in the working tree's cumulative diff are slice 2/3/4's,
  already reviewed/approved there.
- Mutation coverage by inspection, remainder: `body.interactive` gating on the instruction
  append is exercised true and false in the same test (`@s-loop-instruction-appended`);
  `signaled` gating on `sao:end-loop`'s presence is exercised both ways
  (`@s-loop-end-entry-only-when-signaled`); `answer.id === "sao:end-loop"` vs `"sao:reject"`
  vs the default (agent-option) branch are each independently exercised.

## Scope note

This review was written without per-slice commits to diff against — slices 1–4 are all still
uncommitted in the working tree alongside slice 5. Scope for this review was reconstructed
from `task-5.md`'s `paths:`/`scenarios:` list and `tdd-5.md`'s cycles, cross-checked against
`review-slice-1.md`–`review-slice-4.md` to avoid re-litigating code and tests already reviewed
and approved there (`src/gate.ts`, `src/acp.ts`, `src/nodes.ts`, `src/runners/types.ts`,
`src/options.ts`, the `"gate nodes"` describe block, `parsePermissionReply`). Findings above
are confined to what `task-5.md` actually scopes to this slice: `src/engine.ts`'s loop/steps/
`askLoopGate` wiring, the new `"interactive loop options"` tests, the loop-resume test in
`tests/engine-m3.test.ts`, `tests/cli.test.ts`'s source-hygiene test, and the `SPEC.md`/
`README.md` *Loop semantics* updates.
