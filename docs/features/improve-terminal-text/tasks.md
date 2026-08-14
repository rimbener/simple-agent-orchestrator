# improve-terminal-text — tasks

Three vertical slices. Each is independently green and exercisable end to end
through the `sao` CLI, and each carries its own `SPEC.md` / `README.md` update.

| Slice | Task | Title | Scenarios |
| --- | --- | --- | --- |
| **1 — the block at an interactive-loop pause** | [task-1](./task-1.md) | `src/render.ts`: markdown subset + marker stripping | `@s-render-emphasis` `@s-render-headings-lists` `@s-render-fenced-code` `@s-render-passthrough` `@s-render-no-color` `@s-strip-options-block` `@s-strip-options-unclosed` `@s-strip-promise-any` `@s-strip-reports-signal-names` |
| | [task-2](./task-2.md) | Draw the block in the prompt's TTY branch | `@s-block-boxed-at-tty` `@s-block-absent-when-piped` `@s-block-atomic-with-its-list` `@s-permission-prompt-unchanged` `@s-block-ctrl-c-unchanged` |
| | [task-3](./task-3.md) | Wire the interactive-loop pause + docs | `@s-loop-question-in-block` `@s-loop-pause-line-unchanged` `@s-loop-options-order-preserved` `@s-loop-empty-message` `@s-loop-message-only-marker` `@s-loop-unexpected-signal-warning` `@s-loop-options-warning-kept` `@s-loop-piped-unchanged` `@s-loop-log-verbatim` `@s-resume-pause-identical` |
| **2 — printed exactly once** | [task-4](./task-4.md) | Declare streaming granularity on `Runner`, withhold the echo + `SPEC.md` update | `@s-runner-granularity-declared` `@s-runner-granularity-defaults` `@s-question-appears-once-per-message` `@s-question-appears-once-whole-turn` `@s-narration-still-streams` `@s-repeated-text-keeps-earlier-copy` `@s-withheld-remainder-released` `@s-withheld-released-on-failure` `@s-no-withholding-when-piped` |
| **3 — gate pauses** | [task-5](./task-5.md) | Gates through the same block + docs | `@s-gate-message-in-block` `@s-gate-strips-markers` `@s-gate-piped-unchanged` |

Slice order matters: slice 1 leaves the message visible twice (block plus dim
stream) — a readable question with a known duplicate. Slice 2 removes the
duplicate. Slice 3 extends the finished path to gates.
