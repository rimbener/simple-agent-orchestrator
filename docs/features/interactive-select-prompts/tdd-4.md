# tdd-4 — Parse the agent's `<options>` declaration

## @s → test map

| Scenario | Test |
| --- | --- |
| `@s-options-parsed` | `tests/options.test.ts` → `parseAgentOptions > @s-options-parsed: ...` |
| `@s-options-last-block-wins` | `tests/options.test.ts` → `parseAgentOptions > @s-options-last-block-wins: ...` |
| `@s-options-malformed-ignored` | `tests/options.test.ts` → `parseAgentOptions > @s-options-malformed-ignored: ...` (invalid JSON, missing closing tag) |
| `@s-options-invalid-shape-ignored` | `tests/options.test.ts` → `parseAgentOptions > @s-options-invalid-shape-ignored: %s yields undefined` (not-array, empty array, missing/empty id, missing/empty label, duplicate id, `sao:`-prefixed id) |
| `@s-options-absent` | `tests/options.test.ts` → `parseAgentOptions > @s-options-absent: ...` |

## Cycles

1. RED/GREEN: `parseAgentOptions` reads the last `<options>…</options>` block,
   `JSON.parse`s it and zod-validates non-empty array shape (`id`, `label`,
   optional `description`), returning entries in declared order.
2. RED/GREEN (already satisfied by matching the last regex match): a second
   `<options>` block overrides an earlier one.
3. RED/GREEN (already satisfied by the parse try/catch and the regex requiring
   a closing tag): invalid JSON and a missing closing tag both yield
   `undefined`, no throw.
4. RED/GREEN: added a duplicate-id and `sao:`-prefix post-check after the zod
   shape check — the two invalid-shape cases zod alone can't express.
5. RED/GREEN: `AGENT_OPTIONS_INSTRUCTION` — a string constant documenting the
   last-line `<options>` block, unique ids, `sao:` reserved.

## Docs

`SPEC.md` § *Project structure* — added `options.ts` to the module tree.
