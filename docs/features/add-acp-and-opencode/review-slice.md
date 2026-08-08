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
