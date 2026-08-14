import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpLaunch } from "../src/acp";
import { runAcpTurn } from "../src/acp";
import type { Choice, PromptChoices } from "../src/gate";

/**
 * A hand-rolled ACP agent that requests permission mid-turn: on `session/prompt`
 * it sends `session/request_permission` and waits for the client's response
 * before finishing the turn — proving src/acp.ts's client-side wiring end to end,
 * without a dependency on any real agent binary.
 */
const DOUBLE_SCRIPT = `#!/usr/bin/env node
const config = JSON.parse(process.env.ACP_DOUBLE_SCRIPT || "{}");
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
const sessionId = "sess-1";
let permReqId = null;
let promptMsgId = null;
function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sessionId } });
  } else if (msg.method === "session/prompt") {
    promptMsgId = msg.id;
    permReqId = "perm-1";
    send({
      jsonrpc: "2.0",
      id: permReqId,
      method: "session/request_permission",
      params: { sessionId: sessionId, options: config.options, toolCall: { toolCallId: "tc-1", title: config.title } },
    });
  } else if (msg.method === undefined && msg.id === permReqId) {
    const outcome = msg.result.outcome;
    const text = outcome.outcome === "selected" ? "chosen:" + outcome.optionId : "cancelled";
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text } } } });
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

function withPermissionDouble(config: Record<string, unknown>): { launch: AcpLaunch; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "sao-acp-perm-double-"));
  const script = join(dir, "double.js");
  writeFileSync(script, DOUBLE_SCRIPT);
  return { launch: { command: process.execPath, args: [script] }, env: { ACP_DOUBLE_SCRIPT: JSON.stringify(config) } };
}

const OPTIONS = [
  { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
  { optionId: "opt-deny", name: "Deny", kind: "reject_once" },
];

describe("runAcpTurn — permission requests", () => {
  test("@s-perm-agent-options-listed: the list holds the node id, the tool call title, and one entry per option sent, in order, nothing invented", async () => {
    const double = withPermissionDouble({ title: "Write file foo.txt", options: OPTIONS });
    const seen: { message: string; choices: Choice[] }[] = [];
    const promptChoice: PromptChoices = async (req) => {
      seen.push(req);
      return { kind: "choice", id: "opt-allow" };
    };
    const logged: string[] = [];
    const result = await runAcpTurn(double.launch, {
      prompt: "do it",
      cwd: process.cwd(),
      env: double.env,
      nodeId: "write-node",
      promptChoice,
      onOutput: (c) => logged.push(c),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.message).toContain("write-node");
    expect(seen[0]!.message).toContain("Write file foo.txt");
    expect(seen[0]!.choices).toEqual([
      { id: "opt-allow", label: "Allow" },
      { id: "opt-deny", label: "Deny" },
    ]);
    expect(result.output).toBe("chosen:opt-allow");
    // The request/list/selection text rides the interactive prompt only — never
    // mirrored through onOutput too, matching the gate node's own prompt text,
    // which likewise never touches the node log (engine.ts's executeGate).
    expect(logged.join("")).not.toContain("Write file foo.txt");
    expect(logged.join("")).not.toContain("selected:");
  });

  test("@s-perm-selection-sent-verbatim: a chosen entry's id reaches the agent unchanged; sao remembers nothing about it", async () => {
    const double = withPermissionDouble({ title: "Run rm -rf", options: OPTIONS });
    const promptChoice: PromptChoices = async () => ({ kind: "choice", id: "opt-deny" });
    const result = await runAcpTurn(double.launch, {
      prompt: "do it",
      cwd: process.cwd(),
      env: double.env,
      nodeId: "n",
      promptChoice,
    });
    expect(result.output).toBe("chosen:opt-deny");
  });

  test("@s-perm-piped-index: a piped reply naming a valid 1-based index chooses the option at that position", async () => {
    const double = withPermissionDouble({ title: "Run rm -rf", options: OPTIONS });
    const promptChoice: PromptChoices = async () => ({ kind: "text", text: "2" });
    const result = await runAcpTurn(double.launch, {
      prompt: "do it",
      cwd: process.cwd(),
      env: double.env,
      nodeId: "n",
      promptChoice,
    });
    expect(result.output).toBe("chosen:opt-deny");
  });

  test("@s-perm-piped-option-id: a piped reply naming an option's identifier chooses that option", async () => {
    const double = withPermissionDouble({ title: "Run rm -rf", options: OPTIONS });
    const promptChoice: PromptChoices = async () => ({ kind: "text", text: "opt-deny" });
    const result = await runAcpTurn(double.launch, {
      prompt: "do it",
      cwd: process.cwd(),
      env: double.env,
      nodeId: "n",
      promptChoice,
    });
    expect(result.output).toBe("chosen:opt-deny");
  });

  test("@s-perm-piped-invalid-reasks / @s-perm-nothing-sent-until-chosen: an unusable piped reply re-asks with no menu written; nothing reaches the agent until a valid choice", async () => {
    const double = withPermissionDouble({ title: "Run rm -rf", options: OPTIONS });
    const replies = ["banana", "9", "opt-nonexistent", "2"];
    let calls = 0;
    const promptChoice: PromptChoices = async () => ({ kind: "text", text: replies[calls++]! });
    const result = await runAcpTurn(double.launch, {
      prompt: "do it",
      cwd: process.cwd(),
      env: double.env,
      nodeId: "n",
      promptChoice,
    });
    expect(calls).toBe(4);
    expect(result.output).toBe("chosen:opt-deny");
  });
});
