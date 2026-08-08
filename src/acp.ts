import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type AgentCapabilities,
  type Client,
  type ContentBlock,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@zed-industries/agent-client-protocol";
import { SaoError, truncateDetail } from "./errors";
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

/**
 * Drives one prompt turn against an ACP agent over stdio: spawn, `initialize`,
 * `session/new`, `session/prompt`, then tear the process down. Each call is a
 * fresh spawn — matching the claude/codex adapters' per-call process lifecycle —
 * so session continuity (task 6) is a matter of what `req.resumeSessionId` asks for.
 */
export function runAcpTurn(launch: AcpLaunch, req: RunnerRequest): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
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
      // Stryker disable next-line all: equivalent — clearTimeout(undefined) is a no-op, and an uncleared timer only fires a harmless killTree on an already-dead child after settling
      if (timer) clearTimeout(timer);
      finish();
    };

    const timer = req.timeoutSec
      ? setTimeout(() => {
          killTree(child);
          settle(() => reject(new SaoError(`${launch.command} timed out after ${req.timeoutSec}s`)));
        }, req.timeoutSec * 1000)
      : undefined;

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
      async requestPermission(): Promise<RequestPermissionResponse> {
        // No wiring yet (task 4 adds the terminal prompt) — never auto-approve.
        return { outcome: { outcome: "cancelled" } };
      },
    };

    // Wait for a confirmed spawn before writing anything: on ENOENT-style failures
    // "error" fires and "spawn" never does, so starting the protocol here would
    // otherwise write to a stdin pipe whose process never launched.
    child.once("spawn", () => {
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      const conn = new ClientSideConnection(() => client, stream);

      (async () => {
        await conn.initialize({ protocolVersion: PROTOCOL_VERSION });
        const session = await conn.newSession({ cwd: req.cwd, mcpServers: [] });
        const promptBlocks: ContentBlock[] = [{ type: "text", text: composeAcpPrompt(req) }];
        const response = await conn.prompt({ sessionId: session.sessionId, prompt: promptBlocks });
        settle(() => {
          killTree(child); // the turn is over — a long-running agent has no reason to keep running
          if (response.stopReason === "refusal") {
            reject(new SaoError(`${launch.command} refused the turn`, truncateDetail(output)));
            return;
          }
          resolve({ output, sessionId: session.sessionId, exitCode: 0 });
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

/**
 * Spawns the agent just long enough to complete `initialize` and read back its
 * advertised capabilities, then tears the process down — never runs a prompt
 * turn. Used by ACP runners' preflight (task 3) to check a workflow's needs
 * against what the agent actually supports, instead of a static declaration.
 */
export function runAcpHandshake(launch: AcpLaunch, opts: { cwd: string; env?: Record<string, string> }): Promise<AgentCapabilities> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
      detached: true,
    });
    track(child);
    swallowStdinErrors(child);

    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      finish();
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle(() => reject(new SaoError(`failed to spawn ${launch.command}: ${err.message}`)));
    });

    child.on("close", (code) => {
      settle(() => reject(new SaoError(`${launch.command} exited before completing the ACP handshake (code ${code})`)));
    });

    child.once("spawn", () => {
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      const client: Client = {
        async sessionUpdate(): Promise<void> {},
        async requestPermission(): Promise<RequestPermissionResponse> {
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
