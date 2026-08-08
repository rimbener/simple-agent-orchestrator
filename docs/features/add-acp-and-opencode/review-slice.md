# Review — slice trail: add-acp-and-opencode

Durable log across slices. Never emptied; each slice appends/updates its section.
Findings are marked `open` / `resolved`.

---

## Slice S1 — ACP transport & opencode runner (task-1, task-2)

**Verdict: CHANGES_REQUESTED** → `docs/features/add-acp-and-opencode/review-slice.md`

### Diff reviewed

`git diff HEAD` and `git status --porcelain` at review time show **no code diff**:

- No changes to `package.json`, `src/`, or `tests/`.
- The only new file is `docs/features/add-acp-and-opencode/tdd.md` (untracked),
  which records that `build-slice` never reached a RED test.

`tdd.md` states the slice is **Blocked**: task-1 requires adding
`@zed-industries/agent-client-protocol` as a new runtime dependency (spec.md D1,
already approved at the gate per `story.md` Note 7), and the sandbox this attempt
ran in denies all network access (`bun add`, `npm view`, and a raw `curl` to
`registry.npmjs.org` all refused). Without the package physically present in
`node_modules`, `src/acp.ts` cannot be written, typechecked, or tested, so none of
task-1's five `@s` scenarios could go red→green.

### Findings

1. **[correctness] `open`** — `docs/features/add-acp-and-opencode/tdd.md:5-11`.
   Zero implementation exists for slice S1: `src/acp.ts`, `tests/acp.test.ts`, and
   the `package.json` dependency bump from task-1.md's `paths:` list are all
   absent, and none of the five `@s` scenarios assigned to task-1
   (`@s-acp-stream-and-output`, `@s-acp-output-excludes-thoughts`,
   `@s-acp-sentinel-ends-loop`, `@s-acp-refusal-fails-node`,
   `@s-acp-timeout-kills`) have a test. Task-2 (opencode registry entry) also has
   no diff. A slice with no code cannot be approved — this is a blocker on
   infrastructure (network access to fetch the approved D1 dependency into this
   worktree), not a defect in written code. Re-run `build-slice` after `bun add
   @zed-industries/agent-client-protocol` succeeds in an environment with network
   access, then re-invoke this review against the real diff.

   **`resolved` (build-slice landed code, 2026-08-08):** network access was
   restored; `bun add @zed-industries/agent-client-protocol` succeeded. The slice
   now has a real diff — `src/acp.ts`, `src/runners/opencode.ts`,
   `tests/acp.test.ts`, `tests/opencode.test.ts`, plus the `package.json`,
   `src/runners/types.ts`, `tests/runners.test.ts`, `SPEC.md`, `README.md` edits.
   See the **Slice S1 — landed** section below for the review of that diff.

### Sections not applicable to this attempt (no code diff to check)

- **2. Repo rules** — N/A, no `src/`/`package.json` changes to check for
  minimalism, layering, node-target, procs, or path/state safety.
- **3. Code quality** — N/A, nothing written.
- **4. CLI & workflow surface** — N/A, no terminal-output, error-message, YAML, or
  runner-parity changes shipped yet.
- **5. Docs parity** — N/A for this attempt: `SPEC.md`'s locked four-dependency
  line is correctly still untouched, since the D1 dependency bump never actually
  landed in `package.json`. Once task-1 lands code, `SPEC.md`'s dependency count
  and `README.md` (`opencode` runner entry, task-2) updates are required in that
  same slice's diff — flag then if missing.

---

## Slice S1 — landed (task-1, task-2) — 2026-08-08

**Verdict: APPROVED** → `docs/features/add-acp-and-opencode/review-slice.md`

### Diff reviewed

`git diff HEAD` (working tree) for: `package.json`, `src/runners/types.ts`,
`tests/runners.test.ts`, `SPEC.md`, `README.md`; plus new files `src/acp.ts`,
`src/runners/opencode.ts`, `tests/acp.test.ts`, `tests/opencode.test.ts`. Cross-checked
`session/update` variant names (`agent_message_chunk`, `agent_thought_chunk`,
`tool_call`), `stopReason`, and `RequestPermissionResponse` shapes against
`node_modules/@zed-industries/agent-client-protocol/dist/schema.d.ts` — the
implementation matches the real protocol, not just the test double's shape.

### 1. Correctness against the contract

All 9 `@s` scenarios owned by task-1/task-2 have a test that bites:

- `@s-acp-stream-and-output`, `@s-acp-output-excludes-thoughts`,
  `@s-acp-refusal-fails-node`, `@s-acp-timeout-kills` (`tests/acp.test.ts`) each
  assert behavior a broken implementation would fail (streamed+joined text,
  thought/tool-call exclusion, refusal → reject with message containing
  "refused", real-process-death polling on timeout).
- `@s-acp-sentinel-ends-loop` maps to "successive turns each return their own
  isolated output" rather than a full loop run. This is correct scoping, not a
  weak test: `sentinelToken`/loop-ending logic is engine-level and already
  covered generically with a mock runner in `tests/engine-m2.test.ts`
  ("sentinel loops" describe block) — the only ACP-specific risk is
  `runAcpTurn` leaking output state across calls, which this test does exercise
  (two distinct doubles, asserted not to bleed into each other).
- `@s-opencode-runner-selectable`'s three-way selection (node key / workflow
  defaults / `--runner` override) is likewise proven runner-agnostic already in
  `tests/engine-m4.test.ts` ("node-level runner, agent frontmatter runner, and
  --runner override are all caught"); the opencode-specific test only needs to
  confirm the registry entry resolves and executes through the real ACP client,
  which it does (`tests/opencode.test.ts`, `tests/runners.test.ts`).
- `@s-opencode-agent-system-prompt`, `@s-opencode-missing-binary-preflight`,
  `@s-unknown-runner-lists-opencode` all bite (echoed-prompt assertion,
  message+hint assertion, updated available-runners hint).
- Every `SaoError` this slice adds carries a hint or truncated detail
  (`src/acp.ts:66,71,77,116`; `src/runners/opencode.ts:16`), consistent with the
  claude/codex adapters' error shape.
- No scope creep: capability preflight, permission requests, timeouts-across-waits,
  sessions/resume, and MCP passthrough (the other 17 `@s` scenarios in
  `gherkin-scenarios.md`) are correctly left untouched for tasks 3–7 — confirmed
  by grepping for `mcpServers`/`permissionMode`/`allowedTools` usage in
  `src/acp.ts`: none read, `requestPermission()` always cancels with a comment
  pointing at task 4.

### 2. Repo rules

- **Minimalism** — `@zed-industries/agent-client-protocol` is a recorded,
  pre-approved decision (D1, `SPEC.md`), not an undocumented addition. No new
  abstraction beyond what task-1/task-2 call for.
- **Layering** — `src/runners/opencode.ts` is exactly name + launch command +
  delegation to `src/acp.ts`, matching the "one new file in `src/runners/`,
  registered in the static `REGISTRY` map" rule (`src/runners/types.ts:47`) — no
  dynamic loading. `src/acp.ts` importing `RunnerRequest`/`RunnerResult` as
  types from `./runners/types` mirrors how `engine.ts`/`nodes.ts` already
  consume that same module; avoiding it would require a second near-identical
  request/response shape and a mapping layer between them for a single
  consumer, which is the extra abstraction the minimalism rule warns against.
- **Node target** — `node:child_process`, `node:stream` only; no Bun-only API.
  `Readable.toWeb`/`Writable.toWeb` are stable Node builtins by Node 20.
- **Process safety** — spawned `detached: true`, `track()`ed, stdin errors
  swallowed (`src/acp.ts:41-49`); the timeout settles from its own `setTimeout`
  and never awaits `close` (`src/acp.ts:63-68`); `close` always rejects if the
  turn hasn't already settled, so a crashed/handshake-refusing agent can't hang
  the pending promise forever.
- **Path / input / argv safety** — no user-controlled path/argv construction
  here; the prompt (incl. the system-prompt preamble) rides the ACP JSON-RPC
  `prompt` param, never argv.
- **State durability** — unaffected; `sessionId` flows through the existing
  generic `RunnerResult`/state-persistence path untouched by this diff.
- **Comments** — `Stryker disable` comments on `src/acp.ts:43,58` each state why
  the mutant is equivalent, matching `src/runners/codex.ts`'s existing wording.

### 3. Code quality

Short, single-purpose functions; no duplication beyond the established
claude/codex adapter shape (`composeAcpPrompt` mirrors `composeCodexPrompt` by
design, per spec); no magic numbers beyond the existing `timeoutSec * 1000`
convention; no `console.log`/debug leftovers; no commented-out code.

### 4. CLI & workflow surface

- Terminal output: assistant-text chunks go through the same `onOutput` seam
  the engine already prefixes with `[node-id]` and appends to the node log —
  no new output path introduced.
- Error messages: `"opencode CLI not found on PATH"` + `"install opencode:
  https://opencode.ai"` hint follows the claude/codex install-hint voice;
  `"<cmd> refused the turn"` + truncated output detail follows the codex
  in-stream-error precedent.
- `sao validate` catches a missing `opencode` binary and an unknown-runner name
  at parse/preflight time via the existing generic registry + preflight
  mechanism — no new validation code needed, none skipped.
- YAML surface: `runner: opencode` needs no new schema key; the existing
  `runner:` string field already accepts any registered name.
- Both runners: claude/codex are untouched by this diff (`git diff` shows no
  changes to `src/runners/claude.ts` or `src/runners/codex.ts`).

### 5. Docs parity

`SPEC.md` (`AI execution` decision row, opencode-adapter paragraph, dependency
count four→five, file-tree entries) and `README.md` (prereqs, `runner:` comment,
Runners section) are both in this slice's diff and match the shipped behavior —
no overclaiming of not-yet-built capability-preflight, permission-request,
session-resume, or MCP-passthrough behavior.

### Findings

None.

---

## Slice S2 — Capability preflight (task-3) — 2026-08-08

**Verdict: CHANGES_REQUESTED** → `docs/features/add-acp-and-opencode/review-slice.md`

### Diff reviewed

`git diff ceddcb4..d5b7f98` (S1 → S2): `src/acp.ts`, `src/engine.ts`, `src/cli.ts`,
`src/runners/opencode.ts`, `src/runners/types.ts`, `README.md`, `SPEC.md`,
`docs/features/add-acp-and-opencode/task-3.md`, and tests
`tests/acp.test.ts`, `tests/codex.test.ts`, `tests/engine-acp.test.ts` (new),
`tests/engine-m4.test.ts`, `tests/opencode.test.ts`, `tests/runners.test.ts`.

### 1. Correctness against the contract

All 6 `@s` scenarios owned by task-3 have a test that bites
(`tests/engine-acp.test.ts` + `tests/opencode.test.ts` + `tests/acp.test.ts`'s new
`runAcpHandshake` describe block) — verified `@s-capability-gap-preflight`,
`@s-capability-present-passes`, `@s-validate-performs-handshake`,
`@s-handshake-once-per-runner`, `@s-handshake-failure-preflight`,
`@s-existing-runners-unaffected` each assert a message/behavior a broken
implementation would fail. No scope creep: MCP-transport needs (task 7) are
correctly left out of `RunnerNeeds`.

One correctness gap survives, on a path no scenario or test currently exercises:

1. **[procs] `open`** — `src/acp.ts:138-192` (`runAcpHandshake`). Every other
   spawn in this codebase (`runAcpTurn` at `src/acp.ts:63-68`, `src/nodes.ts:97-101`,
   `src/runners/claude.ts:193`, `src/runners/codex.ts:214`) settles from its own
   timer so a hung agent can't block forever. `runAcpHandshake` has none: its only
   settle paths are `"error"` (spawn failure), `"close"` (early exit), and the
   `initialize()` promise resolving/rejecting. If the agent binary spawns
   successfully but never replies to `initialize` (hung process, broken
   install, a version mismatch that silently drops the request), the promise
   never settles. Because `preflightRunnerEnvironments` (`src/engine.ts:625-647`)
   `await`s this per distinct runner and is itself awaited by `sao run`,
   `sao validate`, `sao resume` (via `runWorkflow`), and `--dry-run`
   (`src/cli.ts`, `src/engine.ts:405-420`), the whole CLI invocation hangs
   indefinitely with no message, no timeout, and no way out short of the user
   manually killing it — and the tracked child (`src/acp.ts:146`) is only reaped
   on the parent's own SIGINT/SIGTERM/exit (`src/procs.ts:82-98`), so it is never
   cleaned up while the hang is in progress. Confirmed this path is untested:
   `tests/acp.test.ts`'s `DOUBLE_SCRIPT` only honors `config.hang` inside the
   `session/prompt` branch (line 62) — the double always answers `initialize`
   immediately, so no test drives a hung handshake. Give `runAcpHandshake` the
   same timer-based settle its sibling `runAcpTurn` already has (a fixed
   preflight timeout, or a caller-supplied one), and add the corresponding
   "handshake never responds" test.

### 2. Repo rules

- **Minimalism** — no new dependency or abstraction beyond what task-3 calls
  for; `RunnerNeeds` is the minimal shape task-3.md specifies (session-resume
  only, MCP deferred to task 7).
- **Layering** — unaffected; `opencodeRunner` still only delegates to `src/acp.ts`.
- **Node target** — no Bun-only API added.
- **Process safety** — see finding 1 above; everything else (detached spawn,
  `track()`, `killTree` on both settle branches that have a live child) matches
  the established pattern.
- **Path / input / argv safety** — unaffected by this slice.
- **State durability** — unaffected; `RunnerNeeds` is computed fresh per
  preflight call, never persisted.
- **Comments** — accurate; no stale `Stryker disable` comments added.

### 3. Code quality

Mostly clean split (`preflightAiConfigs` sync / `preflightRunnerEnvironments`
async), consistent with the task-3 spec. One quality nit alongside finding 1:

2. **[quality] `open`** — `src/runners/opencode.ts:21-26`. The `catch` around
   `runAcpHandshake` discards the real error (`catch { throw new
   SaoError("opencode failed the ACP handshake", "…did not respond to
   initialize — check it is up to date"); }`) instead of folding it in, the way
   every other adapter in this diff and its neighbours does (`src/acp.ts:187`'s
   `` `${launch.command} failed: ${err.message}` ``, `truncateDetail(output)` in
   `src/runners/claude.ts:186`/`src/runners/codex.ts:193`). A handshake that
   fails for a reason other than "exited" or "out of date" — e.g. a malformed
   `initialize` response, a permission error, a protocol-version mismatch — is
   reported with a generic, possibly-wrong guess instead of the actual cause,
   making it harder to debug than any other error path in this file. Fold the
   caught error's message into the `SaoError` (mirroring `runAcpTurn`'s own
   catch two functions above it) instead of dropping it.

### 4. CLI & workflow surface

- `sao validate` now performs the same handshake `run` does — verified via
  `README.md`/`SPEC.md` and `tests/engine-acp.test.ts`'s
  `@s-validate-performs-handshake` test.
- Error messages: capability-gap and missing-binary messages name the agent
  and the missing capability/binary, matching the existing voice — except the
  swallowed-detail case in finding 2.
- Both runners: claude/codex `preflight()` signatures are unchanged in body
  (only the call sites now pass `{ needsSessionResume: false }`, which they
  ignore) — `@s-existing-runners-unaffected` confirms no handshake is attempted
  for either.
- YAML surface: no new keys; `fresh_context: false` behavior is now
  runner-capability-dependent rather than statically declared, which is D2 and
  is documented.

### 5. Docs parity

`SPEC.md` (execution-semantics step 2 — ACP capability handshake) and
`README.md` (`validate` description, `fresh_context: false` comment, opencode
bullet) are both in this slice's diff and match the shipped behavior — neither
overclaims a timeout guarantee the code doesn't have.

### Findings

1. **[procs] `resolved`** — `src/acp.ts:138-192`. `runAcpHandshake` has no
   timeout; a hung `initialize` blocks `run`/`validate`/`resume`/`--dry-run`
   forever. See analysis above. Fixed: `runAcpHandshake` now settles from its
   own timer (`DEFAULT_HANDSHAKE_TIMEOUT_SEC = 10`, overridable via
   `opts.timeoutSec`), mirroring `runAcpTurn`. Test: `tests/acp.test.ts`
   "a hung handshake times out, kills the process, and rejects naming the
   timeout" (new `hangInitialize` double config).
2. **[quality] `resolved`** — `src/runners/opencode.ts:21-26`. The handshake
   failure catch discards the real error instead of folding it into the
   `SaoError`, unlike every sibling error path in this diff. Fixed: the catch
   now folds `err.message` into the `SaoError`. Test:
   `tests/opencode.test.ts`'s `@s-handshake-failure-preflight` strengthened to
   assert the underlying detail ("exited before completing the ACP handshake")
   survives into the preflight error.

---

## Slice S3 — Permission prompts (task-4, task-5) — 2026-08-08

**Verdict: CHANGES_REQUESTED** → `docs/features/add-acp-and-opencode/review-slice.md`

### Diff reviewed

`git diff 941f54a..cced965` (S2 → S3): `src/acp.ts`, `src/engine.ts`, `src/gate.ts`,
`src/nodes.ts`, `src/runners/types.ts`, `SPEC.md`, `README.md`,
`docs/features/add-acp-and-opencode/{task-4,task-5}.md` (status flips), and tests
`tests/acp.test.ts`, `tests/cli.test.ts`, `tests/gate-permission.test.ts` (new),
`tests/gate.test.ts`, `tests/nodes.test.ts`, `tests/engine-acp.test.ts`.

### 1. Correctness against the contract

All 7 `@s` scenarios owned by task-4/task-5 have a test that bites, cross-checked
against `gherkin-scenarios.md`'s exact Given/When/Then:
`@s-permission-prompt-numbered`, `@s-permission-invalid-reply-reasks`
(`tests/acp.test.ts`), `@s-permission-stdin-closed-fails`,
`@s-permission-serialized-with-gates`, `@s-no-new-prompts-for-claude-codex`
(`tests/cli.test.ts`, real spawned CLI + stub binaries), `@s-timeout-paused-during-prompt`,
`@s-timeout-paused-while-queued` (`tests/acp.test.ts`, real-wall-clock timers that
would actually fire without the pause — 1s `timeoutSec` vs. 1.5s/1.6s waits).
Plumbing (`nodeId`/`promptUser` reaching the runner) is covered in
`tests/nodes.test.ts` and `tests/engine-acp.test.ts`. No scope creep: grepped the
diff for `permission_mode`/`allowed_tools`/`mcpServers` — none touched, correctly
left for later tasks. `parsePermissionReply` (`src/gate.ts:28-35`) is
unit-tested for every boundary (0, out-of-range, non-numeric, whitespace).

One behavioral defect survives, reproduced by actually running the shipped CLI
against a stub `opencode` binary (not just inferred from reading the code):

1. **[cli-ux] `open`** — `src/acp.ts:130,136,147`. Every permission request is
   rendered on the live terminal **twice**: once via `req.onOutput?.(...)`
   (`src/acp.ts:130`, `147`), which — per every other `NodeLog.log` call in this
   codebase (`src/engine.ts:1052-1074`, `makeLog`'s `echoLine`) — both appends to
   the node's log file *and* echoes a dim `[node-id]`-prefixed copy straight to
   the console; and a second time via the actual interactive prompt text handed
   to `req.promptUser` (`src/acp.ts:136`), which repeats the same node id, title,
   and numbered menu. Ran the real flow end to end (spawned `sao run` against a
   stub `opencode` binary that requests permission, replying `1`) and captured:
   ```
     [ask] permission requested: risky action
     [ask]   1. Allow

   [ask] permission requested: risky action
     1. Allow
   >   [ask] selected: Allow
   ```
   The block is shown once dim (log echo) and once bright (the actual prompt),
   and because `promptOnTerminal`'s prompt write has no trailing newline, the
   `selected: …` log-echo line lands merged onto the same line as the `>` prompt
   when the reply arrives over a pipe (`sao`'s own documented "piped replies,
   one line per prompt" mode — `src/gate.ts:61`, `README.md`'s stdin section —
   not just an interactive-tty edge case). This contradicts the single clean
   block both `SPEC.md`'s new "Permission requests" subsection and `README.md`'s
   own example render (one occurrence, no echo) document as the expected output
   — the docs are correct, the implementation doesn't match them. No existing
   test catches it: the `tests/acp.test.ts` scenarios inject a bare capturing
   `promptUser`/`onOutput` (never the real `this.print` + real
   `promptOnTerminal` together), and the `tests/cli.test.ts` spawned-CLI
   scenarios only assert substring presence/ordering, not absence of a
   duplicate. Either drop the `onOutput` call for the request text (the prompt
   itself already shows it to the human; log the request to the file through a
   channel that doesn't console-echo) or drop the redundant text from the
   prompt message and rely on the log echo alone — but not both painting the
   same information over each other.

2. **[cli-ux] `open`** — `src/gate.ts:58-63` (`stdinClosedError`, unchanged by
   this diff but now reached from a new caller). The hint text — "gates and
   interactive loops need an interactive terminal (or piped replies, one line
   per prompt)" — is reused verbatim for a permission-prompt stdin closure
   (`@s-permission-stdin-closed-fails`, exercised via `src/acp.ts:139-141`'s
   catch), but never mentions permission requests as a case. A user hitting this
   from an ACP node's `session/request_permission` sees a hint that names two
   unrelated flows and omits the one that actually fired, which reads as
   possibly-stale copy rather than an accurate, actionable hint (rubric §4). The
   tests only assert the message contains "interactive terminal", which passes
   regardless of this gap. Reword the hint to cover all three callers now that
   `stdinClosedError` is shared three ways.

### 2. Repo rules

- **Minimalism** — no new dependency; the pausable-timer helpers
  (`armTimer`/`clearTimer`/`pauseTimer`/`resumeTimer`) are the minimal shape
  task-5 calls for, no extra abstraction.
- **Layering** — `src/acp.ts` and `src/runners/types.ts` importing
  `parsePermissionReply`/`PromptUser` from `./gate`, and `src/nodes.ts` importing
  `PromptUser` from `./gate`, are all downward (gate.ts sits at the
  state/worktree/gate/runs tier below nodes/runners) — no upward imports
  introduced.
- **Node target** — no Bun-only API added; `Date.now()`/`setTimeout` only.
- **Process safety** — the pausable timer still settles from its own timer
  (`onTimeout`, `src/acp.ts:73-76`), never by awaiting `close`; `killTree` is
  called on every reject path including the new stdin-closed-during-permission
  one (`src/acp.ts:138-141`).
- **Path / input / argv safety** — permission replies ride `promptUser` (stdin),
  never argv; the agent's own option names/titles are only ever echoed to the
  terminal/log, never used to build a path or shell command.
- **State durability** — unaffected; `nodeId`/`promptUser` are per-call wiring,
  never persisted, correctly so (nothing a resume needs).
- **Comments** — the D5 pause rationale comment (`src/acp.ts:65-68`) states the
  non-obvious *why* (queued time counts too); no stale `Stryker disable` left
  over from the plain-`setTimeout` version it replaced.

### 3. Code quality

Short, single-purpose helpers (`armTimer`/`clearTimer`/`pauseTimer`/`resumeTimer`/
`onTimeout`); `parsePermissionReply` mirrors `parse`'s shape without duplicating
its approve/reject-vocabulary logic (deliberately stricter — numbers only, per
task-4). No magic numbers, no `console.log`/debug leftovers, no commented-out
code. No TODOs without an issue.

### 4. CLI & workflow surface

- Terminal output: see findings 1 and 2 above — the numbered-menu rendering
  itself is right (matches `SPEC.md`'s example), but it is shown twice per
  request.
- `sao validate` is unaffected by this slice (permission prompts are a `run`-time,
  not `validate`-time, concern — correctly out of scope here).
- YAML surface: no new keys.
- Both runners: `@s-no-new-prompts-for-claude-codex` confirms claude/codex never
  call `promptUser` — verified by spawning both as real stub binaries with stdin
  closed and asserting the run still succeeds.

### 5. Docs parity

`SPEC.md` (new "Permission requests" subsection, step 7 invariant note) and
`README.md` (opencode bullet: prompt rendering, shared queue, timeout exclusion)
are both in this slice's diff, and both are *accurate to the intended design* —
which is exactly how finding 1 above was caught: the docs' own example output
doesn't match what the shipped code actually prints.

### Findings

1. **[cli-ux] `resolved`** — `src/acp.ts:130,136,147`. A permission request
   printed twice on the live terminal (once via the log-echo path, once via the
   actual prompt). Fixed: `requestPermission` no longer calls `req.onOutput?.()`
   for the request/menu text or the "selected: …" confirmation — the interactive
   `promptUser` message is now the only rendering, matching the gate node's own
   prompt (`executeGate` in `src/engine.ts`), which likewise never mirrors its
   question into the node log. `onOutput` still carries the turn's real message
   content, untouched. Test: `tests/gate-permission.test.ts`'s
   `@s-permission-prompt-numbered` strengthened to assert the request/menu/
   selection text never reaches `onOutput`.
2. **[cli-ux] `resolved`** — `src/gate.ts:58-63`. `stdinClosedError`'s hint text
   didn't mention permission prompts even though it now fires for them. Fixed:
   the hint now reads "gates, interactive loops, and permission prompts need an
   interactive terminal (or piped replies, one line per prompt)". Test:
   `tests/cli.test.ts`'s `@s-permission-stdin-closed-fails` strengthened to
   assert the hint contains "permission prompts".

---

## Slice S4 — Sessions & MCP passthrough (task-6, task-7) — 2026-08-08

**Verdict: CHANGES_REQUESTED** → `docs/features/add-acp-and-opencode/review-slice.md`

### Diff reviewed

`git diff d0b1c33..649fc05` (S3 review-fix → S4): `src/acp.ts`, `src/engine.ts`,
`src/runners/opencode.ts`, `src/runners/types.ts`, `SPEC.md`, `README.md`,
`docs/features/add-acp-and-opencode/{task-6,task-7,tdd}.md`, and tests
`tests/acp.test.ts`, `tests/engine-acp.test.ts`, `tests/opencode.test.ts`.

### 1. Correctness against the contract

All 9 `@s` scenarios owned by task-6/task-7 have a test that bites:

- `@s-fresh-context-true-new-session`, `@s-fresh-context-false-loads-session`
  (`tests/acp.test.ts`) assert `session/new` vs. `session/load` is called with
  the right id via an echoed session-event string the double records — a broken
  branch would fail either assertion. Scoped correctly at the `runAcpTurn`
  level, not a full loop run: the per-iteration `resumeSessionId` wiring
  (`src/engine.ts:919,945,950-951`, the "resume fidelity (M3)" mechanism) is
  pre-existing, already exercised generically for claude before this slice —
  confirmed by grep, `engine.ts` has no diff on those lines in this slice.
- `@s-lost-session-warns-and-continues` and its unlabeled sibling ("a process
  that dies while loading a session still fails the node") together prove the
  scope's required distinction: a `session/load` JSON-RPC error warns and
  retries with `session/new`, but a process death during the same load still
  rejects the turn (`err.message` asserted to not contain "lost session").
- `@s-session-id-persisted` (`tests/opencode.test.ts`) runs a real `runWorkflow`
  end to end against a stub binary and asserts `state.nodes["a"].sessionId` —
  the one scenario that needed the full state-persistence path, and it uses it.
- `@s-mcp-forwarded-to-session-new`, `@s-no-mcp-key-no-forwarding` assert the
  exact `mcpServers` array shape reaching `session/new` (both stdio
  `command`/`args`/`env` and remote `url`/`type`/`headers` forms), cross-checked
  against `node_modules/@zed-industries/agent-client-protocol`'s `McpServer`
  type by the S1 review precedent's method.
- `@s-mcp-unsupported-transport-preflight` bites at both the engine
  (`tests/engine-acp.test.ts`, a `mockAcpRunner` that throws when
  `needs.mcpTransports` includes `"http"`) and the real-handshake level
  (`tests/opencode.test.ts`, `agentCapabilities.mcpCapabilities` toggled true/
  false) — the "no node executes" half of the scenario is covered by the
  existing `existsSync(join(dir, ".sao"))` pattern already established in S2.
- `@s-allowed-tools-warns-ignored`, `@s-permission-mode-noop` assert the exact
  warning string appears / the string `"permission_mode"` never appears in
  `onOutput`, matching the codex-precedent wording task-7 calls for.
- No scope creep: grepped the diff for `permission_mode`/`allowedTools` reads —
  `ignoredAcpSettings` (`src/acp.ts:39-43`) only ever inspects `allowedTools`;
  `permissionMode` is read nowhere in `src/acp.ts`, matching D4's silent no-op.

### 2. Repo rules

- **Minimalism** — no new dependency. `RunnerNeeds.mcpTransports` is the
  minimal shape task-7 calls for. One duplication issue, below (finding 1).
- **Layering** — `src/runners/opencode.ts` still only delegates to `src/acp.ts`;
  `src/engine.ts`'s new `neededMcpTransports`/`readMcpServersRecord` stay
  self-contained (no new import of `src/acp.ts` from `engine.ts`, which would
  be an odd coupling of generic preflight code to one runner's wire format) —
  but see finding 1 for the cost of that independence.
- **Node target** — `node:fs`'s `readFileSync` only; no Bun-only API.
- **Process safety** — unaffected; the per-turn spawn/settle/timeout shape from
  prior slices is untouched by this diff.
- **Path / input / argv safety** — `mcpConfigPath` is sao's own already-resolved,
  already-JSON-validated path (`src/parser.ts:66-79`) or the per-run generated
  copy (`src/engine.ts:250-252`), never user-controlled at this point; MCP
  server `command`/`args`/`env`/`url`/`headers` values ride the ACP JSON-RPC
  payload, never argv or a shell string.
- **State durability** — unaffected; `sessionId` continues to ride the existing
  per-node field, exactly as task-6.md's scope requires ("no state-shape
  change").
- **Comments** — the task-6 lost-session comment (`src/acp.ts:224-231`) states
  the non-obvious *why* (a transport failure must not be swallowed as a lost
  session); the task-7 forwarder comment (`src/acp.ts:64-68`) accurately states
  sao does no env/template expansion, matching the existing MCP rule.

One duplication survives:

1. **[quality] `open`** — `src/acp.ts:70-73` (`loadAcpMcpServers`) and
   `src/engine.ts:670-672` (`readMcpServersRecord`). Both functions are the
   identical three lines — `JSON.parse(readFileSync(path, "utf8")) as {
   mcpServers?: Record<string, unknown> }`, then `?? {}` — reading the *same*
   `.mcp.json`-shaped file's `mcpServers` key. Worse, this is the **third**
   place that reads and parses this exact file: `src/parser.ts:71-78` already
   does `readFileSync` + `JSON.parse(mcpRaw)` on the identical path at
   workflow-load time purely to validate it's JSON, then discards the parsed
   result (only the raw string was needed for the validation, and even that
   result is thrown away once the `try` succeeds). So an immutable,
   already-validated config file gets parsed once to validate, a second time
   in `engine.ts` at preflight to extract transport kinds, and a third time in
   `acp.ts` on every single `runAcpTurn` call (i.e., once per loop iteration)
   to build the forwarded `mcpServers` payload — with two of those three sites
   hand-rolling the identical unwrap snippet instead of sharing it. This is a
   real "no duplication" violation (rubric §3), not a stylistic nit: a future
   change to the `.mcp.json` shape (e.g., adding a new server field, or
   changing the `mcpServers` key name) has three call sites to update in
   lockstep, and nothing enforces that. The natural fix is for
   `src/parser.ts` to keep the object it already parsed at line 76
   (`mcpServers = JSON.parse(mcpRaw)`) instead of discarding it — it currently
   only assigns `mcpServers` for the *inline* form (line 89), leaving the
   *path* form's already-parsed data on the floor. With that, `engine.ts`'s
   `neededMcpTransports` could read `workflow.mcpServers` directly for both
   forms and `readMcpServersRecord` could be deleted entirely; `src/acp.ts`'s
   per-turn read is the one genuinely necessary site, since it operates on
   `req.mcpConfigPath` (the runtime, possibly per-run-generated copy) rather
   than the static `Workflow` object. Fix the `parser.ts`/`engine.ts` pair; the
   `acp.ts` read stands.

### 3. Code quality

Aside from finding 1: short, single-purpose functions (`ignoredAcpSettings`,
`nameValuePairs`, `toMcpServer`, `neededMcpTransports`); no magic numbers; no
`console.log`/debug leftovers; no commented-out code; no TODO without an issue.
`ignoredAcpSettings` mirrors `ignoredCodexSettings`'s existing shape without
duplicating its codex-specific list.

### 4. CLI & workflow surface

- Terminal output: the `allowed_tools`-ignored and lost-session warnings use
  the same `⚠ <cmd> …` glyph/voice as the existing codex warning
  (`src/runners/codex.ts:155`) and the existing lost-session precedent voice —
  consistent, plain text, no ANSI-only signal, readable under `NO_COLOR`/piped
  output (unchanged mechanism from prior slices).
- Error messages: the MCP-transport preflight error names both the agent and
  the transport (`"opencode does not support the ${transport} MCP transport"`
  + a hint naming the offending `mcp:` server), matching the session-resume
  capability-gap message's shape from S2.
- `sao validate` catches the MCP-transport gap at preflight time, per
  `@s-mcp-unsupported-transport-preflight` — same mechanism task 3 already
  wired into `validate`/`run`/`resume`/`--dry-run`, no new validation path.
- YAML surface: no new keys; `mcp:` and `allowed_tools`/`permission_mode` are
  pre-existing keys, now honored/ignored per D4 for the ACP runner family.
- Both runners: claude/codex are untouched by this diff (`git diff` shows no
  changes to `src/runners/claude.ts` or `src/runners/codex.ts`); the new
  `RunnerNeeds.mcpTransports` field is optional and both existing `preflight`s
  ignore it, matching `@s-existing-runners-unaffected`'s precedent from S2.

### 5. Docs parity

`SPEC.md` (sessions map to `session/new`/`session/load` + lost-session warn-and-
continue in the ACP adapter paragraph; the MCP-servers-and-tool-allowlists v1
note extended three-way; the preflight step's capability list extended to
mention the MCP-transport gap) and `README.md` (opencode bullet: session
sentence, mcp/allowed_tools/permission_mode three-way summary, transport-gap
sentence) are both in this slice's diff and match the shipped behavior — no
overclaiming beyond what's implemented, and the wording task-6.md/task-7.md
asked for ("parallel to the claude/codex entries") is what landed.

### Findings

1. **[quality] `resolved`** — `src/acp.ts:70-73`, `src/engine.ts:670-672`,
   `src/parser.ts:75-79`. The same `.mcp.json`-shaped file is read and
   `JSON.parse`d three times across three files — once to validate at parse
   time (result discarded), once more in `engine.ts` to extract MCP transport
   kinds, and again in `acp.ts` on every turn to build the forwarded payload —
   with the `engine.ts`/`acp.ts` pair duplicating the identical three-line
   unwrap snippet. See analysis above. Fixed: `src/parser.ts`'s path-form
   branch now keeps the parsed object (`mcpServers = parsedMcp.mcpServers ??
   {}`) instead of discarding it after the JSON-validity check, so it is
   populated for both the inline and path forms. `src/engine.ts`'s
   `neededMcpTransports` now reads `workflow.mcpServers` directly and
   `readMcpServersRecord` is deleted. Since `mcpServers` is no longer
   inline-only, the run-dir mcp.json write guard was tightened from
   `mcpServers !== undefined` to `mcpConfigPath === undefined && mcpServers !==
   undefined`, so a path-form workflow (which always has `mcpConfigPath` set)
   is never mistaken for inline. `src/acp.ts`'s per-turn read is unchanged, as
   recommended. No new test was needed: `tests/engine-m2.test.ts`'s "inline
   mcp: is serialized to the run dir and passed to every AI execution" and
   "mcp: as a file path is resolved and passed through untouched", plus
   `tests/engine-acp.test.ts`'s "workflow mcp: servers given as a path are read
   for the same transport check as inline servers", already pinned both
   branches and stayed green through the refactor. Full suite green (723
   pass), `bun run typecheck` and `bun run build` clean.
