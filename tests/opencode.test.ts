import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "../src/engine";
import { SaoError } from "../src/errors";
import { loadWorkflow } from "../src/parser";
import { opencodeRunner } from "../src/runners/opencode";
import { getRunner } from "../src/runners/types";

/** Await a promise that must reject; returns the rejection error. */
async function rejectionOf(promise: unknown): Promise<SaoError> {
  try {
    await promise;
  } catch (err) {
    return err as SaoError;
  }
  throw new Error("expected the promise to reject");
}

/**
 * A hand-rolled ACP agent double, spoken over stdio like tests/acp.test.ts's —
 * installed as an executable named "opencode" so preflight and run() find it via
 * PATH exactly like the real binary would. Only responds if invoked as `acp`
 * (proves the launch command), and echoes the received prompt when configured.
 */
const DOUBLE_SCRIPT = `#!/usr/bin/env node
const config = JSON.parse(process.env.ACP_DOUBLE_SCRIPT || "{}");
if (process.argv[2] !== "acp") process.exit(1);

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
var lastModel = "";
function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: config.agentCapabilities || {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "double-session" } });
  } else if (msg.method === "session/set_model") {
    lastModel = (msg.params && msg.params.modelId) || "";
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    var blocks = (msg.params && msg.params.prompt) || [];
    var text = config.echoPrompt ? blocks.map(function (b) { return b.text || ""; }).join("") : "ok";
    if (config.echoModel) text = lastModel;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "double-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
}
var buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (data) {
  buf += data;
  var lines = buf.split("\\n");
  buf = lines.pop();
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
`;

/** Put a fake `opencode` executable first on PATH; returns a restore function. */
function withStubOpencode(config: Record<string, unknown> = {}): () => void {
  const dir = mkdtempSync(join(tmpdir(), "sao-opencode-stub-"));
  const bin = join(dir, "opencode");
  writeFileSync(bin, DOUBLE_SCRIPT);
  chmodSync(bin, 0o755);
  const oldPath = process.env.PATH;
  const oldScript = process.env.ACP_DOUBLE_SCRIPT;
  process.env.PATH = `${dir}:${oldPath}`;
  process.env.ACP_DOUBLE_SCRIPT = JSON.stringify(config);
  return () => {
    process.env.PATH = oldPath;
    if (oldScript === undefined) delete process.env.ACP_DOUBLE_SCRIPT;
    else process.env.ACP_DOUBLE_SCRIPT = oldScript;
  };
}

describe("opencodeRunner", () => {
  test("is named opencode", () => {
    expect(opencodeRunner.name).toBe("opencode");
  });

  test("@s-opencode-missing-binary-preflight: preflight throws a SaoError naming the missing binary and an install hint", async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), "sao-no-opencode-"));
    try {
      const err = await rejectionOf(opencodeRunner.preflight!({ needsSessionResume: false }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toBe("opencode CLI not found on PATH");
      expect(err.hint).toContain("opencode");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("preflight passes when opencode is on PATH and no session resume is needed", async () => {
    const restore = withStubOpencode();
    try {
      await expect(opencodeRunner.preflight!({ needsSessionResume: false })).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  test("@s-capability-present-passes: preflight passes when the handshake advertises session loading", async () => {
    const restore = withStubOpencode({ agentCapabilities: { loadSession: true } });
    try {
      await expect(opencodeRunner.preflight!({ needsSessionResume: true })).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  test("@s-capability-gap-preflight: preflight rejects naming the agent and the missing capability", async () => {
    const restore = withStubOpencode({ agentCapabilities: {} });
    try {
      const err = await rejectionOf(opencodeRunner.preflight!({ needsSessionResume: true }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toContain("opencode");
      expect(err.message).toContain("session");
      expect(err.hint).toBe(
        "fresh_context: false requires session resume — drop fresh_context, or use a runner/agent version that supports it",
      );
    } finally {
      restore();
    }
  });

  test("@s-handshake-failure-preflight: a binary that does not speak ACP fails preflight naming the agent and the failed handshake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sao-opencode-nohandshake-"));
    const bin = join(dir, "opencode");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n"); // on PATH, but never speaks ACP
    chmodSync(bin, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    try {
      const err = await rejectionOf(opencodeRunner.preflight!({ needsSessionResume: false }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toContain("opencode");
      expect(err.message).toContain("handshake");
      // the real cause folds in, not a generic guess — matches every other adapter's error path
      expect(err.message).toContain("exited before completing the ACP handshake");
      expect(err.hint).toBe("the opencode CLI on PATH did not respond to initialize — check it is up to date");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("@s-mcp-unsupported-transport-preflight: preflight rejects naming the agent and the unsupported MCP transport", async () => {
    const restore = withStubOpencode({ agentCapabilities: { mcpCapabilities: {} } });
    try {
      const err = await rejectionOf(opencodeRunner.preflight!({ needsSessionResume: false, mcpTransports: ["http"] }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toContain("opencode");
      expect(err.message).toContain("http");
      expect(err.hint).toBe(
        "the workflow's mcp: block declares a http server — drop it, or use a runner/agent version that supports it",
      );
    } finally {
      restore();
    }
  });

  test("preflight passes when the handshake advertises the needed MCP transport", async () => {
    const restore = withStubOpencode({ agentCapabilities: { mcpCapabilities: { http: true } } });
    try {
      await expect(
        opencodeRunner.preflight!({ needsSessionResume: false, mcpTransports: ["http"] }),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  test("preflight rejects naming the sse MCP transport when the agent supports http but not sse", async () => {
    const restore = withStubOpencode({ agentCapabilities: { mcpCapabilities: { http: true } } });
    try {
      const err = await rejectionOf(opencodeRunner.preflight!({ needsSessionResume: false, mcpTransports: ["sse"] }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toContain("sse");
      expect(err.hint).toBe(
        "the workflow's mcp: block declares a sse server — drop it, or use a runner/agent version that supports it",
      );
    } finally {
      restore();
    }
  });

  test("preflight passes when the handshake advertises sse but not http, and sse is what's needed", async () => {
    const restore = withStubOpencode({ agentCapabilities: { mcpCapabilities: { sse: true } } });
    try {
      await expect(
        opencodeRunner.preflight!({ needsSessionResume: false, mcpTransports: ["sse"] }),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  test("preflight rejects when the agent advertises no mcpCapabilities at all and http is needed", async () => {
    const restore = withStubOpencode({ agentCapabilities: {} });
    try {
      const err = await rejectionOf(opencodeRunner.preflight!({ needsSessionResume: false, mcpTransports: ["http"] }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toContain("http");
    } finally {
      restore();
    }
  });

  test("preflight rejects when the agent advertises no mcpCapabilities at all and sse is needed", async () => {
    const restore = withStubOpencode({ agentCapabilities: {} });
    try {
      const err = await rejectionOf(opencodeRunner.preflight!({ needsSessionResume: false, mcpTransports: ["sse"] }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toContain("sse");
    } finally {
      restore();
    }
  });

  test("run() launches `opencode acp` and delegates the turn to the ACP client", async () => {
    const restore = withStubOpencode();
    try {
      const result = await opencodeRunner.run({ prompt: "hi", cwd: process.cwd() });
      expect(result.output).toBe("ok");
      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe("double-session");
    } finally {
      restore();
    }
  });

  test("@s-session-id-persisted: the run's persisted state records the opencode node's session id", async () => {
    const restore = withStubOpencode();
    try {
      const dir = mkdtempSync(join(tmpdir(), "sao-opencode-state-"));
      const path = join(dir, "workflow.yaml");
      writeFileSync(
        path,
        `
name: sessionpersist
nodes:
  - id: a
    runner: opencode
    prompt: "hi"
`,
      );
      const state = await runWorkflow({
        workflow: loadWorkflow(path, { cwd: dir }),
        workflowPath: path,
        task: "",
        vars: {},
        cwd: dir,
        print: () => {},
      });
      expect(state.nodes.a!.sessionId).toBe("double-session");
    } finally {
      restore();
    }
  });

  test("a wrong launch command (missing `acp`) fails the turn — pins the launch string", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sao-opencode-bad-"));
    const bin = join(dir, "opencode");
    writeFileSync(bin, "#!/bin/sh\nexit 1\n"); // never speaks ACP, whatever the args
    chmodSync(bin, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    try {
      await expect(opencodeRunner.run({ prompt: "hi", cwd: process.cwd() })).rejects.toThrow();
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("@s-opencode-agent-system-prompt: the agent file body reaches the ACP agent as the system prompt", async () => {
    const restore = withStubOpencode({ echoPrompt: true });
    try {
      const result = await opencodeRunner.run({
        prompt: "do it",
        systemPrompt: "Answer only with BANANA.",
        cwd: process.cwd(),
      });
      expect(result.output).toContain("Answer only with BANANA.");
    } finally {
      restore();
    }
  });

  test("@s-opencode-model-forwarded: run() forwards req.model via session/set_model", async () => {
    const restore = withStubOpencode({ echoModel: true });
    try {
      const result = await opencodeRunner.run({
        prompt: "hi",
        cwd: process.cwd(),
        model: "opencode-go/deepseek-v4-flash",
      });
      expect(result.output).toBe("opencode-go/deepseek-v4-flash");
    } finally {
      restore();
    }
  });

  test("@s-opencode-defaults-model-forwarded: a workflow's defaults.model reaches the ACP agent end-to-end", async () => {
    const restore = withStubOpencode({ echoModel: true });
    try {
      const dir = mkdtempSync(join(tmpdir(), "sao-opencode-model-"));
      const path = join(dir, "workflow.yaml");
      writeFileSync(
        path,
        `
name: modelfwd
defaults:
  runner: opencode
  model: opencode-go/deepseek-v4-flash
nodes:
  - id: a
    prompt: "hi"
`,
      );
      const state = await runWorkflow({
        workflow: loadWorkflow(path, { cwd: dir }),
        workflowPath: path,
        task: "",
        vars: {},
        cwd: dir,
        print: () => {},
      });
      expect(state.nodes.a!.output).toBe("opencode-go/deepseek-v4-flash");
    } finally {
      restore();
    }
  });

  test("@s-opencode-runner-selectable: the registry resolves opencode and it executes through the ACP client", async () => {
    const restore = withStubOpencode();
    try {
      const runner = getRunner("opencode");
      expect(runner.name).toBe("opencode");
      const result = await runner.run({ prompt: "hi", cwd: process.cwd() });
      expect(result.output).toBe("ok");
    } finally {
      restore();
    }
  });

  test("@s-runner-granularity-declared: opencodeRunner declares whole-turn final-output streaming", () => {
    expect(opencodeRunner.finalOutputStreaming).toBe("whole-turn");
  });
});
