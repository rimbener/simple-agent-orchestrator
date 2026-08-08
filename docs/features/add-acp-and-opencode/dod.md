# Definition of Done — add-acp-and-opencode

## Verdict

✅ **PASS** → all dimensions verified, no open blockers or majors, mutation threshold met (98.70%, 0 survived)

---

## Checklist

| Dimension | Evidence |
| --- | --- |
| **Functionality** | All 31 `@s` tags from gherkin-scenarios.md have test coverage (`@s-*` test tags verified in tests/acp.test.ts, tests/opencode.test.ts, tests/engine-acp.test.ts, tests/gate-permission.test.ts, tests/cli.test.ts); `bun test` green: 730 pass, 0 fail |
| **Code quality** | No console.log/TODO/commented-out code in src/acp.ts, src/runners/opencode.ts, src/engine.ts, src/gate.ts, src/nodes.ts, src/parser.ts, src/schema.ts, src/cli.ts (checked via grep); every `SaoError` call carries a `hint` argument; timer pause for permissions justified by D5, handshake logic by D2 |
| **Architecture & minimalism** | Layering verified: acp.ts imports from `./gate`, `./procs`, `./runners/types` only (no upward imports to engine.ts/nodes.ts); opencode runner is one file in src/runners/, registered in REGISTRY (src/runners/types.ts:62-66); one new runtime dependency `@zed-industries/agent-client-protocol` documented in spec D1; YAML schema and state.json untouched |
| **CLI & workflow surface** | No new flags (opencode is runner name only); `bun run dev -- validate examples/hello.yaml` confirms validate still works on existing workflows; SPEC.md sections added: "Agent Client Protocol (ACP)", "Capability preflight", "Permission requests (ACP runners)", "Sessions and resume", plus architecture notes; README.md sections added: opencode runner example, behavior parity notes |
| **Security** | Fixed argv: opencode runner launches with args `["acp"]` (src/runners/opencode.ts:7), never a runtime value; prompts transit over ACP JSON-RPC `requestPermission` channel, not argv; children spawned with `detached: true` and `track()`'d immediately (src/acp.ts:94-96, 278-280); `killTree` called in all settle paths (error, timeout, exit, success — src/acp.ts:119, 148, 154, 186, 243, 252, 299, 304, 308, 327); no changes to state.json or committed files |
| **Node-target compatibility** | `Readable.toWeb` and `Writable.toWeb` used in acp.ts (src/acp.ts:108-109, 158-159) are stable Node >= 18 builtins; all node imports use `node:*` format (node:child_process, node:fs, node:stream); `bun run build` compiles to dist/cli.js without error; `engines.node >= 20` in package.json is correct for Readable.toWeb usage |
| **Testing rigor** | tdd.md: 4373 bytes (under 8k limit), four-slice log with @s→test mappings (S1: 8 tags, S2: 6 tags, S3: 8 tags, S4: 9 tags); engine tests inject mock `Runner` object, never spawn real agent CLI (review: "hand-rolled `mockAcpRunner`"); mutation report: 98.70% score, 0 survived mutants, 1585 killed; three `// Stryker disable next-line` suppressions at engine.ts:638-640, nodes.ts:102, runners/opencode.ts:23 each documented with equivalence argument in tdd.md "Mutation kill pass" section |
| **Observability & docs** | No changes to node log directory (.sao/runs/<id>/logs/); no changes to state.json shape (session ids reuse per-node `sessionId` per spec); SPEC.md updated: "Surfaces touched", "Error contract", resolved decisions D1–D7, non-goals; README.md updated: opencode in runner table, system-prompt flow, fresh_context behavior for ACP; both docs consistent with code (LAUNCH const, preflight logic, capability check, permission rendering) |

### Review files (non-empty, findings marked `resolved`)

- `review.md`: 284 lines. Round 1 (full feature): APPROVED, no new findings. Round 2 (mutation kill pass): APPROVED, no new findings, all prior-round findings confirmed still fixed
- `review-spec.md`: 127 lines. Three findings, all resolved; D1 approved at gate
- `review-slice.md`: 627 lines. Slices S1–S4 documented; all findings marked `resolved` (S2: handshake timeout, error fold; S3: double-print, stdin-closed hint; S4: triple-parsed .mcp.json)
- `mutation.md`: 34 lines. PASS verdict, 98.70% score, 0 survived, 24 no-coverage mutants in unreachable subprocess error paths

### Accepted minors

None. All findings in review files are either resolved or not present. No human-accepted deviations recorded in spec.md "Open decisions" section.

---

## Summary

The feature implements one ACP protocol client (`src/acp.ts`), registers `opencode` as the first ACP runner (`src/runners/opencode.ts`), and wires preflight capability checking into the engine and CLI. All 31 gherkin scenarios pass; mutation testing confirms 100% of covered code is killed (98.70% overall score, 0 survivors); all review rounds are APPROVED with no blockers or majors; documentation (SPEC.md, README.md) is current; security and architecture boundaries are intact.

**Ready to merge.**
