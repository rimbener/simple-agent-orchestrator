---
id: 6
title: Piped replies address a declared option
slice: C — agent-declared options
scenarios: [@s-loop-piped-option-id, @s-loop-piped-verdict-precedence, @s-loop-piped-unsignaled-approve-reasks, @s-loop-piped-freeform-is-feedback]
status: done
paths: [src/gate.ts, src/engine.ts, tests/gate.test.ts, tests/engine-m2.test.ts, tests/cli.test.ts, SPEC.md, README.md]
---

Close the non-TTY path for agent-declared options: `parseLoopReply` takes the
iteration's options and resolves a line in this fixed precedence. This path sees
only untagged `{ kind: "text" }` answers — a `from`-tagged one came from a list
selection and never reaches here (task 1).

```mermaid
flowchart TD
    L["piped reply line"] --> V{"a / approve / approved<br/>r / reject / rejected?"}
    V -->|"yes"| W["verdict — approve or reject"]
    V -->|"no"| I{"exact match on a<br/>declared option id?"}
    I -->|"yes"| S["feedback = that option's label"]
    I -->|"no"| T["feedback = the line itself"]
    W --> U{"approve on an<br/>unsignaled iteration?"}
    U -->|"yes"| R["warn and ask again"]
    U -->|"no"| E["end the loop / halt the run"]
```

- Verdict words win over an identical option id, so an agent declaring an option
  with id `a` cannot cost the human the loop's exit path
  (`@s-loop-piped-verdict-precedence`).
- Matching is exact on `id` — no index, because no menu is printed for a number
  to refer to, and an index would shift as the agent reorders its list.
- An empty line still re-asks; a non-matching line is feedback, exactly as today
  (`@s-loop-piped-freeform-is-feedback`).

**Docs:** `SPEC.md` § *Loop semantics* — the typed-line path names an option by
its `id`, verdict words take precedence, and no menu is rendered on that path.
`README.md`: beside the declaration docs task 5 adds to the loop example, state
how a piped reply picks a declared option — one line, the option's exact `id` —
and that a verdict word wins a collision. A workflow author scripting replies
into a loop needs this at README level, not only in `SPEC.md`.
