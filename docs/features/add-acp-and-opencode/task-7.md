---
id: 7
title: mcp: forwarding, transport capability gap, and ignored settings
slice: S4 — Sessions & MCP passthrough
status: done
scenarios:
  - "@s-mcp-forwarded-to-session-new"
  - "@s-mcp-unsupported-transport-preflight"
  - "@s-no-mcp-key-no-forwarding"
  - "@s-allowed-tools-warns-ignored"
  - "@s-permission-mode-noop"
paths:
  - src/acp.ts
  - src/runners/opencode.ts
  - tests/engine-acp.test.ts
  - tests/opencode.test.ts
  - SPEC.md
  - README.md
---

# Task 7 — MCP passthrough and ignored settings

Close the parity gap: ACP agents get workflow-level MCP servers, and the two
settings ACP has no home for say so plainly (spec decision D4).

## Scope

- **Forward `mcp:`.** Read the `.mcp.json`-shaped file sao already writes to
  `.sao/runs/<id>/mcp.json` (handed over as `RunnerRequest.mcpConfigPath`) and pass
  its servers as `mcpServers` on `session/new`. sao stays a forwarder, not a host —
  it neither expands `${ENV_VAR}` references nor applies `{{...}}` templating, per
  the existing MCP rules.
- **No `mcpConfigPath`** → no servers forwarded; the agent falls back to its own
  discovery, exactly as claude and codex do today.
- **Transport capability gap.** The handshake's MCP capabilities say which transports
  the agent accepts. A workflow declaring one it does not (e.g. a `url:` remote
  server against a stdio-only agent) fails at **preflight** through task 3's needs
  path, with the same message shape as the session-loading gap — naming the agent
  and the unsupported transport. No new mechanism.
- **`allowed_tools`:** printed warning, then ignored — ACP has no allowlist concept
  to map it onto. Follow the codex warning's wording and timing so the two read as
  one convention.
- **`permission_mode`:** silent no-op. It is already documented claude-only, and
  under ACP permission *is* the request/response flow from task 4, so a warning
  would be noise.

## Docs (part of this slice)

- `SPEC.md`: extend the "MCP servers & tool allowlists" v1 note — claude honors both
  keys, codex ignores both with a warning, ACP runners honor `mcp:` natively and
  warn on `allowed_tools`.
- `README.md`: same three-way summary in the runners section.
