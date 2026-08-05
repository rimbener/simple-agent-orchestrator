# sao — simple agent orchestrator

A minimal YAML workflow engine for AI coding agents. One thing only:
take a YAML file describing a dependency graph of AI/bash/gate nodes and execute it deterministically
against a repo.

## Decisions (locked)


| Dimension        | Decision                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language         | TypeScript                                                                                                                                                                                   |
| Toolchain        | Bun for dev/test; code stays Node-compatible (no Bun-only APIs); published to npm                                                                                                            |
| Distribution     | Global CLI (`npm i -g sao` / `npx sao` / `bun i -g sao`), `engines: node >= 20`                                                                                                              |
| Binary name      | `sao`                                                                                                                                                                                        |
| Interface        | Pure CLI, live progress in terminal                                                                                                                                                          |
| AI execution     | Pluggable `Runner` interface; **claude** (Claude Code headless) and **codex** (Codex CLI exec) adapters in v1                                                                                |
| Workflow model   | Dependency graph via `depends_on`; independent nodes run concurrently                                                                                                                        |
| Loops            | Repeat an AI prompt or a multi-step body (`steps:`) until a sentinel signal or a bash predicate passes; `max_iterations` guard; `fresh_context` per iteration                                                                |
| Approval gates   | Block in the terminal (approve / reject / feedback)                                                                                                                                          |
| Context flow     | Shared worktree files + `{{nodes.<id>.output}}` templating                                                                                                                                   |
| Persistence      | JSON state + per-node logs under `.sao/runs/<id>/`; `sao resume <id>`; no DB                                                                                                                 |
| Inputs           | Declared `inputs:` + `--var k=v` + positional freeform `{{task}}`                                                                                                                            |
| Failure handling | Halt, save state, resumable from the failed node; optional per-node `retries: N`                                                                                                             |
| Isolation        | One git worktree + branch per run, cut from `--base` / workflow `base:` (default HEAD)                                                                                                                                                            |
| On success       | Default: leave the branch and print next steps. Opt-in `--auto-open-pr`: push branch and open a **draft PR via** `gh`, falling back to the default report if `gh` is missing/unauthenticated |
| MCP              | Pass-through, not a host: workflow `mcp:` servers + `allowed_tools` allowlists are forwarded to the runner (claude adapter in v1) |
| Agents           | Optional reusable agent files in `.agents/agents/<name>.md` at the repo root (frontmatter + system prompt), attached to AI/loop nodes via `agent:`                                                               |




## YAML format

```yaml
name: fix-issue
description: Plan, implement, validate, and PR a fix

base: main                # optional — ref the run worktree/branch is cut from (--base wins; default HEAD)

inputs:
  - name: issue          # available as {{issue}}
    required: true

mcp:                      # optional — MCP servers for AI nodes (see MCP section)
  jira:
    command: npx
    args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"]

defaults:                 # per-workflow defaults, overridable per node
  runner: claude          # claude | codex
  model: sonnet           # passed through to the runner, optional
  permission_mode: acceptEdits   # claude adapter only
  allowed_tools: [mcp__jira]     # tool allowlist forwarded to the runner

nodes:
  # ── AI node ────────────────────────────────────────────────
  - id: plan
    prompt: |
      Fetch issue {{issue}} with the jira MCP tools, then explore the codebase
      and write an implementation plan for: {{task}}.
      Save it to plan.md as a markdown checkbox task list.

  # ── Loop node, run by a named agent ───────────────────────
  - id: implement
    depends_on: [plan]
    agent: implementer          # .agents/agents/implementer.md supplies the system prompt
    loop:
      prompt: |
        Read plan.md. Implement the next unchecked task, verify it,
        and check it off in plan.md.
      until: ALL_TASKS_COMPLETE     # sentinel signal name (see Loop semantics)
      max_iterations: 20
      fresh_context: true           # new agent session each iteration

  # ── Bash node ──────────────────────────────────────────────
  - id: test
    depends_on: [implement]
    bash: "npm test"
    retries: 1                      # optional, default 0
    timeout: 600                    # seconds, optional

  # ── Loop with bash predicate instead of sentinel ───────────
  - id: fix-lint
    depends_on: [test]
    loop:
      prompt: "Run the linter and fix every reported problem."
      until_bash: "npm run lint"    # loop exits when this exits 0
      max_iterations: 5

  # ── AI node consuming another node's output ───────────────
  - id: summarize
    depends_on: [fix-lint]
    prompt: |
      Write a PR-ready summary of the changes.
      Implementation notes: {{nodes.implement.output}}

  # ── Gate node ──────────────────────────────────────────────
  - id: ship
    depends_on: [summarize]
    gate:
      message: "Review the diff and summary. Ship it?"
```



### Node types (exactly one of `prompt`, `bash`, `loop`, `gate` per node)

1. **AI node** — `prompt`. Runs once via the node's runner inside the run worktree.
  Optional per-node keys: `agent` (see Agents), `runner`, `model`, `allowed_tools`,
  `timeout`, `retries`.
2. **Bash node** — `bash`. Runs the command with `sh -c` in the worktree. Non-zero exit
  = failure (after `retries`). stdout+stderr captured to the node log; last 100 lines
   become `nodes.<id>.output`.
3. **Loop node** — `loop:` with `prompt` (single-step) **or** `steps:` (multi-step,
   see Loop semantics), plus exactly one of:
  - `until: SIGNAL_NAME` — sentinel self-report (see below)
  - `until_bash: "cmd"` — after each iteration the command runs; exit 0 ends the loop
   Options: `max_iterations` (required, hard cap), `fresh_context` (default `true`,
   single-prompt loops only — steps run as separate sessions), `interactive`
   (default `false`, requires `until:` — see below). Loop nodes also accept
   node-level `agent`, applied to every iteration (individual steps may override
   it), and `retries` — which re-runs the **whole loop from iteration 1**, with
   iteration logs appended across attempts, never truncated.
4. **Gate node** — `gate:` with `message`. Pauses and prompts in the terminal.
   Accepts `timeout` to bound its `when_bash` predicate; the human wait itself is
   never time-boxed.

Any node — and any loop step — may set `when_bash: "cmd"`: the command runs in the
worktree first, and the node/step executes only if it exits 0; otherwise it is marked
`skipped` (dependents treat a skipped node as satisfied). This is the engine's only
conditional mechanism — e.g. re-run a review only when a fix touched production source:
`when_bash: "git diff --name-only $SAO_BASE_REF..HEAD | grep -qvE '\.test\.'"`.

### Agents

An agent is a reusable persona: a markdown file with YAML frontmatter whose body
becomes the system prompt for any node that references it.

```markdown
---
name: implementer
description: Careful implementer that works plan.md one task at a time
model: sonnet                  # optional — same pass-through as defaults.model
runner: claude                 # optional
permission_mode: acceptEdits   # optional, claude adapter only
allowed_tools: [mcp__jira]     # optional — tool allowlist for nodes using this agent
---

You are a meticulous implementer. Work on exactly one task at a time,
run the relevant tests after every change, and never refactor beyond
the scope of the current task.
```

- Reference from AI and loop nodes with `agent: implementer`.
- Resolution: `agent: <name>` → `<repo-root>/.agents/agents/<name>.md`, where
  repo root is the checkout `sao run` was invoked from (resolved at parse time,
  before the worktree exists). A value containing `/` or ending in `.md` is instead
  treated as a path relative to the workflow file (`agent: ./agents/reviewer.md`),
  so agents can also live anywhere.
- Delivery is runner-specific: the claude adapter passes the body via
  `--append-system-prompt`; the codex adapter prepends it to the task prompt as a
  role preamble.
- Setting precedence: node keys > agent frontmatter > workflow `defaults`.
- Agent bodies are used verbatim — no `{{...}}` interpolation in v1, so one agent
  stays reusable across workflows.
- `sao validate` errors on references to missing agent files.



### Loop semantics (sentinel self-report)

`until: ALL_TASKS_COMPLETE` is a *named signal*, not an engine-evaluated expression.
The engine automatically appends to every iteration prompt:

> If and only if the condition "ALL_TASKS_COMPLETE" is fully satisfied, end your
> response with exactly `<promise>ALL_TASKS_COMPLETE</promise>`. Otherwise, do not
> emit that token anywhere.

The engine string-matches the agent's final output for `<promise>NAME</promise>`.
Signal found → loop ends. `max_iterations` reached without signal → node **fails**
(halt + resumable). `fresh_context: true` starts a clean agent session per iteration;
`false` resumes the same session (claude adapter: `--resume <session_id>`).

**Interactive loops** (`interactive: true`): the engine pauses for the human after
**every** iteration. A typed reply feeds the next iteration as `{{loop.feedback}}`;
a bare approve ends the loop, but only on an iteration where the agent emitted the
signal (approving an unsignaled iteration just re-prompts). Combined with
`fresh_context: false` this is a genuine multi-turn conversation — e.g. an agent
interviewing the human one question per iteration until the spec is settled.

**Multi-step loops** (`steps:` instead of `prompt`): each iteration runs the steps
in order. A step is an AI step (`prompt`, with optional `agent`/`runner`/`model`) or
a bash step (`bash`), and may set `when_bash`. A failing step fails the node
(halt + resume). The sentinel instruction is appended to the last AI step's prompt;
`until` / `until_bash` are evaluated once per iteration, at the end. Steps have no
cross-step templating — they communicate through files in the worktree (state on
disk). This is how alternating-agent cycles are modeled:

```yaml
- id: build-slices
  depends_on: [approve-spec]
  loop:
    steps:
      - agent: implementer
        prompt: "Implement the next unfinished slice from tasks.md, TDD-first."
      - agent: reviewer_slice
        prompt: "Review the slice diff against .agents/rules/; write review-slice.md."
      - agent: implementer
        prompt: "Fix every finding in review-slice.md, then commit the slice."
    until: ALL_SLICES_COMPLETE
    max_iterations: 8
```

### Gate semantics

Terminal prompt: `[a]pprove / [r]eject / or type feedback`.

- approve → continue.
- reject → run halts as `rejected`; `sao resume` re-asks the gate.
- feedback → stored as `nodes.<id>.output` so downstream prompts can consume it,
then continues (a gate that must re-do work should be modeled as an interactive loop).



### Templating

Mustache-style `{{...}}` string substitution only — no logic, no filters:

- `{{task}}` — positional freeform text from the CLI
- `{{<input>}}` — declared inputs (from `--var` or `default`)
- `{{nodes.<id>.output}}` — a completed node's captured final output
- `{{loop.feedback}}`, `{{loop.iteration}}` — inside a loop's body only: its prompt,
  its steps (prompts, bash, when_bash), and its until_bash. (`loop.feedback`
  interpolates to the empty string when there is none yet, e.g. on the first
  iteration.) Human feedback is raw text under the same author-owned quoting rules
  as node outputs.
- `{{base}}`, `{{branch}}`, `{{run_id}}` — run metadata (also exported to every bash
  node and runner subprocess as `SAO_BASE_REF`, `SAO_BRANCH`, `SAO_RUN_ID`, `SAO_WORKTREE`)

`sao validate` fails on references to undeclared inputs or unknown/not-yet-run node ids
(i.e. a node may only reference nodes it transitively depends on). It also fails when a
template references an optional input that has no `default:` — such an input may be
unset at run time, so any referenced input must be `required` or carry a default.

Interpolation is raw text substitution. In bash nodes, quote interpolated values —
`{{nodes.<id>.output}}` can contain shell metacharacters (AI output becomes shell text
by design; the workflow author owns that boundary).

### MCP servers & tool allowlists

sao is **not an MCP host** — the runners already are. sao only forwards configuration:

- Workflow-level `mcp:` is either a path to a `.mcp.json`-style file or an inline
  map of server definitions (same shape: `command`/`args`/`env` for stdio, `url`
  for remote). Inline definitions are serialized to `.sao/runs/<id>/mcp.json` and
  handed to the runner. Secrets belong in `${ENV_VAR}` references inside the config
  (expanded by the runner), never inline — sao applies no `{{...}}` templating to
  the `mcp:` block.
- `allowed_tools:` lists tool names/prefixes the runner may use without prompting
  (e.g. `mcp__jira`, `WebSearch`). Settable in `defaults:`, agent frontmatter, and
  per node; standard precedence applies (node > agent > defaults, override — not
  merge).
- With no `mcp:` key, runners fall back to their own discovery (repo `.mcp.json`,
  user-level config) — MCP still works; it's just not pinned by the workflow.
- v1: the **claude adapter** honors both keys (`--mcp-config`, `--allowedTools`);
  the **codex adapter** uses its own global config (`~/.codex/config.toml`) and
  ignores them with a printed warning.

## Runner interface

```ts
export interface Runner {
  name: string;
  run(req: {
    prompt: string;
    systemPrompt?: string;       // agent file body, if the node references one
    cwd: string;                 // the run worktree
    model?: string;
    permissionMode?: string;
    mcpConfigPath?: string;      // workflow mcp: block, serialized to a JSON file
    allowedTools?: string[];
    resumeSessionId?: string;    // continue a prior session (loops with fresh_context: false)
    timeoutSec?: number;
    onOutput?: (chunk: string) => void;   // live streaming to terminal + log
  }): Promise<{
    output: string;              // final result text (sentinel detection runs on this)
    sessionId?: string;
    exitCode: number;
  }>;
}
```

**claude adapter** — spawns `claude -p --output-format stream-json --verbose`
(stream-json requires --verbose), piping the prompt over **stdin** — never argv,
where it would be `ps`-visible, flag-injectable, and ARG_MAX-bounded — with
`--model`, `--permission-mode` (default `acceptEdits`), `--resume`,
`--append-system-prompt <systemPrompt>`, `--mcp-config <mcpConfigPath>`, and
`--allowedTools <allowedTools>` as applicable.
Parses the stream for live output; `result` event supplies `output` + `session_id`.

**codex adapter** — spawns `codex exec <prompt> --json` (non-interactive), prepending
`systemPrompt` to the prompt as a role preamble. Maps the
event stream to the same shape. No session resume in v1 → `fresh_context: false` with
runner `codex` is a validation error.

Adding a runner = one new file in `src/runners/` implementing the interface, registered
in a static map. No dynamic plugin loading in v1.

## Execution semantics

1. `sao run workflow.yaml "add dark mode" --var issue=123`
2. Parse + validate (zod schema, dependency cycle check, template references, runner
  availability — registry lookup and binary-on-PATH, so a missing CLI fails before
  any node's side effects).
3. Create run: id `2026-08-03-1432-fix-issue-a1b2`, dir `.sao/runs/<id>/` in the
  **main repo** (`.sao/` auto-appended to `.git/info/exclude`, never the user's
  .gitignore; agents in `.agents/` are ordinary committed files).
4. `git worktree add .sao/worktrees/<id> -b <branch> <base>` — `<base>` from `--base`,
  else workflow `base:`, else current HEAD; `<branch>` defaults to `sao/<id>`,
  overridable with `--branch <name>` (`--no-worktree` runs in-place for trusted/quick
  workflows).
5. Dependency-order scheduling: every node whose deps are complete becomes eligible; eligible
  nodes run concurrently up to `--concurrency` (default **2**). Caveat documented:
   parallel AI nodes share the worktree — keep parallel branches read-only/disjoint.
6. Each node: check `when_bash` (skip if non-zero) → interpolate templates → execute
  (subprocesses inherit the `SAO_*` env vars) → stream output live (prefixed
  `[node-id]`) → append to `.sao/runs/<id>/logs/<node-id>.log` (loops:
   `<node-id>.<iter>.log`) → persist state after every node/iteration transition.
7. Failure (bash non-zero after retries, agent crash, loop cap — or a gate reject,
  which marks the node and run `rejected` instead of `failed`): halt,
  mark node `failed`, print `sao resume <id>`, exit 1. Resume re-runs from the
   failed node/iteration with all prior state intact.
8. Success: auto-commit any uncommitted worktree changes (`sao: finalize run <id>`).
  Default: print the branch, worktree path, and copy-paste next steps (diff, merge,
   PR). With `--auto-open-pr`: additionally push `sao/<id>` and run
   `gh pr create --draft` with title from workflow name/task and body from the last
   AI node's output; if `gh` fails or is absent, fall back to the default report.
   Worktree is kept until `sao clean`.



### State file (`.sao/runs/<id>/state.json`)

```json
{
  "id": "2026-08-03-1432-fix-issue-a1b2",
  "workflow": "/abs/path/fix-issue.yaml",
  "workflowHash": "sha256:...",
  "task": "add dark mode",
  "vars": { "issue": "123" },
  "autoOpenPr": false,
  "worktree": ".sao/worktrees/<id>",
  "base": "main",
  "branch": "sao/<id>",
  "status": "running | succeeded | failed | rejected",
  "nodes": {
    "plan":      { "status": "succeeded", "output": "...", "sessionId": "...", "startedAt": "...", "endedAt": "..." },
    "implement": { "status": "running", "iterations": 3, "sessionId": "...", "lastFeedback": "..." }
  }
}
```

`resume` refuses to run if the workflow file's hash changed (override with `--force`).
`autoOpenPr` is persisted from `sao run`; `sao resume` inherits it, and passing
`--auto-open-pr` on resume turns it on for a run that started without it.

## CLI

```
sao run <workflow.yaml> [task...] [--var k=v ...] [--base ref] [--branch name] [--concurrency N] [--no-worktree] [--runner name] [--auto-open-pr] [--dry-run]
sao resume <run-id> [--force] [--auto-open-pr]
sao list                      # scans .sao/runs/, table: id, workflow, status, age
sao logs <run-id> [node-id] [--follow]
sao validate <workflow.yaml>  # schema + dependency-graph + template + runner checks, no execution
sao clean [--all]             # remove worktrees/branches of finished runs (--all: also run dirs)
```

`--dry-run` prints the resolved execution plan (node order, interpolated prompts) without running anything.

## Project structure

```
src/
  cli.ts             # commander-based entry, command wiring
  schema.ts          # zod workflow schema + types
  parser.ts          # YAML load, validation, dependency-graph + template checks
  template.ts        # {{...}} interpolation
  agents.ts          # agent file resolution + frontmatter parsing
  engine.ts          # scheduler: dependency ordering, concurrency, node dispatch
  nodes.ts           # ai / bash executors + shell helpers (loop/gate executors live in engine.ts)
  state.ts           # run dir layout, state.json persistence, resume logic
  worktree.ts        # git worktree lifecycle, finalize commit, gh PR
  gate.ts            # terminal prompts (node:readline)
  runners/
    types.ts         # Runner interface + registry
    claude.ts
    codex.ts
tests/               # bun test; engine tests use a mock Runner
```

Dependencies (kept minimal): `commander`, `yaml`, `zod`, `picocolors`. Everything else
is node builtins (`child_process`, `readline`, `crypto`, `fs`). Build: `bun build`
targeting node (or tsup) → `dist/`, `bin: { "sao": "dist/cli.js" }`.

## Milestones

1. **M1 — linear engine**: schema, parser, template, AI+bash nodes, claude runner,
  `run`/`validate`, in-place execution (no worktree), logs. A 3-node workflow works end to end.
2. **M2 — control flow**: concurrent execution of independent branches, loop nodes
  (sentinel + until_bash + interactive + multi-step `steps`), gate nodes, `when_bash`,
  agent files (`.agents/agents/`), MCP/allowed-tools passthrough.
3. **M3 — durability & isolation**: state persistence, `resume`, `list`, `logs`,
  worktree-per-run with `--base`/`--branch`, `SAO_*` env vars, `clean`.
4. **M4 — ship**: codex adapter, `--auto-open-pr` draft-PR finalization, `--dry-run`,
  README, npm publish.



## Non-goals (v1, explicitly)

Web UI/dashboard · database · bundled/default workflows · skills system · natural-language
workflow router · chat platform adapters (Slack/Telegram/Discord/GitHub) · telemetry ·
acting as an MCP host (sao only forwards config to runners) ·
dynamic plugin loading · nested/sub-workflows · expression-language conditionals
(`if:` with comparisons/logic — `when_bash` shell predicates are the only branching) ·
cron/scheduled runs.