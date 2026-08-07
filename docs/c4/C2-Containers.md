# C2 — Containers

> Level 2 of the C4 model. Zoom into **sao**: the whole system is a single deployable
> container (a Node 20+/Bun CLI published to npm as `simple-agent-orchestrator`). Its
> only "storage" is plain files on the local filesystem — there is no database.

Diagram source: [`C2-Containers.excalidraw`](./C2-Containers.excalidraw) (import in [excalidraw.com](https://excalidraw.com)). Raw elements: [`C2-Containers.json`](./C2-Containers.json).

## Diagram

```mermaid
%%{init: {"themeVariables": {"fontFamily": "Menlo, Monaco, 'Courier New', monospace"}}}%%
flowchart LR
    DEV["**Person**: Developer\nruns CLI · answers gates"] -->|"sao run · resume · validate"| CLI
    CLI["**Container**: sao CLI\nNode 20+/Bun npm package\nno web UI · no DB · no plugins"] -->|"persist after every step"| STORE
    CLI -->|"execute in isolation"| WT
    CLI -->|"prompt (stdin) / stream output"| CL
    CLI -->|"prompt (stdin) / stream output"| CX
    CLI -->|"push branch + draft PR"| GH

    STORE["**Data**: .sao/ run store\nstate.json · logs · mcp.json"]
    WT["**Data**: git worktree\n.sao/worktrees/<id> + branch"]
    CL["**External**: Claude Code CLI"]
    CX["**External**: Codex CLI"]
    GH["**External**: GitHub / gh CLI"]
```

## Containers

| Container | Type | Technology | Responsibilities |
| --- | --- | --- | --- |
| **sao CLI** | Application (CLI) | Node 20+/Bun, `commander`, `yaml`, `zod`, `picocolors` | Parses workflows, schedules nodes, streams output, prompts at gates, persists state, manages worktrees/branches/PRs. |

## Data stores

| Data store | Type | Details |
| --- | --- | --- |
| `.sao/` run store | JSON files on local disk | `.sao/runs/<id>/state.json`, `logs/<node-id>.log`, `mcp.json`; written atomically after every step. |
| git worktree | git checkout | `.sao/worktrees/<id>` on branch `sao/<id>`, cut from the base ref; kept until `sao clean`. |

## External software systems

| System | Purpose |
| --- | --- |
| Claude Code CLI | Default agent runner (`claude -p`). |
| Codex CLI | Second agent runner (`codex exec --json`). |
| GitHub / gh CLI | Optional draft-PR finalization (`--auto-open-pr`). |
