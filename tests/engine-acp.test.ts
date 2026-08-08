import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightAiConfigs, preflightRunnerEnvironments, runWorkflow } from "../src/engine";
import { SaoError } from "../src/errors";
import { loadWorkflow } from "../src/parser";
import type { Runner, RunnerNeeds, RunnerRequest } from "../src/runners/types";

const quiet = () => {};

function setup(yaml: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "sao-engine-acp-"));
  const path = join(dir, "workflow.yaml");
  writeFileSync(path, yaml);
  return { dir, path };
}

function run(path: string, dir: string, extra: Partial<Parameters<typeof runWorkflow>[0]> = {}): ReturnType<typeof runWorkflow> {
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

/** Async preflight double: never spawns a real process, mirrors the ACP handshake shape. */
function mockAcpRunner(preflight: (needs: RunnerNeeds) => void | Promise<void>): Runner {
  return {
    name: "mockacp",
    preflight,
    run: async () => ({ output: "done <promise>DONE</promise>", sessionId: "s1", exitCode: 0 }),
  };
}

const RESUME_LOOP = `
name: capability
nodes:
  - id: fix
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 3
      fresh_context: false
`;

describe("preflightRunnerEnvironments", () => {
  test("@s-capability-gap-preflight: a capability the agent does not advertise fails preflight before any node executes", async () => {
    const { dir, path } = setup(RESUME_LOOP);
    const runner = mockAcpRunner((needs) => {
      if (needs.needsSessionResume) throw new SaoError("mockacp does not advertise session loading", "drop fresh_context");
    });
    await expect(run(path, dir, { resolveRunner: () => runner })).rejects.toThrow("mockacp does not advertise session loading");
    expect(existsSync(join(dir, ".sao"))).toBe(false);
  });

  test("@s-capability-present-passes: an advertised capability lets the run proceed", async () => {
    const { dir, path } = setup(RESUME_LOOP);
    const runner = mockAcpRunner(() => {}); // never throws: capability present
    const state = await run(path, dir, { resolveRunner: () => runner });
    expect(state.nodes["fix"]!.status).toBe("succeeded");
  });

  test("@s-validate-performs-handshake: the same preflight call validate makes surfaces the capability gap without running anything", async () => {
    const { dir, path } = setup(RESUME_LOOP);
    const runner = mockAcpRunner((needs) => {
      if (needs.needsSessionResume) throw new SaoError("mockacp does not advertise session loading", "drop fresh_context");
    });
    const workflow = loadWorkflow(path, { cwd: dir });
    const configs = preflightAiConfigs(workflow, undefined, () => runner);
    await expect(preflightRunnerEnvironments(workflow, configs)).rejects.toThrow("mockacp does not advertise session loading");
  });

  test("@s-handshake-once-per-runner: the handshake happens once per distinct runner, not once per node", async () => {
    const { dir, path } = setup(`
name: onceperrunner
nodes:
  - id: a
    prompt: "one"
  - id: b
    depends_on: [a]
    prompt: "two"
  - id: c
    depends_on: [b]
    prompt: "three"
`);
    let probes = 0;
    const runner = mockAcpRunner(async () => {
      probes++;
      await Promise.resolve();
    });
    await run(path, dir, { resolveRunner: () => runner });
    expect(probes).toBe(1);
  });

  test("@s-handshake-failure-preflight: a binary that does not speak ACP fails preflight naming the agent and the failed handshake", async () => {
    const { dir, path } = setup(`
name: handshakefail
nodes:
  - id: a
    prompt: "hi"
`);
    const runner = mockAcpRunner(() => {
      throw new SaoError("mockacp failed the ACP handshake", "check the binary is up to date");
    });
    await expect(run(path, dir, { resolveRunner: () => runner })).rejects.toThrow("mockacp failed the ACP handshake");
    expect(existsSync(join(dir, ".sao"))).toBe(false);
  });

  test("@s-mcp-unsupported-transport-preflight: an MCP transport the agent cannot take fails preflight before any node executes", async () => {
    const { dir, path } = setup(`
name: mcptransport
mcp:
  docs:
    url: https://example.com/mcp
nodes:
  - id: a
    prompt: "hi"
`);
    const runner = mockAcpRunner((needs) => {
      if (needs.mcpTransports?.includes("http")) throw new SaoError("mockacp does not support the http MCP transport");
    });
    await expect(run(path, dir, { resolveRunner: () => runner })).rejects.toThrow("mockacp does not support the http MCP transport");
    expect(existsSync(join(dir, ".sao"))).toBe(false);
  });

  test("workflow mcp: servers given as a path are read for the same transport check as inline servers", async () => {
    const { dir, path } = setup(`
name: mcptransportpath
mcp: ./mcp.json
nodes:
  - id: a
    prompt: "hi"
`);
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "https://example.com/mcp", type: "sse" } } }));
    let seenTransports: string[] = [];
    const runner = mockAcpRunner((needs) => {
      seenTransports = needs.mcpTransports ?? [];
    });
    await run(path, dir, { resolveRunner: () => runner });
    expect(seenTransports).toEqual(["sse"]);
  });

  test("no mcp: block: mcpTransports is empty", async () => {
    const { dir, path } = setup(`
name: nomcp
nodes:
  - id: a
    prompt: "hi"
`);
    let seenTransports: string[] = [];
    const runner = mockAcpRunner((needs) => {
      seenTransports = needs.mcpTransports ?? [];
    });
    await run(path, dir, { resolveRunner: () => runner });
    expect(seenTransports).toEqual([]);
  });
});

describe("permission-prompt plumbing", () => {
  test("the engine passes the owning node id and its terminal prompt function to the runner", async () => {
    const { dir, path } = setup(`
name: plumbing
nodes:
  - id: fix
    prompt: "go"
`);
    const calls: RunnerRequest[] = [];
    const runner: Runner = {
      name: "mockacp",
      async run(req) {
        calls.push(req);
        return { output: "done", exitCode: 0 };
      },
    };
    const promptUser = async (message: string) => message;
    await run(path, dir, { resolveRunner: () => runner, promptUser });
    expect(calls[0]!.nodeId).toBe("fix");
    expect(calls[0]!.promptUser).toBe(promptUser);
  });
});

describe("@s-existing-runners-unaffected", () => {
  test.each(["claude", "codex"])("%s: preflightRunnerEnvironments performs only the existing binary check", async (runnerName) => {
    const { dir, path } = setup(`
name: unaffected
nodes:
  - id: a
    runner: ${runnerName}
    prompt: "hi"
`);
    const workflow = loadWorkflow(path, { cwd: dir });
    const configs = preflightAiConfigs(workflow);
    await expect(preflightRunnerEnvironments(workflow, configs)).resolves.toBeUndefined();
  });
});
