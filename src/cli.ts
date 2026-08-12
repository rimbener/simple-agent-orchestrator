#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { formatDryRun, preflightAiConfigs, preflightRunnerEnvironments, runWorkflow } from "./engine";
import { SaoError } from "./errors";
import { loadWorkflow } from "./parser";
import { cleanRuns, formatCleanSummary, formatRunList, makeLogPoller, printLogs } from "./runs";
import { findRepoRoot, loadRun } from "./state";

const program = new Command();
program
  .name("sao")
  .description("simple agent orchestrator — a minimal YAML workflow engine for AI coding agents")
  .version(pkg.version);

program
  .command("run")
  .description("execute a workflow")
  .argument("<workflow>", "path to a workflow YAML file")
  .argument("[task...]", "freeform task text, available as {{task}}")
  .option(
    "--var <key=value>",
    "set a declared input (repeatable)",
    collectVar,
    Object.create(null) as Record<string, string>,
  )
  .option("--base <ref>", "ref to cut the run worktree/branch from (default: workflow base:, else HEAD)")
  .option("--branch <name>", "branch name for the run worktree (default: sao/<run-id>)")
  .option("--no-worktree", "run in place instead of an isolated git worktree")
  .option("--runner <name>", "override the runner for every AI node")
  .option("--concurrency <n>", "max nodes executing at once (default 2)", parseConcurrency)
  .option("--auto-open-pr", "on success, push the run branch and open a draft PR via gh")
  .option("--dry-run", "print the resolved execution plan (node order, interpolated prompts) without running anything")
  .action(
    async (
      workflowPath: string,
      taskWords: string[],
      options: {
        var: Record<string, string>;
        base?: string;
        branch?: string;
        worktree: boolean;
        runner?: string;
        concurrency?: number;
        autoOpenPr?: boolean;
        dryRun?: boolean;
      },
    ) => {
      await fail(async () => {
        if (!options.worktree && (options.base !== undefined || options.branch !== undefined)) {
          throw new SaoError(
            "--base/--branch have no effect with --no-worktree",
            "they configure the run worktree — drop them or drop --no-worktree",
          );
        }
        if (!options.worktree && options.autoOpenPr === true) {
          throw new SaoError(
            "--auto-open-pr has no effect with --no-worktree",
            "a PR needs the run branch a worktree provides — drop one of the flags",
          );
        }
        const path = resolve(workflowPath);
        const repoRoot = findRepoRoot(process.cwd());
        const workflow = loadWorkflow(path, { cwd: repoRoot });
        const worktree = options.worktree ? { base: options.base, branch: options.branch } : undefined;
        if (options.dryRun === true) {
          const plan = await formatDryRun({
            workflow,
            task: taskWords.join(" "),
            vars: options.var,
            runRoot: repoRoot,
            runnerOverride: options.runner,
            worktree,
            autoOpenPr: options.autoOpenPr,
          });
          for (const line of plan) console.log(line);
          return;
        }
        await runWorkflow({
          workflow,
          workflowPath: path,
          task: taskWords.join(" "),
          vars: options.var,
          cwd: process.cwd(),
          runRoot: repoRoot, // SPEC step 3: the run dir lives in the main repo
          concurrency: options.concurrency,
          runnerOverride: options.runner,
          autoOpenPr: options.autoOpenPr,
          worktree,
        });
      });
    },
  );

program
  .command("resume")
  .description("re-run a halted run from its failed node/iteration")
  .argument("<run-id>", "run id (see sao list)")
  .option(
    "--force",
    "resume even if the configuration changed, the recorded owner pid looks alive, or a live lock must be taken over",
  )
  .option(
    "--auto-open-pr",
    "turn on draft-PR finalization for this halted run (already-succeeded runs cannot be resumed; open theirs with gh)",
  )
  .action(async (runId: string, options: { force?: boolean; autoOpenPr?: boolean }) => {
    await fail(async () => {
      const repoRoot = findRepoRoot(process.cwd());
      const { state, paths } = loadRun(repoRoot, runId);
      if (!existsSync(state.workflow)) {
        throw new SaoError(`workflow file is gone: ${state.workflow}`, "the original file is needed to resume");
      }
      const workflow = loadWorkflow(state.workflow, { cwd: repoRoot });
      await runWorkflow({
        workflow,
        workflowPath: state.workflow,
        task: state.task,
        vars: state.vars,
        cwd: process.cwd(),
        runRoot: repoRoot,
        autoOpenPr: options.autoOpenPr,
        resume: { state, paths, force: options.force === true },
      });
    });
  });

program
  .command("validate")
  .description("check a workflow file without executing it")
  .argument("<workflow>", "path to a workflow YAML file")
  .action(async (workflowPath: string) => {
    await fail(async () => {
      const workflow = loadWorkflow(resolve(workflowPath), { cwd: findRepoRoot(process.cwd()) });
      const configs = preflightAiConfigs(workflow);
      await preflightRunnerEnvironments(workflow, configs);
      console.log(pc.green(`✓ ${workflow.name}`) + pc.dim(` — ${workflow.nodes.length} nodes, valid`));
    });
  });

program
  .command("list")
  .description("list runs under .sao/runs")
  .action(async () => {
    await fail(async () => {
      for (const line of formatRunList(findRepoRoot(process.cwd()), new Date())) console.log(line);
    });
  });

program
  .command("logs")
  .description("print a run's node logs")
  .argument("<run-id>", "run id (see sao list)")
  .argument("[node-id]", "only this node's logs (loops: every iteration)")
  .option("--follow", "keep polling for new log output (Ctrl-C to stop)")
  .action(async (runId: string, nodeId: string | undefined, options: { follow?: boolean }) => {
    await fail(async () => {
      const { state, paths } = loadRun(findRepoRoot(process.cwd()), runId);
      const nodeOrder = Object.keys(state.nodes); // state.json keeps dependency order
      const write = (text: string) => process.stdout.write(text);
      if (options.follow === true) {
        const poller = makeLogPoller(paths, nodeId, write, nodeOrder);
        poller.poll();
        // The interval keeps the event loop alive until Ctrl-C. Its callbacks run
        // outside fail()'s try — route errors through the same printer, not a crash.
        const timer = setInterval(() => {
          try {
            poller.poll();
          } catch (err) {
            clearInterval(timer);
            printError(err);
          }
        }, 300);
      } else {
        printLogs(paths, nodeId, write, nodeOrder);
      }
    });
  });

program
  .command("clean")
  .description("remove worktrees and branches of finished runs")
  .option("--all", "also remove the run dirs (state + logs) and worktrees with uncommitted changes")
  .action(async (options: { all?: boolean }) => {
    await fail(async () => {
      const root = findRepoRoot(process.cwd());
      const summary = cleanRuns(root, options.all === true, (line) => console.log(pc.yellow(line)));
      console.log(formatCleanSummary(summary));
    });
  });

function parseConcurrency(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("expects an integer >= 1");
  return n;
}

function collectVar(pair: string, acc: Record<string, string>): Record<string, string> {
  const eq = pair.indexOf("=");
  if (eq < 1) throw new InvalidArgumentError(`expects key=value, got "${pair}"`);
  acc[pair.slice(0, eq)] = pair.slice(eq + 1);
  return acc;
}

function printError(err: unknown): void {
  if (err instanceof SaoError) {
    console.error(pc.red(`error: ${err.message}`));
    if (err.hint) console.error(pc.dim(`  hint: ${err.hint}`));
  } else {
    console.error(pc.red(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
  }
  process.exitCode = 1; // no hard exit: let pending stream writes drain
}

async function fail(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    printError(err);
  }
}

// Awaited: a floating promise here lets a drained event loop (e.g. readline on an
// exhausted stdin pipe) exit 0 mid-action without fail() ever running.
await program.parseAsync(process.argv);
