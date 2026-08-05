import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { finished } from "node:stream/promises";
import pc from "picocolors";
import { GateRejectedError, SaoError } from "./errors";
import { parseGateReply, parseLoopReply, promptOnTerminal, type PromptUser } from "./gate";
import { evaluateWhenBash, executeAiNode, executeBashScript, withRetries } from "./nodes";
import { orderNodes } from "./parser";
import { onShutdown } from "./procs";
import { getRunner, type Runner, type RunnerResolver } from "./runners/types";
import type { AgentSpec, GateNode, LoopNode, Workflow, WorkflowNode } from "./schema";
import { acquireRunLock, createRun, isPidAlive, saveState, type NodeState, type RunPaths, type RunState } from "./state";
import { interpolate, type RunMetaVars, type TemplateContext } from "./template";
import {
  addWorktree,
  branchExists,
  finalizeWorktree,
  isUsableWorktree,
  requireGitRepo,
  resolveHead,
  validateBranchName,
  verifyBaseRef,
  verifyBranchIsNew,
  worktreeRelPath,
} from "./worktree";

const DEFAULT_CONCURRENCY = 2;

export interface WorktreeRunOptions {
  /** Ref to cut the run branch from; default: workflow `base:`, else current HEAD (as a SHA). */
  base?: string;
  /** Branch name; default `sao/<run-id>`. */
  branch?: string;
}

export interface ResumeRunOptions {
  state: RunState;
  paths: RunPaths;
  /** Skip the workflow-hash check (the state records the hash actually resumed with). */
  force?: boolean;
}

export interface RunWorkflowOptions {
  workflow: Workflow;
  workflowPath: string;
  task: string;
  vars: Record<string, string>;
  /** Where nodes execute for in-place runs (worktree runs execute in the worktree). */
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
  /** Cut a git worktree + branch for this run (SPEC step 4); omit to run in place at cwd. */
  worktree?: WorktreeRunOptions;
  /** Resume a persisted run instead of creating one (ignores `worktree`: the original run's isolation is reused). */
  resume?: ResumeRunOptions;
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
  const runRoot = opts.runRoot ?? opts.cwd;
  // Execution parameters persist in state.json and win on resume — the resume CLI
  // deliberately has no flags for them, and dropping them would silently change the
  // run's environment (a --concurrency 1 run must not resume at 2).
  const runnerOverride = opts.runnerOverride ?? opts.resume?.state.runnerOverride;
  const concurrency = Math.max(1, opts.concurrency ?? opts.resume?.state.concurrency ?? DEFAULT_CONCURRENCY);
  // On resume, vars for inputs a --force'd edit removed must be dropped, not fatal.
  const resuming = opts.resume !== undefined;
  const vars = resuming ? pickDeclaredVars(opts.workflow, opts.vars) : opts.vars;
  const inputs = resolveInputs(opts.workflow, vars, resuming);
  const ordered = orderNodes(opts.workflow);

  const aiConfigs = preflightAiConfigs(opts.workflow, runnerOverride, resolveRunner);

  // Hash before creating the run dir: a vanished workflow file must not orphan a dir.
  const workflowHash = hashRunConfig(opts.workflowPath, opts.workflow);

  if (opts.resume !== undefined) {
    const prior = opts.resume.state;
    if (prior.status === "succeeded") {
      throw new SaoError(`run ${prior.id} already succeeded`, "nothing to resume — start a new run");
    }
    // Stryker disable next-line ConditionalExpression: forcing the pid-undefined clause true is equivalent — isPidAlive(undefined) throws inside its try and reports dead
    // Stryker disable next-line ConditionalExpression: forcing the force-check true is equivalent-adjacent — the lock acquisition below re-verifies liveness atomically; this pre-check only produces the friendlier message
    if (prior.status === "running" && prior.pid !== undefined && isPidAlive(prior.pid) && opts.resume.force !== true) {
      // --force bypasses this too: after a machine reboot the recorded pid is often
      // recycled by an unrelated long-lived process, and the run would be stuck.
      throw new SaoError(
        `run ${prior.id} looks live (pid ${prior.pid})`,
        "another sao process owns this run — two engines in one worktree would duplicate side effects\n  if that pid is unrelated (reboot, pid recycling), resume with --force",
      );
    }
    if (opts.resume.force !== true && workflowHash !== prior.workflowHash) {
      throw new SaoError(
        "the run's configuration changed since it started (workflow, agent files, or mcp config)",
        "resume with --force to run the changed configuration, or start a new run",
      );
    }
  }

  // Worktree pre-checks run before the run dir exists: a bad --base / --branch is a
  // config error and must not leave a failed run under .sao/ (same rule as preflight).
  let newRunBase: string | undefined;
  if (opts.resume === undefined && opts.worktree !== undefined) {
    requireGitRepo(runRoot);
    newRunBase = opts.worktree.base ?? opts.workflow.base;
    if (newRunBase === undefined) {
      newRunBase = resolveHead(runRoot); // "HEAD" itself would make SAO_BASE_REF useless once commits land
    } else {
      verifyBaseRef(runRoot, newRunBase);
    }
    if (opts.worktree.branch !== undefined) {
      validateBranchName(runRoot, opts.worktree.branch);
      verifyBranchIsNew(runRoot, opts.worktree.branch);
    }
  }

  let state: RunState;
  let paths: RunPaths;
  let runId: string;
  let releaseRunLock: () => void;
  if (opts.resume !== undefined) {
    ({ state, paths } = opts.resume);
    runId = state.id;
    // Atomic ownership BEFORE any state mutation: the status/pid check above is
    // check-then-write, and two resumes racing through that window would both
    // execute every node in the same worktree.
    releaseRunLock = acquireRunLock(paths, opts.resume.force === true);
    state.workflowHash = workflowHash; // under --force, record the hash actually resumed with
    state.status = "running";
    state.pid = process.pid;
    if (opts.concurrency !== undefined) state.concurrency = concurrency;
    // Nodes added by a --force'd edit start pending; entries for removed nodes drop.
    // hasOwn + null prototype: a node id like "constructor" must read the persisted
    // entry (or nothing), never Object.prototype — a prototype hit here makes the
    // node re-run on every resume with its completion never recorded.
    const prior = state.nodes;
    state.nodes = buildNodeMap(ordered, (id) => (Object.hasOwn(prior, id) ? prior[id]! : { status: "pending" }));
  } else {
    ({ runId, paths } = createRun(runRoot, opts.workflow.name));
    releaseRunLock = acquireRunLock(paths); // fresh dir: uncontended, but symmetric with resume
    state = {
      id: runId,
      workflow: opts.workflowPath,
      workflowHash,
      task: opts.task,
      vars: inputs,
      autoOpenPr: false, // the flag lands in M4; persisted now so resume carries it
      createdAt: new Date().toISOString(),
      pid: process.pid,
      concurrency,
      runnerOverride,
      status: "running",
      nodes: buildNodeMap(ordered, () => ({ status: "pending" })),
    };
    // Persist before any further setup: a failure below must leave a visible failed
    // run, never an invisible orphan dir that list/clean can never see.
    saveState(paths, state);
  }

  // Execution directory: the run's worktree when isolated, opts.cwd otherwise. Any
  // setup failure from here on is recorded on the run before it propagates.
  let execCwd = opts.cwd;
  let mcpConfigPath = opts.workflow.mcpConfigPath;
  try {
    if (opts.resume !== undefined) {
      if (state.worktree !== undefined) {
        // A tampered state.worktree must never choose the execution directory.
        if (state.worktree !== worktreeRelPath(runId)) {
          throw new SaoError(
            `state.worktree is not the expected ${worktreeRelPath(runId)}`,
            "state.json was edited — refusing to execute in an unexpected directory",
          );
        }
        execCwd = resolve(runRoot, state.worktree);
        // isUsableWorktree, not existsSync: a SIGKILL exactly mid-`git worktree add`
        // can leave a husk directory that must refuse the same way a missing one does.
        if (!isUsableWorktree(execCwd)) {
          throw new SaoError(
            `worktree is gone: ${state.worktree}`,
            "it was removed (sao clean?), or the run crashed while the worktree was being created — start a fresh run instead",
          );
        }
      } else if (state.cwd !== undefined) {
        // In-place runs execute where they started, not where resume was invoked.
        execCwd = resolve(runRoot, state.cwd);
      }
    } else if (opts.worktree !== undefined) {
      const rel = worktreeRelPath(runId);
      const branch = opts.worktree.branch ?? `sao/${runId}`;
      execCwd = resolve(runRoot, rel);
      // Persist the isolation INTENT before the (slow) checkout: a crash during
      // `git worktree add` must leave a state whose resume refuses with "worktree
      // is gone" — never one that silently executes in the user's main checkout.
      state.worktree = rel;
      state.base = newRunBase;
      state.branch = branch;
      saveState(paths, state);
      try {
        addWorktree(runRoot, execCwd, branch, newRunBase!);
      } catch (err) {
        // addWorktree unwinds a branch IT created; one that survives the failure
        // pre-existed (verify→add TOCTOU) and is not ours — leaving it recorded
        // would let a later `clean --all` -D someone else's branch.
        // Stryker disable next-line ConditionalExpression: the branch-survived case needs a competitor creating the branch between verify and add — a race no deterministic test can stage; the always-delete mutant is killed by the squat test
        if (branchExists(runRoot, branch)) delete state.branch;
        throw err; // the outer catch persists the failed state
      }
      print(pc.dim(`worktree ${rel} on branch ${branch} (base ${newRunBase})`));
    } else {
      state.cwd = relative(runRoot, execCwd) || ".";
    }

    // Inline mcp: servers become a per-run config file; a path form was already resolved.
    if (opts.workflow.mcpServers !== undefined) {
      mcpConfigPath = join(paths.dir, "mcp.json");
      writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: opts.workflow.mcpServers }, null, 2) + "\n");
    }
  } catch (err) {
    state.status = "failed";
    saveState(paths, state);
    releaseRunLock();
    throw err;
  }

  // Run metadata: {{base}}/{{branch}}/{{run_id}} in templates, SAO_* in every subprocess.
  const meta: RunMetaVars = { base: state.base ?? "", branch: state.branch ?? "", run_id: runId };
  const env: Record<string, string> = {
    SAO_RUN_ID: runId,
    SAO_BASE_REF: meta.base,
    SAO_BRANCH: meta.branch,
    SAO_WORKTREE: execCwd,
  };
  // Null prototype: {{nodes.constructor.output}} must never read Object.prototype.
  const ctx: TemplateContext = { task: opts.task, inputs, nodeOutputs: Object.create(null) as Record<string, string>, meta };

  saveState(paths, state);
  const verb = opts.resume !== undefined ? "resume" : "run";
  print(pc.bold(`sao ${verb} ${runId}`) + pc.dim(` (${ordered.length} nodes, concurrency ${concurrency}, logs in ${paths.logsDir})`));

  // A Ctrl-C / SIGTERM mid-run must not leave state.json claiming "running" forever.
  const releaseShutdownHook = onShutdown(() => {
    // Stryker disable next-line ConditionalExpression: equivalent in practice — the hook is released in the finally below, so at teardown time the only reachable run status is "running"
    if (state.status === "running") state.status = "failed";
    for (const nodeState of Object.values(state.nodes)) {
      if (nodeState.status === "running") nodeState.status = "failed";
    }
    saveState(paths, state);
    // Stryker disable next-line all: a leaked lock after SIGKILL is reclaimed as stale anyway (dead pid); releasing here is just tidier
    releaseRunLock();
  });

  const engine = new Engine(state, paths, runId, aiConfigs, mcpConfigPath, promptUser, print, execCwd, env, ctx);
  try {
    await engine.run(ordered, concurrency);
  } catch (err) {
    // Stryker disable next-line ConditionalExpression: forcing the guard true is equivalent — every error the engine throws is a SaoError; the guard only protects hypothetical non-Sao crashes
    if (err instanceof SaoError) {
      // Stryker disable next-line ConditionalExpression,StringLiteral: forcing the hint-check true (or junking the unreachable else-branch) is equivalent — runOne attaches at least the log-path hint to every error it throws
      err.hint = (err.hint !== undefined ? err.hint + "\n  " : "") + `resume with: sao resume ${runId}`;
    }
    // Stryker disable next-line BlockStatement,StatementRemoval: leaving the hook registered after a failure only causes a redundant re-save of already-failed state at teardown — unobservable
    releaseShutdownHook();
    releaseRunLock();
    throw err;
  }

  // SPEC step 8: auto-commit whatever the run left uncommitted, then report. A failed
  // finalize is a warning — the workflow itself succeeded. The shutdown hook stays
  // armed until the final save: a Ctrl-C during the finalize commit marks the run
  // failed, and resuming it re-runs nothing and simply retries the finalize.
  let finalized = false;
  if (state.worktree !== undefined) {
    try {
      finalized = finalizeWorktree(execCwd, runId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,StringLiteral: forcing the guard true is equivalent — finalizeWorktree only throws SaoErrors, and every one carries a hint (gitFailure always finds stderr detail or is given one)
      const hint = err instanceof SaoError && err.hint !== undefined ? ` (${err.hint})` : "";
      print(pc.yellow(`⚠ finalize commit failed: ${message}${hint}`));
    }
  }

  state.status = "succeeded";
  saveState(paths, state);
  releaseShutdownHook();
  releaseRunLock();
  print(pc.green(pc.bold(`✓ run ${runId} succeeded`)));
  if (state.worktree !== undefined) {
    if (finalized) print(pc.dim("  finalized: committed remaining worktree changes"));
    print(`  branch:   ${state.branch}`);
    print(`  worktree: ${state.worktree}`);
    print(pc.dim(`  review:   git diff ${state.base}...${state.branch}`));
    print(pc.dim(`  merge:    git merge ${state.branch}   (worktree kept until: sao clean)`));
    print(pc.dim(`  pr:       git push -u origin ${state.branch} && gh pr create --head ${state.branch}`));
  }
  return state;
}

/**
 * Hash of everything that shapes a run's behavior from disk: the workflow YAML,
 * every referenced agent file (its body becomes a system prompt), and a path-form
 * mcp config. `resume` compares it so a silent behavior change requires --force.
 */
export function hashRunConfig(workflowPath: string, workflow: Workflow): string {
  const hash = createHash("sha256").update(readFileSync(workflowPath));
  // Stryker disable next-line MethodExpression: equivalent — loadWorkflow builds the agents map in node order, which is itself part of the hashed workflow bytes; sort() only canonicalizes hand-built maps
  for (const ref of [...workflow.agents.keys()].sort()) {
    // Stryker disable next-line StringLiteral: framing marker — a collision without it needs bytes moved across the file seam, and the second file would then no longer start with the frontmatter loadAgent requires
    hash.update(`\0agent:${ref}\0`).update(readFileSync(workflow.agents.get(ref)!.path));
  }
  if (workflow.mcpConfigPath !== undefined) {
    // Stryker disable next-line StringLiteral: boundary marker — a collision without it needs bytes moved across the agent/mcp seam to still parse as JSON, which concatenated JSON documents never do
    hash.update("\0mcp\0").update(readFileSync(workflow.mcpConfigPath));
  }
  return "sha256:" + hash.digest("hex");
}

/** Null-prototype node-state map: ids like "constructor" must never hit Object.prototype. */
function buildNodeMap(ordered: WorkflowNode[], entryFor: (id: string) => NodeState): Record<string, NodeState> {
  const nodes: Record<string, NodeState> = Object.create(null) as Record<string, NodeState>;
  for (const node of ordered) nodes[node.id] = entryFor(node.id);
  return nodes;
}

/** Resume tolerance: drop persisted vars whose inputs a --force'd edit removed. */
function pickDeclaredVars(workflow: Workflow, vars: Record<string, string>): Record<string, string> {
  const declared = new Set(workflow.inputs.map((input) => input.name));
  const kept: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(vars)) {
    if (declared.has(key)) kept[key] = vars[key]!;
  }
  return kept;
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
  private halted = false;
  /** Loop nodes resuming mid-run: the iteration/feedback/session to continue from. */
  private readonly loopResume = new Map<string, { iteration: number; feedback: string; sessionId?: string }>();

  constructor(
    private readonly state: RunState,
    private readonly paths: RunPaths,
    private readonly runId: string,
    private readonly aiConfigs: Map<string, ResolvedAiConfig>,
    private readonly mcpConfigPath: string | undefined,
    private readonly promptUser: PromptUser,
    private readonly print: (line: string) => void,
    private readonly execCwd: string,
    private readonly env: Record<string, string>,
    private readonly ctx: TemplateContext,
  ) {}

  async run(ordered: WorkflowNode[], concurrency: number): Promise<void> {
    const satisfied = new Set<string>();
    const started = new Set<string>();
    const running = new Map<string, Promise<void>>();
    const errors: SaoError[] = [];

    // Resume seeding: completed nodes are settled facts — restore their outputs for
    // dependents' templates and never re-run them. Loops that were mid-flight pick up
    // at the iteration that was running when the run halted. On a fresh run every
    // node is pending and this seeds nothing.
    for (const node of ordered) {
      const prior = this.state.nodes[node.id]!;
      if (prior.status === "succeeded" || prior.status === "skipped") {
        satisfied.add(node.id);
        started.add(node.id);
        this.ctx.nodeOutputs[node.id] = prior.output ?? "";
        this.print(pc.dim(`↷ ${node.id} (already ${prior.status})`));
      } else if (
        // Stryker disable next-line ConditionalExpression,LogicalOperator: forcing this true is equivalent — a hint built from an untouched node carries iteration undefined / feedback "" / sessionId undefined, exactly the fresh-loop defaults executeLoop falls back to
        node.kind === "loop" && prior.iterations !== undefined
      ) {
        this.loopResume.set(node.id, {
          iteration: prior.iterations,
          feedback: prior.lastFeedback ?? "",
          sessionId: prior.sessionId,
        });
      }
    }

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
      // The predicate runs at most once per node: a resumed failed/rejected/
      // interrupted attempt that got past it (whenPassed persisted) goes straight
      // to the body — the node's own partial work can flip the predicate's answer,
      // and a skip here would wipe loop progress or a gate's promised re-ask. A
      // predicate that itself failed left whenPassed unset, so it re-evaluates.
      if (node.when_bash !== undefined && nodeState.whenPassed !== true) {
        const shouldRun = await evaluateWhenBash(interpolate(node.when_bash, this.ctx), {
          cwd: this.execCwd,
          env: this.env,
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
        nodeState.whenPassed = true;
        saveState(this.paths, this.state); // before the body: a crash mid-body must not re-gate on resume
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
            cwd: this.execCwd,
            env: this.env,
            timeoutSec: node.timeout,
            log: nodeLog.log,
          }),
        };
      case "ai": {
        const config = this.aiConfigs.get(node.id)!;
        return executeAiNode(
          interpolate(node.prompt, this.ctx),
          { ...config, mcpConfigPath: this.mcpConfigPath, timeoutSec: node.timeout },
          { cwd: this.execCwd, env: this.env, log: nodeLog.log },
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
    // Resume hint: continue from the iteration that was running when the run halted,
    // with the feedback/session that fed it. Consumed once — a `retries` re-attempt
    // restarts from iteration 1 (SPEC: retries re-run the whole loop).
    const resumeHint = this.loopResume.get(node.id);
    this.loopResume.delete(node.id);
    const startIteration = resumeHint?.iteration ?? 1;
    let feedback = resumeHint?.feedback ?? "";
    // Stryker disable next-line BooleanLiteral: dead initial value — startIteration <= max_iterations whenever the loop body wrote state, so every iteration assigns it before the exhaustion throw reads it
    let signaledOnFinalIteration = false;
    let sessionId: string | undefined = resumeHint?.sessionId;
    // Stryker disable next-line StringLiteral: dead initial value — max_iterations >= 1, so every path assigns output before any read
    let output = "";

    for (let iteration = startIteration; iteration <= body.max_iterations; iteration++) {
      nodeState.iterations = iteration;
      if (body.interactive) nodeState.lastFeedback = feedback; // resume fidelity (M3)
      saveState(this.paths, this.state);
      const loopCtx: TemplateContext = { ...this.ctx, loop: { feedback, iteration } };
      // Append mode: a retried loop node must not truncate the previous attempt's
      // iteration logs — they are the evidence for why the attempt failed.
      const iterLog = this.makeLog(`${node.id}.${iteration}.log`, `${node.id}#${iteration}`);
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
            { cwd: this.execCwd, env: this.env, log: iterLog.log },
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
            cwd: this.execCwd,
            env: this.env,
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
          cwd: this.execCwd,
          env: this.env,
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
          cwd: this.execCwd,
          env: this.env,
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
          { cwd: this.execCwd, env: this.env, log: iterLog.log },
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
      // Loop replies use the strict parser: an interview agent's "should X be
      // public?" answered with a natural "no" is feedback, not a run rejection.
      const reply = parseLoopReply(await this.promptUser(question));
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

  private makeLog(fileName: string, echoLabel: string): NodeLog {
    // Always append: a resumed run (or a retried loop) re-opens existing log files,
    // and the earlier attempt's output is the evidence for why it failed.
    const logStream = createWriteStream(join(this.paths.logsDir, fileName), { flags: "a" });
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

function resolveInputs(workflow: Workflow, vars: Record<string, string>, resuming: boolean): Record<string, string> {
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
      if (input.required) {
        // `sao resume` has no --var flag — a hint naming one would be a dead end.
        const hint = resuming
          ? `the edited workflow now requires it — give it a default:, or start a new run`
          : `pass it with --var ${input.name}=<value>`;
        throw new SaoError(`missing required input "${input.name}"`, hint);
      }
      continue;
    }
    resolved[input.name] = value;
  }
  return resolved;
}
