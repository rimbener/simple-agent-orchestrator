import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

// The prompt machinery reads real process.stdin/stdout, so the suite replaces both
// with in-memory pipes: readline and @clack/prompts are driven by writes instead of
// a human terminal.
const origStdin = process.stdin;
const origStdout = process.stdout;
let stdin = new PassThrough();
let stdout = new PassThrough();
process.stdin = stdin as unknown as typeof process.stdin;
process.stdout = stdout as unknown as typeof process.stdout;

const { promptChoice, resetPromptState } = await import("../src/gate");

const tick = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Sets up stdin/stdout as an interactive terminal @clack/prompts can render to and read keys from. */
function makeInteractive(): { written: () => string } {
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: (v: boolean) => void }).setRawMode = () => {};
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  let out = "";
  stdout.on("data", (chunk) => {
    out += chunk.toString();
  });
  return { written: () => out };
}

const DOWN = "\x1B[B";
const ENTER = "\r";
const CTRL_C = "\x03";

// bun --rerun-each reuses the module instance, so an EOF'd stdin would linger
// across runs. Swap in fresh pipes and reset the readline machinery per test.
beforeEach(() => {
  stdin = new PassThrough();
  stdout = new PassThrough();
  process.stdin = stdin as unknown as typeof process.stdin;
  process.stdout = stdout as unknown as typeof process.stdout;
  resetPromptState();
});

afterAll(() => {
  process.stdin = origStdin;
  process.stdout = origStdout;
});

const CHOICES = [
  { id: "sao:approve", label: "Approve" },
  { id: "sao:reject", label: "Reject" },
  { id: "sao:feedback", label: "Give feedback", collectsText: true as const },
];

describe("promptChoice — piped (not an interactive terminal)", () => {
  test("@s-list-no-menu-when-piped: the reply line alone decides the answer, no menu is written", async () => {
    let written = "";
    stdout.on("data", (chunk) => {
      written += chunk.toString();
    });
    const reply = promptChoice({ message: "gate: ", choices: CHOICES });
    await tick();
    stdin.write("approve\n");
    await expect(reply).resolves.toEqual({ kind: "text", text: "approve" });
    expect(written).not.toContain("Approve");
    expect(written).not.toContain("Reject");
    expect(written).not.toContain("Give feedback");
  });

  test("@s-list-stdin-closed-fails: stdin closed with no reply line fails with the existing error", async () => {
    const reply = promptChoice({ message: "gate: ", choices: CHOICES });
    await tick();
    stdin.end();
    await expect(reply).rejects.toThrow("stdin closed while waiting for a reply");
  });

  test("@s-list-serialized-across-branches: two queued prompts never interleave a reply", async () => {
    const one = promptChoice({ message: "one: ", choices: CHOICES });
    const two = promptChoice({ message: "two: ", choices: CHOICES });
    await tick();
    stdin.write("first\n");
    await expect(one).resolves.toEqual({ kind: "text", text: "first" });
    await tick();
    stdin.write("second\n");
    await expect(two).resolves.toEqual({ kind: "text", text: "second" });
  });

  test("a multi-reply pipe chunk answers the current prompt and buffers the rest for the next", async () => {
    const one = promptChoice({ message: "one: ", choices: CHOICES });
    await tick();
    stdin.write("first\nsecond\n");
    await expect(one).resolves.toEqual({ kind: "text", text: "first" });
    const two = promptChoice({ message: "two: ", choices: CHOICES });
    await expect(two).resolves.toEqual({ kind: "text", text: "second" });
  });

  test("a prompt issued after EOF rejects too", async () => {
    stdin.end();
    await tick();
    await expect(promptChoice({ message: "gate: ", choices: CHOICES })).rejects.toThrow(
      "stdin closed while waiting for a reply",
    );
  });

  test("a prompt issued against a destroyed stdin rejects instead of creating a readline", async () => {
    stdin.destroy();
    await tick();
    await expect(promptChoice({ message: "gate: ", choices: CHOICES })).rejects.toThrow(
      "stdin closed while waiting for a reply",
    );
  });

  test("resetPromptState while a reply is pending rejects that reply", async () => {
    const reply = promptChoice({ message: "gate: ", choices: CHOICES });
    await tick();
    resetPromptState();
    await expect(reply).rejects.toThrow("prompt state reset while a reply was pending");
  });
});

describe("promptChoice — interactive terminal", () => {
  test("@s-list-at-terminal: the human moves a selection and confirms one entry, no letter or number menu appears", async () => {
    const { written } = makeInteractive();
    const reply = promptChoice({ message: "gate: ", choices: CHOICES });
    await tick();
    stdin.write(ENTER); // confirm the first entry, "Approve", with no navigation
    await expect(reply).resolves.toEqual({ kind: "choice", id: "sao:approve" });
    expect(written()).toContain("Approve");
    expect(written()).not.toContain("[a]pprove");
    expect(written()).not.toContain("1. Allow");
  });

  test("choosing a collectsText entry runs the follow-up text prompt in the same turn", async () => {
    makeInteractive();
    const reply = promptChoice({ message: "gate: ", choices: CHOICES });
    await tick();
    stdin.write(DOWN + DOWN); // Approve -> Reject -> Give feedback
    await tick();
    stdin.write(ENTER); // confirm "Give feedback"
    await tick();
    stdin.write("looks good");
    stdin.write(ENTER);
    await expect(reply).resolves.toEqual({ kind: "text", text: "looks good", from: "sao:feedback" });
  });

  test("@s-list-serialized-across-branches: a second queued pause can't slot in between a selection and its text entry", async () => {
    makeInteractive();
    const first = promptChoice({ message: "one: ", choices: CHOICES });
    const second = promptChoice({ message: "two: ", choices: CHOICES });
    await tick();
    stdin.write(DOWN + DOWN); // Approve -> Reject -> Give feedback
    await tick();
    stdin.write(ENTER); // confirm "Give feedback" — second must still be waiting
    await tick();
    stdin.write("still first's turn");
    stdin.write(ENTER);
    await expect(first).resolves.toEqual({ kind: "text", text: "still first's turn", from: "sao:feedback" });
    // Now the queue hands the terminal to the second pause.
    await tick();
    stdin.write(ENTER); // confirm "Approve" for the second pause
    await expect(second).resolves.toEqual({ kind: "choice", id: "sao:approve" });
  });

  test("@s-list-longer-than-terminal: an entry past the last visible row is still reachable and selectable", async () => {
    (stdout as unknown as { rows: number }).rows = 6; // maxItems caps at rows - 4 = 3ish; list has 6 entries
    makeInteractive();
    const manyChoices = Array.from({ length: 6 }, (_, i) => ({ id: `opt-${i}`, label: `Option ${i}` }));
    const reply = promptChoice({ message: "gate: ", choices: manyChoices });
    await tick();
    stdin.write(DOWN.repeat(5)); // move past the last visible row to the final entry
    await tick();
    stdin.write(ENTER);
    await expect(reply).resolves.toEqual({ kind: "choice", id: "opt-5" });
  });

  test("@s-list-interrupt: Ctrl-C re-raises SIGINT instead of resolving the pause", async () => {
    makeInteractive();
    const originalKill = process.kill;
    const calls: unknown[][] = [];
    (process as unknown as { kill: typeof process.kill }).kill = ((...args: unknown[]) => {
      calls.push(args);
      return true;
    }) as typeof process.kill;
    try {
      const reply = promptChoice({ message: "gate: ", choices: CHOICES });
      await tick();
      stdin.write(CTRL_C);
      await tick();
      expect(calls).toEqual([[process.pid, "SIGINT"]]);
      // The pause never settles on its own — the process is expected to exit first.
      let settled = false;
      reply.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await tick();
      expect(settled).toBe(false);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });
});
