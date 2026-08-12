# AGENTS.md

`sao` — a YAML workflow engine for AI coding agents. TypeScript, developed with Bun but **src must stay Node-compatible** (no Bun-only APIs; published to npm, `engines: node >= 20`). Entry: `src/cli.ts` → built to `dist/cli.js`.

## Commands

```bash
bun install
bun test                          # all tests (bun's built-in test runner)
bun test tests/engine.test.ts     # single file
bun test -t "partial name"        # single test by name
bun run typecheck                 # tsc on BOTH tsconfig.json and tsconfig.test.json
bun run lint                      # biome check src tests (use lint:fix to autofix)
bun run format                    # biome format src tests (use format:fix to autofix)
bun run build                     # bun build src/cli.ts --outdir dist --target node
bun run bootstrap                 # typecheck && test && build (pre-pack gate)
bun run dev -- run examples/hello.yaml "task"   # run the CLI from source
bunx stryker run                  # mutation testing — slow; suite holds a 100% score
```

Verify order after changes: `format` → `lint` → `typecheck` → `test`. Note `typecheck` covers tests too via `tsconfig.test.json`; plain `tsc --noEmit` alone misses test files.

## Constraints that are easy to miss

- `SPEC.md` is the binding design document; `README.md` is the user-facing reference. When prose conflicts with code/config, trust the code.
- `@zed-industries/agent-client-protocol` is patched via bun `patchedDependencies` (`patches/`) — it fixes an upstream `session_set_model`/`session_set_mode` bug. Don't drop the patch entry; re-apply/re-check it when upgrading that dep.
- TS config is `strict` + `noUncheckedIndexedAccess`, `types: ["bun"]` only (no auto `@types/*`).
- Biome: 2-space, double quotes, line width 120, imports auto-organized. Lint covers `src` and `tests` only.
- `src/cli.ts` is exercised only via spawned subprocesses, so it's excluded from mutation coverage by design (`stryker.conf.mjs`) — don't "fix" that exclusion.

## Testing quirks

- No real agent CLIs needed: runner tests put fake `claude`/`codex` executables first on `PATH`. Never assume `claude`/`codex`/`opencode` exist on the dev machine.
- Tests spawn real subprocesses and temp dirs; nothing external (no services, no network) is required.
- `test:orchestrator` = `bun test --only-failures` (rerun failures only), not a separate suite.

## Repo layout notes

- `.sao/` — sao's own run state (worktrees, logs, state.json). Gitignored runtime data; never edit or commit.
- `.agents/agents/*.md` — sao agent personas consumed by the dogfooding workflow `workflows/sao-features-orchestrator/` (`.claude/agents/` mirrors them). They are product fixtures, not editor/agent tooling config.
- `examples/jira-orchestrator.yaml` and `examples/ticket-orchestrator.yaml` are deliberately gitignored.
- `reports/` (stryker incremental state, mutation HTML) is gitignored.

## Git conventions

- Conventional Commits (`type(scope): subject`, lowercase imperative); common scopes: `cli`, `engine`, `schema`, `parser`, `template`, `nodes`, `state`, `worktree`, `gate`, `runners`, `examples`, `agents`.
- Never commit directly to `main` — create a topic branch first.
- Never add AI co-author / "Generated with" trailers. Full rules: `.claude/skills/commit/SKILL.md`.
