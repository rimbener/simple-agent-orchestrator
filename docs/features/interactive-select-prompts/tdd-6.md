# tdd-6 — Piped replies address a declared option

## @s → test map

| Scenario | Test |
| --- | --- |
| `@s-loop-piped-option-id` | `tests/gate.test.ts` → `parseLoopReply > @s-loop-piped-option-id: ...` and `tests/engine-m2.test.ts` → `interactive loop options > @s-loop-piped-option-id: ...` |
| `@s-loop-piped-verdict-precedence` | `tests/gate.test.ts` → `parseLoopReply > @s-loop-piped-verdict-precedence: ...` and `tests/engine-m2.test.ts` → `interactive loop options > @s-loop-piped-verdict-precedence: ...` |
| `@s-loop-piped-unsignaled-approve-reasks` | `tests/engine-m2.test.ts` → `interactive loops > @s-loop-piped-unsignaled-approve-reasks: ...` |
| `@s-loop-piped-freeform-is-feedback` | `tests/gate.test.ts` → `parseLoopReply > @s-loop-piped-freeform-is-feedback: ...` and `tests/engine-m2.test.ts` → `interactive loops > @s-loop-piped-freeform-is-feedback: ...` |

## Cycles

1. RED/GREEN: `parseLoopReply(reply, options = [])` — verdict words resolve first
   (unchanged precedence), then a `feedback`-kind result whose text exactly
   matches a declared option's `id` resolves to `{ kind: "feedback", text:
   option.label }`; a non-matching or option-less line stays feedback verbatim.
   Default `options = []` keeps every pre-existing single-arg call site green.
2. GREEN (no src change needed): `askLoopGate`'s untagged-`{ kind: "text" }`
   branch now passes `options` (already in scope) as `parseLoopReply`'s second
   argument.
3. Confirmed by inspection, then tagged: `@s-loop-piped-verdict-precedence`
   already held before step 1 — `parse()` checks verdict words ahead of any
   option lookup — so the new test for it passed immediately; it stays as a
   regression guard.
4. Retagged two pre-existing `engine-m2.test.ts` cases to their owning
   scenarios rather than duplicating coverage: the plain interactive-loop test
   (bare "a" approve, "blue, not red" feedback) → `@s-loop-piped-freeform-is-feedback`;
   the eager-approve-on-unsignaled-iteration test → `@s-loop-piped-unsignaled-approve-reasks`.

## Docs

`SPEC.md` § *Loop semantics* — added the piped-path option-id paragraph:
verdict precedence, exact `id` match (never index), label substitution,
fallback to feedback verbatim.
`README.md` — added the piped-reply paragraph beside the `<options>` docs in
the workflow reference example.
