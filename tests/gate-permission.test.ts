import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpLaunch } from "../src/acp";
import { runAcpTurn } from "../src/acp";
import type { PromptUser } from "../src/gate";

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
  test("@s-permission-prompt-numbered: shows the node id, the tool call title, and the offered options numbered; the chosen optionId reaches the agent", async () => {
    const double = withPermissionDouble({ title: "Write file foo.txt", options: OPTIONS });
    const messages: string[] = [];
    const promptUser: PromptUser = async (message) => {
      messages.push(message);
      return "1";
    };
    const logged: string[] = [];
    const result = await runAcpTurn(double.launch, {
      prompt: "do it",
      cwd: process.cwd(),
      env: double.env,
      nodeId: "write-node",
      promptUser,
      onOutput: (c) => logged.push(c),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("write-node");
    expect(messages[0]).toContain("Write file foo.txt");
    expect(messages[0]).toContain("1. Allow");
    expect(messages[0]).toContain("2. Deny");
    expect(result.output).toBe("chosen:opt-allow");
    // The request/menu/selection text rides the interactive prompt only — never
    // onOutput too, or a real terminal (print echoes onOutput chunks dim, alongside
    // the bright interactive prompt) shows the same block twice. onOutput still
    // carries the turn's actual message content (the double's "chosen:..." reply).
    expect(logged.join("")).not.toContain("Write file foo.txt");
    expect(logged.join("")).not.toContain("selected:");
  });

  test("@s-permission-invalid-reply-reasks: an unparseable or out-of-range reply re-asks; nothing reaches the agent until a valid choice", async () => {
    const double = withPermissionDouble({ title: "Run rm -rf", options: OPTIONS });
    const replies = ["banana", "9", "2"];
    let calls = 0;
    const promptUser: PromptUser = async () => replies[calls++]!;
    const result = await runAcpTurn(double.launch, {
      prompt: "do it",
      cwd: process.cwd(),
      env: double.env,
      nodeId: "n",
      promptUser,
    });
    expect(calls).toBe(3);
    expect(result.output).toBe("chosen:opt-deny");
  });
});
