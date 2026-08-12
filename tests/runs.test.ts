import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { SaoError } from "../src/errors";
import {
  cleanRuns,
  formatCleanSummary,
  formatRunList,
  humanAge,
  listLogFiles,
  makeLogPoller,
  printLogs,
} from "../src/runs";
import type { RunPaths, RunState } from "../src/state";
import { addWorktree, worktreeRelPath } from "../src/worktree";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "sao-runs-"));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(): string {
  const dir = temp();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

/** Materialize a run dir with a state.json (and optionally a real worktree). */
function makeRun(
  root: string,
  id: string,
  overrides: Partial<RunState> & { withWorktree?: boolean; dirty?: boolean } = {},
): RunPaths {
  const { withWorktree, dirty, ...stateOverrides } = overrides;
  const dir = join(root, ".sao", "runs", id);
  const paths: RunPaths = { dir, logsDir: join(dir, "logs"), stateFile: join(dir, "state.json") };
  mkdirSync(paths.logsDir, { recursive: true });
  const state: RunState = {
    id,
    workflow: join(root, "wf.yaml"),
    workflowHash: "sha256:x",
    task: "",
    vars: {},
    autoOpenPr: false,
    createdAt: new Date().toISOString(),
    status: "succeeded",
    nodes: {},
    ...stateOverrides,
  };
  if (withWorktree) {
    state.worktree = worktreeRelPath(id);
    state.branch = `sao/${id}`;
    addWorktree(root, join(root, state.worktree), state.branch, "main");
    if (dirty) writeFileSync(join(root, state.worktree, "uncommitted.txt"), "work\n");
  }
  writeFileSync(paths.stateFile, JSON.stringify(state, null, 2));
  return paths;
}

/** A pid that is certainly dead: a just-exited child. */
function deadPid(): number {
  const child = spawnSync("sh", ["-c", "exit 0"]);
  return child.pid!;
}

describe("humanAge", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  test("picks the coarsest fitting unit", () => {
    expect(humanAge(at(0), now)).toBe("0s");
    expect(humanAge(at(59_000), now)).toBe("59s");
    expect(humanAge(at(60_000), now)).toBe("1m");
    expect(humanAge(at(3_599_000), now)).toBe("59m");
    expect(humanAge(at(3_600_000), now)).toBe("1h");
    expect(humanAge(at(86_399_000), now)).toBe("23h");
    expect(humanAge(at(86_400_000), now)).toBe("1d");
    expect(humanAge(at(12 * 86_400_000), now)).toBe("12d");
  });

  test("clamps future timestamps to 0s and marks junk as ?", () => {
    expect(humanAge(at(-5_000), now)).toBe("0s");
    expect(humanAge("not-a-date", now)).toBe("?");
  });
});

describe("formatRunList", () => {
  test("says so when there are no runs", () => {
    expect(formatRunList(temp(), new Date())).toEqual(["no runs found (nothing under .sao/runs)"]);
  });

  test("renders aligned columns, newest first", () => {
    const root = temp();
    makeRun(root, "run-old", { createdAt: "2026-08-05T10:00:00.000Z", status: "failed" });
    makeRun(root, "run-new", { createdAt: "2026-08-05T11:59:00.000Z" });
    const lines = formatRunList(root, new Date("2026-08-05T12:00:00.000Z"));
    expect(lines[0]).toBe("RUN      WORKFLOW  STATUS     AGE");
    expect(lines[1]).toBe("run-new  wf.yaml   succeeded  1m");
    expect(lines[2]).toBe("run-old  wf.yaml   failed     2h");
  });
});

describe("listLogFiles", () => {
  test("filters by node and orders iterations numerically", () => {
    const root = temp();
    const logsDir = join(root, "logs");
    mkdirSync(logsDir);
    for (const file of ["loop.10.log", "loop.2.log", "a.log", "state.json", "readme.txt"]) {
      writeFileSync(join(logsDir, file), "x");
    }
    expect(listLogFiles(logsDir, "loop")).toEqual(["loop.2.log", "loop.10.log"]);
    expect(listLogFiles(logsDir, "ghost")).toEqual([]);
    expect(listLogFiles(logsDir)).toEqual(["a.log", "loop.2.log", "loop.10.log"]); // no order → alphabetical
  });

  test("orders by the node order of the run, unknown nodes last", () => {
    const root = temp();
    const logsDir = join(root, "logs");
    mkdirSync(logsDir);
    for (const file of ["zeta.log", "alpha.log", "renamed.log"]) writeFileSync(join(logsDir, file), "x");
    expect(listLogFiles(logsDir, undefined, ["zeta", "alpha"])).toEqual(["zeta.log", "alpha.log", "renamed.log"]);
  });

  test("a missing logs dir is just empty", () => {
    expect(listLogFiles(join(temp(), "nope"))).toEqual([]);
  });
});

describe("makeLogPoller", () => {
  function poller(logsDir: string, nodeId?: string, nodeOrder: string[] = []) {
    const out: string[] = [];
    const paths: RunPaths = { dir: join(logsDir, ".."), logsDir, stateFile: join(logsDir, "..", "state.json") };
    return { out, poll: makeLogPoller(paths, nodeId, (text) => out.push(text), nodeOrder) };
  }

  test("prints only what was appended since the last poll, with headers on file switches", () => {
    const root = temp();
    const logsDir = join(root, "logs");
    mkdirSync(logsDir);
    writeFileSync(join(logsDir, "a.log"), "one\n");
    const { out, poll } = poller(logsDir);
    expect(poll.poll()).toBe(true);
    appendFileSync(join(logsDir, "a.log"), "two\n");
    expect(poll.poll()).toBe(true);
    expect(poll.poll()).toBe(false); // nothing new
    expect(out.join("")).toBe("── a.log ──\none\ntwo\n");
  });

  test("a UTF-8 sequence split across polls decodes intact", () => {
    const root = temp();
    const logsDir = join(root, "logs");
    mkdirSync(logsDir);
    const bytes = Buffer.from("héllo\n", "utf8"); // é = 0xC3 0xA9
    writeFileSync(join(logsDir, "n.log"), bytes.subarray(0, 2)); // "h" + first half of é
    const { out, poll } = poller(logsDir);
    poll.poll();
    appendFileSync(join(logsDir, "n.log"), bytes.subarray(2));
    poll.poll();
    expect(out.join("")).toBe("── n.log ──\nhéllo\n");
    expect(out.join("")).not.toContain("�");
  });

  test("external truncation resets the offset instead of wedging the file", () => {
    const root = temp();
    const logsDir = join(root, "logs");
    mkdirSync(logsDir);
    writeFileSync(join(logsDir, "t.log"), "a long first line\n");
    const { out, poll } = poller(logsDir);
    poll.poll();
    writeFileSync(join(logsDir, "t.log"), "new\n"); // shrunk: rotated/truncated
    expect(poll.poll()).toBe(true);
    expect(out.join("")).toContain("new\n");
  });

  test("a poll that sees only half a character prints nothing yet — not even a header", () => {
    const root = temp();
    const logsDir = join(root, "logs");
    mkdirSync(logsDir);
    writeFileSync(join(logsDir, "p.log"), Buffer.from([0xc3])); // first byte of é, nothing else
    const { out, poll } = poller(logsDir);
    expect(poll.poll()).toBe(false);
    expect(out).toEqual([]);
    appendFileSync(join(logsDir, "p.log"), Buffer.from([0xa9, 0x0a])); // the rest: "é\n"
    expect(poll.poll()).toBe(true);
    expect(out.join("")).toBe("── p.log ──\né\n");
  });

  test("a file vanishing between polls is skipped, not a crash", () => {
    const root = temp();
    const logsDir = join(root, "logs");
    mkdirSync(logsDir);
    writeFileSync(join(logsDir, "gone.log"), "x\n");
    writeFileSync(join(logsDir, "stays.log"), "y\n");
    const { out, poll } = poller(logsDir);
    poll.poll();
    rmSync(join(logsDir, "gone.log"));
    appendFileSync(join(logsDir, "stays.log"), "more\n");
    expect(poll.poll()).toBe(true);
    expect(out.join("")).toContain("more\n");
  });

  test("a directory squatting on a .log name is skipped — the stat→open race guard", () => {
    const root = temp();
    const logsDir = join(root, "logs");
    mkdirSync(logsDir);
    // A directory named like a log passes readdir and stat (size > 0) but openSync
    // rejects it (EISDIR) — the same shape as a file vanishing between stat and open.
    mkdirSync(join(logsDir, "fake.log"));
    writeFileSync(join(logsDir, "fake.log", "x"), "x"); // guarantee a non-zero dir size
    const { out, poll } = poller(logsDir);
    expect(poll.poll()).toBe(false);
    expect(out).toEqual([]);
  });
});

describe("printLogs", () => {
  test("dumps everything once", () => {
    const root = temp();
    const logsDir = join(root, "logs");
    mkdirSync(logsDir);
    writeFileSync(join(logsDir, "a.log"), "alpha\n");
    const out: string[] = [];
    const paths: RunPaths = { dir: root, logsDir, stateFile: join(root, "state.json") };
    printLogs(paths, undefined, (text) => out.push(text));
    expect(out.join("")).toBe("── a.log ──\nalpha\n");
  });

  test("an unknown node filter errors and lists what exists, comma-separated", () => {
    const root = temp();
    const logsDir = join(root, "logs");
    mkdirSync(logsDir);
    writeFileSync(join(logsDir, "a.log"), "alpha\n");
    writeFileSync(join(logsDir, "b.log"), "beta\n");
    const paths: RunPaths = { dir: root, logsDir, stateFile: join(root, "state.json") };
    try {
      printLogs(paths, "ghost", () => {});
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe('no logs for node "ghost"');
      expect((err as SaoError).hint).toBe("available logs: a.log, b.log");
    }
  });

  test("a run with no logs yet errors with (none)", () => {
    const root = temp();
    const paths: RunPaths = { dir: root, logsDir: join(root, "logs"), stateFile: join(root, "state.json") };
    try {
      printLogs(paths, undefined, () => {});
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("no logs for this run yet");
      expect((err as SaoError).hint).toBe("available logs: (none)");
    }
  });
});

const CLEAN_ZERO = {
  worktrees: 0,
  branches: 0,
  runDirs: 0,
  skippedRunning: 0,
  skippedUnfinished: 0,
  keptDirty: 0,
  keptUnmergedBranches: 0,
};

describe("cleanRuns", () => {
  test("removes a succeeded run's worktree; its unmerged branch survives until merged", () => {
    const root = repo();
    const paths = makeRun(root, "done-1", { withWorktree: true });
    // Give the branch a commit main does not have — deleting it would lose work.
    writeFileSync(join(root, worktreeRelPath("done-1"), "result.txt"), "r\n");
    git(join(root, worktreeRelPath("done-1")), "add", "-A");
    git(join(root, worktreeRelPath("done-1")), "commit", "-qm", "work");
    const first = cleanRuns(root, false, () => {});
    expect(first).toEqual({ ...CLEAN_ZERO, worktrees: 1, keptUnmergedBranches: 1 });
    expect(existsSync(join(root, worktreeRelPath("done-1")))).toBe(false);
    expect(git(root, "branch", "--list", "sao/done-1")).not.toBe(""); // work not lost
    expect(existsSync(paths.dir)).toBe(true); // no --all: state and logs stay

    git(root, "merge", "-q", "sao/done-1");
    const second = cleanRuns(root, false, () => {});
    expect(second).toEqual({ ...CLEAN_ZERO, branches: 1 }); // merged → now deletable
    expect(git(root, "branch", "--list", "sao/done-1")).toBe("");
    const withAll = cleanRuns(root, true, () => {});
    expect(withAll.runDirs).toBe(1);
    expect(existsSync(paths.dir)).toBe(false);
  });

  test("a branch with no commits of its own counts as merged and is deleted", () => {
    const root = repo();
    makeRun(root, "noop-1", { withWorktree: true }); // tip === main tip
    const summary = cleanRuns(root, false, () => {});
    expect(summary).toEqual({ ...CLEAN_ZERO, worktrees: 1, branches: 1 });
    expect(git(root, "branch", "--list", "sao/noop-1")).toBe("");
  });

  test("failed and rejected runs are resume targets — untouched without --all", () => {
    const root = repo();
    makeRun(root, "fail-1", { status: "failed", withWorktree: true, dirty: true });
    makeRun(root, "rej-1", { status: "rejected" });
    const kept = cleanRuns(root, false, () => {});
    expect(kept).toEqual({ ...CLEAN_ZERO, skippedUnfinished: 2 });
    expect(existsSync(join(root, worktreeRelPath("fail-1"), "uncommitted.txt"))).toBe(true);
    const discarded = cleanRuns(root, true, () => {});
    expect(discarded.worktrees).toBe(1);
    expect(discarded.runDirs).toBe(2);
    expect(existsSync(join(root, worktreeRelPath("fail-1")))).toBe(false);
  });

  test("never touches a live run; --all treats dead-pid and legacy pid-less running runs as crashed", () => {
    const root = repo();
    makeRun(root, "live-1", { status: "running", pid: process.pid, withWorktree: true });
    makeRun(root, "crash-1", { status: "running", pid: deadPid(), withWorktree: true });
    makeRun(root, "old-1", { status: "running" }); // no pid recorded (M1/M2 state)
    const byDefault = cleanRuns(root, false, () => {});
    // live-1 and pid-less old-1 are unverifiable/live; dead-pid crash-1 is merely unfinished
    expect(byDefault).toEqual({ ...CLEAN_ZERO, skippedRunning: 2, skippedUnfinished: 1 });
    expect(existsSync(join(root, worktreeRelPath("crash-1")))).toBe(true);

    const withAll = cleanRuns(root, true, () => {});
    expect(withAll.skippedRunning).toBe(1); // only the genuinely live run survives --all
    expect(existsSync(join(root, worktreeRelPath("live-1")))).toBe(true);
    expect(existsSync(join(root, worktreeRelPath("crash-1")))).toBe(false);
  });

  test("a run whose engine.lock is held by a live process is skipped even under --all", () => {
    const root = repo();
    const paths = makeRun(root, "locked-1", { status: "failed" });
    writeFileSync(join(paths.dir, "engine.lock"), String(process.pid));
    const summary = cleanRuns(root, true, () => {});
    expect(summary).toEqual({ ...CLEAN_ZERO, skippedRunning: 1 });
    expect(existsSync(paths.dir)).toBe(true);

    writeFileSync(join(paths.dir, "engine.lock"), String(deadPid()));
    expect(cleanRuns(root, true, () => {}).runDirs).toBe(1); // stale lock: cleanable
  });

  test("a succeeded run whose finalize failed keeps its dirty worktree too", () => {
    const root = repo();
    makeRun(root, "done-dirty", { status: "succeeded", withWorktree: true, dirty: true });
    const warnings: string[] = [];
    const kept = cleanRuns(root, false, (line) => warnings.push(line));
    expect(kept.keptDirty).toBe(1);
    expect(warnings[0]).toContain("uncommitted changes");
    // Resume refuses succeeded runs — the hint must point at the manual commit, never at resume.
    expect(warnings[0]).toContain("commit them in the worktree");
    expect(warnings[0]).not.toContain("resume");
    expect(existsSync(join(root, worktreeRelPath("done-dirty"), "uncommitted.txt"))).toBe(true);
  });

  test("in-place runs (no worktree) clean without warnings", () => {
    const root = repo();
    const paths = makeRun(root, "plain-1", { status: "failed" });
    const warnings: string[] = [];
    const summary = cleanRuns(root, true, (line) => warnings.push(line));
    expect(warnings).toEqual([]);
    expect(summary).toEqual({ ...CLEAN_ZERO, runDirs: 1 });
    expect(existsSync(paths.dir)).toBe(false);
  });

  test("a worktree git refuses to remove is warned about and everything else is kept", () => {
    const root = repo();
    const paths = makeRun(root, "stuck-1", { status: "failed", withWorktree: true });
    // Corrupt the worktree: git worktree remove refuses a dir it can't recognize.
    writeFileSync(join(root, worktreeRelPath("stuck-1"), ".git"), "gitdir: /nonexistent-gitdir\n");
    const warnings: string[] = [];
    const summary = cleanRuns(root, true, (line) => warnings.push(line));
    expect(summary.worktrees).toBe(0);
    expect(warnings[0]).toContain("stuck-1");
    expect(existsSync(paths.dir)).toBe(true); // --all did NOT remove the dir of a stuck worktree
    expect(git(root, "branch", "--list", "sao/stuck-1")).not.toBe("");
  });

  test("a recorded branch that no longer exists is neither counted as kept nor deleted", () => {
    const root = repo();
    const paths = makeRun(root, "ghostbr-1", { withWorktree: true });
    const state = JSON.parse(readFileSync(paths.stateFile, "utf8")) as RunState;
    state.branch = "ghost-gone"; // never existed
    writeFileSync(paths.stateFile, JSON.stringify(state));
    const summary = cleanRuns(root, false, () => {});
    expect(summary).toEqual({ ...CLEAN_ZERO, worktrees: 1 }); // no phantom keptUnmergedBranches
  });

  test("a run with a worktree but no recorded branch cleans without crashing", () => {
    const root = repo();
    const paths = makeRun(root, "nobranch-1", { withWorktree: true });
    const state = JSON.parse(readFileSync(paths.stateFile, "utf8")) as RunState;
    delete state.branch;
    writeFileSync(paths.stateFile, JSON.stringify(state));
    const summary = cleanRuns(root, false, () => {});
    expect(summary.worktrees).toBe(1);
    expect(summary.branches).toBe(0);
    expect(git(root, "branch", "--list", "sao/nobranch-1")).not.toBe(""); // branch intentionally untouched
  });

  test("a tampered state.worktree is never force-removed", () => {
    const root = repo();
    const victim = temp();
    writeFileSync(join(victim, "precious.txt"), "keep me\n");
    makeRun(root, "tamper-1", { status: "failed", worktree: relative(root, victim), branch: "main" });
    const warnings: string[] = [];
    const summary = cleanRuns(root, true, (line) => warnings.push(line));
    expect(warnings[0]).toContain("not the expected");
    expect(existsSync(join(victim, "precious.txt"))).toBe(true);
    expect(git(root, "branch", "--list", "main")).not.toBe(""); // branch survived too
    expect(summary.runDirs).toBe(1); // --all still removes the (safe) run dir
  });
});

describe("formatCleanSummary", () => {
  test("plain and annotated forms", () => {
    expect(formatCleanSummary({ ...CLEAN_ZERO, worktrees: 2, branches: 1 })).toBe(
      "cleaned: 2 worktrees, 1 branches, 0 run dirs",
    );
    expect(
      formatCleanSummary({
        worktrees: 0,
        branches: 0,
        runDirs: 3,
        skippedRunning: 2,
        skippedUnfinished: 1,
        keptDirty: 1,
        keptUnmergedBranches: 4,
      }),
    ).toBe(
      "cleaned: 0 worktrees, 0 branches, 3 run dirs (skipped 2 running; kept 1 unfinished — resume them, or pass --all; kept 1 with uncommitted changes; kept 4 unmerged branches)",
    );
  });
});
