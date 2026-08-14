---
id: task-1
title: "src/render.ts: markdown subset renderer + marker stripping"
slice: "1 — the block at an interactive-loop pause"
scenarios:
  - "@s-render-emphasis"
  - "@s-render-headings-lists"
  - "@s-render-fenced-code"
  - "@s-render-passthrough"
  - "@s-render-no-color"
  - "@s-strip-options-block"
  - "@s-strip-options-unclosed"
  - "@s-strip-promise-any"
  - "@s-strip-reports-signal-names"
status: done
paths:
  - src/render.ts
  - src/options.ts
  - tests/render.test.ts
---

A new leaf module, pure and total: string in, string out, no I/O, no throw. It is
the whole of decision D1 and D6's stripping half.

Two exported functions, one entry point:

- **strip** — removes every well-formed `<options>…</options>` pair and every
  `<promise>NAME</promise>` token, and reports the promise names it removed so
  task-3 can warn on an unexpected one. Reuse the `<options>` pattern rather than
  copying it: export the existing regex from `src/options.ts` (`options.ts:13`) and
  import it here, so the display can never diverge from what the picker consumes. An
  opening `<options>` with no closing tag matches nothing and stays as text.
- **render** — the markdown subset, styled with `picocolors` (already a dependency,
  already honours `NO_COLOR`): ATX headings, `**bold**` / `*italic*` /
  `` `inline code` ``, fenced code blocks, `-` and `1.` list items, blockquotes,
  `---` rules. Everything else — tables, nested lists, reference links, raw HTML —
  passes through byte-for-byte. A fenced block's body is never markdown-interpreted.
- The single entry point the callers use composes the two and returns the block text
  plus the stripped signal names.

Notes for the implementer:

- No wrapping and no indentation of the caller's lines: `@clack/prompts`' `note()`
  owns wrapping (via `wrap-ansi`) in task-2, and doing it twice would fight.
- Unbalanced emphasis (`**bold` with no closer) is not markdown — leave it literal.
- The repo holds a 100% mutation score; a subset renderer is regex-dense, so expect
  to justify equivalent mutants with `Stryker disable next-line` comments carrying a
  reason, as the surrounding modules do.
