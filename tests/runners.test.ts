import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeArgs, ClaudeStreamCollector, claudeRunner } from "../src/runners/claude";
import { getRunner } from "../src/runners/types";
import { SaoError } from "../src/errors";

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

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

describe("buildClaudeArgs", () => {
  test("minimal request produces the base headless invocation", () => {
    expect(buildClaudeArgs({ prompt: "hi", cwd: "/tmp" })).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
    ]);
  });

  test("never puts the prompt on argv — it goes over stdin", () => {
    expect(buildClaudeArgs({ prompt: "--help", cwd: "/tmp" })).not.toContain("--help");
  });

  test("maps every optional field to its flag", () => {
    const args = buildClaudeArgs({
      prompt: "p",
      cwd: "/",
      model: "haiku",
      permissionMode: "plan",
      resumeSessionId: "s-123",
      systemPrompt: "you are terse",
      mcpConfigPath: "/run/mcp.json",
      allowedTools: ["mcp__jira", "WebSearch"],
    });
    expect(flagValue(args, "--model")).toBe("haiku");
    expect(flagValue(args, "--permission-mode")).toBe("plan");
    expect(flagValue(args, "--resume")).toBe("s-123");
    expect(flagValue(args, "--append-system-prompt")).toBe("you are terse");
    expect(flagValue(args, "--mcp-config")).toBe("/run/mcp.json");
    expect(flagValue(args, "--allowedTools")).toBe("mcp__jira,WebSearch");
  });

  test("omits flags for absent options", () => {
    const args = buildClaudeArgs({ prompt: "p", cwd: "/" });
    for (const flag of ["--model", "--resume", "--append-system-prompt", "--mcp-config", "--allowedTools"]) {
      expect(args).not.toContain(flag);
    }
  });

  test("omits --allowedTools for an empty list", () => {
    expect(buildClaudeArgs({ prompt: "p", cwd: "/", allowedTools: [] })).not.toContain("--allowedTools");
  });
});

describe("ClaudeStreamCollector", () => {
  test("captures result text and session id", () => {
    const collector = new ClaudeStreamCollector();
    collector.push('{"type":"result","result":"final answer","session_id":"abc"}\n');
    collector.finish();
    expect(collector.output).toBe("final answer");
    expect(collector.sessionId).toBe("abc");
  });

  test("streams assistant text blocks to onOutput", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    collector.push(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"tool_use"},{"type":"text","text":" world"}]}}\n',
    );
    expect(chunks).toEqual(["hello world\n"]);
  });

  test("excludes non-text blocks even when they carry text", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    collector.push(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"tool_use","text":"IGNORED"},{"type":"text","text":"b"}]}}\n',
    );
    expect(chunks).toEqual(["ab\n"]);
  });

  test("assistant events without message or content are ignored, not a crash", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    collector.push('{"type":"assistant"}\n');
    collector.push('{"type":"assistant","message":{}}\n');
    expect(chunks).toEqual([]);
  });

  test("assistant events whose text blocks are all empty emit nothing", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    collector.push('{"type":"assistant","message":{"content":[{"type":"text","text":""},{"type":"text","text":""}]}}\n');
    expect(chunks).toEqual([]);
  });

  test("reassembles JSON lines split across chunks", () => {
    const collector = new ClaudeStreamCollector();
    collector.push('{"type":"result","res');
    collector.push('ult":"joined","session_id":"s"}\n');
    expect(collector.output).toBe("joined");
  });

  test("finish flushes a trailing line without a newline", () => {
    const collector = new ClaudeStreamCollector();
    collector.push('{"type":"result","result":"tail"}');
    expect(collector.output).toBe("");
    collector.finish();
    expect(collector.output).toBe("tail");
  });

  test("finish resets pending so later pushes start clean", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    collector.push("tail");
    collector.finish();
    expect(chunks).toEqual(["tail\n"]);
    collector.push("next\n");
    expect(chunks).toEqual(["tail\n", "next\n"]);
  });

  test("forwards non-JSON lines to onOutput without affecting output", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    collector.push("plain warning\n");
    expect(chunks).toEqual(["plain warning\n"]);
    expect(collector.output).toBe("");
  });

  test("ignores blank lines and unknown event types", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    collector.push("\n\n");
    collector.push('{"type":"system","subtype":"init"}\n');
    expect(chunks).toEqual([]);
    expect(collector.sawResult).toBe(false);
    expect(collector.output).toBe("");
  });

  test("whitespace-only lines are ignored entirely", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    collector.push("   \n\t\n  \n");
    expect(chunks).toEqual([]);
    expect(collector.output).toBe("");
  });

  test("forwards JSON scalar lines (null, numbers) as raw output instead of crashing", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    collector.push("null\n123\n");
    expect(chunks).toEqual(["null\n", "123\n"]);
    expect(collector.sawResult).toBe(false);
  });

  test("forwards quoted-string scalar lines verbatim", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    collector.push('"stray"\n');
    expect(chunks).toEqual(['"stray"\n']);
  });

  test("stays silent and safe without an onOutput callback", () => {
    const collector = new ClaudeStreamCollector();
    expect(() => {
      collector.push("plain text line\n");
      collector.push('"scalar"\n');
      collector.push("123\n");
      collector.push('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n');
      collector.push("z".repeat((8 << 20) + 1)); // overflow flush path
    }).not.toThrow();
  });

  test("tracks whether a result event ever arrived", () => {
    const collector = new ClaudeStreamCollector();
    expect(collector.sawResult).toBe(false);
    expect(collector.isError).toBe(false);
    collector.push('{"type":"result","result":"done"}\n');
    expect(collector.sawResult).toBe(true);
    expect(collector.isError).toBe(false);
  });

  test("records the result event's is_error flag", () => {
    const collector = new ClaudeStreamCollector();
    collector.push('{"type":"result","result":"credit balance too low","is_error":true}\n');
    expect(collector.isError).toBe(true);
    expect(collector.output).toBe("credit balance too low");
  });

  test("only a literal true is_error marks an error", () => {
    const collector = new ClaudeStreamCollector();
    collector.push('{"type":"result","result":"r","is_error":"yes"}\n');
    expect(collector.sawResult).toBe(true);
    expect(collector.isError).toBe(false);
  });

  test("a result event without a result field yields empty output", () => {
    const collector = new ClaudeStreamCollector();
    collector.push('{"type":"result","session_id":"s-2"}\n');
    expect(collector.sawResult).toBe(true);
    expect(collector.output).toBe("");
    expect(collector.sessionId).toBe("s-2");
  });

  test("caps the pending buffer on a pathological newline-less stream", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    const big = "z".repeat(3 << 20);
    collector.push(big);
    collector.push(big);
    collector.push(big); // 9 MiB without a newline — must flush raw, not buffer forever
    expect(chunks.join("").length).toBeGreaterThanOrEqual(8 << 20);
  });

  test("resets the pending buffer after an overflow flush", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    const big = "z".repeat((8 << 20) + 1);
    collector.push(big);
    expect(chunks).toEqual([big]);
    collector.push('{"type":"result","result":"after"}\n');
    expect(collector.output).toBe("after"); // parses cleanly — no leftover garbage prefix
    expect(chunks).toEqual([big]);
  });

  test("does not flush at exactly the cap", () => {
    const chunks: string[] = [];
    const collector = new ClaudeStreamCollector((chunk) => chunks.push(chunk));
    collector.push("z".repeat(8 << 20));
    expect(chunks).toEqual([]);
  });
});

/** Put a fake `claude` executable first on PATH; returns a restore function. */
function withStubClaude(script: string): () => void {
  const dir = mkdtempSync(join(tmpdir(), "sao-stub-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  return () => {
    process.env.PATH = oldPath;
  };
}

describe("claudeRunner.run", () => {
  test("pipes the prompt over stdin — even one that looks like a flag", async () => {
    const restore = withStubClaude(`#!/bin/sh
prompt=$(cat)
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'
printf '{"type":"result","result":"got %s","session_id":"sess-1"}\\n' "$prompt"
`);
    try {
      const chunks: string[] = [];
      const result = await claudeRunner.run({ prompt: "--help", cwd: process.cwd(), onOutput: (c) => chunks.push(c) });
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("got --help");
      expect(result.sessionId).toBe("sess-1");
      // On success the result text must NOT be echoed to the log — only live assistant text.
      expect(chunks.join("")).toBe("working\n");
    } finally {
      restore();
    }
  });

  test("runs claude in the requested working directory", async () => {
    const restore = withStubClaude(`#!/bin/sh
cat > /dev/null
printf '{"type":"result","result":"%s"}\\n' "$PWD"
`);
    const dir = mkdtempSync(join(tmpdir(), "sao-cwd-"));
    try {
      const result = await claudeRunner.run({ prompt: "hi", cwd: dir });
      expect(result.output).toBe(realpathSync(dir));
    } finally {
      restore();
    }
  });

  test("a clean exit without a result event is an error, not an empty success", async () => {
    const restore = withStubClaude("#!/bin/sh\ncat > /dev/null\nexit 0\n");
    try {
      const err = await rejectionOf(claudeRunner.run({ prompt: "hi", cwd: process.cwd() }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toBe("claude exited without emitting a result event");
      expect(err.hint).toBe("the stream-json output ended before a result line; the node log has the raw stream");
    } finally {
      restore();
    }
  });

  test("survives EPIPE when claude exits without reading a huge prompt", async () => {
    const restore = withStubClaude("#!/bin/sh\nexit 0\n"); // never reads stdin
    let uncaught: unknown;
    const trap = (err: unknown) => {
      uncaught = err;
    };
    process.on("uncaughtException", trap);
    try {
      const err = await rejectionOf(
        claudeRunner.run({ prompt: "p".repeat(2 << 20), cwd: process.cwd() }),
      );
      expect(err.message).toBe("claude exited without emitting a result event");
      await wait(200); // give a straggling EPIPE time to surface
      expect(uncaught).toBeUndefined(); // the stdin error listener must swallow it
    } finally {
      process.removeListener("uncaughtException", trap);
      restore();
    }
  });

  test("on non-zero exit the result text still reaches the log via onOutput", async () => {
    const restore = withStubClaude(`#!/bin/sh
cat > /dev/null
echo '{"type":"result","result":"Invalid model name: claude-nope","is_error":true}'
exit 1
`);
    try {
      const chunks: string[] = [];
      const result = await claudeRunner.run({ prompt: "hi", cwd: process.cwd(), onOutput: (c) => chunks.push(c) });
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe("Invalid model name: claude-nope");
      expect(chunks.join("")).toBe("Invalid model name: claude-nope\n");
      // And without an onOutput callback the same failure must still resolve, not crash.
      const bare = await claudeRunner.run({ prompt: "hi", cwd: process.cwd() });
      expect(bare.exitCode).toBe(1);
      expect(bare.output).toBe("Invalid model name: claude-nope");
    } finally {
      restore();
    }
  });

  test("non-zero exit with whitespace-only result logs nothing", async () => {
    const restore = withStubClaude(`#!/bin/sh
cat > /dev/null
echo '{"type":"result","result":"   "}'
exit 1
`);
    try {
      const chunks: string[] = [];
      const result = await claudeRunner.run({ prompt: "hi", cwd: process.cwd(), onOutput: (c) => chunks.push(c) });
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe("   ");
      expect(chunks.join("")).toBe("");
    } finally {
      restore();
    }
  });

  test("a signal-killed claude resolves with exit code 1, not null", async () => {
    const restore = withStubClaude("#!/bin/sh\ncat > /dev/null\nkill -KILL $$\n");
    try {
      const result = await claudeRunner.run({ prompt: "hi", cwd: process.cwd() });
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe("");
    } finally {
      restore();
    }
  });

  test("a result event with is_error fails the run even on exit 0, logging the text", async () => {
    const restore = withStubClaude(`#!/bin/sh
cat > /dev/null
echo '{"type":"result","result":"credit balance too low","is_error":true,"session_id":"s"}'
`);
    try {
      const chunks: string[] = [];
      const err = await rejectionOf(claudeRunner.run({ prompt: "hi", cwd: process.cwd(), onOutput: (c) => chunks.push(c) }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toBe("claude reported an error result");
      expect(err.hint).toBe("credit balance too low");
      // The node log must carry the failure text too, not just the CLI hint.
      expect(chunks.join("")).toContain("credit balance too low");
    } finally {
      restore();
    }
  });

  test(
    "a hang after an is_error result still fails the run, logging the text",
    async () => {
      const restore = withStubClaude(`#!/bin/sh
cat > /dev/null
echo '{"type":"result","result":"credit balance too low","is_error":true}'
sleep 30
`);
      process.env.SAO_CLAUDE_RESULT_GRACE_MS = "200";
      try {
        const chunks: string[] = [];
        const err = await rejectionOf(claudeRunner.run({ prompt: "hi", cwd: process.cwd(), onOutput: (c) => chunks.push(c) }));
        expect(err).toBeInstanceOf(SaoError);
        expect(err.message).toBe("claude reported an error result");
        expect(chunks.join("")).toContain("credit balance too low");
      } finally {
        delete process.env.SAO_CLAUDE_RESULT_GRACE_MS;
        restore();
      }
    },
    10000,
  );

  test("error-result hints are trimmed and bounded to 500 chars", async () => {
    const exactly500 = "x".repeat(500);
    let restore = withStubClaude(`#!/bin/sh
cat > /dev/null
echo '{"type":"result","result":"${exactly500}","is_error":true}'
`);
    try {
      const err = await rejectionOf(claudeRunner.run({ prompt: "hi", cwd: process.cwd() }));
      expect(err.hint).toBe(exactly500);
    } finally {
      restore();
    }

    const over = "y".repeat(501);
    restore = withStubClaude(`#!/bin/sh
cat > /dev/null
echo '{"type":"result","result":"${over}","is_error":true}'
`);
    try {
      const err = await rejectionOf(claudeRunner.run({ prompt: "hi", cwd: process.cwd() }));
      expect(err.hint).toBe("y".repeat(500) + " …");
    } finally {
      restore();
    }

    restore = withStubClaude(`#!/bin/sh
cat > /dev/null
echo '{"type":"result","result":"   ","is_error":true}'
`);
    try {
      const err = await rejectionOf(claudeRunner.run({ prompt: "hi", cwd: process.cwd() }));
      expect(err.message).toBe("claude reported an error result");
      expect(err.hint).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("forwards stderr chatter to onOutput", async () => {
    const restore = withStubClaude(`#!/bin/sh
cat > /dev/null
echo "warned on stderr" >&2
echo '{"type":"result","result":"ok"}'
`);
    try {
      const chunks: string[] = [];
      const result = await claudeRunner.run({ prompt: "hi", cwd: process.cwd(), onOutput: (c) => chunks.push(c) });
      expect(result.output).toBe("ok");
      expect(chunks.join("")).toContain("warned on stderr");
      // Without a callback, stderr output must be silently dropped, not crash.
      const bare = await claudeRunner.run({ prompt: "hi", cwd: process.cwd() });
      expect(bare.output).toBe("ok");
    } finally {
      restore();
    }
  });

  test("a slow-but-finishing claude beats a generous timeout", async () => {
    const restore = withStubClaude(`#!/bin/sh
cat > /dev/null
sleep 0.3
echo '{"type":"result","result":"slow-ok"}'
`);
    try {
      const result = await claudeRunner.run({ prompt: "hi", cwd: process.cwd(), timeoutSec: 5 });
      expect(result.output).toBe("slow-ok");
      expect(result.exitCode).toBe(0);
    } finally {
      restore();
    }
  });

  test("kills and rejects when the timeout elapses", async () => {
    const restore = withStubClaude("#!/bin/sh\ncat > /dev/null\nsleep 30\n");
    try {
      const started = Date.now();
      const err = await rejectionOf(claudeRunner.run({ prompt: "hi", cwd: process.cwd(), timeoutSec: 1 }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toBe("claude timed out after 1s");
      expect(err.hint).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      restore();
    }
  });

  test(
    "settles shortly after the result event even if claude hangs instead of exiting",
    async () => {
      const restore = withStubClaude(`#!/bin/sh
cat > /dev/null
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"started"}]}}'
echo '{"type":"result","result":"done","session_id":"s-9"}'
sleep 30
`);
      process.env.SAO_CLAUDE_RESULT_GRACE_MS = "700";
      try {
        const started = Date.now();
        const chunks: string[] = [];
        let outputSeenAt = 0;
        const result = await claudeRunner.run({
          prompt: "hi",
          cwd: process.cwd(),
          onOutput: (c) => {
            chunks.push(c);
            if (!outputSeenAt) outputSeenAt = Date.now();
          },
        });
        expect(result.output).toBe("done");
        expect(result.sessionId).toBe("s-9");
        expect(result.exitCode).toBe(0);
        expect(Date.now() - started).toBeLessThan(3000);
        // The grace delay must actually be honored: measured from the moment the
        // stream started arriving (immune to spawn overhead), settling near-instantly
        // would mean the configured 700ms was replaced by a bogus tiny delay.
        expect(Date.now() - outputSeenAt).toBeGreaterThanOrEqual(500);
        // The late `close` after the grace kill must not re-settle and leak the
        // result text into the log as if it were a failure.
        await wait(400);
        expect(chunks.join("")).toBe("started\n");
      } finally {
        delete process.env.SAO_CLAUDE_RESULT_GRACE_MS;
        restore();
      }
    },
    10000,
  );

  test(
    "the grace kill must not arm before the result event arrives",
    async () => {
      const restore = withStubClaude(`#!/bin/sh
cat > /dev/null
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}'
sleep 0.4
echo '{"type":"result","result":"late","session_id":"s-10"}'
sleep 30
`);
      process.env.SAO_CLAUDE_RESULT_GRACE_MS = "150";
      try {
        const result = await claudeRunner.run({ prompt: "hi", cwd: process.cwd() });
        expect(result.output).toBe("late");
        expect(result.exitCode).toBe(0);
      } finally {
        delete process.env.SAO_CLAUDE_RESULT_GRACE_MS;
        restore();
      }
    },
    10000,
  );

  test(
    "the grace kill takes the whole process tree down (detached group)",
    async () => {
      const restore = withStubClaude(`#!/bin/sh
cat > /dev/null
sleep 30 &
printf '{"type":"result","result":"%s"}\\n' "$!"
wait
`);
      process.env.SAO_CLAUDE_RESULT_GRACE_MS = "200";
      try {
        const result = await claudeRunner.run({ prompt: "hi", cwd: process.cwd() });
        const grandchild = Number(result.output);
        expect(grandchild).toBeGreaterThan(0);
        let dead = false;
        for (let i = 0; i < 30; i++) {
          try {
            process.kill(grandchild, 0);
            await wait(50);
          } catch {
            dead = true;
            break;
          }
        }
        expect(dead).toBe(true);
      } finally {
        delete process.env.SAO_CLAUDE_RESULT_GRACE_MS;
        restore();
      }
    },
    10000,
  );

  test("a missing claude binary yields the install hint", async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), "sao-nopath-"));
    try {
      const err = await rejectionOf(claudeRunner.run({ prompt: "hi", cwd: process.cwd() }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toBe("claude CLI not found on PATH");
      expect(err.hint).toBe("install Claude Code: https://claude.com/claude-code");
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe("getRunner", () => {
  test("resolves the claude runner", () => {
    expect(getRunner("claude").name).toBe("claude");
  });

  test("codex points at M4", () => {
    try {
      getRunner("codex");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toBe('unknown runner "codex"');
      expect((err as SaoError).hint).toBe("the codex adapter lands in M4");
    }
  });

  test("prototype property names are not runners", () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(() => getRunner(name)).toThrow(`unknown runner "${name}"`);
    }
  });

  test("unknown runners list what is available", () => {
    try {
      getRunner("nope");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toBe('unknown runner "nope"');
      expect((err as SaoError).hint).toBe("available runners: claude");
    }
  });
});
