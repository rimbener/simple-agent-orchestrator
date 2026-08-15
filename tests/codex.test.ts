import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaoError } from "../src/errors";
import {
  buildCodexArgs,
  CodexStreamCollector,
  codexRunner,
  composeCodexPrompt,
  ignoredCodexSettings,
} from "../src/runners/codex";

/** Await a promise that must reject; returns the rejection error. */
async function rejectionOf(promise: Promise<unknown>): Promise<SaoError> {
  try {
    await promise;
  } catch (err) {
    return err as SaoError;
  }
  throw new Error("expected the promise to reject");
}

describe("buildCodexArgs", () => {
  test("minimal request: exec --json, workspace-write sandbox, stdin sentinel LAST", () => {
    expect(buildCodexArgs({ prompt: "hi", cwd: "/tmp" })).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-",
    ]);
  });

  test("never puts the prompt on argv — the trailing '-' reads it from stdin", () => {
    const args = buildCodexArgs({ prompt: "--dangerously-bypass-approvals-and-sandbox", cwd: "/tmp" });
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args[args.length - 1]).toBe("-");
  });

  test("model rides argv as a single --model= token before the stdin sentinel", () => {
    const args = buildCodexArgs({ prompt: "hi", cwd: "/tmp", model: "gpt-5.3-codex" });
    expect(args).toEqual(["exec", "--json", "--sandbox", "workspace-write", "--model=gpt-5.3-codex", "-"]);
  });
});

describe("composeCodexPrompt", () => {
  test("no system prompt: the prompt is untouched", () => {
    expect(composeCodexPrompt({ prompt: "do it", cwd: "/tmp" })).toBe("do it");
  });

  test("system prompt becomes a role preamble separated from the task", () => {
    expect(composeCodexPrompt({ prompt: "do it", cwd: "/tmp", systemPrompt: "You are careful." })).toBe(
      "You are careful.\n\n---\n\ndo it",
    );
  });
});

describe("ignoredCodexSettings", () => {
  test("nothing set: nothing ignored", () => {
    expect(ignoredCodexSettings({ prompt: "p", cwd: "/tmp" })).toEqual([]);
  });

  test("each unsupported setting is named, in a stable order", () => {
    expect(
      ignoredCodexSettings({
        prompt: "p",
        cwd: "/tmp",
        mcpConfigPath: "/x/mcp.json",
        allowedTools: ["mcp__jira"],
        permissionMode: "acceptEdits",
      }),
    ).toEqual(["mcp", "allowed_tools", "permission_mode"]);
    expect(ignoredCodexSettings({ prompt: "p", cwd: "/tmp", allowedTools: [] })).toEqual(["allowed_tools"]);
  });
});

describe("CodexStreamCollector", () => {
  test("maps thread.started and the completed agent message; streams the text", () => {
    const chunks: string[] = [];
    const collector = new CodexStreamCollector((chunk) => chunks.push(chunk));
    collector.push('{"type":"thread.started","thread_id":"t-1"}\n');
    collector.push('{"type":"turn.started"}\n');
    collector.push('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}\n');
    collector.push('{"type":"turn.completed","usage":{"input_tokens":1}}\n');
    collector.finish();
    expect(collector.sessionId).toBe("t-1");
    expect(collector.sawMessage).toBe(true);
    expect(collector.output).toBe("pong");
    expect(collector.errorMessage).toBeUndefined();
    expect(chunks).toEqual(["pong\n"]);
  });

  test("the LAST completed agent message wins as output", () => {
    const collector = new CodexStreamCollector();
    collector.push('{"type":"item.completed","item":{"type":"agent_message","text":"first"}}\n');
    collector.push('{"type":"item.completed","item":{"type":"agent_message","text":"second"}}\n');
    expect(collector.output).toBe("second");
  });

  test("reassembles events split across chunks mid-line", () => {
    const collector = new CodexStreamCollector();
    collector.push('{"type":"item.completed","item":{"type":"agent_');
    collector.push('message","text":"split"}}\n{"type":"thread.started","thr');
    collector.push('ead_id":"t-2"}\n');
    expect(collector.output).toBe("split");
    expect(collector.sessionId).toBe("t-2");
  });

  test("finish() flushes a trailing line that never got its newline", () => {
    const collector = new CodexStreamCollector();
    collector.push('{"type":"item.completed","item":{"type":"agent_message","text":"tail"}}');
    expect(collector.sawMessage).toBe(false); // not yet — no newline
    collector.finish();
    expect(collector.output).toBe("tail");
  });

  test("non-JSON lines and JSON scalars pass through as raw output", () => {
    const chunks: string[] = [];
    const collector = new CodexStreamCollector((chunk) => chunks.push(chunk));
    collector.push("plain progress line\n123\nnull\n\n   \n");
    // "null" parses to null, whose typeof is "object" — it must still pass through
    // as stray output, never be dereferenced as an event.
    expect(chunks).toEqual(["plain progress line\n", "123\n", "null\n"]);
    expect(collector.sawMessage).toBe(false);
  });

  test("non-message items (reasoning, command_execution) are not output", () => {
    const chunks: string[] = [];
    const collector = new CodexStreamCollector((chunk) => chunks.push(chunk));
    collector.push('{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}\n');
    collector.push('{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}\n');
    collector.push('{"type":"item.started","item":{"type":"agent_message","text":"not yet"}}\n');
    expect(chunks).toEqual([]);
    expect(collector.sawMessage).toBe(false);
    expect(collector.output).toBe("");
  });

  test("an empty agent message still counts as a result, but streams nothing", () => {
    const chunks: string[] = [];
    const collector = new CodexStreamCollector((chunk) => chunks.push(chunk));
    collector.push('{"type":"item.completed","item":{"type":"agent_message","text":""}}\n');
    expect(collector.sawMessage).toBe(true);
    expect(collector.output).toBe("");
    expect(chunks).toEqual([]);
  });

  test("turn.completed and turn.failed both mark the turn ended; plain error events do not", () => {
    const done = new CodexStreamCollector();
    done.push('{"type":"turn.completed","usage":{}}\n');
    expect(done.turnEnded).toBe(true);

    const failed = new CodexStreamCollector();
    failed.push('{"type":"turn.failed","error":{"message":"x"}}\n');
    expect(failed.turnEnded).toBe(true);

    const mid = new CodexStreamCollector();
    mid.push(
      '{"type":"error","message":"transient"}\n{"type":"item.completed","item":{"type":"agent_message","text":"t"}}\n',
    );
    expect(mid.turnEnded).toBe(false);
  });

  test("turn.failed and error events record the FIRST failure message", () => {
    const collector = new CodexStreamCollector();
    collector.push('{"type":"turn.failed","error":{"message":"rate limited"}}\n');
    collector.push('{"type":"error","message":"later noise"}\n');
    expect(collector.errorMessage).toBe("rate limited");

    const bare = new CodexStreamCollector();
    bare.push('{"type":"turn.failed"}\n');
    expect(bare.errorMessage).toBe("codex reported turn.failed");

    const errEvent = new CodexStreamCollector();
    errEvent.push('{"type":"error"}\n');
    expect(errEvent.errorMessage).toBe("codex reported an error event");
  });

  test("a collector without an onOutput callback never throws, whatever arrives", () => {
    const collector = new CodexStreamCollector();
    collector.push("not json at all\n123\n");
    collector.push("x".repeat((8 << 20) + 1)); // over-cap raw flush
    collector.push('{"type":"item.completed","item":{"type":"agent_message","text":"quiet"}}\n');
    collector.push('{"type":"item.completed"}'); // no item at all
    collector.finish();
    expect(collector.output).toBe("quiet");
  });

  test("an item.completed without an item, and an agent_message without text, are safe", () => {
    const collector = new CodexStreamCollector();
    collector.push('{"type":"item.completed"}\n');
    expect(collector.sawMessage).toBe(false);
    collector.push('{"type":"item.completed","item":{"type":"agent_message"}}\n');
    expect(collector.sawMessage).toBe(true);
    expect(collector.output).toBe(""); // text absent falls back to ""
  });

  test("finish() is idempotent — a second call re-emits nothing", () => {
    const chunks: string[] = [];
    const collector = new CodexStreamCollector((chunk) => chunks.push(chunk));
    collector.push("dangling tail");
    collector.finish();
    collector.finish();
    expect(chunks).toEqual(["dangling tail\n"]);
  });

  test("a pathological newline-less line is flushed raw past the cap, and parsing recovers", () => {
    const chunks: string[] = [];
    const collector = new CodexStreamCollector((chunk) => chunks.push(chunk));
    const big = "x".repeat((8 << 20) + 1);
    collector.push(big);
    expect(chunks).toEqual([big]);
    collector.push('{"type":"item.completed","item":{"type":"agent_message","text":"after"}}\n');
    expect(collector.output).toBe("after"); // no leftover garbage prefix
  });

  test("does not flush at exactly the cap", () => {
    const chunks: string[] = [];
    const collector = new CodexStreamCollector((chunk) => chunks.push(chunk));
    collector.push("z".repeat(8 << 20));
    expect(chunks).toEqual([]);
  });
});

/** Put a fake `codex` executable first on PATH; returns a restore function. */
function withStubCodex(script: string): () => void {
  const dir = mkdtempSync(join(tmpdir(), "sao-codex-stub-"));
  const bin = join(dir, "codex");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  return () => {
    process.env.PATH = oldPath;
  };
}

describe("codexRunner.run", () => {
  test("pipes the prompt (with system preamble) over stdin — even one that looks like a flag", async () => {
    const restore = withStubCodex(`#!/bin/sh
prompt=$(cat)
echo '{"type":"thread.started","thread_id":"t-9"}'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"got %s"}}\\n' "$(printf '%s' "$prompt" | tr '\\n' '|')"
`);
    try {
      const chunks: string[] = [];
      const result = await codexRunner.run({
        prompt: "--help",
        systemPrompt: "You are terse.",
        cwd: process.cwd(),
        onOutput: (c) => chunks.push(c),
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("got You are terse.||---||--help");
      expect(result.sessionId).toBe("t-9");
      expect(chunks.join("")).toBe("got You are terse.||---||--help\n");
    } finally {
      restore();
    }
  });

  test("warns once about settings codex cannot honor; stays silent when none are set", async () => {
    const restore = withStubCodex(`#!/bin/sh
cat > /dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'
`);
    try {
      const warned: string[] = [];
      await codexRunner.run({
        prompt: "p",
        cwd: process.cwd(),
        mcpConfigPath: "/x/mcp.json",
        permissionMode: "acceptEdits",
        onOutput: (c) => warned.push(c),
      });
      expect(warned[0]).toBe("⚠ codex ignores mcp, permission_mode — it uses its own config (~/.codex/config.toml)\n");

      const silent: string[] = [];
      await codexRunner.run({ prompt: "p", cwd: process.cwd(), onOutput: (c) => silent.push(c) });
      expect(silent.join("")).toBe("ok\n");
    } finally {
      restore();
    }
  });

  test("refuses resumeSessionId without spawning — codex has no session resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sao-codex-marker-"));
    const marker = join(dir, "spawned");
    const restore = withStubCodex(`#!/bin/sh\ntouch ${marker}\n`);
    try {
      const err = await rejectionOf(codexRunner.run({ prompt: "p", cwd: process.cwd(), resumeSessionId: "t-1" }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toBe("the codex runner cannot resume sessions");
      expect(err.hint).toBe("loops with fresh_context: false require the claude runner");
      expect(existsSync(marker)).toBe(false);
    } finally {
      restore();
    }
  });

  test("runs codex in the requested working directory with the request env on top", async () => {
    const restore = withStubCodex(`#!/bin/sh
cat > /dev/null
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s %s"}}\\n' "$PWD" "$SAO_RUN_ID"
`);
    const dir = mkdtempSync(join(tmpdir(), "sao-codex-cwd-"));
    try {
      const result = await codexRunner.run({ prompt: "p", cwd: dir, env: { SAO_RUN_ID: "run-77" } });
      expect(result.output).toBe(`${realpathSync(dir)} run-77`);
    } finally {
      restore();
    }
  });

  test("a clean exit without an agent message is an error, not an empty success", async () => {
    const restore = withStubCodex("#!/bin/sh\ncat > /dev/null\nexit 0\n");
    try {
      const err = await rejectionOf(codexRunner.run({ prompt: "p", cwd: process.cwd() }));
      expect(err.message).toBe("codex exited without emitting an agent message");
      expect(err.hint).toBe(
        "the --json event stream ended before an agent_message item; codex's stderr and error events are in the node log",
      );
    } finally {
      restore();
    }
  });

  test("an in-stream error event fails the node even on exit 0, and lands in the log", async () => {
    const restore = withStubCodex(`#!/bin/sh
cat > /dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}'
echo '{"type":"turn.failed","error":{"message":"model quota exhausted"}}'
exit 0
`);
    try {
      const chunks: string[] = [];
      const err = await rejectionOf(
        codexRunner.run({ prompt: "p", cwd: process.cwd(), onOutput: (c) => chunks.push(c) }),
      );
      expect(err.message).toBe("codex reported an error");
      expect(err.hint).toBe("model quota exhausted");
      expect(chunks).toContain("model quota exhausted\n"); // failure detail reaches the node log
    } finally {
      restore();
    }
  });

  test("a non-zero exit with no events at all resolves with empty output", async () => {
    const restore = withStubCodex("#!/bin/sh\ncat > /dev/null\nexit 5\n");
    try {
      const result = await codexRunner.run({ prompt: "p", cwd: process.cwd() });
      expect(result.exitCode).toBe(5);
      expect(result.output).toBe("");
    } finally {
      restore();
    }
  });

  test("a non-zero exit resolves with the error event as output when no message came", async () => {
    const restore = withStubCodex(`#!/bin/sh
cat > /dev/null
echo '{"type":"error","message":"login required"}'
exit 3
`);
    try {
      const result = await codexRunner.run({ prompt: "p", cwd: process.cwd() });
      expect(result.exitCode).toBe(3);
      expect(result.output).toBe("login required"); // executeAiNode shows output as the failure detail
    } finally {
      restore();
    }
  });

  test("a non-zero exit keeps the agent message as output when there was one", async () => {
    const restore = withStubCodex(`#!/bin/sh
cat > /dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"crashed after this"}}'
exit 2
`);
    try {
      const result = await codexRunner.run({ prompt: "p", cwd: process.cwd() });
      expect(result.exitCode).toBe(2);
      expect(result.output).toBe("crashed after this");
    } finally {
      restore();
    }
  });

  test("stderr streams to onOutput as it arrives", async () => {
    const restore = withStubCodex(`#!/bin/sh
cat > /dev/null
echo 'oauth token stale' >&2
echo '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'
`);
    try {
      const chunks: string[] = [];
      await codexRunner.run({ prompt: "p", cwd: process.cwd(), onOutput: (c) => chunks.push(c) });
      expect(chunks.join("")).toContain("oauth token stale");
    } finally {
      restore();
    }
  });

  test("a codex that hangs after turn.completed is grace-killed and settles with its output", async () => {
    const restore = withStubCodex(`#!/bin/sh
cat > /dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"done work"}}'
echo '{"type":"turn.completed","usage":{}}'
sleep 30
`);
    process.env.SAO_CODEX_TURN_GRACE_MS = "200";
    try {
      const started = Date.now();
      const result = await codexRunner.run({ prompt: "p", cwd: process.cwd() });
      expect(result.output).toBe("done work");
      expect(result.exitCode).toBe(0);
      expect(Date.now() - started).toBeLessThan(10000); // did not wait out the sleep
    } finally {
      delete process.env.SAO_CODEX_TURN_GRACE_MS;
      restore();
    }
  }, 15000);

  test("output before turn.completed does not start the grace timer early", async () => {
    // If the grace timer started on the FIRST chunk (before the turn actually ends),
    // it would kill the process — and settle — well before "final" is ever emitted.
    const restore = withStubCodex(`#!/bin/sh
cat > /dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}'
sleep 0.3
echo '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}'
echo '{"type":"turn.completed","usage":{}}'
`);
    process.env.SAO_CODEX_TURN_GRACE_MS = "100";
    try {
      const result = await codexRunner.run({ prompt: "p", cwd: process.cwd() });
      expect(result.output).toBe("final");
      expect(result.exitCode).toBe(0);
    } finally {
      delete process.env.SAO_CODEX_TURN_GRACE_MS;
      restore();
    }
  }, 15000);

  test("a hang after turn.failed still fails the node via the grace path", async () => {
    const restore = withStubCodex(`#!/bin/sh
cat > /dev/null
echo '{"type":"turn.failed","error":{"message":"stuck and broken"}}'
sleep 30
`);
    process.env.SAO_CODEX_TURN_GRACE_MS = "200";
    try {
      const err = await rejectionOf(codexRunner.run({ prompt: "p", cwd: process.cwd() }));
      expect(err.message).toBe("codex reported an error");
      expect(err.hint).toBe("stuck and broken");
    } finally {
      delete process.env.SAO_CODEX_TURN_GRACE_MS;
      restore();
    }
  }, 15000);

  test("timeoutSec kills a hung codex and rejects", async () => {
    const restore = withStubCodex("#!/bin/sh\ncat > /dev/null\nsleep 30\n");
    try {
      const started = Date.now();
      const err = await rejectionOf(codexRunner.run({ prompt: "p", cwd: process.cwd(), timeoutSec: 1 }));
      expect(err.message).toBe("codex timed out after 1s");
      expect(Date.now() - started).toBeLessThan(10000);
    } finally {
      restore();
    }
  }, 15000);

  test("a missing codex binary yields the install hint", async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), "sao-codex-nopath-"));
    try {
      const err = await rejectionOf(codexRunner.run({ prompt: "hi", cwd: process.cwd() }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message).toBe("codex CLI not found on PATH");
      expect(err.hint).toBe("install the Codex CLI: npm install -g @openai/codex");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("a non-ENOENT spawn failure (EACCES) surfaces the spawn message, not the install hint", async () => {
    // A shebang line pointing at a non-executable interpreter: the OS finds "codex"
    // on PATH (it has +x) but fails to exec it — EACCES, delivered async, not thrown.
    const interpDir = mkdtempSync(join(tmpdir(), "sao-codex-interp-"));
    const interp = join(interpDir, "interp");
    writeFileSync(interp, "#!/bin/sh\necho hi\n");
    chmodSync(interp, 0o644);
    const restore = withStubCodex(`#!${interp}\n`);
    try {
      const err = await rejectionOf(codexRunner.run({ prompt: "hi", cwd: process.cwd() }));
      expect(err).toBeInstanceOf(SaoError);
      expect(err.message.startsWith("failed to spawn codex: ")).toBe(true);
      expect(err.hint).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("runs without an onOutput callback even when warnings, stderr, and errors fire", async () => {
    const restore = withStubCodex(`#!/bin/sh
cat > /dev/null
echo 'stderr noise' >&2
echo '{"type":"error","message":"transient"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"still fine"}}'
exit 7
`);
    try {
      // mcpConfigPath set → the ignored-settings warning path also runs, silently.
      const result = await codexRunner.run({ prompt: "p", cwd: process.cwd(), mcpConfigPath: "/x/mcp.json" });
      expect(result.exitCode).toBe(7);
      expect(result.output).toBe("still fine");
    } finally {
      restore();
    }
  });

  test("a timeout that does NOT fire lets a slower codex finish (seconds, not milliseconds)", async () => {
    const restore = withStubCodex(`#!/bin/sh
cat > /dev/null
sleep 1
echo '{"type":"item.completed","item":{"type":"agent_message","text":"slow but fine"}}'
`);
    try {
      const result = await codexRunner.run({ prompt: "p", cwd: process.cwd(), timeoutSec: 300 });
      expect(result.output).toBe("slow but fine"); // a ms-scaled timeout (300ms) would have killed this
    } finally {
      restore();
    }
  }, 15000);

  test("a chunk boundary inside a multi-byte character does not corrupt the output", async () => {
    const restore = withStubCodex(`#!/bin/sh
cat > /dev/null
printf '{"type":"item.completed","item":{"type":"agent_message","text":"caf\\303'
sleep 0.15
printf '\\251"}}\\n'
`);
    try {
      const result = await codexRunner.run({ prompt: "p", cwd: process.cwd() });
      expect(result.output).toBe("café"); // per-chunk toString() would bake in U+FFFD
    } finally {
      restore();
    }
  }, 15000);

  test("codexRunner.preflight throws a SaoError when codex is missing from PATH", () => {
    const realPath = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), "sao-no-codex-"));
    try {
      codexRunner.preflight!({ needsSessionResume: false });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toBe("codex CLI not found on PATH");
      expect((err as SaoError).hint).toBe("install the Codex CLI: npm install -g @openai/codex");
    } finally {
      process.env.PATH = realPath;
    }
  });

  test("codexRunner.preflight passes when a codex binary is on PATH", () => {
    const restore = withStubCodex("#!/bin/sh\nexit 0\n");
    try {
      expect(() => codexRunner.preflight!({ needsSessionResume: false })).not.toThrow();
    } finally {
      restore();
    }
  });

  test("@s-runner-granularity-declared: codexRunner declares per-message final-output streaming", () => {
    expect(codexRunner.finalOutputStreaming).toBe("per-message");
  });
});
