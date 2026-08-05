import { describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

function runCli(args: string[], cwd?: string) {
  return spawnSync("bun", ["run", CLI, ...args], { cwd, encoding: "utf8" });
}

function tempWorkflow(yaml: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "sao-cli-"));
  const path = join(dir, "workflow.yaml");
  writeFileSync(path, yaml);
  return { dir, path };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitify(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
}

/** Fails on the first run, passes on resume (marker lands in the exec cwd). */
const FLAKY_YAML = `
name: cli-flaky
nodes:
  - id: ok
    bash: "echo fine"
  - id: flaky
    depends_on: [ok]
    bash: "test -f marker || { touch marker; exit 1; }"
`;

describe("sao validate", () => {
  test("accepts a valid workflow", () => {
    const result = runCli(["validate", join(FIXTURES, "valid.yaml")]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("valid");
  });

  test("fails with a readable error for a missing file", () => {
    const result = runCli(["validate", "/nope/missing.yaml"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read workflow file");
  });

  test("checks runner availability, matching run's preflight", () => {
    const { path } = tempWorkflow(`
name: no-such-runner
defaults:
  runner: nope
nodes:
  - id: a
    prompt: "hi"
`);
    const result = runCli(["validate", path]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node "a": unknown runner "nope"');
    expect(result.stderr).toContain("available runners: claude, codex");
  });

  test("--dry-run prints the plan, creates nothing, and exits 0", () => {
    const { dir, path } = tempWorkflow(`
name: cli-dry
nodes:
  - id: a
    prompt: "hello {{task}}"
  - id: b
    depends_on: [a]
    bash: "echo {{nodes.a.output}}"
`);
    gitify(dir);
    const result = runCli(["run", path, "the", "task", "--dry-run"], dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry run: cli-dry — 2 nodes, nothing executes");
    expect(result.stdout).toContain("prompt: hello the task");
    expect(result.stdout).toContain("bash: echo <output of a>");
    expect(existsSync(join(dir, ".sao"))).toBe(false); // no run dir, no worktree, no exclude edit
  });

  test("--auto-open-pr conflicts with --no-worktree, like --base/--branch", () => {
    const { dir, path } = tempWorkflow(`
name: cli-pr-conflict
nodes:
  - id: a
    bash: "true"
`);
    const result = runCli(["run", path, "--no-worktree", "--auto-open-pr"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--auto-open-pr has no effect with --no-worktree");
    expect(existsSync(join(dir, ".sao"))).toBe(false);
  });

  test("surfaces hints for invalid workflows", () => {
    const { path } = tempWorkflow(`
name: badref
nodes:
  - id: a
    bash: "true"
  - id: b
    bash: "echo {{nodes.a.output}}"
`);
    const result = runCli(["validate", path]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not depend on");
    expect(result.stderr).toContain("hint:");
  });
});

describe("sao run gates (real stdin)", () => {
  test("an approval typed on stdin lets the run succeed", () => {
    const { dir, path } = tempWorkflow(`
name: gate-stdin
nodes:
  - id: ship
    gate:
      message: "Ship it?"
  - id: after
    depends_on: [ship]
    bash: "echo shipped"
`);
    const result = spawnSync("bun", ["run", CLI, "run", path, "--no-worktree"], { cwd: dir, encoding: "utf8", input: "a\n", timeout: 30000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Ship it?");
    expect(result.stdout).toContain("succeeded");
  });

  test("EOF on stdin fails the gate (exit 1) instead of silently exiting 0", () => {
    const { dir, path } = tempWorkflow(`
name: gate-eof
nodes:
  - id: ship
    gate:
      message: "Ship it?"
`);
    // input: "" closes stdin immediately — the CI / `< /dev/null` case.
    const result = spawnSync("bun", ["run", CLI, "run", path, "--no-worktree"], { cwd: dir, encoding: "utf8", input: "", timeout: 30000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stdin closed");
  });

  test("one pipe chunk carrying replies for two prompts answers both (process-lifetime readline)", () => {
    // Both replies arrive in a single chunk. A per-prompt readline used to discard
    // the second line with the first interface; the process-lifetime readline
    // buffers it and the second gate consumes it.
    const { dir, path } = tempWorkflow(`
name: gate-two
nodes:
  - id: first
    gate:
      message: "First?"
  - id: second
    depends_on: [first]
    gate:
      message: "Second?"
`);
    const result = spawnSync("bun", ["run", CLI, "run", path, "--no-worktree"], { cwd: dir, encoding: "utf8", input: "a\na\n", timeout: 30000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ first");
    expect(result.stdout).toContain("✓ second");
    expect(result.stdout).toContain("succeeded");
  });

  test("piped replies still fail loudly when there are fewer replies than prompts", () => {
    const { dir, path } = tempWorkflow(`
name: gate-short
nodes:
  - id: first
    gate:
      message: "First?"
  - id: second
    depends_on: [first]
    gate:
      message: "Second?"
`);
    const result = spawnSync("bun", ["run", CLI, "run", path, "--no-worktree"], { cwd: dir, encoding: "utf8", input: "a\n", timeout: 30000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("✓ first"); // the first gate did approve
    expect(result.stderr).toContain("stdin closed");
  });

  test("a rejection typed on stdin halts the run as rejected", () => {
    const { dir, path } = tempWorkflow(`
name: gate-stdin-reject
nodes:
  - id: ship
    gate:
      message: "Ship it?"
`);
    const result = spawnSync("bun", ["run", CLI, "run", path, "--no-worktree"], { cwd: dir, encoding: "utf8", input: "r\n", timeout: 30000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rejected at node "ship"');
  });
});

describe("sao run", () => {
  test("executes a bash-only workflow end to end", () => {
    const { dir, path } = tempWorkflow(`
name: cli-e2e
nodes:
  - id: one
    bash: "echo first"
  - id: two
    depends_on: [one]
    bash: "echo got {{nodes.one.output}}"
`);
    const result = runCli(["run", path, "--no-worktree"], dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("succeeded");
    expect(result.stdout).toContain("got first");
    expect(existsSync(join(dir, ".sao", "runs"))).toBe(true);
  });

  test("propagates node failure as exit code 1 with the failing node named", () => {
    const { dir, path } = tempWorkflow(`
name: cli-fail
nodes:
  - id: boom
    bash: "exit 7"
`);
    const result = runCli(["run", path, "--no-worktree"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed at node "boom"');
  });

  test("joins task words and applies repeated --var values", () => {
    const { dir, path } = tempWorkflow(`
name: cli-task
inputs:
  - name: one
    required: true
  - name: two
    required: true
nodes:
  - id: a
    bash: "echo \\"task=[{{task}}] one=[{{one}}] two=[{{two}}]\\""
`);
    const result = runCli(["run", path, "add", "dark", "mode", "--no-worktree", "--var", "one=x", "--var", "two=y"], dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("task=[add dark mode] one=[x] two=[y]");
  });

  test(
    "SIGINT persists state.json as failed instead of leaving it running",
    async () => {
      const { dir, path } = tempWorkflow(`
name: cli-sigint
nodes:
  - id: slow
    bash: "sleep 30"
`);
      const child = spawn("bun", ["run", CLI, "run", path, "--no-worktree"], { cwd: dir, stdio: "ignore" });
      const runsDir = join(dir, ".sao", "runs");
      const findRunningState = (): string | undefined => {
        if (!existsSync(runsDir)) return undefined;
        const run = readdirSync(runsDir)[0];
        if (!run) return undefined;
        const file = join(runsDir, run, "state.json");
        try {
          return JSON.parse(readFileSync(file, "utf8")).nodes.slow.status === "running" ? file : undefined;
        } catch {
          return undefined; // state.json missing or mid-write
        }
      };

      let stateFile: string | undefined;
      for (let i = 0; i < 100 && !stateFile; i++) {
        await new Promise((r) => setTimeout(r, 100));
        stateFile = findRunningState();
      }
      expect(stateFile).toBeDefined();

      child.kill("SIGINT");
      await new Promise((r) => child.once("exit", r));
      const saved = JSON.parse(readFileSync(stateFile!, "utf8"));
      expect(saved.status).toBe("failed");
      expect(saved.nodes.slow.status).toBe("failed");
    },
    20000,
  );

  test("rejects --var __proto__ as an unknown input instead of silently dropping it", () => {
    const { dir, path } = tempWorkflow(`
name: cli-proto
nodes:
  - id: a
    bash: "true"
`);
    const result = runCli(["run", path, "--no-worktree", "--var", "__proto__=x"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown input "__proto__"');
  });

  test("rejects malformed --var pairs", () => {
    const { dir, path } = tempWorkflow(`
name: cli-var
nodes:
  - id: a
    bash: "true"
`);
    const result = runCli(["run", path, "--no-worktree", "--var", "noequals"], dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("key=value");
  });

  test("reports unknown runners before doing any work", () => {
    const { dir, path } = tempWorkflow(`
name: cli-runner
nodes:
  - id: a
    prompt: "hi"
`);
    const result = runCli(["run", path, "--no-worktree", "--runner", "nope"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown runner "nope"');
    expect(existsSync(join(dir, ".sao"))).toBe(false);
  });

  test("outside a git repo, the worktree default fails with the --no-worktree hint", () => {
    const { dir, path } = tempWorkflow(`
name: cli-nogit
nodes:
  - id: a
    bash: "true"
`);
    const result = runCli(["run", path], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a git repository");
    expect(result.stderr).toContain("--no-worktree");
  });

  test("--base/--branch conflict with --no-worktree", () => {
    const { dir, path } = tempWorkflow(`
name: cli-conflict
nodes:
  - id: a
    bash: "true"
`);
    const result = runCli(["run", path, "--no-worktree", "--branch", "x"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--base/--branch have no effect with --no-worktree");
  });
});

describe("sao run in a worktree + resume/list/logs/clean", () => {
  test("the full M3 lifecycle works end to end", () => {
    const { dir, path } = tempWorkflow(FLAKY_YAML);
    gitify(dir);

    // 1. run: fails at "flaky", pointing at resume
    const first = runCli(["run", path], dir);
    expect(first.status).toBe(1);
    expect(first.stderr).toContain('failed at node "flaky"');
    expect(first.stderr).toContain("resume with: sao resume");
    const runId = readdirSync(join(dir, ".sao", "runs"))[0]!;

    // 2. list: shows the failed run
    const list = runCli(["list"], dir);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(runId);
    expect(list.stdout).toContain("failed");

    // 3. resume: succeeds in the same worktree
    const resumed = runCli(["resume", runId], dir);
    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toContain("↷ ok (already succeeded)");
    expect(resumed.stdout).toContain(`✓ run ${runId} succeeded`);

    // 4. logs: dependency-ordered dump, first attempt's evidence preserved
    const logs = runCli(["logs", runId], dir);
    expect(logs.status).toBe(0);
    expect(logs.stdout).toContain("── ok.log ──");
    expect(logs.stdout).toContain("fine");
    const nodeLogs = runCli(["logs", runId, "ghost"], dir);
    expect(nodeLogs.status).toBe(1);
    expect(nodeLogs.stderr).toContain('no logs for node "ghost"');

    // 5. clean: removes the (finalized) worktree; the unmerged branch is kept
    const clean = runCli(["clean"], dir);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("cleaned: 1 worktrees, 0 branches, 0 run dirs (kept 1 unmerged branches)");
    expect(existsSync(join(dir, ".sao", "worktrees", runId))).toBe(false);
    expect(git(dir, "branch", "--list", `sao/${runId}`)).not.toBe(""); // the finalize commit is only here

    // 6. after merging, clean deletes the branch too
    git(dir, "merge", "-q", `sao/${runId}`);
    const cleanMerged = runCli(["clean"], dir);
    expect(cleanMerged.stdout).toContain("cleaned: 0 worktrees, 1 branches, 0 run dirs");
    expect(git(dir, "branch", "--list", `sao/${runId}`)).toBe("");

    // 7. resume after clean: refuses (already succeeded)
    const again = runCli(["resume", runId], dir);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already succeeded");
  }, 30000); // 9 spawned CLI subprocesses ride well past bun's 5s default under load

  test("resume refuses a changed workflow without --force and honors it with", () => {
    const { dir, path } = tempWorkflow(FLAKY_YAML);
    runCli(["run", path, "--no-worktree"], dir);
    const runId = readdirSync(join(dir, ".sao", "runs"))[0]!;
    writeFileSync(path, readFileSync(path, "utf8") + "# edited\n");

    const refused = runCli(["resume", runId], dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("configuration changed");
    expect(refused.stderr).toContain("--force");

    const forced = runCli(["resume", runId, "--force"], dir);
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain("succeeded");
  }, 30000); // 3 spawned CLI subprocesses — same load headroom as the lifecycle test

  test("resume rejects unknown and malformed run ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "sao-cli-"));
    const unknown = runCli(["resume", "2020-01-01-0000-ghost-0000"], dir);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("run not found");
    const traversal = runCli(["resume", "../../etc"], dir);
    expect(traversal.status).toBe(1);
    expect(traversal.stderr).toContain("invalid run id");
  }, 30000); // 2 spawned CLI subprocesses — same load headroom as the lifecycle test

  test("list with no runs says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "sao-cli-"));
    const result = runCli(["list"], dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no runs found");
  });
});
