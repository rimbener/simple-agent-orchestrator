import { spawn } from "node:child_process";
import { SaoError, truncateDetail } from "../errors";
import { killTree, swallowStdinErrors, track } from "../procs";
import { findExecutableOnPath } from "./claude";
import type { Runner, RunnerRequest, RunnerResult } from "./types";

/**
 * Codex CLI adapter: `codex exec --json` (non-interactive), mapping its JSONL
 * event stream onto the Runner result shape. Differences from the claude adapter,
 * per SPEC: no session resume (loops with `fresh_context: false` are rejected at
 * validate/preflight), no system-prompt flag (the agent body is prepended to the
 * prompt as a role preamble), and MCP / allowed-tools / permission-mode settings
 * are ignored with a warning — codex uses its own global config (~/.codex/config.toml).
 */

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  error?: { message?: string };
  message?: string;
}

// Same bound as the claude adapter: one event line can be large, but a newline-less
// stream must not grow the reassembly buffer without bound.
const MAX_PENDING_CHARS = 8 << 20;

// Once the turn has ended, wait only this long for the process to exit before
// killing the tree and settling with what we have. Same defense as the claude
// adapter's result grace: codex spawns MCP-server children, and a straggler
// holding the pipe open would otherwise hang a node with no `timeout:` forever.
const TURN_END_GRACE_MS = 5000;

const INSTALL_HINT = "install the Codex CLI: npm install -g @openai/codex";

export function buildCodexArgs(req: RunnerRequest): string[] {
  // "-" reads the prompt from stdin, never argv: a prompt starting with "-" would
  // parse as a flag, argv is `ps`-visible, and interpolated outputs can exceed ARG_MAX.
  // Fixed sandbox policy: agents must edit files in their (isolated) worktree — the
  // codex equivalent of the claude adapter's default acceptEdits.
  const args = ["exec", "--json", "--sandbox", "workspace-write"];
  if (req.model) args.push(`--model=${req.model}`); // one token: a hyphen-leading value can never open a new flag
  args.push("-");
  return args;
}

/** The agent body rides in the prompt — codex exec has no system-prompt flag. */
export function composeCodexPrompt(req: RunnerRequest): string {
  if (!req.systemPrompt) return req.prompt;
  return `${req.systemPrompt}\n\n---\n\n${req.prompt}`;
}

/** Settings codex cannot honor; the run log warns instead of silently dropping them. */
export function ignoredCodexSettings(req: RunnerRequest): string[] {
  const ignored: string[] = [];
  if (req.mcpConfigPath !== undefined) ignored.push("mcp");
  if (req.allowedTools !== undefined) ignored.push("allowed_tools");
  if (req.permissionMode !== undefined) ignored.push("permission_mode");
  return ignored;
}

/**
 * Accumulates codex's --json stdout: completed agent messages go to onOutput and
 * the last one is the node output; `thread.started` supplies the session id;
 * `turn.failed`/`error` events fail the node even on a zero exit.
 */
export class CodexStreamCollector {
  output = "";
  sessionId: string | undefined;
  /** Whether any agent_message completed — a clean exit without one has no output. */
  sawMessage = false;
  /** First turn.failed / error event's message — codex reported failure in-stream. */
  errorMessage: string | undefined;
  /** Whether the turn reached a terminal event — nothing of value follows it. */
  turnEnded = false;
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
    // Stryker disable next-line ConditionalExpression: equivalent — handleLine("") returns immediately on the blank-line guard
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
      // JSON scalars are stray output, not events.
      this.onOutput?.(line + "\n");
      return;
    }
    const event = parsed as CodexEvent;
    if (event.type === "thread.started") {
      this.sessionId = event.thread_id;
    } else if (event.type === "item.completed" && event.item?.type === "agent_message") {
      const text = event.item.text ?? "";
      this.sawMessage = true;
      this.output = text; // the last completed agent message is the node output
      if (text) this.onOutput?.(text + "\n");
    } else if (event.type === "turn.completed") {
      this.turnEnded = true;
    } else if (event.type === "turn.failed") {
      this.turnEnded = true;
      this.errorMessage ??= event.error?.message ?? "codex reported turn.failed";
    } else if (event.type === "error") {
      this.errorMessage ??= event.message ?? "codex reported an error event";
    }
  }
}

/** Non-interactive Codex CLI: `codex exec --json` with the prompt piped over stdin. */
export const codexRunner: Runner = {
  name: "codex",
  supportsSessionResume: false,

  // validate-and-run parity: a missing binary must fail preflight, before any node
  // (or its side effects) runs — not mid-flight at the first AI node.
  preflight(): void {
    if (findExecutableOnPath("codex") === undefined) {
      throw new SaoError("codex CLI not found on PATH", INSTALL_HINT);
    }
  },

  run(req: RunnerRequest): Promise<RunnerResult> {
    return new Promise((resolve, reject) => {
      // Defense in depth: preflightAiConfigs rejects fresh_context: false with codex,
      // so a session id here means an engine bug — fail loudly, never silently fresh.
      if (req.resumeSessionId !== undefined) {
        reject(new SaoError("the codex runner cannot resume sessions", "loops with fresh_context: false require the claude runner"));
        return;
      }
      const ignored = ignoredCodexSettings(req);
      if (ignored.length > 0) {
        req.onOutput?.(`⚠ codex ignores ${ignored.join(", ")} — it uses its own config (~/.codex/config.toml)\n`);
      }

      const child = spawn("codex", buildCodexArgs(req), {
        cwd: req.cwd,
        // Stryker disable next-line ArrayDeclaration: equivalent — node/bun default missing stdio entries for fds 0-2 to "pipe"
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...req.env }, // SAO_* run metadata rides along (SPEC step 6)
        detached: true, // own process group, so a timeout can kill the whole tree
      });
      track(child);
      swallowStdinErrors(child); // EPIPE if codex dies early — close reports it
      child.stdin.end(composeCodexPrompt(req));

      const collector = new CodexStreamCollector(req.onOutput);
      let settled = false;
      let turnGrace: ReturnType<typeof setTimeout> | undefined;
      // Settle exactly once. The timeout path must NOT wait for `close`: if the kill
      // fails or a grandchild keeps the tree alive, `close` may be late or never come.
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        // Stryker disable next-line all: equivalent — clearTimeout(undefined) is a no-op, and an uncleared timer only fires a harmless killTree on an already-dead child after settling
        if (timer) clearTimeout(timer);
        // Stryker disable next-line all: equivalent — same as the timer guard above, for the grace timer
        if (turnGrace) clearTimeout(turnGrace);
        finish();
      };

      const settleWithResult = (exitCode: number) => {
        collector.finish();
        if (collector.errorMessage !== undefined) {
          // Failure detail often lives only on the error event — put it in the log.
          req.onOutput?.(collector.errorMessage + "\n");
        }
        if (exitCode === 0) {
          if (collector.errorMessage !== undefined) {
            // codex signalled failure in-stream — an exit 0 must not mask it.
            reject(new SaoError("codex reported an error", truncateDetail(collector.errorMessage)));
            return;
          }
          if (!collector.sawMessage) {
            reject(
              new SaoError(
                "codex exited without emitting an agent message",
                "the --json event stream ended before an agent_message item; codex's stderr and error events are in the node log",
              ),
            );
            return;
          }
          resolve({ output: collector.output, sessionId: collector.sessionId, exitCode });
          return;
        }
        // Non-zero exit: executeAiNode surfaces `output` as the failure detail, and
        // the useful message often lives only on the error event, not an agent message.
        resolve({ output: collector.output || collector.errorMessage || "", sessionId: collector.sessionId, exitCode });
      };

      const timer = req.timeoutSec
        ? setTimeout(() => {
            killTree(child);
            settle(() => reject(new SaoError(`codex timed out after ${req.timeoutSec}s`)));
          }, req.timeoutSec * 1000)
        : undefined;

      // setEncoding: a chunk boundary splitting a multi-byte UTF-8 sequence must not
      // corrupt the text — per-chunk toString() would bake U+FFFD into agent output
      // that later feeds templates, state.json, and PR bodies.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        collector.push(chunk);
        // The turn is over; don't depend on an optional timeout for a process kept
        // alive by a straggling child — grace-kill and settle with what we have.
        if (collector.turnEnded && turnGrace === undefined && !settled) {
          const graceMs = Number(process.env.SAO_CODEX_TURN_GRACE_MS) || TURN_END_GRACE_MS;
          turnGrace = setTimeout(() => {
            killTree(child);
            settle(() => settleWithResult(0));
          }, graceMs);
        }
      });
      child.stderr.on("data", (chunk: string) => req.onOutput?.(chunk));

      child.on("error", (err: NodeJS.ErrnoException) => {
        settle(() => {
          // Stryker disable next-line ConditionalExpression: unreachable under bun — non-ENOENT spawn failures throw synchronously from spawn() instead of emitting an async error event
          if (err.code === "ENOENT") {
            reject(new SaoError("codex CLI not found on PATH", INSTALL_HINT));
          } else /* Stryker disable next-line all: unreachable under bun — non-ENOENT spawn failures (EACCES, ENOEXEC) throw synchronously from spawn() instead of emitting an async error event */ {
            // Stryker disable next-line all: unreachable under bun, as above
            reject(new SaoError(`failed to spawn codex: ${err.message}`));
          }
        });
      });

      child.on("close", (code) => settle(() => settleWithResult(code ?? 1)));
    });
  },
};
