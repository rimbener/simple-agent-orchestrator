# improve-terminal-text — slice 2 TDD log

## @s → test map

| Scenario | Test |
| --- | --- |
| @s-runner-granularity-declared | tests/runners.test.ts › findExecutableOnPath / preflight › `@s-runner-granularity-declared: claudeRunner declares per-message final-output streaming`; tests/codex.test.ts › codexRunner.run › `@s-runner-granularity-declared: codexRunner declares per-message final-output streaming`; tests/opencode.test.ts › opencodeRunner › `@s-runner-granularity-declared: opencodeRunner declares whole-turn final-output streaming` |
| @s-runner-granularity-defaults | tests/engine-m2.test.ts › message appears exactly once › `@s-runner-granularity-defaults: ...` |
| @s-question-appears-once-per-message | tests/engine-m2.test.ts › message appears exactly once › `@s-question-appears-once-per-message: ...` |
| @s-question-appears-once-whole-turn | tests/engine-m2.test.ts › message appears exactly once › `@s-question-appears-once-whole-turn: ...` |
| @s-narration-still-streams | tests/engine-m2.test.ts › message appears exactly once › `@s-narration-still-streams: ...` |
| @s-repeated-text-keeps-earlier-copy | tests/engine-m2.test.ts › message appears exactly once › `@s-repeated-text-keeps-earlier-copy: ...` |
| @s-withheld-remainder-released | tests/engine-m2.test.ts › message appears exactly once › `@s-withheld-remainder-released: ...` |
| @s-withheld-released-on-failure | tests/engine-m2.test.ts › message appears exactly once › `@s-withheld-released-on-failure: ...` |
| @s-no-withholding-when-piped | tests/engine-m2.test.ts › message appears exactly once › `@s-no-withholding-when-piped: ...` |

## Cycles

- RED `tests/runners.test.ts`/`tests/codex.test.ts`/`tests/opencode.test.ts` against
  `Runner` with no `finalOutputStreaming` field → GREEN adding the optional field to
  `src/runners/types.ts` and declaring `"per-message"` on `claudeRunner`/`codexRunner`,
  `"whole-turn"` on `opencodeRunner`.
- RED `tests/engine-m2.test.ts` `@s-question-appears-once-per-message` (a per-message
  runner's final message still echoed live) against an unchanged `makeLog` → GREEN
  adding `release()` to `NodeLog`, a `withhold` mode to `makeLog` (per-message rotates
  the held call; whole-turn accumulates), `dropLastOccurrence` to drop the final
  message's last occurrence, `instructedRunnerGranularity` to read the iteration's
  runner declaration, and wiring `executeLoop` to compute `withhold` at `isInteractive()
  && body.interactive`, calling `iterLog.release(instructedOutput ?? "")` after options
  parsing and before `until_bash`.
- RED `@s-runner-granularity-defaults` (an undeclared runner's partial, newline-less
  chunks still fully withheld) exposed a real gap: the trailing-partial-line buffer
  (`pendingEcho`) was echoed unconditionally by `flush()`/ignored by `release()`,
  leaking a final message that never happened to end mid-chunk on a `\n`. GREEN: fold
  `pendingEcho` into `held` inside both `release()` and `flush()` before echoing/
  searching, only when withholding; the non-withholding path is untouched.
- RED `@s-question-appears-once-whole-turn`, `@s-narration-still-streams`,
  `@s-repeated-text-keeps-earlier-copy`, `@s-withheld-remainder-released`,
  `@s-withheld-released-on-failure`, `@s-no-withholding-when-piped`: each written
  against the code above and went GREEN immediately — the mechanism from the prior two
  cycles already covers them; kept as separate tests since each pins a distinct
  contract (ordering, repeat-text, non-final remainder, failure release, piped no-op).
- Docs: `SPEC.md`'s Runner interface gained `finalOutputStreaming` with its default and
  reason; the Loop semantics section gained a paragraph on withhold-and-release.
  `README.md`'s interactive-loop paragraph gained one sentence. All landed in this
  slice's commit.
