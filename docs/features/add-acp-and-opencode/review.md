# Review — engineering trail: add-acp-and-opencode

Durable log for `reviewer_engineering`'s four lenses (code/TDD, architecture,
performance, security). Never emptied; each round appends/updates. The
repo-rules, CLI-surface, and docs lenses are covered separately per slice in
`review-slice.md`; the spec-level review is in `review-spec.md`.

---

## Round 1 — full-review — 2026-08-08

**Verdict: APPROVED** → `docs/features/add-acp-and-opencode/review.md`

### Diff reviewed

`git diff 8912c536...HEAD` (full feature): `src/acp.ts` (new), `src/runners/opencode.ts`
(new), `src/runners/types.ts`, `src/engine.ts`, `src/gate.ts`, `src/nodes.ts`,
`src/parser.ts`, `src/schema.ts`, `src/cli.ts`, `package.json`/`bun.lock`,
`SPEC.md`/`README.md`, plus `tests/acp.test.ts`, `tests/opencode.test.ts`,
`tests/engine-acp.test.ts`, `tests/gate-permission.test.ts`,
`tests/cli.test.ts`, `tests/gate.test.ts`, `tests/nodes.test.ts`,
`tests/engine-m4.test.ts`, `tests/codex.test.ts`, `tests/runners.test.ts` (new
+ changed). Cross-referenced against `gherkin-scenarios.md` (31 `@s` tags),
`tdd.md`'s four-slice log, and the four prior slice rounds already recorded in
`review-slice.md` (S1–S4, all findings there marked `resolved`) to avoid
re-litigating settled findings and instead check the *accumulated*, whole-feature
diff fresh across the four lenses this file owns.

### 1. Code quality & TDD

- `@s` → test coverage is complete: all 31 tags in `gherkin-scenarios.md` have at
  least one matching `@s-...` test tag across `tests/{acp,opencode,engine-acp,
  gate-permission,cli}.test.ts` (verified by diffing the tag sets, not just
  grepping for presence — zero orphans either direction).
- Engine-level tests (`tests/engine-acp.test.ts`) inject a hand-rolled
  `mockAcpRunner`/`Runner` object, never a real `claude`/`codex`/`opencode`
  binary. Runner-level tests (`tests/acp.test.ts`, `tests/opencode.test.ts`,
  `tests/gate-permission.test.ts`) spawn a hand-rolled Node script speaking raw
  ACP JSON-RPC over stdio — a test double, not the real `opencode` CLI — matching
  the existing claude/codex adapter tests' precedent of stubbing a same-named
  executable on `PATH`.
- Tests bite: e.g. `tests/gate-permission.test.ts`'s
  `@s-permission-prompt-numbered` asserts the exact rendered menu text
  (`"1. Allow"`, `"2. Deny"`) and separately asserts that text never reaches
  `onOutput` — a regression of either the S3 double-print bug or a menu-format
  change would fail it. `tests/opencode.test.ts`'s handshake-failure test
  asserts the underlying cause string survives into the preflight error, not
  just that *some* error was thrown.
- Timing-sensitive tests (`@s-timeout-paused-during-prompt`,
  `@s-timeout-paused-while-queued` in `tests/acp.test.ts`) use real wall-clock
  timers, but the pass condition doesn't depend on tight margins: the pause is
  either fully in effect (in which case the human's delay, however long, never
  reaches the timer) or it isn't (in which case the test fails regardless of
  timing). No sleep-and-hope assertion — CI load can only make these tests
  slower, not flaky.
- No `console.log`/debug leftovers in the new/changed `src/` files (checked
  `acp.ts`, `runners/opencode.ts`, `engine.ts`, `gate.ts`, `nodes.ts`,
  `parser.ts`, `schema.ts`, `cli.ts`, `runners/types.ts` — the only
  `console.log` calls are the pre-existing CLI-output sites). No TODO without an
  issue; no commented-out code.
- Short, single-purpose functions throughout `src/acp.ts`
  (`composeAcpPrompt`/`ignoredAcpSettings`/`toMcpServer`/`loadAcpMcpServers`/
  `runAcpTurn`/`runAcpHandshake`); the pausable-timer helpers
  (`armTimer`/`clearTimer`/`pauseTimer`/`resumeTimer`) each do one thing. No
  magic numbers beyond the existing `timeoutSec * 1000` convention and the
  documented `DEFAULT_HANDSHAKE_TIMEOUT_SEC = 10`.

### 2. Architecture & minimalism

- Layering holds: `src/runners/opencode.ts` is name + launch command +
  delegation to `src/acp.ts` only (no protocol logic duplicated); `src/acp.ts`
  imports downward from `./gate` (`parsePermissionReply`, `PromptUser` type) and
  `./procs` (`killTree`/`track`/`swallowStdinErrors`), consistent with the
  documented tier order (nodes/runners → state/worktree/gate/runs). No upward
  import from `engine.ts`/`nodes.ts` into runner internals — `engine.ts` and
  `nodes.ts` only ever touch a runner through the `Runner`/`RunnerRequest`
  interface in `src/runners/types.ts`.
- `opencode` is one new file in `src/runners/`, registered in the existing
  static `REGISTRY` map (`src/runners/types.ts:62-66`) alongside claude/codex —
  no dynamic loading introduced.
- The one new runtime dependency, `@zed-industries/agent-client-protocol`, is a
  recorded, human-approved decision (`review-spec.md` finding 1 resolution;
  `spec.md` D1; `SPEC.md`'s dependency line updated four→five), not an
  undocumented addition. It lands in `package.json`'s `devDependencies` block —
  checked this isn't a new inconsistency: `commander`/`yaml`/`zod`/`picocolors`
  were *already* listed there before this feature (confirmed against
  `8912c536:package.json`), because `bun build --target node` bundles
  everything into `dist/cli.js` and only `dist/` ships (`"files": ["dist"]`) —
  the new dependency follows the pre-existing convention exactly, not a fresh
  deviation.
- No Bun-only API in `src/`: `node:child_process`, `node:stream`, `node:fs`
  only; `Readable.toWeb`/`Writable.toWeb` are stable Node ≥ 18 builtins.
- Validation stays front-loaded: `preflightRunnerEnvironments` (`src/engine.ts:625-663`)
  is awaited in `runWorkflow` before `hashRunConfig`/run-dir/worktree creation
  (`src/engine.ts:97-99`), and identically in `formatDryRun` and `sao validate`
  (`src/cli.ts:56-57,118-119`) — a missing binary, failed handshake, or
  capability/MCP-transport gap fails before any node's side effects in all four
  invocation paths (`run`, `validate`, `resume` via `runWorkflow`, `--dry-run`).
- Schema/state-shape: `Workflow.mcpServers` is now populated for both the
  inline and path forms of `mcp:` (`src/parser.ts:79`), a parse-time
  representational change, not a persisted-state change — `state.json`'s shape
  is untouched by this feature (confirmed no diff to `src/state.ts`), so
  resume/config-hash behavior for in-flight runs is unaffected.
- One duplication (three sites parsing the same `.mcp.json`-shaped file) was
  caught and fixed within the feature itself (S4 review, `resolved` in
  `review-slice.md`) — re-checked against the current tree: `src/parser.ts`
  keeps the parsed object for both forms, `src/engine.ts`'s
  `neededMcpTransports` (`src/engine.ts:665-680`) reads `workflow.mcpServers`
  directly with no re-read, and only `src/acp.ts:70-74`'s per-turn read
  remains — necessarily so, since it operates on the resolved runtime
  `mcpConfigPath` rather than the static `Workflow` object. No regression.

### 3. Performance

- Scheduling: the new `await preflightRunnerEnvironments(...)` is a one-time,
  before-any-node gate — it does not sit inside the per-node concurrency path,
  so it cannot serialize otherwise-concurrent node execution. Within it,
  distinct runners are probed once each (`probed` Set, `src/engine.ts:635-639`
  logic carried over from before this feature) — for a workflow mixing
  claude/codex/opencode, the two static-preflight runners resolve
  synchronously and only the ACP runner's handshake actually blocks on I/O.
- Subprocess output: `runAcpTurn`'s `output` accumulator (`src/acp.ts:160-168`)
  grows unbounded for the turn's lifetime, same as the pre-existing
  claude/codex adapters' `collector.output` (`src/runners/claude.ts`,
  `src/runners/codex.ts`) — the rubric's 100-line cap is bash-node-specific
  (`src/nodes.ts`'s `BASH_OUTPUT_TAIL_LINES`), not an AI-runner convention this
  diff breaks.
- Log appends are incremental: each `agent_message_chunk` calls `req.onOutput?.(text)`
  immediately (`src/acp.ts:167`), not buffered and flushed once.
- The `.mcp.json` file is read synchronously once per `runAcpTurn` call (i.e.
  once per loop iteration for a looping ACP node) rather than cached across
  iterations. Noted but not raised as a finding: the file is small, the read is
  dwarfed by the fresh subprocess spawn that already happens every turn by
  design (spec: "each call is a fresh spawn"), and the alternative (a
  cross-call cache) would add state-management complexity disproportionate to
  the actual cost.
- No synchronous fs work was added on a path where an async form is already
  used nearby; `readFileSync` in `loadAcpMcpServers` matches the codebase's
  existing sync-fs convention (`src/parser.ts`, `src/state.ts`).
- CLI startup: `src/acp.ts`/`@zed-industries/agent-client-protocol` are only
  imported transitively through `src/runners/opencode.ts`, which every command
  already imports via the runner registry — no new heavy import gated behind a
  command that doesn't need it, consistent with how claude/codex are already
  always-imported.

### 4. Security

- Shell/command injection: no new shell string is built from a
  workflow-author-uncontrolled value. Agent-supplied text (assistant output,
  permission option names/titles) is only ever rendered to the terminal/log or
  echoed back into the ACP JSON-RPC `optionId` field — never interpolated into
  a spawned command or a `sh -c` string.
- argv exposure: the prompt (including the system-prompt preamble) and the
  permission reply both ride the ACP JSON-RPC channel over stdio
  (`conn.prompt(...)`, the `requestPermission` response) — `spawn(launch.command,
  launch.args, ...)`'s `args` is the fixed `["acp"]` constant
  (`src/runners/opencode.ts:7`), never a runtime value.
- Path traversal: `req.nodeId` and permission option text are used only in
  human-readable strings, never as a path segment. `mcpConfigPath` is either
  sao's own run-dir-generated file or the workflow's own already-resolved,
  already-JSON-validated path from `src/parser.ts` — not fresh user input at
  this point.
- git refspec: this feature touches no git/push code path — N/A, no diff to
  `src/worktree.ts`.
- Secrets: MCP `env` values are forwarded verbatim as strings
  (`nameValuePairs`, `src/acp.ts:45-48`) — sao performs no `${ENV_VAR}`
  expansion or templating of them, matching the documented forwarder-not-host
  contract; a secret in `mcp.json` is exactly as exposed (or not) as it already
  is for the claude/codex adapters. Nothing new is written to `state.json` or a
  committed file. The one place agent-controlled text reaches the log/terminal
  unfiltered — the ACP double's `stderr` passthrough (`src/acp.ts:157-158`,
  pre-existing pattern also used by claude/codex) — is the agent's own stream,
  not sao-constructed, and is outside this feature's threat-model change.
- Process teardown: both `runAcpTurn` and `runAcpHandshake` spawn `detached:
  true` and immediately `track()` (`src/acp.ts:96,280`), so an untimed abort
  (Ctrl-C) reaps them via `shutdownAll` the same as every other adapter's child.
  Every settle path (`error`, `close`, timer fire, success) calls `killTree`
  before resolving/rejecting except the plain success path in `runAcpTurn`,
  which also calls it (`src/acp.ts:243`) — no path leaves the child running
  after the promise settles. No `close`-based timeout: both timers
  (`onTimeout` in `runAcpTurn`, the inline timer in `runAcpHandshake`) fire
  from their own `setTimeout`, matching the rubric's requirement, and this was
  the exact defect S2's review caught and fixed for the handshake path
  (`review-slice.md` S2 finding 1, `resolved`) — reconfirmed still in place in
  the current tree.
- Resume trust: no diff to `src/state.ts`, `acquireRunLock`, or the config-hash
  mechanism — N/A, unaffected by this feature.

### Findings

None new. This round independently re-confirmed (against the current, fully
merged tree, not just the historical per-slice diffs) that all findings
previously raised and marked `resolved` in `review-slice.md` (S2's missing
handshake timeout and swallowed error; S3's double-printed permission prompt
and the stale stdin-closed hint; S4's triple-parsed `.mcp.json`) are still
fixed with no regression introduced by a later slice.

---

## Round 2 — delta-review (mutation kill pass) — 2026-08-08

**Verdict: APPROVED** → `docs/features/add-acp-and-opencode/review.md`

### Diff reviewed

`git diff c067e77...HEAD` (mutation-fix commit only): `src/engine.ts` (+2),
`src/nodes.ts` (+1), `src/runners/opencode.ts` (+1) — three added
`// Stryker disable next-line` comments, no behavior change — plus
`tests/engine-acp.test.ts` (+3 tests) and `tests/opencode.test.ts` (+4 tests,
3 strengthened assertions), `mutation.md` (new: 98.70% score, 0 survived),
`tdd.md` ("Mutation kill pass" section + condensed prior-slice entries).
Cross-checked against `mutation.md`'s per-file table and the "Mutation kill
pass" section of `tdd.md`, which names exactly these three suppressions and
the remaining survivors as test-strengthening only.

### 1. Code quality & TDD

- No new `@s` tags; `gherkin-scenarios.md` untouched, so the existing 31-tag
  coverage from Round 1 stands unchanged.
- The four new/strengthened tests bite: `opencode.test.ts`'s three existing
  preflight-rejection tests now assert the exact `err.hint` string (not just
  `err.message`), and three new tests
  (`sse-only-capability-rejects-http`/`http-only-capability-rejects-sse`-style
  cases plus the two no-`mcpCapabilities`-at-all cases) exercise
  `opencodeRunner.preflight`'s transport-capability branch directly per
  transport, closing exactly the survivors `mutation.md` reports as killed on
  `runners/opencode.ts` (100.00%, 44/44). `engine-acp.test.ts`'s three new
  tests (fresh-context-true → `needsSessionResume` stays `false`;
  malformed-`mcpServers`-entries scan settles on the one valid `sse` entry;
  a genuinely-`undefined` (not merely absent) server value is skipped without
  throwing) each target a distinct branch in `neededMcpTransports`/the
  session-resume-needs loop — verified these aren't restatements of existing
  `@s`-tagged tests by diffing test names against Round 1's list.
- The three `// Stryker disable next-line` suppressions
  (`engine.ts:638,640`, `nodes.ts:102`, `runners/opencode.ts:23`) are each
  accompanied by a specific, checked-correct equivalence argument, not a bare
  suppression:
  - `engine.ts:638-641` — `configs.get(node.id)?.runner` / `if (runner)`:
    confirmed `src/parser.ts:162-165` rejects `fresh_context: false` combined
    with `steps !== undefined`, so a loop with `fresh_context: false` that
    passed `loadWorkflow` always has `node.loop.prompt !== undefined`, which
    is exactly `preflightAiConfigs`'s condition (`src/engine.ts:591`) for
    populating `configs.get(node.id)`. The optional-chain and `if` guard are
    unreachable-false for any workflow that went through the parser — matches
    the pre-existing identical suppression already in place four lines above
    at `engine.ts:606` for the same reasoning (not a new pattern introduced
    ad hoc for this pass).
  - `nodes.ts:102` — `if (timer) clearTimeout(timer)`: `clearTimeout(undefined)`
    is a spec'd no-op in Node — confirmed no observable difference.
  - `runners/opencode.ts:23` — `{ cwd: process.cwd() }`: `child_process.spawn`
    already defaults `cwd` to `process.cwd()` when omitted — confirmed no
    observable difference between passing it explicitly and omitting it.
  - `tdd.md`'s "Mutation kill pass" section records these were "reproduced by
    hand before disabling," i.e. verified as equivalent rather than
    rubber-stamped, consistent with what re-deriving each claim above found.
- No `console.log`/debug leftovers, no TODOs, no unrelated churn — the diff is
  scoped exactly to the three suppressions plus the tests/docs that justify
  them; no other line in `src/` changed.

### 2. Architecture & minimalism

- Zero behavioral change: all three `src/` edits are comments only, no logic,
  import, dependency, or schema/state-shape touched. Layering, the static
  runner registry, and the `Runner` interface boundary are all unaffected —
  re-confirmed unchanged from Round 1's assessment.

### 3. Performance

N/A — the diff adds no executable code (comments only) and no new test
touches a scheduling, subprocess-buffering, or persistence path differently
than Round 1 already assessed.

### 4. Security

N/A — no new subprocess, path, git, or persistence surface; the diff is
comments plus hermetic unit tests (mock `Runner`/stubbed `opencode` binary on
`PATH`, same doubles as Round 1, no real `claude`/`codex`/`opencode` spawned).

### Findings

None new, none reopened. `mutation.md` reports 0 survived / 98.70% score
(100% of covered code killed); the 24 no-coverage mutants are pre-existing,
unreachable `acp.ts` subprocess-error/cleanup paths already noted as such in
`mutation.md` itself, not a product of this delta.
