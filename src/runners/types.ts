import { SaoError } from "../errors";
import { claudeRunner } from "./claude";

export interface RunnerRequest {
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  mcpConfigPath?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
  timeoutSec?: number;
  onOutput?: (chunk: string) => void;
}

export interface RunnerResult {
  /** Final result text — sentinel detection (M2) runs on this. */
  output: string;
  sessionId?: string;
  exitCode: number;
}

export interface Runner {
  name: string;
  run(req: RunnerRequest): Promise<RunnerResult>;
}

export type RunnerResolver = (name: string) => Runner;

// A Map, not a plain object: `--runner toString` must not resolve via the prototype chain.
const REGISTRY = new Map<string, Runner>([["claude", claudeRunner]]);

export function getRunner(name: string): Runner {
  const runner = REGISTRY.get(name);
  if (!runner) {
    throw new SaoError(
      `unknown runner "${name}"`,
      name === "codex" ? "the codex adapter lands in M4" : `available runners: ${[...REGISTRY.keys()].join(", ")}`,
    );
  }
  return runner;
}
