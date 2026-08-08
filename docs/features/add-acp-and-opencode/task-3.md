---
id: 3
title: Async runner-environment preflight driven by the ACP handshake
slice: S2 — Capability preflight
status: todo
scenarios:
  - "@s-capability-gap-preflight"
  - "@s-capability-present-passes"
  - "@s-validate-performs-handshake"
  - "@s-handshake-once-per-runner"
  - "@s-handshake-failure-preflight"
  - "@s-existing-runners-unaffected"
paths:
  - src/runners/types.ts
  - src/runners/opencode.ts
  - src/engine.ts
  - src/cli.ts
  - tests/engine-acp.test.ts
  - tests/engine-m2.test.ts
  - tests/engine-m4.test.ts
  - SPEC.md
  - README.md
---

# Task 3 — capability preflight

Replace the static capability boolean with the real `initialize` handshake for ACP
runners (spec decision D2), without disturbing claude or codex.

## Scope

- **`Runner` interface** (`src/runners/types.ts`): `preflight` takes the workflow's
  *needs* (at minimum: does any node require session resume; which MCP transports
  are declared — task 7 consumes the latter) and may return a promise.
  `supportsSessionResume` stays as the static path for claude and codex; ACP
  runners supersede it via the handshake.
- **Split the preflight in `src/engine.ts`.** `preflightAiConfigs` stays
  **synchronous** — configs, agent resolution, template checks, and computing the
  needs — and a new awaited `preflightRunnerEnvironments` performs binary and
  handshake checks. Keep the existing "once per distinct runner" guarantee
  (`tests/engine-m2.test.ts` pins it); the handshake process must be terminated
  when preflight ends and must not be inherited by the run.
- **`src/runners/opencode.ts`:** `preflight` spawns the agent through `src/acp.ts`,
  sends `initialize`, and compares `agentCapabilities` against the needs. A gap
  throws a `SaoError` naming **both** the agent and the missing capability
  (e.g. session loading for `fresh_context: false`). A binary that fails to
  handshake throws a distinct, actionable `SaoError`.
- **Call sites:** `runWorkflow`, `formatDryRun` (`--dry-run`), `sao resume`, and
  `sao validate` in `src/cli.ts` all await it — validate/run parity, so a capability
  gap surfaces without a run.
- Failures here happen **before any side effect**: no run directory, worktree or
  branch. This is the same ordering the existing bad-runner preflight tests assert.

## Regression guard

claude and codex must attempt no handshake and keep their current behavior,
including codex's existing `fresh_context: false` rejection message and its "checked
against the effective runner" `--runner codex` case.

## Docs (part of this slice)

- `SPEC.md`: execution-semantics step 2 — preflight now includes the ACP capability
  handshake; note that ACP capability comes from the handshake rather than a static
  declaration.
- `README.md`: the `sao validate` description gains the capability check.
