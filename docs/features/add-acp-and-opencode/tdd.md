# TDD log — ACP client + opencode runner

## Slice S1 — ACP transport & opencode runner (task-1, task-2)

@s → test (`tests/acp.test.ts` unless noted): `@s-acp-stream-and-output`,
`@s-acp-output-excludes-thoughts`, `@s-acp-sentinel-ends-loop`,
`@s-acp-refusal-fails-node`, `@s-acp-timeout-kills`;
`@s-opencode-missing-binary-preflight`, `@s-opencode-agent-system-prompt`,
`@s-opencode-runner-selectable` → `tests/opencode.test.ts`;
`@s-unknown-runner-lists-opencode` → `tests/runners.test.ts`.

Gate: `bun test` (673 pass), typecheck, build green.

## Slice S2 — Capability preflight (task-3)

@s → test (`tests/engine-acp.test.ts` + `tests/opencode.test.ts`):
`@s-capability-gap-preflight`, `@s-capability-present-passes`,
`@s-validate-performs-handshake`, `@s-handshake-once-per-runner`,
`@s-handshake-failure-preflight`, `@s-existing-runners-unaffected`.

Review fixes (`resolved`): handshake had no timeout → pausable-timer settle;
preflight's handshake-failure catch discarded the real error → folds it in.

Gate: `bun test` (687 pass), typecheck, build green.

## Slice S3 — Permission prompts (task-4, task-5)

@s → test:
- `@s-permission-prompt-numbered`, `@s-permission-invalid-reply-reasks` →
  `tests/gate-permission.test.ts`
- `@s-permission-stdin-closed-fails`, `@s-permission-serialized-with-gates` →
  `tests/cli.test.ts`
- `@s-no-new-prompts-for-claude-codex` → `tests/cli.test.ts`
- `@s-timeout-paused-during-prompt`, `@s-timeout-paused-while-queued` →
  `tests/acp.test.ts`

Review fixes (`resolved`): permission request was double-printed (log echo +
prompt) → dropped the log echo; stdin-closed hint didn't name permission
prompts → reworded.

Gate: `bun test` (706 pass), typecheck, build green.

## Slice S4 — Sessions & MCP passthrough (task-6, task-7)

@s → test (`tests/acp.test.ts` unless noted):
- `@s-fresh-context-false-loads-session`, `@s-fresh-context-true-new-session`,
  `@s-lost-session-warns-and-continues`
- `@s-session-id-persisted` → `tests/opencode.test.ts`
- `@s-mcp-forwarded-to-session-new`, `@s-no-mcp-key-no-forwarding`,
  `@s-allowed-tools-warns-ignored`, `@s-permission-mode-noop`
- `@s-mcp-unsupported-transport-preflight` → `tests/engine-acp.test.ts` +
  `tests/opencode.test.ts`

Review fix (`resolved`): `.mcp.json` was parsed 3x (parser/engine/acp) →
`parser.ts` keeps the parsed `mcpServers` for the path form too; `engine.ts`
reads it directly; only the per-turn read in `acp.ts` remains.

Gate: `bun test` (723 pass), typecheck, build green.

## Mutation kill pass

`bunx stryker run --force` (cli.ts exclusion re-applied). Two mutants judged
genuinely equivalent, reproduced by hand before disabling:

- `engine.ts:638-640` — `configs.get(node.id)?.runner` + `if (runner)` guard:
  the parser rejects `fresh_context: false` on a steps loop without a
  prompt-level config, so `configs.get(node.id)` is always defined for a
  workflow that passed `loadWorkflow`; the `?.`/guard only protects hand-built
  workflows that bypass the parser. `// Stryker disable next-line` on each.
- `nodes.ts:102` — `if (timer) clearTimeout(timer)`: `clearTimeout(undefined)`
  is a no-op, so the guard is unobservable. `// Stryker disable next-line`.
- `runners/opencode.ts:23` — `runAcpHandshake(LAUNCH, { cwd: process.cwd() })`:
  `child_process.spawn` already defaults `cwd` to `process.cwd()`, so the key
  is redundant. `// Stryker disable next-line`.

Remaining survivors killed by strengthening/adding tests (no `src/` defect):
- `opencode.test.ts` — asserted the exact `.hint` string (not just `.message`)
  for the fresh_context/handshake/mcp-transport preflight errors; added
  sse-only-capability-passes, http-only-capability-rejects-sse, and
  no-mcpCapabilities-at-all (http and sse) preflight cases.
- `engine-acp.test.ts` — added a fresh-context-true loop asserting
  `needsSessionResume` stays `false`; a malformed-`mcpServers`-entries case
  (null/string/no-url/bad-url survives to just the valid `sse` one); a
  genuinely-`undefined` (not merely absent) server value skipped without
  throwing.

Gate: `bun test` (730 pass), typecheck, build green. `mutation.md`: 0
survived, 100.00% on every changed file (`engine.ts`, `nodes.ts`,
`runners/opencode.ts`); `acp.ts`'s no-coverage mutants are pre-existing
unreachable subprocess error paths, untouched by this pass.
