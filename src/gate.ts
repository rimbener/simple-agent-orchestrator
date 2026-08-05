import { createInterface } from "node:readline/promises";
import { SaoError } from "./errors";

export type PromptUser = (message: string) => Promise<string>;

export type GateReply = { kind: "approve" } | { kind: "reject" } | { kind: "feedback"; text: string } | { kind: "empty" };

const APPROVALS = new Set(["a", "approve", "approved", "y", "yes"]);
const REJECTIONS = new Set(["r", "reject", "rejected", "n", "no"]);

export function parseGateReply(reply: string): GateReply {
  const text = reply.trim();
  if (!text) return { kind: "empty" };
  const lower = text.toLowerCase();
  if (APPROVALS.has(lower)) return { kind: "approve" };
  if (REJECTIONS.has(lower)) return { kind: "reject" };
  return { kind: "feedback", text };
}

// With concurrent branches, two gates/interactive loops must never interleave on
// stdin — prompts are strictly serialized through this queue.
let queue: Promise<unknown> = Promise.resolve();

// Stryker disable all: only reachable through real-stdin paths, which are exercised
// exclusively by the spawned-CLI tests in cli.test.ts (invisible to per-test coverage).
function stdinClosedError(): SaoError {
  return new SaoError(
    "stdin closed while waiting for a reply",
    "gates and interactive loops need an interactive terminal (or one piped reply per prompt, written as each prompt appears)",
  );
}
// Stryker restore all

/** Ask on the terminal; resolves with the raw reply line. */
// Stryker disable all: readline on the real stdin/stdout is only exercised via the
// spawned-CLI gate tests in cli.test.ts, which per-test coverage cannot observe —
// every mutant here would report NoCoverage (same rationale as excluding cli.ts).
export const promptOnTerminal: PromptUser = (message) => {
  const turn = queue.then(async () => {
    // A readline created on ALREADY-ended stdin never emits `close` — the second
    // prompt of a piped run would just hang on a dead stream. Fail loudly up front.
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      throw stdinClosedError();
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      // With stdin at EOF (CI, `< /dev/null`) question() never settles and the drained
      // event loop would exit the process with code 0 — a false success. Reject on
      // close instead, so the gate fails like any other node.
      return await new Promise<string>((resolve, reject) => {
        rl.question(message).then(resolve, reject);
        rl.once("close", () => {
          // Known limitation: one pipe chunk carrying replies for MULTIPLE prompts
          // loses the extra lines when this per-prompt interface closes (a
          // process-lifetime readline is queued for M3).
          reject(stdinClosedError());
        });
      });
    } finally {
      rl.close();
    }
  });
  queue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
};
// Stryker restore all
