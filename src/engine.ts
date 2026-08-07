import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import pc from "picocolors";
import { SaoError } from "./errors";
import { executeAiNode, executeBashNode, withRetries } from "./nodes";
import { orderNodes } from "./parser";
import { onShutdown } from "./procs";
import { getRunner, type Runner, type RunnerResolver } from "./runners/types";
import type { Workflow, WorkflowNode } from "./schema";
import { createRun, hashFile, saveState, type RunPaths, type RunState } from "./state";
import { interpolate, type TemplateContext } from "./template";

export interface RunWorkflowOptions {
  workflow: Workflow;
  workflowPath: string;
  task: string;
  vars: Record<string, string>;
  /** Where nodes execute and where .sao/ lives. M1 runs in place; worktrees land in M3. */
  cwd: string;
  runnerOverride?: string;
  resolveRunner?: RunnerResolver;
  print?: (line: string) => void;
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunState> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const resolveRunner = opts.resolveRunner ?? getRunner;
  const inputs = resolveInputs(opts.workflow, opts.vars);
  const ordered = orderNodes(opts.workflow);

  const runners = preflightRunners(opts.workflow, opts.runnerOverride, resolveRunner);

  const { runId, paths } = createRun(opts.cwd, opts.workflow.name);
  const state: RunState = {
    id: runId,
    workflow: opts.workflowPath,
    workflowHash: hashFile(opts.workflowPath),
    task: opts.task,
    vars: inputs,
    status: "running",
    nodes: Object.fromEntries(ordered.map((node) => [node.id, { status: "pending" as const }])),
  };
  saveState(paths, state);
  print(pc.bold(`sao run ${runId}`) + pc.dim(` (${ordered.length} nodes, logs in ${paths.logsDir})`));

  // A Ctrl-C / SIGTERM mid-run must not leave state.json claiming "running" forever.
  const releaseShutdownHook = onShutdown(() => {
    state.status = "failed";
    for (const nodeState of Object.values(state.nodes)) {
      if (nodeState.status === "running") nodeState.status = "failed";
    }
    saveState(paths, state);
  });

  const ctx: TemplateContext = { task: opts.task, inputs, nodeOutputs: {} };

  try {
    await runNodes(ordered, state, ctx, opts, runners, paths, runId, print);
  } finally {
    releaseShutdownHook();
  }

  state.status = "succeeded";
  saveState(paths, state);
  print(pc.green(pc.bold(`✓ run ${runId} succeeded`)));
  return state;
}

async function runNodes(
  ordered: WorkflowNode[],
  state: RunState,
  ctx: TemplateContext,
  opts: RunWorkflowOptions,
  runners: Map<string, Runner>,
  paths: RunPaths,
  runId: string,
  print: (line: string) => void,
): Promise<void> {
  for (const node of ordered) {
    const nodeState = state.nodes[node.id]!;
    nodeState.status = "running";
    nodeState.startedAt = new Date().toISOString();
    saveState(paths, state);
    print(pc.cyan(`→ ${node.id}`) + pc.dim(` (${node.kind})`));

    const logStream = createWriteStream(join(paths.logsDir, `${node.id}.log`));
    logStream.on("error", () => {}); // best-effort logging: a failed write must not crash the run
    // Echo only completed lines so a line delivered across chunks isn't split apart.
    let pendingEcho = "";
    const echoLine = (line: string) => {
      if (line.trim()) print(pc.dim(`  [${node.id}] `) + line);
    };
    const log = (chunk: string) => {
      logStream.write(chunk);
      pendingEcho += chunk;
      const lines = pendingEcho.split("\n");
      pendingEcho = lines.pop()!; // split() always yields at least one element
      for (const line of lines) echoLine(line);
      if (pendingEcho.length > 8192) {
        echoLine(pendingEcho); // don't buffer a runaway newline-less line forever
        pendingEcho = "";
      }
    };
    const flushEcho = () => {
      echoLine(pendingEcho);
      // Stryker disable next-line all: dead store — flushEcho is the last use of this node's pendingEcho
      pendingEcho = "";
    };

    const startedMs = Date.now();
    try {
      const result = await withRetries(node.retries, () => executeNode(node, ctx, opts, runners, log));
      nodeState.status = "succeeded";
      nodeState.output = result.output;
      if (result.sessionId) nodeState.sessionId = result.sessionId;
      ctx.nodeOutputs[node.id] = result.output;
      flushEcho(); // a trailing unterminated line must land before the ✓ line
      print(pc.green(`✓ ${node.id}`) + pc.dim(` (${((Date.now() - startedMs) / 1000).toFixed(1)}s)`));
    } catch (err) {
      nodeState.status = "failed";
      nodeState.endedAt = new Date().toISOString();
      state.status = "failed";
      saveState(paths, state);
      flushEcho();
      logStream.end();
      await finished(logStream).catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      const logHint = `full output: ${join(paths.logsDir, `${node.id}.log`)}`;
      const hint = err instanceof SaoError && err.hint ? `${err.hint}\n  ${logHint}` : logHint;
      throw new SaoError(`run ${runId} failed at node "${node.id}": ${message}`, hint);
    }
    nodeState.endedAt = new Date().toISOString();
    saveState(paths, state);
    logStream.end();
    await finished(logStream).catch(() => {});
  }
}

/**
 * Resolve every AI node's effective runner (node > defaults > "claude", with the CLI
 * override on top). Used by `sao validate` and by runWorkflow before any run state
 * exists, so a config error can't leave a failed run under .sao/.
 */
export function preflightRunners(
  workflow: Workflow,
  runnerOverride?: string,
  resolveRunner: RunnerResolver = getRunner,
): Map<string, Runner> {
  const runners = new Map<string, Runner>();
  for (const node of workflow.nodes) {
    if (node.kind !== "ai") continue;
    const runnerName = runnerOverride ?? node.runner ?? workflow.defaults.runner ?? "claude";
    try {
      runners.set(node.id, resolveRunner(runnerName));
    } catch (err) {
      if (err instanceof SaoError) throw new SaoError(`node "${node.id}": ${err.message}`, err.hint);
      throw err;
    }
  }
  return runners;
}

async function executeNode(
  node: WorkflowNode,
  ctx: TemplateContext,
  opts: RunWorkflowOptions,
  runners: Map<string, Runner>,
  log: (chunk: string) => void,
): Promise<{ output: string; sessionId?: string }> {
  const execCtx = { cwd: opts.cwd, log };
  if (node.kind === "bash") {
    const output = await executeBashNode(node, interpolate(node.bash, ctx), execCtx);
    return { output };
  }
  const runner = runners.get(node.id)!; // prefetched in runWorkflow
  return executeAiNode(
    node,
    interpolate(node.prompt, ctx),
    runner,
    { model: opts.workflow.defaults.model, permissionMode: opts.workflow.defaults.permission_mode },
    execCtx,
  );
}

function resolveInputs(workflow: Workflow, vars: Record<string, string>): Record<string, string> {
  const declared = new Map(workflow.inputs.map((input) => [input.name, input]));
  for (const key of Object.keys(vars)) {
    if (!declared.has(key)) {
      throw new SaoError(`unknown input "${key}"`, `declared inputs: ${[...declared.keys()].join(", ") || "(none)"}`);
    }
  }
  // Null-prototype + hasOwn: `--var __proto__=…` must not read/write Object.prototype.
  const resolved: Record<string, string> = Object.create(null);
  for (const input of workflow.inputs) {
    const value = Object.hasOwn(vars, input.name) ? vars[input.name] : input.default;
    if (value === undefined) {
      if (input.required) throw new SaoError(`missing required input "${input.name}"`, `pass it with --var ${input.name}=<value>`);
      continue;
    }
    resolved[input.name] = value;
  }
  return resolved;
}
