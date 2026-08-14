# interactive-select-prompts — full review (reviewer_engineering)

Mode: full-review. Diff: `git diff 38af7c1...HEAD` (= `$SAO_BASE_REF`, the commit
before `cf57d38` seeded this feature's docs). Four lenses below; the repo-rules,
CLI-surface and docs lenses were already covered per slice by `reviewer_slice`
(`review-slice-1.md` … `review-slice-6.md`, `review-spec.md`), all approved.

## Dependency diff (mandatory, read in full)

`package.json` / `bun.lock`: adds `@clack/prompts@^1.7.0` (devDependency, same
"bundled by `bun build`, no runtime `dependencies` section at all" convention this
repo already uses for `commander`/`yaml`/`zod`/`picocolors`) and its transitive
`@clack/core@1.4.3` + new leaf `sisteransi@1.0.5` (`fast-wrap-ansi`/`fast-string-width`
already present in the lockfile via `@inquirer/*`). No `postinstall`/lifecycle
script, no `overrides`/`resolutions`, no `trustedDependencies` change. `engines.node`
raised `>=20 → >=20.12`, matching `@clack/prompts`' own declared `engines.node
>= 20.12.0` (verified in `node_modules/@clack/{prompts,core}/package.json`) — not
an arbitrary bump. `os: ["darwin","linux"]` dropped, intentionally (Windows
scenarios `@s-windows-installable`/`@s-windows-prompt-portable`). No
`patchedDependencies`/`patches/` change. The new dependency is recorded as a
decision in both `docs/features/interactive-select-prompts/spec.md` ("Packaging"
row, decision 8) and `SPEC.md` § *Project structure* Dependencies paragraph —
satisfies the minimalism rule's "unless spec.md records an explicit decision"
carve-out. Accepted.

## Findings

### [arch] major — dead code left behind: `PromptUser` / `promptOnTerminal` (`src/gate.ts:6`, `src/gate.ts:145-152`) — resolved

This slice's own migration retired every production caller of the old
string-reply seam: `engine.ts`, `acp.ts`, `nodes.ts` and `runners/types.ts` all
moved to `PromptChoices`/`promptChoice` (confirmed — `grep -rn "promptOnTerminal"
src/*.ts` outside `gate.ts` returns nothing, and `RunWorkflowOptions.promptUser`
no longer exists). `promptOnTerminal` is now a second, parallel queue-serialized
prompt primitive that duplicates `readReplyLine`'s buffered/readline logic for no
production caller — it survives only because `tests/gate-stdin.test.ts`'s
original `describe("promptOnTerminal", ...)` block was left untouched exercising
it directly. This is exactly the erosion this repo's minimalism rule exists to
catch: an exported primitive with a real-looking test suite that no longer
answers anything a shipped run makes happen. `review-slice-5.md:70-76` already
flagged this precisely and deferred it here, noting `src/gate.ts` and
`tests/gate-stdin.test.ts` sat outside `task-5.md`'s slice boundary. Recommend
deleting `promptOnTerminal`, the `PromptUser` type, and the
`describe("promptOnTerminal", ...)` block in `tests/gate-stdin.test.ts` (its
buffered-line/EOF/queue-serialization coverage is now redundant with the
`promptChoice — piped` describe block added in this same diff, which exercises
`readReplyLine` through the surviving seam).

## Lenses with no further findings

- **[code] TDD** — every `@s` in `gherkin-scenarios.md` maps to a scenario tag in
  `tests/*.test.ts`, cross-checked against `tdd-1.md`…`tdd-6.md`'s scenario→test
  tables; `@s-old-renderings-gone` is a source-wide grep in `tests/cli.test.ts`
  that would fail against the pre-fix source. `runAcpTurn` tests use a hand-rolled
  ACP double (`withPermissionDouble`/`withAcpDouble`), never a real `claude`/`codex`
  process. `tests/gate-stdin.test.ts`'s Ctrl-C/serialization tests drive real
  in-memory `PassThrough` streams with `tick()`-based deterministic flushing
  (20 macrotask ticks), not a sleep-and-hope wait. No module-scope fixture is
  mutated across tests without a `beforeEach` reset (`gate-stdin.test.ts`'s
  `resetPromptState()` + fresh `PassThrough` per test covers `--rerun-each=2`).
- **[arch] layering & minimalism (beyond the finding above)** — no upward imports;
  `src/gate.ts` importing `type AgentOption` from the `options.ts` leaf is a
  type-only import into the same tier gate.ts already occupies, consistent with
  slice-3's review. `src/options.ts` is a new leaf module (zod-validated
  parser + instruction string), matches `SPEC.md`'s new project-structure row. No
  new abstraction layer or config surface beyond the one dependency addressed
  above. Schema/`state.json` shape is genuinely untouched (`spec.md` "Surfaces
  touched" table, confirmed by the diff having no `schema.ts`/`state.ts` changes)
  — resume compatibility holds with no config-hash concern.
- **[perf]** — `listMaxItems()` bounds the rendered window (`Math.max(3, rows -
  4)`) rather than rendering unbounded entries; `@clack/prompts` owns the actual
  terminal repaint. No new polling loop — `promptChoice`/`promptOnTerminal` both
  reuse the existing `Promise`-chained `queue` for serialization, no busy-wait. No
  synchronous fs work added. `parseAgentOptions` is a bounded regex + JSON.parse
  over the agent's own final-output string (already fully buffered elsewhere in
  the pipeline before this call), not a per-node re-read of anything.
- **[security]** — no shell string is built from workflow-author-untrusted text
  (an agent's declared option `id`/`label` only ever becomes a `Map` key, a
  rendered list label, or `{{loop.feedback}}` interpolation text — templating's
  existing trust boundary, unchanged by this feature). No prompt/text moved onto
  argv — `@clack/prompts` reads/writes over the passed `input`/`output` streams
  (stdin/stdout), and permission-option ids are compared in-memory
  (`parsePermissionReply`, `src/gate.ts`), never spawned. No new path segment is
  built from any of this feature's new inputs (option ids/labels never reach
  `.sao/`/`.agents/` path construction). No git refspec, secrets, or
  `patchedDependencies` surface touched. `reraiseSigint` (`src/gate.ts`) calls
  `process.kill(process.pid, "SIGINT")` and returns a promise that never
  settles by design (`tests/gate-stdin.test.ts`'s `@s-list-interrupt` test
  asserts non-settlement) — reuses `src/procs.ts`'s existing tracked-child
  reaping path rather than introducing a second interrupt/teardown mechanism.

## Verdict

**CHANGES_REQUESTED** — one major: delete the now-dead `promptOnTerminal`/
`PromptUser` primitive and its orphaned test block (`src/gate.ts:6,145-152`;
`tests/gate-stdin.test.ts`'s `describe("promptOnTerminal", ...)`).

**Resolved**: `PromptUser` and `promptOnTerminal` deleted from `src/gate.ts`
(along with the stale doc-comment reference to `promptOnTerminal` on
`promptChoice`). The orphaned `describe("promptOnTerminal", ...)` block in
`tests/gate-stdin.test.ts` is removed; the four behaviors it uniquely covered
(multi-reply chunk buffers the rest, a prompt issued after EOF still rejects, a
destroyed stdin rejects without creating a readline, `resetPromptState` rejects
a pending reply) are now asserted through `promptChoice`'s piped branch instead,
so `readReplyLine`'s buffered/EOF/reset paths keep their coverage through the
surviving seam. `bun run typecheck`, `bun run test:orchestrator`, and
`bun run build` all green after the change.

---

## Delta review — mutation-fix round

Mode: delta-review. Diff: `git diff aabfb9c2..HEAD` (`aabfb9c2` = `mut-start-sha`,
the commit above whose full-review this section continues), scoped to
`src/acp.ts`, `src/engine.ts`, `src/gate.ts`, `src/options.ts` and their test
files, per `mutation.md`'s "100% mutation score, 0 survived" result for this
feature's in-scope files. This single commit (`57df5ca`) is entirely: (a) new
test cases that extend coverage into previously-`NoCoverage` branches, and (b)
`// Stryker disable next-line <mutator>: <reason>` comments over the mutants
that new coverage exposed as genuinely equivalent. **No behavior changed** — every
non-test `+` line in the diff is a comment, except `src/options.ts`'s
`} catch {` being split across two lines to give the disable comment a line to
attach to (confirmed: `git diff --stat` shows only comment/test hunks, no `-`
line removes any prior logic).

### Dependency diff (mandatory, re-checked for this delta)

`git diff aabfb9c2..HEAD -- package.json bun.lock patches/` is empty — no
dependency change in this round; the full-review's dependency verdict above
still stands.

### [code] TDD — spot-verified, not just accepted on the mutation report's word

Rather than trust `mutation.md`'s "all 5 prior survivors resolved" narrative
at face value — its own "Kill round" table lists 5 rows but the diff actually
adds ~20 new `Stryker disable` annotations across the four files, i.e. the
table under-documents what this round actually found and suppressed — each new
equivalence claim was read against the surrounding code by hand:

- `src/acp.ts:290` (loadSession catch, `if (settled) return;`), `:316`
  (`(err as {code?:number})?.code`), `:380` (`settled = true` in
  `runAcpHandshake`'s `settle`), `:409-421` (the preflight-only `client` stub's
  `sessionUpdate`/`requestPermission` bodies) — all correctly scoped to
  `runAcpHandshake`, whose stub client is provably never observed past
  `initialize()` (the function kills the child and resolves/rejects
  immediately after). Reasoning holds.
- `src/gate.ts:123` (`stdinClosed = true` in the `"close"` handler — redundant
  with `ensureReadline`'s own re-derivation) and `:127` (`waiting !== undefined`
  guard — a paused `rl` never emits `"close"`), `:158-167` (`listMaxItems`'s
  return value is dominated by `@clack/prompts`' own row-based clamp), `:191`
  (`chosen?.collectsText` — `chosen` is always found since `picked` is always
  one of `req.choices`' own ids), `:237/:241` (`removeAllListeners` before
  `rl.close()` — the close is what actually stops further `"line"`/`"close"`
  emission, not the listener removal) — traced through `ensureReadline` and
  `resetPromptState` line by line; all hold.
- `src/engine.ts:1031/1037` (`instructedOutput ?? ""` fallback content is
  unobservable — no string without a literal `<options>` substring changes
  `parseAgentOptions`'s or `.includes()`'s result) and `:1165/1172/1188` (the
  `"feedback"` tag on the returned union is never itself branched on by
  `askLoopGate`'s caller, which only checks `verdict.kind === "approve"`,
  confirmed by reading the call site at `engine.ts:1063`) — hold.
- `src/options.ts:25` (`lastMatch === undefined` guard — `lastMatch[1]` on
  `undefined` throws, caught by the same `try/catch` two lines down, same
  `return undefined` either way) — holds.

No case where an "equivalent" claim actually masks an observable behavior
change; none should have been left to a killing test instead.

New tests bite rather than restate the implementation: `tests/options.test.ts`'s
exact `toBe` on `AGENT_OPTIONS_INSTRUCTION`, `tests/gate-stdin.test.ts`'s exact
`hint` match and the TTY/non-TTY `isInteractive()` combination test, and
`tests/acp.test.ts`'s exact permission-prompt message with/without `nodeId` all
assert precise UX strings per this repo's rubric, not just "doesn't throw".
`lastPermissionResult`/`echoPermissionResult` added to the ACP double
(`tests/acp.test.ts:62,135-137`) live inside the double's own spawned
child-process script (`DOUBLE_SCRIPT`), not shared test-file module scope — no
`--rerun-each=2` leakage risk. `tests/gate-stdin.test.ts`'s new tests run under
the existing `beforeEach` (fresh `PassThrough` pair + `resetPromptState()` per
test), so the new `isTTY` mutation in one test cannot bleed into the next.

### [arch] / [perf] / [security] — no change to re-litigate

Purely comments and tests; the full-review's architecture, performance, and
security verdicts above are unaffected. Performance: N/A (no runtime code
changed). Security: N/A (no new subprocess, path, git, or persistence surface;
no new dependency).

### Verdict

**APPROVED** — mutation-fix round holds up under hand-verification; no new
findings.
