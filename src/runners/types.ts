import { SaoError } from "../errors";
import { claudeRunner } from "./claude";

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
}

export type RunnerResolver = (name: string) => Runner;

// A Map, not a plain object: `--runner toString` must not resolve via the prototype chain.
const REGISTRY = new Map<string, Runner>([["claude", claudeRunner]]);

export function getRunner(name: string): Runner {
  const runner = REGISTRY.get(name);
  if (!runner) {
    throw new SaoError(
      `unknown runner "${name}"`,
      // Stryker disable next-line StringLiteral: the ", " join separator is unobservable while the registry holds a single runner; the codex adapter (M4) makes it assertable
      name === "codex" ? "the codex adapter lands in M4" : `available runners: ${[...REGISTRY.keys()].join(", ")}`,
    );
  }
  return runner;
}
