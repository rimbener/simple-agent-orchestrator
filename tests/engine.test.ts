import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightAiConfigs, runWorkflow } from "../src/engine";
import { SaoError } from "../src/errors";
import { loadWorkflow } from "../src/parser";
import { shutdownAll } from "../src/procs";
import type { Runner, RunnerRequest } from "../src/runners/types";
import type { RunState } from "../src/state";

function setup(yaml: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "sao-engine-"));
  const path = join(dir, "workflow.yaml");
  writeFileSync(path, yaml);
  return { dir, path };
}

function mockRunner(calls: RunnerRequest[]): Runner {
  return {
    name: "mock",
    async run(req) {
      calls.push(req);
      return { output: `echo:${req.prompt}`, sessionId: "s-1", exitCode: 0 };
    },
  };
}

const quiet = () => {};

// picocolors only adds ANSI codes on a TTY; strip defensively so assertions hold either way.
const stripAnsi = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");

/** The content of every `  [<id>] ` echo line, prefix removed. */
function echoContents(printed: string[], id: string): string[] {
  const prefix = `  [${id}] `;
  return printed
    .map(stripAnsi)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

async function rejection(promise: Promise<unknown>): Promise<SaoError> {
  try {
    await promise;
  } catch (err) {
    return err as SaoError;
  }
  throw new Error("expected the promise to reject");
}

/** Read back the single run under <dir>/.sao/runs. */
function readRunState(dir: string): { runId: string; saved: RunState } {
  const runsDir = join(dir, ".sao", "runs");
  const runId = readdirSync(runsDir)[0]!;
  return { runId, saved: JSON.parse(readFileSync(join(runsDir, runId, "state.json"), "utf8")) as RunState };
}

describe("runWorkflow", () => {
  test("runs ai and bash nodes in dependency order, flowing outputs", async () => {
    const { dir, path } = setup(`
name: chain
inputs:
  - name: issue
    required: true
nodes:
  - id: plan
    prompt: "plan {{task}} #{{issue}}"
  - id: check
    depends_on: [plan]
    bash: "echo \\"plan was: {{nodes.plan.output}}\\""
  - id: summarize
    depends_on: [check]
    prompt: "sum {{nodes.check.output}}"
`);
    const calls: RunnerRequest[] = [];
    const state = await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "dark mode",
      vars: { issue: "42" },
      cwd: dir,
      resolveRunner: () => mockRunner(calls),
      print: quiet,
    });

    expect(state.status).toBe("succeeded");
    expect(calls[0]!.prompt).toBe("plan dark mode #42");
    expect(state.nodes["plan"]!.output).toBe("echo:plan dark mode #42");
    expect(state.nodes["check"]!.output).toBe("plan was: echo:plan dark mode #42");
    expect(calls[1]!.prompt).toBe("sum plan was: echo:plan dark mode #42");
    expect(state.nodes["summarize"]!.status).toBe("succeeded");
  });

  test("echoes a line delivered across multiple chunks as one line", async () => {
    const { dir, path } = setup(`
name: echo-buffer
nodes:
  - id: a
    bash: "printf hello-; sleep 0.3; printf world; sleep 0.3; echo '!'"
`);
    const printed: string[] = [];
    await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      print: (line) => printed.push(line),
    });
    const nodeLines = printed.filter((line) => line.includes("[a]"));
    expect(nodeLines).toHaveLength(1);
    expect(nodeLines[0]).toContain("hello-world!");
  });

  test("echoes a trailing unterminated line, including when the node fails", async () => {
    const { dir, path } = setup(`
name: echo-flush
nodes:
  - id: ok
    bash: "printf no-newline-here"
  - id: bad
    depends_on: [ok]
    bash: "printf partial-line; exit 3"
`);
    const printed: string[] = [];
    await expect(
      runWorkflow({
        workflow: loadWorkflow(path),
        workflowPath: path,
        task: "",
        vars: {},
        cwd: dir,
        print: (line) => printed.push(line),
      }),
    ).rejects.toThrow('failed at node "bad"');
    expect(printed.some((line) => line.includes("no-newline-here"))).toBe(true);
    expect(printed.some((line) => line.includes("partial-line"))).toBe(true);
  });

  test("writes state.json and per-node logs", async () => {
    const { dir, path } = setup(`
name: logging
nodes:
  - id: only
    bash: "echo hello-log"
`);
    const state = await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      print: quiet,
    });

    const runDir = join(dir, ".sao", "runs", state.id);
    expect(existsSync(join(runDir, "state.json"))).toBe(true);
    expect(readFileSync(join(runDir, "logs", "only.log"), "utf8")).toContain("hello-log");
    const saved = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(saved.status).toBe("succeeded");
    expect(saved.workflowHash).toStartWith("sha256:");
  });

  test("a failing bash node halts the run and marks state failed", async () => {
    const { dir, path } = setup(`
name: failing
nodes:
  - id: boom
    bash: "exit 3"
  - id: never
    depends_on: [boom]
    bash: "echo unreachable"
`);
    await expect(
      runWorkflow({
        workflow: loadWorkflow(path),
        workflowPath: path,
        task: "",
        vars: {},
        cwd: dir,
        print: quiet,
      }),
    ).rejects.toThrow('failed at node "boom": command exited with code 3'); // exactly one node-id prefix

    const runsDir = join(dir, ".sao", "runs");
    const runId = (await import("node:fs")).readdirSync(runsDir)[0]!;
    const saved = JSON.parse(readFileSync(join(runsDir, runId, "state.json"), "utf8"));
    expect(saved.status).toBe("failed");
    expect(saved.nodes.boom.status).toBe("failed");
    expect(saved.nodes.never.status).toBe("pending");
  });

  test("retries re-run a flaky node", async () => {
    const { dir, path } = setup(`
name: flaky
nodes:
  - id: flaky
    retries: 1
    bash: "test -f marker || { touch marker; exit 1; }"
`);
    const state = await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      print: quiet,
    });
    expect(state.nodes["flaky"]!.status).toBe("succeeded");
  });

  test("rejects missing required inputs and unknown vars", async () => {
    const { dir, path } = setup(`
name: inputs
inputs:
  - name: needed
    required: true
nodes:
  - id: a
    bash: "echo {{needed}}"
`);
    const base = { workflow: loadWorkflow(path), workflowPath: path, task: "", cwd: dir, print: quiet };
    await expect(runWorkflow({ ...base, vars: {} })).rejects.toThrow('missing required input "needed"');
    await expect(runWorkflow({ ...base, vars: { needed: "x", extra: "y" } })).rejects.toThrow('unknown input "extra"');
  });

  test("a bad runner fails preflight, before any run state exists", async () => {
    const { dir, path } = setup(`
name: preflight
nodes:
  - id: setup
    bash: "echo never runs"
  - id: a
    depends_on: [setup]
    prompt: "hi"
    runner: nope
`);
    await expect(
      runWorkflow({
        workflow: loadWorkflow(path),
        workflowPath: path,
        task: "",
        vars: {},
        cwd: dir,
        print: quiet,
      }),
    ).rejects.toThrow('unknown runner "nope"');
    expect(existsSync(join(dir, ".sao"))).toBe(false);
  });

  test("a failing node's SaoError hint survives engine wrapping", async () => {
    const { dir, path } = setup(`
name: hints
nodes:
  - id: a
    prompt: "hi"
`);
    const hintedRunner: Runner = {
      name: "hinted",
      async run() {
        throw new SaoError("boom", "try harder");
      },
    };
    try {
      await runWorkflow({
        workflow: loadWorkflow(path),
        workflowPath: path,
        task: "",
        vars: {},
        cwd: dir,
        resolveRunner: () => hintedRunner,
        print: quiet,
      });
      throw new Error("should have thrown");
    } catch (err) {
      const { runId } = readRunState(dir);
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toBe(`run ${runId} failed at node "a": boom`);
      expect((err as SaoError).hint).toBe(`try harder\n  full output: ${join(dir, ".sao", "runs", runId, "logs", "a.log")}`);
    }
  });

  test("a failing node without a hint gets exactly the log-path hint", async () => {
    const { dir, path } = setup(`
name: hints-bare
nodes:
  - id: a
    prompt: "hi"
`);
    const bareRunner: Runner = {
      name: "bare",
      async run() {
        throw new SaoError("boom-bare");
      },
    };
    const err = await rejection(
      runWorkflow({
        workflow: loadWorkflow(path),
        workflowPath: path,
        task: "",
        vars: {},
        cwd: dir,
        resolveRunner: () => bareRunner,
        print: quiet,
      }),
    );
    const { runId } = readRunState(dir);
    expect(err).toBeInstanceOf(SaoError);
    expect(err.message).toBe(`run ${runId} failed at node "a": boom-bare`);
    expect(err.hint).toBe(`full output: ${join(dir, ".sao", "runs", runId, "logs", "a.log")}`);
  });

  test("a non-Error throw from a runner is stringified into the failure message", async () => {
    const { dir, path } = setup(`
name: hints-string
nodes:
  - id: a
    prompt: "hi"
`);
    const throwingRunner: Runner = {
      name: "thrower",
      async run() {
        throw "boom-string";
      },
    };
    const err = await rejection(
      runWorkflow({
        workflow: loadWorkflow(path),
        workflowPath: path,
        task: "",
        vars: {},
        cwd: dir,
        resolveRunner: () => throwingRunner,
        print: quiet,
      }),
    );
    const { runId } = readRunState(dir);
    expect(err.message).toBe(`run ${runId} failed at node "a": boom-string`);
    expect(err.hint).toBe(`full output: ${join(dir, ".sao", "runs", runId, "logs", "a.log")}`);
  });

  test("workflow defaults.model and permission_mode reach the runner request", async () => {
    const { dir, path } = setup(`
name: defaults-flow
defaults:
  model: sonnet
  permission_mode: plan
nodes:
  - id: a
    prompt: "hi"
`);
    const calls: RunnerRequest[] = [];
    await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      resolveRunner: () => mockRunner(calls),
      print: quiet,
    });
    expect(calls[0]!.model).toBe("sonnet");
    expect(calls[0]!.permissionMode).toBe("plan");
  });

  test("runner override wins over workflow defaults", async () => {
    const { dir, path } = setup(`
name: override
defaults:
  runner: claude
nodes:
  - id: a
    prompt: "hi"
`);
    const seen: string[] = [];
    await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      runnerOverride: "mock",
      resolveRunner: (name) => {
        seen.push(name);
        return mockRunner([]);
      },
      print: quiet,
    });
    expect(seen).toEqual(["mock"]);
  });

  test("prints the exact header, node, echo, timing, and success lines", async () => {
    const { dir, path } = setup(`
name: formats
nodes:
  - id: a
    bash: "sleep 0.15; echo hello"
`);
    const printed: string[] = [];
    const state = await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      print: (line) => printed.push(line),
    });
    const lines = printed.map(stripAnsi);
    const logsDir = join(dir, ".sao", "runs", state.id, "logs");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(`sao run ${state.id} (1 nodes, concurrency 2, logs in ${logsDir})`);
    expect(lines[1]).toBe("→ a (bash)");
    expect(lines[2]).toBe("  [a] hello");
    const timing = /^✓ a \((\d+\.\d)s\)$/.exec(lines[3]!);
    expect(timing).not.toBeNull();
    expect(Number.parseFloat(timing![1]!)).toBeLessThan(60); // node slept 0.15s; a sane wall-clock reading
    expect(lines[4]).toBe(`✓ run ${state.id} succeeded`);
  });

  test("prints an ai node with its kind", async () => {
    const { dir, path } = setup(`
name: ai-kind
nodes:
  - id: think
    prompt: "hi"
`);
    const printed: string[] = [];
    await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      resolveRunner: () => mockRunner([]),
      print: (line) => printed.push(line),
    });
    expect(printed.map(stripAnsi)).toContain("→ think (ai)");
  });

  test("default print writes to console.log", async () => {
    const { dir, path } = setup(`
name: defprint
nodes:
  - id: a
    bash: "echo hi"
`);
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const state = await runWorkflow({
        workflow: loadWorkflow(path),
        workflowPath: path,
        task: "",
        vars: {},
        cwd: dir,
      });
      const logged = spy.mock.calls.map((call) => stripAnsi(String(call[0])));
      expect(logged).toContain(`sao run ${state.id} (1 nodes, concurrency 2, logs in ${join(dir, ".sao", "runs", state.id, "logs")})`);
      expect(logged).toContain(`✓ run ${state.id} succeeded`);
    } finally {
      spy.mockRestore();
    }
  });

  test("does not echo whitespace-only lines", async () => {
    const { dir, path } = setup(`
name: blanks
nodes:
  - id: a
    bash: 'printf "   \\nreal\\n"'
`);
    const printed: string[] = [];
    await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      print: (line) => printed.push(line),
    });
    expect(echoContents(printed, "a")).toEqual(["real"]);
  });

  test("buffers an unterminated line of exactly 8192 chars instead of echoing early", async () => {
    const { dir, path } = setup(`
name: boundary
nodes:
  - id: a
    bash: 'head -c 8192 /dev/zero | tr "\\0" x; sleep 0.3; printf END'
`);
    const printed: string[] = [];
    await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      print: (line) => printed.push(line),
    });
    // 8192 chars is not "> 8192": nothing echoes until END lands, then exactly one line.
    expect(echoContents(printed, "a")).toEqual(["x".repeat(8192) + "END"]);
  });

  test("echoes a runaway newline-less line past 8192 chars and resets the buffer", async () => {
    const { dir, path } = setup(`
name: runaway
nodes:
  - id: a
    bash: 'head -c 8300 /dev/zero | tr "\\0" x; sleep 0.3; echo TAIL'
`);
    const printed: string[] = [];
    const state = await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      print: (line) => printed.push(line),
    });
    const contents = echoContents(printed, "a");
    expect(contents).toHaveLength(2); // the runaway echo, then the remainder + TAIL
    expect(contents[0]!.length).toBeGreaterThan(8192);
    expect(contents.join("")).toBe("x".repeat(8300) + "TAIL"); // no junk injected between echoes
    expect(readFileSync(join(dir, ".sao", "runs", state.id, "logs", "a.log"), "utf8")).toBe("x".repeat(8300) + "TAIL\n");
  });

  test("state.json reports the run and the executing node as running mid-run", async () => {
    const { dir, path } = setup(`
name: peek
nodes:
  - id: peek
    bash: "cat .sao/runs/*/state.json"
`);
    const state = await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      print: quiet,
    });
    const midRun = JSON.parse(state.nodes["peek"]!.output!) as RunState;
    expect(midRun.status).toBe("running");
    expect(midRun.nodes["peek"]!.status).toBe("running");
  });

  test("records the runner sessionId only when one is returned", async () => {
    const { dir, path } = setup(`
name: session
nodes:
  - id: a
    prompt: "hi"
`);
    const withSession = await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      resolveRunner: () => mockRunner([]),
      print: quiet,
    });
    expect(withSession.nodes["a"]!.sessionId).toBe("s-1");

    const noSessionRunner: Runner = {
      name: "nosess",
      async run() {
        return { output: "out", exitCode: 0 };
      },
    };
    const withoutSession = await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      resolveRunner: () => noSessionRunner,
      print: quiet,
    });
    expect("sessionId" in withoutSession.nodes["a"]!).toBe(false);
  });

  test("unknown var hint lists the declared inputs exactly", async () => {
    const { dir, path } = setup(`
name: declared
inputs:
  - name: alpha
  - name: beta
nodes:
  - id: n
    bash: "echo hi"
`);
    const err = await rejection(
      runWorkflow({
        workflow: loadWorkflow(path),
        workflowPath: path,
        task: "",
        vars: { bogus: "1" },
        cwd: dir,
        print: quiet,
      }),
    );
    expect(err).toBeInstanceOf(SaoError);
    expect(err.message).toBe('unknown input "bogus"');
    expect(err.hint).toBe("declared inputs: alpha, beta");
  });

  test("unknown var hint says (none) when no inputs are declared", async () => {
    const { dir, path } = setup(`
name: no-inputs
nodes:
  - id: n
    bash: "echo hi"
`);
    const err = await rejection(
      runWorkflow({
        workflow: loadWorkflow(path),
        workflowPath: path,
        task: "",
        vars: { bogus: "1" },
        cwd: dir,
        print: quiet,
      }),
    );
    expect(err.hint).toBe("declared inputs: (none)");
  });

  test("missing required input carries the exact --var hint", async () => {
    const { dir, path } = setup(`
name: req
inputs:
  - name: needed
    required: true
nodes:
  - id: n
    bash: "echo {{needed}}"
`);
    const err = await rejection(
      runWorkflow({
        workflow: loadWorkflow(path),
        workflowPath: path,
        task: "",
        vars: {},
        cwd: dir,
        print: quiet,
      }),
    );
    expect(err.message).toBe('missing required input "needed"');
    expect(err.hint).toBe("pass it with --var needed=<value>");
  });

  test("an optional input without a default may simply be omitted", async () => {
    const { dir, path } = setup(`
name: optional
inputs:
  - name: opt
nodes:
  - id: n
    bash: "echo steady"
`);
    const state = await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      print: quiet,
    });
    expect(state.status).toBe("succeeded");
    expect("opt" in state.vars).toBe(false);
  });

  test("an optional input's default flows into interpolation", async () => {
    const { dir, path } = setup(`
name: defaulted
inputs:
  - name: opt
    default: fallback-value
nodes:
  - id: n
    bash: "echo {{opt}}"
`);
    const state = await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      print: quiet,
    });
    expect(state.vars["opt"]).toBe("fallback-value");
    expect(state.nodes["n"]!.output).toBe("fallback-value");
  });

  test(
    "shutdownAll mid-run fails the run and running nodes but leaves pending nodes pending",
    async () => {
      const { dir, path } = setup(`
name: shutdown
nodes:
  - id: one
    bash: "sleep 30"
  - id: two
    depends_on: [one]
    bash: "echo never"
`);
      const run = runWorkflow({
        workflow: loadWorkflow(path),
        workflowPath: path,
        task: "",
        vars: {},
        cwd: dir,
        print: quiet,
      });

      const runsDir = join(dir, ".sao", "runs");
      const deadline = Date.now() + 5000;
      // Wait until node one is genuinely running (state saved before its child spawns).
      while (true) {
        if (existsSync(runsDir) && readdirSync(runsDir).length > 0) {
          const { saved } = readRunState(dir);
          if (saved.nodes["one"]!.status === "running") {
            expect(saved.status).toBe("running");
            break;
          }
        }
        if (Date.now() > deadline) throw new Error("node one never reached running");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      shutdownAll();
      // Synchronously after the hook ran, before the engine's own failure path can save:
      const snapshot = readRunState(dir).saved;
      expect(snapshot.status).toBe("failed");
      expect(snapshot.nodes["one"]!.status).toBe("failed");
      expect(snapshot.nodes["two"]!.status).toBe("pending");

      await expect(run).rejects.toThrow('failed at node "one"');
      const final = readRunState(dir).saved;
      expect(final.status).toBe("failed");
      expect(final.nodes["one"]!.status).toBe("failed");
      expect(final.nodes["two"]!.status).toBe("pending");
    },
    15000,
  );

  test("shutdownAll after a successful run leaves state.json succeeded", async () => {
    const { dir, path } = setup(`
name: released
nodes:
  - id: a
    bash: "echo done"
`);
    await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      print: quiet,
    });
    shutdownAll(); // the run released its shutdown hook, so this must not touch its state
    const { saved } = readRunState(dir);
    expect(saved.status).toBe("succeeded");
    expect(saved.nodes["a"]!.status).toBe("succeeded");
  });

  test("a log stream error does not crash the run", async () => {
    const { dir, path } = setup(`
name: logerr
nodes:
  - id: sab
    bash: 'd=$(echo .sao/runs/*); mkdir "$d/logs/vic.log"'
  - id: vic
    depends_on: [sab]
    bash: "echo survived"
`);
    // vic's log path is a directory, so its write stream errors (EISDIR); best-effort
    // logging must swallow that and let the node finish.
    const state = await runWorkflow({
      workflow: loadWorkflow(path),
      workflowPath: path,
      task: "",
      vars: {},
      cwd: dir,
      print: quiet,
    });
    expect(state.status).toBe("succeeded");
    expect(state.nodes["vic"]!.output).toBe("survived");
  });
});

describe("preflightAiConfigs", () => {
  function spyResolver(seen: string[]): (name: string) => Runner {
    return (name) => {
      seen.push(name);
      return mockRunner([]);
    };
  }

  test("never resolves runners for bash nodes", () => {
    const { path } = setup(`
name: bashonly
nodes:
  - id: a
    bash: "echo hi"
  - id: b
    depends_on: [a]
    bash: "echo ho"
`);
    const seen: string[] = [];
    const configs = preflightAiConfigs(loadWorkflow(path), undefined, spyResolver(seen));
    expect(seen).toEqual([]);
    expect(configs.size).toBe(0);
  });

  test('falls back to exactly "claude" when nothing is configured', () => {
    const { path } = setup(`
name: bare
nodes:
  - id: a
    prompt: "hi"
`);
    const seen: string[] = [];
    preflightAiConfigs(loadWorkflow(path), undefined, spyResolver(seen));
    expect(seen).toEqual(["claude"]);
  });

  test("node runner beats defaults.runner, which beats the claude fallback", () => {
    const { path } = setup(`
name: chainprec
defaults:
  runner: defr
nodes:
  - id: a
    prompt: "hi"
    runner: noder
  - id: b
    prompt: "hi"
`);
    const seen: string[] = [];
    preflightAiConfigs(loadWorkflow(path), undefined, spyResolver(seen));
    expect(seen).toEqual(["noder", "defr"]);

    const overridden: string[] = [];
    preflightAiConfigs(loadWorkflow(path), "ovr", spyResolver(overridden));
    expect(overridden).toEqual(["ovr", "ovr"]);
  });

  test("wraps a resolver SaoError with the node id and preserves the hint", () => {
    const { path } = setup(`
name: wraps
nodes:
  - id: a
    prompt: "hi"
`);
    let caught: unknown;
    try {
      preflightAiConfigs(loadWorkflow(path), undefined, () => {
        throw new SaoError("no such runner", "install it");
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SaoError);
    expect((caught as SaoError).message).toBe('node "a": no such runner');
    expect((caught as SaoError).hint).toBe("install it");
  });

  test("rethrows a non-Sao resolver error unwrapped", () => {
    const { path } = setup(`
name: unwrapped
nodes:
  - id: a
    prompt: "hi"
`);
    let caught: unknown;
    try {
      preflightAiConfigs(loadWorkflow(path), undefined, () => {
        throw new Error("plain-fail");
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SaoError);
    expect((caught as Error).message).toBe("plain-fail");
  });
});
