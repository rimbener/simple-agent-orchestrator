# improve-terminal-text — slice 1 review

Scope: task-1 (`src/render.ts`), task-2 (`src/gate.ts`), task-3 (`src/engine.ts` +
docs), per `tdd-1.md`'s `@s → test` map, against `gherkin-scenarios.md` and
`spec.md`.

## Verdict: CHANGES_REQUESTED

## Findings

### 1. [quality] `src/engine.ts:18` — import not alphabetically ordered, fails `bun run lint`

`import { renderBlock } from "./render";` is inserted between `./parser` (line 17)
and `./procs` (line 19). `procs` sorts before `render` alphabetically, so this
import block is not in the order biome.json's `assist.actions.source.organizeImports:
"on"` enforces. `bun run lint` runs `biome check src tests`, which applies that
assist alongside the linter — this file will be flagged. The slice gate only ran
`typecheck`/`test:orchestrator`, so this survived to review; it will not survive
`bun run bootstrap` or CI's lint step.

Failure scenario: run `bun run lint` (or `bun run bootstrap`) on this branch — it
reports/rewrites `src/engine.ts`'s import order, i.e. the tree is not in the state
the repo's own verify order (`format` → `lint` → `typecheck` → `test`) requires.

Status: resolved — reordered the `./render` import statement after `./procs`, and
also fixed the same file's `./gate` named-import sort order (a second
`organizeImports` violation in this slice's own diff that `bun run lint` still
flagged after the statement-order fix) plus the identical issue in `src/gate.ts`'s
new `note` import. `bun run lint` now reports zero findings in files this slice
touched (the pre-existing `src/acp.ts` sort issue is untouched — out of scope).

### 2. [quality] Several new lines exceed the project's 120-column line width, fails `bun run format`

`biome.json` sets `formatter.lineWidth: 120`. New lines added by this slice exceed
it and would be rewrapped by `bun run format:fix` / flagged by `bun run format`:

- `tests/gate-stdin.test.ts:282` — `const reply = promptChoice({ message: "gate: ", choices: CHOICES, block: "the rendered question", blockTitle: "[work#1]" });` (128 cols)
- `tests/gate-stdin.test.ts:320` — the `@s-block-atomic-with-its-list` test's title line (126 cols)
- `tests/gate-stdin.test.ts:344` — `const reply = promptChoice({ message: "gate: ", choices: CHOICES, block: "hidden question", blockTitle: "[work#1]" });` (122 cols)
- `tests/engine-m2.test.ts:1115` — the `@s-loop-question-in-block` test's title line (132 cols)

Failure scenario: run `bun run format` on this branch — it reports these files as
needing reformatting, i.e. the tree is not in the state the repo's own verify
order requires, same as finding 1.

Status: resolved — ran `bun run format:fix`, which rewrapped the two flagged
`gate-stdin.test.ts` call sites and reformatted the corresponding lines in
`engine-m2.test.ts`. `bun run format` now reports no fixes needed.

## What was checked and is clean

- **Correctness against the contract**: every `@s` scenario this slice owns has a
  test in `tdd-1.md`'s map, and each test asserts concrete, falsifiable output
  (rendered strings, exact `block`/`blockTitle` values, printed-line contents,
  byte-identical piped output) rather than just "did not throw". No `SaoError` is
  added by this slice (checked — all `new SaoError` sites are pre-existing).
- **Minimalism**: no `package.json`/lockfile/`patches/` change; `src/render.ts` is
  a genuine leaf (only imports `picocolors` and `./options`, itself dependency-free
  beyond `zod`) — matches D1's "no new dependency" and the spec's "new leaf" claim.
- **Layering**: `render.ts` reusing `OPTIONS_BLOCK` from `options.ts` is leaf→leaf,
  no upward import; `gate.ts` and `engine.ts` changes stay within their existing
  layers; no new runner file, no dynamic loading.
- **Node target**: no Bun-only API introduced; `bun:test` stays confined to
  `tests/render.test.ts`.
- **Process safety**: unaffected — this slice touches no child-process code.
- **Path/input/argv safety**: `strip`/`render`/`renderBlock` are pure string→string
  functions; nothing user-controlled reaches a path, argv slot or refspec.
- **State durability**: nothing new persisted — `block`/`blockTitle` are
  recomputed at each pause from the already-persisted `instructedOutput`, verified
  against `@s-resume-pause-identical`; no `src/state.ts` change.
- **CLI/workflow surface**: the block is drawn only in `runListPrompt`'s TTY
  branch (`isInteractive()`), gated identically to the existing `promptChoice`
  fork, so the piped path is provably byte-identical by construction and by test
  (`@s-block-absent-when-piped`, `@s-loop-piped-unchanged`). ACP permission
  prompts (`src/acp.ts`) call `promptChoice` with no `block`, so `@s-permission-
  prompt-unchanged` holds structurally, not just by test. `NO_COLOR` handling in
  `render()` uses the same `picocolors` convention already relied on elsewhere.
- **Docs parity**: `SPEC.md` and `README.md` both gained the pause-block
  paragraph in this slice's diff, matching the new behavior; `task-1/2/3.md`
  status flips to `done` with no other edits.

## Resolution log

(updated in place as `fix-slice-findings` resolves each item above)
