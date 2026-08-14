#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { SaoError } from "./errors";
import { promptChoice } from "./gate";
import { parseAgentOptions } from "./options";

export const INTERACTIVE_CHOICES_USAGE = `preview a list prompt from an agent <options> block

usage:
  bun run interactive-choices -- [--message <text>] [options=]<options>[...]</options>

example:
  bun run interactive-choices -- --message "which path?" 'options=<options>[{"id":"a","label":"A","description":"first"}]</options>'

piped stdin uses the line-reader path (no menu). a TTY uses the navigable list.`;

export type InteractiveChoicesArgs = { kind: "help" } | { kind: "run"; message: string; source: string };

export function parseInteractiveChoicesArgs(argv: string[]): InteractiveChoicesArgs {
  let message = "pick an option";
  let source: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--message" || arg === "-m") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new SaoError("--message needs a value", "pass the question text after --message");
      }
      message = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("message=")) {
      message = arg.slice("message=".length);
      continue;
    }
    if (arg.startsWith("options=")) {
      source = arg.slice("options=".length);
      continue;
    }
    rest.push(arg);
  }

  if (source === undefined && rest.length > 0) source = rest.join(" ");
  if (source === undefined || source.trim() === "") {
    throw new SaoError(
      "missing options blob",
      "pass an <options>[...]</options> block, optionally prefixed with options=",
    );
  }
  return { kind: "run", message, source };
}

export async function runInteractiveChoices(args: { message: string; source: string }): Promise<void> {
  const options = parseAgentOptions(args.source);
  if (options === undefined) {
    throw new SaoError(
      "could not parse <options> block",
      "needs a JSON array of {id, label, description?} with unique ids that do not start with sao:",
    );
  }
  const answer = await promptChoice({
    message: args.message,
    choices: options.map((option) => ({ id: option.id, label: option.label, description: option.description })),
  });
  console.log(JSON.stringify(answer));
}

function printError(err: unknown): void {
  if (err instanceof SaoError) {
    console.error(pc.red(`error: ${err.message}`));
    if (err.hint) console.error(pc.dim(`  hint: ${err.hint}`));
  } else {
    console.error(pc.red(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
  }
  process.exitCode = 1;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const parsed = parseInteractiveChoicesArgs(argv);
    if (parsed.kind === "help") {
      console.log(INTERACTIVE_CHOICES_USAGE);
      return;
    }
    await runInteractiveChoices(parsed);
  } catch (err) {
    printError(err);
  }
}

function isExecutedAsScript(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isExecutedAsScript()) await main();
