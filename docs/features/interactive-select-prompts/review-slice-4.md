# review-slice-4 — Parse the agent's `<options>` declaration

Verdict: **APPROVED**

## Findings

None.

## Not flagged

- [correctness] All five `@s-options-*` scenarios map 1:1 to a test in
  `tests/options.test.ts` per `tdd-4.md`, and each bites: exact array equality
  for the happy path and last-block-wins (`src/options.ts:22-44`), and a
  `test.each` over eight distinct invalid-shape inputs (not-array, empty
  array, missing/empty id, missing/empty label, duplicate id, `sao:`-prefixed
  id) each independently asserting `toBeUndefined()`. No test can pass on a
  broken implementation of `startsWith("sao:")` or `ids.has(...)` without the
  paired dedicated case for that branch.
- [correctness] No `SaoError`/error path added by this slice —
  `parseAgentOptions` only ever returns `AgentOption[] | undefined`, matching
  `@s-options-malformed-ignored`'s "nothing throws" requirement; both no-block
  and missing-closing-tag inputs are covered as separate cases.
- [correctness] No scope creep: `AGENT_OPTIONS_INSTRUCTION` is defined but not
  yet appended anywhere — wiring into `executeLoop`/`sentinelInstruction()` is
  explicitly task-5's job (`task-5.md:10-13`, paths `src/engine.ts` +
  `src/options.ts`), not this slice's. `src/options.ts` and
  `tests/options.test.ts` are the only code files task-4.md scopes, and that's
  the only code touched.
- [minimalism] No new dependency, abstraction, or config surface — `zod` is
  already a dependency used elsewhere (`src/gate.ts`, `src/engine.ts`); no
  `package.json`/lockfile/`patches/` change in this slice's diff (the
  `@clack/prompts` addition visible in the working tree's `package.json`/
  `bun.lock` diff belongs to slice 1, already reviewed/approved in
  `review-slice-1.md`).
- [layering] `src/options.ts` imports only `zod` — a leaf module per the
  `SPEC.md` module tree (sits beside `agents.ts`, ahead of `engine.ts`), no
  upward or sideways import into `engine`/`nodes`/`runners`.
- [node-target] No Bun-only API — `String.matchAll`, `JSON.parse`, `Set`,
  `zod` are all standard; nothing under `src/` uses `bun:test`.
- [procs] N/A — no subprocess touched by this slice.
- [safety] N/A — no filesystem path, argv, or git refspec involved;
  `parseAgentOptions` only parses a string already held in memory (the
  agent's own stdout capture, out of scope for this slice to re-litigate).
- [state] N/A — no `state.json` shape change; the module is pure and stateless.
- [cli-ux] N/A per task-4.md — this slice adds no terminal output, YAML key,
  or runner-facing behavior; `AGENT_OPTIONS_INSTRUCTION` is an unconsumed
  string constant until task 5 wires it in.
- Docs: `SPEC.md` § *Project structure* gained the `options.ts` line
  (`SPEC.md`: "options.ts # <options> declaration instruction + parser
  (zod-validated)"), matching `tdd-4.md`'s docs note exactly. No `README.md`
  change needed — nothing user-facing changed yet (consistent with task-4.md's
  scope; task 5 owns the user-visible wiring and its own docs).
- Mutation coverage by inspection (Stryker itself not re-run, per protocol):
  `matches.at(-1)` (last-block-wins) exercised both with one and two blocks;
  the `try/catch` around `JSON.parse` exercised by the invalid-JSON case; each
  zod field constraint (`min(1)` on `id` and on `label`, `min(1)` on the array)
  has a dedicated failing case; the `startsWith("sao:") || ids.has(...)` OR is
  exercised on each side independently (prefix case doesn't duplicate, dup-id
  case isn't prefixed).
