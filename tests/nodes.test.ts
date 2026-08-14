import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaoError } from "../src/errors";
import type { PromptChoices } from "../src/gate";
import type { AiExecConfig } from "../src/nodes";
import { evaluateWhenBash, executeAiNode, executeBashScript, runShell, trimBuffer, withRetries } from "../src/nodes";
import type { Runner, RunnerRequest } from "../src/runners/types";

const cwd = () => mkdtempSync(join(tmpdir(), "sao-nodes-"));

// Mirrors MAX_BUFFER_CHARS in src/nodes.ts.
const MAX_BUFFER_CHARS = 4 << 20;

function fakeRunner(
  result: { output?: string; sessionId?: string; exitCode?: number },
  calls: RunnerRequest[] = [],
): Runner {
  return {
    name: "fake",
    async run(req) {
      calls.push(req);
      return { output: result.output ?? "ok", sessionId: result.sessionId, exitCode: result.exitCode ?? 0 };
    },
  };
}

function config(runner: Runner, extra: Partial<AiExecConfig> = {}): AiExecConfig {
  return { runner, ...extra };
}

describe("executeBashScript", () => {
  test("captures stdout and stderr, streaming to log", async () => {
    const logged: string[] = [];
    const output = await executeBashScript("echo out; echo err >&2", {
      cwd: cwd(),
      log: (chunk) => logged.push(chunk),
    });
    expect(output).toContain("out");
    expect(output).toContain("err");
    expect(logged.join("")).toContain("out");
  });

  test("keeps only the last 100 output lines", async () => {
    const script = 'i=1; while [ $i -le 150 ]; do echo "line$i"; i=$((i+1)); done';
    const output = await executeBashScript(script, { cwd: cwd(), log: () => {} });
    const lines = output.split("\n");
    expect(lines).toHaveLength(100);
    expect(lines[0]).toBe("line51");
    expect(lines[99]).toBe("line150");
  });

  test("bounds memory on huge output and still returns the exact last 100 lines", async () => {
    // Sized to cross the 4 MiB buffer cap inside the final 100 lines (860 × ~5 KB ≈
    // 4.3 MiB): fewer than 70 lines arrive after the last trim, so a trim that kept
    // too few lines could not rebuild the 100-line tail and this test would fail.
    const pad = "x".repeat(5000);
    const script = `awk 'BEGIN { for (i = 1; i <= 860; i++) printf "line%04d-%s\\n", i, "${pad}" }'`;
    const output = await executeBashScript(script, { cwd: cwd(), log: () => {} });
    const lines = output.split("\n");
    expect(lines).toHaveLength(100);
    expect(lines[0]).toBe(`line0761-${pad}`);
    expect(lines[99]).toBe(`line0860-${pad}`);
  });

  test("trailing blank lines don't eat into the 100-line tail when trimming", async () => {
    const pad = "y".repeat(5000);
    const script = `awk 'BEGIN { for (i = 1; i <= 1000; i++) printf "row%04d-%s\\n", i, "${pad}"; for (i = 0; i < 150; i++) print "" }'`;
    const output = await executeBashScript(script, { cwd: cwd(), log: () => {} });
    const lines = output.split("\n");
    expect(lines).toHaveLength(100);
    expect(lines[0]).toBe(`row0901-${pad}`);
    expect(lines[99]).toBe(`row1000-${pad}`);
  });

  test("rejects on non-zero exit with the code", async () => {
    await expect(executeBashScript("exit 5", { cwd: cwd(), log: () => {} })).rejects.toThrow(
      "command exited with code 5",
    );
  });

  test("kills the process on timeout", async () => {
    const started = Date.now();
    await expect(executeBashScript("sleep 5", { cwd: cwd(), timeoutSec: 1, log: () => {} })).rejects.toThrow(
      "timed out after 1s",
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("timeout settles at the deadline even when a grandchild escapes the process group", async () => {
    // perl setsid()s into its own session, out of reach of the group kill, while
    // still holding the stdio pipes — the rejection must come from the timer, not close.
    const script = "perl -MPOSIX -e 'POSIX::setsid(); sleep 8' & wait";
    const started = Date.now();
    await expect(executeBashScript(script, { cwd: cwd(), timeoutSec: 1, log: () => {} })).rejects.toThrow(
      "timed out after 1s",
    );
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10000);

  test("timeout kills the whole process tree, not just sh", async () => {
    // "; true" stops sh from exec-replacing itself, so sleep is a grandchild that
    // holds the stdio pipes — killing only sh would hang this until sleep exits.
    const script = "sleep 30; true";
    const started = Date.now();
    await expect(executeBashScript(script, { cwd: cwd(), timeoutSec: 1, log: () => {} })).rejects.toThrow(
      "timed out after 1s",
    );
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10000);

  test("runs the script in the given cwd", async () => {
    const dir = cwd();
    const output = await executeBashScript("pwd", { cwd: dir, log: () => {} });
    expect(output).toBe(realpathSync(dir));
  });

  test("stdin comes from /dev/null, so readers see EOF instead of hanging on a pipe", async () => {
    // With stdin ignored, `cat` hits EOF immediately; a dangling stdin pipe would
    // block it until the 2s timeout rejected this node.
    const output = await executeBashScript("cat; echo fin", { cwd: cwd(), timeoutSec: 2, log: () => {} });
    expect(output).toBe("fin");
  });

  test("a fast script under a generous timeout succeeds (timeout is seconds, not milliseconds)", async () => {
    const output = await executeBashScript("sleep 0.5; echo done", { cwd: cwd(), timeoutSec: 5, log: () => {} });
    expect(output).toBe("done");
  });

  test("timeout kills backgrounded grandchildren via the detached process group", async () => {
    // The subshell would write the marker at t=2s; the group kill at t=1s must
    // reach it. Killing only sh (non-detached fallback) leaves it alive.
    const dir = cwd();
    const marker = join(dir, "marker.txt");
    const script = `(sleep 2; echo alive > "${marker}") & wait`;
    await expect(executeBashScript(script, { cwd: dir, timeoutSec: 1, log: () => {} })).rejects.toThrow(
      "timed out after 1s",
    );
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(marker)).toBe(false);
  }, 10000);

  test("rejects with SaoError when the shell cannot spawn", async () => {
    const missing = join(cwd(), "does-not-exist");
    try {
      await executeBashScript("echo hi", { cwd: missing, log: () => {} });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toMatch(/^failed to spawn shell: .+/);
    }
  });

  test("clears the timeout timer on settle so the process can exit promptly", async () => {
    // Touch the timer path in-process first so per-test mutant coverage sees it.
    await executeBashScript("true", { cwd: cwd(), timeoutSec: 5, log: () => {} });

    // An uncleared 5s timer would keep the child process's event loop alive long
    // after the node resolves — observable as wall-clock exit time.
    const dir = cwd();
    const nodesPath = new URL("../src/nodes.ts", import.meta.url).pathname;
    const scriptPath = join(dir, "exit-fast.ts");
    writeFileSync(
      scriptPath,
      `import { executeBashScript } from ${JSON.stringify(nodesPath)};\n` +
        `const output = await executeBashScript("echo ok", { cwd: process.cwd(), timeoutSec: 5, log: () => {} });\n` +
        `console.log("RESOLVED:" + output);\n`,
    );
    const started = Date.now();
    const result = spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: "utf8", timeout: 8000 });
    expect(result.stdout).toContain("RESOLVED:ok");
    expect(Date.now() - started).toBeLessThan(3500);
  }, 15000);

  test("does not trim segments while the buffer stays under the cap", async () => {
    // 200 real lines + 950 trailing blanks (~2 KB total): an eager trim to the last
    // 1000 segments would leave only 49 real lines for the 100-line tail.
    const script =
      'i=1; while [ $i -le 200 ]; do echo "line$i"; i=$((i+1)); done; ' +
      "i=0; while [ $i -lt 950 ]; do echo; i=$((i+1)); done";
    const output = await executeBashScript(script, { cwd: cwd(), log: () => {} });
    const lines = output.split("\n");
    expect(lines).toHaveLength(100);
    expect(lines[0]).toBe("line101");
    expect(lines[99]).toBe("line200");
  });

  test("hard cap: when the last 100 lines exceed the cap, output is exactly the last 4 MiB", async () => {
    // 100 lines × 65536 chars = 6.25 MiB; the surviving buffer is always the last
    // MAX_BUFFER_CHARS chars of the stream = exactly the last 64 lines.
    const dir = cwd();
    const line = (i: number) => `line${String(i).padStart(4, "0")} ${"a".repeat(65526)}\n`;
    writeFileSync(join(dir, "big.txt"), Array.from({ length: 100 }, (_, i) => line(i + 1)).join(""));
    const output = await executeBashScript("cat big.txt", { cwd: dir, log: () => {} });
    const lines = output.split("\n");
    expect(lines).toHaveLength(64);
    expect(lines[0]).toBe(line(37).trimEnd());
    expect(lines[63]).toBe(line(100).trimEnd());
  });

  test("a buffer landing exactly on the cap is left untrimmed", async () => {
    // Total output is exactly MAX_BUFFER_CHARS, so no intermediate chunk sum can
    // exceed it: trimming at >= (instead of >) would fire on the final chunk and
    // eat into the blank-line window, shrinking the tail to 49 lines.
    const dir = cwd();
    const real = Array.from({ length: 200 }, (_, i) => `line${String(i + 1).padStart(4, "0")}\n`).join("");
    const blanks = "\n".repeat(950);
    const filler = `${"a".repeat(MAX_BUFFER_CHARS - real.length - blanks.length - 1)}\n`;
    const content = filler + real + blanks;
    expect(content).toHaveLength(MAX_BUFFER_CHARS);
    writeFileSync(join(dir, "exact.txt"), content);
    const output = await executeBashScript("cat exact.txt", { cwd: dir, log: () => {} });
    const lines = output.split("\n");
    expect(lines).toHaveLength(100);
    expect(lines[0]).toBe("line0101");
    expect(lines[99]).toBe("line0200");
  });
});

describe("runShell / evaluateWhenBash", () => {
  test("runShell resolves with the exit code instead of throwing", async () => {
    const { code, output } = await runShell("echo probe; exit 3", { cwd: cwd(), log: () => {} });
    expect(code).toBe(3);
    expect(output).toBe("probe");
  });

  test("evaluateWhenBash is true on exit 0", async () => {
    expect(await evaluateWhenBash("true", { cwd: cwd(), log: () => {} })).toBe(true);
  });

  test("evaluateWhenBash is false on non-zero exit", async () => {
    expect(await evaluateWhenBash("exit 1", { cwd: cwd(), log: () => {} })).toBe(false);
  });

  test("evaluateWhenBash streams predicate output to the log", async () => {
    const logged: string[] = [];
    await evaluateWhenBash("echo probe-out", { cwd: cwd(), log: (chunk) => logged.push(chunk) });
    expect(logged.join("")).toContain("probe-out");
  });

  test("evaluateWhenBash still throws on timeout — a broken predicate must not silently skip", async () => {
    await expect(evaluateWhenBash("sleep 5", { cwd: cwd(), timeoutSec: 1, log: () => {} })).rejects.toThrow(
      "timed out after 1s",
    );
  });
});

describe("trimBuffer", () => {
  test("keeps exactly the last 1000 newline-delimited segments", () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `L${String(i + 1).padStart(4, "0")}\n`);
    const text = lines.join("");
    // The walk steps back 1000 newlines (landing on the one ending line 501) and
    // keeps everything after it: the last 999 full lines.
    expect(trimBuffer(text)).toBe(lines.slice(501).join(""));
  });

  test("returns the kept window untouched when it is under the hard cap", () => {
    // 2000 × 3000-char lines (6 MB): the kept window (999 lines ≈ 2.9 MB) is between
    // MAX/2 and MAX, where a stray negative-start slice would truncate it.
    const lines = Array.from({ length: 2000 }, (_, i) => `${String(i + 1).padStart(4, "0") + "y".repeat(2995)}\n`);
    expect(trimBuffer(lines.join(""))).toBe(lines.slice(1001).join(""));
  });

  test("newline-less text is hard-capped to exactly the last MAX_BUFFER_CHARS chars", () => {
    const text = "b".repeat(MAX_BUFFER_CHARS + 5000);
    expect(trimBuffer(text)).toBe(text.slice(5000));
  });

  test("a kept window still over the cap is hard-capped from the front", () => {
    // 1100 × 8192-char lines: the kept 999 lines are ~7.8 MB, so the hard cap
    // applies — exactly the last 512 lines (512 × 8192 = MAX_BUFFER_CHARS).
    const lines = Array.from({ length: 1100 }, (_, i) => `${String(i + 1).padStart(4, "0") + "z".repeat(8187)}\n`);
    expect(trimBuffer(lines.join(""))).toBe(lines.slice(588).join(""));
  });

  test("a walk that lands on a leading newline keeps the whole text", () => {
    // Exactly 1000 newlines with the 1000th-from-last at position 0: idx reaches 0
    // and the idx <= 0 branch must keep everything (slice(1) would drop the "\n").
    const text = `\n${"z\n".repeat(999)}tail`;
    expect(trimBuffer(text)).toBe(text);
  });

  test("the segment walk stops exactly at the 1000th newline from the end", () => {
    // The 1000th newline from the end sits at position 1; the walk must stop there
    // (keeping text.slice(2)), not treat position 1 as a break sentinel.
    const text = `a\n${"bb\n".repeat(999)}cc`;
    expect(trimBuffer(text)).toBe(text.slice(2));
  });
});

describe("executeAiNode", () => {
  test("passes prompt, cwd, and every config field to the runner", async () => {
    const calls: RunnerRequest[] = [];
    const dir = cwd();
    await executeAiNode(
      "the prompt",
      config(fakeRunner({}, calls), {
        model: "haiku",
        permissionMode: "plan",
        systemPrompt: "be terse",
        allowedTools: ["mcp__jira"],
        mcpConfigPath: "/run/mcp.json",
        resumeSessionId: "s-1",
        timeoutSec: 42,
      }),
      { cwd: dir, log: () => {} },
    );
    const req = calls[0]!;
    expect(req.prompt).toBe("the prompt");
    expect(req.cwd).toBe(dir);
    expect(req.model).toBe("haiku");
    expect(req.permissionMode).toBe("plan");
    expect(req.systemPrompt).toBe("be terse");
    expect(req.allowedTools).toEqual(["mcp__jira"]);
    expect(req.mcpConfigPath).toBe("/run/mcp.json");
    expect(req.resumeSessionId).toBe("s-1");
    expect(req.timeoutSec).toBe(42);
  });

  test("forwards the owning node id and the list-prompt seam from context to the runner", async () => {
    const calls: RunnerRequest[] = [];
    const promptChoice: PromptChoices = async () => ({ kind: "choice", id: "x" });
    await executeAiNode("p", config(fakeRunner({}, calls)), { cwd: cwd(), log: () => {}, nodeId: "fix", promptChoice });
    const req = calls[0]!;
    expect(req.nodeId).toBe("fix");
    expect(req.promptChoice).toBe(promptChoice);
  });

  test("leaves optional fields undefined when the config has none", async () => {
    const calls: RunnerRequest[] = [];
    await executeAiNode("p", config(fakeRunner({}, calls)), { cwd: cwd(), log: () => {} });
    const req = calls[0]!;
    expect(req.model).toBeUndefined();
    expect(req.systemPrompt).toBeUndefined();
    expect(req.allowedTools).toBeUndefined();
    expect(req.mcpConfigPath).toBeUndefined();
    expect(req.resumeSessionId).toBeUndefined();
  });

  test("returns output and session id", async () => {
    const result = await executeAiNode("p", config(fakeRunner({ output: "answer", sessionId: "s9" })), {
      cwd: cwd(),
      log: () => {},
    });
    expect(result).toEqual({ output: "answer", sessionId: "s9" });
  });

  test("throws when the runner exits non-zero", async () => {
    await expect(
      executeAiNode("p", config(fakeRunner({ exitCode: 2 })), { cwd: cwd(), log: () => {} }),
    ).rejects.toThrow("fake exited with code 2");
  });

  test("non-zero exit surfaces the result text as the error hint", async () => {
    try {
      await executeAiNode("p", config(fakeRunner({ output: "Invalid model name: claude-nope", exitCode: 2 })), {
        cwd: cwd(),
        log: () => {},
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).hint).toContain("Invalid model name: claude-nope");
    }
  });

  const failHint = async (output: string): Promise<string | undefined> => {
    try {
      await executeAiNode("p", config(fakeRunner({ output, exitCode: 2 })), { cwd: cwd(), log: () => {} });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toBe("fake exited with code 2");
      return (err as SaoError).hint;
    }
  };

  test("a 500-char detail (after trimming) becomes the hint untruncated", async () => {
    const detail = "x".repeat(500);
    expect(await failHint(`${detail}\n\n`)).toBe(detail);
  });

  test("a 501-char detail is truncated to 500 chars plus an ellipsis", async () => {
    const detail = "x".repeat(501);
    expect(await failHint(detail)).toBe(`${"x".repeat(500)} …`);
  });

  test("whitespace-only output yields no hint", async () => {
    expect(await failHint(" \n\t \n")).toBeUndefined();
  });
});

describe("withRetries", () => {
  test("returns the first success without extra attempts", async () => {
    let attempts = 0;
    const result = await withRetries(3, async () => {
      attempts++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(1);
  });

  test("retries until success within the budget", async () => {
    let attempts = 0;
    const result = await withRetries(2, async () => {
      attempts++;
      if (attempts < 3) throw new Error("flaky");
      return "eventually";
    });
    expect(result).toBe("eventually");
    expect(attempts).toBe(3);
  });

  test("throws the last error after exhausting retries", async () => {
    let attempts = 0;
    await expect(
      withRetries(1, async () => {
        attempts++;
        throw new Error(`attempt ${attempts}`);
      }),
    ).rejects.toThrow("attempt 2");
    expect(attempts).toBe(2);
  });
});
