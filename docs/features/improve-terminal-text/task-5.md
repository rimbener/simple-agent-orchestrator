---
id: task-5
title: "Gate pauses through the same block, plus docs"
slice: "3 — gate pauses"
scenarios:
  - "@s-gate-message-in-block"
  - "@s-gate-strips-markers"
  - "@s-gate-piped-unchanged"
status: done
paths:
  - src/engine.ts
  - tests/engine-m2.test.ts
  - SPEC.md
  - README.md
---

Decision D4: the same path, one more caller. `executeGate` (`engine.ts:944`)
interpolates its message and today hands the whole thing to the prompt as raw text
(`engine.ts:946`).

- At an interactive terminal, strip + render the interpolated message (task-1) and
  pass it as `block` with `blockTitle` = `[<node>]`; the prompt `message` keeps only
  the short pause line. The Approve / Reject / Give feedback list and every reply
  path are untouched.
- Stripping matters here because a gate message can interpolate a loop node's output,
  which carries that loop's `<promise>` sentinel. A gate has no expected signal name,
  so no unexpected-name warning applies — the token is simply removed.
- Piped: no block, and the wider gate vocabulary (`gate.ts:20-21`) decides the
  verdict exactly as before.
- `--dry-run`'s plan printer (`engine.ts:516`) is **not** touched — it dumps a plan,
  not a pause.

Docs in this slice: `SPEC.md`'s **Gate semantics** section gains the block sentence
alongside its existing interactive-vs-piped split; `README.md`'s gate mention
(`README.md:158-162`) notes that the message is rendered in a box at an interactive
terminal.
