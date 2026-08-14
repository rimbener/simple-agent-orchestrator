# improve-terminal-text — slice 3 TDD log

## @s → test map

| Scenario | Test |
| --- | --- |
| @s-gate-message-in-block | tests/engine-m2.test.ts › gate pause block › `@s-gate-message-in-block: a gate's message renders in the same titled box, list offered below` |
| @s-gate-strips-markers | tests/engine-m2.test.ts › gate pause block › `@s-gate-strips-markers: a gate message carrying an interpolated promise token is cleaned` |
| @s-gate-piped-unchanged | tests/engine-m2.test.ts › gate nodes › `@s-gate-piped-unchanged: piped replies with no list selection keep today's vocabulary` (pre-existing; the piped path never computes `block`, so it stays byte-for-byte unchanged by construction) |

## Cycles

- RED `@s-gate-message-in-block` (interactive terminal, bold message) against
  `executeGate` passing no `block`/`blockTitle` to `promptChoice` → GREEN: compute
  `block`/`blockTitle` from `renderBlock(message)` only when `isInteractive()`,
  titled `[<node>]` (no iteration — a gate has none), pass both through to
  `promptChoice` alongside the unchanged `question`/`choices`.
- RED `@s-gate-strips-markers` (gate message interpolates a loop node's raw output
  carrying `<promise>SETTLED</promise>`) against the same unmodified `executeGate`
  → went GREEN with the same change: `renderBlock` strips every `<promise>` token
  regardless of name, and a gate has no `until:` signal to compare against, so no
  unexpected-name warning is computed here (unlike the loop pause).
- Docs: `SPEC.md`'s Gate semantics section gained the block paragraph, alongside
  the existing interactive-vs-piped split. `README.md`'s gate example gained one
  sentence. Both landed in this slice's commit.
- RED (review finding 1) `@s-gate-message-in-block` / `@s-gate-strips-markers`
  extended with `expect(req.message).not.toContain(...)` on the interactive path
  → both failed against `executeGate`'s single shared `question` (raw message
  embedded, sent to `promptChoice` on both branches) → GREEN: split `question` —
  piped path keeps the raw-message-embedded string unchanged; interactive path
  reassigns it to `\n[${node.id}] ` (mirrors `askLoopGate`'s bare status line),
  leaving the rendered/stripped text solely in `block`.
