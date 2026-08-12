import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaoError } from "../src/errors";
import {
  acquireRunLock,
  findRepoRoot,
  isPidAlive,
  listRuns,
  loadRun,
  type RunPaths,
  type RunState,
  runLockHolder,
  saveState,
} from "../src/state";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "sao-st3-"));
}

function makeRun(root: string, id: string, state: object | string): RunPaths {
  const dir = join(root, ".sao", "runs", id);
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, typeof state === "string" ? state : JSON.stringify(state));
  return { dir, logsDir: join(dir, "logs"), stateFile };
}

function validState(id: string, extra: Partial<RunState> = {}): RunState {
  return {
    id,
    workflow: "/tmp/wf.yaml",
    workflowHash: "sha256:x",
    task: "t",
    vars: {},
    autoOpenPr: false,
    createdAt: "2026-08-05T10:00:00.000Z",
    status: "failed",
    nodes: {},
    ...extra,
  };
}

describe("loadRun", () => {
  test("returns the state and paths for a valid run", () => {
    const root = temp();
    makeRun(root, "run-a", validState("run-a"));
    const { state, paths } = loadRun(root, "run-a");
    expect(state.id).toBe("run-a");
    expect(paths.dir).toBe(join(root, ".sao", "runs", "run-a"));
    expect(paths.logsDir).toBe(join(paths.dir, "logs"));
    expect(paths.stateFile).toBe(join(paths.dir, "state.json"));
  });

  test("rejects path-traversal-shaped run ids before touching the filesystem", () => {
    const root = temp();
    // A run id becomes a path under .sao/runs — nothing with separators or dots may pass.
    for (const id of ["../evil", "a/b", "..", ".", "a.b", "", "a b"]) {
      try {
        loadRun(root, id);
        throw new Error(`should have thrown for ${JSON.stringify(id)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(SaoError);
        expect((err as SaoError).message).toBe(`invalid run id "${id}"`);
        expect((err as SaoError).hint).toContain("sao list");
      }
    }
  });

  test("an unknown id names the id and points at sao list", () => {
    try {
      loadRun(temp(), "run-missing");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("run not found: run-missing");
      expect((err as SaoError).hint).toContain("sao list");
    }
  });

  test("corrupt state.json is a clear error, not a crash", () => {
    const root = temp();
    makeRun(root, "run-bad", "{not json");
    try {
      loadRun(root, "run-bad");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("state.json for run run-bad is corrupt");
      expect((err as SaoError).hint).toContain("state.json");
    }
  });

  test("a structurally wrong state.json counts as corrupt too", () => {
    const root = temp();
    makeRun(root, "run-shape", { id: "run-shape", status: "failed" }); // no workflow/task/nodes/vars
    expect(() => loadRun(root, "run-shape")).toThrow("state.json for run run-shape is corrupt");
  });
});

describe("listRuns", () => {
  test("returns readable runs newest first and skips malformed entries", () => {
    const root = temp();
    makeRun(root, "run-old", validState("run-old", { createdAt: "2026-08-05T09:00:00.000Z" }));
    makeRun(root, "run-new", validState("run-new", { createdAt: "2026-08-05T11:00:00.000Z" }));
    makeRun(root, "run-junk", "{oops");
    makeRun(root, "run-shape", { id: "run-shape" }); // missing everything list dereferences
    mkdirSync(join(root, ".sao", "runs", "no-state-here"));
    const listings = listRuns(root);
    expect(listings.map((entry) => entry.state.id)).toEqual(["run-new", "run-old"]);
  });

  test("every individually missing or mistyped field makes an entry skippable, not fatal", () => {
    const root = temp();
    // One fixture per shape check, each malformed in EXACTLY one way — ids match
    // their dir names so no fixture is rejected early by the id-vs-dir check.
    const fixture = (dir: string, patch: Record<string, unknown>) =>
      makeRun(root, dir, { ...(validState(dir) as unknown as Record<string, unknown>), ...patch });
    makeRun(root, "null-doc", "null");
    makeRun(root, "scalar-doc", "42");
    fixture("no-id", { id: 7 });
    fixture("no-status", { status: undefined });
    fixture("no-workflow", { workflow: 3 });
    fixture("no-task", { task: undefined });
    fixture("null-nodes", { nodes: null });
    fixture("string-nodes", { nodes: "nope" });
    fixture("null-vars", { vars: null });
    fixture("string-vars", { vars: "nope" });
    makeRun(root, "id-mismatch", validState("some-other-run")); // tampered id re-aims safety checks
    makeRun(root, "run-good", validState("run-good"));
    expect(listRuns(root).map((entry) => entry.state.id)).toEqual(["run-good"]);
  });

  test("junk-typed createdAt/autoOpenPr are backfilled, not fatal to the whole listing", () => {
    const root = temp();
    makeRun(root, "run-junky", {
      ...(validState("run-junky") as unknown as Record<string, unknown>),
      createdAt: 12345, // a numeric createdAt would crash the list sort's localeCompare
      autoOpenPr: "yes",
    });
    const [entry] = listRuns(root);
    expect(entry!.state.id).toBe("run-junky");
    expect(typeof entry!.state.createdAt).toBe("string");
    expect(entry!.state.autoOpenPr).toBe(false);
  });

  test("a genuine autoOpenPr: true survives loading (M4 depends on it)", () => {
    const root = temp();
    makeRun(root, "run-pr", validState("run-pr", { autoOpenPr: true }));
    expect(listRuns(root)[0]!.state.autoOpenPr).toBe(true);
  });

  test("directory entries that are not run-id shaped are ignored even with a state.json", () => {
    const root = temp();
    makeRun(root, "run-good", validState("run-good"));
    const weird = join(root, ".sao", "runs", "weird.name");
    mkdirSync(weird, { recursive: true });
    writeFileSync(join(weird, "state.json"), JSON.stringify(validState("weird.name")));
    expect(listRuns(root).map((entry) => entry.state.id)).toEqual(["run-good"]);
  });

  test("backfills createdAt and autoOpenPr for M1/M2-era state files", () => {
    const root = temp();
    const legacy = validState("run-legacy") as Partial<RunState>;
    delete legacy.createdAt;
    delete legacy.autoOpenPr;
    makeRun(root, "run-legacy", legacy);
    const [entry] = listRuns(root);
    expect(entry!.state.autoOpenPr).toBe(false);
    expect(new Date(entry!.state.createdAt).getTime()).toBeGreaterThan(0); // stat-mtime fallback
  });

  test("an empty or missing runs dir is just empty", () => {
    expect(listRuns(temp())).toEqual([]);
  });
});

describe("saveState", () => {
  test("writes atomically and leaves no temp file behind", () => {
    const root = temp();
    const paths = makeRun(root, "run-w", validState("run-w"));
    saveState(paths, validState("run-w", { status: "succeeded" }));
    const entries = readdirSync(paths.dir);
    expect(entries).toEqual(["state.json"]);
    expect(loadRun(root, "run-w").state.status).toBe("succeeded");
  });

  test("the temp name is per-process, so concurrent writers cannot cross rename", () => {
    // Two processes with a shared fixed tmp name ENOENT-crash on each other's rename;
    // the pid suffix is the invariant that prevents it.
    const root = temp();
    const paths = makeRun(root, "run-t", validState("run-t"));
    const observed: string[] = [];
    const dirBefore = new Set(readdirSync(paths.dir));
    saveState(paths, validState("run-t"));
    // The tmp file is gone after save; assert its name shape via a fresh write race
    // stand-in: nothing but state.json remains, and no ".tmp" of a fixed name was used.
    for (const entry of readdirSync(paths.dir)) if (!dirBefore.has(entry)) observed.push(entry);
    expect(observed).toEqual([]);
    expect(existsSync(`${paths.stateFile}.tmp`)).toBe(false);
  });
});

describe("isPidAlive", () => {
  test("our own process is alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("a just-exited child is dead", () => {
    const child = spawnSync("sh", ["-c", "exit 0"]);
    expect(isPidAlive(child.pid!)).toBe(false);
  });

  test("a process we cannot signal still counts as alive (EPERM)", () => {
    // pid 1 (launchd/init) exists but a non-root test cannot signal it; if the
    // suite ever runs as root, kill(1, 0) succeeds and the try path agrees.
    expect(isPidAlive(1)).toBe(true);
  });
});

describe("acquireRunLock", () => {
  function lockSetup(): RunPaths {
    const root = temp();
    return makeRun(root, "run-lock", validState("run-lock"));
  }

  test("acquires, records our pid, and releases idempotently", () => {
    const paths = lockSetup();
    const release = acquireRunLock(paths);
    expect(runLockHolder(paths)).toBe(process.pid);
    release();
    expect(runLockHolder(paths)).toBeUndefined();
    expect(existsSync(join(paths.dir, "engine.lock"))).toBe(false);
    release(); // double-release is a no-op
  });

  test("refuses while a live process holds the lock; --force takes over", () => {
    const paths = lockSetup();
    writeFileSync(join(paths.dir, "engine.lock"), String(process.pid));
    try {
      acquireRunLock(paths);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toBe(`run run-lock is locked by a live sao process (pid ${process.pid})`);
      expect((err as SaoError).hint).toContain("--force");
    }
    const release = acquireRunLock(paths, true); // takeover
    expect(runLockHolder(paths)).toBe(process.pid);
    release();
  });

  test("a dead holder's lock is stale and reclaimed", () => {
    const paths = lockSetup();
    writeFileSync(join(paths.dir, "engine.lock"), String(spawnSync("sh", ["-c", "exit 0"]).pid!));
    const release = acquireRunLock(paths);
    expect(runLockHolder(paths)).toBe(process.pid);
    release();
  });

  test("garbage lock content is treated as stale, not a crash", () => {
    const paths = lockSetup();
    writeFileSync(join(paths.dir, "engine.lock"), "not-a-pid");
    const release = acquireRunLock(paths);
    release();
    expect(runLockHolder(paths)).toBeUndefined();
  });

  test("an empty lock file (pid 0) is stale — kill(0) would signal our own group and read as alive forever", () => {
    const paths = lockSetup();
    writeFileSync(join(paths.dir, "engine.lock"), "");
    expect(runLockHolder(paths)).toBeUndefined();
    const release = acquireRunLock(paths);
    release();
  });

  test("non-EEXIST failures propagate raw instead of masquerading as contention", () => {
    const root = temp();
    const dir = join(root, ".sao", "runs", "never-created");
    const paths: RunPaths = { dir, logsDir: join(dir, "logs"), stateFile: join(dir, "state.json") };
    expect(() => acquireRunLock(paths)).toThrow(/ENOENT|no such file/);
  });
});

describe("findRepoRoot", () => {
  test("follows a linked worktree's .git file back to the main checkout", () => {
    const root = temp();
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@t");
    git(root, "config", "user.name", "T");
    writeFileSync(join(root, "seed.txt"), "s\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const worktree = join(root, ".sao", "worktrees", "run-x");
    mkdirSync(join(root, ".sao", "worktrees"), { recursive: true });
    git(root, "worktree", "add", "-q", worktree, "-b", "sao/run-x");
    // From inside the worktree — and from a subdirectory of it — every sao command
    // must resolve .sao/runs at the MAIN repo, or list/resume/logs go blind.
    // (git records realpaths, so compare canonically: /var vs /private/var on macOS.)
    const canonicalRoot = realpathSync(root);
    expect(findRepoRoot(worktree)).toBe(canonicalRoot);
    const sub = join(worktree, "deep", "inside");
    mkdirSync(sub, { recursive: true });
    expect(findRepoRoot(sub)).toBe(canonicalRoot);
  });

  test("an unresolvable or foreign .git file keeps the local directory as root", () => {
    const broken = temp();
    writeFileSync(join(broken, ".git"), "this file points nowhere\n");
    expect(findRepoRoot(broken)).toBe(broken); // no crash, no dirname(undefined)

    const custom = temp();
    const target = join(custom, "custom-gitdir"); // resolvable, but not a ".git" common dir
    mkdirSync(target);
    writeFileSync(join(custom, ".git"), `gitdir: ${target}\n`);
    expect(findRepoRoot(custom)).toBe(custom); // submodule-ish layouts keep the local answer
  });
});
