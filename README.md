# sao — simple agent orchestrator

A deliberately minimal YAML workflow engine for AI coding agents. Describe a
pipeline of AI prompts, shell commands, loops, and human gates; sao runs it in
an isolated git worktree, streams every node's output, persists state after
every step, and leaves you a branch to review.

No web UI, no database, no plugins. One binary, one YAML file, one branch per run.

```yaml
# fix.yaml
name: fix
nodes:
  - id: plan
    prompt: "Plan a minimal fix for: {{task}}. List the files to touch."

  - id: implement
    depends_on: [plan]
    loop:
      prompt: |
        Execute this plan step by step: {{nodes.plan.output}}
        Iteration {{loop.iteration}}.
      until: ALL_TASKS_COMPLETE
      max_iterations: 10

  - id: test
    depends_on: [implement]
    bash: "bun test"

  - id: ship
    depends_on: [test]
    gate:
      message: "Tests pass. Ship it?"
```

```console
$ sao run fix.yaml "the date picker crashes on Feb 29"
worktree .sao/worktrees/2026-08-05-1432-fix-a1b2 on branch sao/2026-08-05-1432-fix-a1b2 (base 9af0685…)
sao run 2026-08-05-1432-fix-a1b2 (4 nodes, concurrency 2, logs in .sao/runs/…/logs)
→ plan (ai)
...
✓ run 2026-08-05-1432-fix-a1b2 succeeded
  branch:   sao/2026-08-05-1432-fix-a1b2
  worktree: .sao/worktrees/2026-08-05-1432-fix-a1b2
  review:   git diff 9af0685…...sao/2026-08-05-1432-fix-a1b2
  merge:    git merge sao/2026-08-05-1432-fix-a1b2   (worktree kept until: sao clean)
  pr:       git push -u origin sao/… && gh pr create --head sao/…
```

## Install

```console
$ npm install -g simple-agent-orchestrator
```

Requires Node 20+ (or Bun), git, and at least one agent CLI:
[Claude Code](https://claude.com/claude-code) (`claude`) and/or
[Codex CLI](https://github.com/openai/codex) (`codex`).

## Commands

```
sao run <workflow.yaml> [task...] [--var k=v ...] [--base ref] [--branch name]
                        [--concurrency N] [--no-worktree] [--runner name]
                        [--auto-open-pr] [--dry-run]
sao resume <run-id> [--force] [--auto-open-pr]
sao validate <workflow.yaml>
sao list
sao logs <run-id> [node-id] [--follow]
sao clean [--all]
```

- **run** — execute a workflow. Each run gets its own git worktree
  (`.sao/worktrees/<run-id>`) and branch (`sao/<run-id>`), cut from `--base`,
  the workflow's `base:`, or HEAD. On success, leftover changes are
  auto-committed (`sao: finalize run <id>`) and the report prints the diff /
  merge / PR next steps. `--no-worktree` runs in place for trusted workflows.
- **`--dry-run`** — print the resolved execution plan (node order, interpolated
  prompts) and execute nothing. Runs the same validation a real run would.
- **`--auto-open-pr`** — on success, push the run branch and open a **draft PR**
  via `gh`, titled from the workflow name/task with the last AI node's output
  as the body. If `gh` is missing or fails, you get a warning and the normal
  report — the run still succeeds.
- **resume** — continue a halted run from the failed node/iteration: completed
  nodes are not re-run, loops continue at the iteration they died on, rejected
  gates are re-asked. Refuses if the workflow/agents/mcp config changed or the
  run looks owned by a live process (`--force` overrides both).
- **validate** — schema, dependency graph, template references, agent files,
  runner availability. Exactly the checks `run` performs before executing.
- **logs** — dependency-ordered node logs; `--follow` tails a live run.
- **clean** — remove succeeded runs' worktrees; branches are deleted only once
  merged elsewhere. Failed/rejected runs, dirty worktrees, and unmerged
  branches are kept (`--all` discards all of that, plus the run dirs).

## Workflow reference

```yaml
name: my-workflow          # letters, digits, - _ (becomes part of run ids)
description: optional
base: main                 # ref runs are cut from (--base wins; default HEAD)

inputs:                    # --var key=value, used as {{key}}
  - name: ticket
    required: true
  - name: audience
    default: world

defaults:                  # per-node keys > agent frontmatter > defaults
  runner: claude           # claude | codex
  model: sonnet
  permission_mode: acceptEdits
  allowed_tools: [mcp__jira, WebSearch]

mcp:                       # inline server definitions, or a path to an .mcp.json
  jira:
    command: npx
    args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"]

nodes:
  - id: analyze            # AI node
    prompt: "Analyze {{ticket}}: {{task}}"
    agent: researcher      # .agents/agents/researcher.md (frontmatter + system prompt)

  - id: build              # bash node — non-zero exit fails the node
    depends_on: [analyze]
    bash: "bun run build"
    retries: 1
    timeout: 600           # seconds

  - id: implement          # loop node
    depends_on: [analyze]
    loop:
      prompt: "Continue the work. Iteration {{loop.iteration}}. {{loop.feedback}}"
      until: ALL_TASKS_COMPLETE     # sentinel the agent self-reports
      # until_bash: "bun test"      # …or a shell probe: exit 0 ends the loop
      # interactive: true           # …or a human approves each iteration
      max_iterations: 10
      fresh_context: false          # keep one agent session across iterations (claude only)

  - id: ship               # gate node — pauses for y/n in the terminal
    depends_on: [build, implement]
    when_bash: "git diff --quiet || true"   # any node may be conditional
    gate:
      message: "Build green. Merge?"
```

Templating: `{{task}}` (the freeform CLI text), `{{<input>}}`, and
`{{nodes.<id>.output}}` everywhere; `{{loop.iteration}}` / `{{loop.feedback}}`
inside loops; `{{run_id}}` / `{{base}}` / `{{branch}}` run metadata. Every
subprocess also gets `SAO_RUN_ID`, `SAO_BASE_REF`, `SAO_BRANCH`, and
`SAO_WORKTREE` in its environment.

Nodes with satisfied dependencies run concurrently (default 2, `--concurrency`).
Parallel AI nodes share the worktree — keep parallel branches read-only or
disjoint.

### Agents

An agent is a reusable persona: markdown with YAML frontmatter whose body
becomes the system prompt.

```markdown
---
model: sonnet
allowed_tools: [Bash, Read, Edit]
---
You are a meticulous implementer. Work on exactly one task at a time.
```

`agent: implementer` resolves to `<repo-root>/.agents/agents/implementer.md`;
a value containing `/` or ending in `.md` is a path relative to the workflow
file.

### Runners

- **claude** — Claude Code headless (`claude -p`), the default. Honors `model`,
  `permission_mode`, `mcp`, `allowed_tools`, and per-loop session resume.
- **codex** — Codex CLI (`codex exec --json`, `workspace-write` sandbox).
  Uses its own global config (`~/.codex/config.toml`): `mcp`, `allowed_tools`,
  and `permission_mode` are ignored with a warning, and `fresh_context: false`
  is a validation error.

Prompts are always piped over stdin — never argv.

## How a run is stored

```
.sao/                      # in the main repo, auto-added to .git/info/exclude
  runs/<run-id>/
    state.json             # status, per-node state, everything resume needs
    logs/<node-id>.log     # full output (loops: <node-id>.<iteration>.log)
    mcp.json               # inline mcp: block, serialized for the runner
  worktrees/<run-id>/      # the run's checkout, kept until `sao clean`
```

State is saved after every node/iteration transition, so `sao resume` loses at
most the step that was interrupted. A config hash guards resumes against the
workflow changing underneath a half-finished run.

## Development

```console
$ bun install
$ bun test                 # unit tests
$ bun run typecheck
$ bunx stryker run         # mutation tests (the suite holds a 100% score)
$ bun run dev -- run examples/hello.yaml "greet the team"
```

`SPEC.md` is the binding design document. `examples/` has a smoke-test workflow
and three larger Jira/ticket pipelines.

## License

MIT
