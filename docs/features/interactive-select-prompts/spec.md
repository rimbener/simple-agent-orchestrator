# interactive-select-prompts — spec

Every human-facing pause renders its answers as a navigable list. The letter
prompt (`[a]pprove / [r]eject / or type feedback`) and the numbered permission
menu (`1. Allow`) are **deleted**, not supplemented. Interactive-loop iterations
also present the **agent's own options**, declared in the agent's output — the
channel the `<promise>` sentinel already travels.

Acceptance criteria: [gherkin-scenarios.md](./gherkin-scenarios.md).
Work: [tasks.md](./tasks.md). Problem: [user-story.md](./user-story.md).
Diagrams sit where the detail does: the pause's three-way fork in the story,
list composition in [task-5](./task-5.md), piped precedence in
[task-6](./task-6.md).

## Surfaces touched

| Surface | Change |
| --- | --- |
| YAML schema, `Runner`, `state.json` | **none** — config hash unaffected, in-flight runs resume |
| CLI output | gate / loop / ACP-permission prompts become lists |
| Internal seam | `PromptUser` carries choices, returns choice-or-text (task 1) |
| Packaging | drop `os`; `engines.node >= 20.12`; add `@clack/prompts` |
| New module | `src/options.ts` — instruction, parser, zod shape (task 4) |

Agent declaration, appended beside the sentinel — field rules in
[task-4](./task-4.md):

```
<options>
[{"id": "sqlite", "label": "Use SQLite", "description": "no server to run"}]
</options>
```

## Failure semantics

`validate` gains no error — nothing new is authored in YAML. Two run-time
guarantees are load-bearing and unchanged: stdin closed or exhausted raises the
existing `stdin closed while waiting for a reply` `SaoError` — node fails,
resumable, never auto-approved, never exit 0; Ctrl-C at a list re-raises
`SIGINT` rather than failing the node, keeping one interrupt path, the one whose
handler (`src/procs.ts`) reaps the agent still running behind the pause. Each
task owns its own reply resolution.

## Resolved decisions

1. **Transport = a convention in the agent's own output.** The engine already
   appends an instruction and string-matches the reply, so this reaches all three
   runners by construction — no new layer, protocol or dependency. Rejected, on
   costs the story's Notes measure: both ACP channels are opencode-only, and an
   MCP tool sao serves makes sao a host and moves the pause mid-turn, where
   `{{loop.feedback}}` has nothing to carry.
2. **JSON with ids in `<options>` tags**, zod-validated — human's call over a
   line-per-option convention. Tags, not a fenced `json` block, so agent-written
   code is never read as a declaration.
3. **`{{loop.feedback}}` gets the chosen option's `label`.** `fresh_context`
   defaults true, so the next iteration usually never saw the ids: a label is an
   answer, an id a dangling token. Ids serve sao — uniqueness, logs, addressing.
4. **The piped path keeps every word it accepts today**, plus one addressing
   mode: an exact `id` (loops) / `optionId` (permission, beside today's bare
   index). Verdict words match first. The index/id asymmetry stands because piped
   tests already send indexes.
5. **Text collected after a list selection is never reparsed as a verdict** — the
   seam tags it with the entry that asked for it, so picking `Give feedback` and
   typing `yes` yields `yes`. Reparsing would reintroduce, one keystroke after an
   unambiguous choice, the blind vocabulary this feature deletes.
6. **A loop's list is the agent's options plus the run's own entries.** `End the
   loop` appears **only** on a signaled iteration — an entry that can only be
   refused is that blind vocabulary again. Feedback and reject appear always: an
   option list is the agent's guess. Gates offer the fixed verdicts; permission
   requests the agent's options alone, nothing added.
7. **The instruction is appended only when `interactive: true`** — other loops
   never pause, so options would be unanswerable.
8. **Windows ships as portability, not coverage.** The prompt path stays free of
   POSIX-only facilities and task 1 records a manual smoke check; no Windows CI
   job is added.
9. **§ *Non-goals* and the *MCP* row are NOT amended** — decision 1 stays inside
   the v1 boundary. Amended instead: § *Gate semantics*, § *Permission requests*,
   § *Loop semantics*, § *Decisions (locked)* Distribution row, § *Project
   structure*.

## Non-goals

Rich full-screen TUI (`ink`, `@opentui/core` — measured in the story's Notes) ·
multi-select · options at gate nodes (no agent behind them), at non-interactive
loops, or at plain AI nodes · `{{loop.selected_id}}` · Windows CI, and testing
the rest of the CLI there at all.
