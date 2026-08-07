import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, createRunId, hashFile, initRunDir, saveState, type RunState } from "../src/state";

const temp = () => mkdtempSync(join(tmpdir(), "sao-state-"));

describe("createRunId", () => {
  test("stamps date, time, workflow name, and a random suffix", () => {
    const id = createRunId("hello", new Date(2026, 7, 4, 9, 5));
    expect(id).toMatch(/^2026-08-04-0905-hello-[0-9a-f]{4}$/);
  });

  test("sanitizes path characters so run ids are always safe path segments", () => {
    const id = createRunId("../../../../tmp/sao-pwn", new Date(2026, 7, 4, 9, 5));
    expect(id).not.toContain("/");
    expect(id).not.toContain("..");
    expect(id).toMatch(/^2026-08-04-0905-tmp-sao-pwn-[0-9a-f]{4}$/);
  });

  test("falls back to a generic slug when nothing survives sanitizing", () => {
    expect(createRunId("../..", new Date(2026, 7, 4, 9, 5))).toMatch(/^2026-08-04-0905-run-[0-9a-f]{4}$/);
  });

  test("suffix differs between calls", () => {
    const now = new Date();
    expect(createRunId("x", now)).not.toBe(createRunId("x", now));
  });

  test("collapses each run of illegal characters into a single dash", () => {
    const id = createRunId("a!!b!c", new Date(2026, 7, 4, 9, 5));
    expect(id).toMatch(/^2026-08-04-0905-a-b-c-[0-9a-f]{4}$/);
  });

  test("strips all leading and trailing dashes, not just one", () => {
    const id = createRunId("--Weird--", new Date(2026, 7, 4, 9, 5));
    expect(id).toMatch(/^2026-08-04-0905-Weird-[0-9a-f]{4}$/);
  });
});

describe("createRun", () => {
  test("creates a run with a default createRunId-style id", () => {
    const root = temp();
    const { runId, paths } = createRun(root, "hello");
    expect(runId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-hello-[0-9a-f]{4}$/);
    expect(paths.dir).toBe(join(root, ".sao", "runs", runId));
    expect(existsSync(paths.logsDir)).toBe(true);
  });

  test("retries with fresh ids on collision and succeeds", () => {
    const root = temp();
    initRunDir(root, "taken");
    const ids = ["taken", "taken", "fresh"];
    let calls = 0;
    const { runId, paths } = createRun(root, "wf", () => {
      calls++;
      return ids.shift()!;
    });
    expect(runId).toBe("fresh");
    expect(calls).toBe(3); // two collisions consumed, third id wins
    expect(existsSync(paths.logsDir)).toBe(true);
  });

  test("gives up after exactly five attempts of persistent collisions", () => {
    const root = temp();
    initRunDir(root, "taken");
    let calls = 0;
    let caught: unknown;
    try {
      createRun(root, "wf", () => {
        calls++;
        return "taken";
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("EEXIST");
    expect(calls).toBe(5); // attempts 0..4, then rethrow
  });

  test("rethrows non-collision errors immediately, without retrying", () => {
    const rootFile = join(temp(), "root-is-a-file");
    writeFileSync(rootFile, "");
    let calls = 0;
    let caught: unknown;
    try {
      createRun(rootFile, "wf", () => {
        calls++;
        return "x";
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("ENOTDIR");
    expect(calls).toBe(1);
  });
});

describe("hashFile", () => {
  test("produces a stable sha256-prefixed digest", () => {
    const path = join(temp(), "f.txt");
    writeFileSync(path, "abc");
    expect(hashFile(path)).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("initRunDir", () => {
  test("creates the run and logs directories", () => {
    const root = temp();
    const paths = initRunDir(root, "run-1");
    expect(existsSync(paths.logsDir)).toBe(true);
    expect(paths.stateFile).toBe(join(root, ".sao", "runs", "run-1", "state.json"));
  });

  test("adds .sao/ to .git/info/exclude exactly once", () => {
    const root = temp();
    mkdirSync(join(root, ".git"));
    initRunDir(root, "run-1");
    initRunDir(root, "run-2");
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line.trim() === ".sao/")).toHaveLength(1);
  });

  test("preserves existing exclude entries", () => {
    const root = temp();
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), "keep-me\n");
    initRunDir(root, "run-1");
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("keep-me");
    expect(exclude).toContain(".sao/");
  });

  test("does nothing git-related outside a git repo", () => {
    const root = temp();
    initRunDir(root, "run-1");
    expect(existsSync(join(root, ".git"))).toBe(false);
  });

  test("finds the repo root from a subdirectory", () => {
    const root = temp();
    mkdirSync(join(root, ".git"));
    const sub = join(root, "packages", "app");
    mkdirSync(sub, { recursive: true });
    initRunDir(sub, "run-1");
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toContain(".sao/");
  });

  test("follows a .git file to the linked worktree's common dir", () => {
    const repo = temp();
    mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
    const worktree = temp();
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
    initRunDir(worktree, "run-1");
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain(".sao/");
  });

  test("refuses to reuse an existing run directory", () => {
    const root = temp();
    initRunDir(root, "run-1");
    expect(() => initRunDir(root, "run-1")).toThrow();
  });
});

describe("git exclude content", () => {
  const excludePath = (root: string) => join(root, ".git", "info", "exclude");

  test("writes exactly '.sao/\\n' when no exclude file exists", () => {
    const root = temp();
    mkdirSync(join(root, ".git"));
    initRunDir(root, "run-1");
    expect(readFileSync(excludePath(root), "utf8")).toBe(".sao/\n");
  });

  test("appends after a newline-terminated file without adding blank lines", () => {
    const root = temp();
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(excludePath(root), "foo\n");
    initRunDir(root, "run-1");
    expect(readFileSync(excludePath(root), "utf8")).toBe("foo\n.sao/\n");
  });

  test("inserts the missing newline when the file does not end with one", () => {
    const root = temp();
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(excludePath(root), "foo");
    initRunDir(root, "run-1");
    expect(readFileSync(excludePath(root), "utf8")).toBe("foo\n.sao/\n");
  });

  test("writes exactly '.sao/\\n' into an existing empty exclude file", () => {
    const root = temp();
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(excludePath(root), "");
    initRunDir(root, "run-1");
    expect(readFileSync(excludePath(root), "utf8")).toBe(".sao/\n");
  });

  test("recognizes a whitespace-padded existing entry and leaves the file untouched", () => {
    const root = temp();
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(excludePath(root), "  .sao/  \n");
    initRunDir(root, "run-1");
    expect(readFileSync(excludePath(root), "utf8")).toBe("  .sao/  \n");
  });

  test("two runs leave exactly one entry and nothing else", () => {
    const root = temp();
    mkdirSync(join(root, ".git"));
    initRunDir(root, "run-1");
    initRunDir(root, "run-2");
    expect(readFileSync(excludePath(root), "utf8")).toBe(".sao/\n");
  });
});

describe("findGitDir via .git files", () => {
  test("follows 'gitdir:<path>' with no space after the colon and no trailing newline", () => {
    const target = temp(); // stands in for a real git dir
    const worktree = temp();
    writeFileSync(join(worktree, ".git"), `gitdir:${target}`);
    initRunDir(worktree, "run-1");
    expect(readFileSync(join(target, "info", "exclude"), "utf8")).toBe(".sao/\n");
  });

  test("trims trailing whitespace after the gitdir path", () => {
    const target = temp();
    const worktree = temp();
    writeFileSync(join(worktree, ".git"), `gitdir: ${target}  \n`);
    initRunDir(worktree, "run-1");
    expect(readFileSync(join(target, "info", "exclude"), "utf8")).toBe(".sao/\n");
  });

  test("does not follow a 'gitdir:' that is not at the start of a line", () => {
    const decoy = temp(); // real dir, so a wrongly-followed pointer WOULD be able to write here
    const worktree = temp();
    writeFileSync(join(worktree, ".git"), `somegitdir: ${decoy}\n`);
    const paths = initRunDir(worktree, "run-1");
    expect(existsSync(paths.logsDir)).toBe(true); // run creation itself is unaffected
    expect(existsSync(join(decoy, "info"))).toBe(false); // decoy must stay untouched
  });

  test("a .git file with no gitdir line is ignored without breaking the run", () => {
    const worktree = temp();
    writeFileSync(join(worktree, ".git"), "this file points nowhere\n");
    const paths = initRunDir(worktree, "run-1");
    expect(existsSync(paths.logsDir)).toBe(true);
  });
});

describe("saveState", () => {
  test("round-trips through JSON", () => {
    const root = temp();
    const paths = initRunDir(root, "run-1");
    const state: RunState = {
      id: "run-1",
      workflow: "/wf.yaml",
      workflowHash: "sha256:x",
      task: "t",
      vars: { a: "1" },
      status: "running",
      nodes: { n: { status: "pending" } },
    };
    saveState(paths, state);
    expect(JSON.parse(readFileSync(paths.stateFile, "utf8"))).toEqual(state);
    expect(existsSync(paths.stateFile + ".tmp")).toBe(false); // atomic write leaves no temp file
  });

  test("writes pretty-printed JSON with a trailing newline, byte for byte", () => {
    const root = temp();
    const paths = initRunDir(root, "run-1");
    const state: RunState = {
      id: "run-1",
      workflow: "/wf.yaml",
      workflowHash: "sha256:x",
      task: "t",
      vars: {},
      status: "succeeded",
      nodes: {},
    };
    saveState(paths, state);
    expect(readFileSync(paths.stateFile, "utf8")).toBe(JSON.stringify(state, null, 2) + "\n");
  });
});
