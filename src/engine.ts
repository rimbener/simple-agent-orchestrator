import { createWriteStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import pc from "picocolors";
import { GateRejectedError, SaoError } from "./errors";
import { parseGateReply, promptOnTerminal, type PromptUser } from "./gate";
import { evaluateWhenBash, executeAiNode, executeBashScript, withRetries } from "./nodes";
import { orderNodes } from "./parser";
import { onShutdown } from "./procs";
import { getRunner, type Runner, type RunnerResolver } from "./runners/types";
import type { AgentSpec, GateNode, LoopNode, Workflow, WorkflowNode } from "./schema";
import { createRun, hashFile, saveState, type RunPaths, type RunState } from "./state";
import { interpolate, type TemplateContext } from "./template";

const DEFAULT_CONCURRENCY = 2;

export interface RunWorkflowOptions {
  workflow: Workflow;
  workflowPath: string;
  task: string;
  vars: Record<string, string>;
  /** Where nodes execute. Runs in place; worktrees land in M3. */
  cwd: string;
  /** Where .sao/ lives (default: cwd). The CLI passes the repo root, per SPEC step 3. */
  runRoot?: string;
  /** Max nodes executing at once (default 2). */
  concurrency?: number;
  runnerOverride?: string;
  resolveRunner?: RunnerResolver;
  /** Terminal prompt for gates and interactive loops (injectable for tests). */
  promptUser?: PromptUser;
  print?: (line: string) => void;
}

/** The sentinel token a loop agent emits to signal its `until:` condition. */
export function sentinelToken(signal: string): string {
  return `<promise>${signal}</promise>`;
}

/** Instruction the engine appends to a loop prompt (SPEC: Loop semantics). */
export function sentinelInstruction(signal: string): string {
  return (
    `\n\nIf and only if the condition "${signal}" is fully satisfied, end your response` +
    ` with exactly ${sentinelToken(signal)}. Otherwise, do not emit that token anywhere.`
  );
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunState> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const promptUser = opts.promptUser ?? promptOnTerminal;
  const resolveRunner = opts.resolveRunner ?? getRunner;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const inputs = resolveInputs(opts.workflow, opts.vars);
  const ordered = orderNodes(opts.workflow);

  const aiConfigs = preflightAiConfigs(opts.workflow, opts.runnerOverride, resolveRunner);

  // Hash before creating the run dir: a vanished workflow file must not orphan a dir.
  const workflowHash = hashFile(opts.workflowPath);
  const { runId, paths } = createRun(opts.runRoot ?? opts.cwd, opts.workflow.name);

  // Inline mcp: servers become a per-run config file; a path form was already resolved.
  let mcpConfigPath = opts.workflow.mcpConfigPath;
  if (opts.workflow.mcpServers !== undefined) {
    mcpConfigPath = join(paths.dir, "mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: opts.workflow.mcpServers }, null, 2) + "\n");
  }

  const state: RunState = {
    id: runId,
    workflow: opts.workflowPath,
    workflowHash,
    task: opts.task,
    vars: inputs,
    status: "running",
    nodes: Object.fromEntries(ordered.map((node) => [node.id, { status: "pending" as const }])),
  };
  saveState(paths, state);
  print(pc.bold(`sao run ${runId}`) + pc.dim(` (${ordered.length} nodes, concurrency ${concurrency}, logs in ${paths.logsDir})`));

  // A Ctrl-C / SIGTERM mid-run must not leave state.json claiming "running" forever.
  const releaseShutdownHook = onShutdown(() => {
    // Stryker disable next-line ConditionalExpression: equivalent in practice — the hook is released in the finally below, so at teardown time the only reachable run status is "running"
    if (state.status === "running") state.status = "failed";
    for (const nodeState of Object.values(state.nodes)) {
      if (nodeState.status === "running") nodeState.status = "failed";
    }
    saveState(paths, state);
  });

  const engine = new Engine(opts, state, paths, runId, aiConfigs, mcpConfigPath, promptUser, print, inputs);
  await engine.run(ordered, concurrency).finally(releaseShutdownHook);

  state.status = "succeeded";
  saveState(paths, state);
  print(pc.green(pc.bold(`✓ run ${runId} succeeded`)));
  return state;
}

/** Per-execution AI settings after the node > agent > loop-node > loop-agent > defaults chain. */
export interface ResolvedAiConfig {
  runner: Runner;
  model?: string;
  permissionMode?: string;
  systemPrompt?: string;
  allowedTools?: string[];
}

interface AiUnit {
  agent?: string;
  runner?: string;
  model?: string;
  allowed_tools?: string[];
}

/**
 * Resolve every AI execution unit's settings (AI nodes, loop prompts, AI steps —
 * steps are keyed `<node-id>#<step-index>`) before any run state exists, so a config
 * error can't leave a failed run under .sao/. Also used by `sao validate`.
 */
export function preflightAiConfigs(
  workflow: Workflow,
  runnerOverride?: string,
  resolveRunner: RunnerResolver = getRunner,
): Map<string, ResolvedAiConfig> {
  const configs = new Map<string, ResolvedAiConfig>();
  const put = (key: string, nodeId: string, unit: AiUnit, nodeLevel?: AiUnit) => {
    try {
      configs.set(key, resolveAiConfig(workflow, runnerOverride, resolveRunner, unit, nodeLevel));
    } catch (err) {
      if (err instanceof SaoError) throw new SaoError(`node "${nodeId}": ${err.message}`, err.hint);
      throw err;
    }
  };
  for (const node of workflow.nodes) {
    if (node.kind === "ai") {
      put(node.id, node.id, node);
    } else if (node.kind === "loop") {
      if (node.loop.prompt !== undefined) put(node.id, node.id, node);
      // Stryker disable next-line ArrayDeclaration: equivalent — the fallback only fires for prompt loops (steps undefined), and any replacement array's entries fail the step.kind === "ai" check
      for (const [index, step] of (node.loop.steps ?? []).entries()) {
        if (step.kind === "ai") put(`${node.id}#${index}`, node.id, step, node);
      }
    }
  }
  // Environment checks (binary on PATH, …), once per distinct runner: a missing CLI
  // must fail here — before any node's side effects — not at the first AI node.
  const probed = new Set<Runner>();
  for (const { runner } of configs.values()) {
    if (probed.has(runner)) continue;
    probed.add(runner);
    runner.preflight?.();
  }
  return configs;
}

function resolveAiConfig(
  workflow: Workflow,
  runnerOverride: string | undefined,
  resolveRunner: RunnerResolver,
  unit: AiUnit,
  nodeLevel?: AiUnit,
): ResolvedAiConfig {
  const unitAgent = agentOf(workflow, unit.agent);
  const nodeAgent = agentOf(workflow, nodeLevel?.agent);
  const effectiveAgent = unitAgent ?? nodeAgent;
  const runnerName =
    runnerOverride ??
    unit.runner ??
    unitAgent?.runner ??
    nodeLevel?.runner ??
    nodeAgent?.runner ??
    workflow.defaults.runner ??
    "claude";
  return {
    runner: resolveRunner(runnerName),
    model: unit.model ?? unitAgent?.model ?? nodeLevel?.model ?? nodeAgent?.model ?? workflow.defaults.model,
    // Same cascade as every sibling field (nodes/steps carry no permission_mode key).
    permissionMode: unitAgent?.permissionMode ?? nodeAgent?.permissionMode ?? workflow.defaults.permission_mode,
    systemPrompt: effectiveAgent?.systemPrompt,
    allowedTools:
      unit.allowed_tools ??
      unitAgent?.allowedTools ??
      nodeLevel?.allowed_tools ??
      nodeAgent?.allowedTools ??
      workflow.defaults.allowed_tools,
  };
}

function agentOf(workflow: Workflow, ref: string | undefined): AgentSpec | undefined {
  if (ref === undefined) return undefined;
  const agent = workflow.agents.get(ref);
  if (!agent) throw new SaoError(`agent "${ref}" was not loaded`, "workflows built without loadWorkflow must populate workflow.agents");
  return agent;
}

interface NodeResult {
  output: string;
  sessionId?: string;
}

interface NodeLog {
  log: (chunk: string) => void;
  flush: () => void;
  close: () => Promise<void>;
}

class Engine {
  private readonly ctx: TemplateContext;
  private halted = false;

  constructor(
    private readonly opts: RunWorkflowOptions,
    private readonly state: RunState,
    private readonly paths: RunPaths,
    private readonly runId: string,
    private readonly aiConfigs: Map<string, ResolvedAiConfig>,
    private readonly mcpConfigPath: string | undefined,
    private readonly promptUser: PromptUser,
    private readonly print: (line: string) => void,
    inputs: Record<string, string>,
  ) {
    // Null prototype: {{nodes.constructor.output}} must never read Object.prototype.
    this.ctx = { task: opts.task, inputs, nodeOutputs: Object.create(null) as Record<string, string> };
  }

  async run(ordered: WorkflowNode[], concurrency: number): Promise<void> {
    const satisfied = new Set<string>();
    const started = new Set<string>();
    const running = new Map<string, Promise<void>>();
    const errors: SaoError[] = [];

    const startEligible = () => {
      if (this.halted) return;
      for (const node of ordered) {
        if (running.size >= concurrency) return;
        if (started.has(node.id)) continue;
        if (!node.depends_on.every((dep) => satisfied.has(dep))) continue;
        started.add(node.id);
        const promise = this.runOne(node)
          .then(() => {
            satisfied.add(node.id);
          })
          .catch((err: SaoError) => {
            this.halted = true;
            errors.push(err);
          })
          .finally(() => {
            running.delete(node.id);
          });
        running.set(node.id, promise);
      }
    };

    for (;;) {
      startEligible();
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    if (errors.length > 0) throw errors[0];
  }

  private async runOne(node: WorkflowNode): Promise<void> {
    const nodeState = this.state.nodes[node.id]!;
    nodeState.status = "running";
    nodeState.startedAt = new Date().toISOString();
    saveState(this.paths, this.state);
    this.print(pc.cyan(`→ ${node.id}`) + pc.dim(` (${node.kind})`));

    const nodeLog = this.makeLog(`${node.id}.log`, node.id);
    const startedMs = Date.now();
    try {
      if (node.when_bash !== undefined) {
        const shouldRun = await evaluateWhenBash(interpolate(node.when_bash, this.ctx), {
          cwd: this.opts.cwd,
          timeoutSec: "timeout" in node ? node.timeout : undefined,
          log: nodeLog.log,
        });
        if (!shouldRun) {
          nodeState.status = "skipped";
          nodeState.output = "";
          this.ctx.nodeOutputs[node.id] = ""; // dependents' templates see an empty output
          this.print(pc.yellow(`⊘ ${node.id}`) + pc.dim(" (skipped by when_bash)"));
          return;
        }
      }

      const retries = "retries" in node ? node.retries : 0; // gates carry no retries key
      const result = await withRetries(retries, () => this.executeByKind(node, nodeLog));
      nodeState.status = "succeeded";
      nodeState.output = result.output;
      if (result.sessionId !== undefined) nodeState.sessionId = result.sessionId;
      this.ctx.nodeOutputs[node.id] = result.output; // loops write nodeState.iterations themselves
      this.print(pc.green(`✓ ${node.id}`) + pc.dim(` (${((Date.now() - startedMs) / 1000).toFixed(1)}s)`));
    } catch (err) {
      const rejected = err instanceof GateRejectedError;
      nodeState.status = rejected ? "rejected" : "failed";
      if (this.state.status === "running") this.state.status = rejected ? "rejected" : "failed";
      const message = err instanceof Error ? err.message : String(err);
      // Loop output lives in the per-iteration logs — point the hint at the real file.
      const logFile =
        // Stryker disable next-line ConditionalExpression: forcing the kind clause true is equivalent — only loop nodes ever set nodeState.iterations, so the second clause still gates
        node.kind === "loop" && nodeState.iterations !== undefined
          ? `${node.id}.${nodeState.iterations}.log`
          : `${node.id}.log`;
      const logHint = `full output: ${join(this.paths.logsDir, logFile)}`;
      const hint = err instanceof SaoError && err.hint ? `${err.hint}\n  ${logHint}` : logHint;
      if (rejected) {
        throw new SaoError(`run ${this.runId} rejected at node "${node.id}"`, hint);
      }
      throw new SaoError(`run ${this.runId} failed at node "${node.id}": ${message}`, hint);
    } finally {
      nodeState.endedAt = new Date().toISOString();
      saveState(this.paths, this.state);
      nodeLog.flush();
      await nodeLog.close();
    }
  }

  private async executeByKind(node: WorkflowNode, nodeLog: NodeLog): Promise<NodeResult> {
    switch (node.kind) {
      case "bash":
        return {
          output: await executeBashScript(interpolate(node.bash, this.ctx), {
            cwd: this.opts.cwd,
            timeoutSec: node.timeout,
            log: nodeLog.log,
          }),
        };
      case "ai": {
        const config = this.aiConfigs.get(node.id)!;
        return executeAiNode(
          interpolate(node.prompt, this.ctx),
          { ...config, mcpConfigPath: this.mcpConfigPath, timeoutSec: node.timeout },
          { cwd: this.opts.cwd, log: nodeLog.log },
        );
      }
      case "gate":
        return this.executeGate(node);
      case "loop":
        return this.executeLoop(node);
    }
  }

  private async executeGate(node: GateNode): Promise<NodeResult> {
    const message = interpolate(node.gate.message, this.ctx);
    const question = `\n${message}\n[${node.id}] [a]pprove / [r]eject / or type feedback: `;
    for (;;) {
      const reply = parseGateReply(await this.promptUser(question));
      if (reply.kind === "approve") return { output: "approved" };
      // Stryker disable next-line StringLiteral: the wrap in runOne names the node and drops this inner message by design
      if (reply.kind === "reject") throw new GateRejectedError("rejected by the human at the gate");
      if (reply.kind === "feedback") return { output: reply.text };
      // empty reply → ask again
    }
  }

  private async executeLoop(node: LoopNode): Promise<NodeResult> {
    const body = node.loop;
    const nodeState = this.state.nodes[node.id]!;
    let feedback = "";
    // Stryker disable next-line BooleanLiteral: dead initial value — max_iterations >= 1, so every iteration assigns it before the exhaustion throw reads it
    let signaledOnFinalIteration = false;
    let sessionId: string | undefined;
    // Stryker disable next-line StringLiteral: dead initial value — max_iterations >= 1, so every path assigns output before any read
    let output = "";

    for (let iteration = 1; iteration <= body.max_iterations; iteration++) {
      nodeState.iterations = iteration;
      if (body.interactive) nodeState.lastFeedback = feedback; // resume fidelity (M3)
      saveState(this.paths, this.state);
      const loopCtx: TemplateContext = { ...this.ctx, loop: { feedback, iteration } };
      // Append mode: a retried loop node must not truncate the previous attempt's
      // iteration logs — they are the evidence for why the attempt failed.
      const iterLog = this.makeLog(`${node.id}.${iteration}.log`, `${node.id}#${iteration}`, true);
      let untilBashPassed = false;
      // Signal detection uses ONLY the output of the execution that carried the
      // sentinel instruction this iteration — never bash output, never a previous
      // iteration's text (a stale token must not satisfy a bare approve).
      let instructedOutput: string | undefined;
      try {
        if (body.prompt !== undefined) {
          const config = this.aiConfigs.get(node.id)!;
          const prompt = interpolate(body.prompt, loopCtx) + (body.until !== undefined ? sentinelInstruction(body.until) : "");
          const result = await executeAiNode(
            prompt,
            {
              ...config,
              mcpConfigPath: this.mcpConfigPath,
              resumeSessionId: body.fresh_context ? undefined : sessionId,
              timeoutSec: node.timeout,
            },
            { cwd: this.opts.cwd, log: iterLog.log },
          );
          sessionId = result.sessionId ?? sessionId;
          if (sessionId !== undefined) nodeState.sessionId = sessionId; // resume fidelity (M3)
          output = result.output;
          instructedOutput = result.output;
        } else {
          const stepsResult = await this.executeSteps(node, loopCtx, iterLog);
          output = stepsResult.output;
          instructedOutput = stepsResult.instructedOutput;
        }
        if (body.until_bash !== undefined) {
          untilBashPassed = await evaluateWhenBash(interpolate(body.until_bash, loopCtx), {
            cwd: this.opts.cwd,
            timeoutSec: node.timeout,
            log: iterLog.log,
          });
        }
      } finally {
        iterLog.flush();
        await iterLog.close();
      }

      if (untilBashPassed) return { output, sessionId };

      const signaled =
        body.until !== undefined && instructedOutput !== undefined && instructedOutput.includes(sentinelToken(body.until));
      signaledOnFinalIteration = signaled;
      if (body.interactive) {
        const verdict = await this.askLoopGate(node, iteration, signaled, body.until!);
        if (verdict.kind === "approve") return { output, sessionId };
        feedback = verdict.text;
      } else if (signaled) {
        return { output, sessionId };
      }
    }

    // Diagnose precisely: "signaled but not approved" (interactive, feedback on the
    // last round) must not read as a sentinel-detection failure.
    const reason =
      body.until === undefined
        ? "without until_bash passing"
        : signaledOnFinalIteration
          ? `with ${body.until} signaled on the final iteration but not approved`
          : `without signal ${body.until}`;
    throw new SaoError(
      `loop hit max_iterations (${body.max_iterations}) ${reason}`,
      "this is the escalation point: fix the underlying problem, then re-run",
    );
  }

  private async executeSteps(
    node: LoopNode,
    loopCtx: TemplateContext,
    iterLog: NodeLog,
  ): Promise<{ output: string; instructedOutput?: string }> {
    const steps = node.loop.steps!;
    // Stryker disable next-line UnaryOperator: equivalent — the -1 seed only survives the reduce for all-bash steps, where lastAiIndex is never compared (until: requires an AI step, enforced at parse)
    const lastAiIndex = steps.reduce((last, step, index) => (step.kind === "ai" ? index : last), -1);
    let lastAiOutput: string | undefined;
    // Only the step that carried the sentinel instruction may signal; if when_bash
    // skips it this iteration, the iteration simply cannot signal.
    let instructedOutput: string | undefined;
    let output = "";

    for (const [index, step] of steps.entries()) {
      if (step.when_bash !== undefined) {
        const shouldRun = await evaluateWhenBash(interpolate(step.when_bash, loopCtx), {
          cwd: this.opts.cwd,
          timeoutSec: node.timeout,
          log: iterLog.log,
        });
        if (!shouldRun) {
          this.print(pc.yellow(`⊘ ${node.id} step #${index + 1}`) + pc.dim(" (skipped by when_bash)"));
          continue;
        }
      }
      if (step.kind === "bash") {
        output = await executeBashScript(interpolate(step.bash, loopCtx), {
          cwd: this.opts.cwd,
          timeoutSec: node.timeout,
          log: iterLog.log,
        });
      } else {
        const config = this.aiConfigs.get(`${node.id}#${index}`)!;
        const instructed = node.loop.until !== undefined && index === lastAiIndex;
        const prompt = interpolate(step.prompt, loopCtx) + (instructed ? sentinelInstruction(node.loop.until!) : "");
        const result = await executeAiNode(
          prompt,
          { ...config, mcpConfigPath: this.mcpConfigPath, timeoutSec: node.timeout },
          { cwd: this.opts.cwd, log: iterLog.log },
        );
        output = result.output;
        lastAiOutput = result.output;
        if (instructed) instructedOutput = result.output;
      }
    }
    // The node's output is the last AI step's output; all-bash iterations fall back
    // to the last executed step's output ("" when every step was skipped).
    return { output: lastAiOutput ?? output, instructedOutput };
  }

  private async askLoopGate(
    node: LoopNode,
    iteration: number,
    signaled: boolean,
    signal: string,
  ): Promise<{ kind: "approve" } | { kind: "feedback"; text: string }> {
    const status = signaled ? `agent signaled ${signal}` : "no signal yet";
    const question = `\n[${node.id}] iteration ${iteration} — ${status}\n[a]pprove / [r]eject / or type feedback: `;
    for (;;) {
      const reply = parseGateReply(await this.promptUser(question));
      if (reply.kind === "approve") {
        if (signaled) return { kind: "approve" };
        this.print(pc.yellow(`${node.id}: the agent has not emitted ${sentinelToken(signal)} yet — type feedback to continue`));
        continue;
      }
      // Stryker disable next-line StringLiteral: the wrap in runOne names the node and drops this inner message by design
      if (reply.kind === "reject") throw new GateRejectedError("rejected by the human at the interactive loop");
      // Stryker disable next-line ObjectLiteral,StringLiteral: the caller only distinguishes kind === "approve"; any other kind value routes to the feedback branch identically
      if (reply.kind === "feedback") return { kind: "feedback", text: reply.text };
      // empty reply → ask again
    }
  }

  // Stryker disable next-line BooleanLiteral: equivalent — every non-loop log file name is fresh within a run, so write vs append is indistinguishable; the flag exists for loop retries, which pass true explicitly
  private makeLog(fileName: string, echoLabel: string, append = false): NodeLog {
    const logStream = createWriteStream(join(this.paths.logsDir, fileName), append ? { flags: "a" } : undefined);
    logStream.on("error", () => {}); // best-effort logging: a failed write must not crash the run
    // Echo only completed lines so a line delivered across chunks isn't split apart.
    let pendingEcho = "";
    const echoLine = (line: string) => {
      if (line.trim()) this.print(pc.dim(`  [${echoLabel}] `) + line);
    };
    return {
      log: (chunk: string) => {
        logStream.write(chunk);
        pendingEcho += chunk;
        const lines = pendingEcho.split("\n");
        pendingEcho = lines.pop()!; // split() always yields at least one element
        for (const line of lines) echoLine(line);
        if (pendingEcho.length > 8192) {
          echoLine(pendingEcho); // don't buffer a runaway newline-less line forever
          pendingEcho = "";
        }
      },
      flush: () => {
        echoLine(pendingEcho);
        // Stryker disable next-line StringLiteral: dead store — flush is the last read of this log's pendingEcho
        pendingEcho = "";
      },
      close: async () => {
        logStream.end();
        await finished(logStream).catch(() => {});
      },
    };
  }
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
