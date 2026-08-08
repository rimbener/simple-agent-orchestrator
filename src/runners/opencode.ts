import { runAcpHandshake, runAcpTurn } from "../acp";
import { SaoError } from "../errors";
import { findExecutableOnPath } from "./claude";
import type { Runner, RunnerNeeds, RunnerRequest, RunnerResult } from "./types";

const INSTALL_HINT = "install opencode: https://opencode.ai";
const LAUNCH = { command: "opencode", args: ["acp"] };

/** opencode speaks ACP directly: `opencode acp` (spec D7) — everything else lives in src/acp.ts. */
export const opencodeRunner: Runner = {
  name: "opencode",

  // validate-and-run parity: a missing binary, a failed handshake, or a capability
  // gap must all fail preflight, before any node (or its side effects) runs — not
  // mid-flight at the first AI node. The binary check stays synchronous so it fails
  // fast without ever spawning the process.
  async preflight(needs: RunnerNeeds): Promise<void> {
    if (findExecutableOnPath("opencode") === undefined) {
      throw new SaoError("opencode CLI not found on PATH", INSTALL_HINT);
    }
    let capabilities;
    try {
      // Stryker disable next-line ObjectLiteral: equivalent — node's child_process.spawn defaults cwd to process.cwd() when omitted, so dropping this key changes nothing observable
      capabilities = await runAcpHandshake(LAUNCH, { cwd: process.cwd() });
    } catch (err) {
      throw new SaoError(
        `opencode failed the ACP handshake: ${(err as Error).message}`,
        "the opencode CLI on PATH did not respond to initialize — check it is up to date",
      );
    }
    if (needs.needsSessionResume && capabilities.loadSession !== true) {
      throw new SaoError(
        "opencode does not advertise session loading",
        "fresh_context: false requires session resume — drop fresh_context, or use a runner/agent version that supports it",
      );
    }
    for (const transport of needs.mcpTransports ?? []) {
      const supported = transport === "sse" ? capabilities.mcpCapabilities?.sse : capabilities.mcpCapabilities?.http;
      if (supported !== true) {
        throw new SaoError(
          `opencode does not support the ${transport} MCP transport`,
          `the workflow's mcp: block declares a ${transport} server — drop it, or use a runner/agent version that supports it`,
        );
      }
    }
  },

  run(req: RunnerRequest): Promise<RunnerResult> {
    return runAcpTurn(LAUNCH, req);
  },
};
