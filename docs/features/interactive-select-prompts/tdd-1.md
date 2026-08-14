# tdd-1 — List prompt seam, TTY detection, packaging

## @s → test map

| Scenario | Test |
| --- | --- |
| `@s-list-at-terminal` | `tests/gate-stdin.test.ts` → `promptChoice — interactive terminal > @s-list-at-terminal: ...` |
| `@s-list-no-menu-when-piped` | `tests/gate-stdin.test.ts` → `promptChoice — piped (not an interactive terminal) > @s-list-no-menu-when-piped: ...` |
| `@s-list-stdin-closed-fails` | `tests/gate-stdin.test.ts` → `promptChoice — piped (not an interactive terminal) > @s-list-stdin-closed-fails: ...` |
| `@s-list-serialized-across-branches` | `tests/gate-stdin.test.ts` → `promptChoice — piped ... > @s-list-serialized-across-branches: ...` and `promptChoice — interactive terminal > @s-list-serialized-across-branches: ...` |
| `@s-list-interrupt` | `tests/gate-stdin.test.ts` → `promptChoice — interactive terminal > @s-list-interrupt: ...` |
| `@s-list-longer-than-terminal` | `tests/gate-stdin.test.ts` → `promptChoice — interactive terminal > @s-list-longer-than-terminal: ...` |
| `@s-windows-installable` | `tests/cli.test.ts` → `package metadata > @s-windows-installable: ...` |
| `@s-windows-prompt-portable` | `tests/cli.test.ts` → `package metadata > @s-windows-prompt-portable: ...` |

## Cycles

1. RED/GREEN: `promptChoice` piped path resolves `{ kind: "text" }` from a buffered/waited line, writing no menu — extracted `readReplyLine` out of `promptOnTerminal` (behavior-preserving refactor) so both share the buffered-line/readline machinery.
2. RED/GREEN: piped-path stdin-closed rejection and cross-turn queue serialization for the piped path.
3. RED/GREEN: interactive path — `isInteractive()` gate, `runListPrompt` via `@clack/prompts` `select`, confirming an entry with no letter/number menu rendered.
4. RED/GREEN: `collectsText` choice runs `clackText` inside the same queued turn, resolving `{ kind: "text", from }`; a second queued `promptChoice` call can't interleave between the selection and its text entry.
5. RED/GREEN: `@s-list-longer-than-terminal` — `listMaxItems()` bounds the visible window below the full option count; an entry past it is still reachable and selectable.
6. RED/GREEN: `@s-list-interrupt` — clack cancel re-raises `SIGINT` on the process (`reraiseSigint`); verified by breaking the re-raise and watching the test fail before restoring.
7. RED/GREEN: `@s-windows-installable` — `package.json` drops `os`, `engines.node` is `>=20.12`, `@clack/prompts` is a dependency.
8. RED/GREEN: `@s-windows-prompt-portable` — `src/gate.ts` signals only `SIGINT`; `SPEC.md` records the manual Windows smoke check.

## Docs

`SPEC.md` § *Decisions (locked)* Distribution row (raised node floor, Windows install, manual check) and the Dependencies paragraph in § *Project structure* — both amended.
