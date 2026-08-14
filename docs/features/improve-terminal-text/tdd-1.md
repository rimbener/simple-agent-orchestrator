# improve-terminal-text — slice 1 TDD log

## @s → test map

| Scenario | Test |
| --- | --- |
| @s-render-emphasis | tests/render.test.ts › render — inline emphasis › `@s-render-emphasis: ...` |
| @s-render-headings-lists | tests/render.test.ts › render — headings and lists › `@s-render-headings-lists: ...` |
| @s-render-fenced-code | tests/render.test.ts › render — fenced code › `@s-render-fenced-code: ...` |
| @s-render-passthrough | tests/render.test.ts › render — passthrough › `@s-render-passthrough: ...` |
| @s-render-no-color | tests/render.test.ts › render — NO_COLOR › `@s-render-no-color: ...` |
| @s-strip-options-block | tests/render.test.ts › strip › `@s-strip-options-block: ...` |
| @s-strip-options-unclosed | tests/render.test.ts › strip › `@s-strip-options-unclosed: ...` |
| @s-strip-promise-any | tests/render.test.ts › strip › `@s-strip-promise-any: ...` |
| @s-strip-reports-signal-names | tests/render.test.ts › strip › `@s-strip-reports-signal-names: ...` |
| @s-block-boxed-at-tty | tests/gate-stdin.test.ts › promptChoice — interactive terminal › `@s-block-boxed-at-tty: ...` |
| @s-block-absent-when-piped | tests/gate-stdin.test.ts › promptChoice — piped, with a block › `@s-block-absent-when-piped: ...` |
| @s-block-atomic-with-its-list | tests/gate-stdin.test.ts › promptChoice — interactive terminal › `@s-block-atomic-with-its-list: ...` |
| @s-permission-prompt-unchanged | tests/gate-stdin.test.ts › promptChoice — interactive terminal › `@s-permission-prompt-unchanged: ...` |
| @s-block-ctrl-c-unchanged | tests/gate-stdin.test.ts › promptChoice — interactive terminal › `@s-block-ctrl-c-unchanged: ...` |
| @s-loop-question-in-block | tests/engine-m2.test.ts › interactive loop pause block › `@s-loop-question-in-block: ...` |
| @s-loop-pause-line-unchanged | tests/engine-m2.test.ts › interactive loop pause block › `@s-loop-pause-line-unchanged: ...` |
| @s-loop-options-order-preserved | tests/engine-m2.test.ts › interactive loop pause block › `@s-loop-options-order-preserved: ...` |
| @s-loop-empty-message | tests/engine-m2.test.ts › interactive loop pause block › `@s-loop-empty-message: ...` |
| @s-loop-message-only-marker | tests/engine-m2.test.ts › interactive loop pause block › `@s-loop-message-only-marker: ...` |
| @s-loop-unexpected-signal-warning | tests/engine-m2.test.ts › interactive loop pause block › `@s-loop-unexpected-signal-warning: ...` |
| @s-loop-options-warning-kept | tests/engine-m2.test.ts › interactive loop options › `@s-loop-malformed-fallback @s-loop-options-warning-kept: ...` (pre-existing behavior, unchanged by this slice) |
| @s-loop-piped-unchanged | tests/engine-m2.test.ts › interactive loop pause block › `@s-loop-piped-unchanged: ...` |
| @s-loop-log-verbatim | tests/engine-m2.test.ts › interactive loop pause block › `@s-loop-log-verbatim: ...` |
| @s-resume-pause-identical | tests/engine-m2.test.ts › interactive loop pause block › `@s-resume-pause-identical: ...` |

## Cycles

- task-1: RED `tests/render.test.ts` against a missing `src/render.ts` → GREEN adding
  `strip`/`render`/`renderBlock` (`src/render.ts`), exporting `OPTIONS_BLOCK` from
  `src/options.ts` for reuse. Refactor: NUL-delimited placeholder for inline code
  spans (a space-delimited one collided with plain numbers in prose).
- task-2: RED new `tests/gate-stdin.test.ts` cases against `PromptChoices` with no
  `block`/`blockTitle` → GREEN adding both fields to the type, drawing `block` via
  `@clack/prompts` `note()` in `runListPrompt` only, exporting `isInteractive()`.
- task-3: RED new `tests/engine-m2.test.ts` cases (with `process.stdin`/`stdout`
  `isTTY` faked per test) against unchanged `askLoopGate` → GREEN threading
  `instructedOutput` into `askLoopGate`, computing `block`/`blockTitle` and the
  empty-message / unexpected-signal notices only under `isInteractive()`. Added a
  file-wide `beforeEach`/`afterEach` forcing `isTTY = false` so the piped-path tests
  never depend on whether `bun test` itself runs from a terminal.
- Docs: `SPEC.md`'s Loop semantics and `README.md`'s interactive-loop section each
  gained one paragraph/sentence on the pause block, landed in the task-3 commit.
