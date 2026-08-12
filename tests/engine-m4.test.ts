import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftPrTitle, formatDryRun, lastAiNodeOutput, preflightAiConfigs, runWorkflow } from "../src/engine";
import { SaoError } from "../src/errors";
import { loadWorkflow, orderNodes } from "../src/parser";
import type { Runner, RunnerRequest } from "../src/runners/types";
import { loadRun } from "../src/state";

const quiet = () => {};

function setup(yaml: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "sao-m4-"));
  const path = join(dir, "workflow.yaml");
  writeFileSync(path, yaml);
  return { dir, path };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Turn a plain temp dir into a git repo (branch main, one commit). */
function gitify(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
}

/** A bare repo registered as `origin` of dir; returns the bare repo's path. */
function addBareOrigin(dir: string): string {
  const bare = mkdtempSync(join(tmpdir(), "sao-m4-origin-"));
  git(bare, "init", "-q", "--bare");
  git(dir, "remote", "add", "origin", bare);
  return bare;
}

/**
 * Put a fake `gh` first on PATH that records argv + stdin body under its own dir
 * and prints noise plus a PR URL. Returns paths and a restore function.
 */
function withStubGh(script?: string): { argsFile: string; bodyFile: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sao-m4-gh-"));
  const argsFile = join(dir, "gh-args.txt");
  const bodyFile = join(dir, "gh-body.txt");
  writeFileSync(
    join(dir, "gh"),
    script ??
      `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
cat > "${bodyFile}"
echo "Creating pull request for x into main"
echo "https://github.com/example/repo/pull/7"
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  return { argsFile, bodyFile, restore: () => (process.env.PATH = oldPath) };
}

function scriptedRunner(script: string[]): () => Runner {
  let call = 0;
  const runner: Runner = {
    name: "scripted",
    async run(_req: RunnerRequest) {
      const output = script[Math.min(call, script.length - 1)]!;
      call++;
      return { output, exitCode: 0 };
    },
  };
  return () => runner;
}

function run(
  path: string,
  dir: string,
  extra: Partial<Parameters<typeof runWorkflow>[0]> = {},
): ReturnType<typeof runWorkflow> {
  return runWorkflow({
    workflow: loadWorkflow(path, { cwd: dir }),
    workflowPath: path,
    task: "",
    vars: {},
    cwd: dir,
    print: quiet,
    ...extra,
  });
}

const FAIL_ONCE = "test -f marker || { touch marker; echo first-try >&2; exit 1; }";

describe("draftPrTitle", () => {
  test("workflow name and task compose the title; whitespace collapses", () => {
    expect(draftPrTitle("fix-bug", "handle  Feb\n29 crash ")).toBe("fix-bug: handle Feb 29 crash");
  });

  test("no task: the workflow name stands alone", () => {
    expect(draftPrTitle("nightly-cleanup", "")).toBe("sao: nightly-cleanup");
    expect(draftPrTitle("nightly-cleanup", "  \n ")).toBe("sao: nightly-cleanup");
  });
});

describe("lastAiNodeOutput", () => {
  test("the LAST ai/loop output in dependency order wins; bash and empty outputs are ignored", () => {
    const { dir, path } = setup(`
name: body-pick
nodes:
  - id: first
    prompt: "a"
  - id: shell
    depends_on: [first]
    bash: "true"
  - id: second
    depends_on: [shell]
    loop:
      prompt: "b"
      until: DONE
      max_iterations: 2
  - id: silent
    depends_on: [second]
    prompt: "c"
`);
    const workflow = loadWorkflow(path, { cwd: dir });
    const ordered = orderNodes(workflow);
    expect(
      lastAiNodeOutput(ordered, {
        first: { status: "succeeded", output: "ai one" },
        shell: { status: "succeeded", output: "bash noise" },
        second: { status: "succeeded", output: "loop verdict" },
        silent: { status: "skipped", output: "" },
      }),
    ).toBe("loop verdict");
    expect(lastAiNodeOutput(ordered, { shell: { status: "succeeded", output: "bash noise" } })).toBeUndefined();
    // Whitespace-only output is as silent as no output — it must not become a PR body.
    expect(lastAiNodeOutput(ordered, { first: { status: "succeeded", output: "  \n\t" } })).toBeUndefined();
  });
});

describe("fresh_context × codex validation", () => {
  const LOOP = `
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 3
      fresh_context: false
`;

  test("workflow defaults.runner codex is rejected at load+preflight, with the fix in the hint", () => {
    const { dir, path } = setup(`
name: bad-defaults
defaults:
  runner: codex
nodes:
  - id: fix
${LOOP}`);
    try {
      preflightAiConfigs(loadWorkflow(path, { cwd: dir }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toBe('node "fix": the codex runner cannot resume sessions');
      expect((err as SaoError).hint).toBe(
        "fresh_context: false requires session resume — use the claude runner, or drop fresh_context",
      );
    }
  });

  test("node-level runner, agent frontmatter runner, and --runner override are all caught", () => {
    const { dir, path } = setup(`
name: bad-node
nodes:
  - id: fix
    runner: codex
${LOOP}`);
    expect(() => preflightAiConfigs(loadWorkflow(path, { cwd: dir }))).toThrow("cannot resume sessions");

    const viaAgent = setup(`
name: bad-agent
nodes:
  - id: fix
    agent: coder
${LOOP}`);
    mkdirSync(join(viaAgent.dir, ".agents", "agents"), { recursive: true });
    writeFileSync(join(viaAgent.dir, ".agents", "agents", "coder.md"), "---\nrunner: codex\n---\nYou code.\n");
    expect(() => preflightAiConfigs(loadWorkflow(viaAgent.path, { cwd: viaAgent.dir }))).toThrow(
      "cannot resume sessions",
    );

    const viaOverride = setup(`
name: bad-override
nodes:
  - id: fix
${LOOP}`);
    expect(() => preflightAiConfigs(loadWorkflow(viaOverride.path, { cwd: viaOverride.dir }), "codex")).toThrow(
      'node "fix": the codex runner cannot resume sessions',
    );
  });

  test("codex with fresh_context true and claude with false both pass", () => {
    const okCodex = setup(`
name: ok-codex
defaults:
  runner: codex
nodes:
  - id: fix
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 3
`);
    // A stub codex satisfies the binary preflight without the real CLI.
    const dir = mkdtempSync(join(tmpdir(), "sao-m4-stub-"));
    writeFileSync(join(dir, "codex"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "codex"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    try {
      expect(() => preflightAiConfigs(loadWorkflow(okCodex.path, { cwd: okCodex.dir }))).not.toThrow();
    } finally {
      process.env.PATH = oldPath;
    }

    const okClaude = setup(`
name: ok-claude
nodes:
  - id: fix
${LOOP}`);
    expect(() => preflightAiConfigs(loadWorkflow(okClaude.path, { cwd: okClaude.dir }))).not.toThrow();
  });
});

describe("--auto-open-pr", () => {
  test("pushes the branch and opens a draft PR titled from name/task, body from the last AI output", async () => {
    const { dir, path } = setup(`
name: pr-flow
nodes:
  - id: think
    prompt: "produce the summary"
  - id: change
    depends_on: [think]
    bash: "echo made > artifact.txt"
`);
    gitify(dir);
    const bare = addBareOrigin(dir);
    const gh = withStubGh();
    try {
      const lines: string[] = [];
      const state = await run(path, dir, {
        task: "wire the thing",
        worktree: {},
        autoOpenPr: true,
        resolveRunner: scriptedRunner(["## What changed\nEverything."]),
        print: (l) => lines.push(l),
      });
      expect(state.status).toBe("succeeded");
      expect(state.autoOpenPr).toBe(true);
      expect(lines.join("\n")).toContain("pr:       https://github.com/example/repo/pull/7 (draft)");
      expect(lines.join("\n")).not.toContain("gh pr create --head"); // the manual hint is replaced

      const ghArgs = readFileSync(gh.argsFile, "utf8").split("\n");
      expect(ghArgs).toContain("pr");
      expect(ghArgs).toContain("create");
      expect(ghArgs).toContain("--draft");
      expect(ghArgs).toContain(`--head=${state.branch}`);
      expect(ghArgs).toContain("--title=pr-flow: wire the thing");
      expect(ghArgs).toContain("--body-file");
      expect(readFileSync(gh.bodyFile, "utf8")).toBe("## What changed\nEverything.");

      // The branch really arrived on origin before gh ran.
      expect(git(bare, "branch", "--list", state.branch!)).toContain(state.branch!);
    } finally {
      gh.restore();
    }
  });

  test("bash-only workflows fall back to a minimal body and the sao: title", async () => {
    const { dir, path } = setup(`
name: quiet-flow
nodes:
  - id: change
    bash: "echo made > artifact.txt"
`);
    gitify(dir);
    addBareOrigin(dir);
    const gh = withStubGh();
    try {
      const state = await run(path, dir, { worktree: {}, autoOpenPr: true });
      expect(readFileSync(gh.bodyFile, "utf8")).toBe(`sao run ${state.id} (workflow quiet-flow)`);
      expect(readFileSync(gh.argsFile, "utf8")).toContain("--title=sao: quiet-flow");
    } finally {
      gh.restore();
    }
  });

  test("a failing push downgrades to a warning, keeps the run succeeded, and never reaches gh", async () => {
    const { dir, path } = setup(`
name: push-fail
nodes:
  - id: change
    bash: "echo made > artifact.txt"
`);
    gitify(dir); // no origin remote at all
    const gh = withStubGh();
    try {
      const lines: string[] = [];
      const state = await run(path, dir, { worktree: {}, autoOpenPr: true, print: (l) => lines.push(l) });
      expect(state.status).toBe("succeeded");
      const output = lines.join("\n");
      expect(output).toContain(`⚠ auto-open-pr failed: git push failed for ${state.branch}`);
      expect(output).toContain("is an 'origin' remote configured and writable?");
      expect(output).toContain(`pr:       git push -u origin ${state.branch} && gh pr create --head ${state.branch}`);
      expect(existsSync(gh.argsFile)).toBe(false);
    } finally {
      gh.restore();
    }
  });

  test("a failing gh downgrades to a warning with gh's stderr in the hint", async () => {
    const { dir, path } = setup(`
name: gh-fail
nodes:
  - id: change
    bash: "echo made > artifact.txt"
`);
    gitify(dir);
    addBareOrigin(dir);
    const gh = withStubGh("#!/bin/sh\ncat > /dev/null\necho 'gh: Not authenticated' >&2\nexit 4\n");
    try {
      const lines: string[] = [];
      const state = await run(path, dir, { worktree: {}, autoOpenPr: true, print: (l) => lines.push(l) });
      expect(state.status).toBe("succeeded");
      const output = lines.join("\n");
      expect(output).toContain("⚠ auto-open-pr failed: gh pr create failed");
      expect(output).toContain("gh: Not authenticated");
      expect(output).toContain("is gh authenticated (gh auth status)");
      expect(output).toContain(`pr:       git push -u origin ${state.branch}`);
    } finally {
      gh.restore();
    }
  });

  test("resume inherits a recorded autoOpenPr and retries the PR", async () => {
    const { dir, path } = setup(`
name: pr-resume
nodes:
  - id: flaky
    bash: "${FAIL_ONCE}"
`);
    gitify(dir);
    addBareOrigin(dir);
    const gh = withStubGh();
    try {
      await run(path, dir, { worktree: {}, autoOpenPr: true }).catch(() => {});
      const loaded = loadRun(dir, loadRunId(dir));
      expect(loaded.state.autoOpenPr).toBe(true); // persisted before the failure
      expect(existsSync(gh.argsFile)).toBe(false); // failed runs never open PRs

      const lines: string[] = [];
      const state = await run(path, dir, { resume: loaded, print: (l) => lines.push(l) }); // no flag: inherited
      expect(state.status).toBe("succeeded");
      expect(existsSync(gh.argsFile)).toBe(true);
      expect(lines.join("\n")).toContain("pull/7 (draft)");
    } finally {
      gh.restore();
    }
  });

  test("resume --auto-open-pr turns it on for a run that started without it", async () => {
    const { dir, path } = setup(`
name: pr-late
nodes:
  - id: flaky
    bash: "${FAIL_ONCE}"
`);
    gitify(dir);
    addBareOrigin(dir);
    const gh = withStubGh();
    try {
      await run(path, dir, { worktree: {} }).catch(() => {});
      expect(loadRun(dir, loadRunId(dir)).state.autoOpenPr).toBe(false);

      const state = await run(path, dir, { resume: loadRun(dir, loadRunId(dir)), autoOpenPr: true });
      expect(state.autoOpenPr).toBe(true);
      expect(loadRun(dir, loadRunId(dir)).state.autoOpenPr).toBe(true); // persisted for the next resume too
      expect(existsSync(gh.argsFile)).toBe(true);
    } finally {
      gh.restore();
    }
  });

  test("resume --auto-open-pr of an in-place run explains why nothing happens, without persisting", async () => {
    const { dir, path } = setup(`
name: pr-inplace
nodes:
  - id: flaky
    bash: "${FAIL_ONCE}"
`);
    const gh = withStubGh();
    try {
      await run(path, dir).catch(() => {});
      const lines: string[] = [];
      const state = await run(path, dir, {
        resume: loadRun(dir, loadRunId(dir)),
        autoOpenPr: true,
        print: (l) => lines.push(l),
      });
      expect(state.status).toBe("succeeded");
      const output = lines.join("\n");
      expect(output).toContain("⚠ --auto-open-pr ignored: this run has no branch (it ran with --no-worktree)");
      expect(output).not.toContain("auto-open-pr failed"); // explained, not attempted-and-crashed
      expect(state.autoOpenPr).toBe(false); // not persisted — a later resume would not re-warn
      expect(existsSync(gh.argsFile)).toBe(false);
    } finally {
      gh.restore();
    }
  });

  test("a fresh in-place run with the flag (engine API — the CLI blocks this) warns at success", async () => {
    const { dir, path } = setup(`
name: pr-inplace-fresh
nodes:
  - id: a
    bash: "true"
`);
    const gh = withStubGh();
    try {
      const lines: string[] = [];
      const state = await run(path, dir, { autoOpenPr: true, print: (l) => lines.push(l) });
      expect(state.status).toBe("succeeded");
      expect(lines.join("\n")).toContain(
        "⚠ --auto-open-pr ignored: this run has no branch (it ran with --no-worktree)",
      );
      expect(existsSync(gh.argsFile)).toBe(false);
    } finally {
      gh.restore();
    }
  });

  test("resume WITHOUT the flag leaves a flagless run off — no push, no gh, no warnings", async () => {
    const { dir, path } = setup(`
name: pr-off
nodes:
  - id: flaky
    bash: "${FAIL_ONCE}"
`);
    gitify(dir);
    const gh = withStubGh();
    try {
      await run(path, dir, { worktree: {} }).catch(() => {});
      const lines: string[] = [];
      const state = await run(path, dir, { resume: loadRun(dir, loadRunId(dir)), print: (l) => lines.push(l) });
      expect(state.status).toBe("succeeded");
      expect(state.autoOpenPr).toBe(false);
      expect(loadRun(dir, state.id).state.autoOpenPr).toBe(false);
      expect(lines.join("\n")).not.toContain("auto-open-pr");
      expect(existsSync(gh.argsFile)).toBe(false);
    } finally {
      gh.restore();
    }
  });

  test("a tampered state.branch is refused by the push guard, downgraded to a warning", async () => {
    const { dir, path } = setup(`
name: pr-tamper
nodes:
  - id: flaky
    bash: "${FAIL_ONCE}"
`);
    gitify(dir);
    addBareOrigin(dir);
    const gh = withStubGh();
    try {
      await run(path, dir, { worktree: {}, autoOpenPr: true }).catch(() => {});
      const runId = loadRunId(dir);
      const stateFile = join(dir, ".sao", "runs", runId, "state.json");
      const onDisk = JSON.parse(readFileSync(stateFile, "utf8"));
      onDisk.branch = "+sao/evil:main"; // force-refspec shape — must never reach git push
      writeFileSync(stateFile, JSON.stringify(onDisk, null, 2) + "\n");

      const lines: string[] = [];
      const state = await run(path, dir, { resume: loadRun(dir, runId), print: (l) => lines.push(l) });
      expect(state.status).toBe("succeeded"); // the PR step degrades, the run does not
      expect(lines.join("\n")).toContain("⚠ auto-open-pr failed: invalid branch name: +sao/evil:main");
      expect(existsSync(gh.argsFile)).toBe(false);
    } finally {
      gh.restore();
    }
  });

  test("a failed finalize SKIPS the PR — it would silently omit the uncommitted work", async () => {
    const { dir, path } = setup(`
name: pr-nofinalize
nodes:
  - id: change
    bash: "echo made > artifact.txt"
`);
    gitify(dir);
    const bare = addBareOrigin(dir);
    // Break the finalize commit only: no identity anywhere for THIS repo.
    git(dir, "config", "user.name", "");
    git(dir, "config", "user.email", "");
    const gh = withStubGh();
    try {
      const lines: string[] = [];
      const state = await run(path, dir, { worktree: {}, autoOpenPr: true, print: (l) => lines.push(l) });
      expect(state.status).toBe("succeeded");
      const output = lines.join("\n");
      expect(output).toContain("⚠ finalize commit failed");
      expect(output).toContain("⚠ auto-open-pr skipped: the finalize commit failed");
      expect(output).toContain(`pr:       git push -u origin ${state.branch}`); // manual fallback stays
      expect(existsSync(gh.argsFile)).toBe(false); // no PR…
      expect(git(bare, "for-each-ref", "refs/heads/")).toBe(""); // …and no push either
    } finally {
      gh.restore();
    }
  });

  test("a 64-hex sha256-repo base is still recognized as a SHA — gh gets no --base", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sao-m4-sha256-"));
    const path = join(dir, "workflow.yaml");
    writeFileSync(
      path,
      `
name: pr-sha256
nodes:
  - id: change
    bash: "echo made > artifact.txt"
`,
    );
    git(dir, "init", "-q", "-b", "main", "--object-format=sha256");
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "T");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    const bare = mkdtempSync(join(tmpdir(), "sao-m4-origin256-"));
    git(bare, "init", "-q", "--bare", "--object-format=sha256"); // the origin must share the object format
    git(dir, "remote", "add", "origin", bare);
    const gh = withStubGh();
    try {
      const state = await run(path, dir, { worktree: {}, autoOpenPr: true }); // base defaults to HEAD → 64-hex SHA
      expect(state.base).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(gh.argsFile, "utf8")).not.toContain("--base=");
    } finally {
      gh.restore();
    }
  });

  test("a worktree state whose branch was DELETED gets the no-branch warning, not a crash", async () => {
    const { dir, path } = setup(`
name: pr-nobranch
nodes:
  - id: flaky
    bash: "${FAIL_ONCE}"
`);
    gitify(dir);
    addBareOrigin(dir);
    const gh = withStubGh();
    try {
      await run(path, dir, { worktree: {}, autoOpenPr: true }).catch(() => {});
      const runId = loadRunId(dir);
      const stateFile = join(dir, ".sao", "runs", runId, "state.json");
      const onDisk = JSON.parse(readFileSync(stateFile, "utf8"));
      delete onDisk.branch; // worktree present, branch gone — one clause true, not both
      writeFileSync(stateFile, JSON.stringify(onDisk, null, 2) + "\n");

      const lines: string[] = [];
      const state = await run(path, dir, { resume: loadRun(dir, runId), print: (l) => lines.push(l) });
      expect(state.status).toBe("succeeded");
      const output = lines.join("\n");
      expect(output).toContain(
        "⚠ --auto-open-pr ignored: this run has no branch (state.json no longer records its branch)",
      );
      expect(output).not.toContain("--no-worktree"); // a worktree run — don't blame the wrong flag
      expect(output).not.toContain("auto-open-pr failed"); // never attempted with undefined argv
      expect(existsSync(gh.argsFile)).toBe(false);
    } finally {
      gh.restore();
    }
  });

  test("a run based on a NAMED ref targets the PR at it; a resolved-SHA base lets gh default", async () => {
    const { dir, path } = setup(`
name: pr-base
base: main
nodes:
  - id: change
    bash: "echo made > artifact.txt"
`);
    gitify(dir);
    addBareOrigin(dir);
    const gh = withStubGh();
    try {
      await run(path, dir, { worktree: {}, autoOpenPr: true });
      expect(readFileSync(gh.argsFile, "utf8").split("\n")).toContain("--base=main");
    } finally {
      gh.restore();
    }

    const sha = setup(`
name: pr-sha
nodes:
  - id: change
    bash: "echo made > artifact.txt"
`);
    gitify(sha.dir);
    addBareOrigin(sha.dir);
    const gh2 = withStubGh();
    try {
      await run(sha.path, sha.dir, { worktree: {}, autoOpenPr: true }); // base defaults to HEAD → a SHA
      expect(readFileSync(gh2.argsFile, "utf8")).not.toContain("--base=");
    } finally {
      gh2.restore();
    }
  });
});

function loadRunId(root: string): string {
  const runs = readdirSync(join(root, ".sao", "runs"));
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

describe("formatDryRun", () => {
  test("renders the full plan for a small workflow, byte for byte", async () => {
    const { dir, path } = setup(`
name: mini
base: main
inputs:
  - name: target
    default: prod
nodes:
  - id: plan
    prompt: "Plan {{task}} for {{target}} on {{branch}}"
  - id: apply
    depends_on: [plan, plan2]
    when_bash: "test -n '{{target}}'"
    bash: |-
      echo {{nodes.plan.output}}
      echo run {{run_id}}
  - id: plan2
    agent: coder
    prompt: "Second opinion on {{task}}"
`);
    gitify(dir);
    mkdirSync(join(dir, ".agents", "agents"), { recursive: true });
    writeFileSync(join(dir, ".agents", "agents", "coder.md"), "---\nmodel: sonnet\n---\nYou code.\n");
    const workflow = loadWorkflow(path, { cwd: dir });
    expect(
      await formatDryRun({ workflow, task: "the rollout", vars: {}, runRoot: dir, worktree: {}, autoOpenPr: true }),
    ).toEqual([
      "dry run: mini — 3 nodes, nothing executes",
      "isolation: worktree from base main, branch sao/<run-id>",
      "on success: push the branch and open a draft PR via gh (--auto-open-pr)",
      "task: the rollout",
      "",
      "1. plan  [ai · runner claude]",
      "   prompt: Plan the rollout for prod on sao/<run-id>",
      "",
      "2. plan2  [ai · runner claude · agent coder]",
      "   prompt: Second opinion on the rollout",
      "",
      "3. apply  [bash]  (after plan, plan2)",
      "   when_bash: test -n 'prod'",
      "   bash: echo <output of plan>",
      "         echo run <run-id>",
    ]);
  });

  test("a defaulted base resolves to the real HEAD SHA, matching what the run would record", async () => {
    const { dir, path } = setup(`
name: headbase
nodes:
  - id: a
    bash: "true"
`);
    gitify(dir);
    const lines = await formatDryRun({
      workflow: loadWorkflow(path, { cwd: dir }),
      task: "",
      vars: {},
      runRoot: dir,
      worktree: {},
    });
    expect(lines[1]).toMatch(/^isolation: worktree from base [0-9a-f]{40}, branch sao\/<run-id>$/);
    expect(lines).not.toContain("task: "); // empty task: no task line at all
    // Without --auto-open-pr the plan has exactly these five lines — no PR step.
    expect(lines[2]).toBe("");
    expect(lines).toHaveLength(5);
  });

  test("worktree-mode plans run the real git pre-checks — parity with run's failures", async () => {
    const { dir, path } = setup(`
name: checks
nodes:
  - id: a
    bash: "true"
`);
    const workflowNoRepo = loadWorkflow(path, { cwd: dir });
    await expect(
      formatDryRun({ workflow: workflowNoRepo, task: "", vars: {}, runRoot: dir, worktree: {} }),
    ).rejects.toThrow("not a git repository");
    gitify(dir);
    const workflow = loadWorkflow(path, { cwd: dir });
    await expect(
      formatDryRun({ workflow, task: "", vars: {}, runRoot: dir, worktree: { base: "no-such-ref" } }),
    ).rejects.toThrow("base ref not found: no-such-ref");
    await expect(
      formatDryRun({ workflow, task: "", vars: {}, runRoot: dir, worktree: { branch: "main" } }),
    ).rejects.toThrow("branch already exists: main");
    await expect(
      formatDryRun({ workflow, task: "", vars: {}, runRoot: dir, worktree: { branch: "+x" } }),
    ).rejects.toThrow("invalid branch name: +x");
    // A named branch that passes the checks is echoed verbatim.
    const lines = await formatDryRun({
      workflow,
      task: "",
      vars: {},
      runRoot: dir,
      worktree: { base: "main", branch: "feature/x" },
    });
    expect(lines[1]).toBe("isolation: worktree from base main, branch feature/x");
  });

  test("in-place plans render the empty base/branch the engine would actually provide", async () => {
    const { dir, path } = setup(`
name: inplace-meta
nodes:
  - id: a
    bash: "git diff [{{base}}]..[{{branch}}] in {{run_id}}"
`);
    const lines = await formatDryRun({
      workflow: loadWorkflow(path, { cwd: dir }),
      task: "",
      vars: {},
      runRoot: dir,
      autoOpenPr: true,
    });
    expect(lines).toContain("isolation: in place (--no-worktree)");
    expect(lines).toContain("   bash: git diff []..[] in <run-id>");
    expect(lines.join("\n")).not.toContain("on success: push"); // no worktree, no PR step even when asked
  });

  test("renders loops (prompt and steps), gates, agents, and until variants", async () => {
    const { dir, path } = setup(`
name: full
nodes:
  - id: fix
    agent: coder
    loop:
      prompt: "Iteration {{loop.iteration}}: fix. Feedback: [{{loop.feedback}}]"
      until: ALL_DONE
      max_iterations: 5
      interactive: true
  - id: verify
    depends_on: [fix]
    loop:
      steps:
        - prompt: "review it"
          agent: coder
        - when_bash: "test -f go"
          bash: "bun test"
        - prompt: "summarize, agentless"
      until_bash: "test -f done-{{run_id}}"
      max_iterations: 3
  - id: ship
    depends_on: [verify]
    gate:
      message: "Ship {{task}}?"
`);
    mkdirSync(join(dir, ".agents", "agents"), { recursive: true });
    writeFileSync(join(dir, ".agents", "agents", "coder.md"), "---\nmodel: sonnet\n---\nYou code.\n");
    const workflow = loadWorkflow(path, { cwd: dir });
    const lines = await formatDryRun({ workflow, task: "v2", vars: {}, runRoot: dir });
    expect(lines).toContain("isolation: in place (--no-worktree)");
    expect(lines).toContain("1. fix  [loop · runner claude · agent coder · until ALL_DONE · interactive · max 5]");
    expect(lines).toContain("   prompt: Iteration 1: fix. Feedback: []"); // truthful first-iteration context
    expect(lines).toContain("   (each iteration also carries the <promise>ALL_DONE</promise> sentinel instruction)");
    // Exactly one sentinel note: the until_bash loop must NOT grow a bogus one.
    expect(lines.filter((line) => line.includes("sentinel instruction"))).toHaveLength(1);
    expect(lines).toContain("2. verify  [loop · until_bash · max 3]  (after fix)");
    expect(lines).toContain("   until_bash: test -f done-<run-id>");
    expect(lines).toContain("   step 1  [ai · runner claude · agent coder]");
    expect(lines).toContain("     prompt: review it");
    expect(lines).toContain("   step 2  [bash]");
    expect(lines).toContain("     when_bash: test -f go");
    expect(lines).toContain("     bash: bun test");
    expect(lines).toContain("   step 3  [ai · runner claude]"); // no agent anywhere: no agent part
    expect(lines).toContain("3. ship  [gate]  (after verify)");
    expect(lines).toContain("   gate: Ship v2?");
  });

  test("shows the runner a --runner override would actually use", async () => {
    const { dir, path } = setup(`
name: override
nodes:
  - id: a
    prompt: "hi"
`);
    const stub = mkdtempSync(join(tmpdir(), "sao-m4-stub2-"));
    writeFileSync(join(stub, "codex"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(stub, "codex"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${stub}:${oldPath}`;
    try {
      const lines = await formatDryRun({
        workflow: loadWorkflow(path, { cwd: dir }),
        task: "",
        vars: {},
        runRoot: dir,
        runnerOverride: "codex",
      });
      expect(lines).toContain("1. a  [ai · runner codex]");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("an injected runner registry is honored — the plan names ITS runners", async () => {
    const { dir, path } = setup(`
name: injected
nodes:
  - id: a
    prompt: "hi"
`);
    const fake: Runner = { name: "fake-runner", run: async () => ({ output: "", exitCode: 0 }) };
    const lines = await formatDryRun({
      workflow: loadWorkflow(path, { cwd: dir }),
      task: "",
      vars: {},
      runRoot: dir,
      resolveRunner: () => fake,
    });
    expect(lines).toContain("1. a  [ai · runner fake-runner]");
  });

  test("run-parity checks still fire: missing required inputs and unknown runners fail", async () => {
    const { dir, path } = setup(`
name: strict
inputs:
  - name: ticket
    required: true
nodes:
  - id: a
    prompt: "{{ticket}}"
`);
    const workflow = loadWorkflow(path, { cwd: dir });
    try {
      await formatDryRun({ workflow, task: "", vars: {}, runRoot: dir });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe('missing required input "ticket"');
      expect((err as SaoError).hint).toBe("pass it with --var ticket=<value>"); // the RUN hint, not resume's
    }
    await expect(
      formatDryRun({ workflow, task: "", vars: { ticket: "T-1" }, runRoot: dir, runnerOverride: "nope" }),
    ).rejects.toThrow('unknown runner "nope"');
    expect(existsSync(join(dir, ".sao"))).toBe(false); // plans have no side effects
  });
});
