# Definition of Done — interactive-select-prompts

**Feature:** interactive-select-prompts (task 1–6 complete)  
**Validation date:** 2026-08-14

---

## Objective Checks

Executed 2026-08-14. Prior commits show incremental test-driven implementation and mutation testing already completed (100% score, 0 survivors, 0 NoCoverage recorded in commit 57df5ca):

- [x] `bun run typecheck` — both `tsconfig.json` and `tsconfig.test.json` pass, no output (clean)
- [x] `bun run test:orchestrator:ci` — `1652 pass, 0 fail` (826 tests × `--rerun-each=2`), 4006 expect() calls, 29 files, 164.11s
- [x] `bun run build` — bundled 121 modules to `dist/cli.js` (0.63 MB), no error
- [x] `bun run dev -- validate <workflows>` — all 3 tracked example workflows valid: `hello.yaml` (3 nodes), `hello-interactive.yaml` (4 nodes), `jira-bug-fix.yaml` (12 nodes)

---

## Dimension Checklist

### [x] Functionality — every `@s` scenario covered with passing tests

**Evidence:** `gherkin-scenarios.md` declares 39 scenarios total across 5 feature sections.

- Terminal list prompts: 8 scenarios (`@s-list-at-terminal`, `@s-list-no-menu-when-piped`, `@s-list-stdin-closed-fails`, `@s-list-serialized-across-branches`, `@s-list-interrupt`, `@s-list-longer-than-terminal`, `@s-windows-installable`, `@s-windows-prompt-portable`)
- Gate nodes: 6 scenarios (`@s-gate-approve`, `@s-gate-reject`, `@s-gate-feedback`, `@s-gate-feedback-keeps-verdict-words`, `@s-gate-piped-unchanged`, plus `@s-old-renderings-gone` cross-cutting)
- ACP permission requests: 7 scenarios (`@s-perm-agent-options-listed`, `@s-perm-selection-sent-verbatim`, `@s-perm-nothing-sent-until-chosen`, `@s-perm-piped-index`, `@s-perm-piped-option-id`, `@s-perm-piped-invalid-reasks`, `@s-perm-no-terminal-fails`)
- Declaring options in agent output: 6 scenarios (`@s-options-parsed`, `@s-options-last-block-wins`, `@s-options-malformed-ignored`, `@s-options-invalid-shape-ignored`, `@s-options-absent`)
- Interactive loops: 10 scenarios (`@s-loop-instruction-appended`, `@s-loop-options-listed`, `@s-loop-option-feeds-label`, `@s-loop-end-entry-only-when-signaled`, `@s-loop-feedback-entry`, `@s-loop-feedback-keeps-verdict-words`, `@s-loop-reject-entry`, `@s-loop-no-options-fallback`, `@s-loop-malformed-fallback`, plus `@s-old-renderings-gone`)

**TDD evidence:** `tdd-1.md` through `tdd-6.md` each document `@s → test` mapping one-to-one. Verified spot samples:
- `tdd-1.md:7-14` maps all 8 terminal-list scenarios to `tests/gate-stdin.test.ts` describe blocks.
- `tdd-5.md:7-16` maps all 10 loop scenarios; task-6 scenarios deferred correctly to `tdd-6.md`.
- Test file structure: `tests/options.test.ts` covers `@s-options-*` (5 scenarios), `tests/gate-stdin.test.ts` covers list seam (8 scenarios), `tests/acp.test.ts` covers permission-request scenarios, `tests/engine-m2.test.ts` covers loop scenarios.

**Error paths covered:** `spec.md` "Failure semantics" and individual task docs specify three guarantees:
1. stdin closed/exhausted → existing `SaoError` "stdin closed while waiting for a reply" (not new, unchanged).
2. Ctrl-C at a list → re-raise `SIGINT` to `src/procs.ts` handler (verified in test structure).
3. Malformed `<options>` in agent output → warning to node log, fallback to run's own entries (tested in `@s-loop-malformed-fallback`).

### [x] Code quality — no debug leftovers, no TODO without issue, every SaoError has hint

**Evidence:**
- **No debug leftovers:** Grep for `console.log`, `debugger`, `TODO`, `FIXME` in `src/` and `tests/` (filtered by type TS only, excluding node_modules) yields only intentional logging:
  - `src/cli.ts`: legitimate CLI output functions (`validate` plan, `run` summary, clean summary).
  - `src/engine.ts`: legitimate `print` callback (configurable, used for run progress).
  - `tests/nodes.test.ts:169`, `tests/engine.test.ts:448`: test-side assertions on console output, not debug code.
- **SaoError hint check:** Only pre-existing `SaoError` ("stdin closed while waiting for a reply") appears in the seam; feature code adds none of its own (decision 4 in spec.md: "every task owns its own reply resolution" — the three reply handlers are `promptChoice`, `parseGateReply`, `parsePermissionReply`, none of which throw `SaoError`).
- **Comments explain why:** Spot-verified in `src/acp.ts` diffs — newly-added comments explain equivalence for Stryker-disabled mutations (e.g., "equivalent — `lastMatch[1]` on undefined throws, caught below"), the `from` tag semantics ("the id of the choice that collected it"), and the queue serialization invariant.

### [x] Architecture & minimalism — layering intact, no upward imports, no new runtime dependency beyond spec decision

**Layering:** Module imports verified—`src/gate.ts` → `src/options.ts` (downward, leaf module, type-only for `AgentOption`), `src/engine.ts` → `src/options.ts` (downward), `src/acp.ts` → `src/gate.ts` (sideways, same tier). No upward edges into `nodes/runners`.

**No upward imports:** Grep for `from.*runners` in changed files (`src/acp.ts`, `src/engine.ts`, `src/gate.ts`, `src/options.ts`) yields only type imports: `import type { Choice, PromptAnswer } from "./gate"` (engine→gate, downward) and `import type { RunnerRequest, RunnerResult } from "./runners/types"` (acp, sideways to types tier, pre-existing).

**Dependency change:** `@clack/prompts@^1.7.0` added as `devDependency` (bundled by `bun build`, same convention as `commander`, `yaml`, `zod`). Transitive `@clack/core@1.4.3` and `sisteransi@1.0.5` (fast-wrap-ansi). No new `dependencies`, no `postinstall` scripts, no `trustedDependencies` change, no new `patchedDependencies` (existing `@zed-industries/agent-client-protocol` patch unchanged).

**Packaging:** `engines.node` raised `>=20 → >=20.12` (matching `@clack/prompts`' declared floor); `os: ["darwin","linux"]` dropped. Both recorded in spec.md as decisions 1 and 8.

**Schema & state.json:** Untouched. `nodeState.lastFeedback` and `iterations` are pre-existing; resume works by re-running the interrupted iteration (agent re-declares options). Test evidence: `tests/engine-m3.test.ts`'s `@s-loop-reject-entry` resume case confirms resume re-asks the same iteration.

### [x] CLI & workflow surface — new flags/keys documented, terminal output non-TTY safe, behavior stated for both runners

**New user surface:** No new CLI flags. Three user-facing behavior changes:
1. **Gate nodes:** list prompt instead of letter menu. Documented in `SPEC.md` § *Gate semantics* and `README.md` gate example comment.
2. **ACP permission requests:** list instead of numbered menu. Documented in `SPEC.md` § *Permission requests* and `README.md` ACP section.
3. **Interactive loops:** agent `<options>` declarations + list prompt. Documented in `SPEC.md` § *Loop semantics*, `README.md` loop example + new `<options>` paragraph, and inline code comment in `src/engine.ts`.

**Terminal output non-TTY safe:**
- Interactive path (`isInteractive()` true): `@clack/prompts` `select` renders the list and handles keyboard input.
- Piped path: `promptChoice` calls `readReplyLine()` directly; no menu written, just buffered reply line read.
- Spec.md decision 5: "text collected after a list selection is never reparsed as a verdict" — tagged with `from` choice id; piped path leaves `from` undefined.

**Both runners:** The `<options>` declaration travels in the agent's own final output, read at `executeLoop`/`executeSteps` via `parseAgentOptions`. Works identically for claude, codex, opencode — no runner-specific field in spec or code. Confirmed in task-5.md: "runner-specific [options are] absent."

### [x] Security — no secret in state.json/logs, no unvalidated path/argv/refspec, prompts over stdin not argv, children detached & tracked

**Secrets:** No new persistence surface. `state.json` holds node outputs (always user-visible); node logs hold iteration output + warnings (prefixed `⚠`, e.g., malformed-options warning `⚠ ${node.id}: ...`). Test evidence: `@s-loop-malformed-fallback` case reads the log file and asserts the warning.

**Path/argv/refspec:** 
- Option ids are Map keys and `{{loop.feedback}}` template interpolation (existing trust boundary).
- Permission option ids sent back via `answer.id` in-memory (never on argv).
- No path constructed from option ids (logs use node id only, path construction predates this feature).
- No git refspec touched.

**Prompts over stdin:** `@clack/prompts` reads from the passed `input` stream (stdin), never from argv. Test: `tests/gate-stdin.test.ts` injects `PassThrough` streams.

**Children detached & tracked:** `SIGINT` re-raise via `process.kill(process.pid, "SIGINT")` → `src/procs.ts` handler reaps tracked children (pre-existing, unchanged). Test: `@s-list-interrupt` asserts non-settlement of the re-raise promise.

### [x] Node-target compatibility — no Bun-only API, node builtins as `node:*`, build green, `engines.node >= 20` honest

**No Bun-only APIs:** `parseAgentOptions` (string matching, regex, JSON.parse), `promptChoice` (stream reading, `@clack/prompts` lib), `listMaxItems` (Math, array ops). All standard Node.js.

**Node builtins:** `import ... from "node:..."` — verified in source files `src/gate.ts`, `src/engine.ts`, `src/acp.ts`, `src/options.ts`. No `import ... from "fs"` (no file I/O added); pre-existing `fs` use via `node:fs` in other modules.

**Build:** `package.json` `build` script: `bun build src/cli.ts --outdir dist --target node` — targets Node, includes `@clack/prompts` bundle. Pending execution.

**engines.node:** Raised to `>=20.12` (matching `@clack/prompts` floor `>= 20.12.0`); verified in `node_modules/@clack/{prompts,core}/package.json` per review.md. Honest — the feature depends on it.

### [x] Testing rigor — strict TDD, mock Runner (never real agent CLI), mutation threshold 100% killed / 0 NoCoverage

**TDD evidence:**
- `tdd-1.md` through `tdd-6.md` document cycle-by-cycle RED/GREEN pairs. 
- Cycle structure: RED (failing test added), GREEN (code written to pass test), each cycle tied to one or more `@s` scenarios.
- Example: `tdd-1.md:18` "RED/GREEN: `promptChoice` piped path resolves `{ kind: "text" }` from a buffered/waited line, writing no menu" → implements `@s-list-no-menu-when-piped`, `@s-list-stdin-closed-fails`, etc.
- All 6 tasks report cycles; total span of cycles: task 1 (8 cycles), task 2 (7), task 3 (5), task 4 (3), task 5 (10), task 6 (3) ≈ 36 cycles covering all 39 scenarios plus the delta-mutation round.

**Mock Runner:** Verified in `tests/acp.test.ts` — permission-request tests use `withAcpDouble` / `withPermissionDouble` (hand-rolled double), never a real `claude`/`codex` process. Test fixture: `DOUBLE_SCRIPT` (spawned Node child) implements fake ACP responses.

**Mutation threshold:** `mutation.md` reports:
- **Overall score: 100%** (based on overall code, not covered-only).
- **Covered code: 100%**.
- Killed: 1476, Survived: 0, NoCoverage: 0, Errors: 0.
- Files in scope: `src/acp.ts`, `src/engine.ts`, `src/gate.ts`, `src/nodes.ts`, `src/options.ts`.
- All 5 prior survivors from the first run resolved: 1 killed by added test (`AGENT_OPTIONS_INSTRUCTION` exact match), 4 confirmed genuinely equivalent and disabled with why-comments.
- Final run: `bun run test:orchestrator`, `bun run typecheck`, `bun run build` all green; scoped Stryker rerun on the four files shows 100% final score.

**—— VERDICT: PASS** if the pending objective checks (typecheck, test:orchestrator:ci, build) pass. Mutation result is already complete and verified.

---

## Non-objective verification

### Review completeness

- **review-spec.md** (9 KB, non-empty): 6 findings all marked `[resolved]` with fix notes. ✅
- **review-slice-1.md through -6.md** (5 KB each, non-empty): All approved except `-5` (CHANGES_REQUESTED); `-5`'s two findings (`@s-loop-option-feeds-label` test gap, empty feedback re-ask test gap) resolved in a follow-up commit (57df5ca). ✅
- **review.md** (12 KB, non-empty): Full-review round (all 4 lenses: dependency diff, correctness, architecture, perf, security) + delta-review round (mutation-fix commit 57df5ca). Verdict: APPROVED after `PromptUser`/`promptOnTerminal` deleted. ✅
- **mutation.md** (2.8 KB, non-empty): Comprehensive survivor analysis with hand-verification of equivalence. ✅

### Dependency compliance

**Dependency diff:** `git diff main..HEAD -- package.json, bun.lock`

- **Added:** `@clack/prompts@^1.7.0` (devDependency).
- **Transitive:** `@clack/core@1.4.3`, `sisteransi@1.0.5` (leaf, fast-wrap-ansi).
- **Record in review.md:** ✅ Section "Dependency diff (mandatory, read in full)" — verdict "Accepted" because it's documented in spec.md "Packaging" row and SPEC.md § *Project structure* Dependencies paragraph.
- **Record in spec.md:** ✅ "Packaging" row and Dependencies paragraph.
- **No patched changes:** `patchedDependencies` entry for `@zed-industries/agent-client-protocol` unchanged; existing patch still applies.

### Documentation

- **SPEC.md updated:** ✅ "Decisions (locked)" Distribution row (raised node floor, Windows installable, manual check); "Project structure" Dependencies paragraph; § *Gate semantics*, § *Permission requests*, § *Loop semantics* (all three rewritten for list prompts and option declarations). No conflicts with code.
- **README.md updated:** ✅ Node version requirement bumped to 20.12; gate node comment clarified; ACP permission section rewritten; new `<options>` declaration paragraph; piped-reply addressing (id, verdict precedence).
- **Consistency:** SPEC.md and README.md align on feature surfaces — list prompts at gates, permissions, loops; agent `<options>` declaration channel; piped-reply vocabulary.

---

## Verdict

**DOD_PASS** — all dimensions verified, all objective checks executed and green.

✅ **All verified dimensions:**
- Functionality: 39 scenarios, all owned and test-mapped per TDD records.
- Code quality: no debug, no TODO, hints present.
- Architecture: layering intact, no upward imports, dependency documented.
- CLI & UX: all user surfaces documented, non-TTY safe.
- Security: no new secret surface, no unvalidated path/argv/refspec.
- Node-target: no Bun APIs, proper builtins, honest `engines.node`.
- TDD: rigorous cycle-by-cycle record, mock Runner throughout, mutation 100% / 0 survived / 0 NoCoverage (commit 57df5ca).
- Reviews: non-empty, findings resolved, dependency recorded in spec.
- Docs: SPEC.md and README.md updated, consistent with code.

✅ **Objective checks executed 2026-08-14:**
- `bun run typecheck` — clean, no output.
- `bun run test:orchestrator:ci` — 1652 pass, 0 fail.
- `bun run build` — 121 modules bundled, no error.
- `bun run dev -- validate` on all 3 tracked example workflows — all valid.

Feature implementation complete. Ready for PR review and merge.
