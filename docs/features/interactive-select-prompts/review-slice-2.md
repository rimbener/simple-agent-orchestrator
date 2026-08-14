# review-slice-2 — Gate nodes present a list

Verdict: **APPROVED**

## Findings

None.

## Not flagged

- `tdd-2.md`'s `@s → test map` cites `tests/engine-m2.test.ts` for `@s-gate-reject`
  but not `tests/engine-m3.test.ts`'s `"a rejected gate re-asks on resume"` test —
  the scenario's last clause ("resuming the run asks the same gate again") is
  covered there, just untagged and unmapped. The scenario itself is satisfied by
  the code and tests; this is a traceability gap in the map, not a coverage gap,
  so not worth blocking the slice over.
- `answer.kind === "choice"` in `src/engine.ts:966-969` treats any non-approve
  choice as reject rather than checking `answer.id === "sao:reject"` explicitly.
  Currently safe: `gate.ts`'s `runListPrompt` only ever returns `{kind:"choice"}`
  for the two non-`collectsText` choices (approve/reject), so there's no third
  case that could reach it. Both branches are exercised by
  `@s-gate-approve`/`@s-gate-reject`.
- Magic strings `"sao:approve"`/`"sao:reject"`/`"sao:feedback"` repeat 4x in
  `executeGate` rather than being named constants — scoped to one function,
  matches existing repo idiom (e.g. `GateReply` kind literals), not a real DRY
  violation at this size.
- Mutation coverage by inspection (Stryker itself not re-run, per protocol):
  `answer.id === "sao:approve"`, `answer.from === "sao:feedback"`, and
  `answer.text.trim() === ""` are each covered both-ways by
  `@s-gate-approve`/`@s-gate-reject`/`@s-gate-feedback`/
  `@s-gate-feedback-keeps-verdict-words`. The verdict-words test in particular
  exists specifically to kill an always-false mutant on the `from` check (a
  flip there would silently re-route "yes" feedback through `parseGateReply`
  and turn it into an approval — the test catches exactly that).
- Docs: `SPEC.md`'s *Gate semantics* section and `README.md`'s gate-node comment
  (line 158) both accurately describe the new list/piped split; no other
  user-facing surface touched by this slice.
- CLI & workflow surface: N/A — no new YAML keys, no schema change, no
  runner-specific behavior; the `[node-id]` prefix convention in the prompt
  message is preserved.
- Layering/node-target/process-safety/state-durability: N/A — `engine.ts`
  importing types and `promptChoice`/`parseGateReply` from `gate.ts` is
  pre-existing layering; no Bun-only API, no subprocess, no `state.json` shape
  change (`NodeResult.output` shape is unchanged).
- No dependency/package.json/patch changes in this slice's diff (that's
  slice 1's, already reviewed in `review-slice-1.md`).
