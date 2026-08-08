import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaoError } from "../src/errors";
import { opencodeRunner } from "../src/runners/opencode";
import { getRunner } from "../src/runners/types";

/** Await a promise that must reject; returns the rejection error. */
async function rejectionOf(promise: void | Promise<unknown>): Promise<SaoError> {
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
function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: config.agentCapabilities || {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "double-session" } });
  } else if (msg.method === "session/prompt") {
    var blocks = (msg.params && msg.params.prompt) || [];
    var text = config.echoPrompt ? blocks.map(function (b) { return b.text || ""; }).join("") : "ok";
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
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("run() launches `opencode acp` and delegates the turn to the ACP client", async () => {
    const restore = withStubOpencode();
    try {
      const result = await opencodeRunner.run({ prompt: "hi", cwd: process.cwd() });
      expect(result.output).toBe("ok");
      expect(result.exitCode).toBe(0);
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
      const result = await opencodeRunner.run({ prompt: "do it", systemPrompt: "Answer only with BANANA.", cwd: process.cwd() });
      expect(result.output).toContain("Answer only with BANANA.");
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
});
