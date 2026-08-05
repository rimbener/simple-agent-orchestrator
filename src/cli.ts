#!/usr/bin/env node
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { preflightAiConfigs, runWorkflow } from "./engine";
import { SaoError } from "./errors";
import { loadWorkflow } from "./parser";
import { findRepoRoot } from "./state";

const program = new Command();
program.name("sao").description("simple agent orchestrator — a minimal YAML workflow engine for AI coding agents").version(pkg.version);

program
  .command("run")
  .description("execute a workflow")
  .argument("<workflow>", "path to a workflow YAML file")
  .argument("[task...]", "freeform task text, available as {{task}}")
  .option("--var <key=value>", "set a declared input (repeatable)", collectVar, Object.create(null) as Record<string, string>)
  .option("--runner <name>", "override the runner for every AI node")
  .option("--concurrency <n>", "max nodes executing at once (default 2)", parseConcurrency)
  .action(
    async (
      workflowPath: string,
      taskWords: string[],
      options: { var: Record<string, string>; runner?: string; concurrency?: number },
    ) => {
      await fail(async () => {
        const path = resolve(workflowPath);
        const repoRoot = findRepoRoot(process.cwd());
        const workflow = loadWorkflow(path, { cwd: repoRoot });
        await runWorkflow({
          workflow,
          workflowPath: path,
          task: taskWords.join(" "),
          vars: options.var,
          cwd: process.cwd(),
          runRoot: repoRoot, // SPEC step 3: the run dir lives in the main repo
          concurrency: options.concurrency,
          runnerOverride: options.runner,
        });
      });
    },
  );

program
  .command("validate")
  .description("check a workflow file without executing it")
  .argument("<workflow>", "path to a workflow YAML file")
  .action(async (workflowPath: string) => {
    await fail(async () => {
      const workflow = loadWorkflow(resolve(workflowPath), { cwd: findRepoRoot(process.cwd()) });
      preflightAiConfigs(workflow);
      console.log(pc.green(`✓ ${workflow.name}`) + pc.dim(` — ${workflow.nodes.length} nodes, valid`));
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

async function fail(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SaoError) {
      console.error(pc.red(`error: ${err.message}`));
      if (err.hint) console.error(pc.dim(`  hint: ${err.hint}`));
    } else {
      console.error(pc.red(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
    }
    process.exitCode = 1; // no hard exit: let pending stream writes drain
  }
}

// Awaited: a floating promise here lets a drained event loop (e.g. readline on an
// exhausted stdin pipe) exit 0 mid-action without fail() ever running.
await program.parseAsync(process.argv);
