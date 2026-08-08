# Spec review — add-acp-and-opencode

Round 1 (automated, pre-gate). Verdict: **CHANGES_REQUESTED** — all three findings
addressed by `spec_partner`; see the **Resolution** note under each.

## Findings

### 1. [blocker] [resolved] New runtime dependency added without a recorded human decision

**Where:** `spec.md` — "Resolved decisions", D1 ("Use the official ACP library").

`SPEC.md`'s locked design says dependencies are "kept minimal": `commander`, `yaml`,
`zod`, `picocolors` + node builtins. D1 adds a fifth runtime dependency,
`@zed-industries/agent-client-protocol`, changing that locked line from 4 → 5.

D1's rationale ("the package is the protocol definition, so drift is handled
upstream") is `spec_partner`'s own justification, not a decision attributed to the
human. `user-story.md`'s Notes 1–6 — the record of decisions "the human already
made" — say nothing about a new dependency; the choice between a hand-rolled
JSON-RPC client and pulling in the official SDK was never put to the human. Per the
review rubric, a new runtime dependency beyond the four locked ones, without a
recorded human decision, is a blocker regardless of how sound the rationale is —
this is exactly the kind of locked-design change (`SPEC.md`'s dependency line) that
needs an explicit, attributed decision, the same way the plugin-loading non-goal
check (story Note 2) was explicitly put to the human and recorded.

**Fix:** either attribute D1 to a human decision the human actually made (go back
and ask, then record it as a Note in `user-story.md` the way Notes 1–6 are
recorded), or mark it clearly as an open question for the human gate rather than a
resolved decision baked into the spec.

**Resolution:** took the second option — the human is not available to answer
mid-run, and `spec_partner` must not decide a dependency itself. D1 is gone from
"Resolved decisions"; the choice is now **O1** under `spec.md`'s
`## Open — for the human at the approval gate`, stating both options, the
recommendation (take the library) and its blast radius (one task: `src/acp.ts`
internals, `package.json`, and the `SPEC.md` dependency line — no scenario,
message, schema or task boundary moves either way). `task-1.md` now opens "Blocked
on open decision O1" and no longer asserts the dependency; `task-2.md`'s `SPEC.md`
docs bullet makes the four→five dependency-line edit conditional on O1's answer.
`spec.md`'s Non-goals no longer list the hand-rolled client as discarded.

**Update — answered at the gate.** The human approved the official package. The
decision is recorded as `user-story.md` Note 7 (attributed, the way Notes 1–6 are)
and as `spec.md` D1; O1 is gone from `## Open`, `task-1.md` asserts the dependency,
and `task-2.md`'s `SPEC.md` four→five edit is now unconditional. Finding 1 is
closed on its first option — the attributed human decision — not the fallback.

### 2. [major] [resolved] Session-lifecycle behavior has no README update anywhere in the plan

**Where:** `task-6.md` (paths / Docs section); `README.md`'s "Runners" section.

`README.md`'s existing Runners section documents session-related behavior
per-runner: claude gets "per-loop session resume", codex gets "`fresh_context:
false` is a validation error." Task 6 gives the opencode/ACP runner its own
session-lifecycle behavior — `fresh_context: false` continuing one session via
`session/load`, and a lost session on resume warning ("prior conversation history
was lost") and continuing rather than halting — which is exactly the class of
user-facing, runner-specific behavior the existing README entries for claude/codex
already cover. Task 6's paths/Docs list only `SPEC.md`; no task's README scope
covers it:

- Task 2 adds the opencode README stub before capability preflight (task 3) or
  session support (task 6) exist, so it can't describe session behavior yet.
- Task 7's README scope is explicitly the three-way MCP/`allowed_tools` summary,
  not sessions.

So the opencode entry in README's Runners section will describe runner selection
and MCP/`allowed_tools` handling, but never gets a session-behavior sentence
analogous to codex's — an omission, not a deliberate deferral.

**Fix:** add `README.md` to task-6's paths and Docs section, with a sentence in the
opencode Runners entry parallel to codex's: session resume via `fresh_context:
false`, and what happens when the recorded session is gone.

**Resolution:** `README.md` added to `task-6.md`'s `paths`, with a Docs bullet
extending the opencode Runners entry (added in task 2) with a session sentence
parallel to claude's "per-loop session resume" and codex's "`fresh_context: false`
is a validation error": `fresh_context: false` continues one ACP session, and a
session the agent no longer knows warns that prior conversation history was lost
and continues with a fresh one.

### 3. [minor] [resolved] `spec.md` is over the terse-overview size target

**Where:** `spec.md` (whole file).

The file is 5.4 KB; the review rubric's target for `spec.md` is "≤ ~4 KB". The
Summary/Surfaces/Error-contract/Decisions/Open/Non-goals structure is the right
shape and nothing in it is a duplicate of `gherkin-scenarios.md` or `task-N.md`
content, so this isn't a content problem — it's simply ~35% over the size
guideline.

**Fix:** tighten prose in the "Resolved decisions" rationales (several "Why:"
sentences restate context already in `user-story.md`'s Context section) to bring
the file back under ~4 KB.

**Resolution:** 5.4 KB → 4.4 KB. The Surfaces and Error-contract tables became
compact bullet lists, the decision rationales lost their "Why:" preamble and their
restatements of `user-story.md` Context, and Non-goals merged. Every section
required by the spec brief is still present; nothing moved into another artifact.
Note this is ~7% over the ~4 KB guideline rather than under it — the residue is the
new O1 entry (finding 1's fix, ~600 B), which has to stay legible for the human at
the gate. Cutting further would mean dropping a resolved decision's rationale.

## Verification notes (for context, not findings)

Confirmed against the current tree (no issues found):
- All `src/`/`tests/` paths named across `task-1.md`–`task-7.md` are real or
  consistent with the existing layering (`src/procs.ts`, `src/gate.ts:98`
  `promptOnTerminal`, `src/runners/types.ts` `REGISTRY`, `preflightAiConfigs` /
  `formatDryRun` in `src/engine.ts`, `preflight` calls in `src/runners/claude.ts`
  and `codex.ts`).
- All 31 `@s` tags in `gherkin-scenarios.md` are unique, each owned by exactly one
  task, and each task's `scenarios` frontmatter matches its corresponding feature
  block exactly — no orphans, no double-ownership.
- No collision with any other `SPEC.md` non-goal (dynamic plugin loading is
  explicitly addressed and stays a non-goal per story Note 2; MCP stays
  forwarder-not-host per D4; no Bun-only API is implied — task-1 says so
  explicitly).
- Runner-specific behavior is specified for both runners in every case (claude/codex
  regression guards appear in tasks 3–5; the "no ACP handshake, no new prompts"
  scenarios are explicit).
- Resume/config-hash impact is addressed directly ("no schema or state-shape
  change... in-flight runs resume unaffected, and the config hash is untouched").
- Vertical slices are each independently CLI-exercisable end to end (S1 = task-1 +
  task-2; S2 = task-3; S3 = task-4 + task-5; S4 = task-6 + task-7), consistent with
  the rubric's slice-level (not task-level) exercisability requirement.
