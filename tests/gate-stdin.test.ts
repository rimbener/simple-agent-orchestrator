import { PassThrough } from "node:stream";
import { afterAll, describe, expect, test } from "bun:test";

// The prompt machinery reads real process.stdin, so the suite replaces it with an
// in-memory pipe: readline is driven by writes instead of a human terminal.
const origStdin = process.stdin;
const stdin = new PassThrough();
process.stdin = stdin as unknown as typeof process.stdin;

const { promptOnTerminal } = await import("../src/gate");

const tick = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

afterAll(() => {
  process.stdin = origStdin;
});

describe("promptOnTerminal", () => {
  test("a multi-reply chunk answers the current prompt and buffers the rest", async () => {
    const first = promptOnTerminal("");
    await tick();
    stdin.write("a\nb\n");
    await expect(first).resolves.toBe("a");
    const second = promptOnTerminal("");
    await expect(second).resolves.toBe("b");
  });

  test("a waiting prompt is resolved by the next line", async () => {
    const reply = promptOnTerminal("");
    await tick();
    stdin.write("n\n");
    await expect(reply).resolves.toBe("n");
  });

  test("concurrent prompts serialize: one line serves one prompt", async () => {
    const one = promptOnTerminal("");
    const two = promptOnTerminal("");
    await tick();
    stdin.write("y\n");
    await expect(one).resolves.toBe("y");
    await tick();
    stdin.write("r\n");
    await expect(two).resolves.toBe("r");
  });

  test("stdin EOF while a prompt waits rejects with the stdin-closed error", async () => {
    const reply = promptOnTerminal("");
    await tick();
    stdin.end();
    await expect(reply).rejects.toThrow("stdin closed while waiting for a reply");
  });

  test("a prompt issued after EOF rejects too", async () => {
    await expect(promptOnTerminal("")).rejects.toThrow("stdin closed while waiting for a reply");
  });
});
