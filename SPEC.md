# sao — simple agent orchestrator

A minimal YAML workflow engine for AI coding agents. One thing only:
take a YAML file describing a dependency graph of AI/bash/gate nodes and execute it deterministically
against a repo.

## Decisions (locked)


| Dimension        | Decision                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language         | TypeScript                                                                                                                                                                                   |
| Toolchain        | Bun for dev/test; code stays Node-compatible (no Bun-only APIs); published to npm                                                                                                            |
| Distribution     | Global CLI (`npm i -g sao` / `npx sao` / `bun i -g sao`), `engines: node >= 20.12`. Installable on macOS, Linux and Windows — no `os` restriction. Manual smoke check (no CI job): install from a pack, answer a gate's list prompt in a Windows terminal. |
| Binary name      | `sao`                                                                                                                                                                                        |
| Interface        | Pure CLI, live progress in terminal                                                                                                                                                          |
| AI execution     | Pluggable `Runner` interface; **claude** (Claude Code headless), **codex** (Codex CLI exec), and **opencode** (Agent Client Protocol) adapters in v1                                        |
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
  runner: claude          # claude | codex | opencode
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



### Nodes

A **node** is the smallest unit of work in a workflow: one step the engine executes
in the run worktree. A workflow's `nodes:` list *is* the workflow — each entry
defines one node with a unique `id` and exactly one behavior. Nodes are wired into
a dependency graph with `depends_on`; a node starts once every node it depends on
has finished, and independent nodes run concurrently. A node's result is captured
as `nodes.<id>.output` for later nodes to consume, and its status is persisted so
`resume` can re-run from the exact node (or loop iteration) that failed.

Every node takes one of four behaviors (exactly one of `prompt`, `bash`, `loop`,
`gate` per node):

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
A node's predicate is evaluated at most once: when `sao resume` re-attempts a node
whose earlier attempt already passed it (recorded in state), the body runs directly —
the node's own partial work may have flipped the predicate, and skipping now would
wipe loop progress or a gate's promised re-ask. Only if the predicate itself failed
(e.g. timed out) is it evaluated again.

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
**every** iteration. At an interactive terminal the pause is a navigable list: the
agent's own declared options first, in the order it sent them, then **End the
loop** (offered only on an iteration where the agent emitted the signal —
offering it otherwise would be an entry that can only ever be refused),
**Write feedback instead** (collects a follow-up text entry, kept verbatim even if
it reads like a verdict word such as "approve" or "reject" — picking a list entry
already disambiguated the answer, so it is never reparsed), and **Reject and halt
the run**. Choosing an agent option feeds its `label` — never its `id` — to the
next iteration's `{{loop.feedback}}`.

At an interactive terminal only, that same pause also draws the iteration's own
output as a titled box above the list — `<options>`/`<promise>` markers stripped
and the markdown subset rendered (`src/render.ts`), never wrapped or indented
beyond what the box itself adds. A piped reply sees no box at all: the message and
the raw markers stay exactly as they are today. An output that is empty,
whitespace-only, or nothing but markers shows a dim `(the agent sent no text)`
notice in place of the box. A `<promise>NAME</promise>` whose name isn't this
loop's `until:` is stripped like any other and reported as a dim
`⚠ <node>: agent emitted <promise>NAME</promise>, expected <SIGNAL>` warning —
never halting the run, and never changing signal detection itself. Nothing here
touches what is logged: the node log and `nodes.<id>.output` keep the raw text.

At that same terminal, the iteration's live echo is **withheld and released at the
pause**, minus the final message, so the message appears exactly once — inside the
box, never also as a scrolled dim line. How much narration streams live before that
depends on the runner's declared `finalOutputStreaming` (see Runner interface,
below): a `per-message` runner's earlier messages still scroll live, lagging by one
message; a `whole-turn` runner (or one that declares nothing) holds the whole
iteration until the pause. Either way a wrong or missing declaration only shows the
message twice, never zero times, and a failing iteration echoes whatever it was
holding rather than discarding it. A piped run withholds nothing — every chunk
echoes exactly as it arrives, unchanged by this.

An agent invites this by ending its response with a last line of the form
`<options>[{"id": "sqlite", "label": "Use SQLite", "description": "no server to
run"}]</options>` — a JSON array of objects with unique, non-empty `id`s (not
starting with the `sao:` prefix sao reserves for its own entries) and non-empty
`label`s; `description` is optional and shown alongside the label. The instruction
inviting this rides beside the sentinel instruction on every iteration's prompt, so
it reaches every runner without any runner-specific wiring — it is just the
agent's own output, the same channel the sentinel already travels. A declaration
that can't be read (invalid JSON, wrong shape, missing closing tag) is silently
dropped — a warning naming the node is recorded on the iteration's log and the
pause still runs with only the run's own entries, exactly as if the agent had
declared nothing.

Piped replies are a separate channel with no menu at all. Combined with
`fresh_context: false` this is a genuine multi-turn conversation — e.g. an agent
interviewing the human one question per iteration until the spec is settled.
Because these are conversations, only the explicit forms `a`/`approve`/`approved`
and `r`/`reject`/`rejected` act as verdicts here — a natural-language "yes"/"no"
(an answer to the agent's question) is treated as feedback. Plain gates keep the
wider `y`/`yes`/`n`/`no` vocabulary. An approve on an iteration the agent has not
signaled just re-prompts, exactly as at an interactive terminal.

A line that is not a verdict is checked next against the agent's declared
options (if any): an exact match on one's `id` becomes feedback naming that
option's `label`, the piped path's stand-in for picking it from the list — the
match is exact on `id`, never a 1-based index, since no menu is printed for a
number to refer to. A verdict word always wins first, so an agent declaring an
option whose `id` happens to be a verdict word (e.g. `a`) can never cost the
human the loop's exit path. A line matching neither becomes feedback verbatim,
exactly as when the agent declared nothing.

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

At an interactive terminal the pause is a navigable list: **Approve**, **Reject**,
**Give feedback** (the last collects a follow-up text entry, which becomes the
node's output verbatim even if it reads like a verdict word such as "yes" or
"approve" — picking a list entry already disambiguated the answer, so it is never
reparsed). The old `[a]pprove / [r]eject / or type feedback` letter prompt is gone
from this path.

Piped replies are a separate input channel that renders no menu at all, and are
where the deleted letter prompt's vocabulary now lives: `a`, `approve`, `y`, `yes`
approve; `r`, `reject`, `n`, `no` reject; any other non-empty line is feedback; an
empty line re-asks.

- approve → continue.
- reject → run halts as `rejected`; `sao resume` re-asks the gate.
- feedback → stored as `nodes.<id>.output` so downstream prompts can consume it,
then continues (a gate that must re-do work should be modeled as an interactive loop).

### Permission requests (ACP runners)

**Invariant change:** gates are no longer the only thing that can pause a run — an
ACP runner's `session/request_permission` pauses too, mid-AI-node. At an
interactive terminal the pause is the same navigable list a gate uses: the node id
and what the agent wants to do (the tool call's title), then one entry per option
the agent sent, in the order sent — nothing sao invents, and the old numbered menu
(`1. Allow`, `2. Deny`, …) is gone. The chosen option's `optionId` is sent back
verbatim — sao never interprets option meaning, and keeps **no** permission memory
of its own ("allow for this session" is remembered agent-side, not by sao).

Piped replies address an option by a bare 1-based index or by the option's own
identifier, typed exactly; anything else re-asks and nothing is sent to the agent
until a valid choice is made. With no interactive terminal (stdin closed), the
node fails the same way a gate does — never auto-approved.

Permission prompts serialize on the **same terminal queue** gates and interactive
loops already use (`src/gate.ts`'s shared prompt queue, behind `promptChoice`) —
there is no second stdin mechanism, so at most one prompt owns the terminal at a
time, each naming the node it belongs to. A node's `timeout` (if any) excludes
time spent waiting on — or queued behind — a permission prompt, exactly like a
gate's wait is never time-boxed: the clock pauses the instant a prompt is handed
to that queue and resumes once it is answered, so one human's slow reply to one
node never times out an unrelated node. claude and codex have no
permission-request concept and never gain this prompt.

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
  ignores them with a printed warning; **ACP runners** (opencode) honor `mcp:`
  natively via `session/new`'s `mcpServers` and warn-and-ignore `allowed_tools`
  — an ACP runner has no allowlist concept to map it onto.

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
  // How the runner streams its final output — a liveness hint for withholding an
  // interactive loop's echo (see above), never a correctness contract. "per-message":
  // onOutput fires once per complete agent message, the last of which is the final
  // output (claude, codex). "whole-turn": onOutput fires with partial chunks that only
  // add up to the final output at the end (opencode). Unset means "whole-turn" — the
  // conservative default, so a runner that declares nothing is still shown once, not zero times.
  finalOutputStreaming?: "per-message" | "whole-turn";
}
```

**claude adapter** — spawns `claude -p --output-format stream-json --verbose`
(stream-json requires --verbose), piping the prompt over **stdin** — never argv,
where it would be `ps`-visible, flag-injectable, and ARG_MAX-bounded — with
`--model`, `--permission-mode` (default `acceptEdits`), `--resume`,
`--append-system-prompt <systemPrompt>`, `--mcp-config <mcpConfigPath>`, and
`--allowedTools <allowedTools>` as applicable.
Parses the stream for live output; `result` event supplies `output` + `session_id`.

**codex adapter** — spawns `codex exec --json --sandbox workspace-write -` (non-interactive;
the trailing `-` reads the prompt over **stdin**, same rationale as the claude adapter),
prepending `systemPrompt` to the prompt as a role preamble. Maps the JSONL event stream to
the same shape: the last completed `agent_message` item is the output, `thread.started`
supplies the session id, and a `turn.failed`/`error` event fails the node even on exit 0.
The fixed `workspace-write` sandbox is the codex equivalent of claude's default
`acceptEdits` — agents edit files in their (isolated) worktree without prompting.
No session resume in v1 → `fresh_context: false` with
runner `codex` is a validation error (checked against the effective runner, so a
`--runner codex` override fails preflight the same way).

**opencode adapter** — the first **Agent Client Protocol (ACP)** agent, via
`src/acp.ts`: the one protocol client every ACP agent goes through (spawn over
stdio, `initialize`, `session/new`, `session/prompt`, stream `session/update`).
`src/runners/opencode.ts` is only its name and launch command (`opencode acp`,
spec D7), delegating everything else to `src/acp.ts` — adding the next ACP agent
is a sibling file of the same shape. `output` is the whole turn's assistant text,
joined from `agent_message_chunk` updates only; thought chunks and tool-call
updates are excluded, matching the claude adapter's text-only capture. ACP has no
system-prompt slot, so `systemPrompt` is prepended to the prompt as a role
preamble (the codex precedent). A `stopReason` of `refusal` fails the node even on
a clean exit. Sessions map to `session/new` (fresh) and `session/load`
(`fresh_context: false`, continuing); a `session/load` the agent no longer
recognizes prints a warning that prior conversation history was lost and
continues in a new session, rather than halting the run (user story Note 6) —
a genuine process/transport failure during the load still fails the node.
`mcp:` servers are forwarded natively via `session/new`/`session/load`'s
`mcpServers`; `model` is set on the session via `session/set_model` before the
prompt (the pinned `agent-client-protocol` ships a patched `setSessionModel`,
whose upstream method mistakenly sends `session/set_mode`) — an agent that does
not implement it warns and runs with its default, but a rejected model (e.g.
unknown ID) fails the node like a bad `--model` on claude/codex rather than
silently running the wrong model; `allowed_tools` is warned about and ignored
(no ACP allowlist concept to map it onto); `permission_mode` is a silent no-op,
superseded by the permission-request flow.
List of opencode-go models:
opencode-go/deepseek-v4-flash
opencode-go/deepseek-v4-pro
opencode-go/glm-5
opencode-go/glm-5.1
opencode-go/glm-5.2
opencode-go/gpt-5.6-luna
opencode-go/grok-4.5
opencode-go/hy3
opencode-go/kimi-k2.5
opencode-go/kimi-k2.6
opencode-go/kimi-k2.7-code
opencode-go/kimi-k3
opencode-go/mimo-v2-omni
opencode-go/mimo-v2-pro
opencode-go/mimo-v2.5
opencode-go/mimo-v2.5-pro
opencode-go/minimax-m2.5
opencode-go/minimax-m2.7
opencode-go/minimax-m3
opencode-go/qwen3.5-plus
opencode-go/qwen3.6-plus
opencode-go/qwen3.7-max
opencode-go/qwen3.7-plus
opencode-go/qwen3.8-max

Adding a runner = one new file in `src/runners/` implementing the interface, registered
in a static map. No dynamic plugin loading in v1.

## Execution semantics

1. `sao run workflow.yaml "add dark mode" --var issue=123`
2. Parse + validate (zod schema, dependency cycle check, template references, runner
  availability — registry lookup and binary-on-PATH — so a missing CLI fails before
  any node's side effects). For ACP runners, the binary check is followed by an
  `initialize` handshake: the agent's advertised capabilities are checked against
  what the workflow needs (e.g. session loading for `fresh_context: false`, or an
  MCP transport an `mcp:` server declares that the agent's handshake doesn't
  advertise) — an ACP runner's capability comes from this live handshake, never a static
  declaration, so a capability gap or a binary that fails to speak ACP also fails
  here, before any node's side effects. `sao validate` performs the same handshake.
3. Create run: id `2026-08-03-1432-fix-issue-a1b2`, dir `.sao/runs/<id>/` in the
  **main repo** (`.sao/` auto-appended to `.git/info/exclude`, never the user's
  .gitignore; agents in `.agents/` are ordinary committed files). Invoked from
  inside ANY linked worktree — a run's own or the user's — sao follows the `.git`
  file to the main checkout: `.sao/`, `.agents/` resolution, and the default base
  (HEAD) all anchor there.
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
  which marks the node and run `rejected` instead of `failed`; an ACP runner's
  permission request can likewise pause and, with no terminal, fail the node —
  see Permission requests): halt,
  mark node `failed`, print `sao resume <id>`, exit 1. Resume re-runs from the
   failed node/iteration with all prior state intact.
8. Success: auto-commit any uncommitted worktree changes (`sao: finalize run <id>`).
  Default: print the branch, worktree path, and copy-paste next steps (diff, merge,
   PR). With `--auto-open-pr`: additionally push `sao/<id>` (as an explicit
   `refs/heads/x:refs/heads/x` refspec — a bare name is refspec syntax, where a
   crafted value could force-push) and run `gh pr create --draft` with title from
   workflow name/task, body from the last AI node's output, and `--base` set to the
   run's base whenever it is not a resolved commit SHA (a base gh cannot use — a
   tag, say — just degrades to the fallback); if the push or `gh` fails or is
   absent, fall back to the default report. Worktree is kept until `sao clean`.



### State file (`.sao/runs/<id>/state.json`)

```json
{
  "id": "2026-08-03-1432-fix-issue-a1b2",
  "workflow": "/abs/path/fix-issue.yaml",
  "workflowHash": "sha256:...",
  "task": "add dark mode",
  "vars": { "issue": "123" },
  "autoOpenPr": false,
  "createdAt": "2026-08-03T14:32:05.000Z",
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

`resume` refuses to run if the run's configuration hash changed — the workflow file,
any referenced agent file, or a path-form mcp config (override with `--force`). It
also refuses while another sao process owns the run (an `engine.lock` file in the
run dir holds the owner's pid; the persisted `pid` is a second check). `--force`
overrides the liveness refusals too — after a reboot the recorded pid is often
recycled by an unrelated process.
Execution parameters are persisted and reused on resume: `pid`, `concurrency`, a
`--runner` override, and — for `--no-worktree` runs — the execution `cwd` (relative
to the repo root), so a resume from a different directory still executes where the
run started. `autoOpenPr` is persisted from `sao run`; `sao resume` inherits it, and
passing `--auto-open-pr` on resume turns it on for a run that started without it
(only halted runs can be resumed — a run that already succeeded without the flag
gets its PR opened by hand).

## CLI

```
sao run <workflow.yaml> [task...] [--var k=v ...] [--base ref] [--branch name] [--concurrency N] [--no-worktree] [--runner name] [--auto-open-pr] [--dry-run]
sao resume <run-id> [--force] [--auto-open-pr]
sao list                      # scans .sao/runs/, table: id, workflow, status, age
sao logs <run-id> [node-id] [--follow]
sao validate <workflow.yaml>  # schema + dependency-graph + template + runner checks, no execution
sao clean [--all]             # remove succeeded runs' worktrees; branches only once merged
                              # elsewhere. Failed/rejected runs (resume targets), dirty worktrees,
                              # and unmerged branches are kept. --all discards all of that
                              # plus the run dirs; live runs are never touched.
```

`--dry-run` prints the resolved execution plan (node order, interpolated prompts)
without running anything, after the same checks a real run makes before its first
side effect: inputs, AI configs, runner preflight, and — when a worktree applies —
the git repo / base ref / branch name pre-checks. In-place plans render the empty
`{{base}}`/`{{branch}}` the engine would actually provide.

## Project structure

```
src/
  cli.ts             # commander-based entry, command wiring
  schema.ts          # zod workflow schema + types
  parser.ts          # YAML load, validation, dependency-graph + template checks
  template.ts        # {{...}} interpolation
  agents.ts          # agent file resolution + frontmatter parsing
  options.ts         # <options> declaration instruction + parser (zod-validated)
  engine.ts          # scheduler: dependency ordering, concurrency, node dispatch
  nodes.ts           # ai / bash executors + shell helpers (loop/gate executors live in engine.ts)
  state.ts           # run dir layout, state.json persistence, resume logic
  worktree.ts        # git worktree lifecycle, finalize commit, gh PR
  gate.ts            # terminal prompts (node:readline)
  acp.ts             # Agent Client Protocol client — the one client every ACP agent goes through
  runners/
    types.ts         # Runner interface + registry
    claude.ts
    codex.ts
    opencode.ts      # ACP registry entry: name + launch command, delegates to acp.ts
tests/               # bun test; engine tests use a mock Runner
```

Dependencies (kept minimal): `commander`, `yaml`, `zod`, `picocolors`,
`@clack/prompts` (the list prompt every human-facing pause renders through), and
`@zed-industries/agent-client-protocol` (the ACP client's transport — the package
*is* the protocol definition, so drift is tracked upstream rather than by hand).
Everything else is node builtins (`child_process`, `readline`, `crypto`, `fs`).
Build: `bun build` targeting node (or tsup) → `dist/`, `bin: { "sao": "dist/cli.js" }`.

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

Web UI/dashboard · database · natural-language workflow router · chat platform
adapters (Slack/Telegram/Discord/GitHub) · telemetry · acting as an MCP host (sao
only forwards config to runners) · dynamic plugin loading · nested/sub-workflows ·
expression-language conditionals (`if:` with comparisons/logic — `when_bash` shell
predicates are the only branching) · cron/scheduled runs.
