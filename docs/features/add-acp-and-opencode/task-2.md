---
id: 2
title: opencode registry entry, system prompt delivery, binary preflight, docs
slice: S1 — ACP transport & opencode runner
status: done
scenarios:
  - "@s-opencode-runner-selectable"
  - "@s-opencode-agent-system-prompt"
  - "@s-opencode-missing-binary-preflight"
  - "@s-unknown-runner-lists-opencode"
paths:
  - src/runners/opencode.ts
  - src/runners/types.ts
  - tests/opencode.test.ts
  - tests/runners.test.ts
  - SPEC.md
  - README.md
---

# Task 2 — opencode runner entry

Make `runner: opencode` a real, selectable runner on top of task 1's client. This
is the task that proves "adding an ACP agent is a registry entry plus a launch
command".

## Scope

- `src/runners/opencode.ts`: a `Runner` whose whole content is its name, its launch
  command, and a delegation to `src/acp.ts`. **No stream parsing, no session logic,
  no error mapping lives here** — if any of it does, the abstraction has leaked and
  belongs in `src/acp.ts` instead. Structure it so a second ACP agent is a sibling
  file of the same shape.
- **Launch command:** `opencode acp` (spec D7). Unverified against a real CLI —
  confirm it against the installed `opencode` and correct this one string if it
  differs.
- Register `opencode` in the `REGISTRY` map in `src/runners/types.ts`, so it works
  identically via a node's `runner:`, workflow `defaults.runner`, agent frontmatter
  and `--runner`, and appears in the `unknown runner` error's available list.
- `preflight` checks the binary is on PATH via the existing `findExecutableOnPath`,
  throwing a `SaoError` with an install hint — before any run directory, worktree or
  branch exists.
- Deliver `RunnerRequest.systemPrompt` (the agent file body) to the agent as its
  system prompt over the protocol.

## Docs (part of this slice)

- `SPEC.md`: add the ACP/opencode adapter beside the claude and codex adapter
  descriptions; update the `AI execution` decision row. Change the dependency list
  from four to five, naming `@zed-industries/agent-client-protocol` and why (D1 —
  the package is the protocol definition).
- `README.md`: add opencode to the runners section and to the `runner:` comment in
  the YAML reference.
