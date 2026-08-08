---
id: 5
title: Pausable node timeout across human waits
slice: S3 — Permission prompts
status: todo
scenarios:
  - "@s-timeout-paused-during-prompt"
  - "@s-timeout-paused-while-queued"
paths:
  - src/acp.ts
  - src/gate.ts
  - tests/acp.test.ts
  - SPEC.md
---

# Task 5 — the timeout clock stops for the human

Make the ACP runner's `timeoutSec` measure agent work, not human deliberation
(spec decision D5).

## Scope

- Replace task 1's single `setTimeout` seam with a pausable timer: the clock stops
  when a permission prompt becomes outstanding and resumes when it is answered.
- The pause covers **queued** time too — from the moment the prompt is enqueued on
  `promptOnTerminal`'s queue, not from when it reaches the terminal. Without this,
  one human's slow answer to node A's prompt can time out node B, which would break
  the story's "same run, same answers, same behavior regardless of node timing"
  criterion.
- Only the ACP path changes. claude's and codex's timers are untouched.
- Tests use injectable/fake time rather than real sleeps, matching how the existing
  runner timeout tests are written.

## Docs (part of this slice)

- `SPEC.md`: state alongside the gate rule ("the human wait itself is never
  time-boxed") that a node's `timeout` likewise excludes time spent waiting on — or
  queued behind — a permission prompt.
