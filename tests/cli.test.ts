import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
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
name: codex-early
defaults:
  runner: codex
nodes:
  - id: a
    prompt: "hi"
`);
    const result = runCli(["validate", path]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node "a": unknown runner "codex"');
    expect(result.stderr).toContain("M4");
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
    const result = runCli(["run", path], dir);
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
    const result = runCli(["run", path], dir);
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
    const result = runCli(["run", path, "add", "dark", "mode", "--var", "one=x", "--var", "two=y"], dir);
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
      const child = spawn("bun", ["run", CLI, "run", path], { cwd: dir, stdio: "ignore" });
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
    const result = runCli(["run", path, "--var", "__proto__=x"], dir);
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
    const result = runCli(["run", path, "--var", "noequals"], dir);
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
    const result = runCli(["run", path, "--runner", "nope"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown runner "nope"');
    expect(existsSync(join(dir, ".sao"))).toBe(false);
  });
});
