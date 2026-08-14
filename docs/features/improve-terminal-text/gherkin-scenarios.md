# improve-terminal-text — contract

Every `@s` tag below is owned by exactly one task in [`tasks.md`](./tasks.md).
"An interactive terminal" means both stdin and stdout are TTYs; "piped" means either
is not.

```gherkin
Feature: a readable question when a run pauses

  # ── Slice 1 · task-1 — the pause block's text ──────────────────────────

  @s-render-emphasis
  Scenario: emphasis and inline code become styling, not literal characters
    Given an agent message containing "**bold**", "*italic*" and "`code`"
    When the pause block for that message is produced
    Then the words appear without their surrounding asterisks or backticks
    And each carries terminal styling distinguishing it from plain text

  @s-render-headings-lists
  Scenario: headings and lists become formatting
    Given an agent message with an ATX heading, a "-" bullet list and a "1." list
    When the pause block for that message is produced
    Then the heading appears without its leading "#" characters
    And each list item appears as a formatted item rather than raw markdown

  @s-render-fenced-code
  Scenario: a fenced code block keeps its contents verbatim
    Given an agent message containing a fenced code block whose body includes "**not bold**"
    When the pause block for that message is produced
    Then the fence markers do not appear
    And the body appears unchanged, with its asterisks intact

  @s-render-passthrough
  Scenario: markdown outside the supported subset is left as literal text
    Given an agent message containing a pipe table and a nested list
    When the pause block for that message is produced
    Then that text appears exactly as the agent wrote it, unmangled

  @s-render-no-color
  Scenario: with color disabled the block is plain readable text
    Given color output is disabled
    When the pause block for a message with emphasis and headings is produced
    Then it contains no escape sequences
    And the markdown syntax characters are still removed

  @s-strip-options-block
  Scenario: every well-formed options declaration is removed
    Given an agent message that ends with an options declaration
    And a second options declaration earlier in the same message
    When the pause block for that message is produced
    Then neither declaration appears in it

  @s-strip-options-unclosed
  Scenario: an options declaration with no closing tag stays visible
    Given an agent message containing an opening options tag and no closing tag
    When the pause block for that message is produced
    Then that text is still present, as ordinary text

  @s-strip-promise-any
  Scenario: any promise token is removed regardless of its name
    Given an agent message containing a promise token for an arbitrary signal name
    When the pause block for that message is produced
    Then the token does not appear in it

  @s-strip-reports-signal-names
  Scenario: producing the block reports which signal names were removed
    Given an agent message containing promise tokens for two different signal names
    When the pause block for that message is produced
    Then both removed signal names are reported alongside the block

  # ── Slice 1 · task-2 — where the block is drawn ────────────────────────

  @s-block-boxed-at-tty
  Scenario: at an interactive terminal the block is a titled box above the list
    Given an interactive terminal
    When a pause is presented with a block and a list of choices
    Then the block's text appears inside a bordered box titled with the node id
    And the box is written before the list of choices
    And none of the block's lines carry the dim node-and-iteration prefix

  @s-block-absent-when-piped
  Scenario: the piped path writes no block at all
    Given a piped reply channel
    When a pause is presented with a block and a list of choices
    Then nothing from the block is written to the terminal
    And the bytes written are the same as for a pause carrying no block

  @s-block-atomic-with-its-list
  Scenario: a block is never split from its own list by another pause
    Given an interactive terminal
    And two nodes pausing concurrently, each with its own block
    When both pauses are presented
    Then the first block and its list are written before anything of the second

  @s-permission-prompt-unchanged
  Scenario: an ACP permission prompt is unaffected
    Given an interactive terminal
    When an agent requests permission mid-node
    Then the prompt names the node and offers the agent's options in the order sent
    And no box is drawn for it

  @s-block-ctrl-c-unchanged
  Scenario: Ctrl-C at a pause showing a block still interrupts the run
    Given an interactive terminal presenting a pause with a block
    When the human presses Ctrl-C
    Then the run exits through the existing interrupt path

  # ── Slice 1 · task-3 — the interactive-loop pause ──────────────────────

  @s-loop-question-in-block
  Scenario: an interactive loop iteration shows the agent's message as the block
    Given an interactive terminal
    And an interactive loop whose agent answers with markdown, an options declaration and a promise token
    When the iteration pauses
    Then the agent's message appears once, rendered, inside the titled box
    And no options declaration and no promise token appear anywhere on the terminal

  @s-loop-pause-line-unchanged
  Scenario: the pause line still reports the signal state
    Given an interactive terminal
    When an iteration pauses whose agent emitted the loop's signal
    Then the pause line reports that the agent signaled it
    And when the agent emitted no signal the pause line reports no signal yet

  @s-loop-options-order-preserved
  Scenario: the picker still offers the agent's declared options
    Given an interactive terminal
    And an agent that declared three options
    When the iteration pauses
    Then the list offers exactly those three, in the order declared, ahead of the run's own entries

  @s-loop-empty-message
  Scenario: an empty agent message still reaches a usable pause
    Given an interactive terminal
    And an iteration whose agent produced no text
    When the iteration pauses
    Then no box is drawn
    And a dim line states that the agent sent no text
    And the list of choices is offered as usual

  @s-loop-message-only-marker
  Scenario: a message that is nothing but markers behaves as an empty one
    Given an interactive terminal
    And an iteration whose agent produced only an options declaration and a promise token
    When the iteration pauses
    Then no box is drawn
    And a dim line states that the agent sent no text

  @s-loop-unexpected-signal-warning
  Scenario: a promise token with an unexpected name is reported
    Given an interactive terminal
    And an interactive loop expecting one signal name
    When the iteration's agent emits a promise token for a different name
    Then a dim warning names both the emitted and the expected signal
    And the pause line still reports no signal yet
    And the run does not halt

  @s-loop-options-warning-kept
  Scenario: an unreadable options declaration still warns and falls back
    Given an interactive loop whose agent emits an options declaration that cannot be read
    When the iteration pauses
    Then a warning naming the node is recorded on the iteration's log
    And the pause offers only the run's own entries

  @s-loop-piped-unchanged
  Scenario: a piped interactive loop is byte-for-byte unchanged
    Given a piped reply channel
    When an iteration pauses whose agent declared options and emitted a promise token
    Then the terminal output is identical to the behaviour before this feature, markers included
    And replying with a declared option's exact id still feeds that option's label to the next iteration

  @s-loop-log-verbatim
  Scenario: the iteration log keeps the raw output
    Given an interactive terminal
    When an iteration pauses
    Then the iteration's log file contains the agent's output verbatim, markers and markdown syntax intact
    And it contains no formatting escape sequences

  @s-resume-pause-identical
  Scenario: a resumed run displays the question the same way
    Given an interactive terminal
    And a halted run resumed at an interactive loop
    When the loop pauses
    Then the question is displayed exactly as on a first run

  # ── Slice 2 · task-4 — the message appears exactly once ────────────────
  # A runner declares how it streams its final output; the final message is then
  # identified by matching the iteration's reported output against the withheld text.

  @s-runner-granularity-declared
  Scenario: the shipped runners declare how they stream their final output
    Given the runners sao ships with
    Then the claude and codex runners declare that they stream one complete message at a time
    And the opencode runner declares that its reported output is the whole turn

  @s-runner-granularity-defaults
  Scenario: a runner that declares nothing gets the conservative behaviour
    Given an interactive terminal
    And a runner that makes no declaration about its streaming
    When an iteration produces text and pauses
    Then it is treated as a whole-turn runner
    And its final message still appears exactly once

  @s-question-appears-once-per-message
  Scenario: a per-message runner's final message is not also streamed
    Given an interactive terminal
    And a runner declaring per-message streaming, its last message being the reported output
    When an iteration produces narration and then its final message
    Then the final message text appears on the terminal only inside the box

  @s-question-appears-once-whole-turn
  Scenario: a whole-turn runner shows its text only in the box
    Given an interactive terminal
    And a runner declaring whole-turn streaming, sending many partial chunks
    When an iteration produces text and pauses
    Then none of that text is echoed as dim prefixed lines
    And all of it appears once inside the box

  @s-narration-still-streams
  Scenario: a per-message runner's narration still scrolls live
    Given an interactive terminal
    And a runner declaring per-message streaming
    When an iteration produces two narration messages and then its final message
    Then the first narration message is echoed with its dim node-and-iteration prefix before the second arrives
    And every narration message is echoed, in the order the agent produced it
    And all of it is echoed before the block is drawn

  @s-repeated-text-keeps-earlier-copy
  Scenario: only the last occurrence of the final message is withheld
    Given an interactive terminal
    And an iteration whose agent emits the same text twice, the second being its final message
    When the iteration pauses
    Then the earlier copy is still echoed as dim prefixed lines
    And the box shows that text once

  @s-withheld-remainder-released
  Scenario: withheld text that is not part of the final message is still echoed
    Given an interactive terminal
    And an iteration whose runner also writes diagnostics to its error stream
    When the iteration pauses
    Then those diagnostics are echoed as dim prefixed lines
    And they are not swallowed by the withholding

  @s-withheld-released-on-failure
  Scenario: a failing iteration releases what was withheld
    Given an interactive terminal
    And an iteration whose runner fails after producing output
    When the node fails
    Then the withheld output is echoed rather than discarded
    And the failure is reported as it is today

  @s-no-withholding-when-piped
  Scenario: piped runs withhold nothing
    Given a piped reply channel
    When an interactive loop iteration streams its output
    Then every chunk is echoed as it arrives, exactly as before this feature

  # ── Slice 3 · task-5 — gate pauses ─────────────────────────────────────

  @s-gate-message-in-block
  Scenario: a gate's message is rendered inside the same box
    Given an interactive terminal
    And a gate whose message contains markdown
    When the gate pauses
    Then the message appears rendered inside a box titled with the gate's node id
    And the approve / reject / feedback list is offered below it

  @s-gate-strips-markers
  Scenario: a gate message carrying an interpolated marker is cleaned
    Given a gate whose message interpolates a loop node's output containing a promise token
    When the gate pauses at an interactive terminal
    Then no promise token appears on the terminal

  @s-gate-piped-unchanged
  Scenario: a piped gate is unchanged
    Given a piped reply channel
    When a gate pauses
    Then no box is written
    And the existing reply vocabulary decides the verdict exactly as before
```
