# TDD log — ACP client + opencode runner

## Unblocked (2026-08-08)

Prior attempts were blocked on network access to fetch
`@zed-industries/agent-client-protocol` (see `review-slice.md`). This session has
network access; `bun add @zed-industries/agent-client-protocol` succeeded. Moved
it into `devDependencies` alongside the other four runtime deps, matching this
repo's existing convention (everything is bundled by `bun build`, so the
dependencies/devDependencies split doesn't gate what ships).

## Slice S1 — ACP transport & opencode runner

### task-1 — `src/acp.ts`

Tests drive a hand-rolled ACP agent double (`tests/acp.test.ts`'s `DOUBLE_SCRIPT`)
speaking newline-delimited JSON-RPC directly over stdio — no dependency on the ACP
package on the double side, never the real opencode binary. `runAcpTurn(launch,
req)` spawns fresh per turn (mirrors claude/codex's per-call process lifecycle),
drives `initialize` → `session/new` → `session/prompt` via `ClientSideConnection`
+ `ndJsonStream`, and tears the process down after the turn.

@s → test map:
- `@s-acp-stream-and-output` → "streams live text and captures the whole turn as output"
- `@s-acp-output-excludes-thoughts` → "reasoning and tool-call updates stay out of output and the stream"
- `@s-acp-sentinel-ends-loop` → "successive turns each return their own isolated output"
- `@s-acp-refusal-fails-node` → "a refusal stop reason fails the turn even on a clean exit"
- `@s-acp-timeout-kills` → "a hung turn times out, kills the process, and rejects naming the timeout"

Supporting (untagged) cycles: `composeAcpPrompt` no-op / preamble (mirrors codex's
`composeCodexPrompt`); cwd + env merge-over-`process.env`; system-prompt delivery
via an echo double; a process that dies mid-handshake rejects instead of hanging
(added a `child.on("close", …)` settle path); a command that fails to spawn
rejects (gated the protocol start on the `"spawn"` event, not immediately after
`spawn()`, after a stray "ACP write error" surfaced from writing to a pipe whose
process never launched — fixed, not silenced).

### task-2 — `src/runners/opencode.ts`

Confirmed `opencode acp` against the real installed CLI (D7 — no correction
needed). `opencodeRunner` is name + launch command + delegation to `runAcpTurn`;
`preflight` reuses `findExecutableOnPath`. Registered in `REGISTRY`
(`src/runners/types.ts`).

@s → test map:
- `@s-opencode-missing-binary-preflight` → "preflight throws a SaoError naming the missing binary and an install hint"
- `@s-opencode-agent-system-prompt` → "the agent file body reaches the ACP agent as the system prompt"
- `@s-opencode-runner-selectable` → "the registry resolves opencode and it executes through the ACP client"
- `@s-unknown-runner-lists-opencode` → `tests/runners.test.ts` "unknown runners list what is available, including opencode"

Supporting: name check, preflight-passes, launch-command pin (wrong binary fails
the turn), `getRunner("opencode")` resolution.

## Gate

`bun test` (673 pass), `bun run typecheck`, `bun run build` all green. Manual CLI
check: `sao validate` against a `runner: opencode` workflow passes preflight
(opencode is installed on this machine); an unknown-runner error lists
`claude, codex, opencode`. Docs landed in this slice: `SPEC.md` (AI execution row,
`runner:` comment, ACP/opencode adapter description, directory listing,
five-dependency line) and `README.md` (install prereqs, `runner:` comment,
Runners section).

## Slice S2 — Capability preflight

### task-3 — async runner-environment preflight

`Runner.preflight` now takes `RunnerNeeds` (`{ needsSessionResume }`) and may
return a promise. `preflightAiConfigs` stays sync (config resolution only);
the binary/handshake probing loop moved to a new awaited
`preflightRunnerEnvironments(workflow, configs)`, called once per distinct
runner from `runWorkflow`, `formatDryRun` (now async), and `sao validate`.
`src/acp.ts` gained `runAcpHandshake` (spawn, `initialize`, kill, return
`agentCapabilities` — never a prompt turn) since opencode's capability check
needs the ACP connection but not a full turn. `opencodeRunner.preflight`
checks PATH first (sync fail), then handshakes and compares
`needs.needsSessionResume` against `capabilities.loadSession`.

@s → test map:
- `@s-capability-gap-preflight` → tests/engine-acp.test.ts + tests/opencode.test.ts (mock-runner and real-handshake versions)
- `@s-capability-present-passes` → same two files
- `@s-validate-performs-handshake` → tests/engine-acp.test.ts "the same preflight call validate makes..."
- `@s-handshake-once-per-runner` → tests/engine-acp.test.ts (3 AI nodes, one mock runner, probes===1)
- `@s-handshake-failure-preflight` → tests/engine-acp.test.ts + tests/opencode.test.ts (non-ACP binary on PATH)
- `@s-existing-runners-unaffected` → tests/engine-acp.test.ts test.each(["claude","codex"])

Supporting (untagged): tests/acp.test.ts's `runAcpHandshake` describe block
(resolves capabilities, rejects on early exit, process doesn't outlive the
call); tests/opencode.test.ts's DOUBLE_SCRIPT made `agentCapabilities`
configurable; existing claude/codex/opencode preflight call sites across
tests/runners.test.ts, tests/codex.test.ts, tests/opencode.test.ts updated to
pass a `RunnerNeeds` arg; every `formatDryRun` call site in
tests/engine-m4.test.ts made async.

## Gate

`bun test` (686 pass), `bun run typecheck`, `bun run build` all green. Manual
CLI check: `sao validate` on a `fresh_context: false` + `runner: opencode`
workflow passes (real opencode advertises `loadSession`); with a fake
`opencode` on PATH that exits without speaking ACP, validate fails with
"opencode failed the ACP handshake"; `--dry-run` on a plain opencode node
awaits the handshake and prints the plan. Docs landed: `SPEC.md` (execution
semantics step 2 — ACP capability handshake) and `README.md` (`validate`
description, `fresh_context: false` comment, opencode bullet).
