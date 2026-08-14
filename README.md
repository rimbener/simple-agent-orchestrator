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

## Architecture diagrams

C4-model diagrams of the system, generated from the source. Each level ships as
a Mermaid flowchart (`.md`, renders on GitHub), an editable
[Excalidraw](https://excalidraw.com) scene (`.excalidraw`), and the raw element
data (`.json`):

| Level | What it shows | Files |
| --- | --- | --- |
| C1 — Context | sao and the people/systems around it (developer, git, Claude/Codex CLIs) | [`.md`](docs/c4/C1-Context.md) |
| C2 — Containers | the single sao CLI container and its dependencies | [`.md`](docs/c4/C2-Containers.md) |
| C3 — Components | the modules behind `sao run` (parser, engine, nodes, runners, …) | [`.md`](docs/c4/C3-Components.md) |
| C4 — Code | the function-level run path (`runWorkflow` → executeByKind → runners) | [`.md`](docs/c4/C4-Code.md) |

## Install

```console
$ npm install -g simple-agent-orchestrator
```

Requires Node 20.12+ (or Bun), git, and at least one agent CLI:
[Claude Code](https://claude.com/claude-code) (`claude`),
[Codex CLI](https://github.com/openai/codex) (`codex`), and/or
[opencode](https://opencode.ai) (`opencode`, via the Agent Client Protocol).

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
  runner availability, and — for ACP runners like opencode — an `initialize`
  handshake checking the agent's advertised capabilities against what the
  workflow needs (e.g. session loading for `fresh_context: false`). Exactly the
  checks `run` performs before executing.
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
  runner: claude           # claude | codex | opencode
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

  - id: implement          # loop node — the agent may end a reply with an <options> block (see below)
    depends_on: [analyze]
    loop:
      prompt: "Continue the work. Iteration {{loop.iteration}}. {{loop.feedback}}"
      until: ALL_TASKS_COMPLETE     # sentinel the agent self-reports
      # until_bash: "bun test"      # …or a shell probe: exit 0 ends the loop
      # interactive: true           # …or a human approves each iteration from a list, agent options first
      max_iterations: 10
      fresh_context: false          # keep one agent session across iterations (claude, or an ACP agent whose handshake advertises it — codex never)

  - id: ship               # gate node — pauses for an approve/reject/feedback list in the terminal
    depends_on: [build, implement]
    when_bash: "git diff --quiet || true"   # any node may be conditional
    gate:
      message: "Build green. Merge?"
```

An interactive loop's agent may end its response with a last line of the form
`<options>[{"id": "sqlite", "label": "Use SQLite", "description": "no server to
run"}]</options>` (ids unique and non-empty, not prefixed `sao:`; `description`
optional). The pause then offers those options first, in the order declared,
ahead of **End the loop** (only once the agent has signaled `until:`), **Write
feedback instead**, and **Reject and halt the run**. Choosing a declared option
feeds its `label` — not its `id` — to the next iteration's `{{loop.feedback}}`.
This works the same for any runner, since the declaration travels in the agent's
own output; a block that can't be read is ignored with a warning, and the pause
still runs with the run's own entries.

At an interactive terminal, that pause also shows the iteration's own message —
markdown rendered, `<options>`/`<promise>` markers stripped — in a titled box
above the list, so the human never has to read the raw tags. That message prints
exactly once: the live dim `[<node>#<iteration>]` echo holds it back and releases
everything else at the pause, so narration still streams while the final message
appears only in the box.

A piped reply (no interactive terminal) renders no list at all: one line picks a
declared option by typing its exact `id`, which feeds that option's `label` to
`{{loop.feedback}}` the same as picking it from the list would. A verdict word
(`a`/`approve`/`approved`, `r`/`reject`/`rejected`) always wins over an identical
option id — a declared option can never block the loop's exit path. Anything else
is feedback verbatim.

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
- **opencode** — the first [Agent Client Protocol](https://agentclientprotocol.com)
  agent (`opencode acp`). `systemPrompt` is delivered as a role preamble (ACP has
  no system-prompt slot); `model` is applied per-session via `session/set_model`
  (an agent that can't select models warns and uses its default; an unknown model
  fails the node). A refused turn fails the node even on a clean exit.
  `fresh_context: false` support depends on the agent's own `initialize`
  handshake advertising session loading, checked at `validate`/`run` time —
  not a static per-runner declaration like claude/codex. When the agent asks for
  permission mid-turn (`session/request_permission`), sao pauses the run with the
  same navigable list a gate uses — the node id, what the agent wants to do, then
  one entry per option the agent sent, in the order sent, nothing else. A piped
  reply may name an option by a 1-based index or by its own identifier, typed
  exactly; anything else re-asks.

  The chosen option is sent back to the agent verbatim; sao keeps no permission
  memory of its own ("allow for this session" is remembered agent-side). This
  prompt shares the same terminal queue as gates and interactive loops, so only
  one is ever shown at a time, and a node's `timeout` excludes time spent
  waiting on (or queued behind) one — same as a gate's wait is never time-boxed.
  With no interactive terminal, the node fails instead of auto-approving. claude
  and codex have no permission-request concept and never show this prompt.
  `fresh_context: false` continues one ACP session (`session/load`); a recorded
  session the agent no longer knows warns that prior conversation history was
  lost and continues with a fresh one, rather than halting. Honors `mcp` natively
  (forwarded via `session/new`'s `mcpServers`, same `command`/`args`/`env` or
  `url` shape as the other runners); `allowed_tools` is warned about and
  ignored (no allowlist concept to map it onto); `permission_mode` is a silent
  no-op, superseded by the permission-request flow above. An MCP transport a
  workflow's `mcp:` block declares that the agent's handshake doesn't advertise
  fails at `validate`/`run` time, the same way a missing session-loading
  capability does.

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
