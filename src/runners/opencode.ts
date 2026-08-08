import { runAcpTurn } from "../acp";
import { SaoError } from "../errors";
import { findExecutableOnPath } from "./claude";
import type { Runner, RunnerRequest, RunnerResult } from "./types";

const INSTALL_HINT = "install opencode: https://opencode.ai";

/** opencode speaks ACP directly: `opencode acp` (spec D7) — everything else lives in src/acp.ts. */
export const opencodeRunner: Runner = {
  name: "opencode",

  // validate-and-run parity: a missing binary must fail preflight, before any node
  // (or its side effects) runs — not mid-flight at the first AI node.
  preflight(): void {
    if (findExecutableOnPath("opencode") === undefined) {
      throw new SaoError("opencode CLI not found on PATH", INSTALL_HINT);
    }
  },

  run(req: RunnerRequest): Promise<RunnerResult> {
    return runAcpTurn({ command: "opencode", args: ["acp"] }, req);
  },
};
