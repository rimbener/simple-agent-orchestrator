import { SaoError } from "../errors";
import type { PromptChoices } from "../gate";
import { claudeRunner } from "./claude";
import { codexRunner } from "./codex";
import { opencodeRunner } from "./opencode";

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
  /** The owning node id — ACP runners name it in a `session/request_permission` prompt. */
  nodeId?: string;
  /** List-prompt seam for ACP `session/request_permission`; shares gate.ts's serialized queue. */
  promptChoice?: PromptChoices;
}

export interface RunnerResult {
  /** Final result text — sentinel detection (M2) runs on this. */
  output: string;
  sessionId?: string;
  exitCode: number;
}

/** What the workflow's AI nodes actually require of a runner's environment. */
export interface RunnerNeeds {
  /** Some loop using this runner has fresh_context: false. */
  needsSessionResume: boolean;
  /** Distinct remote MCP transport kinds ("http" | "sse") the workflow's mcp: block declares. */
  mcpTransports?: string[];
}

export interface Runner {
  name: string;
  run(req: RunnerRequest): Promise<RunnerResult>;
  /**
   * Environment check (binary on PATH, ACP capability handshake, …) run at
   * validate/preflight time, once per distinct runner. May reject/throw a
   * SaoError; ACP runners await a handshake here instead of a static declaration.
   */
  preflight?: (needs: RunnerNeeds) => void | Promise<void>;
  /**
   * Whether run() honors resumeSessionId. Only an explicit `false` marks a runner
   * incapable — loops with `fresh_context: false` are rejected for it at
   * validate/preflight time (mock runners that leave it unset stay resumable).
   * ACP runners supersede this static path with the handshake in preflight().
   */
  supportsSessionResume?: boolean;
  /**
   * How the runner streams its final output — a liveness hint for withholding an
   * interactive loop's echo (M2), never a correctness contract: a wrong or missing
   * declaration only shows the final message twice, never zero times.
   * "per-message": onOutput fires once per complete agent message, the last of
   * which is result.output (claude, codex). "whole-turn": onOutput fires with
   * partial chunks that only add up to result.output at the end (opencode).
   * Unset means "whole-turn" — the conservative default.
   */
  finalOutputStreaming?: "per-message" | "whole-turn";
}

export type RunnerResolver = (name: string) => Runner;

// A Map, not a plain object: `--runner toString` must not resolve via the prototype chain.
const REGISTRY = new Map<string, Runner>([
  ["claude", claudeRunner],
  ["codex", codexRunner],
  ["opencode", opencodeRunner],
]);

export function getRunner(name: string): Runner {
  const runner = REGISTRY.get(name);
  if (!runner) {
    throw new SaoError(`unknown runner "${name}"`, `available runners: ${[...REGISTRY.keys()].join(", ")}`);
  }
  return runner;
}
