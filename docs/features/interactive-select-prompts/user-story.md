# Choose an answer from a list instead of memorizing reply letters

**As a** developer running `sao`
**I want** the run's terminal prompts to present their answers as a list I can move
through and pick from
**so that** I can answer a gate, a loop iteration, or an agent's permission request
by looking at my options and choosing one, instead of recalling which letter or
number means what and typing it blind.

## Context

Every place a run pauses for a human today asks for a typed reply against a
vocabulary the human has to know in advance:

- Gate nodes and interactive-loop iterations print
  `[a]pprove / [r]eject / or type feedback`, and the accepted words differ between
  the two: a plain gate treats `y`/`yes`/`n`/`no` as verdicts, an interactive loop
  deliberately does not (there, "yes" is an answer to the agent's question and flows
  through as feedback).
- An ACP runner's permission request renders the agent's own options as a numbered
  menu and accepts only a bare number, re-asking on anything else.

So the three pause points that share one terminal queue each speak a different reply
dialect, none of it visible at the moment of answering. The request is that the human
move between the available answers and pick one.

Surfaces touched, coarsely: the CLI's terminal interaction and the internals behind
it (the shared prompt queue in `src/gate.ts`, the gate and interactive-loop pauses in
`src/engine.ts`, the permission prompt in `src/acp.ts`). No YAML schema surface, no
runner-interface surface — a workflow author writes the same YAML before and after.
Distribution is touched: the human wants this to work on macOS, Linux, **and
Windows**, and `package.json` currently declares `"os": ["darwin", "linux"]`, so
`sao` cannot be installed on Windows at all today.

**Collisions with `SPEC.md` — named so the call is knowing, and the human's answer
is recorded under Notes:**

1. `SPEC.md` § *Gate semantics* locks the prompt as the literal string
   `[a]pprove / [r]eject / or type feedback`, and § *Permission requests (ACP
   runners)* locks the rendering as "the agent's **own** options as a numbered menu
   (`1. Allow`, `2. Deny`, …)". This story changes both renderings, so `SPEC.md`
   must be amended rather than merely implemented against.
2. `SPEC.md` § *Loops* locks the narrower verdict vocabulary for interactive loops
   as a deliberate decision, because those pauses are conversations. Picking a
   verdict from a list sidesteps the ambiguity the narrow vocabulary exists to
   prevent — but only for a human at a real terminal. The distinction still has to
   hold wherever replies arrive as typed lines.
3. `SPEC.md` § *Decisions (locked)* fixes Distribution at `engines: node >= 20`. The
   library the human has already chosen requires `node >= 20.12`, which tightens
   that floor.
4. § *Decisions (locked)* fixes Interface as "Pure CLI, live progress in terminal".
   A list the human moves through is still a terminal CLI prompt, not a dashboard,
   and the v1 non-goals (web UI, chat adapters) are untouched — noted only so nobody
   later reads this as a TUI.

The behavior this must not disturb is the reason those pauses are careful today:
`SPEC.md` requires that with no interactive terminal a paused node **fails** the way
a gate does and is never auto-approved, and that replies may arrive piped one line
per prompt. The suite exercises exactly that, feeding gate replies to a spawned CLI
over a pipe.

## Acceptance criteria

- At an interactive terminal, a gate node presents approve, reject, and give-feedback
  as a list; the human moves the selection between them and confirms one, without
  typing a letter. Choosing give-feedback then collects the feedback text.
- At an interactive terminal, an interactive-loop iteration presents the same three
  answers the same way, and an ACP permission request presents the agent's own
  options as the list, one entry per option.
- The verdict reached by picking from the list is the same verdict the typed letter
  produced: approve continues, reject halts the run as `rejected` and `sao resume`
  re-asks, feedback is stored as `nodes.<id>.output` and the run continues.
- A permission choice sends back the `optionId` of the option the human picked,
  verbatim, and nothing is sent to the agent until a choice is made.
- With stdin **not** an interactive terminal, every one of the three pauses still
  accepts replies as typed lines in today's vocabulary — including the interactive
  loop's narrower verdict set — so existing piped-reply usage keeps working
  unchanged.
- With stdin closed or exhausted, a pause still fails the node with the existing
  error rather than hanging or exiting `0`; a run can never report success because a
  prompt was never answered.
- Two concurrent branches still cannot interleave prompts: at most one pause owns the
  terminal at a time, each naming the node it belongs to, and a node's `timeout`
  still excludes time spent waiting on or queued behind a prompt.
- `sao` installs on Windows, and the list prompt is usable in a Windows terminal.
- `SPEC.md` is amended in the same change, so the binding design document describes
  the shipped behavior rather than the replaced behavior. Every passage the four
  collisions above name is updated: § *Gate semantics* no longer states the prompt as
  the literal `[a]pprove / [r]eject / or type feedback`; § *Permission requests (ACP
  runners)* no longer states the rendering as a numbered menu; § *Loops* states where
  the interactive-loop verdict vocabulary still applies and where picking from a list
  replaces it; and the § *Decisions (locked)* Distribution row states the raised node
  floor. Both the terminal path and the typed-line path are described, including that
  a pause with no interactive terminal still fails and is never auto-approved.
- `README.md`, as the user-facing reference, no longer instructs the reader to answer
  these pauses by typing a letter or a number at an interactive terminal.
- No regression in the repo's verify gate: `format` → `lint` → `typecheck` → `test`
  all pass, and the mutation suite holds its score.

## Notes

Decisions the human has already made — do not re-ask:

- **Library: `@clack/prompts`.** Chosen over `@inquirer/select` and over a
  hand-rolled `node:readline` implementation, on the strength of a research pass run
  before this story: it bundles to ~50 KB through `bun build --target node`, has four
  pure-JS dependencies and no native bindings, needs `node >= 20.12`, and ships both
  the list prompt and the follow-up text prompt the feedback answer needs.
- **Scope: all three pause points** — gate nodes, interactive-loop iterations, and the
  ACP permission menu — in one change, sharing one prompt helper. Not gates alone.
- **Amending `SPEC.md` is in scope, not a follow-up.** The four collisions above are
  not obstacles to route around: the document is binding, so the change that alters
  these prompts is the change that updates it, in the same PR. Trusting the code over
  the prose is the repo's rule for reading a stale document, not a licence to leave
  one behind.
- **Windows packaging: yes.** Drop `"os": ["darwin", "linux"]` from `package.json`.
  The human's call, made knowing that the rest of the CLI on Windows — git worktree
  handling, the agent CLIs sao spawns — is untested there; this story only claims the
  install and the prompt.

Facts established by that same research pass, carried here so they are not
rediscovered as surprises:

- The chosen library, and every comparable one, **hangs and exits `0`** when stdin is
  not a TTY — the exact false-success failure that `src/gate.ts`'s readline machinery
  is commented to prevent. A list prompt is therefore only reachable when stdin is an
  interactive terminal; the existing line reader remains the other path. This is why
  the criteria above pin both paths.
- The library accepts injected input/output streams and was driven to a correct
  answer over a plain in-memory stream pair with no TTY, so the new prompt is
  testable in-process.
- `src/gate.ts` holds a process-lifetime readline interface with a `line` listener on
  stdin; a list prompt is a second consumer of the same stream. Reconciling those two
  is `spec_partner`'s to design, not settled here.
