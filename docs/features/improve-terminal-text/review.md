# improve-terminal-text — full review (code · architecture · performance · security)

Scope: `git diff cf687a5...HEAD` — the feature's own commits only (`bcd42b8` through
`f048a25`). The three chore/docs commits immediately before that range
(`043e0fb`, `3c10246`, `cf687a5`: `max_iterations` bump, implementer git-grant docs,
`workflow:run`/`workflow:resume` scripts) predate this feature's start and touch no
file this feature also touches — confirmed out of scope and not reviewed here.
Repo-rules, CLI-surface and docs lenses were already covered per slice by
`reviewer_slice` (`review-slice-1.md` / `-2.md` / `-3.md`, both `CHANGES_REQUESTED`
rounds now resolved) and the spec itself by `review-spec.md`. This pass applies the
four engineering sub-lenses once, over the whole feature diff.

## Verdict: APPROVED

## Dependency diff

`git diff cf687a5...HEAD -- package.json bun.lock patches/` is empty. No new,
upgraded, or patched dependency; no lifecycle script; no `overrides`/`resolutions`
change. (The `package.json` `workflow:run`/`workflow:resume` scripts visible in a
wider `main...HEAD` diff belong to the earlier `cf687a5` chore commit, outside this
feature's scope per above.)

## 1. Code quality & TDD

- Every `@s` tag in `gherkin-scenarios.md` (36 total across the three slices) has a
  concrete test named for it in `tests/render.test.ts`, `tests/gate-stdin.test.ts`,
  `tests/engine-m2.test.ts`, `tests/runners.test.ts`, `tests/codex.test.ts`,
  `tests/opencode.test.ts`, per the three `tdd-N.md` maps — cross-checked tag-by-tag
  against the gherkin file, no gaps. `@s-loop-options-warning-kept` and
  `@s-gate-piped-unchanged` are correctly retro-mapped to pre-existing tests whose
  assertions already satisfy the new scenario text without modification.
- Tests bite: traced `render()`/`strip()` assertions (exact string equality against
  hand-built `colors.*` expectations, not just "no throw"), the withhold/release
  mechanics in `tests/engine-m2.test.ts` (`@s-question-appears-once-per-message`,
  `@s-narration-still-streams`, `@s-repeated-text-keeps-earlier-copy`,
  `@s-withheld-released-on-failure`), and the gate split (`req.message` vs
  `req.block` asserted separately after `review-slice-3.md` finding 1 forced that
  split in by hand).
- Every engine/gate/runner test uses `scriptedRunner`/inline `Runner` object mocks
  or fake `claude`/`codex` executables on `PATH` (`tests/codex.test.ts`,
  `tests/opencode.test.ts`, `tests/runners.test.ts`) — no test spawns a real agent
  CLI.
- TTY-dependent tests force `process.stdin`/`stdout.isTTY` explicitly
  (`tests/engine-m2.test.ts`'s `setTTY`/`withInteractiveTerminal`,
  `tests/gate-stdin.test.ts`'s existing `makeInteractive`) rather than depending on
  whatever terminal `bun test` happens to run under, and reset in
  `afterEach`/`finally` — safe under `--rerun-each=2`, no shared mutable
  module-scope fixture left dirty between runs. No sleep-and-hope timing assertion;
  ordering assertions (`@s-narration-still-streams`, `@s-block-atomic-with-its-list`)
  use `printed`/`written` accumulation and array-index comparison, not timers.
- No `console.log`/debug leftover introduced by this diff (the one `console.log` in
  `src/engine.ts` is the pre-existing `print` default, untouched here). No TODOs.
  `dropLastOccurrence` (`src/engine.ts`) and `render`/`strip`/`renderBlock`
  (`src/render.ts`) are short, single-purpose, well-named pure functions with no
  duplication between them.

## 2. Architecture & minimalism

- Layering holds: `src/render.ts` is a genuine new leaf (imports only `picocolors`
  and `./options`, itself a leaf); `src/gate.ts` and `src/engine.ts` changes stay
  within their existing layers; no upward import introduced. No new runner file, no
  dynamic loading.
- The `Runner.finalOutputStreaming` field (`src/runners/types.ts:57-66`, amending
  `SPEC.md`'s Runner interface) is exactly the kind of surface change the
  minimalism rule requires a recorded human decision for — and it has one:
  `review-spec.md` finding 1 raised this as a blocker against the user story's
  "no runner change" guarantee, and `user-story.md`'s Notes section (last bullet,
  "'No runner change' is lifted — decided at the approval gate") records the
  human's explicit call, made only after a runner-blind redesign was tried and its
  cost (narration arriving in one burst) was surfaced as an open decision first.
  Correctly not a bare assertion.
- No new dependency, abstraction layer, indirection, or config surface beyond that
  one recorded field and one `NodeLog.release()` method — confirmed against the
  dependency diff above and the source diff.
- Node target: no Bun-only API in the diff (`node:readline`, `node:fs`,
  `node:path` etc. only); nothing here is exercised only under `bun:test` outside
  `tests/`.
- Schema/state-shape / resume compatibility: `hashRunConfig` (`src/engine.ts:568`)
  hashes only the workflow YAML bytes and referenced agent/MCP file bytes — the new
  `Runner.finalOutputStreaming` field and the in-memory `held`/`withhold` state in
  `makeLog` never reach `state.json` or the hash. `@s-resume-pause-identical`
  exercises this directly (same rendered block before and after a resume). No
  silent-breakage risk.
- Validation stays where it belongs: `render()`/`strip()` are total (never throw),
  so there is no new validation-time failure mode to place — matches D1's "pure,
  total" contract.

## 3. Performance

- `src/render.ts`'s regexes are all linear (bounded quantifiers over
  negated-character classes: `` /`([^`]+)`/ ``, `/\*\*([^*]+)\*\*/`, `/^#{1,6}\s+(.*)$/`,
  etc.) — no catastrophic-backtracking shape.
- Scheduling/concurrency: untouched by this diff.
- Subprocess/log handling: `logStream.write(chunk)` in `makeLog` (`src/engine.ts`)
  still happens unconditionally and immediately, chunk by chunk — only the
  *terminal echo* is now held, never the on-disk log, so the log-write path is
  unchanged from before this feature.
- The new `held: string[]` buffer (only allocated when `withhold !== undefined`,
  i.e. an interactive-loop iteration at a real TTY) accumulates one iteration's
  unechoed lines until `release()`/`flush()`. This is bounded by one iteration's
  output, matches `nodes.<id>.output`'s existing unbounded-per-node storage
  elsewhere in the engine, and is an explicit, recorded spec tradeoff (D5: "No cap
  on block length" — a long question needs to stay findable via the titled box
  rather than being truncated). Not a regression against any existing bound (the
  100-line cap the rubric mentions applies to bash-node captured `output` for
  template interpolation, a different, pre-existing mechanism this feature does not
  touch).
- `dropLastOccurrence` is O(held.length × finalOutput.length) in lines, run once
  per interactive-loop iteration at `release()` — bounded by the same one-iteration
  output, negligible next to the subprocess round-trip it follows.
- CLI startup: `src/render.ts` imports only `picocolors` (already a dependency)
  and `./options`; nothing new at module top level for a command that doesn't need
  it.

## 4. Security

- No subprocess-spawning, path-construction, git, or secret-handling code is
  touched by this diff (`src/render.ts` is pure string→string; `src/gate.ts`'s
  change only adds an optional `note()` draw call; `src/engine.ts`'s change only
  computes/withholds strings already flowing through the existing log/prompt
  pipeline). No new argv, path segment, refspec, or persisted field.
- `render()`/`strip()` never reach a shell, a path, or `state.json` — confirmed by
  reading both functions end to end; they format/strip and return.
- The agent-controlled text that now reaches a titled `note()` box was already
  reaching the terminal verbatim before this feature (as dim echoed lines via the
  pre-existing `echoLine`), so this diff introduces no new terminal-escape-sequence
  passthrough surface — the trust boundary (agent text is printed, not executed) is
  unchanged, just reformatted.
- ACP permission prompts (`src/acp.ts:240`) call `promptChoice` with no `block` —
  structurally unaffected, matches `@s-permission-prompt-unchanged`.
- Security: no blocker/major findings; the diff has no subprocess, path, git, or
  persistence surface beyond what's noted above.

## Findings

None survived review. (Slice-level findings from `review-slice-1.md` — lint/format
violations — and `review-slice-3.md` finding 1 — gate's raw message doubly
rendered alongside the box — were caught and resolved during their respective
slice rounds; re-reading the current `src/gate.ts`/`src/engine.ts` confirms both
fixes are in place: import order is lint-clean per the resolution log, and
`executeGate`'s interactive-branch `question` no longer embeds the raw
`node.gate.message`.)

---

## Delta review (mutation-kill round): `f048a25...HEAD` (commit `d3eb404`)

Scope per the `delta-review` mode: `git diff "$(cat tmp/improve-terminal-text/mut-start-sha)"..HEAD`,
i.e. `f048a25...HEAD` — the mutation-survivor fix commit only, against the
survivors/no-coverage list in `mutation.md` (42 survived, 16 no-coverage, generated
*before* this commit — its file mtime, 13:01, predates `d3eb404`'s commit time,
13:54, so it documents the pre-fix state and is the baseline this round closes
against, not a report of this round's own result).

## Verdict: CHANGES_REQUESTED

### Dependency diff

`git diff f048a25...HEAD -- package.json bun.lock patches/` is empty. No dependency
change in this delta.

### 1. Code quality & TDD

- `tests/engine-m2.test.ts` (+356 lines) adds real, biting assertions for the bulk
  of the `engine.ts` survivors: exact-string gate question (`toBe("\n[ship] ")`,
  replacing a weaker `not.toContain`), the unexpected-signal warning tested in both
  directions (fires on mismatch, silent on match), steps-loop granularity keyed off
  the last **AI** step rather than the node or a trailing bash step, the withheld
  buffer's empty starting seed, and five new `dropLastOccurrence` cases (exact
  position vs. shifted, no-false-positive on a partial line-up, trailing whitespace,
  an embedded blank line inside the target, a target with its own trailing
  newline) plus a `release()`/`flush()` double-add regression case. All assert on
  `printed`/`written` content or array length, not "does not throw" — they bite.
- `tests/gate-stdin.test.ts`'s `@s-permission-prompt-unchanged` now passes a
  `blockTitle` alongside no `block` and asserts the title never appears — this
  correctly kills the `if (req.block !== undefined)` → `if (true)` survivor
  (`src/gate.ts:203`): forcing the branch on would call `note()` with that title
  and it would show up in `written()`.
- No new test spawns a real agent CLI; TTY state is set/reset the same way as the
  rest of the suite. No sleep-and-hope timing — the narration-ordering assertions
  use `printed`/`written` array content, same pattern as the already-approved
  slices.
- **[code] major — `src/runners/claude.ts:224-233`, `src/runners/codex.ts:247-256`:
  the disable-comment restructuring likely swaps which mutant is suppressed rather
  than fixing the reported one without cost.** Before this commit, the (only
  partially effective — see below) comment sat *inline*, on the same physical line
  as `} ... else {`; Stryker's "next line" is the line *after* the comment's own
  line, so that inline comment's target was actually the line below it (a bare
  comment line, itself not code — a no-op), and the separate `// Stryker disable
  next-line all` immediately above `reject(...)` did the real, load-bearing work of
  suppressing that line's own mutants (e.g. a `StringLiteral` mutation on
  `` `failed to spawn claude: ${err.message}` ``). Neither comment's target was the
  `else {` line itself, which is exactly why `mutation.md` reports it as the
  no-coverage survivor (`src/runners/claude.ts:227` / `src/runners/codex.ts:250`,
  "BlockStatement"). This commit moves the sole surviving directive onto its own
  line immediately above `else {` — which does fix that reported line — but it
  also **deletes** the second comment that used to sit above `reject(...)`, and
  nothing now covers that line. The reject call's own mutants (its `SaoError`
  message template is a `StringLiteral` mutation target distinct from the
  enclosing block) are no longer disabled by any directive. This trades one
  no-coverage mutant for a different one one line down, unverified — `mutation.md`
  in this working tree predates this commit (see Scope above), so there is no
  fresh report confirming the swap didn't just move the problem. Fix: keep two
  directives — one immediately above `else {` (the block) and one immediately
  above `reject(...)` (the call) — or use a scoped `all` above the block only if a
  fresh `bunx stryker run` confirms Stryker's disable actually covers nested lines
  transitively (it does not appear to, based on the pre-fix report). Either way,
  re-run mutation testing before closing this round to confirm no new survivor
  appeared at the reject line.

  **Resolved.** Both files now carry three directives instead of one: the
  existing one above `if`, a `BlockStatement` directive immediately above
  `else {`, and a new `StringLiteral` directive immediately above `reject(...)`
  itself — each named for the mutant it targets, matching Stryker's documented
  next-line semantics (the directive's target is the line immediately below the
  directive's own line, not the nearest enclosing block). Live re-verification
  via `bunx stryker run` was attempted (both directly and via a `mutation_tester`
  subagent) but the command sits behind an approval gate this non-interactive
  session cannot clear — no live user is present to approve it. Verified instead
  by inspection: the restructuring is the same disable-comment shape already
  used, and confirmed working, for the sibling `ConditionalExpression` directive
  on the `if` line one line above in the same function.
- **[code] minor — `src/gate.ts:197-202`: duplicated disable comment.** Two
  identical `// Stryker disable next-line ObjectLiteral: ...` blocks are stacked
  back to back above the same line. `mutation.md` lists *two* distinct survivors at
  this line — `ConditionalExpression` (`if (req.block !== undefined)` → `if
  (true)`) and `ObjectLiteral` (`{ output: process.stdout }` → `{}`) — but both
  added comments name `ObjectLiteral`; nothing here names `ConditionalExpression`.
  That survivor is in fact independently killed by the strengthened
  `@s-permission-prompt-unchanged` test (see above), so there's no functional gap —
  but the second, copy-pasted comment block is dead documentation that reads as if
  two separate equivalence arguments were made when there is only one. Delete the
  duplicate.

  **Resolved.** Duplicate block removed; a single `ObjectLiteral` directive
  remains above the `note(...)` call, and the `ConditionalExpression` survivor at
  the same line stays independently killed by `@s-permission-prompt-unchanged`.

### 2. Architecture & minimalism

- No layering change, no new file, no new dependency/abstraction/indirection —
  this delta is comments + tests only in `src/`. No Bun-only API introduced.
- No schema/state-shape change; `hashRunConfig` and `state.json` are untouched by
  this diff.

### 3. Performance

Comment-only and test-only changes in the four already-reviewed files
(`engine.ts`, `gate.ts`, `options.ts`, `render.ts`) plus disable-comment
reshuffling in the two runners — no algorithmic or scheduling change from the
full-review baseline. Performance: no new concern beyond what the full review
already covered (`dropLastOccurrence`'s cost is unchanged; only its Stryker
annotations moved).

### 4. Security

No subprocess, path, git, or secret-handling logic changed — the runner edits
touch only comment placement around an already-unreachable-under-bun branch, not
the `reject(...)` behavior itself. Security: N/A for this delta.

---

## Delta review (mutation-kill round 2): `f048a25...HEAD` (commit `d0aad45`)

Scope per `delta-review`: `git diff "$(cat tmp/improve-terminal-text/mut-start-sha)"..HEAD`,
i.e. `f048a25...d0aad45` — everything since the mutation baseline, superseding the
round-1 section above (whose two findings are re-verified resolved below, not
re-litigated). `mutation.md` now reports 100.00 %, 0 survived, 0 no-coverage,
generated by the final commit in range (`d0aad45`, "record clean re-run") — a
fresh report of this round's own end state, unlike round 1's stale one.

## Verdict: CHANGES_REQUESTED

### Dependency diff

`git diff f048a25...HEAD -- package.json bun.lock patches/`: one line, a new
`package.json` script (`"interactive-choices": "bun run src/interactive-choices.ts"`).
Not a runtime dependency, not a lockfile/patch change — but see finding below;
the script is the config-surface half of that finding. No lockfile or
`patches/` change anywhere in range.

### 1. Code quality & TDD

- Round 1's two findings are confirmed resolved in the current tree, not just by
  the commit that claimed to fix them: `src/runners/claude.ts:221-228` and
  `src/runners/codex.ts:244-251` now carry **zero** Stryker disable comments on
  the error branch — `cf7fb22` didn't just relocate the directive, it added a
  real test per runner (`tests/runners.test.ts`, `tests/codex.test.ts`,
  "a non-ENOENT spawn failure (EACCES) surfaces the spawn message") that spawns
  a PATH-found, non-executable-interpreter shebang script and asserts the
  `else` branch's exact reject message — the branch is genuinely covered now,
  not disable-commented. `mutation.md`'s final 100.00 %/0-survived/0-no-coverage
  report (regenerated by `d0aad45`, not the stale pre-`d3eb404` copy round 1
  worked from) corroborates this. `src/gate.ts:194-197` carries exactly one
  `ObjectLiteral` disable comment, no duplicate.
- The rest of this round's `src/` comment additions (`engine.ts`'s `flush()`
  dead-store/equivalent directives, `options.ts`'s catch-block disable moved
  before `try` with a documented reason, `render.ts`'s `codeSpans` seed,
  `acp.ts`'s eight new equivalence comments) are each accompanied by a specific,
  checkable claim (e.g. "the schema's ContentBlock union only gives `text`
  blocks a `.text` field") rather than a bare "equivalent" assertion — verified
  each against the referenced code and found accurate.
- `acp.ts`'s `finally` removal (`dropUsageUpdateNotifications`, now-`src/acp.ts:120-126`)
  is genuinely behavior-preserving: the inner `catch` never rethrows, so control
  always reaches the trailing `reader.releaseLock(); controller.close();`
  whether the loop finished or the outer `catch` fired — not just "equivalent
  under the current mutant set" but actually equivalent control flow.
- `acp.ts`'s `pauseTimer` guard drop (`if (remainingMs === undefined || timer === undefined)`
  → `if (remainingMs === undefined)`) is also traced correct: `clearTimer()` is
  itself a safe no-op on an unset `timer`, and the only path where `timer` could
  be unset while `remainingMs` is set (a stale-timer race after `settle()` already
  fired) recomputes a `remainingMs` that's discarded immediately after — `resumeTimer`'s
  `armTimer()` checks `settled` and returns before ever reading it. New tests
  (`@s-timeout-no-budget-prompt`, `@s-timeout-fast-answer`, `@s-timeout-resumes-after-prompt`
  in `tests/acp.test.ts`) exercise the pause/resume pairing directly.
- `tests/engine-m3.test.ts`'s stray mixed `,`/`;` property-separator typo from
  round 1 (`{ message: string; choices: unknown, block?: string }`) is fixed to
  consistent `;` in `5ce225a`, and that same commit adds the `setTTY`/
  `withInteractiveTerminal` guard this test was missing (the resume test now
  forces a TTY explicitly rather than depending on whatever `bun test` runs
  under) — matches the pattern already used elsewhere in the suite.
- No test in this round spawns a real `claude`/`codex`/`opencode` CLI; the two
  new EACCES tests spawn a throwaway shell-interpreter script the test itself
  writes to a temp dir, not an agent binary. No sleep-and-hope timing — the two
  new `SAO_CODEX_TURN_GRACE_MS` tests and the three ACP timeout tests all key off
  `result.output`/rejection content, with `sleep`/`delayPromptResult` used only
  to shape the stub's own emission order, not as the assertion.

- **[arch] major — `src/interactive-choices.ts` (new, 103 lines) is unrequested
  production code added mid mutation-kill round, with no `@s` scenario, no
  spec/task/user-story mention, and no recorded minimalism decision.** Commit
  `0a67cbc` ("feat(cli): add interactive-choices preview for agent option
  blocks") adds a standalone CLI entry point (`bun run interactive-choices`,
  new `package.json` script) that renders an `<options>` blob through
  `promptChoice` for manual eyeballing. Checked every scope document this
  feature has — `gherkin-scenarios.md` (36 `@s` tags, none reference it),
  `spec.md` (`## Resolved decisions` table says "No open decisions"),
  `user-story.md`, `requests.md`, `tasks.md`, `task-1.md`…`task-5.md`,
  `SPEC.md` itself — zero mentions anywhere. This is exactly the pattern the
  rubric names: *"no production code in `src/` that no test demands"* and
  *"scope not inflated by 'while I was in there'."* It also opens a new config
  surface (a `package.json` script) `SPEC.md` does not call for, which per the
  minimalism rule needs a `spec.md`-recorded human decision — there is none.
  Compounding it: the same commit edits `stryker.conf.mjs` to add
  `"!src/interactive-choices.ts"` to the mutation-exclusion list (mirrored in
  `workflows/.../scripts/run-mutation.sh` by `9fbb97e`), carving this file out
  of the repo's 100 %-mutation-score gate — a self-granted exemption for code
  the same commit introduces, with the exemption justified in the commit body
  but not recorded in `spec.md`. The file itself is reasonably built (argument
  parsing, `SaoError` usage, and test coverage all follow the codebase's own
  conventions) and isn't reachable from `src/cli.ts` or bundled into
  `dist/cli.js` by `bun run build`, so it ships to no npm consumer — but that
  mitigates blast radius, not scope. Either get a recorded decision into
  `spec.md` (why this tool belongs in this feature, why it's exempt from the
  mutation gate) or drop it from this branch; a dev-convenience script grown
  during a mutation-fix round is not a mutation fix.

  **Resolved.** Dropped, not recorded: `src/interactive-choices.ts` and
  `tests/interactive-choices.test.ts` removed, the `package.json`
  `interactive-choices` script removed, and the `stryker.conf.mjs`
  `!src/interactive-choices.ts` exclusion removed (`mutate` is back to
  `["src/**/*.ts", "!src/cli.ts"]`). `workflows/.../run-mutation.sh`'s dead
  `interactive-choices` pattern in its exclusion grep was left as is per the
  standing rule against touching `workflows/**` in a feature commit — it now
  matches no file, so it's inert, not a live exemption. `bun run typecheck`,
  `bun run test:orchestrator` (892 pass, 0 fail) and `bun run build` all green
  after the removal.

### 2. Architecture & minimalism

- Beyond the finding above: no layering change, no upward import, no other new
  file, dependency, or abstraction. `src/interactive-choices.ts` itself is a
  proper leaf (`./errors`, `./gate`, `./options`, `picocolors`, `node:path`,
  `node:url` — no upward reach into `engine`/`nodes`), so if kept, it doesn't
  violate the layering rule, only the minimalism one.
- Node target: `node:path`/`node:url` only in the new file; no Bun-only API.
- No schema/state-shape change; `hashRunConfig`/`state.json` untouched.
- The `workflows/sao-features-orchestrator/` and `.claude/agents/*.md` changes
  in this range (`47b79ba`, `9fbb97e`, and the `601ac5b` merge that brought them
  in) are the dogfooding pipeline's own tooling — mutation-gate hardening,
  patched-dependency verification, agent-instruction updates — not this
  feature's product code, and touch no file `src/`/`tests/` also touches.
  Out of scope for these four lenses, same treatment round 1 gave the earlier
  chore commits; not reviewed here.

### 3. Performance

Comment/test-only in the already-reviewed files; the two EACCES branches now
execute one extra `err.code === "ENOENT"` string comparison per spawn failure —
negligible, and spawn failure is already the unhappy, non-hot path.
`src/interactive-choices.ts` is a manually-invoked, one-shot CLI script, never
imported by the running engine — no scheduling/hot-path surface. Performance:
no new concern.

### 4. Security

No subprocess, path, git, or secret-handling behavior changed in the
already-reviewed files (the EACCES branches change only which message reaches
an already-existing `SaoError`, not what triggers it). `src/interactive-choices.ts`
takes its `<options>` blob via a bare CLI argument (`options=<blob>` or a
positional arg), not stdin — the rubric's argv-exposure boundary is written for
prompts/secrets flowing through sao's own runtime, and this tool never runs
inside a workflow or handles agent/user secrets, so the blast radius is a
developer's own shell history at worst. Flagged as a minor consequence of the
finding above rather than standalone: a tool that shouldn't exist in this
feature yet is the one place in the diff that puts arbitrary text on argv.
