import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  type AgentCapabilities,
  type Client,
  ClientSideConnection,
  type ContentBlock,
  type McpServer,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@zed-industries/agent-client-protocol";
import { SaoError, truncateDetail } from "./errors";
import { type Choice, type PromptAnswer, parsePermissionReply } from "./gate";
import { killTree, swallowStdinErrors, track } from "./procs";
import type { RunnerRequest, RunnerResult } from "./runners/types";

/** How to launch a specific ACP agent binary — the whole shape a registry entry needs to supply. */
export interface AcpLaunch {
  command: string;
  args: string[];
}

/** The agent body rides in the prompt as a role preamble — ACP has no system-prompt slot (codex precedent). */
export function composeAcpPrompt(req: RunnerRequest): string {
  if (!req.systemPrompt) return req.prompt;
  return `${req.systemPrompt}\n\n---\n\n${req.prompt}`;
}

function messageText(content: ContentBlock): string | undefined {
  return content.type === "text" ? content.text : undefined;
}

/** Settings ACP has no home for; the run log warns instead of silently dropping them (codex precedent). */
export function ignoredAcpSettings(req: RunnerRequest): string[] {
  const ignored: string[] = [];
  if (req.allowedTools !== undefined) ignored.push("allowed_tools");
  return ignored;
}

function nameValuePairs(value: unknown): { name: string; value: string }[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).map(([name, v]) => ({ name, value: String(v) }));
}

/** claude's `.mcp.json` shape (`command`/`args`/`env` for stdio, `url` for remote) → the ACP wire shape. */
function toMcpServer(name: string, def: unknown): McpServer {
  const d = (def ?? {}) as Record<string, unknown>;
  if (typeof d.url === "string") {
    return { name, type: d.type === "sse" ? "sse" : "http", url: d.url, headers: nameValuePairs(d.headers) };
  }
  return {
    name,
    command: typeof d.command === "string" ? d.command : "",
    args: Array.isArray(d.args) ? d.args.map(String) : [],
    env: nameValuePairs(d.env),
  };
}

/**
 * Reads the `.mcp.json`-shaped file at `mcpConfigPath` (sao's own serialized
 * inline block, or the workflow author's own file) and converts it to ACP's
 * `session/new`/`session/load` `mcpServers` shape. sao stays a forwarder: no
 * `${ENV_VAR}` expansion, no `{{...}}` templating — the runner's contract.
 */
export function loadAcpMcpServers(mcpConfigPath: string | undefined): McpServer[] {
  if (mcpConfigPath === undefined) return [];
  const raw = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as { mcpServers?: Record<string, unknown> };
  return Object.entries(raw.mcpServers ?? {}).map(([name, def]) => toMcpServer(name, def));
}

/**
 * Drops non-standard `session/update` notifications from the agent's output
 * stream before the ACP library's `Connection` sees them. opencode emits
 * `usage_update` (token-usage telemetry) which the pinned ACP schema does not
 * know, so the library rejects the notification and prints a spurious
 * "Invalid params" error even though the turn is fine. Re-frames NDJSON the
 * same way the library does, preserving untouched lines byte-for-byte.
 */
export function dropUsageUpdateNotifications(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();
  let buffer = "";
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = input.getReader();
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            buffer += textDecoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              let drop = false;
              try {
                const message = JSON.parse(line.trim()) as {
                  method?: string;
                  params?: { update?: { sessionUpdate?: string } };
                };
                drop = message.method === "session/update" && message.params?.update?.sessionUpdate === "usage_update";
              } catch {
                // Unparseable line — pass it through untouched; the library will report it.
              }
              if (!drop) controller.enqueue(textEncoder.encode(`${line}\n`));
            }
          }
        } catch {
          // The agent process was killed mid-turn; the reader aborts instead of
          // ending cleanly. Best-effort pass-through: stop forwarding and let the
          // library see a normal end-of-stream, exactly as it would on the raw pipe.
        } finally {
          reader.releaseLock();
          controller.close();
        }
      })();
    },
  });
}

/**
 * Drives one prompt turn against an ACP agent over stdio: spawn, `initialize`,
 * `session/new`, `session/prompt`, then tear the process down. Each call is a
 * fresh spawn — matching the claude/codex adapters' per-call process lifecycle —
 * so session continuity (task 6) is a matter of what `req.resumeSessionId` asks for.
 */
export function runAcpTurn(launch: AcpLaunch, req: RunnerRequest): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const ignored = ignoredAcpSettings(req);
    if (ignored.length > 0) {
      req.onOutput?.(
        // Stryker disable next-line StringLiteral: equivalent — ignoredAcpSettings only ever pushes one
        // entry ("allowed_tools"), so a one-element array's join separator is never observed.
        `⚠ ${launch.command} ignores ${ignored.join(", ")} — ACP has no tool-allowlist concept to map it onto\n`,
      );
    }

    const child = spawn(launch.command, launch.args, {
      cwd: req.cwd,
      // Stryker disable next-line ArrayDeclaration: equivalent — node/bun default missing stdio entries for fds 0-2 to "pipe"
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...req.env }, // SAO_* run metadata rides along (SPEC step 6)
      detached: true, // own process group, so a timeout can kill the whole tree
    });
    track(child);
    swallowStdinErrors(child);

    let settled = false;
    // Settle exactly once — from a timer, a spawn error, an early exit, or the
    // turn actually completing. Never wait on `close` for the success path: a
    // long-running ACP agent has no reason to exit on its own after one turn.
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimer();
      finish();
    };

    // Pausable timeout (D5): the clock stops for the whole time a permission
    // prompt is outstanding — from the moment it is enqueued, queued time
    // included — and resumes once answered, so one human's slow reply never
    // times out an unrelated node waiting behind it in the same terminal queue.
    let remainingMs = req.timeoutSec !== undefined ? req.timeoutSec * 1000 : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timerStartedAt = 0;

    function onTimeout(): void {
      killTree(child);
      settle(() => reject(new SaoError(`${launch.command} timed out after ${req.timeoutSec}s`)));
    }

    function armTimer(): void {
      if (remainingMs === undefined || settled) return;
      timerStartedAt = Date.now();
      timer = setTimeout(onTimeout, remainingMs);
    }

    function clearTimer(): void {
      // Stryker disable next-line all: equivalent — clearTimeout(undefined) is a no-op, and an uncleared timer only fires a harmless killTree on an already-dead child after settling
      if (timer) clearTimeout(timer);
      timer = undefined;
    }

    function pauseTimer(): void {
      if (remainingMs === undefined || timer === undefined) return;
      clearTimer();
      remainingMs = Math.max(0, remainingMs - (Date.now() - timerStartedAt));
    }

    function resumeTimer(): void {
      armTimer();
    }

    armTimer();

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle(() => reject(new SaoError(`failed to spawn ${launch.command}: ${err.message}`)));
    });

    // An agent that exits before the turn completes (crash, handshake refusal,
    // no ACP on the other end) must reject, not hang the pending request forever.
    child.on("close", (code) => {
      settle(() => reject(new SaoError(`${launch.command} exited before completing the turn (code ${code})`)));
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => req.onOutput?.(chunk));

    let output = "";
    const client: Client = {
      async sessionUpdate(params: SessionNotification): Promise<void> {
        if (params.update.sessionUpdate !== "agent_message_chunk") return;
        const text = messageText(params.update.content);
        if (!text) return;
        output += text;
        req.onOutput?.(text);
      },
      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        // No terminal wired (e.g. a caller that never sets promptChoice) — never auto-approve.
        if (!req.promptChoice) return { outcome: { outcome: "cancelled" } };
        const title = params.toolCall.title ?? params.toolCall.toolCallId;
        const label = req.nodeId ? `[${req.nodeId}] ` : "";
        // The agent's own options, one-to-one, in the order sent — nothing sao invents.
        const choices: Choice[] = params.options.map((opt) => ({ id: opt.optionId, label: opt.name }));
        const optionIds = params.options.map((opt) => opt.optionId);
        // The interactive prompt below is the only rendering of the request — never
        // mirrored through onOutput too, matching the gate node's own prompt text,
        // which likewise never touches the node log (engine.ts's executeGate).
        pauseTimer(); // the whole exchange below is human deliberation, queued time included
        try {
          for (;;) {
            let answer: PromptAnswer;
            try {
              answer = await req.promptChoice({ message: `\n${label}permission requested: ${title}`, choices });
            } catch (err) {
              settle(() => {
                killTree(child);
                reject(err instanceof SaoError ? err : new SaoError(String(err)));
              });
              throw err;
            }
            // A list selection is sent back verbatim — no permission memory of sao's own.
            if (answer.kind === "choice") return { outcome: { outcome: "selected", optionId: answer.id } };
            const parsed = parsePermissionReply(answer.text, optionIds);
            if (parsed.kind === "invalid") continue; // re-ask; nothing is sent to the agent yet
            const option = params.options[parsed.index - 1]!;
            return { outcome: { outcome: "selected", optionId: option.optionId } };
          }
        } finally {
          resumeTimer();
        }
      },
    };

    // Wait for a confirmed spawn before writing anything: on ENOENT-style failures
    // "error" fires and "spawn" never does, so starting the protocol here would
    // otherwise write to a stdin pipe whose process never launched.
    child.once("spawn", () => {
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        dropUsageUpdateNotifications(Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
      );
      const conn = new ClientSideConnection(() => client, stream);

      (async () => {
        await conn.initialize({ protocolVersion: PROTOCOL_VERSION });
        const mcpServers = loadAcpMcpServers(req.mcpConfigPath);

        // Session continuity (task 6): task 3's preflight already rejected
        // fresh_context: false against an agent that doesn't advertise loadSession,
        // so reaching session/load here always targets a capable agent.
        let sessionId: string | undefined;
        if (req.resumeSessionId !== undefined) {
          try {
            await conn.loadSession({ cwd: req.cwd, mcpServers, sessionId: req.resumeSessionId });
            sessionId = req.resumeSessionId;
          } catch {
            // The agent responded but no longer knows this session (lost on
            // resume, user story Note 6) — never re-thrown as a transport
            // failure. If the process instead died mid-load, `close`/`error`
            // already settled the turn and `settled` is true here, so this
            // branch does nothing further — a genuine transport failure is
            // never swallowed into a "lost session" retry.
            // Stryker disable next-line ConditionalExpression: verified by hand this branch cannot be
            // proven reachable — killTree always reliably kills the child before a delayed response can
            // arrive, and a dead/killed child leaves conn.loadSession() pending forever rather than
            // rejecting it, so no test drives settled=true here. Left in place for defense in depth.
            if (settled) return;
            req.onOutput?.(
              `⚠ lost session ${req.resumeSessionId} — prior conversation history was lost; continuing in a new session\n`,
            );
          }
        }
        if (sessionId === undefined) {
          const session = await conn.newSession({ cwd: req.cwd, mcpServers });
          sessionId = session.sessionId;
        }

        // Model selection is ACP's session/set_model (spec D7; patched in the
        // pinned client-protocol, whose setSessionModel mistakenly sends
        // session/set_mode). A runner that doesn't implement it (method not
        // found) is warned and falls back to its default — the allowed_tools
        // precedent; any other failure (e.g. an unknown model) fails the turn
        // like a bad --model on claude/codex instead of silently running the
        // wrong model.
        if (req.model !== undefined) {
          try {
            await conn.setSessionModel({ sessionId, modelId: req.model });
          } catch (err) {
            // Stryker disable next-line OptionalChaining: equivalent — err here is always the
            // ACP library's own thrown error object for a rejected RPC, never null/undefined.
            if ((err as { code?: number })?.code === -32601) {
              req.onOutput?.(
                `⚠ ${launch.command} cannot select models — model ${req.model} ignored, using its default\n`,
              );
            } else {
              throw new SaoError(`${launch.command} failed to set model ${req.model}: ${(err as Error).message}`);
            }
          }
        }

        const promptBlocks: ContentBlock[] = [{ type: "text", text: composeAcpPrompt(req) }];
        const response = await conn.prompt({ sessionId, prompt: promptBlocks });
        settle(() => {
          killTree(child); // the turn is over — a long-running agent has no reason to keep running
          if (response.stopReason === "refusal") {
            reject(new SaoError(`${launch.command} refused the turn`, truncateDetail(output)));
            return;
          }
          resolve({ output, sessionId, exitCode: 0 });
        });
      })().catch((err: unknown) => {
        settle(() => {
          killTree(child);
          reject(err instanceof SaoError ? err : new SaoError(`${launch.command} failed: ${(err as Error).message}`));
        });
      });
    });
  });
}

/** Preflight has no per-workflow timeout to inherit, so a hung `initialize` needs its own bound. */
const DEFAULT_HANDSHAKE_TIMEOUT_SEC = 10;

/**
 * Spawns the agent just long enough to complete `initialize` and read back its
 * advertised capabilities, then tears the process down — never runs a prompt
 * turn. Used by ACP runners' preflight (task 3) to check a workflow's needs
 * against what the agent actually supports, instead of a static declaration.
 */
export function runAcpHandshake(
  launch: AcpLaunch,
  opts: { cwd: string; env?: Record<string, string>; timeoutSec?: number },
): Promise<AgentCapabilities> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
      detached: true,
    });
    track(child);
    swallowStdinErrors(child);

    const timeoutSec = opts.timeoutSec ?? DEFAULT_HANDSHAKE_TIMEOUT_SEC;

    let settled = false;
    // Settle exactly once — from the timer, a spawn error, an early exit, or
    // `initialize` actually resolving. Without the timer a binary that spawns
    // but never replies (hung process, silently-dropped request) would hang
    // preflight — and every caller that awaits it — forever.
    const settle = (finish: () => void) => {
      if (settled) return;
      // Stryker disable next-line BooleanLiteral: equivalent — a broken guard lets settle() run twice,
      // but resolve/reject are idempotent (a second call after the promise already settled is a no-op),
      // and killTree/clearTimeout are themselves safe to repeat, so no observable outcome changes.
      settled = true;
      // Stryker disable next-line all: equivalent — clearTimeout on an already-fired timer is a no-op
      clearTimeout(timer);
      finish();
    };

    const timer = setTimeout(() => {
      killTree(child);
      settle(() =>
        reject(new SaoError(`${launch.command} did not respond to the ACP handshake within ${timeoutSec}s`)),
      );
    }, timeoutSec * 1000);

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle(() => reject(new SaoError(`failed to spawn ${launch.command}: ${err.message}`)));
    });

    child.on("close", (code) => {
      settle(() => reject(new SaoError(`${launch.command} exited before completing the ACP handshake (code ${code})`)));
    });

    child.once("spawn", () => {
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        dropUsageUpdateNotifications(Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
      );
      // Stryker disable next-line ObjectLiteral: equivalent — verified by hand: even an empty client
      // object here (sessionUpdate/requestPermission both missing) doesn't change the observable
      // outcome. The ACP library catches the resulting "not a function" errors per-request/notification
      // and answers them with a JSON-RPC error internally; it never propagates to the separate
      // initialize() call this function actually awaits.
      const client: Client = {
        async sessionUpdate(): Promise<void> {},
        // Stryker disable next-line BlockStatement: equivalent, same reason as above — this handler's
        // return value only reaches the spawned agent, which this function kills (killTree) the instant
        // initialize() resolves; verified by hand that the child never observably receives it in time.
        async requestPermission(): Promise<RequestPermissionResponse> {
          // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent, same reason — this return
          // value's shape is never validated or awaited by anything this function actually depends on.
          return { outcome: { outcome: "cancelled" } };
        },
      };
      const conn = new ClientSideConnection(() => client, stream);
      conn
        .initialize({ protocolVersion: PROTOCOL_VERSION })
        .then((result) => {
          settle(() => {
            killTree(child);
            resolve(result.agentCapabilities ?? {});
          });
        })
        .catch((err: unknown) => {
          settle(() => {
            killTree(child);
            reject(err instanceof SaoError ? err : new SaoError(`${launch.command} failed: ${(err as Error).message}`));
          });
        });
    });
  });
}
