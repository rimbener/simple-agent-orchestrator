# tdd-3 — ACP permission requests present a list

## @s → test map

| Scenario | Test |
| --- | --- |
| `@s-perm-agent-options-listed` | `tests/gate-permission.test.ts` → `runAcpTurn — permission requests > @s-perm-agent-options-listed: ...` |
| `@s-perm-selection-sent-verbatim` | `tests/gate-permission.test.ts` → `runAcpTurn — permission requests > @s-perm-selection-sent-verbatim: ...` |
| `@s-perm-nothing-sent-until-chosen` | `tests/gate-permission.test.ts` → `runAcpTurn — permission requests > @s-perm-piped-invalid-reasks / @s-perm-nothing-sent-until-chosen: ...` |
| `@s-perm-piped-index` | `tests/gate-permission.test.ts` → `runAcpTurn — permission requests > @s-perm-piped-index: ...` |
| `@s-perm-piped-option-id` | `tests/gate-permission.test.ts` → `runAcpTurn — permission requests > @s-perm-piped-option-id: ...`; unit-level in `tests/gate.test.ts` → `parsePermissionReply > @s-perm-piped-option-id: ...` |
| `@s-perm-piped-invalid-reasks` | `tests/gate-permission.test.ts` → `runAcpTurn — permission requests > @s-perm-piped-invalid-reasks / @s-perm-nothing-sent-until-chosen: ...` |
| `@s-perm-no-terminal-fails` | `tests/acp.test.ts` → `runAcpTurn — the timeout clock pauses for a permission prompt (D5) > @s-perm-no-terminal-fails: ...` |

## Cycles

1. RED/GREEN: `parsePermissionReply` (`src/gate.ts`) takes `optionIds: string[]`
   instead of a bare count, matching a 1-based index or an exact `optionId`
   verbatim (`tests/gate.test.ts`).
2. RED/GREEN: plumbed `promptChoice` (replacing `promptUser`) from
   `NodeExecContext` (`src/nodes.ts`) through `RunnerRequest`
   (`src/runners/types.ts`) to the three AI-node call sites in `src/engine.ts` —
   the only consumer of that field is ACP's `requestPermission`, so `promptUser`
   drops out of this path entirely (`tests/nodes.test.ts`,
   `tests/engine-acp.test.ts`).
3. RED/GREEN: rewrote `requestPermission` (`src/acp.ts`) onto `promptChoice` —
   choices are `params.options` mapped one-to-one (`id: optionId`, `label:
   name`), the numbered-menu string is deleted, `{ kind: "choice" }` returns
   `optionId` verbatim, `{ kind: "text" }` runs the extended
   `parsePermissionReply` (`tests/gate-permission.test.ts`).
4. Migrated `tests/acp.test.ts`'s D5 timeout-pause tests off `promptUser` onto
   `promptChoice`; retagged the throw-fails-turn test as
   `@s-perm-no-terminal-fails` with the real stdin-closed message shape.

## Docs

`SPEC.md` § *Permission requests (ACP runners)* — rewritten for the list/piped
split: a navigable list of the agent's own options, no invented menu, typed-line
addressing by index or `optionId`. `README.md`'s opencode runner section
(previously lines 208–217) — numbered-menu example replaced with prose describing
the list and the two piped addressing forms.
