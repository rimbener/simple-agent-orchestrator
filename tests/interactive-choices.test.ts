import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { SaoError } from "../src/errors";
import { INTERACTIVE_CHOICES_USAGE, parseInteractiveChoicesArgs } from "../src/interactive-choices";

const SCRIPT = new URL("../src/interactive-choices.ts", import.meta.url).pathname;

const OPTIONS = `<options>[{"id":"tty-only","label":"Interactive terminal only (recommended)","description":"Piped/non-TTY echo unchanged"},{"id":"everywhere-plain-list","label":"Everywhere, plain option list when piped","description":"Strip markers always"}]</options>`;

function run(args: string[], input?: string) {
  return spawnSync("bun", ["run", SCRIPT, ...args], { encoding: "utf8", input });
}

describe("parseInteractiveChoicesArgs", () => {
  test("reads a bare <options> blob", () => {
    expect(parseInteractiveChoicesArgs([OPTIONS])).toEqual({
      kind: "run",
      message: "pick an option",
      source: OPTIONS,
    });
  });

  test("strips an options= prefix", () => {
    expect(parseInteractiveChoicesArgs([`options=${OPTIONS}`])).toEqual({
      kind: "run",
      message: "pick an option",
      source: OPTIONS,
    });
  });

  test("takes --message and message= for the question", () => {
    expect(parseInteractiveChoicesArgs(["--message", "which path?", OPTIONS])).toEqual({
      kind: "run",
      message: "which path?",
      source: OPTIONS,
    });
    expect(parseInteractiveChoicesArgs([`message=which path?`, `options=${OPTIONS}`])).toEqual({
      kind: "run",
      message: "which path?",
      source: OPTIONS,
    });
  });

  test("--help wins over other args", () => {
    expect(parseInteractiveChoicesArgs(["--help", OPTIONS])).toEqual({ kind: "help" });
    expect(parseInteractiveChoicesArgs(["-h"])).toEqual({ kind: "help" });
  });

  test("missing blob throws", () => {
    expect(() => parseInteractiveChoicesArgs([])).toThrow(SaoError);
    expect(() => parseInteractiveChoicesArgs(["--message", "hi"])).toThrow(SaoError);
  });

  test("--message without a value throws", () => {
    expect(() => parseInteractiveChoicesArgs(["--message"])).toThrow(SaoError);
  });
});

describe("interactive-choices CLI", () => {
  test("--help prints usage and exits 0", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(INTERACTIVE_CHOICES_USAGE.split("\n")[0]!);
  });

  test("missing blob exits 1 with a hint", () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing options blob");
    expect(result.stderr).toContain("options=");
  });

  test("malformed options exit 1", () => {
    const result = run(["<options>not json</options>"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not parse <options> block");
  });

  test("piped stdin answers via the line reader and prints the text answer", () => {
    const result = run([`options=${OPTIONS}`, "--message", "which path?"], "tty-only\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("which path?");
    expect(result.stdout).toContain('{"kind":"text","text":"tty-only"}');
    expect(result.stdout).not.toContain("Interactive terminal only");
  });
});
