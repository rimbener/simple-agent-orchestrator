---
id: 1
title: List prompt seam, TTY detection, packaging
slice: A — every pause is a list
scenarios: [@s-list-at-terminal, @s-list-no-menu-when-piped, @s-list-stdin-closed-fails, @s-list-serialized-across-branches, @s-list-interrupt, @s-list-longer-than-terminal, @s-windows-installable, @s-windows-prompt-portable]
status: done
paths: [package.json, src/gate.ts, tests/gate.test.ts, tests/gate-stdin.test.ts, tests/cli.test.ts, SPEC.md]
---

Add `@clack/prompts` and widen the injected prompt seam so every pause can offer
choices. No caller changes behavior yet — tasks 2, 3, 5 and 6 move onto it.

**Seam** (in `src/gate.ts`, which already owns the serialization queue):

```ts
export type Choice = { id: string; label: string; description?: string; collectsText?: true };
export type PromptAnswer =
  | { kind: "choice"; id: string }
  | { kind: "text"; text: string; from?: string };
export type PromptUser = (req: { message: string; choices: Choice[] }) => Promise<PromptAnswer>;
```

- One call per pause. A `collectsText` choice runs its follow-up text prompt
  **inside the same queued turn** and resolves `{ kind: "text" }` — so another
  branch's pause can never slot in between a selection and its text entry
  (`@s-list-serialized-across-branches`).
- `from` is that choice's `id`, set **only** when the text follows an explicit
  list selection; the piped line reader leaves it undefined. Callers must not run
  a `from`-tagged answer through any verdict vocabulary — the human already
  disambiguated by picking (spec.md decision 5). It is the one signal that
  separates "typed a line at a closed vocabulary" from "chose to write prose".
- `promptOnTerminal` keeps the existing queue, buffered-line reader and
  `stdinClosedError()` untouched (`@s-list-stdin-closed-fails`).
- Interactive when `process.stdin.isTTY && process.stdout.isTTY` → `@clack/prompts`
  `select` with `maxItems` so a long list scrolls (`@s-list-longer-than-terminal`).
  Otherwise the existing line reader, resolving `{ kind: "text", text: line }`
  and writing **nothing** (`@s-list-no-menu-when-piped`).
- clack's cancel symbol → re-raise `SIGINT` on this process so `src/procs.ts`'s
  existing handler reaps children and exits 130 (`@s-list-interrupt`).

**Packaging** (`@s-windows-installable`): drop the `os` field, raise
`engines.node` to `>=20.12`, add `@clack/prompts` as a dependency.

**Windows** (`@s-windows-prompt-portable`): the prompt path — TTY detection, the
`select`, the follow-up text prompt, the cancel handling — uses no POSIX-only
facility. The one place to check is the Ctrl-C re-raise: `SIGINT` is among the
signals Node emulates for `process.kill` on Windows, so the handler still runs;
no other signal is used. Record the manual smoke check (install from a pack,
answer a gate at a Windows terminal) in `SPEC.md` beside the Distribution row.
No Windows CI job — the guarantee is portability, not per-commit coverage.

**Docs:** `SPEC.md` § *Decisions (locked)* Distribution row (raised node floor,
Windows installable, the manual check) and the Dependencies paragraph in
§ *Project structure*.

Tests: drive the seam in-process over injected non-TTY streams (the story's Notes
confirm clack accepts them); the queue/EOF behavior stays covered by the existing
spawned-CLI tests.
