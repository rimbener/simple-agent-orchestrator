# review-slice-6 — Piped replies address a declared option

**Verdict: APPROVED**

Scope reviewed: the slice's own contribution to the shared working-tree diff
(`git diff ca95f34`), isolated to what `tdd-6.md` records as slice 6's work —
`parseLoopReply`'s new `options` parameter and match logic in `src/gate.ts`, its
four `@s-loop-piped-*`-tagged tests in `tests/gate.test.ts` and
`tests/engine-m2.test.ts`, and the piped-reply paragraphs in `SPEC.md` /
`README.md`. No new untracked files (`git status --porcelain` shows none beyond
this slice's own doc files). Everything else touching these same files
(`Choice`/`PromptChoices`/list-prompt plumbing, `parsePermissionReply` id
matching, the windows/source-hygiene `cli.test.ts` additions) belongs to prior
slices already reviewed and is out of scope here.

## 1. Correctness against the contract

- All four `@s` scenarios map to tests that bite:
  - `@s-loop-piped-option-id` — `tests/gate.test.ts:61-67` (unit) and
    `tests/engine-m2.test.ts` (integration, `postgres` → `feedback: [Use
    Postgres]`): removing the match branch flips the expectation.
  - `@s-loop-piped-verdict-precedence` — `tests/gate.test.ts:69-72` and the
    integration test asserting `calls` stays length 1: this precedence was
    already structural (`parse()` checks verdicts before `parseLoopReply`
    reaches the option-match branch) per `tdd-6.md` cycle 3; kept as a
    regression guard, which is a legitimate reason for a test that doesn't
    currently kill a mutant in the new code.
  - `@s-loop-piped-unsignaled-approve-reasks` / `@s-loop-piped-freeform-is-feedback`
    — correctly retagged onto the two pre-existing `engine-m2.test.ts` cases
    per `tdd-6.md` cycle 4, no duplicated coverage.
- No error paths added (no new `SaoError` in this slice).
- No scope creep: the diff is exactly the `options` param plus its call-site
  wiring (`src/engine.ts:1167` — unchanged per tdd-6 cycle 2, already passing
  `options` from a prior slice) and the doc paragraphs.

## 2. Repo rules

- **Minimalism** — no new dependency, abstraction, or config surface.
  `package.json`/lockfile untouched by this slice.
- **Layering** — `src/gate.ts` importing `type AgentOption` from `./options`
  (a leaf) is a type-only import into a `state`-tier module; no upward import
  introduced.
- **Node target** — no Bun-only API added.
- **Process safety** — n/a, no process/child changes in this slice.
- **Path / input / argv safety** — the new match is a plain string-equality
  check (`option.id === result.text`) against agent-declared, in-memory
  strings; nothing reaches a path, argv, or refspec.
- **State durability** — no state changes.
- **Comments** — the new doc comment on `parseLoopReply` (`src/gate.ts:34-39`)
  states the precedence rationale (a genuine why), not a restatement of the code.

## 3. Code quality

`parseLoopReply` stays short, single-purpose, and reads directly (`src/gate.ts:41-45`).
No duplication, no magic numbers, no debug leftovers.

## 4. CLI & workflow surface

Piped-reply behavior is user-facing (no TTY, e.g. CI or scripted runs), so this
section is not N/A, but the slice adds no new terminal rendering, error message,
or YAML key — it only extends what an existing piped text line can resolve to.
Matching is exact-`id`, never index, consistent with the slice's own stated
rationale (no menu is printed on this path). No `sao validate`-time check applies:
the match target is the agent's own runtime output, not static config. No
runner-specific behavior — the piped path is runner-agnostic already.

## 5. Docs parity

- `SPEC.md` § *Loop semantics* (`SPEC.md:234-241`) — states verdict precedence,
  exact-`id` match (never index), label substitution, and verbatim-feedback
  fallback. Matches the code.
- `README.md` (`README.md:176-180`) — piped-reply paragraph placed beside the
  task-5 `<options>` declaration docs, states the same precedence and exact-`id`
  match at README level for a workflow author scripting replies.

No findings.
