# review-slice-3 — ACP permission requests present a list

Verdict: **APPROVED**

## Findings

None.

## Not flagged

- [correctness] `@s-perm-nothing-sent-until-chosen`'s second clause ("the AI
  node's timeout is not counting the time spent waiting") is not asserted by
  the test `tdd-3.md`'s map cites for it
  (`tests/gate-permission.test.ts` → `@s-perm-piped-invalid-reasks /
  @s-perm-nothing-sent-until-chosen`, which only checks re-ask counting and the
  final outcome). The timer-pause behavior is genuinely covered, though —
  `tests/acp.test.ts`'s `@s-timeout-paused-during-prompt` and
  `@s-timeout-paused-while-queued` (pre-existing D5 tests, migrated onto
  `promptChoice` in this slice per `tdd-3.md` cycle 4) exercise exactly that.
  `pauseTimer()`/`resumeTimer()` around the whole exchange in
  `src/acp.ts:229-249` are also unchanged from before this slice (task-3.md:
  "Untouched"). Same shape as review-slice-2's first "Not flagged" item — a
  traceability gap in the map, not a coverage gap, so not worth blocking over.
- [correctness] `parsePermissionReply` (`src/gate.ts:40-49`) checks the numeric
  1-based-index branch before the `optionIds.indexOf` branch, so a piped reply
  that happens to equal a purely-numeric `optionId` (e.g. an option literally
  named `"2"`) resolves by position, not by id. No scenario in
  `gherkin-scenarios.md` specifies precedence between the two forms, and
  `optionId`s are agent-supplied opaque strings sao never gives meaning to
  (SPEC.md, this section) — not a real defect, just noting it's unspecified
  rather than silently wrong.
- [minimalism] No new dependency, abstraction, or config surface — this slice
  only extends `parsePermissionReply`'s signature and threads the
  already-existing `promptChoice` seam (introduced in slice 1) through
  `NodeExecContext` → `RunnerRequest` → the three `executeAiNode` call sites in
  `src/engine.ts`. No `package.json`/lockfile/`patches/` changes in this
  slice's diff.
- [layering] `src/acp.ts` importing `Choice`/`PromptAnswer` from `src/gate.ts`
  is a downward import (runners → gate), matching the existing pre-slice
  pattern of importing `parsePermissionReply` from the same module. No new
  edge crosses `nodes`/`runners` → `engine` or any other upward direction.
- [node-target] No Bun-only API introduced; `src/nodes.ts`, `src/runners/types.ts`,
  `src/acp.ts`, `src/gate.ts` changes are plain type/signature edits and object
  literals only.
- [procs] Untouched — `killTree(child)` on a `promptChoice` rejection
  (`src/acp.ts:241-245`) is the same child-kill path as before this slice, just
  renamed from `promptUser`.
- [safety] `parsePermissionReply`'s new `optionIds.indexOf(text)` branch
  compares the trimmed reply against agent-supplied ids only; nothing
  user-controlled reaches a filesystem path, argv slot or git refspec.
- [state] No `state.json` shape change; `NodeExecContext.promptChoice` and
  `RunnerRequest.promptChoice` are runtime-only injected functions, not
  persisted fields (same as the `promptUser` field they replace).
- [cli-ux] The permission list reuses the same `promptChoice`/`@clack/prompts`
  rendering path a gate uses (no separate menu-building code in `src/acp.ts`
  beyond mapping `params.options` 1:1 into `Choice[]`); colour/prefix
  conventions are unaffected since this slice touches no print/colour code.
  `sao validate`: N/A, no new YAML surface. Both runners: N/A, claude/codex
  have no permission-request concept (unchanged, per SPEC.md).
- Docs: `SPEC.md` § *Permission requests (ACP runners)* rewritten for the
  list/piped split (numbered menu deleted, id-or-index piped addressing
  documented); `README.md`'s opencode-runner section (previously lines
  208–217) replaces the numbered-menu example with the list/piped-addressing
  prose. Both are in this slice's diff. The adjacent `SPEC.md` Distribution-row
  and `README.md`:70 Node-version wording, and the `README.md` gate-node
  comment, are slice 1's and slice 2's respectively (already reviewed,
  resolved/approved there) — not re-litigated here.
- Tests bite: each new/rewritten test asserts a concrete, falsifiable shape —
  exact `choices` array equality (`@s-perm-agent-options-listed`), exact
  `result.output` per addressing form (`@s-perm-piped-index`,
  `@s-perm-piped-option-id`), an exact re-ask count of 4 across
  index/id/garbage misses (`@s-perm-piped-invalid-reasks`), and the exact
  `stdin closed while waiting for a reply` message plus a confirmed-dead child
  process (`@s-perm-no-terminal-fails`). `tests/gate.test.ts`'s new
  `parsePermissionReply` cases cover both the positive id-match and an
  id-shaped-but-absent negative.
- Mutation coverage by inspection (Stryker itself not re-run, per protocol):
  `answer.kind === "choice"` is exercised both ways
  (`@s-perm-selection-sent-verbatim` true, `@s-perm-piped-index`/
  `@s-perm-piped-option-id` false); `optionIds.indexOf(text) !== -1` is
  exercised both ways by the new `parsePermissionReply` tests; the numeric
  regex/range guard retains its prior coverage (unchanged test cases, just
  parameterized on an id array instead of a count).
