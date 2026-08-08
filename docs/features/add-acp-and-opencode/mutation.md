# Mutation Testing Report: add-acp-and-opencode

## Summary

**Mutation Score: 98.70%** (100% killed of covered code)

- **Killed:** 1585
- **Timeout:** 231
- **Survived:** 0
- **No Coverage:** 24
- **Errors:** 0

## Files in Scope

| File | Score | Killed | Timeout | Survived | No Coverage |
|------|-------|--------|---------|----------|-------------|
| src/runners/opencode.ts | 100.00% | 44 | 0 | 0 | 0 |
| src/runners/types.ts | 100.00% | 16 | 0 | 0 | 0 |
| src/engine.ts | 100.00% | 822 | 146 | 0 | 0 |
| src/gate.ts | 100.00% | 47 | 15 | 0 | 0 |
| src/nodes.ts | 100.00% | 85 | 1 | 0 | 0 |
| src/parser.ts | 100.00% | 363 | 5 | 0 | 0 |
| src/schema.ts | 100.00% | 60 | 0 | 0 | 0 |
| src/acp.ts | 89.83% | 148 | 64 | 0 | 24 |

## No-Coverage Mutants (src/acp.ts)

The 24 no-coverage mutants are all in `src/acp.ts`, located in error-handling paths that spawn child processes and resource-cleanup blocks that are unreachable through the test suite. These are process-level operations (e.g., `child.on("error")`, `killTree(child)` in catch blocks) that only execute during actual subprocess failures, not covered by the mocked test harness.

## Verdict

✅ **PASS** → `docs/features/add-acp-and-opencode/mutation.md`

100% of covered code is killed by tests. All 1585 mutations that executed under the test suite were killed; 231 timed out (expected for delay mutations), and 24 had no coverage (uncovered error paths in ACP subprocess handling).
