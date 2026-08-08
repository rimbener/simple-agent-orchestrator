# Spec — ACP client + opencode runner

Framing: [`user-story.md`](./user-story.md) · Contract:
[`gherkin-scenarios.md`](./gherkin-scenarios.md) · Work: [`tasks.md`](./tasks.md).

## Summary

sao gains one **Agent Client Protocol** client, with `opencode` as the first
registry entry on it. Streaming, sessions, capabilities and permissions come from
the protocol, so the next ACP agent is a registry entry plus a launch command.

## Surfaces touched

- **New:** `src/acp.ts` (the one protocol client) and `src/runners/opencode.ts`
  (registry entry).
- **`Runner`:** `preflight` gains the workflow's *needs* and may be async;
  `supportsSessionResume` stays for claude/codex, superseded for ACP by the
  handshake. **`src/engine.ts`:** runner-environment preflight leaves
  `preflightAiConfigs` for an awaited `preflightRunnerEnvironments`, once per runner.
  **`src/gate.ts`:** permission prompts reuse `promptOnTerminal`'s queue — no
  second stdin path. **CLI:** `run`/`resume`/`validate`/`--dry-run` all handshake,
  no new flags.
- **Unchanged:** YAML schema (`runner:` is free-form, validated by registry lookup)
  and `state.json` (session ids reuse the per-node `sessionId`) — in-flight runs
  resume unaffected, config hash untouched. **Dependencies:** four → five, adding
  `@zed-industries/agent-client-protocol` (D1).

## Error contract — invariants; per-case behavior is the `@s` scenarios

- **Preflight → run `failed` before any side effect:** missing binary (+ install
  hint), a non-ACP binary, an unadvertised capability the workflow needs, an `mcp:`
  transport the agent lacks — capability messages name **both** agent and capability.
- **Run time → node `failed`:** `stopReason: refusal` even on a clean exit; a
  permission request with stdin closed, never auto-approved.
- **Warn and continue:** a session gone on resume (Note 6), `allowed_tools` (codex
  precedent); `permission_mode` is a silent no-op.

## Resolved decisions

1. **D1 — The transport is the official `@zed-industries/agent-client-protocol`
   package**, a fifth runtime dependency. The package *is* the protocol definition,
   so drift is tracked upstream rather than by hand. This departs from `SPEC.md`'s
   locked four-dependency line, so it was the human's call — approved at the gate
   (story Note 7).
2. **D2 — Capabilities come from a real `initialize` handshake at preflight**, not
   a static table, which can lie and re-imposes the per-agent cost this feature
   deletes. So preflight is async and `sao validate` spawns the agent too.
3. **D3 — Permission prompts render the agent's own options as a numbered menu**,
   returning the chosen `optionId`: `[a]pprove/[r]eject` would discard "allow for
   this session", and interpreting agent-defined options is per-agent knowledge sao
   must not hold.
4. **D4 — `mcp:` is forwarded natively** via `session/new`'s `mcpServers` — ACP has
   a first-class slot, so every ACP agent gets claude-level passthrough free.
   `allowed_tools` has no ACP equivalent; `permission_mode` is claude-only and
   subsumed by the permission flow.
5. **D5 — The node timeout clock pauses** while a permission prompt is outstanding
   *or queued* — the story's determinism criterion, else one human's deliberation
   kills an unrelated node.
6. **D6 — `output` is the whole turn's assistant text**, thoughts and tool-call
   updates excluded: ACP marks no message boundary, so a "final message" heuristic
   can drop a sentinel emitted before a last tool call.
7. **D7 — opencode's ACP launch command is `opencode acp`** (approved at the gate).
   Unverified against a real CLI here, so task-2 confirms it and corrects the one
   string if it differs — a wrong value fails at preflight, visibly, not silently.

## Non-goals

- No YAML/CLI surface for pointing sao at an arbitrary agent binary — the
  dynamic-plugin-loading non-goal stands (Note 2).
- No non-blocking / auto-approve permission mode (Note 4); no sao-side permission
  memory or allowlist from `allowed_tools`; no change to claude or codex behavior.
- Discarded: hand-rolled JSON-RPC client (D1); static capability table (D2);
  approve/reject collapse (D3); warn-and-ignore `mcp:` (D4).
