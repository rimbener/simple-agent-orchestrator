import { spawn } from "node:child_process";
import { GateRejectedError, SaoError, truncateDetail } from "./errors";
import { killTree, track } from "./procs";
import type { Runner } from "./runners/types";

const BASH_OUTPUT_TAIL_LINES = 100;
// Only the last 100 lines become node output, so cap the in-memory buffer instead of
// holding gigabytes of build logs (or crashing at V8's max string length) while
// streaming. The full output still reaches the log file. Trimming keeps far more than
// `tail` needs, so the result only deviates on pathological outputs: last 100 lines
// exceeding the cap (truncated from the front), or >900 consecutive trailing blank lines.
const MAX_BUFFER_CHARS = 4 << 20;
const TRIM_KEEP_SEGMENTS = 1000;

export interface NodeExecContext {
  cwd: string;
  /** Receives every output chunk (streamed to the terminal and the node log). */
  log: (chunk: string) => void;
  /** Extra environment (SAO_* run metadata) merged over process.env for subprocesses. */
  env?: Record<string, string>;
}

export interface AiNodeResult {
  output: string;
  sessionId?: string;
}

/** Everything a single AI execution needs beyond its prompt. */
export interface AiExecConfig {
  runner: Runner;
  model?: string;
  permissionMode?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  mcpConfigPath?: string;
  resumeSessionId?: string;
  timeoutSec?: number;
}

export async function executeAiNode(prompt: string, config: AiExecConfig, ctx: NodeExecContext): Promise<AiNodeResult> {
  const result = await config.runner.run({
    prompt,
    cwd: ctx.cwd,
    env: ctx.env,
    model: config.model,
    permissionMode: config.permissionMode,
    systemPrompt: config.systemPrompt,
    allowedTools: config.allowedTools,
    mcpConfigPath: config.mcpConfigPath,
    resumeSessionId: config.resumeSessionId,
    timeoutSec: config.timeoutSec,
    onOutput: ctx.log,
  });
  if (result.exitCode !== 0) {
    // No node-id prefix: the engine wraps every node error with the id already. The
    // useful failure message often lives only in the result text — surface it.
    throw new SaoError(`${config.runner.name} exited with code ${result.exitCode}`, truncateDetail(result.output));
  }
  return { output: result.output, sessionId: result.sessionId };
}

export interface ShellResult {
  code: number;
  /** Last 100 lines of combined stdout+stderr. */
  output: string;
}

/**
 * Run a shell script; resolves with the exit code (predicates need non-zero codes
 * without throwing). Rejects only on spawn failure or timeout.
 */
export function runShell(
  script: string,
  opts: { cwd: string; timeoutSec?: number; log: (chunk: string) => void; env?: Record<string, string> },
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", script], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env }, // SAO_* run metadata rides along (SPEC step 6)
      detached: true, // own process group, so a timeout can kill the whole tree
    });
    track(child);

    let combined = "";
    let settled = false;
    // Settle exactly once. The timeout path must NOT wait for `close`: if the kill
    // fails or a grandchild keeps the tree alive, `close` may be late or never come.
    const settle = (finish: () => void) => {
      // Stryker disable next-line all: equivalent — every finish closure only calls resolve/reject, and re-settling an already-settled promise is a spec'd no-op (re-running clearTimeout is a no-op too)
      if (settled) return;
      // Stryker disable next-line all: equivalent — same reasoning; the flag exists only to skip no-op double-settles
      settled = true;
      if (timer) clearTimeout(timer);
      finish();
    };
    const timer = opts.timeoutSec
      ? setTimeout(() => {
          killTree(child);
          settle(() => reject(new SaoError(`timed out after ${opts.timeoutSec}s`)));
        }, opts.timeoutSec * 1000)
      : undefined;

    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      combined += text;
      if (combined.length > MAX_BUFFER_CHARS) combined = trimBuffer(combined);
      opts.log(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("error", (err) => {
      settle(() => reject(new SaoError(`failed to spawn shell: ${err.message}`)));
    });

    child.on("close", (code) => {
      settle(() => resolve({ code: code ?? 1, output: tail(combined, BASH_OUTPUT_TAIL_LINES) }));
    });
  });
}

/** Bash node/step execution: non-zero exit is a failure. */
export async function executeBashScript(
  script: string,
  opts: { cwd: string; timeoutSec?: number; log: (chunk: string) => void; env?: Record<string, string> },
): Promise<string> {
  const { code, output } = await runShell(script, opts);
  if (code !== 0) throw new SaoError(`command exited with code ${code}`);
  return output;
}

/**
 * when_bash predicate: exit 0 → run the node/step, anything else → skip it.
 * Spawn failures and timeouts still throw — a broken predicate must not silently skip.
 */
export async function evaluateWhenBash(
  script: string,
  opts: { cwd: string; timeoutSec?: number; log: (chunk: string) => void; env?: Record<string, string> },
): Promise<boolean> {
  const { code } = await runShell(script, opts);
  return code === 0;
}

export async function withRetries<T>(retries: number, attempt: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt();
    } catch (err) {
      // A human's explicit rejection is a decision, not a flake — retrying it would
      // re-run the whole node (interactive loops!) against their stated stop.
      if (err instanceof GateRejectedError) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

function tail(text: string, lines: number): string {
  const all = text.trimEnd().split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/**
 * Mid-stream trim: keep the last TRIM_KEEP_SEGMENTS newline-delimited segments (wide
 * margin for trailing blank lines that `tail` strips) plus any trailing partial line,
 * hard-capped at MAX_BUFFER_CHARS so a newline-less stream stays bounded too.
 */
export function trimBuffer(text: string): string {
  let idx = text.length;
  // Stryker disable ConditionalExpression,EqualityOperator,BlockStatement: boundary mutants here are equivalent — once idx reaches 0 (or found is -1 and idx becomes -1 without the break), the loop exits and both routes land in the idx <= 0 branch below with identical output
  for (let i = 0; i < TRIM_KEEP_SEGMENTS && idx > 0; i++) {
    const found = text.lastIndexOf("\n", idx - 1);
    if (found === -1) {
      idx = 0;
      break;
    }
    idx = found;
  }
  // Stryker restore ConditionalExpression,EqualityOperator,BlockStatement
  const kept = idx <= 0 ? text : text.slice(idx + 1);
  // Stryker disable next-line EqualityOperator: equivalent — at kept.length === MAX_BUFFER_CHARS the slice keeps the whole string either way
  return kept.length > MAX_BUFFER_CHARS ? kept.slice(kept.length - MAX_BUFFER_CHARS) : kept;
}
