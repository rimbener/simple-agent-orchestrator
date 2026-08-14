---
id: task-2
title: "Draw the block in the prompt's TTY branch"
slice: "1 — the block at an interactive-loop pause"
scenarios:
  - "@s-block-boxed-at-tty"
  - "@s-block-absent-when-piped"
  - "@s-block-atomic-with-its-list"
  - "@s-permission-prompt-unchanged"
  - "@s-block-ctrl-c-unchanged"
status: todo
paths:
  - src/gate.ts
  - tests/gate-stdin.test.ts
---

Decision D3: the block rides on the existing prompt request and is drawn **only** on
the interactive path, so non-TTY output stays byte-identical by construction rather
than by discipline.

- Add `block?: string` (already-rendered text) and a `blockTitle?: string` to the
  `PromptChoices` request type (`gate.ts:12`).
- In `runListPrompt` (`gate.ts:181`) — the TTY branch — draw it with
  `@clack/prompts`' `note(block, blockTitle, { output: process.stdout })` before the
  `select`. Both writes happen inside the same queued turn (`gate.ts:210`), so
  another node's pause cannot land between a block and its own list.
- The piped branch (`readReplyLine`) ignores `block` entirely — it writes the
  `message` and nothing else, exactly as today.
- Export `isInteractive()` (`gate.ts:154`) — task-5 needs the same single TTY
  predicate for its withholding decision. One definition, two callers.
- A caller that passes no `block` must produce byte-identical output to today: this
  is what keeps ACP permission prompts (`acp.ts:240`) unchanged.

Testing: `tests/gate-stdin.test.ts:20-30` already fakes an interactive terminal over
`PassThrough` pipes and captures everything clack writes — extend that harness
rather than inventing a second one. The atomicity scenario needs two overlapping
`promptChoice` calls and an assertion on write order.
