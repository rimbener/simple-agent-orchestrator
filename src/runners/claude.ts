import { spawn } from "node:child_process";
import { SaoError } from "../errors";
import { killTree, track } from "../procs";
import type { Runner, RunnerRequest, RunnerResult } from "./types";

interface StreamEvent {
  type?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: { content?: Array<{ type?: string; text?: string }> };
}

// A single stream-json event line can be large (big tool results), but a newline-less
// stream must not grow the reassembly buffer without bound — cap it like the bash path.
const MAX_PENDING_CHARS = 8 << 20;

// Claude Code can hang after emitting its final result event; once the result is in,
// wait only this long for the process to exit before killing the tree and settling.
const RESULT_GRACE_MS = 5000;

export function buildClaudeArgs(req: RunnerRequest): string[] {
  // The prompt goes over stdin, never argv: a prompt starting with "-" would parse as
  // a flag, argv is visible in `ps`, and big interpolated outputs can exceed ARG_MAX.
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  args.push("--permission-mode", req.permissionMode ?? "acceptEdits");
  if (req.model) args.push("--model", req.model);
  if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
  if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
  if (req.mcpConfigPath) args.push("--mcp-config", req.mcpConfigPath);
  if (req.allowedTools?.length) args.push("--allowedTools", req.allowedTools.join(","));
  return args;
}

/**
 * Accumulates claude's stream-json stdout: live assistant text goes to onOutput,
 * the `result` event supplies the final output text and session id.
 */
export class ClaudeStreamCollector {
  output = "";
  sessionId: string | undefined;
  /** Whether a `result` event arrived — without one, a clean exit still has no output. */
  sawResult = false;
  /** The result event's is_error flag — an error result must fail the node even on exit 0. */
  isError = false;
  private pending = "";

  constructor(private readonly onOutput?: (chunk: string) => void) {}

  push(chunk: string): void {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    // Stryker disable next-line StringLiteral: split() always yields at least one element, so pop() never returns undefined — the fallback is unreachable
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.handleLine(line);
    if (this.pending.length > MAX_PENDING_CHARS) {
      this.onOutput?.(this.pending); // give up parsing this pathological line, but stay bounded
      this.pending = "";
    }
  }

  /** Flush a trailing line that arrived without a newline. */
  finish(): void {
    if (this.pending) this.handleLine(this.pending);
    this.pending = "";
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch /* Stryker disable next-line all: equivalent — with an empty catch, `parsed` stays undefined and the scalar guard below emits the same line */ {
      this.onOutput?.(line + "\n");
      return;
    }
    if (parsed === null || typeof parsed !== "object") {
      // JSON scalars ("null", "123", quoted strings) are stray output, not events.
      this.onOutput?.(line + "\n");
      return;
    }
    const event = parsed as StreamEvent;
    if (event.type === "assistant") {
      const text = event.message?.content
        ?.filter((block) => block.type === "text" && block.text)
        .map((block) => block.text)
        .join("");
      if (text) this.onOutput?.(text + "\n");
    } else if (event.type === "result") {
      this.sawResult = true;
      this.isError = event.is_error === true;
      this.output = event.result ?? "";
      this.sessionId = event.session_id;
    }
  }
}

/** Trimmed error detail bounded to a hint-sized excerpt. */
function detail(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= 500 ? trimmed : trimmed.slice(0, 500) + " …";
}

/** Headless Claude Code: `claude -p --output-format stream-json` (stream-json requires --verbose). */
export const claudeRunner: Runner = {
  name: "claude",

  run(req: RunnerRequest): Promise<RunnerResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("claude", buildClaudeArgs(req), {
        cwd: req.cwd,
        // Stryker disable next-line ArrayDeclaration: equivalent — node/bun default missing stdio entries for fds 0-2 to "pipe"
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        detached: true, // own process group, so a timeout can kill the whole tree
      });
      track(child);
      child.stdin.on("error", () => {}); // EPIPE if claude dies early — close reports it
      child.stdin.end(req.prompt);

      const collector = new ClaudeStreamCollector(req.onOutput);
      let settled = false;
      let resultGrace: ReturnType<typeof setTimeout> | undefined;
      // Settle exactly once. The timeout path must NOT wait for `close`: if the kill
      // fails or a grandchild keeps the tree alive, `close` may be late or never come.
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        // Stryker disable next-line all: equivalent — clearTimeout(undefined) is a no-op, and an uncleared timer only fires a harmless killTree on an already-dead child after settling
        if (timer) clearTimeout(timer);
        // Stryker disable next-line all: equivalent — same as the timer guard above, for the grace timer
        if (resultGrace) clearTimeout(resultGrace);
        finish();
      };

      const settleWithResult = (code: number) => {
        collector.finish();
        if ((code !== 0 || collector.isError) && collector.output.trim()) {
          // Failure detail usually lives only on the result event — put it in the log.
          req.onOutput?.(collector.output + "\n");
        }
        if (code === 0 && !collector.sawResult) {
          reject(
            new SaoError(
              "claude exited without emitting a result event",
              "the stream-json output ended before a result line; the node log has the raw stream",
            ),
          );
          return;
        }
        if (code === 0 && collector.isError) {
          reject(new SaoError("claude reported an error result", detail(collector.output)));
          return;
        }
        resolve({ output: collector.output, sessionId: collector.sessionId, exitCode: code });
      };

      const timer = req.timeoutSec
        ? setTimeout(() => {
            killTree(child);
            settle(() => reject(new SaoError(`claude timed out after ${req.timeoutSec}s`)));
          }, req.timeoutSec * 1000)
        : undefined;

      child.stdout.on("data", (chunk: Buffer) => {
        collector.push(chunk.toString());
        // Once the result event is in, don't depend on an optional timeout for a
        // process that hangs instead of exiting — grace-kill and settle with what we have.
        if (collector.sawResult && resultGrace === undefined && !settled) {
          const graceMs = Number(process.env.SAO_CLAUDE_RESULT_GRACE_MS) || RESULT_GRACE_MS;
          resultGrace = setTimeout(() => {
            killTree(child);
            settle(() => settleWithResult(0));
          }, graceMs);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => req.onOutput?.(chunk.toString()));

      child.on("error", (err: NodeJS.ErrnoException) => {
        settle(() => {
          if (err.code === "ENOENT") {
            reject(new SaoError("claude CLI not found on PATH", "install Claude Code: https://claude.com/claude-code"));
          } else /* Stryker disable next-line all: unreachable under bun — non-ENOENT spawn failures (EACCES, ENOEXEC) throw synchronously from spawn() instead of emitting an async error event */ {
            // Stryker disable next-line all: unreachable under bun, as above
            reject(new SaoError(`failed to spawn claude: ${err.message}`));
          }
        });
      });

      child.on("close", (code) => settle(() => settleWithResult(code ?? 1)));
    });
  },
};
