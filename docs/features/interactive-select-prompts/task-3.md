---
id: 3
title: ACP permission requests present a list
slice: B — permission prompts
scenarios: [@s-perm-agent-options-listed, @s-perm-selection-sent-verbatim, @s-perm-nothing-sent-until-chosen, @s-perm-piped-index, @s-perm-piped-option-id, @s-perm-piped-invalid-reasks, @s-perm-no-terminal-fails]
status: done
paths: [src/acp.ts, src/gate.ts, tests/acp.test.ts, tests/gate-permission.test.ts, tests/engine-acp.test.ts, SPEC.md, README.md]
---

Rewrite the permission prompt in `requestPermission` (`src/acp.ts:222`).

- Choices are `params.options` mapped one-to-one in the order sent —
  `id: opt.optionId`, `label: opt.name`. Nothing added: no feedback entry, no
  reject entry. The `  1. Allow` menu string is **deleted**.
- `{ kind: "choice" }` → `{ outcome: "selected", optionId }` verbatim, no
  permission memory (`@s-perm-selection-sent-verbatim`).
- `{ kind: "text" }` → `parsePermissionReply(reply, params.options)`, extended
  from a bare 1-based index to *also* accept an exact `optionId`. Anything else
  stays `invalid` → re-ask, nothing sent (`@s-perm-piped-invalid-reasks`).
- Untouched: `pauseTimer()`/`resumeTimer()` around the whole exchange, the
  no-`promptUser` → `cancelled` guard, and the stdin-closed rejection that kills
  the child and fails the node (`@s-perm-no-terminal-fails`).

This task closes the numbered-menu half only. The letter prompt still exists in
`askLoopGate` (`src/engine.ts:1098`) until task 5, so the source-wide assertion
`@s-old-renderings-gone` is owned there, not here.

`requestPermission` has no `collectsText` choice, so it never sees a `from`-tagged
answer — every `{ kind: "text" }` it gets is a piped line.

**Docs:** `SPEC.md` § *Permission requests (ACP runners)* — a navigable list of
the agent's own options, and the typed-line addressing (index or `optionId`).
`README.md`: replace the numbered-menu example in the opencode runner section
(lines 208–217).
