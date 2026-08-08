# Gherkin contract — ACP client + opencode runner

Declarative behavior only. Every `@s` tag is owned by exactly one task in
[`tasks.md`](./tasks.md). "An ACP agent" means a test double speaking the protocol;
no scenario requires the real opencode binary.

---

## Feature: Running an AI node through the ACP client

  @s-acp-stream-and-output
  Scenario: An ACP node streams live and captures its output
    Given a workflow with a single AI node using the opencode runner
    And the agent replies with assistant text across several chunks
    When the workflow runs
    Then the assistant text appears live in the terminal prefixed with the node id
    And the same text is appended to the node's log file under the run directory
    And the node's captured output is the whole turn's assistant text

  @s-acp-output-excludes-thoughts
  Scenario: Reasoning and tool activity stay out of the output
    Given a workflow with a single AI node using the opencode runner
    And the agent emits reasoning chunks and tool-call updates alongside its assistant text
    When the workflow runs
    Then the node's captured output contains only the assistant text
    And the reasoning chunks and tool-call updates are not streamed to the terminal

  @s-acp-sentinel-ends-loop
  Scenario: A sentinel in an ACP turn ends a loop
    Given a loop node using the opencode runner with a sentinel condition
    And the agent emits the sentinel token at the end of its second turn
    When the workflow runs
    Then the loop ends after the second iteration
    And the node succeeds

  @s-acp-refusal-fails-node
  Scenario: A refused turn fails the node even though the agent exited cleanly
    Given a workflow with a single AI node using the opencode runner
    And the agent ends its turn with a refusal stop reason and then exits successfully
    When the workflow runs
    Then the node fails
    And the run halts and reports how to resume it

  @s-acp-timeout-kills
  Scenario: An agent that never finishes hits the node timeout
    Given a workflow with a single AI node using the opencode runner and a short timeout
    And the agent streams forever without ending its turn
    When the workflow runs
    Then the node fails with a message naming the timeout
    And the agent process is no longer running

---

## Feature: Selecting the opencode runner

  @s-opencode-runner-selectable
  Scenario Outline: opencode is selectable the same ways claude and codex are
    Given a workflow whose AI node resolves to the opencode runner via <source>
    When the workflow runs
    Then the node executes through the ACP client

    Examples:
      | source                    |
      | the node's own runner key |
      | the workflow defaults     |
      | the --runner CLI override |

  @s-opencode-agent-system-prompt
  Scenario: An agent file's system prompt reaches the ACP agent
    Given an agent file whose body instructs the agent to answer in a fixed phrase
    And a workflow node referencing that agent and using the opencode runner
    When the workflow runs
    Then the agent receives that body as its system prompt
    And the node's output shows the instruction took effect

  @s-opencode-missing-binary-preflight
  Scenario: A missing agent binary fails before anything happens
    Given a workflow using the opencode runner
    And the opencode binary is not on PATH
    When the workflow runs
    Then the run fails with a message naming the missing binary and how to install it
    And no run directory, worktree or branch is created

  @s-unknown-runner-lists-opencode
  Scenario: The unknown-runner error advertises opencode
    Given a workflow whose node names a runner that does not exist
    When the workflow is validated
    Then the error lists the available runners including opencode

---

## Feature: Capability preflight from the ACP handshake

  @s-capability-gap-preflight
  Scenario: A capability the agent does not advertise fails preflight
    Given a loop node using the opencode runner with fresh_context set to false
    And the agent's handshake does not advertise session loading
    When the workflow runs
    Then the run fails before any node executes
    And the message names both the agent and the missing capability
    And no run directory, worktree or branch is created

  @s-capability-present-passes
  Scenario: An advertised capability lets the run proceed
    Given a loop node using the opencode runner with fresh_context set to false
    And the agent's handshake advertises session loading
    When the workflow runs
    Then preflight passes and the node executes

  @s-validate-performs-handshake
  Scenario: validate surfaces a capability gap without running anything
    Given a loop node using the opencode runner with fresh_context set to false
    And the agent's handshake does not advertise session loading
    When the workflow is validated
    Then validation fails with the same capability message the run would give
    And no node is executed

  @s-handshake-once-per-runner
  Scenario: The handshake happens once per distinct runner, not once per node
    Given a workflow with three AI nodes all using the opencode runner
    When the workflow runs
    Then the agent is handshaken exactly once during preflight
    And that handshake process does not outlive preflight

  @s-handshake-failure-preflight
  Scenario: A binary that does not speak ACP fails preflight
    Given a workflow using the opencode runner
    And the binary on PATH exits without completing the ACP handshake
    When the workflow runs
    Then the run fails at preflight with a message naming the agent and the failed handshake
    And no run directory, worktree or branch is created

  @s-existing-runners-unaffected
  Scenario Outline: claude and codex behave exactly as before
    Given a workflow using the <runner> runner
    When the workflow runs
    Then no ACP handshake is attempted
    And the run produces the same results as before this feature

    Examples:
      | runner |
      | claude |
      | codex  |

---

## Feature: Permission requests

  @s-permission-prompt-numbered
  Scenario: The agent's own options are offered as a numbered menu
    Given a running AI node using the opencode runner
    When the agent requests permission for a tool call, offering several options
    Then the run pauses and the terminal shows the node id, what the agent wants to do, and the options numbered
    And choosing a number sends that option back to the agent
    And both the request and the chosen option are recorded in the node's log

  @s-permission-invalid-reply-reasks
  Scenario: An unparseable reply re-asks rather than guessing
    Given a permission prompt is waiting for the human
    When the human types something that is not one of the offered numbers
    Then the prompt is asked again
    And no option is sent to the agent until a valid choice is made

  @s-permission-stdin-closed-fails
  Scenario: With no terminal, a permission request fails the node
    Given a workflow using the opencode runner is run with stdin closed
    When the agent requests permission
    Then the node fails with a message explaining an interactive terminal is needed
    And no option is auto-approved

  @s-permission-serialized-with-gates
  Scenario: Only one prompt owns the terminal at a time
    Given a workflow running two nodes concurrently
    And one node reaches a gate while the other's agent requests permission
    When both prompts become due
    Then only one prompt is displayed at a time
    And the second is displayed only after the first is answered
    And each prompt identifies the node it belongs to

  @s-no-new-prompts-for-claude-codex
  Scenario: A claude-and-codex-only run never gains a prompt
    Given a workflow with claude and codex nodes and no gates
    When the workflow runs
    Then the run completes without ever prompting the human

---

## Feature: Timeouts across human waits

  @s-timeout-paused-during-prompt
  Scenario: Human deliberation does not count against the node timeout
    Given an AI node using the opencode runner with a short timeout
    And its agent requests permission
    When the human takes longer than the timeout to answer
    Then the node does not time out
    And the agent continues after the answer is sent

  @s-timeout-paused-while-queued
  Scenario: Waiting behind another prompt does not count either
    Given two concurrent AI nodes using the opencode runner, each with a short timeout
    And one node's permission prompt is queued behind the other's
    When the first prompt is answered after a long delay
    Then the queued node does not time out
    And both nodes complete

---

## Feature: Sessions and resume

  @s-fresh-context-false-loads-session
  Scenario: A continuing loop reuses one ACP session
    Given a loop node using the opencode runner with fresh_context set to false
    And the agent advertises session loading
    When the loop runs several iterations
    Then every iteration after the first continues the same session

  @s-fresh-context-true-new-session
  Scenario: A fresh-context loop starts a new session each iteration
    Given a loop node using the opencode runner with fresh_context set to true
    When the loop runs several iterations
    Then each iteration runs in a new session

  @s-session-id-persisted
  Scenario: The session id survives into run state
    Given a workflow with an AI node using the opencode runner
    When the node completes
    Then the run's persisted state records that node's session id

  @s-lost-session-warns-and-continues
  Scenario: A session that no longer exists warns and continues
    Given a halted run whose opencode node recorded a session id
    And the agent no longer knows that session
    When the run is resumed
    Then a warning states that prior conversation history was lost
    And the node continues in a new session
    And the run does not halt

---

## Feature: MCP passthrough and ignored settings

  @s-mcp-forwarded-to-session-new
  Scenario: Workflow MCP servers reach the ACP agent
    Given a workflow declaring an MCP server and a node using the opencode runner
    When the workflow runs
    Then the agent's session is created with that MCP server

  @s-mcp-unsupported-transport-preflight
  Scenario: An MCP transport the agent cannot take fails preflight
    Given a workflow declaring a remote MCP server and a node using the opencode runner
    And the agent's handshake advertises only local MCP servers
    When the workflow runs
    Then the run fails at preflight naming the agent and the unsupported MCP transport
    And no node executes

  @s-no-mcp-key-no-forwarding
  Scenario: Without an MCP block nothing is forwarded
    Given a workflow with no MCP block and a node using the opencode runner
    When the workflow runs
    Then the agent's session is created with no MCP servers

  @s-allowed-tools-warns-ignored
  Scenario: allowed_tools is warned about and ignored
    Given a workflow node using the opencode runner with an allowed_tools list
    When the workflow runs
    Then a warning states the setting is ignored by this runner
    And the node still executes

  @s-permission-mode-noop
  Scenario: permission_mode is silently ignored
    Given a workflow node using the opencode runner with a permission_mode set
    When the workflow runs
    Then no warning about permission_mode is printed
    And the node executes normally
