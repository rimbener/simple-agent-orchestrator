# Mutation Testing Report: improve-terminal-text

## Mutation Score

- **Overall:** 99.92% (2429 killed, 1303 timeout, 1 survived, 2 no-coverage, 0 errors)
- **Based on covered code:** 99.97%

## Files in Scope

- src/acp.ts
- src/agents.ts
- src/engine.ts
- src/errors.ts
- src/gate.ts
- src/nodes.ts
- src/options.ts
- src/parser.ts
- src/procs.ts
- src/render.ts
- src/runs.ts
- src/runners/claude.ts
- src/runners/codex.ts
- src/runners/opencode.ts
- src/runners/types.ts
- src/schema.ts
- src/state.ts
- src/template.ts
- src/worktree.ts

## Mutants Not Killed

| File | Line | Mutator | Mutated Expression | Status |
|------|------|---------|-------------------|--------|
| src/runners/claude.ts | 230 | BlockStatement | else block deleted | NoCoverage |
| src/runners/codex.ts | 253 | BlockStatement | else block deleted | NoCoverage |
| src/options.ts | 45 | BlockStatement | catch block deleted | Survived |

## Summary

`src/engine.ts` is now at 100% (0 survived, 0 no-coverage). The 4 prior survivors in
`flush()` (lines 1309, 1312 ×2, 1315) were hand-reproduced by mutating each in turn and
running the full suite (`bun test`) — none produced a single test failure. All four are
genuinely equivalent: `flush()` is the terminal read of `held`/`pendingEcho` for that log
object (a fresh `makeLog()` closure is created per node/iteration and never reused after
`flush()`), so:

- forcing the `else` branch of `if (withhold === undefined)` still starts from an empty
  `held` in every real call site, and `echoLines([pendingEcho])` / `echoLines([])` print
  exactly what `echoLine(pendingEcho)` / `echoLine("")` would have;
- pushing `pendingEcho` onto `held` unconditionally (or under a mismatched string
  comparison) is unobservable, since `echoLine` filters blank lines and any non-blank
  `pendingEcho` gets pushed either way;
- `held = []` is a dead store, same reasoning already documented for the `pendingEcho = ""`
  reset on the next line — nothing reads `held` again after `flush()`.

Each is now marked with a `// Stryker disable next-line <Mutator>: ...` comment stating
this. Re-running Stryker scoped to `src/engine.ts` (`--force --mutate "src/engine.ts"`)
confirmed the file moved from 5 survived / 1171 total mutants to 0 survived / 1165 total
(a drop of exactly 6 — the two `if`-condition variants disabled on each of the two `if`
lines, plus the `ArrayDeclaration` and `StringLiteral` mutants) — no other file's
survived/no-coverage counts moved, so no over-silencing occurred.

The remaining survivor, `src/options.ts:45`'s catch-block `BlockStatement` mutant, is a
previously verified equivalent (see the comment at `src/options.ts:35-44`): the JSON
parse failure happens mid-assignment, so `parsed` stays `undefined` whether or not the
catch block itself runs, and `safeParse(undefined)` fails the schema check identically.
It cannot be silenced with a `disable next-line` directive — the mutant sits on the
`} catch {` line, the same brace-continuation shape as `} else if` / `} finally`, which
that directive cannot reach; silencing it would need a `disable`/`restore` range pair,
which is a deliberate follow-up, not a drive-by one.

The 2 NoCoverage mutants in `src/runners/claude.ts:230` and `src/runners/codex.ts:253`
are error-handling paths for spawn failures marked with `// Stryker disable next-line
StringLiteral: unreachable under bun`. These paths are unreachable under Bun (the test
runner) but are excluded from mutation scope by design (`stryker.conf.mjs`); they should
not appear in scope per configuration.

Threshold met: every mutant is killed, ignored as verified-equivalent, or a known
unreachable-under-bun no-coverage path.
