---
id: 2
title: Gate nodes present a list
slice: A — every pause is a list
scenarios: [@s-gate-approve, @s-gate-reject, @s-gate-feedback, @s-gate-feedback-keeps-verdict-words, @s-gate-piped-unchanged]
status: todo
paths: [src/engine.ts, src/gate.ts, tests/engine-m2.test.ts, tests/cli.test.ts, SPEC.md, README.md]
---

Move `executeGate` (`src/engine.ts:932`) onto the task-1 seam.

- Choices, in order: `sao:approve` → `Approve`, `sao:reject` → `Reject`,
  `sao:feedback` → `Give feedback` with `collectsText`. The `[a]pprove / [r]eject
  / or type feedback` string is **deleted**; the message keeps the interpolated
  `gate.message` and the `[node-id]` label.
- `{ kind: "choice" }` → approve returns `{ output: "approved" }`, reject throws
  `GateRejectedError` (unchanged run/node `rejected` marking and resume re-ask).
- `{ kind: "text", from: "sao:feedback" }` → the text **is** the node's output,
  verbatim. `parseGateReply` is not called: the human already picked `Give
  feedback`, so `yes` is an answer, not an approval
  (`@s-gate-feedback`, `@s-gate-feedback-keeps-verdict-words`). An empty answer
  re-asks the same gate.
- `{ kind: "text" }` with no `from` — the piped path only — → today's
  `parseGateReply`, unchanged vocabulary (`@s-gate-piped-unchanged`). An empty
  line re-asks, as today. The two paths diverge here by design; the seam's `from`
  tag is what tells them apart (task 1, spec.md decision 5).

The gate's own `[a]pprove / [r]eject / or type feedback` string goes here; the
identical string in `askLoopGate` (`src/engine.ts:1098`) is task 5's, and
`@s-old-renderings-gone` is asserted there, once both are gone.

**Docs:** `SPEC.md` § *Gate semantics* — the pause is a navigable list of
approve / reject / give-feedback; the verdict vocabulary now belongs to the
typed-line path alone, which is an input channel that renders nothing and still
fails a pause it cannot answer. `README.md`: the gate
node comment on line 158 ("pauses for y/n in the terminal").
