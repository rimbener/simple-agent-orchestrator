---
id: 4
title: Permission requests as numbered terminal prompts
slice: S3 — Permission prompts
status: done
scenarios:
  - "@s-permission-prompt-numbered"
  - "@s-permission-invalid-reply-reasks"
  - "@s-permission-stdin-closed-fails"
  - "@s-permission-serialized-with-gates"
  - "@s-no-new-prompts-for-claude-codex"
paths:
  - src/gate.ts
  - src/acp.ts
  - src/nodes.ts
  - src/engine.ts
  - tests/gate-permission.test.ts
  - tests/cli.test.ts
  - SPEC.md
  - README.md
---

# Task 4 — permission prompts

Wire ACP's `session/request_permission` to the human. This deliberately extends
"only gates pause a run" to AI nodes (user story Note 4).

## Scope

- **Rendering (D3):** show the node id, what the agent wants to do (the tool call's
  title), and the agent's **own** options as a numbered menu. Return the selected
  `optionId` verbatim — sao never interprets option meaning and keeps **no**
  permission memory of its own, so "allow for this session" is remembered
  agent-side.
- **Serialization:** go through the existing `promptOnTerminal` queue in
  `src/gate.ts` (`src/gate.ts:98`). No second stdin mechanism: gates, interactive
  loops and permission prompts share one process-global queue, so at most one owns
  the terminal and the rest wait.
- **Reply parsing:** a new parser alongside `parseGateReply` / `parseLoopReply` that
  accepts only the offered numbers. Anything else re-asks; nothing is sent to the
  agent until a valid choice is made.
- **stdin closed:** raise the same `SaoError` shape a gate does, failing the node
  with the "needs an interactive terminal" hint. Never auto-approve, never hang.
- **Logging:** the request and the chosen option are appended to the node's log via
  the existing `onOutput` path, so `sao logs` shows what was approved.
- The engine must pass the owning node id down to the runner so the prompt can name
  it; ACP-agnostic plumbing only.

## Regression guard

A workflow of claude/codex nodes with no gates must run to completion without ever
prompting — assert it in the spawned-CLI tests.

## Docs (part of this slice)

- `SPEC.md`: a permission-requests subsection under the gate/approval semantics,
  stating that ACP AI nodes can also pause the run and that all prompts serialize on
  one queue; note the invariant change explicitly.
- `README.md`: document the permission prompt and its numbered-option vocabulary.
