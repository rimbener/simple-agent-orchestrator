import { createInterface, type Interface } from "node:readline";
import { select as clackSelect, text as clackText, isCancel } from "@clack/prompts";
import { SaoError } from "./errors";
import type { AgentOption } from "./options";

export type PromptUser = (message: string) => Promise<string>;

/** One entry in a navigable list prompt. `collectsText` runs a follow-up text prompt in the same turn. */
export type Choice = { id: string; label: string; description?: string; collectsText?: true };

export type PromptAnswer = { kind: "choice"; id: string } | { kind: "text"; text: string; from?: string };

/** The list-prompt seam: one call per pause, offering `choices` alongside `message`. */
export type PromptChoices = (req: { message: string; choices: Choice[] }) => Promise<PromptAnswer>;

export type GateReply =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "feedback"; text: string }
  | { kind: "empty" };

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

/**
 * Reply parsing for interactive loops: stricter verdict vocabulary (see above), then
 * an exact match on a declared option's id resolves to feedback naming its label —
 * the piped path's stand-in for picking that option from the list. Verdict words
 * win first, so an agent-declared option id colliding with one (e.g. "a") can never
 * cost the human the loop's exit path.
 */
export function parseLoopReply(reply: string, options: AgentOption[] = []): GateReply {
  const result = parse(reply, LOOP_APPROVALS, LOOP_REJECTIONS);
  if (result.kind !== "feedback") return result;
  const match = options.find((option) => option.id === result.text);
  return match ? { kind: "feedback", text: match.label } : result;
}

export type PermissionReply = { kind: "selected"; index: number } | { kind: "invalid" };

/** Permission-prompt replies accept a bare 1-based index, or an offered option's own id verbatim. */
export function parsePermissionReply(reply: string, optionIds: string[]): PermissionReply {
  const text = reply.trim();
  if (/^[0-9]+$/.test(text)) {
    const index = Number(text);
    if (index >= 1 && index <= optionIds.length) return { kind: "selected", index };
  }
  const byId = optionIds.indexOf(text);
  if (byId !== -1) return { kind: "selected", index: byId + 1 };
  return { kind: "invalid" };
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

function stdinClosedError(): SaoError {
  return new SaoError(
    "stdin closed while waiting for a reply",
    "gates, interactive loops, and permission prompts need an interactive terminal (or piped replies, one line per prompt)",
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

/** Reads one reply line: buffered pipe input first, else waits on the readline interface. */
async function readReplyLine(message: string): Promise<string> {
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
}

/** Ask on the terminal; resolves with the raw reply line. */
export const promptOnTerminal: PromptUser = (message) => {
  const turn = queue.then(() => readReplyLine(message));
  queue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
};

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

function listMaxItems(): number | undefined {
  const rows = process.stdout.rows;
  return rows ? Math.max(3, rows - 4) : undefined;
}

/**
 * Ctrl-C during a list prompt re-raises SIGINT on this process rather than
 * rejecting — src/procs.ts's existing handler reaps tracked children and exits
 * 130, the same interrupt path every other pause already uses. The returned
 * promise never settles: the process exits before anything awaits it further.
 */
function reraiseSigint(): Promise<never> {
  process.kill(process.pid, "SIGINT");
  return new Promise<never>(() => {});
}

async function runListPrompt(req: { message: string; choices: Choice[] }): Promise<PromptAnswer> {
  const picked = await clackSelect<string>({
    message: req.message,
    options: req.choices.map((c) => ({ value: c.id, label: c.label, hint: c.description })),
    maxItems: listMaxItems(),
    input: process.stdin,
    output: process.stdout,
  });
  if (isCancel(picked)) return reraiseSigint();
  const chosen = req.choices.find((c) => c.id === picked);
  if (!chosen?.collectsText) return { kind: "choice", id: picked };
  const typed = await clackText({
    message: chosen.label,
    input: process.stdin,
    output: process.stdout,
  });
  if (isCancel(typed)) return reraiseSigint();
  return { kind: "text", text: typed, from: chosen.id };
}

/**
 * The list-prompt seam: interactive terminals get a navigable `@clack/prompts`
 * list; anything else falls back to the same buffered-line reader `promptOnTerminal`
 * uses, resolving `{ kind: "text" }` with no `from` and writing no menu — the
 * choices exist only for a caller to interpret that line against, never rendered.
 */
export const promptChoice: PromptChoices = (req) => {
  const turn = queue.then(async () => {
    if (isInteractive()) return runListPrompt(req);
    const line = await readReplyLine(req.message);
    return { kind: "text", text: line } as const;
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
    turn.reject(
      new SaoError("prompt state reset while a reply was pending", "resetPromptState() torn down mid-prompt"),
    );
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
