# improve-terminal-text — spec

At an interactive terminal, a pause renders the text the human must read as **one
boxed, markdown-rendered, marker-free block, shown exactly once**. With no
interactive terminal, output is byte-for-byte what it is today.

Problem and user: [`user-story.md`](./user-story.md). Acceptance criteria: the `@s`
scenarios in [`gherkin-scenarios.md`](./gherkin-scenarios.md), and no others. Work
breakdown: [`tasks.md`](./tasks.md).

## Surfaces touched

| Surface | Change |
| --- | --- |
| `src/render.ts` (new leaf) | markdown subset → ANSI plus marker stripping. Pure, total, no new dependency (D1) |
| `src/gate.ts` | `block?` on the prompt request, drawn with `@clack/prompts` `note()` in the **TTY branch only**; `isInteractive()` exported (D3) |
| `src/engine.ts` | passes the block at loop and gate pauses; withholds an interactive-loop iteration's echo per the runner's declared granularity, releases it minus the final output (D2) |
| `src/runners/types.ts` + adapters | `finalOutputStreaming?: "per-message" \| "whole-turn"` on `Runner`. **Amends `SPEC.md`'s Runner interface** (D2) |

No YAML schema change, no CLI flag, no `state.json` change, nothing new asked of an
agent. Nothing persisted: the config hash is untouched, an in-flight run resumes and
its pause looks like a first run's, and `nodes.<id>.output`, `{{loop.feedback}}`,
`state.json` and the logs keep the raw text.

## Mechanism

```mermaid
sequenceDiagram
  participant R as "runner adapter"
  participant L as "engine iterLog"
  participant E as "engine executeLoop"
  participant G as "gate.ts promptChoice"
  R->>L: "onOutput chunk"
  L->>L: "log file: every chunk, verbatim, always"
  Note over L: "the echo is held, never the log —<br/>only at a TTY, only in an interactive loop"
  alt "per-message (claude, codex)"
    L-->>E: "echo the PREVIOUS chunk live;<br/>hold only the latest"
  else "whole-turn (opencode, unset)"
    L-->>E: "hold the whole iteration"
  end
  R->>E: "result.output"
  E->>L: "release(finalOutput)"
  L-->>E: "echo the held text minus the last<br/>occurrence of finalOutput"
  E->>E: "strip markers, render markdown"
  E->>G: "promptChoice(message, choices, block)"
  G->>G: "TTY: note(block, title), then the list<br/>piped: no block at all"
```

## Error contract

No validation-time errors; nothing here can fail a run — the renderer is total, so
unsupported markdown passes through literally. Two dim, non-halting notices:

- `⚠ <node>: agent emitted <promise>NAME</promise>, expected <SIGNAL>` — a stripped
  sentinel whose name is not the loop's (D6).
- `(the agent sent no text)` in place of a box when the message is empty,
  whitespace-only or nothing but markers — the pause stays usable.

## Resolved decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | Hand-rolled `src/render.ts`. Subset: ATX headings, bold/italic, inline + fenced code, bullet/numbered lists, blockquote, rules | `SPEC.md` keeps dependencies minimal, and `marked-terminal` renders far more than a pause needs. A pure string→string function mutation-tests cleanly |
| D2 | A runner declares `finalOutputStreaming`: claude/codex `per-message`, opencode `whole-turn`, unset `whole-turn`. Either way the pause drops the **last** occurrence of `result.output` from the held echo, so a miss shows the message twice, never zero times | The human lifted the story's "no runner change" at the gate to buy liveness (`user-story.md` Notes): `whole-turn` alone would land an iteration's narration in one burst at the pause. So the field is a hint, not a contract — `whole-turn` is correct for every runner, an unset adapter is safe, and adding a runner is still one file plus a registry entry |
| D3 | `@clack/prompts` `note()`, drawn only in `runListPrompt` | no drawing code, and `note` wraps via `wrap-ansi` so styling survives. The TTY branch makes non-TTY byte-identical by construction and keeps the block in the serialized prompt turn. Cost: hard wrapping breaks long URLs |
| D4 | Gate messages take the same path | identical defect: a gate interpolating `{{nodes.<id>.output}}` pastes agent markdown, and a loop's output carries a sentinel |
| D5 | No cap on block length | the titled rule is what makes a long question findable; a cap moves the hunting into the log and adds a rows budget competing with `listMaxItems()` |
| D6 | Strip every well-formed `<options>…</options>` and any `<promise>NAME</promise>`; warn on an unexpected name | keeps "no machine markers" absolute, gates included. An unclosed `<options>` stays visible — hiding it would hide a real agent mistake |

No open decisions.

## Non-goals

The streamed echo outside a pause (keeps its dim `[<node>#<iter>]` prefix) ·
piped/non-TTY output · `--dry-run` plan output · ACP permission prompts · ACP
token-level streaming · markdown beyond the subset · truncating long messages ·
node output, `{{loop.feedback}}` or state contents.
