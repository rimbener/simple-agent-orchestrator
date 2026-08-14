# improve-terminal-text — slice 2 review

**Verdict: APPROVED**

## Scope reviewed

`git diff` (README.md, SPEC.md, docs/features/improve-terminal-text/task-4.md,
src/engine.ts, src/runners/{types,claude,codex,opencode}.ts,
tests/{engine-m2,codex,opencode,runners}.test.ts) plus the untracked
`docs/features/improve-terminal-text/tdd-2.md`. Cross-checked against
`gherkin-scenarios.md` slice-2 block and `spec.md` (D2, mechanism diagram).

## 1. Correctness against the contract

All 9 slice-2 `@s` scenarios have a concrete test per `tdd-2.md`'s map, and each
one bites — traced the withhold/release mechanics by hand for
`@s-question-appears-once-per-message`, `@s-narration-still-streams`,
`@s-repeated-text-keeps-earlier-copy`, and `@s-withheld-released-on-failure`
against `makeLog`'s `log`/`release`/`flush` and `dropLastOccurrence`; each test's
assertions would fail if the corresponding mechanism were removed. No scope
creep: the diff implements exactly D2 (runner declaration + withhold/release),
nothing else.

`release()` is called once per iteration, before `until_bash`; confirmed
`until_bash` and `interactive: true` are mutually exclusive at parse time
(`src/parser.ts:159-165`), so the "flush() held is only non-empty on the failure
path" comment in `makeLog` (src/engine.ts) is accurate — there's no live code
path where a post-release `log()` call (e.g. from `until_bash`) could populate
`held` while withholding is active.

## 2. Repo rules

- **Minimalism** — no new dependency, no new abstraction beyond one interface
  field (`finalOutputStreaming`) and one `NodeLog` method (`release`). No
  `package.json`/lockfile/`patches/` changes.
- **Layering** — `engine.ts` importing `Runner`/`isInteractive` from
  `runners/types`/`gate.ts` is pre-existing and downward per the documented
  chain. No new runner added; the three existing runner files each gained one
  static field, no dynamic loading.
- **Node target** — no Bun-only API introduced.
- **State durability** — no `state.json`/config-hash change, matches spec's "no
  YAML schema change... nothing persisted."

## 3. Code quality

`instructedRunnerGranularity` mirrors the existing `lastAiIndex` reduce pattern
used by `executeSteps` (same file), so the runner whose declaration governs
withholding is provably the same one that produced `instructedOutput`.
`dropLastOccurrence` is a small, pure, well-named leaf helper. No
`console.log`/debug leftovers, no dead code, no TODOs.

## 4. CLI & workflow surface

No new YAML key, no new CLI flag. `finalOutputStreaming` is an internal
Runner-interface field, not user-facing. The withhold/release path is byte-
identical to prior behaviour whenever `withhold === undefined` (piped, or any
non-interactive-loop log) — verified against the pre-diff `log()`/`flush()`
bodies line by line. Both shipped interactive runners (claude, codex) declare
`per-message`; opencode declares `whole-turn`; an unset/mock runner defaults to
`whole-turn` — no runner silently no-ops a capability it doesn't have.

## 5. Docs parity

`SPEC.md`'s Runner interface and Loop-semantics prose match the implementation
exactly (checked `finalOutputStreaming`'s doc comment in `types.ts` word-for-word
against `SPEC.md`'s). `README.md` gained the one user-facing sentence the change
warrants. Both are in this slice's diff. `task-4.md` status flipped to `done`.

## Findings

None survived review.
