---
id: 6
title: Session lifecycle, resume, and lost-session recovery
slice: S4 — Sessions & MCP passthrough
status: done
scenarios:
  - "@s-fresh-context-false-loads-session"
  - "@s-fresh-context-true-new-session"
  - "@s-session-id-persisted"
  - "@s-lost-session-warns-and-continues"
paths:
  - src/acp.ts
  - src/runners/opencode.ts
  - src/engine.ts
  - tests/acp.test.ts
  - tests/engine-acp.test.ts
  - SPEC.md
  - README.md
---

# Task 6 — sessions and resume

Give ACP nodes the session continuity `fresh_context: false` promises, and make a
vanished session survivable.

## Scope

- No `resumeSessionId` → `session/new`. With one → `session/load`, so the agent
  continues the same conversation.
- Return the session id in `RunnerResult.sessionId`; it rides the **existing**
  per-node `sessionId` field into `state.json`. **No state-shape change**, so no
  compatibility question and no config-hash impact.
- **Lost session (user story Note 6):** when `session/load` fails because the agent
  no longer knows the id, print a warning that prior conversation history was lost,
  start a fresh session, and continue. The run does not halt. Distinguish this from
  a genuine protocol/transport failure, which must still fail the node — do not
  swallow every `session/load` error into a retry.
- `fresh_context: true` (the default) keeps starting a new session per iteration.
- Reaching `session/load` at all is already guaranteed by task 3: an agent that does
  not advertise session loading was rejected at preflight, so this path never runs
  against an incapable agent.

## Docs (part of this slice)

- `SPEC.md`: in the ACP adapter description, record that sessions map to
  `session/new` / `session/load` and that a lost session on resume warns and
  continues rather than halting.
- `README.md`, **Runners** section: extend the `opencode` entry task 2 added with a
  session sentence parallel to the claude ("per-loop session resume") and codex
  ("`fresh_context: false` is a validation error") entries — `fresh_context: false`
  continues one ACP session, and a recorded session the agent no longer knows warns
  that prior conversation history was lost and continues with a fresh one.
