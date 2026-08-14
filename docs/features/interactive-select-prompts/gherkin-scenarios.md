# interactive-select-prompts — contract

Every scenario has exactly one owning task (see [tasks.md](./tasks.md)).
"An interactive terminal" means stdin **and** stdout are TTYs.

## Feature: Terminal list prompts

```gherkin
@s-list-at-terminal
Scenario: A pause at an interactive terminal is a navigable list
  Given a run pauses and needs an answer from the human
  And stdin and stdout are an interactive terminal
  When the pause is presented
  Then the answers appear as a list the human moves a selection through
  And no letter menu and no numbered menu is written to the output
  And the run continues only after one entry is confirmed

@s-list-no-menu-when-piped
Scenario: A pause with piped replies draws no menu at all
  Given a run pauses and needs an answer from the human
  And stdin is not an interactive terminal but a reply line is available
  When the pause is presented
  Then no list, no letter menu and no numbered menu is written to the output
  And the reply line alone decides the answer

@s-list-stdin-closed-fails
Scenario: A pause nobody can answer fails the node
  Given a run pauses and needs an answer from the human
  And stdin is closed with no reply line available
  Then the node fails with the existing stdin-closed error and hint
  And the run halts and is resumable
  And the run neither auto-approves the pause nor exits with success

@s-list-serialized-across-branches
Scenario: Two concurrent branches never interleave their pauses
  Given two nodes in different branches pause at the same time
  Then only one pause owns the terminal at a time
  And each pause names the node it belongs to
  And a follow-up text entry belongs to the same pause that asked for it
  And neither node's timeout counts the time spent waiting or queued

@s-list-interrupt
Scenario: Ctrl-C at a list interrupts the run as it always has
  Given a list prompt is waiting for a selection
  When the human interrupts with Ctrl-C
  Then every subprocess the run spawned is terminated
  And the process exits with the interrupt status it used before this change

@s-list-longer-than-terminal
Scenario: A list taller than the terminal stays fully reachable
  Given a pause offers more entries than the terminal has rows
  When the human moves the selection past the last visible entry
  Then the list scrolls and every entry can be selected

@s-windows-installable
Scenario: sao can be installed on Windows
  Given a Windows machine with a supported Node runtime
  When the package metadata is inspected
  Then it does not restrict installation to macOS and Linux
  And it declares the raised minimum Node version the list prompt needs

@s-windows-prompt-portable
Scenario: Nothing on the prompt path is locked to a POSIX platform
  Given the code that presents a pause and handles its selection or interrupt
  Then it uses no facility unavailable on Windows
  And a documented manual smoke check records the list prompt answering a gate
    in a Windows terminal
  # No Windows CI job — see spec.md decision 8 for the scope of this guarantee.

@s-old-renderings-gone
Scenario: The old renderings exist nowhere
  Given the shipped source and the output of any run
  Then the letter prompt "[a]pprove / [r]eject / or type feedback" appears nowhere,
    neither at a gate nor at an interactive-loop iteration
  And a numbered permission menu such as "1. Allow" appears nowhere
  And this holds for first asks and for re-asks after an unusable reply
```

## Feature: Gate nodes

```gherkin
@s-gate-approve
Scenario: Approving a gate from the list
  Given a gate node pauses at an interactive terminal
  Then the list offers approve, reject and give-feedback
  When the human confirms approve
  Then the node succeeds and the run continues

@s-gate-reject
Scenario: Rejecting a gate from the list
  Given a gate node pauses at an interactive terminal
  When the human confirms reject
  Then the node and the run are marked rejected
  And resuming the run asks the same gate again

@s-gate-feedback
Scenario: Choosing give-feedback collects the text
  Given a gate node pauses at an interactive terminal
  When the human confirms give-feedback
  Then a text entry is collected for the same gate
  And the entered text becomes the node's output
  And the run continues

@s-gate-feedback-keeps-verdict-words
Scenario: Feedback text that reads like a verdict stays text
  Given a gate node pauses at an interactive terminal
  And the human has confirmed give-feedback
  When the text they enter is a word the piped path treats as a verdict,
    such as "yes" or "approve"
  Then that word becomes the node's output as written
  And the gate is neither approved nor rejected by it

@s-gate-piped-unchanged
Scenario: Piped gate replies keep the vocabulary they have today
  Given a gate node pauses with replies arriving as piped lines
  When a reply of "a", "approve", "y" or "yes" arrives
  Then the gate is approved
  When instead a reply of "r", "reject", "n" or "no" arrives
  Then the run is rejected
  When instead any other non-empty line arrives
  Then that line becomes the node's output as feedback
```

## Feature: ACP permission requests

```gherkin
@s-perm-agent-options-listed
Scenario: A permission request lists the agent's own options
  Given an ACP agent requests permission during an AI node
  And the run is at an interactive terminal
  Then the pause names the node and what the agent wants to do
  And the list holds one entry per option the agent sent, in the order sent
  And the list holds nothing sao invented

@s-perm-selection-sent-verbatim
Scenario: The chosen permission option is returned verbatim
  Given a permission request is presented as a list
  When the human confirms one entry
  Then that option's identifier is sent back to the agent unchanged
  And sao remembers nothing about the choice for later requests

@s-perm-nothing-sent-until-chosen
Scenario: Nothing reaches the agent before a choice is made
  Given a permission request is waiting for an answer
  Then no permission outcome has been sent to the agent
  And the AI node's timeout is not counting the time spent waiting

@s-perm-piped-index
Scenario: A piped permission reply may still name an option by number
  Given a permission request with replies arriving as piped lines
  When a line holding a valid 1-based index arrives
  Then the option at that position is chosen

@s-perm-piped-option-id
Scenario: A piped permission reply may name an option by its identifier
  Given a permission request with replies arriving as piped lines
  When a line exactly matching one option's identifier arrives
  Then that option is chosen

@s-perm-piped-invalid-reasks
Scenario: An unusable piped permission reply asks again
  Given a permission request with replies arriving as piped lines
  When a line that is neither a valid index nor an option identifier arrives
  Then nothing is sent to the agent and the reply is asked for again
  And no menu is written to the output

@s-perm-no-terminal-fails
Scenario: A permission request with no way to answer fails the node
  Given an ACP agent requests permission
  And stdin is closed with no reply line available
  Then the AI node fails the same way a gate does
  And the request is never auto-approved
```

## Feature: Declaring options in agent output

```gherkin
@s-options-parsed
Scenario: A well-formed declaration is read from the agent's output
  Given an agent's final output holds an options block of JSON objects
  And each object has a unique non-empty id and a non-empty label
  Then those options are read in the order declared
  And an object's optional description is kept for display

@s-options-last-block-wins
Scenario: The last declaration in the output is the one that counts
  Given an agent's output holds more than one options block
  Then only the last block is read

@s-options-malformed-ignored
Scenario: A declaration that cannot be read yields no options
  Given an agent's output holds an options block whose content is not valid JSON
  Then no options are read and nothing throws
  And the same holds when the closing tag is missing

@s-options-invalid-shape-ignored
Scenario: A declaration of the wrong shape yields no options
  Given an agent's output holds an options block that is not an array of objects
  Then no options are read
  And the same holds for an empty array, a missing or empty id or label,
    a duplicate id, and an id using the prefix sao reserves for its own entries

@s-options-absent
Scenario: Output with no declaration yields no options
  Given an agent's final output holds no options block
  Then no options are read
```

## Feature: Interactive loops

```gherkin
@s-loop-instruction-appended
Scenario: Only interactive loops invite the agent to declare options
  Given an interactive loop node
  Then every iteration's prompt carries the instruction for declaring options
    alongside the sentinel instruction
  Given a loop node that is not interactive
  Then no iteration's prompt carries the instruction for declaring options

@s-loop-options-listed
Scenario: An iteration presents the agent's own options
  Given an interactive loop iteration whose agent declared options
  And the run is at an interactive terminal
  Then the list holds the agent's options first, in the order declared
  And the run's own entries follow them
  And this is so whichever runner the node uses, with nothing runner-specific
    declared in the workflow

@s-loop-option-feeds-label
Scenario: Choosing an agent option feeds its label to the next iteration
  Given an iteration presenting the agent's declared options
  When the human confirms one of them
  Then the next iteration runs with that option's label as the loop feedback
  And the identifier is not what the next iteration sees

@s-loop-end-entry-only-when-signaled
Scenario: The end-the-loop entry appears only when it can work
  Given an interactive loop iteration whose agent emitted the loop's signal
  Then the list offers an entry that ends the loop
  When the human confirms it
  Then the loop node succeeds with that iteration's output
  Given instead an iteration where the agent did not emit the signal
  Then the list offers no entry that ends the loop

@s-loop-feedback-entry
Scenario: The human can always answer with something unanticipated
  Given an interactive loop iteration at an interactive terminal
  Then the list offers an entry for writing feedback, options declared or not
  When the human confirms it
  Then a text entry is collected for the same iteration
  And the next iteration runs with that text as the loop feedback

@s-loop-feedback-keeps-verdict-words
Scenario: Loop feedback text that reads like a verdict stays text
  Given an interactive loop iteration at an interactive terminal
  And the human has confirmed the write-feedback entry
  When the text they enter is a word the piped path treats as a verdict,
    such as "approve" or "reject"
  Then the next iteration runs with that word as the loop feedback
  And the loop neither ends nor halts because of it

@s-loop-reject-entry
Scenario: The halt path survives at every iteration
  Given an interactive loop iteration at an interactive terminal
  Then the list offers an entry that rejects and halts the run
  When the human confirms it
  Then the node and the run are marked rejected
  And resuming the run pauses for the same decision again

@s-loop-no-options-fallback
Scenario: An agent that declares nothing behaves exactly as before
  Given an interactive loop iteration whose agent declared no options
  Then the list holds only the run's own entries
  And the iteration behaves as it did before this change

@s-loop-malformed-fallback
Scenario: A malformed declaration never swallows the iteration
  Given an interactive loop iteration whose agent's options block cannot be read
  Then a warning naming the node is recorded on the node's log
  And the pause is still presented as a list of the run's own entries
  And the run continues to a human decision rather than failing

@s-loop-piped-option-id
Scenario: A piped reply may name a declared option by its identifier
  Given an interactive loop iteration whose agent declared options
  And replies arrive as piped lines
  When a line exactly matching one option's identifier arrives
  Then the next iteration runs with that option's label as the loop feedback

@s-loop-piped-verdict-precedence
Scenario: A verdict word beats an option identifier that looks like one
  Given an interactive loop iteration whose agent declared an option
    whose identifier is a word the loop already treats as a verdict
  And replies arrive as piped lines
  When that word arrives as a reply
  Then it acts as the verdict, not as a selection of the agent's option

@s-loop-piped-unsignaled-approve-reasks
Scenario: A piped approve on an unsignaled iteration still asks again
  Given an interactive loop iteration where the agent did not emit the signal
  And replies arrive as piped lines
  When an approve reply arrives
  Then the loop does not end and the reply is asked for again

@s-loop-piped-freeform-is-feedback
Scenario: A piped line that names nothing is feedback, as today
  Given an interactive loop iteration with replies arriving as piped lines
  When a line matching no verdict word and no declared identifier arrives
  Then the next iteration runs with that line as the loop feedback
```
