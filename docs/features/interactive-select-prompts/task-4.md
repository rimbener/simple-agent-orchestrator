---
id: 4
title: Parse the agent's <options> declaration
slice: C — agent-declared options
scenarios: [@s-options-parsed, @s-options-last-block-wins, @s-options-malformed-ignored, @s-options-invalid-shape-ignored, @s-options-absent]
status: done
paths: [src/options.ts, tests/options.test.ts, SPEC.md]
---

New pure leaf module `src/options.ts` — no I/O, no engine coupling, fully unit
testable (it deliberately does **not** live in `src/gate.ts`, whose stdin
machinery is Stryker-disabled).

```ts
export type AgentOption = { id: string; label: string; description?: string };
export const AGENT_OPTIONS_INSTRUCTION: string;
export function parseAgentOptions(text: string): AgentOption[] | undefined;
```

- `AGENT_OPTIONS_INSTRUCTION` is appended beside `sentinelInstruction()` and tells
  the agent to emit a last-line `<options>` block holding a JSON array, ids
  unique and not prefixed `sao:`.
- `parseAgentOptions` finds the **last** `<options>…</options>` pair, `JSON.parse`s
  it, then validates with zod: non-empty array; each entry `{ id, label,
  description? }` with non-empty `id`/`label`; ids unique; no id starting `sao:`
  (reserved for the run's own entries, so an agent cannot shadow the halt path).
- Every failure — no block, no closing tag, bad JSON, bad shape — returns
  `undefined`. No throw, no partial list.

**Docs:** `SPEC.md` § *Project structure* — add `options.ts` to the module tree.
