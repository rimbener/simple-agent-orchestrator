# improve-terminal-text — slice 3 review

**Verdict: CHANGES_REQUESTED**

## Scope reviewed

`git diff` (README.md, SPEC.md, docs/features/improve-terminal-text/task-5.md,
src/engine.ts, tests/engine-m2.test.ts) plus the untracked
`docs/features/improve-terminal-text/tdd-3.md`. Cross-checked against
`gherkin-scenarios.md`'s `@s-gate-message-in-block` / `@s-gate-strips-markers` /
`@s-gate-piped-unchanged` block and `SPEC.md`'s gate-pause paragraph.

## Findings

### 1. [correctness] resolved — gate's raw, unstripped message is still rendered on the interactive terminal, alongside the new box

`src/engine.ts:944-945` builds `question` from the raw interpolated
`node.gate.message` (markdown and `<promise>` markers intact):

```ts
const message = interpolate(node.gate.message, this.ctx);
const question = `\n${message}\n[${node.id}] `;
```

`src/engine.ts:961-962` passes that same `question` as `req.message` to
`promptChoice` **unconditionally** — interactive or piped:

```ts
const answer = await this.promptChoice({ message: question, choices, block, blockTitle });
```

On the interactive path, `runListPrompt` (`src/gate.ts:196-204`) feeds
`req.message` straight into `clackSelect({ message: req.message, ... })`, which
prints it verbatim (no stripping, no markdown rendering) as the select prompt's
own title, in addition to the new `note(block, blockTitle)` box. So at a real
interactive terminal, a gate whose message is `"Ship? {{nodes.grill.output}}"`
where `nodes.grill.output` is `"done <promise>SETTLED</promise>"` shows:

- the clean, rendered box (`block`) — correct — **and also**
- the literal, unstripped line `Ship? done <promise>SETTLED</promise>` as the
  select prompt's question text, immediately below it.

This directly contradicts `@s-gate-strips-markers` ("no promise token appears on
the terminal" — it does, just outside the box) and the spirit of
`@s-gate-message-in-block` (message rendered "inside a box", not inside the box
*and* raw beside it). Compare `askLoopGate` (`src/engine.ts:1171-1172`), which
this slice's docs cite as the pattern to mirror: its `message` is a bare status
line (`"iteration N — status"`) that never carries the agent's raw content —
the rendered/stripped text lives *only* in `block`. The gate's `question` needs
the same split: keep it as-is for the piped path (`@s-gate-piped-unchanged`
requires byte-for-byte), but on the interactive path the value handed to
`promptChoice` as `message` must not re-embed the raw `node.gate.message`.

Not caught by either new test because both only assert on `req.block`
(`tests/engine-m2.test.ts:1862-1908`) and never inspect `req.message`, so the
duplicate/unstripped render passes silently.

**Fix**: on the interactive branch, build a `question` that excludes the raw
gate message (e.g. just `\n[${node.id}] `), leaving the rendered text solely in
`block`; keep today's `question` (with the embedded raw message) for the piped
branch only. Extend both new tests to assert `req.message` does **not** contain
`"please decide"` / `"<promise>"` on the interactive path, so the fix is pinned.

**Resolution**: `src/engine.ts`'s `executeGate` now reassigns `question` to
`\n[${node.id}] ` on the `isInteractive()` branch, keeping the raw-message-
embedded string only on the piped path. Both tests extended per the fix note;
see `tdd-3.md`'s new cycle.

## Sections not separately findings-worthy

- **1. Correctness** — `@s` → test map in `tdd-3.md` matches
  `gherkin-scenarios.md`; both new tests bite for what they check (block content,
  stripping, title). Gap is the blocking finding above.
- **2. Repo rules** — no new dependency/abstraction, no `package.json`/lockfile/
  `patches/` touch. Layering unchanged (`engine.ts` → `render.ts` is pre-existing,
  downward). No Bun-only API. No process/state/durability surface touched.
- **3. Code quality** — the new `executeGate` branch mirrors `askLoopGate`'s
  existing `isInteractive()` pattern; comments explain the *why* (no `until`
  signal for a gate); no debug leftovers.
- **4. CLI & workflow surface** — no new YAML key, no schema/validate change.
  Both runners unaffected (gate pauses are runner-agnostic). Color/NO_COLOR
  handling is unchanged, reused from `render.ts`. The one gap is the finding
  above.
- **5. Docs parity** — `SPEC.md` and `README.md` updates land in this slice and
  describe the intended (block-only) behavior accurately; the code just doesn't
  fully deliver it yet (per the finding).
