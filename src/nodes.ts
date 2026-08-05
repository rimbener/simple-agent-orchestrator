import { spawn } from "node:child_process";
import { SaoError } from "./errors";
import { killTree, track } from "./procs";
import type { Runner } from "./runners/types";
import type { AiNode, BashNode } from "./schema";

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
}

export interface AiNodeResult {
  output: string;
  sessionId?: string;
}

export async function executeAiNode(
  node: AiNode,
  prompt: string,
  runner: Runner,
  opts: { model?: string; permissionMode?: string },
  ctx: NodeExecContext,
): Promise<AiNodeResult> {
  const result = await runner.run({
    prompt,
    cwd: ctx.cwd,
    model: node.model ?? opts.model,
    permissionMode: opts.permissionMode,
    timeoutSec: node.timeout,
    onOutput: ctx.log,
  });
  if (result.exitCode !== 0) {
    // No node-id prefix: the engine wraps every node error with the id already. The
    // useful failure message often lives only in the result text — surface it.
    const detail = result.output.trim();
    throw new SaoError(
      `${runner.name} exited with code ${result.exitCode}`,
      detail ? (detail.length <= 500 ? detail : detail.slice(0, 500) + " …") : undefined,
    );
  }
  return { output: result.output, sessionId: result.sessionId };
}

export function executeBashNode(node: BashNode, script: string, ctx: NodeExecContext): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", script], {
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
    const timer = node.timeout
      ? setTimeout(() => {
          killTree(child);
          settle(() => reject(new SaoError(`timed out after ${node.timeout}s`)));
        }, node.timeout * 1000)
      : undefined;

    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      combined += text;
      if (combined.length > MAX_BUFFER_CHARS) combined = trimBuffer(combined);
      ctx.log(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("error", (err) => {
      settle(() => reject(new SaoError(`failed to spawn shell: ${err.message}`)));
    });

    child.on("close", (code) => {
      settle(() => {
        if (code !== 0) {
          reject(new SaoError(`command exited with code ${code}`));
          return;
        }
        resolve(tail(combined, BASH_OUTPUT_TAIL_LINES));
      });
    });
  });
}

export async function withRetries<T>(retries: number, attempt: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt();
    } catch (err) {
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
  for (let i = 0; i < TRIM_KEEP_SEGMENTS && idx > 0; i++) {
    const found = text.lastIndexOf("\n", idx - 1);
    if (found === -1) {
      idx = 0;
      break;
    }
    idx = found;
  }
  const kept = idx <= 0 ? text : text.slice(idx + 1);
  return kept.length > MAX_BUFFER_CHARS ? kept.slice(kept.length - MAX_BUFFER_CHARS) : kept;
}
