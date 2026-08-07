import { describe, expect, test, vi } from "bun:test";
import { createRequire } from "node:module";

// The real spawnSync, captured via require so vi.mock can't loop back on it.
const require = createRequire(import.meta.url);
const realCp = require("node:child_process") as typeof import("node:child_process");

// createDraftPr reaches the "gh could not be spawned" branch (src/worktree.ts:290)
// only when spawnSync reports result.error with a non-ETIMEDOUT code — an
// unspawnable gh. Bun resolves executables outside PATH, so a missing gh cannot be
// fabricated in-process; the gh spawn is faked to return a spawn error instead.
let ghFails = false;

vi.mock("node:child_process", () => {
  return {
    ...realCp,
    spawnSync: (...args: Parameters<typeof realCp.spawnSync>) => {
      const [cmd] = args;
      if (cmd === "gh" && ghFails) {
        return {
          error: Object.assign(new Error("ENOENT: no such file or directory, spawn 'gh'"), {
            code: "ENOENT",
          }),
          pid: undefined,
          status: null,
          signal: null,
          output: null,
          stdout: null,
          stderr: null,
        } as unknown as ReturnType<typeof realCp.spawnSync>;
      }
      return realCp.spawnSync(...args);
    },
  };
});

const { createDraftPr } = await import("../src/worktree");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { SaoError } = await import("../src/errors");

describe("createDraftPr — unspawnable gh", () => {
  test("a spawn error (non-timeout) becomes 'failed to run gh'", () => {
    ghFails = true;
    const dir = mkdtempSync(join(tmpdir(), "sao-gh-"));
    try {
      createDraftPr(dir, { branch: "sao/run-pr", title: "t", body: "b" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      const failure = err as { message: string; hint?: string };
      expect(failure.message).toContain("failed to run gh");
      expect(failure.hint).toContain("install the GitHub CLI");
    } finally {
      ghFails = false;
    }
  });
});
