# improve-terminal-text — spec review

Round 1 (automated, pre-gate). Verdict: **CHANGES_REQUESTED**.

## Findings

### 1. [blocker] [resolved] Slice 2 (D2) breaks the user story's explicit "no runner change" scope boundary, with no recorded human decision walking it back

**Where:** `user-story.md:19` vs `spec.md` ("Surfaces touched" table, D2) and `task-4.md`.

`user-story.md:19` states the surface this feature is scoped to, as a decision
already settled with the human: *"Surface: **CLI terminal output only** — what sao
prints at a pause. No YAML schema change, **no runner change**, no change to what
is asked of the agent."* This is one of three independent guarantees in that
sentence — it can't be read as redundant with "no change to what is asked of the
agent," which is the separate, third clause.

`spec.md`'s Surfaces-touched table lists as Slice 2's mechanism: *"`src/runners/types.ts` + adapters | `finalOutputStreaming?: "per-message" | "whole-turn"` on `Runner` — **amends `SPEC.md`'s Runner interface** (D2)"*. `task-4.md` touches
`src/runners/types.ts`, `src/runners/claude.ts`, `src/runners/codex.ts`, and
`src/runners/opencode.ts`, adding a new field to the `Runner` interface and
implementing it in every adapter. That is a runner change by any reading — it
modifies the interface every `Runner` implementation must satisfy and the binding
`SPEC.md` section that defines it.

`task-4.md` asserts *"This amends `SPEC.md`'s Runner interface section — the human
approved it explicitly,"* but `user-story.md`'s Notes section — the designated
record of "decisions the human already made — do not re-ask" — says nothing about
lifting the "no runner change" guarantee. Contrast this with the TTY-only decision
a few lines above it in the same story, which the story documents as a surfaced
collision with a locked decision (`SPEC.md:225`) and the human's explicit call. No
equivalent record exists for reopening "no runner change." As written, this is
`spec_partner`'s own design choice presented as a settled human decision, not one
actually traceable to the human — the same defect flagged as a blocker in this
feature's sibling review (`add-acp-and-opencode/review-spec.md` finding 1, a new
dependency asserted as a "resolved decision" without a human record).

Also note `spec.md`'s own non-goals-adjacent line ("No YAML schema change, no CLI
flag, no `state.json` change, nothing new asked of an agent") silently drops "no
runner change" from the set of guarantees it restates from the user story — further
sign the boundary was quietly narrowed rather than explicitly renegotiated.

**Consequence if unresolved:** the spec ships a `Runner` interface/adapter change
the human was told, in the same document, would not happen — and the alternative
(achieving once-only printing without touching `Runner`, e.g. inferring
duplicate-suppression purely from the held-text/final-output string match already
described in the Mechanism section, without a declared per-runner field) was never
presented for the human to weigh against D2's approach.

**Fix:** either go back to the human, name the collision explicitly (the way the
TTY-only decision was surfaced), and record their call as a Note in
`user-story.md`; or redesign slice 2 to reach "printed exactly once" without
touching the `Runner` interface, so the recorded "no runner change" guarantee holds
as stated.

**Resolution:** both options in turn — the redesign first, then the renegotiation the
finding asked for, decided by the human.

Round A (the redesign). D2 was made runner-blind: `Runner`, `src/runners/*` and
`src/acp.ts` untouched, the message identified purely by string match. Its cost —
narration arriving in one burst at the pause instead of live — was recorded as open
decision **O1**, with the `Runner`-field alternative named beside it and explicitly
marked as the human's call at the approval gate. Nothing about `Runner` was assumed.

Round B (the human's call at the gate). The collision was put to the human with both
options and their consequences. **They chose the `Runner`-field alternative**, knowingly
amending `SPEC.md`'s Runner interface section. That is now recorded where the finding
required it — as a Note in `user-story.md`, alongside the amended surface line, which no
longer claims "no runner change" while the spec makes one.

State of the bundle:

- `Runner` gains `finalOutputStreaming?: "per-message" | "whole-turn"`; claude and codex
  declare `per-message`, opencode `whole-turn`, **unset means `whole-turn`**. The field
  is a liveness hint, not a contract: correctness in both branches still comes from the
  string match, so a wrong or absent declaration degrades to "shown twice", never to
  "shown zero times", and adding a runner stays one file plus a registry entry.
- Slice 2 stays one task (task-4), now covering the field, the three adapters and the
  engine withholding; gates stay task-5. A declaration-only task would not be
  independently exercisable through the CLI.
- O1 is closed; `spec.md` has no open decisions.
- Contract: `@s-runner-granularity-declared` / `@s-runner-granularity-defaults` restored,
  `@s-narration-released-at-pause` replaced by `@s-narration-still-streams`,
  `@s-question-appears-once-*` restated in terms of the declaration, and
  `@s-repeated-text-keeps-earlier-copy` kept for the last-occurrence rule.
