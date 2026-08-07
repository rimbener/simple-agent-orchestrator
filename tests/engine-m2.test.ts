import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightAiConfigs, runWorkflow, sentinelInstruction, sentinelToken } from "../src/engine";
import { SaoError } from "../src/errors";
import { loadWorkflow } from "../src/parser";
import type { Runner, RunnerRequest } from "../src/runners/types";

const quiet = () => {};

function setup(yaml: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "sao-m2-"));
  const path = join(dir, "workflow.yaml");
  writeFileSync(path, yaml);
  return { dir, path };
}

function agentDir(dir: string, agents: Record<string, string>): void {
  mkdirSync(join(dir, ".agents", "agents"), { recursive: true });
  for (const [name, content] of Object.entries(agents)) {
    writeFileSync(join(dir, ".agents", "agents", `${name}.md`), content);
  }
}

/** Runner returning scripted outputs per call; records every request. */
function scriptedRunner(outputs: string[], calls: RunnerRequest[] = []): Runner {
  let call = 0;
  return {
    name: "scripted",
    async run(req) {
      calls.push(req);
      const output = outputs[Math.min(call, outputs.length - 1)]!;
      call++;
      return { output, sessionId: `session-${call}`, exitCode: 0 };
    },
  };
}

/** promptUser returning scripted replies in order; records every question. */
function scriptedPrompts(replies: string[], questions: string[] = []) {
  let i = 0;
  return async (message: string) => {
    questions.push(message);
    if (i >= replies.length) throw new Error("promptUser called more times than scripted");
    return replies[i++]!;
  };
}

function run(
  path: string,
  dir: string,
  extra: Partial<Parameters<typeof runWorkflow>[0]> = {},
): ReturnType<typeof runWorkflow> {
  return runWorkflow({
    workflow: loadWorkflow(path, { cwd: dir }),
    workflowPath: path,
    task: "",
    vars: {},
    cwd: dir,
    print: quiet,
    ...extra,
  });
}

describe("sentinel loops", () => {
  test("exits when the agent emits the signal; iterations and output recorded", async () => {
    const { dir, path } = setup(`
name: sentinels
nodes:
  - id: work
    loop:
      prompt: "iteration {{loop.iteration}}"
      until: DONE
      max_iterations: 5
`);
    const calls: RunnerRequest[] = [];
    const runner = scriptedRunner(["not yet", "still no", `finished ${sentinelToken("DONE")}`], calls);
    const state = await run(path, dir, { resolveRunner: () => runner });
    expect(state.status).toBe("succeeded");
    expect(state.nodes["work"]!.iterations).toBe(3);
    expect(state.nodes["work"]!.output).toContain("finished");
    expect(calls).toHaveLength(3);
    expect(calls[0]!.prompt).toContain("iteration 1");
    expect(calls[2]!.prompt).toContain("iteration 3");
    expect(calls[0]!.cwd).toBe(dir); // loop iterations execute in the run cwd
    expect(Object.hasOwn(state.nodes["work"]!, "lastFeedback")).toBe(false); // non-interactive loops record none
  });

  test("the engine appends the exact sentinel instruction to every iteration prompt", async () => {
    const { dir, path } = setup(`
name: instr
nodes:
  - id: work
    loop:
      prompt: "do it"
      until: ALL_TASKS_COMPLETE
      max_iterations: 2
`);
    const calls: RunnerRequest[] = [];
    await run(path, dir, { resolveRunner: () => scriptedRunner([sentinelToken("ALL_TASKS_COMPLETE")], calls) });
    expect(calls[0]!.prompt).toBe("do it" + sentinelInstruction("ALL_TASKS_COMPLETE"));
    // Literal contract (SPEC: Loop semantics) — not derived from sentinelInstruction,
    // so a mutated instruction template cannot hide behind its own test.
    expect(calls[0]!.prompt).toContain(
      'If and only if the condition "ALL_TASKS_COMPLETE" is fully satisfied, end your response with exactly <promise>ALL_TASKS_COMPLETE</promise>. Otherwise, do not emit that token anywhere.',
    );
  });

  test("exhausting max_iterations fails the node with the signal named and the escalation hint", async () => {
    const { dir, path } = setup(`
name: exhausted
nodes:
  - id: work
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 2
`);
    try {
      await run(path, dir, { resolveRunner: () => scriptedRunner(["nope"]) });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toContain("loop hit max_iterations (2) without signal DONE");
      expect((err as SaoError).hint).toContain("escalation point");
    }
  });

  test("a stray <promise>undefined</promise> in output never counts as a signal for until_bash loops", async () => {
    const { dir, path } = setup(`
name: straytoken
nodes:
  - id: work
    loop:
      prompt: "go"
      until_bash: "false"
      max_iterations: 2
`);
    const runner = scriptedRunner(["weird output <promise>undefined</promise>"]);
    await expect(run(path, dir, { resolveRunner: () => runner })).rejects.toThrow(
      "max_iterations (2) without until_bash passing",
    );
  });

  test("streamed output without a trailing newline is still echoed when the iteration ends", async () => {
    const { dir, path } = setup(`
name: tailecho
nodes:
  - id: work
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 1
`);
    const runner: Runner = {
      name: "streamy",
      async run(req) {
        req.onOutput?.("tail-without-newline");
        return { output: sentinelToken("DONE"), exitCode: 0 };
      },
    };
    const printed: string[] = [];
    await run(path, dir, { resolveRunner: () => runner, print: (line) => printed.push(line) });
    expect(printed.some((line) => line.includes("tail-without-newline"))).toBe(true);
  });

  test("loop failure hints point at the iteration log, not <id>.log", async () => {
    const { dir, path } = setup(`
name: loghint
nodes:
  - id: work
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 2
`);
    try {
      await run(path, dir, { resolveRunner: () => scriptedRunner(["nope"]) });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).hint).toContain(join("logs", "work.2.log"));
    }
  });

  test("fresh_context: true starts every iteration without a session", async () => {
    const { dir, path } = setup(`
name: fresh
nodes:
  - id: work
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 3
`);
    const calls: RunnerRequest[] = [];
    await run(path, dir, { resolveRunner: () => scriptedRunner(["a", "b", sentinelToken("DONE")], calls) });
    expect(calls.map((c) => c.resumeSessionId)).toEqual([undefined, undefined, undefined]);
  });

  test("fresh_context: false resumes the previous iteration's session", async () => {
    const { dir, path } = setup(`
name: resume
nodes:
  - id: work
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 3
      fresh_context: false
`);
    const calls: RunnerRequest[] = [];
    await run(path, dir, { resolveRunner: () => scriptedRunner(["a", "b", sentinelToken("DONE")], calls) });
    expect(calls.map((c) => c.resumeSessionId)).toEqual([undefined, "session-1", "session-2"]);
  });

  test("iteration logs are written per iteration", async () => {
    const { dir, path } = setup(`
name: iterlogs
nodes:
  - id: work
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 3
`);
    const state = await run(path, dir, {
      resolveRunner: () => scriptedRunner(["one", `two ${sentinelToken("DONE")}`]),
    });
    const logs = join(dir, ".sao", "runs", state.id, "logs");
    expect(existsSync(join(logs, "work.1.log"))).toBe(true);
    expect(existsSync(join(logs, "work.2.log"))).toBe(true);
    expect(existsSync(join(logs, "work.3.log"))).toBe(false);
  });
});

describe("until_bash loops", () => {
  test("exits when the predicate passes, and only then", async () => {
    const { dir, path } = setup(`
name: untilbash
nodes:
  - id: work
    loop:
      steps:
        - bash: "echo tick | tee -a count.txt"
      until_bash: "test $(wc -l < count.txt) -ge 2"
      max_iterations: 5
`);
    const printed: string[] = [];
    const state = await run(path, dir, { print: (line) => printed.push(line) });
    expect(state.status).toBe("succeeded");
    expect(state.nodes["work"]!.iterations).toBe(2);
    expect(state.nodes["work"]!.output).toBe("tick"); // last executed step's tail
    expect(readFileSync(join(dir, "count.txt"), "utf8").trim().split("\n")).toHaveLength(2);
    // Iteration echoes carry the <id>#<iteration> label.
    expect(printed.some((line) => line.includes("[work#1]") && line.includes("tick"))).toBe(true);
  });

  test("a prompt-form until_bash loop sends the prompt verbatim — no sentinel instruction", async () => {
    const { dir, path } = setup(`
name: promptuntilbash
nodes:
  - id: work
    loop:
      prompt: "tally {{loop.iteration}}"
      until_bash: "test -f stop-now"
      max_iterations: 3
`);
    writeFileSync(join(dir, "stop-now"), "");
    const calls: RunnerRequest[] = [];
    const state = await run(path, dir, { resolveRunner: () => scriptedRunner(["counted"], calls) });
    expect(state.status).toBe("succeeded");
    expect(calls[0]!.prompt).toBe("tally 1"); // exactly — no <promise> instruction appended
    expect(state.nodes["work"]!.output).toBe("counted");
  });

  test("an iteration whose steps were all skipped yields an empty output, not stale text", async () => {
    const { dir, path } = setup(`
name: allskipped
nodes:
  - id: work
    loop:
      steps:
        - when_bash: "false"
          bash: "echo never"
      until_bash: "true"
      max_iterations: 3
`);
    const state = await run(path, dir);
    expect(state.status).toBe("succeeded");
    expect(state.nodes["work"]!.output).toBe("");
  });

  test("a never-passing predicate exhausts max_iterations", async () => {
    const { dir, path } = setup(`
name: neverpass
nodes:
  - id: work
    loop:
      steps:
        - bash: "true"
      until_bash: "false"
      max_iterations: 2
`);
    await expect(run(path, dir)).rejects.toThrow("loop hit max_iterations (2) without until_bash passing");
  });
});

describe("steps loops", () => {
  test("runs steps in order with per-step configs; sentinel instruction only on the last AI step", async () => {
    const { dir, path } = setup(`
name: steps
nodes:
  - id: cycle
    loop:
      steps:
        - prompt: "build"
        - bash: "echo checked"
        - prompt: "review"
      until: CLEAN
      max_iterations: 2
`);
    const calls: RunnerRequest[] = [];
    const runner = scriptedRunner(["built", `ok ${sentinelToken("CLEAN")}`], calls);
    const state = await run(path, dir, { resolveRunner: () => runner });
    expect(state.status).toBe("succeeded");
    expect(state.nodes["cycle"]!.iterations).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.prompt).toBe("build"); // no instruction on a non-final AI step
    expect(calls[0]!.cwd).toBe(dir);
    expect(calls[1]!.prompt).toBe("review" + sentinelInstruction("CLEAN"));
    expect(state.nodes["cycle"]!.output).toContain("ok"); // last AI step's output
  });

  test("a failing bash step fails the whole loop node", async () => {
    const { dir, path } = setup(`
name: stepfail
nodes:
  - id: cycle
    loop:
      steps:
        - prompt: "build"
        - bash: "exit 9"
      until: CLEAN
      max_iterations: 2
`);
    await expect(run(path, dir, { resolveRunner: () => scriptedRunner(["x"]) })).rejects.toThrow(
      "command exited with code 9",
    );
  });

  test("when_bash-skipped steps do not run; a skipped sentinel step means the iteration cannot signal", async () => {
    const { dir, path } = setup(`
name: skipsteps
nodes:
  - id: cycle
    loop:
      steps:
        - prompt: "review"
        - when_bash: "false"
          prompt: "fix"
      until: CLEAN
      max_iterations: 2
`);
    const calls: RunnerRequest[] = [];
    // The un-instructed review step emits the token — it must NOT count as a signal.
    const runner = scriptedRunner([`sneaky ${sentinelToken("CLEAN")}`], calls);
    const printed: string[] = [];
    await expect(run(path, dir, { resolveRunner: () => runner, print: (line) => printed.push(line) })).rejects.toThrow(
      "max_iterations",
    );
    // Only the review step ran, twice (two iterations), never the skipped fix step.
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.prompt.startsWith("sneaky") || c.prompt === "review")).toBe(true);
    expect(printed.some((line) => line.includes("⊘ cycle step #2") && line.includes("(skipped by when_bash)"))).toBe(true);
  });

  test("a sentinel loop ending on a bash step signals via the AI step and keeps the AI output", async () => {
    const { dir, path } = setup(`
name: bashlast
nodes:
  - id: cycle
    loop:
      steps:
        - prompt: "review"
        - bash: "echo bash-tail"
      until: DONE
      max_iterations: 2
`);
    const calls: RunnerRequest[] = [];
    const runner = scriptedRunner([`fine ${sentinelToken("DONE")}`], calls);
    const state = await run(path, dir, { resolveRunner: () => runner });
    expect(state.status).toBe("succeeded");
    // The AI step is the last AI step, so it carries the instruction…
    expect(calls[0]!.prompt).toBe("review" + sentinelInstruction("DONE"));
    // …and the node's output is the AI step's, not the trailing bash tail.
    expect(state.nodes["cycle"]!.output).toContain("fine");
    expect(state.nodes["cycle"]!.output).not.toContain("bash-tail");
  });

  test("until_bash steps loops send AI prompts verbatim — no sentinel instruction", async () => {
    const { dir, path } = setup(`
name: stepsnountil
nodes:
  - id: cycle
    loop:
      steps:
        - prompt: "work"
      until_bash: "true"
      max_iterations: 3
`);
    const calls: RunnerRequest[] = [];
    await run(path, dir, { resolveRunner: () => scriptedRunner(["done"], calls) });
    expect(calls[0]!.prompt).toBe("work");
  });

  test("a step whose when_bash passes runs normally", async () => {
    const { dir, path } = setup(`
name: passingstep
nodes:
  - id: cycle
    loop:
      steps:
        - when_bash: "true"
          prompt: "work"
      until: DONE
      max_iterations: 2
`);
    const calls: RunnerRequest[] = [];
    const state = await run(path, dir, { resolveRunner: () => scriptedRunner([`ok ${sentinelToken("DONE")}`], calls) });
    expect(state.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
  });

  test("step-level agent and model override the loop node's", async () => {
    const { dir, path } = setup(`
name: stepagents
defaults:
  model: default-model
nodes:
  - id: cycle
    agent: node_agent
    model: node-model
    loop:
      steps:
        - prompt: "uses node agent"
        - agent: step_agent
          prompt: "uses step agent"
      until: DONE
      max_iterations: 1
`);
    agentDir(dir, {
      node_agent: "---\nmodel: node-agent-model\npermission_mode: plan\n---\nnode persona",
      step_agent: "---\n---\nstep persona",
    });
    const calls: RunnerRequest[] = [];
    const runner = scriptedRunner([sentinelToken("DONE")], calls);
    const state = await run(path, dir, { resolveRunner: () => runner });
    expect(state.status).toBe("succeeded"); // final AI step emits the token
    // Step 1: node-level model beats node-agent model; node agent's persona applies.
    expect(calls[0]!.model).toBe("node-model");
    expect(calls[0]!.systemPrompt).toBe("node persona");
    // Step 2: step agent persona wins; model cascades past the absent step-agent
    // model to the node's; node-agent's permission_mode still cascades.
    expect(calls[1]!.systemPrompt).toBe("step persona");
    expect(calls[1]!.model).toBe("node-model");
    expect(calls[1]!.permissionMode).toBe("plan");
  });
});

describe("interactive loops", () => {
  test("pauses every iteration; feedback threads into {{loop.feedback}}; bare approve on a signaled iteration ends it", async () => {
    const { dir, path } = setup(`
name: interactive
nodes:
  - id: grill
    loop:
      prompt: "ask; feedback: [{{loop.feedback}}]"
      until: SETTLED
      max_iterations: 5
      interactive: true
`);
    const calls: RunnerRequest[] = [];
    const runner = scriptedRunner(["question one?", `done ${sentinelToken("SETTLED")}`], calls);
    const questions: string[] = [];
    const state = await run(path, dir, {
      resolveRunner: () => runner,
      promptUser: scriptedPrompts(["blue, not red", "a"], questions),
    });
    expect(state.status).toBe("succeeded");
    expect(state.nodes["grill"]!.iterations).toBe(2);
    expect(state.nodes["grill"]!.output).toContain("done");
    expect(state.nodes["grill"]!.lastFeedback).toBe("blue, not red"); // persisted for M3 resume
    expect(calls[0]!.prompt).toContain("feedback: []");
    expect(calls[1]!.prompt).toContain("feedback: [blue, not red]");
    expect(questions[0]).toContain("no signal yet");
    expect(questions[1]).toContain("agent signaled SETTLED");
  });

  test("empty replies at the loop gate re-ask instead of becoming feedback", async () => {
    const { dir, path } = setup(`
name: emptyloopreply
nodes:
  - id: grill
    loop:
      prompt: "ask"
      until: SETTLED
      max_iterations: 3
      interactive: true
`);
    const calls: RunnerRequest[] = [];
    const runner = scriptedRunner([`ok ${sentinelToken("SETTLED")}`], calls);
    const questions: string[] = [];
    const state = await run(path, dir, {
      resolveRunner: () => runner,
      promptUser: scriptedPrompts(["", "   ", "a"], questions),
    });
    expect(state.status).toBe("succeeded");
    expect(questions).toHaveLength(3); // two re-asks, then the approve
    expect(calls).toHaveLength(1); // never advanced an iteration on an empty reply
  });

  test("approving an unsignaled iteration re-asks instead of ending the loop", async () => {
    const { dir, path } = setup(`
name: eagerapprove
nodes:
  - id: grill
    loop:
      prompt: "ask"
      until: SETTLED
      max_iterations: 3
      interactive: true
`);
    const runner = scriptedRunner(["no signal here", `yes ${sentinelToken("SETTLED")}`]);
    const questions: string[] = [];
    const printed: string[] = [];
    const state = await run(path, dir, {
      resolveRunner: () => runner,
      // iteration 1: "a" (invalid, unsignaled) → re-ask → feedback; iteration 2: approve.
      promptUser: scriptedPrompts(["a", "keep going", "a"], questions),
      print: (line) => printed.push(line),
    });
    expect(state.status).toBe("succeeded");
    expect(state.nodes["grill"]!.iterations).toBe(2);
    expect(questions).toHaveLength(3);
    expect(
      printed.some((line) => line.includes("has not emitted <promise>SETTLED</promise>") && line.includes("grill")),
    ).toBe(true);
  });

  test("rejecting halts the run as rejected — and retries never re-run a human rejection", async () => {
    const { dir, path } = setup(`
name: rejected
nodes:
  - id: grill
    retries: 2
    loop:
      prompt: "ask"
      until: SETTLED
      max_iterations: 3
      interactive: true
`);
    const calls: RunnerRequest[] = [];
    const runner = scriptedRunner(["whatever"], calls);
    try {
      await run(path, dir, { resolveRunner: () => runner, promptUser: scriptedPrompts(["r"]) });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toContain('rejected at node "grill"');
      expect((err as SaoError).hint).toContain("full output:");
    }
    expect(calls).toHaveLength(1); // retries: 2 must NOT re-run the loop after a rejection
    const runsDir = join(dir, ".sao", "runs");
    const runId = (await import("node:fs")).readdirSync(runsDir)[0]!;
    const saved = JSON.parse(readFileSync(join(runsDir, runId, "state.json"), "utf8"));
    expect(saved.status).toBe("rejected");
    expect(saved.nodes.grill.status).toBe("rejected");
  });

  test("session ids are persisted per iteration, surviving a later rejection (M3 resume fidelity)", async () => {
    const { dir, path } = setup(`
name: sessionkeep
nodes:
  - id: grill
    loop:
      prompt: "ask"
      until: SETTLED
      max_iterations: 3
      fresh_context: false
      interactive: true
`);
    const runner = scriptedRunner(["question?"]);
    await expect(run(path, dir, { resolveRunner: () => runner, promptUser: scriptedPrompts(["r"]) })).rejects.toThrow(
      "rejected",
    );
    const runsDir = join(dir, ".sao", "runs");
    const runId = (await import("node:fs")).readdirSync(runsDir)[0]!;
    const saved = JSON.parse(readFileSync(join(runsDir, runId, "state.json"), "utf8"));
    expect(saved.nodes.grill.sessionId).toBe("session-1"); // iteration 1's session survives the rejection
  });

  test("a runner that reports no session id leaves no sessionId key behind", async () => {
    const { dir, path } = setup(`
name: nosession
nodes:
  - id: work
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 1
`);
    const runner: Runner = {
      name: "sessionless",
      run: async () => ({ output: sentinelToken("DONE"), exitCode: 0 }),
    };
    const state = await run(path, dir, { resolveRunner: () => runner });
    expect(Object.hasOwn(state.nodes["work"]!, "sessionId")).toBe(false);
  });

  test("exhaustion after a signaled-but-unapproved final iteration says so, not 'without signal'", async () => {
    const { dir, path } = setup(`
name: unapproved
nodes:
  - id: grill
    loop:
      prompt: "ask"
      until: SETTLED
      max_iterations: 1
      interactive: true
`);
    const runner = scriptedRunner([`done ${sentinelToken("SETTLED")}`]);
    try {
      await run(path, dir, { resolveRunner: () => runner, promptUser: scriptedPrompts(["please tweak the copy"]) });
      throw new Error("should have thrown");
    } catch (err) {
      const message = (err as SaoError).message;
      expect(message).toContain("loop hit max_iterations (1) with SETTLED signaled on the final iteration but not approved");
      expect(message).not.toContain("without signal");
    }
  });

  test("stale-sentinel regression: an all-skipped iteration cannot be bare-approved", async () => {
    const { dir, path } = setup(`
name: stale
nodes:
  - id: cycle
    loop:
      steps:
        - when_bash: "test ! -f skip-now"
          prompt: "work"
      until: DONE
      max_iterations: 2
      interactive: true
`);
    const runner = scriptedRunner([`done ${sentinelToken("DONE")}`]);
    const questions: string[] = [];
    try {
      await run(path, dir, {
        resolveRunner: () => runner,
        // iter 1 (signaled): feedback + create the marker so iter 2's step is skipped.
        // iter 2 (all steps skipped): "a" must NOT be accepted — the engine re-asks;
        // the follow-up feedback ends iteration 2 and the loop exhausts.
        promptUser: (async (message: string) => {
          questions.push(message);
          if (questions.length === 1) {
            writeFileSync(join(dir, "skip-now"), "");
            return "not yet, keep going";
          }
          if (questions.length === 2) return "a"; // stale token must not make this approvable
          return "still not right";
        }),
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("max_iterations");
    }
    expect(questions[1]).toContain("no signal yet"); // the stale iter-1 token did not count
    expect(questions).toHaveLength(3); // the invalid approve forced a re-ask
  });
});

describe("gate nodes", () => {
  test("approve continues with output 'approved'", async () => {
    const { dir, path } = setup(`
name: gateok
nodes:
  - id: ship
    gate:
      message: "Ship it?"
  - id: after
    depends_on: [ship]
    bash: "echo gate said {{nodes.ship.output}}"
`);
    const state = await run(path, dir, { promptUser: scriptedPrompts(["a"]) });
    expect(state.status).toBe("succeeded");
    expect(state.nodes["ship"]!.output).toBe("approved");
    expect(state.nodes["after"]!.output).toBe("gate said approved");
  });

  test("feedback becomes the gate's output for downstream templates", async () => {
    const { dir, path } = setup(`
name: gatefeedback
nodes:
  - id: ship
    gate:
      message: "Ship it?"
  - id: after
    depends_on: [ship]
    bash: "echo {{nodes.ship.output}}"
`);
    const state = await run(path, dir, { promptUser: scriptedPrompts(["rename the flag first"]) });
    expect(state.nodes["after"]!.output).toBe("rename the flag first");
  });

  test("empty replies re-ask until a real answer arrives", async () => {
    const { dir, path } = setup(`
name: gateempty
nodes:
  - id: ship
    gate:
      message: "Ship it?"
`);
    const questions: string[] = [];
    const state = await run(path, dir, { promptUser: scriptedPrompts(["", "  ", "a"], questions) });
    expect(state.status).toBe("succeeded");
    expect(questions).toHaveLength(3);
  });

  test("reject halts the run as rejected; dependents stay pending", async () => {
    const { dir, path } = setup(`
name: gatereject
nodes:
  - id: ship
    gate:
      message: "Ship it?"
  - id: after
    depends_on: [ship]
    bash: "echo never"
`);
    await expect(run(path, dir, { promptUser: scriptedPrompts(["r"]) })).rejects.toThrow('rejected at node "ship"');
    const runsDir = join(dir, ".sao", "runs");
    const runId = (await import("node:fs")).readdirSync(runsDir)[0]!;
    const saved = JSON.parse(readFileSync(join(runsDir, runId, "state.json"), "utf8"));
    expect(saved.status).toBe("rejected");
    expect(saved.nodes.after.status).toBe("pending");
  });

  test("gate messages are interpolated", async () => {
    const { dir, path } = setup(`
name: gatetpl
inputs:
  - name: feature
    required: true
nodes:
  - id: ship
    gate:
      message: "Ship {{feature}}?"
`);
    const questions: string[] = [];
    await run(path, dir, { vars: { feature: "dark-mode" }, promptUser: scriptedPrompts(["a"], questions) });
    expect(questions[0]).toContain("Ship dark-mode?");
  });
});

describe("when_bash nodes", () => {
  test("a failing predicate skips the node; dependents run and see empty output", async () => {
    const { dir, path } = setup(`
name: skipnode
nodes:
  - id: maybe
    when_bash: "echo probe-when; false"
    bash: "echo never runs"
  - id: after
    depends_on: [maybe]
    bash: "echo got [{{nodes.maybe.output}}]"
`);
    const printed: string[] = [];
    const state = await run(path, dir, { print: (line) => printed.push(line) });
    expect(state.status).toBe("succeeded");
    expect(state.nodes["maybe"]!.status).toBe("skipped");
    expect(state.nodes["maybe"]!.output).toBe("");
    expect(state.nodes["after"]!.output).toBe("got []");
    expect(printed.some((line) => line.includes("⊘ maybe") && line.includes("(skipped by when_bash)"))).toBe(true);
    // The predicate's own output lands in the node log.
    expect(readFileSync(join(dir, ".sao", "runs", state.id, "logs", "maybe.log"), "utf8")).toContain("probe-when");
  });

  test(
    "a hanging predicate is bounded by the node's timeout",
    async () => {
      const { dir, path } = setup(`
name: whenhang
nodes:
  - id: maybe
    when_bash: "sleep 5"
    timeout: 1
    bash: "echo unreached"
`);
      const started = Date.now();
      await expect(run(path, dir)).rejects.toThrow("timed out after 1s");
      expect(Date.now() - started).toBeLessThan(4000);
    },
    10000,
  );

  test("a loop node failing at its when_bash predicate hints at <id>.log (no iteration ran)", async () => {
    const { dir, path } = setup(`
name: loopwhenfail
nodes:
  - id: work
    when_bash: "sleep 5"
    timeout: 1
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 2
`);
    try {
      await run(path, dir, { resolveRunner: () => scriptedRunner(["x"]) });
      throw new Error("should have thrown");
    } catch (err) {
      const hint = (err as SaoError).hint ?? "";
      expect(hint).toContain(join("logs", "work.log"));
      expect(hint).not.toContain("undefined");
    }
  });

  test("a passing predicate runs the node normally", async () => {
    const { dir, path } = setup(`
name: runnode
nodes:
  - id: maybe
    when_bash: "true"
    bash: "echo ran"
`);
    const state = await run(path, dir);
    expect(state.nodes["maybe"]!.status).toBe("succeeded");
    expect(state.nodes["maybe"]!.output).toBe("ran");
  });

  test("when_bash predicates are interpolated", async () => {
    const { dir, path } = setup(`
name: whentpl
inputs:
  - name: flag
    default: "yes"
nodes:
  - id: maybe
    when_bash: "test {{flag}} = yes"
    bash: "echo ran"
`);
    const state = await run(path, dir);
    expect(state.nodes["maybe"]!.status).toBe("succeeded");
  });

  test("a gate behind a failing when_bash is skipped without prompting", async () => {
    const { dir, path } = setup(`
name: skipgate
nodes:
  - id: ship
    when_bash: "false"
    gate:
      message: "never asked"
`);
    const state = await run(path, dir, {
      promptUser: async () => {
        throw new Error("promptUser must not be called");
      },
    });
    expect(state.nodes["ship"]!.status).toBe("skipped");
  });
});

describe("concurrency", () => {
  function delayRunner(delayMs: number, events: Array<{ id: number; at: number; kind: "start" | "end" }>): Runner {
    let n = 0;
    const t0 = Date.now();
    return {
      name: "slow",
      async run() {
        const id = ++n;
        events.push({ id, at: Date.now() - t0, kind: "start" });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        events.push({ id, at: Date.now() - t0, kind: "end" });
        return { output: `done-${id}`, exitCode: 0 };
      },
    };
  }

  const INDEPENDENT = `
name: par
nodes:
  - id: a
    prompt: "a"
  - id: b
    prompt: "b"
`;

  test("independent nodes overlap at concurrency 2", async () => {
    const { dir, path } = setup(INDEPENDENT);
    const events: Array<{ id: number; at: number; kind: "start" | "end" }> = [];
    await run(path, dir, { resolveRunner: () => delayRunner(300, events), concurrency: 2 });
    const secondStart = events.filter((e) => e.kind === "start")[1]!;
    const firstEnd = events.find((e) => e.kind === "end")!;
    expect(secondStart.at).toBeLessThan(firstEnd.at); // started while the first still ran
  });

  test("concurrency 1 serializes independent nodes", async () => {
    const { dir, path } = setup(INDEPENDENT);
    const events: Array<{ id: number; at: number; kind: "start" | "end" }> = [];
    await run(path, dir, { resolveRunner: () => delayRunner(200, events), concurrency: 1 });
    const starts = events.filter((e) => e.kind === "start");
    const ends = events.filter((e) => e.kind === "end");
    expect(starts[1]!.at).toBeGreaterThanOrEqual(ends[0]!.at);
  });

  test("the concurrency cap is never exceeded", async () => {
    const { dir, path } = setup(`
name: cap
nodes:
  - id: a
    prompt: "a"
  - id: b
    prompt: "b"
  - id: c
    prompt: "c"
  - id: d
    prompt: "d"
`);
    let active = 0;
    let maxActive = 0;
    const runner: Runner = {
      name: "counting",
      async run() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active--;
        return { output: "ok", exitCode: 0 };
      },
    };
    await run(path, dir, { resolveRunner: () => runner, concurrency: 2 });
    expect(maxActive).toBe(2);
  });

  test("a failure halts new scheduling; in-flight nodes finish; pending stay pending", async () => {
    const { dir, path } = setup(`
name: halt
nodes:
  - id: boom
    bash: "sleep 0.1; exit 1"
  - id: slow
    bash: "sleep 0.4; echo survived"
  - id: late
    bash: "echo would run after a slot frees"
  - id: never
    depends_on: [boom]
    bash: "echo no"
`);
    await expect(run(path, dir, { concurrency: 2 })).rejects.toThrow('failed at node "boom"');
    const runsDir = join(dir, ".sao", "runs");
    const runId = (await import("node:fs")).readdirSync(runsDir)[0]!;
    const saved = JSON.parse(readFileSync(join(runsDir, runId, "state.json"), "utf8"));
    expect(saved.nodes.slow.status).toBe("succeeded"); // in-flight allowed to finish
    expect(saved.nodes.never.status).toBe("pending"); // dependent of the failure
    expect(saved.nodes.late.status).toBe("pending"); // eligible, but nothing new starts after a failure
    expect(saved.status).toBe("failed");
  });

  test("a failure that lands before a rejection keeps the run status failed", async () => {
    const { dir, path } = setup(`
name: failthenreject
nodes:
  - id: boom
    bash: "exit 1"
  - id: ship
    gate:
      message: "still asked (already running)"
`);
    await expect(
      run(path, dir, {
        concurrency: 2,
        promptUser: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300)); // let boom fail first
          return "r";
        },
      }),
    ).rejects.toThrow('failed at node "boom"'); // the first error wins
    const runsDir = join(dir, ".sao", "runs");
    const runId = (await import("node:fs")).readdirSync(runsDir)[0]!;
    const saved = JSON.parse(readFileSync(join(runsDir, runId, "state.json"), "utf8"));
    expect(saved.status).toBe("failed"); // the later rejection must not overwrite it
    expect(saved.nodes.ship.status).toBe("rejected");
  });
});

describe("run root vs execution cwd", () => {
  test(".sao/ lands under runRoot while nodes execute in cwd", async () => {
    const { dir, path } = setup(`
name: roots
nodes:
  - id: a
    bash: "pwd"
`);
    const runRoot = mkdtempSync(join(tmpdir(), "sao-runroot-"));
    const state = await run(path, dir, { runRoot });
    expect(existsSync(join(runRoot, ".sao", "runs", state.id, "state.json"))).toBe(true);
    expect(existsSync(join(dir, ".sao"))).toBe(false);
    expect(state.nodes["a"]!.output).toBe((await import("node:fs")).realpathSync(dir));
  });
});

describe("runner environment preflight", () => {
  test("a runner whose preflight throws fails before any run state exists", async () => {
    const { dir, path } = setup(`
name: badenv
nodes:
  - id: setup
    bash: "echo never runs"
  - id: a
    depends_on: [setup]
    prompt: "hi"
`);
    const runner: Runner = {
      name: "envless",
      preflight() {
        throw new SaoError("envless CLI not found on PATH", "install it");
      },
      run: async () => ({ output: "", exitCode: 0 }),
    };
    await expect(run(path, dir, { resolveRunner: () => runner })).rejects.toThrow("envless CLI not found on PATH");
    expect(existsSync(join(dir, ".sao"))).toBe(false); // and the bash node's side effects never ran
  });
});

describe("runner preflight probing", () => {
  test("preflight runs exactly once per distinct runner", async () => {
    const { dir, path } = setup(`
name: probeonce
nodes:
  - id: a
    prompt: "one"
  - id: b
    depends_on: [a]
    prompt: "two"
`);
    let probes = 0;
    const runner: Runner = {
      name: "probed",
      preflight() {
        probes++;
      },
      run: async () => ({ output: "ok", exitCode: 0 }),
    };
    await run(path, dir, { resolveRunner: () => runner });
    expect(probes).toBe(1);
  });
});

describe("gate timeout", () => {
  test(
    "a gate's hanging when_bash predicate is bounded by its timeout",
    async () => {
      const { dir, path } = setup(`
name: gatewhenhang
nodes:
  - id: ship
    when_bash: "sleep 5"
    timeout: 1
    gate:
      message: "never asked"
`);
      const started = Date.now();
      await expect(
        run(path, dir, {
          promptUser: async () => {
            throw new Error("promptUser must not be called");
          },
        }),
      ).rejects.toThrow("timed out after 1s");
      expect(Date.now() - started).toBeLessThan(4000);
    },
    10000,
  );
});

describe("retries by node kind", () => {
  test("AI nodes honor retries", async () => {
    const { dir, path } = setup(`
name: airetry
nodes:
  - id: a
    retries: 1
    prompt: "hi"
`);
    let attempts = 0;
    const runner: Runner = {
      name: "flaky",
      async run() {
        attempts++;
        return { output: attempts === 1 ? "boom" : "ok", exitCode: attempts === 1 ? 1 : 0 };
      },
    };
    const state = await run(path, dir, { resolveRunner: () => runner });
    expect(state.status).toBe("succeeded");
    expect(attempts).toBe(2);
  });

  test("loop nodes honor retries — a failed loop re-runs from iteration 1, appending logs", async () => {
    const { dir, path } = setup(`
name: loopretry
nodes:
  - id: work
    retries: 1
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 1
`);
    // Attempt 1 exhausts (no token); attempt 2 signals. Each attempt streams a marker.
    let attempt = 0;
    const runner: Runner = {
      name: "marky",
      async run(req) {
        attempt++;
        req.onOutput?.(`marker-attempt-${attempt}\n`);
        return { output: attempt === 1 ? "nope" : `yes ${sentinelToken("DONE")}`, exitCode: 0 };
      },
    };
    const state = await run(path, dir, { resolveRunner: () => runner });
    expect(state.status).toBe("succeeded");
    expect(state.nodes["work"]!.output).toContain("yes");
    // The retry must APPEND to work.1.log — attempt 1's evidence survives.
    const log = readFileSync(join(dir, ".sao", "runs", state.id, "logs", "work.1.log"), "utf8");
    expect(log).toContain("marker-attempt-1");
    expect(log).toContain("marker-attempt-2");
  });
});

describe("agents and MCP in the engine", () => {
  test("an agent's system prompt, model, and allowed_tools reach the runner", async () => {
    const { dir, path } = setup(`
name: agentflow
nodes:
  - id: a
    agent: impl
    prompt: "build"
`);
    agentDir(dir, { impl: "---\nmodel: agent-model\nallowed_tools: [mcp__jira]\n---\nagent persona" });
    const calls: RunnerRequest[] = [];
    await run(path, dir, { resolveRunner: () => scriptedRunner(["ok"], calls) });
    expect(calls[0]!.systemPrompt).toBe("agent persona");
    expect(calls[0]!.model).toBe("agent-model");
    expect(calls[0]!.allowedTools).toEqual(["mcp__jira"]);
    expect(calls[0]!.cwd).toBe(dir);
  });

  test("preflightAiConfigs rejects agent refs missing from workflow.agents (programmatic use)", () => {
    const workflow = {
      name: "handbuilt",
      inputs: [],
      defaults: {},
      nodes: [{ kind: "ai" as const, id: "a", depends_on: [], retries: 0, prompt: "x", agent: "ghost" }],
      agents: new Map(),
    };
    try {
      preflightAiConfigs(workflow, undefined, () => ({ name: "x", run: async () => ({ output: "", exitCode: 0 }) }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toBe('node "a": agent "ghost" was not loaded');
      expect((err as SaoError).hint).toContain("populate workflow.agents");
    }
  });

  test("node keys beat agent frontmatter, which beats defaults", async () => {
    const { dir, path } = setup(`
name: precedence
defaults:
  model: default-model
  allowed_tools: [default-tool]
nodes:
  - id: a
    agent: impl
    model: node-model
    prompt: "build"
  - id: b
    depends_on: [a]
    agent: impl
    prompt: "again"
  - id: c
    depends_on: [b]
    prompt: "bare"
`);
    agentDir(dir, { impl: "---\nmodel: agent-model\n---\npersona" });
    const calls: RunnerRequest[] = [];
    await run(path, dir, { resolveRunner: () => scriptedRunner(["ok"], calls), concurrency: 1 });
    expect(calls[0]!.model).toBe("node-model"); // node beats agent
    expect(calls[1]!.model).toBe("agent-model"); // agent beats defaults
    expect(calls[2]!.model).toBe("default-model"); // defaults as the floor
    expect(calls[1]!.allowedTools).toEqual(["default-tool"]); // agent has none → defaults
  });

  test("inline mcp: is serialized to the run dir and passed to every AI execution", async () => {
    const { dir, path } = setup(`
name: mcpflow
mcp:
  jira:
    command: npx
    args: ["-y", "mcp-remote"]
nodes:
  - id: a
    prompt: "use jira"
`);
    const calls: RunnerRequest[] = [];
    const state = await run(path, dir, { resolveRunner: () => scriptedRunner(["ok"], calls) });
    const mcpPath = join(dir, ".sao", "runs", state.id, "mcp.json");
    expect(calls[0]!.mcpConfigPath).toBe(mcpPath);
    const raw = readFileSync(mcpPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({
      mcpServers: { jira: { command: "npx", args: ["-y", "mcp-remote"] } },
    });
  });

  test("mcp: as a file path is resolved and passed through untouched", async () => {
    const { dir, path } = setup(`
name: mcppath
mcp: ./servers.json
nodes:
  - id: a
    prompt: "use jira"
`);
    writeFileSync(join(dir, "servers.json"), JSON.stringify({ mcpServers: {} }));
    const calls: RunnerRequest[] = [];
    await run(path, dir, { resolveRunner: () => scriptedRunner(["ok"], calls) });
    expect(calls[0]!.mcpConfigPath).toBe(join(dir, "servers.json"));
  });

  test("preflightAiConfigs keys loop steps as <node-id>#<index>", () => {
    const { dir, path } = setup(`
name: keys
nodes:
  - id: cycle
    loop:
      steps:
        - prompt: "one"
        - bash: "true"
        - prompt: "two"
      until: DONE
      max_iterations: 1
`);
    const configs = preflightAiConfigs(loadWorkflow(path, { cwd: dir }), undefined, () => ({
      name: "x",
      run: async () => ({ output: "", exitCode: 0 }),
    }));
    expect([...configs.keys()].sort()).toEqual(["cycle#0", "cycle#2"]);
  });
});
