import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashRunConfig, runWorkflow } from "../src/engine";
import { SaoError } from "../src/errors";
import { loadWorkflow } from "../src/parser";
import type { Runner, RunnerRequest } from "../src/runners/types";
import { loadRun, type RunState } from "../src/state";
import { worktreeRelPath } from "../src/worktree";

const quiet = () => {};

function setup(yaml: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "sao-m3-"));
  const path = join(dir, "workflow.yaml");
  writeFileSync(path, yaml);
  return { dir, path };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Turn a plain temp dir into a git repo (branch main, one commit). */
function gitify(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
}

/** Runner whose script mixes outputs and thrown errors; records every request. */
function flakyRunner(script: Array<string | Error>, calls: RunnerRequest[] = []): Runner {
  let call = 0;
  return {
    name: "scripted",
    async run(req) {
      calls.push(req);
      const step = script[Math.min(call, script.length - 1)]!;
      call++;
      if (step instanceof Error) throw step;
      return { output: step, sessionId: `session-${call}`, exitCode: 0 };
    },
  };
}

/** One shared runner instance no matter how many units resolve it — the counter must span nodes. */
function useRunner(script: Array<string | Error>, calls: RunnerRequest[] = []): () => Runner {
  const runner = flakyRunner(script, calls);
  return () => runner;
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

async function rejection(promise: Promise<unknown>): Promise<SaoError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SaoError);
    return err as SaoError;
  }
  throw new Error("expected the promise to reject");
}

function onlyRunId(root: string): string {
  const runs = readdirSync(join(root, ".sao", "runs"));
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

/** Run to failure, then resume; returns whatever both phases produced. */
const FAIL_ONCE = "test -f marker || { touch marker; echo first-try >&2; exit 1; }";

describe("resume basics", () => {
  test("completed nodes are not re-run; their outputs still feed dependents' templates", async () => {
    const { dir, path } = setup(`
name: res-basic
nodes:
  - id: a
    prompt: "produce alpha"
  - id: b
    depends_on: [a]
    prompt: "consume {{nodes.a.output}}"
`);
    const firstLines: string[] = [];
    const firstCalls: RunnerRequest[] = [];
    const err = await rejection(
      run(path, dir, {
        resolveRunner: useRunner(["alpha", new SaoError("boom")], firstCalls),
        print: (l) => firstLines.push(l),
      }),
    );
    expect(err.message).toContain('failed at node "b"');
    expect(err.hint).toContain(`resume with: sao resume ${onlyRunId(dir)}`);
    expect(firstLines.join("\n")).toContain(`sao run ${onlyRunId(dir)}`);

    const resumeLines: string[] = [];
    const resumeCalls: RunnerRequest[] = [];
    const loaded = loadRun(dir, onlyRunId(dir));
    expect(loaded.state.autoOpenPr).toBe(false); // persisted off until the M4 flag exists
    expect(loaded.state.cwd).toBe("."); // in-place run at the run root
    const state = await run(path, dir, {
      resolveRunner: useRunner(["beta"], resumeCalls),
      resume: loaded,
      print: (l) => resumeLines.push(l),
    });
    expect(state.status).toBe("succeeded");
    expect(resumeCalls).toHaveLength(1); // a did NOT re-run
    expect(resumeCalls[0]!.prompt).toBe("consume alpha"); // restored output interpolated
    expect(state.nodes["a"]!.output).toBe("alpha");
    expect(state.nodes["b"]!.output).toBe("beta");
    const resumeOutput = resumeLines.join("\n");
    expect(resumeOutput).toContain(`sao resume ${state.id}`);
    expect(resumeOutput).toContain("↷ a (already succeeded)");
  });

  test("a resume that fails again persists status failed, never a half-written value", async () => {
    const { dir, path } = setup(`
name: res-refail
nodes:
  - id: a
    bash: "exit 1"
`);
    await rejection(run(path, dir));
    await rejection(run(path, dir, { resume: loadRun(dir, onlyRunId(dir)) }));
    const { state } = loadRun(dir, onlyRunId(dir));
    expect(state.status).toBe("failed");
    expect(state.nodes["a"]!.status).toBe("failed");
  });

  test("resume ignores a worktree option — the original run's isolation wins", async () => {
    const { dir, path } = setup(`
name: res-nowt
nodes:
  - id: a
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir)); // in-place, and dir is not even a git repo
    const state = await run(path, dir, { resume: loadRun(dir, onlyRunId(dir)), worktree: {} });
    expect(state.status).toBe("succeeded");
    expect(state.worktree).toBeUndefined();
  });

  test("a restored node whose output was hand-stripped restores as empty, not garbage", async () => {
    const { dir, path } = setup(`
name: res-noout
nodes:
  - id: a
    prompt: "produce"
  - id: b
    depends_on: [a]
    prompt: "consume [{{nodes.a.output}}]"
`);
    await rejection(run(path, dir, { resolveRunner: useRunner(["alpha", new SaoError("boom")]) }));
    const loaded = loadRun(dir, onlyRunId(dir));
    delete loaded.state.nodes["a"]!.output;
    const resumeCalls: RunnerRequest[] = [];
    await run(path, dir, { resolveRunner: useRunner(["beta"], resumeCalls), resume: loaded });
    expect(resumeCalls[0]!.prompt).toBe("consume []");
  });

  test("skipped nodes stay skipped on resume", async () => {
    const { dir, path } = setup(`
name: res-skip
nodes:
  - id: a
    when_bash: "false"
    bash: "echo never"
  - id: b
    depends_on: [a]
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir));
    expect(loadRun(dir, onlyRunId(dir)).state.nodes["a"]!.status).toBe("skipped");
    const lines: string[] = [];
    const state = await run(path, dir, { resume: loadRun(dir, onlyRunId(dir)), print: (l) => lines.push(l) });
    expect(state.status).toBe("succeeded");
    expect(state.nodes["a"]!.status).toBe("skipped");
    expect(lines.join("\n")).toContain("↷ a (already skipped)");
  });

  test("a passed when_bash is not re-evaluated on resume — the node's own work cannot skip it away", async () => {
    const { dir, path } = setup(`
name: res-when
nodes:
  - id: a
    when_bash: "test ! -f gate-ran && touch gate-ran"
    bash: "${FAIL_ONCE} && echo body-ran"
`);
    await rejection(run(path, dir)); // predicate passes (and flips itself false), body fails once
    const loaded = loadRun(dir, onlyRunId(dir));
    expect(loaded.state.nodes["a"]!.status).toBe("failed");
    expect(loaded.state.nodes["a"]!.whenPassed).toBe(true); // persisted BEFORE the body — a crash mid-body must not re-gate
    const state = await run(path, dir, { resume: loaded });
    expect(state.status).toBe("succeeded");
    expect(state.nodes["a"]!.status).toBe("succeeded"); // re-ran the body; a re-evaluated predicate would have skipped it
    expect(state.nodes["a"]!.output).toContain("body-ran");
  });

  test("a predicate that itself failed IS re-evaluated on resume — the body never started", async () => {
    const { dir, path } = setup(`
name: res-when-refail
nodes:
  - id: a
    when_bash: "test -f allow || sleep 5"
    bash: "echo body-ran"
    timeout: 1
`);
    const err = await rejection(run(path, dir)); // predicate times out → node failed, whenPassed never set
    expect(err.message).toContain('failed at node "a"');
    const loaded = loadRun(dir, onlyRunId(dir));
    expect(loaded.state.nodes["a"]!.whenPassed).toBeUndefined();
    writeFileSync(join(dir, "allow"), "");
    const state = await run(path, dir, { resume: loaded });
    expect(state.status).toBe("succeeded");
    expect(state.nodes["a"]!.output).toContain("body-ran");
  });

  test("a run that already succeeded refuses to resume", async () => {
    const { dir, path } = setup(`
name: res-done
nodes:
  - id: a
    bash: "true"
`);
    await run(path, dir);
    const loaded = loadRun(dir, onlyRunId(dir));
    const err = await rejection(run(path, dir, { resume: loaded }));
    expect(err.message).toBe(`run ${loaded.state.id} already succeeded`);
    expect(err.hint).toBe("nothing to resume — start a new run");
  });

  test("a live owning process blocks resume; a dead one does not", async () => {
    const { dir, path } = setup(`
name: res-live
nodes:
  - id: a
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir));
    const runId = onlyRunId(dir);

    const live = loadRun(dir, runId);
    live.state.status = "running";
    live.state.pid = process.pid; // an alive pid: this test process
    const err = await rejection(run(path, dir, { resume: live }));
    expect(err.message).toBe(`run ${runId} looks live (pid ${process.pid})`);
    expect(err.hint).toContain("another sao process owns this run");

    const dead = loadRun(dir, runId);
    dead.state.status = "running";
    dead.state.pid = spawnSync("sh", ["-c", "exit 0"]).pid!; // crashed owner
    const state = await run(path, dir, { resume: dead });
    expect(state.status).toBe("succeeded");
    expect(existsSync(join(dir, ".sao", "runs", runId, "engine.lock"))).toBe(false); // released on success
  });

  test("--force bypasses a live-looking pid (reboot pid recycling)", async () => {
    const { dir, path } = setup(`
name: res-force-live
nodes:
  - id: a
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir));
    const loaded = loadRun(dir, onlyRunId(dir));
    loaded.state.status = "running";
    loaded.state.pid = process.pid; // "alive", but the user knows it is unrelated
    const state = await run(path, dir, { resume: { ...loaded, force: true } });
    expect(state.status).toBe("succeeded");
  });

  test("a held engine.lock blocks resume atomically; a stale one is reclaimed", async () => {
    const { dir, path } = setup(`
name: res-lock
nodes:
  - id: a
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir));
    const runId = onlyRunId(dir);
    const lockFile = join(dir, ".sao", "runs", runId, "engine.lock");
    expect(existsSync(lockFile)).toBe(false); // released on the failure path too

    writeFileSync(lockFile, String(process.pid)); // a live competitor holds the run
    const err = await rejection(run(path, dir, { resume: loadRun(dir, runId) }));
    expect(err.message).toBe(`run ${runId} is locked by a live sao process (pid ${process.pid})`);

    // --force takes the lock over even from a live holder (the user's call).
    writeFileSync(lockFile, String(process.pid));
    const forced = await run(path, dir, { resume: { ...loadRun(dir, runId), force: true } });
    expect(forced.status).toBe("succeeded");
    expect(existsSync(lockFile)).toBe(false);

    const refailed = loadRun(dir, runId); // mark failed again: the stale-lock leg re-enters resume

    refailed.state.status = "failed";
    writeFileSync(refailed.paths.stateFile, JSON.stringify(refailed.state));
    writeFileSync(lockFile, String(spawnSync("sh", ["-c", "exit 0"]).pid!)); // stale
    const state = await run(path, dir, { resume: loadRun(dir, runId) });
    expect(state.status).toBe("succeeded");
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a rejected gate re-asks on resume", async () => {
    const { dir, path } = setup(`
name: res-gate
nodes:
  - id: ship
    gate:
      message: "go?"
`);
    const err = await rejection(run(path, dir, { promptUser: async () => "r" }));
    expect(err.message).toContain("rejected");
    const loaded = loadRun(dir, onlyRunId(dir));
    expect(loaded.state.status).toBe("rejected");
    const questions: string[] = [];
    const state = await run(path, dir, {
      resume: loaded,
      promptUser: async (message) => {
        questions.push(message);
        return "a";
      },
    });
    expect(state.status).toBe("succeeded");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("go?");
  });
});

describe("resume config guard", () => {
  test("a changed workflow file blocks resume unless forced, and force records the new hash", async () => {
    const { dir, path } = setup(`
name: res-hash
nodes:
  - id: a
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir));
    const runId = onlyRunId(dir);
    writeFileSync(path, readFileSync(path, "utf8") + "# edited\n");

    const err = await rejection(run(path, dir, { resume: loadRun(dir, runId) }));
    expect(err.message).toBe("the run's configuration changed since it started (workflow, agent files, or mcp config)");
    expect(err.hint).toContain("--force");

    const state = await run(path, dir, { resume: { ...loadRun(dir, runId), force: true } });
    expect(state.status).toBe("succeeded");
    expect(state.workflowHash).toBe(hashRunConfig(path, loadWorkflow(path, { cwd: dir })));
  });

  test("the hash covers agent files: editing a system prompt requires --force", async () => {
    const { dir, path } = setup(`
name: res-agent-hash
nodes:
  - id: a
    agent: helper
    prompt: "hi"
  - id: b
    depends_on: [a]
    bash: "${FAIL_ONCE}"
`);
    const agentFile = join(dir, ".agents", "agents", "helper.md");
    mkdirSync(join(dir, ".agents", "agents"), { recursive: true });
    writeFileSync(agentFile, "---\nname: helper\ndescription: d\n---\nBe helpful.\n");
    await rejection(run(path, dir, { resolveRunner: useRunner(["ok"]) }));
    const runId = onlyRunId(dir);

    writeFileSync(agentFile, "---\nname: helper\ndescription: d\n---\nBe evil.\n");
    const err = await rejection(run(path, dir, { resolveRunner: useRunner(["ok"]), resume: loadRun(dir, runId) }));
    expect(err.message).toContain("configuration changed");
  });

  test("vars for inputs removed by a forced edit are dropped, not fatal", async () => {
    const { dir, path } = setup(`
name: res-vars
inputs:
  - name: flavor
    required: true
nodes:
  - id: a
    bash: "echo {{flavor}}"
  - id: b
    depends_on: [a]
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir, { vars: { flavor: "mint" } }));
    const runId = onlyRunId(dir);
    writeFileSync(
      path,
      `
name: res-vars
nodes:
  - id: a
    bash: "echo no-more-flavor"
  - id: b
    depends_on: [a]
    bash: "${FAIL_ONCE}"
`,
    );
    const loaded = loadRun(dir, runId);
    expect(loaded.state.vars).toEqual({ flavor: "mint" }); // persisted from the original run
    const state = await run(path, dir, { vars: loaded.state.vars, resume: { ...loaded, force: true } });
    expect(state.status).toBe("succeeded");
  });

  test("a forced resume hitting a NEW required input gets an actionable hint (resume has no --var)", async () => {
    const { dir, path } = setup(`
name: res-newinput
nodes:
  - id: a
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir));
    const runId = onlyRunId(dir);
    writeFileSync(
      path,
      `
name: res-newinput
inputs:
  - name: audience
    required: true
nodes:
  - id: a
    bash: "echo {{audience}}"
`,
    );
    const err = await rejection(run(path, dir, { resume: { ...loadRun(dir, runId), force: true } }));
    expect(err.message).toBe('missing required input "audience"');
    expect(err.hint).toBe("the edited workflow now requires it — give it a default:, or start a new run");
    expect(err.hint).not.toContain("--var"); // a flag sao resume does not have
  });

  test("vars for inputs that are still declared survive the resume filtering", async () => {
    const { dir, path } = setup(`
name: res-vars-kept
inputs:
  - name: keep
    required: true
nodes:
  - id: a
    bash: "echo kept=[{{keep}}]"
  - id: b
    depends_on: [a]
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir, { vars: { keep: "v1" } }));
    const loaded = loadRun(dir, onlyRunId(dir));
    const state = await run(path, dir, { vars: loaded.state.vars, resume: loaded });
    expect(state.status).toBe("succeeded"); // the required input arrived through the filter
    expect(state.nodes["a"]!.output).toBe("kept=[v1]");
  });
});

describe("resume execution parameters", () => {
  test("in-place runs resume in the directory they started in, not the resumer's cwd", async () => {
    const { dir, path } = setup(`
name: res-cwd
nodes:
  - id: w
    bash: "echo one > out1.txt"
  - id: f
    depends_on: [w]
    bash: "${FAIL_ONCE}"
  - id: w2
    depends_on: [f]
    bash: "echo two > out2.txt"
`);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    await rejection(run(path, dir, { cwd: sub, runRoot: dir }));
    const loaded = loadRun(dir, onlyRunId(dir));
    expect(loaded.state.cwd).toBe("sub");

    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    const state = await run(path, dir, { cwd: elsewhere, runRoot: dir, resume: loaded });
    expect(state.status).toBe("succeeded"); // marker was visible → f ran in sub again
    expect(existsSync(join(sub, "out2.txt"))).toBe(true);
    expect(existsSync(join(elsewhere, "out2.txt"))).toBe(false);
  });

  test("a --runner override is persisted and reapplied on resume", async () => {
    const { dir, path } = setup(`
name: res-runner
defaults:
  runner: codex
nodes:
  - id: a
    prompt: "hi"
  - id: b
    depends_on: [a]
    bash: "${FAIL_ONCE}"
`);
    const resolved: string[] = [];
    const resolver = (name: string) => {
      resolved.push(name);
      return flakyRunner(["ok"]);
    };
    await rejection(run(path, dir, { runnerOverride: "special", resolveRunner: resolver }));
    const loaded = loadRun(dir, onlyRunId(dir));
    expect(loaded.state.runnerOverride).toBe("special");

    resolved.length = 0;
    const state = await run(path, dir, { resolveRunner: resolver, resume: loaded });
    expect(state.status).toBe("succeeded");
    expect(resolved).toContain("special");
    expect(resolved).not.toContain("codex"); // the workflow default must not sneak back in
  });

  test("concurrency is persisted and reused on resume", async () => {
    const { dir, path } = setup(`
name: res-conc
nodes:
  - id: a
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir, { concurrency: 1 }));
    const loaded = loadRun(dir, onlyRunId(dir));
    expect(loaded.state.concurrency).toBe(1);
    const state = await run(path, dir, { resume: loaded });
    expect(state.concurrency).toBe(1);
  });

  test("an explicit concurrency on resume updates the persisted value", async () => {
    const { dir, path } = setup(`
name: res-conc-up
nodes:
  - id: a
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir, { concurrency: 1 }));
    const state = await run(path, dir, { resume: loadRun(dir, onlyRunId(dir)), concurrency: 3 });
    expect(state.concurrency).toBe(3);
  });

  test("legacy states without cwd/concurrency resume via the caller's cwd and stay legacy", async () => {
    const { dir, path } = setup(`
name: res-legacy
nodes:
  - id: a
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir));
    const loaded = loadRun(dir, onlyRunId(dir));
    delete loaded.state.cwd; // an M1/M2-era state never wrote these
    delete loaded.state.concurrency;
    const state = await run(path, dir, { resume: loaded });
    expect(state.status).toBe("succeeded");
    expect(state.concurrency).toBeUndefined(); // not backfilled — only explicit values persist
  });

  test("nodes added by a forced edit start exactly pending", async () => {
    const { dir, path } = setup(`
name: res-added
nodes:
  - id: broken
    bash: "exit 1"
`);
    await rejection(run(path, dir));
    const runId = onlyRunId(dir);
    writeFileSync(
      path,
      `
name: res-added
nodes:
  - id: broken
    bash: "exit 1"
  - id: later
    depends_on: [broken]
    bash: "echo never-reached"
`,
    );
    await rejection(run(path, dir, { resume: { ...loadRun(dir, runId), force: true } }));
    const { state } = loadRun(dir, runId);
    expect(state.nodes["later"]).toEqual({ status: "pending" });
  });
});

describe("loop resume", () => {
  test("continues from the failed iteration with the saved session", async () => {
    const { dir, path } = setup(`
name: res-loop
nodes:
  - id: work
    loop:
      prompt: "iteration {{loop.iteration}} fb[{{loop.feedback}}]"
      until: DONE
      max_iterations: 4
      fresh_context: false
`);
    const firstCalls: RunnerRequest[] = [];
    await rejection(run(path, dir, { resolveRunner: useRunner(["no", new SaoError("crash")], firstCalls) }));
    const loaded = loadRun(dir, onlyRunId(dir));
    expect(loaded.state.nodes["work"]!.iterations).toBe(2);
    expect(loaded.state.nodes["work"]!.sessionId).toBe("session-1");

    const resumeCalls: RunnerRequest[] = [];
    const state = await run(path, dir, {
      resolveRunner: useRunner(["done <promise>DONE</promise>"], resumeCalls),
      resume: loaded,
    });
    expect(state.status).toBe("succeeded");
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]!.prompt).toContain("iteration 2 fb[]"); // resumed mid-loop, no stale feedback
    expect(resumeCalls[0]!.resumeSessionId).toBe("session-1"); // conversation resumed
    expect(state.nodes["work"]!.iterations).toBe(2);
  });

  test("an interactive loop resumes with the feedback that fed the failed iteration", async () => {
    const { dir, path } = setup(`
name: res-feedback
nodes:
  - id: chat
    loop:
      prompt: "consider [{{loop.feedback}}]"
      until: SETTLED
      max_iterations: 4
      interactive: true
`);
    const firstCalls: RunnerRequest[] = [];
    await rejection(
      run(path, dir, {
        resolveRunner: useRunner(["draft", new SaoError("crash")], firstCalls),
        promptUser: async () => "make it blue",
      }),
    );
    const loaded = loadRun(dir, onlyRunId(dir));
    expect(loaded.state.nodes["chat"]!.lastFeedback).toBe("make it blue");

    const resumeCalls: RunnerRequest[] = [];
    const state = await run(path, dir, {
      resolveRunner: useRunner(["blue <promise>SETTLED</promise>"], resumeCalls),
      promptUser: async () => "a",
      resume: loaded,
    });
    expect(state.status).toBe("succeeded");
    expect(resumeCalls[0]!.prompt).toContain("consider [make it blue]");
  });

  test("the resume hint is consumed once: a retry after a failed resumed attempt restarts at iteration 1", async () => {
    const { dir, path } = setup(`
name: res-retry
nodes:
  - id: work
    retries: 1
    loop:
      prompt: "iteration {{loop.iteration}}"
      until: DONE
      max_iterations: 4
`);
    // Attempt 1 dies at iteration 1; the retry gets to iteration 2 and dies there —
    // so the persisted resume point is iteration 2.
    await rejection(
      run(path, dir, { resolveRunner: useRunner([new SaoError("crash-0"), "no", new SaoError("crash-1")]) }),
    );
    const loaded = loadRun(dir, onlyRunId(dir));
    expect(loaded.state.nodes["work"]!.iterations).toBe(2);

    const resumeCalls: RunnerRequest[] = [];
    const state = await run(path, dir, {
      resolveRunner: useRunner([new SaoError("crash-2"), "ok <promise>DONE</promise>"], resumeCalls),
      resume: loaded,
    });
    expect(state.status).toBe("succeeded");
    expect(resumeCalls[0]!.prompt).toContain("iteration 2"); // attempt 1: resumed mid-loop
    expect(resumeCalls[1]!.prompt).toContain("iteration 1"); // attempt 2: SPEC retry semantics
  });
});

describe("node ids that collide with Object.prototype", () => {
  test("a node named constructor added by a forced edit is recorded and not re-run forever", async () => {
    const { dir, path } = setup(`
name: res-proto
nodes:
  - id: a
    bash: "true"
  - id: boom
    depends_on: [a]
    bash: "${FAIL_ONCE}"
`);
    await rejection(run(path, dir));
    const runId = onlyRunId(dir);
    writeFileSync(
      path,
      `
name: res-proto
nodes:
  - id: a
    bash: "true"
  - id: constructor
    depends_on: [a]
    bash: "echo ran >> proto-count.txt"
  - id: boom
    depends_on: [constructor]
    bash: "${FAIL_ONCE}"
`,
    );
    const state = await run(path, dir, { resume: { ...loadRun(dir, runId), force: true } });
    expect(state.status).toBe("succeeded");
    expect(readFileSync(join(dir, "proto-count.txt"), "utf8")).toBe("ran\n");
    const persisted = JSON.parse(readFileSync(loadRun(dir, runId).paths.stateFile, "utf8")) as RunState;
    expect(persisted.nodes["constructor"]!.status).toBe("succeeded"); // recorded, not lost to the prototype
    expect(Object.hasOwn(Object as object, "status")).toBe(false); // and the global was not polluted
  });
});

describe("worktree lifecycle", () => {
  test("runs execute in an isolated worktree; success finalizes and reports it", async () => {
    const { dir, path } = setup(`
name: wt-run
nodes:
  - id: env
    bash: "echo id={{run_id}} base=[{{base}}] branch=[{{branch}}] && echo env=$SAO_RUN_ID:$SAO_BRANCH"
  - id: write
    depends_on: [env]
    bash: "echo made > artifact.txt"
`);
    gitify(dir);
    const lines: string[] = [];
    const state = await run(path, dir, { worktree: {}, print: (line) => lines.push(line) });
    expect(state.status).toBe("succeeded");
    expect(state.worktree).toBe(worktreeRelPath(state.id));
    expect(state.branch).toBe(`sao/${state.id}`);
    expect(state.base).toMatch(/^[0-9a-f]{40}$/); // defaulted base resolves to the HEAD SHA
    expect(state.cwd).toBeUndefined(); // cwd is persisted only for in-place runs

    const worktree = join(dir, state.worktree!);
    expect(existsSync(join(worktree, "artifact.txt"))).toBe(true);
    expect(existsSync(join(dir, "artifact.txt"))).toBe(false); // main tree untouched
    expect(git(worktree, "log", "-1", "--format=%s")).toBe(`sao: finalize run ${state.id}`);
    expect(state.nodes["env"]!.output).toContain(`id=${state.id} base=[${state.base}] branch=[sao/${state.id}]`);
    expect(state.nodes["env"]!.output).toContain(`env=${state.id}:sao/${state.id}`);
    const report = lines.join("\n");
    expect(report).toContain(`worktree ${state.worktree} on branch sao/${state.id} (base ${state.base})`);
    expect(report).toContain("finalized: committed remaining worktree changes");
    expect(report).toContain(`branch:   sao/${state.id}`);
    expect(report).toContain(`worktree: ${state.worktree}`);
    expect(report).toContain(`review:   git diff ${state.base}...sao/${state.id}`);
    expect(report).toContain(`merge:    git merge sao/${state.id}   (worktree kept until: sao clean)`);
    expect(report).toContain(`pr:       git push -u origin sao/${state.id} && gh pr create --head sao/${state.id}`);
  });

  test("a run that changes nothing reports no finalize commit", async () => {
    const { dir, path } = setup(`
name: wt-clean
nodes:
  - id: a
    bash: "true"
`);
    gitify(dir);
    const lines: string[] = [];
    const state = await run(path, dir, { worktree: {}, print: (line) => lines.push(line) });
    expect(state.status).toBe("succeeded");
    expect(lines.join("\n")).not.toContain("finalized:");
  });

  test("a finalize failure is a warning on a still-successful run", async () => {
    const { dir, path } = setup(`
name: wt-finfail
nodes:
  - id: sabotage
    bash: "echo 'gitdir: /nonexistent-gitdir' > .git && echo done"
`);
    gitify(dir);
    const lines: string[] = [];
    const state = await run(path, dir, { worktree: {}, print: (line) => lines.push(line) });
    expect(state.status).toBe("succeeded");
    const report = lines.join("\n");
    expect(report).toContain("⚠ finalize commit failed: git status failed in the worktree");
    expect(report).toContain("(fatal:"); // the git stderr detail rides along as the hint
    expect(report).not.toContain("finalized:");
  });

  test("base precedence: option beats workflow base:, which beats HEAD", async () => {
    const { dir, path } = setup(`
name: wt-base
base: marker-b1
nodes:
  - id: a
    bash: "true"
`);
    gitify(dir);
    git(dir, "branch", "marker-b1");
    git(dir, "branch", "marker-b2");
    const fromWorkflow = await run(path, dir, { worktree: {} });
    expect(fromWorkflow.base).toBe("marker-b1");
    const fromOption = await run(path, dir, { worktree: { base: "marker-b2" } });
    expect(fromOption.base).toBe("marker-b2");
  });

  test("a custom branch name is validated, checked for collisions, and used", async () => {
    const { dir, path } = setup(`
name: wt-branch
nodes:
  - id: a
    bash: "true"
`);
    gitify(dir);
    const state = await run(path, dir, { worktree: { branch: "feat/custom" } });
    expect(state.branch).toBe("feat/custom");
    expect(git(dir, "branch", "--list", "feat/custom")).not.toBe("");

    const collision = await rejection(run(path, dir, { worktree: { branch: "feat/custom" } }));
    expect(collision.message).toBe("branch already exists: feat/custom");
    const optionShaped = await rejection(run(path, dir, { worktree: { branch: "-f" } }));
    expect(optionShaped.message).toBe("invalid branch name: -f");
  });

  test("config errors are rejected before any run dir exists", async () => {
    const { dir, path } = setup(`
name: wt-early
nodes:
  - id: a
    bash: "true"
`);
    const noRepo = await rejection(run(path, dir, { worktree: {} }));
    expect(noRepo.message).toContain("not a git repository");
    gitify(dir);
    const badBase = await rejection(run(path, dir, { worktree: { base: "ghost" } }));
    expect(badBase.message).toBe("base ref not found: ghost");
    expect(existsSync(join(dir, ".sao", "runs"))).toBe(false); // nothing orphaned
  });

  test("a setup failure after the run dir exists leaves a visible failed run, not an orphan", async () => {
    const { dir, path } = setup(`
name: wt-orphan
nodes:
  - id: a
    bash: "true"
`);
    gitify(dir);
    mkdirSync(join(dir, ".sao"), { recursive: true });
    writeFileSync(join(dir, ".sao", "worktrees"), "a file where the dir must go");
    const err = await rejection(run(path, dir, { worktree: {} }));
    expect(err.message).toContain("cannot create"); // the mkdir failure, formatted — not a raw stack
    const runId = onlyRunId(dir);
    const { state } = loadRun(dir, runId); // parseable → visible to list/clean
    expect(state.status).toBe("failed");
    // The branch was never created (mkdir died first) and did not pre-exist, so the
    // recorded name stays — clean --all's deleteBranch simply no-ops on it.
    expect(state.branch).toBe(`sao/${runId}`);
    // The isolation INTENT was persisted before the add: a resume must refuse with
    // "worktree is gone" — never silently execute in the invoker's directory.
    state.status = "failed";
    const resumed = await rejection(run(path, dir, { resume: { state, paths: loadRun(dir, runId).paths } }));
    expect(resumed.message).toContain("worktree is gone");
    expect(resumed.hint).toContain("crashed while the worktree was being created");
  });

  test("an interactive loop treats a natural 'no' as feedback, not a run rejection", async () => {
    const { dir, path } = setup(`
name: wt-interview
nodes:
  - id: interview
    loop:
      prompt: "answer was [{{loop.feedback}}]"
      until: SETTLED
      max_iterations: 3
      interactive: true
`);
    const replies = ["no", "a"]; // "no" answers the agent's question; "a" approves the signaled round
    let call = 0;
    const calls: RunnerRequest[] = [];
    const state = await run(path, dir, {
      resolveRunner: useRunner(["is it public?", "done <promise>SETTLED</promise>"], calls),
      promptUser: async () => replies[call++]!,
    });
    expect(state.status).toBe("succeeded");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("answer was [no]"); // fed forward, run never halted
  });

  test("resume reuses the original worktree and refuses a missing or tampered one", async () => {
    const { dir, path } = setup(`
name: wt-resume
nodes:
  - id: w
    bash: "echo kept > evidence.txt"
  - id: f
    depends_on: [w]
    bash: "${FAIL_ONCE}"
`);
    gitify(dir);
    await rejection(run(path, dir, { worktree: {} }));
    const runId = onlyRunId(dir);
    const worktree = join(dir, worktreeRelPath(runId));
    expect(existsSync(join(worktree, "evidence.txt"))).toBe(true);

    const tampered = loadRun(dir, runId);
    const untamperedJson = readFileSync(tampered.paths.stateFile, "utf8");
    tampered.state.worktree = join("..", "outside");
    const refused = await rejection(run(path, dir, { resume: tampered }));
    expect(refused.message).toContain("not the expected");
    expect(refused.hint).toContain("state.json was edited");
    // The refused resume marked the run failed with the (in-memory) tampered path
    // persisted — restore the on-disk original before resuming for real.
    writeFileSync(tampered.paths.stateFile, untamperedJson);

    const state = await run(path, dir, { resume: loadRun(dir, runId) });
    expect(state.status).toBe("succeeded");
    expect(existsSync(join(worktree, "evidence.txt"))).toBe(true); // first attempt's work survived

    rmSync(worktree, { recursive: true, force: true });
    const gone = loadRun(dir, runId);
    gone.state.status = "failed";
    const missing = await rejection(run(path, dir, { resume: gone }));
    expect(missing.message).toContain("worktree is gone");
    expect(missing.hint).toContain("sao clean");

    // A SIGKILL-mid-add husk (dir exists, but is not a worktree) must refuse the
    // same way — never execute nodes in a directory that only LOOKS like isolation.
    mkdirSync(worktree, { recursive: true });
    const husk = loadRun(dir, runId);
    husk.state.status = "failed";
    const refusedHusk = await rejection(run(path, dir, { resume: husk }));
    expect(refusedHusk.message).toContain("worktree is gone");
    expect(refusedHusk.hint).toContain("crashed while the worktree was being created");
  });
});

describe("run metadata in place", () => {
  test("in-place runs get empty branch/base, the cwd as SAO_WORKTREE, and the run id everywhere", async () => {
    const { dir, path } = setup(`
name: meta-inplace
nodes:
  - id: a
    bash: "echo id={{run_id}} base=[{{base}}] branch=[{{branch}}] wt=$SAO_WORKTREE ref=[$SAO_BASE_REF]"
`);
    const state = await run(path, dir);
    const output = state.nodes["a"]!.output!;
    expect(output).toContain(`id=${state.id}`);
    expect(output).toContain("base=[]");
    expect(output).toContain("branch=[]");
    expect(output).toContain(`wt=${dir}`);
    expect(output).toContain("ref=[]");
  });

  test("AI runner subprocesses receive the SAO_* environment", async () => {
    const { dir, path } = setup(`
name: meta-ai
nodes:
  - id: a
    prompt: "hi"
`);
    const calls: RunnerRequest[] = [];
    const state = await run(path, dir, { resolveRunner: useRunner(["ok"], calls) });
    expect(calls[0]!.env).toEqual({
      SAO_RUN_ID: state.id,
      SAO_BASE_REF: "",
      SAO_BRANCH: "",
      SAO_WORKTREE: dir,
    });
  });
});

describe("hashRunConfig", () => {
  test("changes when the workflow, an agent file, or the mcp config changes", () => {
    const { dir, path } = setup(`
name: hash-cfg
mcp: ./mcp.json
nodes:
  - id: a
    agent: helper
    prompt: "hi"
`);
    mkdirSync(join(dir, ".agents", "agents"), { recursive: true });
    const agentFile = join(dir, ".agents", "agents", "helper.md");
    writeFileSync(agentFile, "---\nname: helper\ndescription: d\n---\nA\n");
    const mcpFile = join(dir, "mcp.json");
    writeFileSync(mcpFile, '{"mcpServers":{}}\n');

    const load = () => loadWorkflow(path, { cwd: dir });
    const original = hashRunConfig(path, load());
    expect(original).toMatch(/^sha256:[0-9a-f]{64}$/); // a real hex digest, not bytes glued to a prefix
    expect(hashRunConfig(path, load())).toBe(original); // stable

    writeFileSync(agentFile, "---\nname: helper\ndescription: d\n---\nB\n");
    const afterAgent = hashRunConfig(path, load());
    expect(afterAgent).not.toBe(original);

    writeFileSync(mcpFile, '{"mcpServers":{"x":{}}}\n');
    const afterMcp = hashRunConfig(path, load());
    expect(afterMcp).not.toBe(afterAgent);

    writeFileSync(path, readFileSync(path, "utf8") + "# tweak\n");
    expect(hashRunConfig(path, load())).not.toBe(afterMcp);
  });

  test("agent boundaries are framed: moving bytes between adjacent agent files changes the hash", () => {
    const yaml = `
name: hash-seam
nodes:
  - id: a
    agent: first
    prompt: "hi"
  - id: b
    agent: second
    prompt: "ho"
`;
    const make = (firstBody: string, secondBody: string) => {
      const { dir, path } = setup(yaml);
      mkdirSync(join(dir, ".agents", "agents"), { recursive: true });
      writeFileSync(join(dir, ".agents", "agents", "first.md"), `---\nname: first\ndescription: d\n---\n${firstBody}`);
      writeFileSync(
        join(dir, ".agents", "agents", "second.md"),
        `---\nname: second\ndescription: d\n---\n${secondBody}`,
      );
      return hashRunConfig(path, loadWorkflow(path, { cwd: dir }));
    };
    // Identical workflow bytes and identical concatenated agent bytes — only the
    // seam position differs. Unframed hashing would collide.
    expect(make("XY", "Z")).not.toBe(make("X", "YZ"));
  });
});
