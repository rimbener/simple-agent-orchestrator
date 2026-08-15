# Mutation Testing Report: improve-terminal-text

## Mutation Score

- **Overall:** 100% (1986 killed, 1755 timeout, 0 survived, 0 no-coverage, 0 errors)
- **Based on covered code:** 100%

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

None.

## Summary

Three findings from the prior round are now resolved.

**`src/runners/claude.ts:230` and `src/runners/codex.ts:253` (NoCoverage → killed).** The
`// Stryker disable next-line ... unreachable under bun` comments on the non-ENOENT
`else` branch were wrong: reproduced by hand with a real `spawn()` call under Bun using a
command found on `PATH` (so it passes the OS's own executable check) whose shebang points
at a non-executable interpreter — this delivers `EACCES` as an *async* `error` event, not
a synchronous throw, exactly the branch the comment claimed was unreachable. (A bare
`ENOEXEC` binary *does* throw synchronously, which is why the ENOENT-only assumption
looked plausible.) Removed the three stale disable comments in each file and added
`tests/runners.test.ts` / `tests/codex.test.ts` — `"a non-ENOENT spawn failure (EACCES)
surfaces the spawn message, not the install hint"` — using that exact repro. Both files
are now 100% (0 survived, 0 no-coverage), confirmed by
`bunx stryker run --force --mutate "src/runners/claude.ts,src/runners/codex.ts"`.

**`src/options.ts:45`'s catch-block `BlockStatement` mutant (Survived → killed).** Genuinely
equivalent, as previously documented (JSON.parse fails mid-assignment, so `parsed` stays
`undefined` whether or not the catch body runs). The deferred `disable`/`restore` range
pair is now in place: `// Stryker disable BlockStatement` sits as the last line inside the
`try` block (after the `StringLiteral` disable-next-line, before the `} catch {`), and
`// Stryker restore BlockStatement` sits on its own line immediately after the catch
block's closing brace — not as the last line of any enclosing block, avoiding the
silence-to-end-of-file trap. `src/options.ts` is now 100% (0 survived, 0 no-coverage),
confirmed by `bunx stryker run --force --mutate "src/options.ts"`.

**New finding surfaced while re-running `codex.ts` (Survived, found and killed same round):**
a `ConditionalExpression` mutant at `src/runners/codex.ts:235` forcing
`if (collector.turnEnded && turnGrace === undefined && !settled)` to `if (true)`. Under the
mutant, the turn-end grace timer would start on the *first* stdout chunk regardless of
whether the turn has actually ended, killing the process and settling early. Reproduced by
hand (forced the guard to `true`, ran the new test, watched it fail with the wrong output;
reverted). Killed with a new test in `tests/codex.test.ts` — `"output before turn.completed
does not start the grace timer early"` — that emits an agent message, sleeps past the grace
window, then emits a second message and `turn.completed`; the real guard doesn't arm the
timer until `turnEnded` is true, so the process reaches the second message and exits
naturally, while the mutant kills it after the first.

Full re-run (`bunx stryker run --force`, whole scope): 100% mutation score, 0 survived,
0 no-coverage, across all files. Threshold met.
