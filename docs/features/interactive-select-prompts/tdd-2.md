# tdd-2 — Gate nodes present a list

## @s → test map

| Scenario | Test |
| --- | --- |
| `@s-gate-approve` | `tests/engine-m2.test.ts` → `gate nodes > @s-gate-approve: the list offers approve/reject/give-feedback; confirming approve continues` |
| `@s-gate-reject` | `tests/engine-m2.test.ts` → `gate nodes > @s-gate-reject: rejecting from the list halts the run as rejected; dependents stay pending` |
| `@s-gate-feedback` | `tests/engine-m2.test.ts` → `gate nodes > @s-gate-feedback: give-feedback collects text that becomes the node's output` |
| `@s-gate-feedback-keeps-verdict-words` | `tests/engine-m2.test.ts` → `gate nodes > @s-gate-feedback-keeps-verdict-words: feedback text that reads like a verdict stays text` |
| `@s-gate-piped-unchanged` | `tests/engine-m2.test.ts` → `gate nodes > @s-gate-piped-unchanged: piped replies with no list selection keep today's vocabulary` |

## Cycles

1. RED/GREEN: `executeGate` moved onto `promptChoice` — choices `sao:approve` /
   `sao:reject` / `sao:feedback` (`collectsText`), letter-menu string deleted;
   `{ kind: "choice" }` approves/rejects.
2. RED/GREEN: `{ kind: "text", from: "sao:feedback" }` becomes the node's output
   verbatim, `parseGateReply` never called on it; an empty answer re-asks the same
   gate.
3. RED/GREEN: `{ kind: "text" }` with no `from` (piped path) keeps
   `parseGateReply`'s existing vocabulary and empty-line re-ask, unchanged.
4. Updated `engine-m2.test.ts`/`engine-m3.test.ts` fixtures that drove gates
   through the old `promptUser` string seam to the new `promptChoice` seam (gate
   no longer reads `promptUser` at all).

## Docs

`SPEC.md` § *Gate semantics* — rewritten for the list/piped split. `README.md`
line 158 — gate node comment updated from "pauses for y/n" to the
approve/reject/feedback list.
