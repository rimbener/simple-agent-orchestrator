# TDD log — ACP client + opencode runner

## Slice S1 — ACP transport & opencode runner (task-1, task-2)

`runAcpTurn(launch, req)` spawns fresh per turn, drives `initialize` →
`session/new` → `session/prompt` via `ClientSideConnection` + `ndJsonStream`.
`opencodeRunner` is name + launch command (`opencode acp`, D7 confirmed) +
delegation to `runAcpTurn`; preflight reuses `findExecutableOnPath`.

@s → test map (`tests/acp.test.ts` unless noted):
- `@s-acp-stream-and-output` → "streams live text and captures the whole turn as output"
- `@s-acp-output-excludes-thoughts` → "reasoning and tool-call updates stay out of output and the stream"
- `@s-acp-sentinel-ends-loop` → "successive turns each return their own isolated output"
- `@s-acp-refusal-fails-node` → "a refusal stop reason fails the turn even on a clean exit"
- `@s-acp-timeout-kills` → "a hung turn times out, kills the process, and rejects naming the timeout"
- `@s-opencode-missing-binary-preflight`, `@s-opencode-agent-system-prompt`,
  `@s-opencode-runner-selectable` → `tests/opencode.test.ts`
- `@s-unknown-runner-lists-opencode` → `tests/runners.test.ts`

Gate: `bun test` (673 pass), typecheck, build green. Docs: `SPEC.md`/`README.md`
(AI execution row, adapter description, five-dependency line, Runners section).

## Slice S2 — Capability preflight (task-3)

`Runner.preflight` takes `RunnerNeeds` and may return a promise.
`preflightAiConfigs` stays sync; a new awaited `preflightRunnerEnvironments`
does binary/handshake checks, once per distinct runner. `src/acp.ts` gained
`runAcpHandshake` (spawn, `initialize`, kill, return capabilities).

@s → test map (`tests/engine-acp.test.ts` + `tests/opencode.test.ts` unless noted):
`@s-capability-gap-preflight`, `@s-capability-present-passes`,
`@s-validate-performs-handshake`, `@s-handshake-once-per-runner`,
`@s-handshake-failure-preflight`, `@s-existing-runners-unaffected`.

Review fixes (both `resolved` in `review-slice.md`): `runAcpHandshake` had no
timeout → gave it the same timer-based settle as `runAcpTurn`
(`DEFAULT_HANDSHAKE_TIMEOUT_SEC`); `opencodeRunner.preflight`'s handshake-failure
catch discarded the real error → folds `err.message` into the `SaoError`.

Gate: `bun test` (687 pass), typecheck, build green. Docs: `SPEC.md` (execution
semantics step 2), `README.md` (`validate`, `fresh_context: false`, opencode).

## Slice S3 — Permission prompts (task-4, task-5)

**task-4** — `session/request_permission` → numbered terminal prompt.
`gate.ts` gained `parsePermissionReply(reply, optionCount)` (bare number in
range, else `invalid`) alongside `parseGateReply`/`parseLoopReply`.
`RunnerRequest`/`NodeExecContext` gained `nodeId` + `promptUser` (threaded
engine → nodes.ts → runner, at all three `executeAiNode` call sites: plain AI
node, loop `prompt`, loop `steps` AI step). `acp.ts`'s `requestPermission`
renders `[nodeId] permission requested: <title>` + a numbered menu, loops on
`parsePermissionReply` until valid (nothing sent to the agent meanwhile), logs
the request/choice via `onOutput`, and — on a `promptUser` rejection (stdin
closed) — settles the whole turn with that same `SaoError`, never auto-approving.

@s → test map:
- `@s-permission-prompt-numbered`, `@s-permission-invalid-reply-reasks` →
  `tests/gate-permission.test.ts` (hand-rolled ACP double + fake `promptUser`)
- `@s-permission-stdin-closed-fails`, `@s-permission-serialized-with-gates` →
  `tests/cli.test.ts` (spawned CLI, stub `opencode` binary on PATH, real stdin;
  serialization ordering proven via a 200ms send-delay in the double so the
  near-instant gate prompt reliably enqueues first)
- `@s-no-new-prompts-for-claude-codex` → `tests/cli.test.ts` (stub claude+codex
  binaries, stdin closed, run still succeeds — they never call `promptUser`)
- Plumbing (untagged): `tests/nodes.test.ts`, `tests/engine-acp.test.ts` assert
  `nodeId`/`promptUser` reach the runner's request.

Pitfall hit and fixed, not silenced: `spawnSync` in `tests/cli.test.ts` does
**not** pick up a `process.env.PATH` mutation made earlier in the same process
unless `env: process.env` is passed explicitly (a real `opencode`/`claude`/
`codex` on the dev machine's PATH was winning the race otherwise) — every
PATH-stubbed spawn in that file now passes it.

**task-5** — the timeout clock pauses for a permission prompt (D5). Replaced
the flat `setTimeout` in `runAcpTurn` with a pausable one (`remainingMs` +
`armTimer`/`pauseTimer`/`resumeTimer`, tracking elapsed via `Date.now()`);
`requestPermission` pauses before its ask-loop and resumes in a `finally`, so
queued time counts too (pause happens before `promptUser` is even called, not
when it starts being answered).

@s → test map: `@s-timeout-paused-during-prompt`, `@s-timeout-paused-while-queued`
→ `tests/acp.test.ts` (extended `DOUBLE_SCRIPT` with `config.requestPermission`;
real short timers, no fake-clock injection — matches the existing timeout
tests' real-wall-clock style).

Gate: `bun test` (706 pass), typecheck, build green. Manual CLI smoke (real
stub binaries, not just doubles): stdin-closed request fails naming
"interactive terminal"; a `1` reply approves and the node succeeds. Docs:
`SPEC.md` (new "Permission requests" subsection under Gate semantics, step 7
invariant note), `README.md` (opencode bullet: prompt rendering, shared queue,
timeout exclusion).

Review fixes (both `resolved` in `review-slice.md`): a permission request
printed twice on the terminal (once via `onOutput`'s log-echo, once via the
actual `promptUser` prompt) → dropped the `onOutput` calls in
`requestPermission`, matching `executeGate`'s precedent of never mirroring its
own prompt text into the node log; `stdinClosedError`'s hint didn't name
permission prompts as a caller → reworded it to cover all three. Tests:
`tests/gate-permission.test.ts` asserts the request/selection text never
reaches `onOutput`; `tests/cli.test.ts`'s `@s-permission-stdin-closed-fails`
asserts the hint mentions "permission prompts".

Gate: `bun test` (706 pass), typecheck, build green.
