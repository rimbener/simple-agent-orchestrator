# tdd-5 — Interactive loops present the agent's options

## @s → test map

| Scenario | Test |
| --- | --- |
| `@s-loop-instruction-appended` | `tests/engine-m2.test.ts` → `interactive loop options > @s-loop-instruction-appended: ...` |
| `@s-loop-options-listed` | `tests/engine-m2.test.ts` → `interactive loop options > @s-loop-options-listed: ...` |
| `@s-loop-option-feeds-label` | `tests/engine-m2.test.ts` → `interactive loop options > @s-loop-option-feeds-label: ...` |
| `@s-loop-end-entry-only-when-signaled` | `tests/engine-m2.test.ts` → `interactive loop options > @s-loop-end-entry-only-when-signaled: ...` |
| `@s-loop-feedback-entry` | `tests/engine-m2.test.ts` → `interactive loop options > @s-loop-feedback-entry: ...` |
| `@s-loop-feedback-keeps-verdict-words` | `tests/engine-m2.test.ts` → `interactive loop options > @s-loop-feedback-keeps-verdict-words: ...` |
| `@s-loop-reject-entry` | `tests/engine-m2.test.ts` → `interactive loop options > @s-loop-reject-entry: ...` (halt) and `tests/engine-m3.test.ts` → `loop resume > @s-loop-reject-entry: ...` (re-asks on resume) |
| `@s-loop-no-options-fallback` | `tests/engine-m2.test.ts` → `interactive loop options > @s-loop-no-options-fallback: ...` |
| `@s-loop-malformed-fallback` | `tests/engine-m2.test.ts` → `interactive loop options > @s-loop-malformed-fallback: ...` |
| `@s-old-renderings-gone` | `tests/cli.test.ts` → `source hygiene > @s-old-renderings-gone: ...` |

## Cycles

1. RED/GREEN: `executeLoop`/`executeSteps` append `AGENT_OPTIONS_INSTRUCTION`
   beside `sentinelInstruction()` only when `body.interactive` — single-prompt
   loops and the last (sentinel-carrying) AI step of a `steps:` loop.
2. RED/GREEN: `executeLoop` parses `instructedOutput` with `parseAgentOptions`
   (interactive loops only); a present-but-unreadable `<options>` tag logs a
   warning naming the node to the iteration log and falls back to no options.
3. RED/GREEN: `askLoopGate` moved onto `promptChoice` — choices are the agent's
   options (in order), then `sao:end-loop` (only when signaled), `sao:feedback`
   (`collectsText`), `sao:reject`; the old `[a]pprove / [r]eject / or type
   feedback` letter prompt is deleted.
4. RED/GREEN: `{ kind: "choice" }` — an agent option's id resolves to
   `{ kind: "feedback", text: option.label }`; `sao:end-loop` approves;
   `sao:reject` throws `GateRejectedError`.
5. RED/GREEN: `{ kind: "text", from: "sao:feedback" }` becomes the next
   iteration's feedback verbatim, never reparsed by `parseLoopReply`; an empty
   answer re-asks the same iteration.
6. Untagged `{ kind: "text" }` (piped path) keeps `parseLoopReply`'s existing
   vocabulary and the "has not emitted … yet" re-ask on an unsignaled approve —
   now unreachable from the terminal path, since the list never offers
   `sao:end-loop` there.
7. Updated `engine-m2.test.ts`/`engine-m3.test.ts` fixtures that drove
   interactive loops through the old `promptUser` string seam to the new
   `promptChoice` seam; removed `promptUser`/`PromptUser`/`promptOnTerminal`
   plumbing from `RunWorkflowOptions`/`Engine` (dead once `askLoopGate` stopped
   reading it) and the two stray gate `promptUser` fixtures that were never
   updated in slice 2.
8. RED/GREEN: source-wide scan (`tests/cli.test.ts`) — neither
   `[a]pprove / [r]eject / or type feedback` nor `1. Allow` appears anywhere
   under `src/`.
9. GREEN (review-slice-5 fix): `@s-loop-option-feeds-label` now declares two
   options and confirms the non-first one, proving `labelById.get(answer.id)`
   feeds back the *chosen* option's label, not `options[0]`'s.
10. RED/GREEN (review-slice-5 fix): new `@s-loop-feedback-entry` case scripts
    an empty then whitespace-only `sao:feedback` answer before a real one,
    proving the `answer.text.trim() === ""` re-ask guard actually re-asks
    (mirrors the gate's equivalent test).

## Docs

`SPEC.md` § *Loop semantics* — rewritten for the list/declaration/piped split.
`README.md` — the loop node comment and a short paragraph documenting the
`<options>` declaration next to the workflow reference example.
