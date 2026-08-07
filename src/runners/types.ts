import { SaoError } from "../errors";
import { claudeRunner } from "./claude";
import { codexRunner } from "./codex";

export interface RunnerRequest {
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  /** Extra environment (SAO_* run metadata) merged over process.env for the subprocess. */
  env?: Record<string, string>;
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
  /** Optional environment check (binary on PATH, …) run at validate/preflight time. */
  preflight?: () => void;
  /**
   * Whether run() honors resumeSessionId. Only an explicit `false` marks a runner
   * incapable — loops with `fresh_context: false` are rejected for it at
   * validate/preflight time (mock runners that leave it unset stay resumable).
   */
  supportsSessionResume?: boolean;
}

export type RunnerResolver = (name: string) => Runner;

// A Map, not a plain object: `--runner toString` must not resolve via the prototype chain.
const REGISTRY = new Map<string, Runner>([
  ["claude", claudeRunner],
  ["codex", codexRunner],
]);

export function getRunner(name: string): Runner {
  const runner = REGISTRY.get(name);
  if (!runner) {
    throw new SaoError(`unknown runner "${name}"`, `available runners: ${[...REGISTRY.keys()].join(", ")}`);
  }
  return runner;
}
