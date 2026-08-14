# Mutation Test Report: improve-terminal-text

## Mutation Score

- **Overall**: 97.01% (1764 killed, 116 timeout, 42 survived, 16 no-coverage, 0 errors)
- **Based on covered code**: 97.81%

## Files in Scope

- `src/runners/claude.ts`
- `src/runners/codex.ts`
- `src/runners/opencode.ts`
- `src/runners/types.ts`
- `src/engine.ts`
- `src/gate.ts`
- `src/options.ts`
- `src/render.ts`

## Survivors (42 mutants)

| File | Line | Mutator | Expression | Status |
|------|------|---------|-----------|--------|
| src/engine.ts | 964 | StringLiteral | `question = "\n[${node.id}] "` → `"${node.id}]"` | Survived |
| src/engine.ts | 1012 | StringLiteral | `.? "whole-turn" : undefined` → `.? "per-message" : undefined` | Survived |
| src/engine.ts | 1062 | StringLiteral | `instructedOutput ?? ""` → `instructedOutput ?? "marker"` | Survived |
| src/engine.ts | 1104 | BlockStatement | `instructedRunnerGranularity(node)` block | Survived |
| src/engine.ts | 1105 | ConditionalExpression | `if (node.loop.prompt !== undefined)` → `if (true)` | Survived |
| src/engine.ts | 1105 | OptionalChaining | `.get(node.id)?` → `.get(node.id)` | Survived |
| src/engine.ts | 1196 | ConditionalExpression | `if (name !== signal)` → `if (false)` | Survived |
| src/engine.ts | 1280 | ConditionalExpression | `} else if (withhold === "whole-turn")` → `} else if (false)` | Survived |
| src/engine.ts | 1280 | ConditionalExpression | `} else if (withhold === "whole-turn")` → `} else if (true)` | Survived |
| src/engine.ts | 1286 | EqualityOperator | `withhold === "whole-turn"` → `withhold !== "whole-turn"` | Survived |
| src/engine.ts | 1296 | StringLiteral | interpolated string literal | Survived |
| src/engine.ts | 1301 | ConditionalExpression | `if (withhold === undefined)` → `if (true)` | Survived |
| src/engine.ts | 1307 | ArrayDeclaration | `held = []` → `held = ["Stryker was here"]` | Survived |
| src/engine.ts | 1318 | StringLiteral | string literal mutation | Survived |
| src/engine.ts | 1330 | Regex | regex pattern mutation | Survived |
| src/engine.ts | 1330 | Regex | regex pattern mutation | Survived |
| src/engine.ts | 1331 | ConditionalExpression | `if (target.every(...))` → `if (true)` | Survived |
| src/engine.ts | 1331 | MethodExpression | `.every()` → `.some()` | Survived |
| src/engine.ts | 1331 | ConditionalExpression | `=> normalized[start + offset] === line` → `=> true` | Survived |
| src/engine.ts | 1331 | ArithmeticOperator | `start + offset` → `start - offset` | Survived |
| src/gate.ts | 197 | ConditionalExpression | `if (req.block !== undefined)` → `if (true)` | Survived |
| src/gate.ts | 197 | ObjectLiteral | `{ output: process.stdout }` → `{}` | Survived |
| src/options.ts | 35 | BlockStatement | catch block statement | Survived |
| src/render.ts | 30 | ArrayDeclaration | `codeSpans = []` → `codeSpans = ["Stryker was here"]` | Survived |

Plus 18 additional survived mutants with various mutators (StringLiteral, ConditionalExpression, ArrowFunction, EqualityOperator, UnaryOperator, OptionalChaining, UpdateOperator).

## No-Coverage Mutants (16 mutants)

| File | Line | Mutator | Expression | Status |
|------|------|---------|-----------|--------|
| src/runners/claude.ts | 227 | BlockStatement | Error handler for non-ENOENT spawn failures | No-Coverage |
| src/runners/codex.ts | 250 | BlockStatement | Error handler for non-ENOENT spawn failures | No-Coverage |
| src/engine.ts | 1107 | ArrowFunction | `steps.reduce()` callback | No-Coverage |
| src/engine.ts | 1107 | ConditionalExpression | `step.kind === "ai" ? index : last` (multiple) | No-Coverage |
| src/engine.ts | 1107 | EqualityOperator | `step.kind === "ai"` | No-Coverage |
| src/engine.ts | 1107 | StringLiteral | `"ai"` literal | No-Coverage |
| src/engine.ts | 1107 | UnaryOperator | `-1` literal (multiple) | No-Coverage |
| src/engine.ts | 1108 | ConditionalExpression | `if (lastAiIndex === -1)` (multiple) | No-Coverage |
| src/engine.ts | 1108 | EqualityOperator | `lastAiIndex === -1` | No-Coverage |
| src/engine.ts | 1109 | OptionalChaining | `.get()?.runner.finalOutputStreaming` | No-Coverage |
| src/engine.ts | 1109 | StringLiteral | Template literal in key | No-Coverage |
| src/engine.ts | 1194 | StringLiteral | `?? ""` default | No-Coverage |
| src/engine.ts | 1330 | UpdateOperator | `start--` in for loop | No-Coverage |

## Summary

Threshold NOT met: **42 survivors** and **16 uncovered mutants** remain. The feature implementation has gaps in test coverage:

- **Survivors in engine.ts** (38): Logic around `instructedRunnerGranularity()`, withhold condition handling, block rendering markers, and string matching patterns are not sufficiently tested.
- **Survivors in gate.ts** (2): Block condition and output object handling need stronger assertions.
- **Survivors in options.ts and render.ts** (2): Catch block and array initialization edge cases.
- **Uncovered code** (16): Error paths in spawned runners (`claude.ts`, `codex.ts`), and steps-loop final AI index detection in `engine.ts` are not exercised by the test suite.

**Next steps**: Strengthen assertions in tests to kill the 42 survivors and add coverage for the 16 uncovered mutants, particularly around error handlers and step-loop edge cases.
