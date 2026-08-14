# review-slice-1 — List prompt seam, TTY detection, packaging

Verdict: **CHANGES_REQUESTED**

## Findings

### 1. [quality] `src/gate.ts:66-69` — `Stryker disable all` rationale is false for the code this slice added — `resolved`

The block disables mutation testing from `stdinClosedError()` (line 71) through
`resetPromptState()` (line 228), on the stated grounds that "everything below
drives the real process stdin, which is exercised exclusively by the
spawned-CLI tests in `cli.test.ts` — invisible to per-test coverage, so every
mutant would report NoCoverage."

That's no longer true for most of what's inside the span. `tests/gate-stdin.test.ts`
imports `promptOnTerminal`, `promptChoice` and `resetPromptState` directly and
drives them **in-process** by swapping `process.stdin`/`process.stdout` for
in-memory `PassThrough` pipes (`tests/gate-stdin.test.ts:1-19`) — not a spawned
CLI subprocess. With `coverageAnalysis: "perTest"` (`stryker.conf.mjs`) and
`mutate: ["src/**/*.ts", "!src/cli.ts"]` (gate.ts is in scope), Stryker's
per-test coverage tracking *would* see hits on `readReplyLine`,
`isInteractive`, `listMaxItems`, `reraiseSigint`, `runListPrompt` and
`promptChoice` from this exact suite — the disable directive is what's hiding
that, not a real coverage gap.

This slice added ~90 lines of new branching logic into that span (the
interactive/piped fork, the `maxItems` bound, the `collectsText` follow-up,
cancel handling) and put it under a disable comment whose justification is
demonstrably wrong for it, without narrowing the disabled range. Per the repo
rule, "a `// Stryker disable` comment must state why the mutant is equivalent
or unreachable" — this one doesn't, for the code newly placed inside it.
Leaving it as-is silently exempts this slice's new logic from the mutation
score the suite otherwise holds at 100%.

Fix: narrow the disable/restore span to only the parts that genuinely can't be
driven except by a spawned subprocess (if any remain — `ensureReadline`'s
`process.stdin.readableEnded`/`destroyed` checks may qualify), and let Stryker
mutate the rest.

Resolved: checked every function inside the disabled span against
`tests/gate-stdin.test.ts` — `stdinClosedError`, `ensureReadline` (including its
`readableEnded`/`destroyed` early-return, exercised by the "destroyed stdin" and
"EOF" tests), `readReplyLine`, `promptOnTerminal`, `isInteractive`,
`listMaxItems`, `reraiseSigint`, `runListPrompt`, `promptChoice`, and
`resetPromptState` all have direct in-process coverage. Nothing left in the span
needs a spawned subprocess, so the `Stryker disable all`/`restore all` pair was
removed outright rather than narrowed — mutation testing now runs over the whole
file.

### 2. [docs] `README.md:70` — stale Node version claim contradicts this slice's `engines.node` bump — `resolved`

`README.md:70` reads "Requires Node 20+ (or Bun), git, and at least one agent
CLI:". This slice raised `package.json`'s `engines.node` to `>=20.12`
(`package.json:30`, asserted by `tests/cli.test.ts`'s
`@s-windows-installable` test) and documented the reason in `SPEC.md`'s
Distribution row, but left the README's install requirement unchanged. Section
5 (Docs parity) requires the README update alongside `SPEC.md` for anything
user-facing — a minimum-Node bump that gates `npm install` is exactly that: a
user following the README's "Node 20+" claim can land on 20.0–20.11 and hit an
install/runtime failure the doc doesn't warn about.

Fix: update `README.md:70` to `Requires Node 20.12+ (or Bun), ...`.

Resolved: `README.md:70` now reads "Requires Node 20.12+ (or Bun), ...".

## Not flagged

- New dependency `@clack/prompts` (+ transitive `@clack/core`, `sisteransi`,
  `fast-string-width`, `fast-wrap-ansi`) is recorded as a decision in
  `SPEC.md`'s Dependencies paragraph and `spec.md`'s Surfaces-touched table —
  satisfies the minimalism gate. Placed in `devDependencies` alongside
  `commander`/`yaml`/`zod`/`picocolors`, matching this repo's existing
  (pre-slice) convention of bundling all runtime deps via `bun build` rather
  than using a `dependencies` field — not something this slice introduced.
- No `patchedDependencies`/`patches/` touched.
- Layering, Node-target, process-safety and state-durability sections: N/A —
  no local-module imports added, no Bun-only API, no subprocess spawned, no
  `state.json` shape touched.
- CLI & workflow surface: mostly N/A per `task-1.md` — this slice only widens
  the internal seam and packaging; no caller wires user-visible list rendering
  yet (tasks 2/3/5/6 do). Packaging surface (`os`/`engines.node`) is covered by
  finding 2 above.
- Tests bite: `@s-windows-installable`, `@s-windows-prompt-portable`,
  `@s-list-interrupt` and the queue-serialization tests all assert concrete,
  falsifiable expectations (exact `engines.node` string, exact signal set,
  exact `process.kill` call, non-interleaved queue order).
