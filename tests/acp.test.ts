import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaoError } from "../src/errors";
import { composeAcpPrompt, runAcpHandshake, runAcpTurn } from "../src/acp";
import type { AcpLaunch } from "../src/acp";
import type { PromptUser } from "../src/gate";

/** Await a promise that must reject; returns the rejection error. */
async function rejectionOf(promise: Promise<unknown>): Promise<SaoError> {
  try {
    await promise;
  } catch (err) {
    return err as SaoError;
  }
  throw new Error("expected the promise to reject");
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A hand-rolled ACP agent speaking newline-delimited JSON-RPC directly (no
 * dependency on the ACP package itself), scripted per test via ACP_DOUBLE_SCRIPT.
 * Never the real opencode binary — hermetic like the existing runner tests.
 */
const DOUBLE_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const config = JSON.parse(process.env.ACP_DOUBLE_SCRIPT || "{}");
if (config.exitImmediately) process.exit(1);
if (process.env.ACP_DOUBLE_PIDFILE) fs.writeFileSync(process.env.ACP_DOUBLE_PIDFILE, String(process.pid));

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
function emitChunk(sessionId, chunk) {
  var content = { type: "text", text: chunk.text };
  var update;
  if (chunk.kind === "thought") {
    update = { sessionUpdate: "agent_thought_chunk", content: content };
  } else if (chunk.kind === "tool_call") {
    update = { sessionUpdate: "tool_call", toolCallId: chunk.toolCallId || "tc-1", title: chunk.text || "tool" };
  } else {
    update = { sessionUpdate: "agent_message_chunk", content: content };
  }
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sessionId, update: update } });
}
var permReqId = null;
var promptMsgId = null;
function handle(msg) {
  if (msg.method === "initialize") {
    if (config.hangInitialize) return;
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: config.agentCapabilities || {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: config.sessionId || "double-session" } });
  } else if (msg.method === "session/prompt") {
    if (config.hang) return;
    promptMsgId = msg.id;
    if (config.requestPermission) {
      permReqId = "perm-1";
      send({
        jsonrpc: "2.0",
        id: permReqId,
        method: "session/request_permission",
        params: { sessionId: config.sessionId || "double-session", options: config.requestPermission.options, toolCall: { toolCallId: "tc-1", title: config.requestPermission.title } },
      });
      return;
    }
    var chunks = config.chunks || [];
    if (config.echoPrompt) {
      var blocks = (msg.params && msg.params.prompt) || [];
      var text = blocks.map(function (b) { return b.text || ""; }).join("");
      chunks = [{ text: text }];
    } else if (config.echoCwd) {
      var cwdText = process.cwd();
      if (config.echoEnv) cwdText += " " + (process.env[config.echoEnv] || "");
      chunks = [{ text: cwdText }];
    }
    for (var i = 0; i < chunks.length; i++) emitChunk(config.sessionId || "double-session", chunks[i]);
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: config.stopReason || "end_turn" } });
    if (config.exitAfter) process.exit(0);
  } else if (msg.method === undefined && msg.id === permReqId) {
    send({ jsonrpc: "2.0", id: promptMsgId, result: { stopReason: "end_turn" } });
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

function withAcpDouble(config: Record<string, unknown>): { launch: AcpLaunch; env: Record<string, string>; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "sao-acp-double-"));
  const script = join(dir, "double.js");
  writeFileSync(script, DOUBLE_SCRIPT);
  const pidFile = join(dir, "pid");
  return {
    launch: { command: process.execPath, args: [script] },
    env: { ACP_DOUBLE_SCRIPT: JSON.stringify(config), ACP_DOUBLE_PIDFILE: pidFile },
    pidFile,
  };
}

describe("composeAcpPrompt", () => {
  test("no system prompt: the prompt is untouched", () => {
    expect(composeAcpPrompt({ prompt: "do it", cwd: "/tmp" })).toBe("do it");
  });

  test("system prompt becomes a role preamble separated from the task", () => {
    expect(composeAcpPrompt({ prompt: "do it", cwd: "/tmp", systemPrompt: "You are careful." })).toBe(
      "You are careful.\n\n---\n\ndo it",
    );
  });
});

describe("runAcpTurn", () => {
  test("@s-acp-stream-and-output: streams live text and captures the whole turn as output", async () => {
    const double = withAcpDouble({ sessionId: "sess-abc", chunks: [{ text: "Hello, " }, { text: "world." }] });
    const chunks: string[] = [];
    const result = await runAcpTurn(double.launch, {
      prompt: "hi",
      cwd: process.cwd(),
      env: double.env,
      onOutput: (c) => chunks.push(c),
    });
    expect(chunks.join("")).toBe("Hello, world.");
    expect(result.output).toBe("Hello, world.");
    expect(result.sessionId).toBe("sess-abc");
    expect(result.exitCode).toBe(0);
  });

  test("@s-acp-output-excludes-thoughts: reasoning and tool-call updates stay out of output and the stream", async () => {
    const double = withAcpDouble({
      chunks: [
        { kind: "thought", text: "let me think" },
        { text: "part one " },
        { kind: "tool_call", text: "running ls" },
        { text: "part two" },
      ],
    });
    const chunks: string[] = [];
    const result = await runAcpTurn(double.launch, { prompt: "hi", cwd: process.cwd(), env: double.env, onOutput: (c) => chunks.push(c) });
    expect(result.output).toBe("part one part two");
    expect(chunks.join("")).toBe("part one part two");
  });

  test("@s-acp-sentinel-ends-loop: successive turns each return their own isolated output", async () => {
    const first = withAcpDouble({ chunks: [{ text: "still working" }] });
    const second = withAcpDouble({ chunks: [{ text: "done ALL_TASKS_COMPLETE" }] });
    const r1 = await runAcpTurn(first.launch, { prompt: "iterate", cwd: process.cwd(), env: first.env });
    const r2 = await runAcpTurn(second.launch, { prompt: "iterate", cwd: process.cwd(), env: second.env });
    expect(r1.output).toBe("still working");
    expect(r2.output).toBe("done ALL_TASKS_COMPLETE");
  });

  test("@s-acp-refusal-fails-node: a refusal stop reason fails the turn even on a clean exit", async () => {
    const double = withAcpDouble({ chunks: [{ text: "I can't help with that" }], stopReason: "refusal", exitAfter: true });
    const err = await rejectionOf(runAcpTurn(double.launch, { prompt: "hi", cwd: process.cwd(), env: double.env }));
    expect(err).toBeInstanceOf(SaoError);
    expect(err.message).toContain("refused");
  });

  test(
    "@s-acp-timeout-kills: a hung turn times out, kills the process, and rejects naming the timeout",
    async () => {
      const double = withAcpDouble({ hang: true });
      const err = await rejectionOf(runAcpTurn(double.launch, { prompt: "hi", cwd: process.cwd(), env: double.env, timeoutSec: 1 }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toContain("timed out after 1s");

      const pid = Number(readFileSync(double.pidFile, "utf8"));
      let dead = false;
      for (let i = 0; i < 60; i++) {
        if (!isAlive(pid)) {
          dead = true;
          break;
        }
        await wait(50);
      }
      expect(dead).toBe(true);
    },
    15000,
  );

  test("delivers the composed system prompt to the agent over the protocol", async () => {
    const double = withAcpDouble({ echoPrompt: true });
    const result = await runAcpTurn(double.launch, { prompt: "do it", systemPrompt: "You are careful.", cwd: process.cwd(), env: double.env });
    expect(result.output).toBe("You are careful.\n\n---\n\ndo it");
  });

  test("runs the agent in the requested cwd with the request env merged over process.env", async () => {
    const double = withAcpDouble({ echoCwd: true, echoEnv: "SAO_RUN_ID" });
    const dir = mkdtempSync(join(tmpdir(), "sao-acp-cwd-"));
    const result = await runAcpTurn(double.launch, { prompt: "hi", cwd: dir, env: { ...double.env, SAO_RUN_ID: "run-77" } });
    expect(result.output).toBe(`${realpathSync(dir)} run-77`);
  });

  test("a process that exits before completing the handshake rejects instead of hanging", async () => {
    const double = withAcpDouble({ exitImmediately: true });
    const err = await rejectionOf(runAcpTurn(double.launch, { prompt: "hi", cwd: process.cwd(), env: double.env }));
    expect(err).toBeInstanceOf(SaoError);
  });

  test("a command that fails to spawn rejects with a SaoError", async () => {
    const missing = join(tmpdir(), "sao-definitely-does-not-exist-acp-binary");
    const err = await rejectionOf(runAcpTurn({ command: missing, args: [] }, { prompt: "hi", cwd: process.cwd() }));
    expect(err).toBeInstanceOf(SaoError);
    expect(err.message).toContain("failed to spawn");
  });
});

describe("runAcpTurn — the timeout clock pauses for a permission prompt (D5)", () => {
  test(
    "@s-timeout-paused-during-prompt: a human answering slower than timeoutSec does not time out the node",
    async () => {
      const double = withAcpDouble({ requestPermission: { title: "risky", options: [{ optionId: "opt-yes", name: "Yes", kind: "allow_once" }] } });
      const promptUser: PromptUser = () => new Promise((resolve) => setTimeout(() => resolve("1"), 1500));
      const result = await runAcpTurn(double.launch, {
        prompt: "hi",
        cwd: process.cwd(),
        env: double.env,
        timeoutSec: 1,
        nodeId: "n",
        promptUser,
      });
      expect(result.exitCode).toBe(0);
    },
    10000,
  );

  test(
    "@s-timeout-paused-while-queued: a prompt queued behind another's does not time out either, even once the total wait outlasts timeoutSec",
    async () => {
      const a = withAcpDouble({ requestPermission: { title: "task a", options: [{ optionId: "opt-a", name: "A", kind: "allow_once" }] } });
      const b = withAcpDouble({ requestPermission: { title: "task b", options: [{ optionId: "opt-b", name: "B", kind: "allow_once" }] } });
      // A single shared, hand-rolled serial queue (mirrors gate.ts's real one): the
      // second call's own 800ms wait only starts once the first settles, so by the
      // time it resolves, well over 1 second (b's timeoutSec) has elapsed overall.
      let queue: Promise<unknown> = Promise.resolve();
      const promptUser: PromptUser = () => {
        const turn = queue.then(() => new Promise<string>((resolve) => setTimeout(() => resolve("1"), 800)));
        queue = turn.then(
          () => undefined,
          () => undefined,
        );
        return turn;
      };
      const [ra, rb] = await Promise.all([
        runAcpTurn(a.launch, { prompt: "hi", cwd: process.cwd(), env: a.env, timeoutSec: 1, nodeId: "a", promptUser }),
        runAcpTurn(b.launch, { prompt: "hi", cwd: process.cwd(), env: b.env, timeoutSec: 1, nodeId: "b", promptUser }),
      ]);
      expect(ra.exitCode).toBe(0);
      expect(rb.exitCode).toBe(0);
    },
    10000,
  );
});

describe("runAcpHandshake", () => {
  test("resolves the agent's advertised capabilities without running a turn", async () => {
    const double = withAcpDouble({ agentCapabilities: { loadSession: true } });
    const capabilities = await runAcpHandshake(double.launch, { cwd: process.cwd(), env: double.env });
    expect(capabilities).toEqual({ loadSession: true });
  });

  test("a process that exits before completing the handshake rejects", async () => {
    const double = withAcpDouble({ exitImmediately: true });
    const err = await rejectionOf(runAcpHandshake(double.launch, { cwd: process.cwd(), env: double.env }));
    expect(err).toBeInstanceOf(SaoError);
    expect(err.message).toContain("handshake");
  });

  test(
    "a hung handshake times out, kills the process, and rejects naming the timeout",
    async () => {
      const double = withAcpDouble({ hangInitialize: true });
      const err = await rejectionOf(runAcpHandshake(double.launch, { cwd: process.cwd(), env: double.env, timeoutSec: 1 }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toContain("handshake");
      expect(err.message).toContain("1s");

      const pid = Number(readFileSync(double.pidFile, "utf8"));
      let dead = false;
      for (let i = 0; i < 60; i++) {
        if (!isAlive(pid)) {
          dead = true;
          break;
        }
        await wait(50);
      }
      expect(dead).toBe(true);
    },
    15000,
  );

  test("the handshake process does not outlive the call", async () => {
    const double = withAcpDouble({ agentCapabilities: {} });
    await runAcpHandshake(double.launch, { cwd: process.cwd(), env: double.env });
    const pid = Number(readFileSync(double.pidFile, "utf8"));
    let dead = false;
    for (let i = 0; i < 60; i++) {
      if (!isAlive(pid)) {
        dead = true;
        break;
      }
      await wait(50);
    }
    expect(dead).toBe(true);
  });
});
