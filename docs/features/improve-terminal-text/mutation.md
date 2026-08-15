# Mutation Testing: improve-terminal-text

## Score

- **Overall**: 100.00% (2769 killed, 0 survivors, 0 no-coverage, 0 errors)
- **Based on covered code**: 100.00%

## Files in scope

- src/runners/claude.ts
- src/runners/codex.ts
- src/runners/opencode.ts
- src/runners/types.ts
- src/acp.ts
- src/agents.ts
- src/engine.ts
- src/errors.ts
- src/gate.ts
- src/nodes.ts
- src/options.ts
- src/parser.ts
- src/procs.ts
- src/render.ts
- src/runs.ts
- src/schema.ts
- src/state.ts
- src/template.ts
- src/worktree.ts

## Summary

All 2,769 mutants across the changed files were killed. Zero survivors, zero uncovered code. The test suite achieves 100% mutation coverage on every changed file.

| File | Killed | Timeout | Survived | No-coverage | Errors |
|------|--------|---------|----------|------------|--------|
| runners (total) | 450 | 40 | 0 | 0 | 0 |
| acp.ts | 199 | 94 | 0 | 0 | 0 |
| agents.ts | 25 | 97 | 0 | 0 | 0 |
| engine.ts | 1117 | 48 | 0 | 0 | 0 |
| errors.ts | 13 | 2 | 0 | 0 | 0 |
| gate.ts | 127 | 31 | 0 | 0 | 0 |
| nodes.ts | 72 | 14 | 0 | 0 | 0 |
| options.ts | 12 | 16 | 0 | 0 | 0 |
| parser.ts | 223 | 145 | 0 | 0 | 0 |
| procs.ts | 27 | 4 | 0 | 0 | 0 |
| render.ts | 49 | 34 | 0 | 0 | 0 |
| runs.ts | 17 | 218 | 0 | 0 | 0 |
| schema.ts | 60 | 0 | 0 | 0 | 0 |
| state.ts | 173 | 87 | 0 | 0 | 0 |
| template.ts | 34 | 28 | 0 | 0 | 0 |
| worktree.ts | 171 | 114 | 0 | 0 | 0 |

**Verdict: PASS** — 100% killed, zero no-coverage mutants.
