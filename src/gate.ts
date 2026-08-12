import { createInterface, type Interface } from "node:readline";
import { SaoError } from "./errors";

export type PromptUser = (message: string) => Promise<string>;

export type GateReply = { kind: "approve" } | { kind: "reject" } | { kind: "feedback"; text: string } | { kind: "empty" };

const APPROVALS = new Set(["a", "approve", "approved", "y", "yes"]);
const REJECTIONS = new Set(["r", "reject", "rejected", "n", "no"]);
// Interactive loops are conversations — an interview agent asks "should the API be
// public?" and the human answers "no". Only the explicit forms may act as verdicts
// there; natural-language yes/no must flow through as feedback, never halt the run.
const LOOP_APPROVALS = new Set(["a", "approve", "approved"]);
const LOOP_REJECTIONS = new Set(["r", "reject", "rejected"]);

export function parseGateReply(reply: string): GateReply {
  return parse(reply, APPROVALS, REJECTIONS);
}

/** Reply parsing for interactive loops: stricter verdict vocabulary (see above). */
export function parseLoopReply(reply: string): GateReply {
  return parse(reply, LOOP_APPROVALS, LOOP_REJECTIONS);
}

function parse(reply: string, approvals: Set<string>, rejections: Set<string>): GateReply {
  const text = reply.trim();
  if (!text) return { kind: "empty" };
  const lower = text.toLowerCase();
  if (approvals.has(lower)) return { kind: "approve" };
  if (rejections.has(lower)) return { kind: "reject" };
  return { kind: "feedback", text };
}

// With concurrent branches, two gates/interactive loops must never interleave on
// stdin — prompts are strictly serialized through this queue.
// NOTE: queue/buffered/rl are process-global by design (stdin is process-global).
// Embedders running several runWorkflow calls in one process share type-ahead
// lines across runs; the CLI is one run per process, where this is the point.
let queue: Promise<unknown> = Promise.resolve();

// Stryker disable all: everything below drives the real process stdin, which is
// exercised exclusively by the spawned-CLI tests in cli.test.ts — invisible to
// per-test coverage, so every mutant would report NoCoverage (same rationale as
// excluding cli.ts).

function stdinClosedError(): SaoError {
  return new SaoError(
    "stdin closed while waiting for a reply",
    "gates and interactive loops need an interactive terminal (or piped replies, one line per prompt)",
  );
}

/**
 * Process-lifetime readline over stdin. A per-prompt interface would discard the
 * extra lines when one pipe chunk carries replies for several prompts (readline
 * consumes the whole chunk, the interface closes, reply #2 is gone), and an
 * interface created on already-ended stdin never emits `close`. One lazily created
 * interface instead: every line is kept in `buffered` until a prompt consumes it,
 * and the interface is paused while no prompt is waiting so an idle stdin never
 * holds the event loop open.
 */
let rl: Interface | undefined;
let stdinClosed = false;
const buffered: string[] = [];
let waiting: { resolve: (line: string) => void; reject: (err: SaoError) => void } | undefined;

function ensureReadline(): void {
  if (process.stdin.readableEnded || process.stdin.destroyed) {
    stdinClosed = true;
    return;
  }
  if (rl !== undefined || stdinClosed) return;
  rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    if (waiting !== undefined) {
      const turn = waiting;
      waiting = undefined;
      rl!.pause(); // idle until the next prompt — a paused stdin lets the process exit
      turn.resolve(line);
    } else {
      buffered.push(line); // type-ahead or a multi-reply pipe chunk: keep for the next prompt
    }
  });
  rl.on("close", () => {
    // stdin EOF (CI, exhausted pipe). Without this, a pending question would leave
    // the drained event loop to exit the process with code 0 — a false success.
    stdinClosed = true;
    if (waiting !== undefined) {
      const turn = waiting;
      waiting = undefined;
      turn.reject(stdinClosedError());
    }
  });
  rl.pause();
}

/** Ask on the terminal; resolves with the raw reply line. */
export const promptOnTerminal: PromptUser = (message) => {
  const turn = queue.then(async () => {
    ensureReadline();
    process.stdout.write(message);
    // Lines buffered before this prompt (multi-reply pipe) answer it immediately —
    // even after EOF: buffered replies outlive the stream that delivered them.
    const bufferedLine = buffered.shift();
    if (bufferedLine !== undefined) return bufferedLine;
    if (stdinClosed) throw stdinClosedError();
    rl!.resume();
    return await new Promise<string>((resolve, reject) => {
      waiting = { resolve, reject };
    });
  });
  queue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
};

/**
 * Test hook: tear down the process-lifetime stdin machinery so a suite can run
 * against fresh state. bun's --rerun-each reuses the module instance across
 * runs, so a test that EOFs stdin would otherwise poison every later run.
 */
export function resetPromptState(): void {
  if (waiting !== undefined) {
    const turn = waiting;
    waiting = undefined;
    turn.reject(new SaoError("prompt state reset while a reply was pending", "resetPromptState() torn down mid-prompt"));
  }
  if (rl !== undefined) {
    rl.removeAllListeners("line");
    rl.removeAllListeners("close");
    rl.close();
    rl = undefined;
  }
  queue = Promise.resolve();
  stdinClosed = false;
  buffered.length = 0;
}
// Stryker restore all
