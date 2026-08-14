It's hard to see the question and options, they're displayed like this: 
```
  [grill-user-story#2] **Question 2 — what must they be able to answer after opening a workflow, that YAML alone doesn't give them?**
  [grill-user-story#2] The folder picker and the list of workflows are already in your request, so I'm asking about depth per workflow:
  [grill-user-story#2] - **Shape only** — the graph: nodes, `depends_on` edges, which node is AI / bash / loop / gate, and what runs concurrently. Answers "how is this wired".
  [grill-user-story#2] - **Shape + detail on demand** — the same graph, plus picking a node reveals its actual content: the prompt text, `agent`, `runner`/`model`, the loop's `until` / `max_iterations`, the gate's message, any `when_bash`. Answers "how is this wired" *and* "what does it actually ask the agent to do".
  [grill-user-story#2] - **Shape + workflow-level header** — graph plus the workflow's `name`, `description`, `inputs`, `defaults`, `mcp` — the things you must supply to run it.
  [grill-user-story#2] **My recommendation: shape + detail on demand, plus the workflow-level header.** A newcomer's real questions are "what does this do" and "what do I have to pass it to run it" — a bare boxes-and-arrows picture answers neither, and they'd be back in the YAML within a minute. The header matters because `inputs` with `required: true` is the thing that stops a first run cold.
  [grill-user-story#2] Read it here: http://127.0.0.1:53405/docs/spec-viewer.html
```

I'd like them to respect the formatting comming from the LLM, or at least using some formatting so the questions are easier to see

Don't show the raw options, example:
```
  [grill-user-story#2] <options>[{"id":"shape","label":"Shape only","description":"Nodes, edges, node kind, concurrency — the graph and nothing else"},{"id":"shape-detail","label":"Shape + node detail on demand + workflow header (recommended)","description":"Graph, plus per-node prompt/agent/runner/loop/gate detail, plus name/description/inputs/defaults"},{"id":"shape-header","label":"Shape + workflow header only","description":"Graph plus name/description/inputs/defaults, no per-node prompt text"}]</options>
```