# Tasks — ACP client + opencode runner

Spec: [`spec.md`](./spec.md) · Contract: [`gherkin-scenarios.md`](./gherkin-scenarios.md)

Four vertical slices. Each is independently green and exercisable end to end through
the `sao` CLI, and each carries its own `SPEC.md` / `README.md` update — there is no
trailing docs task.

| Slice | Task | Title | Scenarios |
| --- | --- | --- | --- |
| **S1 — ACP transport & opencode runner** | [task-1](./task-1.md) | ACP client module: spawn, handshake, prompt turn, update stream | 5 |
| | [task-2](./task-2.md) | opencode registry entry, system prompt, binary preflight, docs | 4 |
| **S2 — Capability preflight** | [task-3](./task-3.md) | Async runner-environment preflight driven by the handshake | 6 |
| **S3 — Permission prompts** | [task-4](./task-4.md) | `session/request_permission` → numbered terminal prompt | 5 |
| | [task-5](./task-5.md) | Pausable node timeout across human waits | 2 |
| **S4 — Sessions & MCP passthrough** | [task-6](./task-6.md) | Session lifecycle, resume, lost-session recovery | 4 |
| | [task-7](./task-7.md) | `mcp:` forwarding, transport capability gap, ignored settings | 5 |

**Slice order.** S1 → S2 → S3 → S4. S1 makes `runner: opencode` work end to end;
S2 makes wrong configurations fail before side effects; S3 adds the human in the
loop; S4 completes parity on sessions and MCP.
