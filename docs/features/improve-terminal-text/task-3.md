---
id: task-3
title: "Wire the interactive-loop pause to the block, plus docs"
slice: "1 — the block at an interactive-loop pause"
scenarios:
  - "@s-loop-question-in-block"
  - "@s-loop-pause-line-unchanged"
  - "@s-loop-options-order-preserved"
  - "@s-loop-empty-message"
  - "@s-loop-message-only-marker"
  - "@s-loop-unexpected-signal-warning"
  - "@s-loop-options-warning-kept"
  - "@s-loop-piped-unchanged"
  - "@s-loop-log-verbatim"
  - "@s-resume-pause-identical"
status: done
paths:
  - src/engine.ts
  - tests/engine-m2.test.ts
  - SPEC.md
  - README.md
---

`askLoopGate` (`engine.ts:1140`) gains the iteration's agent output and passes a
block alongside its existing message and choices.

- Strip + render the instructed step's output (task-1) and pass it as `block`, with
  `blockTitle` = `[<node>#<iteration>]`. Only when `isInteractive()` — piped runs
  must pass no block at all.
- In a multi-step interactive loop the block is the **instructed** (last AI) step's
  output only; every other step's output stays ordinary echo.
- The pause `message` (`engine.ts:1147-1148`) and the whole choice list
  (`engine.ts:1150-1157`) are unchanged: same `agent signaled X` / `no signal yet`
  line, same agent options in declared order, same run entries.
- Empty, whitespace-only, or markers-only output → pass no block, print one dim
  `(the agent sent no text)` line, and pause as usual.
- Unexpected signal name: for each promise name task-1 reports that is not this
  loop's `until:`, print the dim
  `⚠ <node>: agent emitted <promise>NAME</promise>, expected <SIGNAL>`. Do not halt,
  and do not touch signal detection (`engine.ts:1059`) — a wrong name still means
  `no signal yet`.
- Do not touch what is logged. `iterLog.log` keeps writing raw chunks to the log
  file, and the block is a terminal-only render — the log must stay escape-free.
- `{{loop.feedback}}`, `nodes.<id>.output` and `state.json` keep the raw text.

Docs in this slice: `SPEC.md`'s **Loop semantics** interactive-loop paragraph gains
the block's behaviour and its interactive-terminal-only condition; `README.md`'s
interactive-loop section (`README.md:165-181`) gains a sentence for the reader who
will see the box, keeping the existing piped-reply paragraph as the contrast.
