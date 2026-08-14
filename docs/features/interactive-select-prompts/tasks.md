# interactive-select-prompts — tasks

Three vertical slices. Each is independently green and exercisable end to end
through the `sao` CLI, and each carries its own `SPEC.md` / `README.md` update.

| # | Task | Slice | Scenarios |
| --- | --- | --- | --- |
| [1](./task-1.md) | List prompt seam, TTY detection, packaging | A — every pause is a list | `@s-list-at-terminal` `@s-list-no-menu-when-piped` `@s-list-stdin-closed-fails` `@s-list-serialized-across-branches` `@s-list-interrupt` `@s-list-longer-than-terminal` `@s-windows-installable` `@s-windows-prompt-portable` |
| [2](./task-2.md) | Gate nodes present a list | A | `@s-gate-approve` `@s-gate-reject` `@s-gate-feedback` `@s-gate-feedback-keeps-verdict-words` `@s-gate-piped-unchanged` |
| [3](./task-3.md) | ACP permission requests present a list | B — permission prompts | `@s-perm-agent-options-listed` `@s-perm-selection-sent-verbatim` `@s-perm-nothing-sent-until-chosen` `@s-perm-piped-index` `@s-perm-piped-option-id` `@s-perm-piped-invalid-reasks` `@s-perm-no-terminal-fails` |
| [4](./task-4.md) | Parse the agent's `<options>` declaration | C — agent-declared options | `@s-options-parsed` `@s-options-last-block-wins` `@s-options-malformed-ignored` `@s-options-invalid-shape-ignored` `@s-options-absent` |
| [5](./task-5.md) | Interactive loops present the agent's options | C | `@s-loop-instruction-appended` `@s-loop-options-listed` `@s-loop-option-feeds-label` `@s-loop-end-entry-only-when-signaled` `@s-loop-feedback-entry` `@s-loop-feedback-keeps-verdict-words` `@s-loop-reject-entry` `@s-loop-no-options-fallback` `@s-loop-malformed-fallback` `@s-old-renderings-gone` |
| [6](./task-6.md) | Piped replies address a declared option | C | `@s-loop-piped-option-id` `@s-loop-piped-verdict-precedence` `@s-loop-piped-unsignaled-approve-reasks` `@s-loop-piped-freeform-is-feedback` |

Slice order is A → B → C. A must land first: tasks 3, 5 and 6 all render through
the seam task 1 introduces. Three sites render an old prompt — the gate letter
menu (task 2), the numbered permission menu (task 3) and the loop letter menu
(task 5) — so the source-wide `@s-old-renderings-gone` assertion sits on task 5,
the last of them, not on an earlier slice where it would still be false.
