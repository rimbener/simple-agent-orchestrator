# Reach any ACP-speaking agent through one adapter, starting with opencode

**As a** runner integrator
**I want** sao to talk to coding agents over the Agent Client Protocol, instead of
hand-writing a bespoke CLI adapter for each one
**so that** adding an agent stops being a multi-hundred-line project with its own
capability gaps, and the agents I actually want to use become reachable

## Context

Today sao can run exactly two agents, and the reason is cost per agent. `claude.ts`
is 233 lines and `codex.ts` is 254, each hand-rolling its own stream parsing,
session-id extraction, error mapping, and sandbox/permission flag translation. Every
one of them arrives with its own holes — codex ignores `mcp:` and `allowed_tools`
with a printed warning, and cannot resume sessions at all, which makes
`fresh_context: false` a validation error for it. So the per-adapter cost is what
gates which agents sao can run, and each new agent means re-solving problems the
previous adapter already solved, differently.

ACP (https://agentclientprotocol.com) inverts that: the agent implements the
protocol, sao implements the client once. Streaming, sessions, and permission
requests come from the protocol rather than from per-agent plumbing, and the
handshake tells sao what a given agent can actually do. **opencode** is the first
agent to go through it, and exists in this story as proof the abstraction holds — not
as the point of it.

**Surfaces touched** (coarsely — the design is `spec_partner`'s): the runner layer
and its registry; preflight/validation, which gains capability checks driven by the
ACP handshake; terminal prompting, which for the first time can be triggered by an
AI node rather than only by a gate node; run state and resume, around session
continuity.

**Locked-decision check.** SPEC.md's v1 non-goals include *dynamic plugin loading*,
and "adding a runner = one new file in `src/runners/`, registered in a static map."
This story deliberately stays on the safe side of that line: the leverage is
**contributor-level**, not author-level. After this lands, a second ACP-speaking
agent is added by a contributor as a registry entry plus a launch command — no new
stream parsing, no new session logic — and a workflow author still cannot point sao
at an arbitrary agent binary from YAML. **No collision; the non-goal stands.**
Exposing ACP agents to workflow-level configuration would be a separate story and a
deliberate reopening of that decision.

## Acceptance criteria

- A workflow node with `runner: opencode` (or `--runner opencode`) executes through
  the ACP adapter and produces the same observable results as an equivalent claude
  node: live streamed output prefixed with the node id, output captured to
  `.sao/runs/<id>/logs/<node-id>.log` and to `{{nodes.<id>.output}}`, and a sentinel
  `<promise>NAME</promise>` in the final output ending a loop.
- An agent file's system prompt (`agent:`) reaches the opencode agent, and its
  effect is observable in the run.
- **Capability gap → preflight failure.** When a workflow needs a capability the
  agent does not advertise in the ACP handshake (e.g. `fresh_context: false` against
  an agent that cannot load sessions), the run fails before any node's side effects,
  with a message naming both the agent and the missing capability. It is never a
  mid-run crash and never a silent no-op.
- **Permission requests pause the run for the human.** When the agent asks the client
  to approve an action, sao blocks and prompts in the terminal; the human's choice is
  sent back to the agent and recorded in the node log. This intentionally extends
  "only gates pause a run" to AI nodes — see Notes.
- **Prompts are serialized and attributable.** At most one permission prompt or gate
  owns the terminal at a time; others queue rather than interleaving. Every permission
  prompt names the node id that raised it, so a human facing concurrent streamed
  output knows what they are approving. The same run with the same answers behaves
  the same way regardless of node timing.
- **Missing binary → preflight failure**, consistent with the existing runners:
  running an opencode node without the agent installed fails at preflight with an
  actionable message, not at dispatch.
- **Lost session on resume → fresh session plus a warning.** Resuming a
  `fresh_context: false` node whose recorded session no longer exists starts a new
  session and continues, printing a warning that prior conversation history was lost.
  The run does not halt.
- **No regressions.** The claude and codex adapters behave exactly as before;
  existing workflows produce identical results; a run using only claude/codex never
  gains a new interactive prompt.
- **Adding the next ACP agent is demonstrably cheap** — reachable by registering it
  with a launch command, with no new protocol, streaming, or session code.

## Notes

Decisions the human already made — do not re-ask:

1. **Persona is the runner integrator**, with opencode as the proof the abstraction
   works. Not developer-primary.
2. **Contributor-level leverage only.** Adding an ACP agent stays a code change (a
   thin one). No YAML/config surface for pointing sao at arbitrary agent binaries;
   the dynamic-plugin-loading non-goal is respected, not overridden.
3. **Capability scope: parity on what ACP itself defines** (sessions, streaming,
   prompts, permission requests), with anything the agent does not advertise failing
   at preflight. Not blanket parity with claude, and not a minimal single-shot
   adapter.
4. **Permission requests block and ask the human** — explicitly chosen over
   auto-approving to match `acceptEdits` / `workspace-write`. The human was told this
   extends the "only gates pause a run" invariant to AI nodes and chose it anyway.
   `spec_partner` should design for it deliberately rather than treat it as an
   oversight; a non-blocking mode, if wanted, is a later story.
5. **Concurrent prompts queue** (one at a time, others wait), rather than
   auto-approving when the terminal is busy or forbidding `--concurrency > 1`.
6. **A lost session on resume warns and continues with a fresh session**, rather
   than halting. Chosen over failing loudly.
7. **The official ACP package is the transport** — the human approved taking
   `@zed-industries/agent-client-protocol` as a fifth runtime dependency, over
   hand-rolling JSON-RPC-over-stdio on node builtins. This is an explicit,
   attributed change to `SPEC.md`'s locked four-dependency line, made at the
   approval gate; the package *is* the protocol definition, so drift is tracked
   upstream instead of by hand.

Open to `spec_partner`, deliberately left undesigned here: which module owns the ACP
client, how capabilities map onto the existing `Runner` interface (including whether
`supportsSessionResume` generalizes), how permission prompts reuse or extend the
existing terminal prompt, the exact wording of every message above, and how the work
slices.
