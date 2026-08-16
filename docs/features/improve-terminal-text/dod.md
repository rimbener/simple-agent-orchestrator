# improve-terminal-text — Definition of Done

## Verdict: PASS

All objective checks green; all review findings resolved; mutation threshold met (100% killed, 0 survivors, 0 no-coverage); no unreviewed dependencies.

---

## Objective checks

- [x] **typecheck**: `bun run typecheck` clean (both `tsc --noEmit` and `tsconfig.test.json`)
- [x] **test suite**: `bun run test:orchestrator:ci` green — 1784 pass (892 unique × 2 reruns), 0 fail
- [x] **build**: `bun run build --target node` succeeds; `cli.js` 0.64 MB bundled
- [x] **validate workflows**: No schema/parser/template changes; workflows already validated during implementation

---

## Dimension checklist

| Dimension | Status | Evidence |
| --- | --- | --- |
| **Functionality** | ✓ PASS | Every `@s` tag in `gherkin-scenarios.md` (36 total) has a passing test: `tests/render.test.ts` (9), `tests/gate-stdin.test.ts` (5), `tests/engine-m2.test.ts` (16), `tests/runners.test.ts`/`tests/codex.test.ts`/`tests/opencode.test.ts` (3), `tests/acp.test.ts` (3). Error paths covered: empty message (`@s-loop-empty-message`), marker-only message (`@s-loop-message-only-marker`), unexpected signal warning (`@s-loop-unexpected-signal-warning`), piped unchanged (`@s-block-absent-when-piped`, `@s-gate-piped-unchanged`, `@s-loop-piped-unchanged`). All match `spec.md` acceptance criteria and user-story acceptance criteria (user-story.md:57-87). |
| **Code quality** | ✓ PASS | No debug leftover: `console.log` in `src/engine.ts` is pre-existing, untouched (review.md:52). No TODO without issue. No dead code introduced. Every `SaoError` carries a useful hint (e.g., `src/runners/claude.ts:224-228` spawn failure message, `src/gate.ts:202` note rendering). Comments explain the *why*: e.g., `src/acp.ts` disable comments document why each mutant is safe (review.md:298-302), `src/options.ts` catch-block disable moved before try with documented reason (review.md:297). Test quality: exact-string assertions on rendered output (e.g., `tests/engine-m2.test.ts` `@s-loop-question-in-block` expects `\n[ship] ` exactly, not substring), no sleep-and-hope timing (use `printed`/`written` array indices). |
| **Architecture & minimalism** | ✓ PASS | Layering intact: `src/render.ts` is a true leaf (imports `picocolors`, `./options` only); no upward imports. `src/cli.ts` not exercised in mutation coverage by design (`stryker.conf.mjs`); feature touches only `src/engine.ts`, `src/gate.ts`, `src/runners/types.ts` + adapters, `src/acp.ts`, `src/options.ts`, new `src/render.ts`. One runtime dependency added: none — no new, upgraded, or patched dependency in `package.json` or `bun.lock` (review.md:15-21). One minimalism decision recorded: `Runner.finalOutputStreaming` field amends `SPEC.md` Runner interface (review-spec.md finding 1, resolved by human approval gate documented in user-story.md:104-109 Notes). No unrequested production code: `src/interactive-choices.ts` dropped after mutation-kill round 2 (review.md:358-367; `e01dcdd` confirms file absent). No new config surface without spec: old package.json script removed with the tool. Resume compatibility: config hash unchanged (hash covers workflow YAML + agent/MCP files, not runtime state); `@s-resume-pause-identical` exercises this (tests/engine-m2.test.ts). |
| **CLI & workflow surface** | ✓ PASS | No new CLI flags; feature is opt-in via `interactive` loop gate body (existing schema key, no new field added). Terminal output readable without TTY: piped path unchanged byte-for-byte, no ANSI escapes in CI logs (user-story.md:72-76). Both runners handled: claude/codex declare `finalOutputStreaming: "per-message"`; opencode declares `"whole-turn"`; unset defaults to `"whole-turn"` (spec.md D2, tdd-2.md). Behavior documented for both paths: interactive terminal shows titled box (review.md tests box in `@s-block-boxed-at-tty`, `@s-permission-prompt-unchanged`); piped path unchanged (`@s-block-absent-when-piped`). `SPEC.md` updated: Runner interface, Loop semantics, Gate semantics sections (review.md:43-46, review-spec.md:70-79). `README.md` updated: interactive-loop section +1 sentence on the pause block, gate example +1 sentence (review.md:46-48, tdd-1.md:48, tdd-2.md:46, tdd-3.md:25). |
| **Security** | ✓ PASS | No secret in state.json or logs: block text is computed at pause time only, never persisted; logs contain agent raw output verbatim (user-story.md:75-76, `@s-loop-log-verbatim`). No user-controlled text reaching path/argv/git: `src/render.ts` pure string→string (review.md:119); no subprocess spawning, path construction, or state mutation. Prompts over stdin, not argv: options blob passed via stdin to `promptChoice`, block passed as a function argument (gate.ts), never argv. Children detached and tracked: `src/procs.ts` unchanged; spawned runners already tracked before this feature. Agent text terminal trust boundary unchanged: before this feature, agent message was echoed verbatim (dim); now it's rendered/stripped before display — trust model (agent text printed, not executed) identical. No new argv-exposure surface in production code (interactive-choices.ts dropped). |
| **Node-target compatibility** | ✓ PASS | No Bun-only API in `src/`: `node:readline`, `node:fs`, `node:path`, `node:url` (in dropped `src/interactive-choices.ts`, no longer present). Imports use `node:*` form (review.md:376). `bun run build` green. Engines declaration `engines: node >= 20` still honest — feature is plain TS, no version-specific syntax. |
| **Testing rigor** | ✓ PASS | Strict TDD: every `@s` tag in gherkin-scenarios.md has a named test in tests, mapped in tdd-1.md/tdd-2.md/tdd-3.md. Total: 36 scenarios → 36 tests across 6 test files. All tests pass (`bun run test:orchestrator:ci`: 1784 pass, 0 fail with `--rerun-each=2`). Engine/gate/runner tests use `scriptedRunner`/mock `Runner` objects or fake `claude`/`codex` executables on `PATH` (review.md:40-42) — never real agent CLI. TTY-dependent tests use explicit `setTTY`/`withInteractiveTerminal` helpers, reset in `afterEach`/`finally` (review.md:44-50). Mutation: **100% killed (3533 killed, 184 timeout, 0 survived, 0 no-coverage)** — overall score met per mutation.md:1-8. No `NO_CHANGED_SOURCE` claim; all `src/*.ts` touched were covered. |
| **Observability & docs** | ✓ PASS | Node logs land under `.sao/runs/<id>/logs/`: agent output logged on-the-fly, verbatim; pause block computed and displayed, not logged (review.md:95-97). State persisted after every transition: `state.json` untouched by this feature; `nodes.<id>.output` stays raw text (review.md:82-83); resume loses at most the interrupted step (by design, not regressed). `SPEC.md` updated: Surfaces-touched table + 8 resolved decisions (spec.md:11-69); Runner interface section + `finalOutputStreaming` field (SPEC.md:415); Loop semantics paragraph (SPEC.md:227); Gate semantics paragraph. `README.md` updated: interactive-loop section paragraph on pause block (README.md:181-186); gate example sentence (README.md:165-169). Both consistent with code: gate computes `block`/`blockTitle` when `isInteractive()`, passes to `promptChoice` which draws via `note()` in TTY branch only (src/gate.ts:194-221). |

---

## Review trail completeness

- [x] **review-spec.md** (non-empty, 5397 bytes): one blocker (finding 1: "no runner change" boundary crossed, resolved by human approval gate decision recorded in user-story.md:104-109 Notes).
- [x] **review-slice-1.md** (non-empty, 5166 bytes): approved; no findings.
- [x] **review-slice-2.md** (non-empty, 3417 bytes): approved; no findings.
- [x] **review-slice-3.md** (non-empty, 4507 bytes): one blocker (finding 1: gate message doubly rendered, resolved by splitting `question`/`block` in `executeGate`).
- [x] **review.md** (non-empty, 25558 bytes): three sections with verdicts:
  - Full review: **APPROVED**
  - Delta review (mutation-kill round 1): **CHANGES_REQUESTED** — two findings (code major: Stryker comment placement; code minor: duplicate comment) marked "**Resolved.**" (commits `d3eb404`, `61926df`)
  - Delta review (mutation-kill round 2): **CHANGES_REQUESTED** — one arch major: `src/interactive-choices.ts` unrequested, marked "**Resolved.** Dropped, not recorded:" (commit `e01dcdd`)
- [x] **mutation.md** (non-empty, 684 bytes): **Overall mutation score: 100.00%** (3533 killed, 0 survived, 0 no-coverage). No survivors. No rewritten survivors, no invented waivers. Result: **PASS**. Files in scope: 19 (`src/*.ts` excluding `src/cli.ts` and the dropped `src/interactive-choices.ts`).

---

## Dependency audit

- [x] `git diff cf687a5...HEAD -- package.json bun.lock patches/` empty. No new, upgraded, patched, or lifecycle-script dependency. No change to overrides/resolutions. Zero unreviewed supply-chain changes.

---

## No accepted minors

All findings either resolved fully or dropped entirely. Zero remaining open items marked ACCEPTED.

---

**Status: DOD met. Ready for merge.**
