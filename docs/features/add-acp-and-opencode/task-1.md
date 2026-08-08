---
id: 1
title: ACP client module — spawn, handshake, prompt turn, update stream
slice: S1 — ACP transport & opencode runner
status: todo
scenarios:
  - "@s-acp-stream-and-output"
  - "@s-acp-output-excludes-thoughts"
  - "@s-acp-sentinel-ends-loop"
  - "@s-acp-refusal-fails-node"
  - "@s-acp-timeout-kills"
paths:
  - package.json
  - src/acp.ts
  - src/procs.ts
  - tests/acp.test.ts
---

# Task 1 — ACP client module

Build `src/acp.ts`: the one protocol client every ACP agent goes through.

**Transport (D1, approved):** the official `@zed-industries/agent-client-protocol`
package — a fifth runtime dependency, taking `SPEC.md`'s locked line from four to
five. Add it to `package.json` here. Nothing else hand-rolls JSON-RPC over stdio.

## Scope

- Spawn the agent as a child process over stdio and drive it with the ACP client,
  reusing `src/procs.ts` for tracking, stdin-error swallowing and
  `killTree` so a timeout takes down the whole tree (same lifecycle guarantees the
  claude adapter has).
- Merge `RunnerRequest.env` over `process.env` so `SAO_*` run metadata reaches the
  agent subprocess, and run it in `RunnerRequest.cwd`.
- Expose a turn API: send the prompt, consume `session/update` notifications, and
  resolve with `{ output, sessionId, exitCode }` in `RunnerResult` shape.
- **Output mapping (D6):** `output` is the whole turn's assistant text, joined from
  every `agent_message_chunk`. Thought chunks and tool-call updates go to neither
  `onOutput` nor `output` — matching the claude adapter, which keeps only `text`
  blocks.
- Assistant text streams to `onOutput` as it arrives, so the engine's existing
  node-id prefixing and log append work unchanged.
- A `stopReason` of `refusal` rejects with a `SaoError` even on a clean exit
  (codex's `turn.failed` precedent); `end_turn` and `max_tokens` resolve normally.
- Honor `timeoutSec` by killing the tree and rejecting with a timeout `SaoError`.
  (Task 5 makes this clock pausable; keep the timer behind a small seam so that
  change does not rewrite this module.)
- Node ≥ 20 only — no Bun-only APIs.

## Out of scope

Registry wiring and the `opencode` entry (task 2); the handshake's capability
*checks* (task 3); permission requests (task 4); `session/load` and MCP forwarding
(tasks 6–7). Establish `initialize` and `session/new` here only as far as running a
turn requires.

## Notes

Tests drive a scripted in-process ACP agent double — never the real opencode
binary — so they stay hermetic like the existing engine tests.
