import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAgentRefs, loadAgent, resolveAgentPath, splitFrontmatter } from "../src/agents";
import { SaoError } from "../src/errors";
import { loadWorkflow } from "../src/parser";

const temp = () => mkdtempSync(join(tmpdir(), "sao-agents-"));

function agentFile(content: string): string {
  const dir = temp();
  const path = join(dir, "agent.md");
  writeFileSync(path, content);
  return path;
}

describe("splitFrontmatter", () => {
  test("no frontmatter → everything is body", () => {
    expect(splitFrontmatter("just text")).toEqual({ body: "just text" });
  });

  test("splits frontmatter from body", () => {
    const { frontmatter, body } = splitFrontmatter("---\nmodel: haiku\n---\nThe body.");
    expect(frontmatter).toBe("model: haiku");
    expect(body).toBe("The body.");
  });

  test("an unterminated marker treats the whole file as body", () => {
    const text = "---\nmodel: haiku\nno closing marker";
    expect(splitFrontmatter(text)).toEqual({ body: text });
  });

  test("a file without a leading marker is all body even when --- appears later", () => {
    const text = "not frontmatter\nkey: value\n---\nrest";
    expect(splitFrontmatter(text)).toEqual({ body: text });
  });

  test("only trailing CRs are stripped — a mid-line CR is data", () => {
    const { frontmatter } = splitFrontmatter('---\nkey: "a\rb"\r\n---\nbody');
    expect(frontmatter).toBe('key: "a\rb"');
  });

  test("a --- inside the body after the close is left alone", () => {
    const { frontmatter, body } = splitFrontmatter("---\na: 1\n---\nbody\n---\nmore body");
    expect(frontmatter).toBe("a: 1");
    expect(body).toBe("body\n---\nmore body");
  });

  test("CRLF files lose the trailing \\r on every frontmatter line", () => {
    const { frontmatter } = splitFrontmatter("---\r\nmodel: sonnet\r\nrunner: claude\r\n---\r\nbody");
    expect(frontmatter).toBe("model: sonnet\nrunner: claude");
  });

  test("an empty frontmatter block yields an empty frontmatter string", () => {
    const { frontmatter, body } = splitFrontmatter("---\n---\nbody");
    expect(frontmatter).toBe("");
    expect(body).toBe("body");
  });
});

describe("resolveAgentPath", () => {
  test("plain names resolve under <repoRoot>/.agents/agents/", () => {
    expect(resolveAgentPath("implementer", "/wf", "/repo")).toBe("/repo/.agents/agents/implementer.md");
  });

  test("a ref containing / resolves relative to the workflow dir", () => {
    expect(resolveAgentPath("./team/reviewer.md", "/wf/flows", "/repo")).toBe("/wf/flows/team/reviewer.md");
  });

  test("a ref ending in .md resolves relative to the workflow dir", () => {
    expect(resolveAgentPath("reviewer.md", "/wf/flows", "/repo")).toBe("/wf/flows/reviewer.md");
  });

  test("plain names with path-hostile characters are rejected, with guidance", () => {
    try {
      resolveAgentPath("bad name", "/wf", "/repo");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toBe('invalid agent reference "bad name"');
      expect((err as SaoError).hint).toBe(
        "use a plain name (resolved under .agents/agents/) or a path containing / or ending in .md",
      );
    }
  });
});

describe("loadAgent", () => {
  test("maps frontmatter settings and body onto the spec", () => {
    const path = agentFile(
      "---\nname: impl\nmodel: sonnet\nrunner: claude\npermission_mode: plan\nallowed_tools: [mcp__jira]\ntools: Read, Write\n---\n\nBe careful.\n",
    );
    const agent = loadAgent("impl", path);
    expect(agent.model).toBe("sonnet");
    expect(agent.runner).toBe("claude");
    expect(agent.permissionMode).toBe("plan");
    expect(agent.allowedTools).toEqual(["mcp__jira"]);
    expect(agent.systemPrompt).toBe("Be careful.");
  });

  test("unknown frontmatter keys (tools:, color:) are ignored, not rejected", () => {
    const agent = loadAgent("x", agentFile("---\ncolor: red\ntools: Bash\n---\nbody"));
    expect(agent.systemPrompt).toBe("body");
    expect(agent.model).toBeUndefined();
  });

  test("a file with no frontmatter is all system prompt", () => {
    const agent = loadAgent("x", agentFile("Just a persona."));
    expect(agent.systemPrompt).toBe("Just a persona.");
  });

  test("a missing file names the agent and the path", () => {
    try {
      loadAgent("ghost", "/nope/ghost.md");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toBe('agent "ghost": file not found: /nope/ghost.md');
      expect((err as SaoError).hint).toBe("create it, or fix the agent: reference");
    }
  });

  test("an empty body is rejected — the body is the system prompt", () => {
    try {
      loadAgent("x", agentFile("---\nmodel: haiku\n---\n\n  \n"));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toContain("has an empty body");
      expect((err as SaoError).hint).toBe("the body becomes the agent's system prompt");
    }
  });

  test("an empty frontmatter block loads cleanly with no settings", () => {
    const agent = loadAgent("x", agentFile("---\n---\nbody"));
    expect(agent.systemPrompt).toBe("body");
    expect(agent.model).toBeUndefined();
    expect(agent.runner).toBeUndefined();
  });

  test("invalid frontmatter YAML is a SaoError, not a crash", () => {
    expect(() => loadAgent("x", agentFile("---\n{ not yaml\n---\nbody"))).toThrow("invalid frontmatter YAML");
  });

  test("a scalar frontmatter document is rejected as a non-mapping", () => {
    expect(() => loadAgent("x", agentFile("---\n42\n---\nbody"))).toThrow("must be a YAML mapping");
  });

  test("nested frontmatter issues report a dotted path with a colon separator", () => {
    try {
      loadAgent("x", agentFile('---\nallowed_tools: [""]\n---\nbody'));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).hint).toContain("allowed_tools.0: ");
    }
  });

  test("multiple frontmatter issues arrive one per line", () => {
    try {
      loadAgent("x", agentFile('---\nmodel: ""\nrunner: ""\n---\nbody'));
      throw new Error("should have thrown");
    } catch (err) {
      const hint = (err as SaoError).hint ?? "";
      const lines = hint.split("\n");
      expect(lines).toHaveLength(2); // newline-joined, one issue per line
      expect(lines.some((line) => line.startsWith("model: "))).toBe(true);
      expect(lines.some((line) => line.startsWith("runner: "))).toBe(true);
    }
  });

  test("empty-string settings are rejected, naming the offending key", () => {
    try {
      loadAgent("x", agentFile('---\nmodel: ""\n---\nbody'));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toContain("invalid frontmatter");
      expect((err as SaoError).hint).toContain("model");
    }
  });

  test("allowed_tools: [] in frontmatter is rejected like everywhere else", () => {
    try {
      loadAgent("x", agentFile("---\nallowed_tools: []\n---\nbody"));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).hint).toContain("allowed_tools cannot be empty");
    }
  });

  test("a body of exactly the argv budget is accepted (boundary)", () => {
    const body = "x".repeat(100_000);
    expect(loadAgent("x", agentFile(`---\nmodel: haiku\n---\n${body}`)).systemPrompt).toHaveLength(100_000);
  });

  test("a body larger than the argv budget fails at load time, not as E2BIG at spawn", () => {
    const huge = "x".repeat(100_001);
    try {
      loadAgent("x", agentFile(`---\nmodel: haiku\n---\n${huge}`));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toContain("body is 100001 characters (max 100000)");
      expect((err as SaoError).hint).toContain("size-limited by the OS");
    }
  });

  test("CRLF regression: the last frontmatter value carries no trailing CR", () => {
    const agent = loadAgent("x", agentFile("---\r\nmodel: sonnet\r\n---\r\nbody"));
    expect(agent.model).toBe("sonnet");
  });
});

describe("collectAgentRefs", () => {
  test("collects from AI nodes, loop nodes, and steps, deduplicated", () => {
    const dir = temp();
    mkdirSync(join(dir, ".agents", "agents"), { recursive: true });
    for (const name of ["planner", "builder", "checker"]) {
      writeFileSync(join(dir, ".agents", "agents", `${name}.md`), `persona ${name}`);
    }
    const path = join(dir, "wf.yaml");
    writeFileSync(
      path,
      `
name: agents
nodes:
  - id: plan
    agent: planner
    prompt: "plan"
  - id: build
    agent: builder
    loop:
      steps:
        - prompt: "build"
        - agent: checker
          prompt: "check"
        - agent: builder
          prompt: "fix"
      until: DONE
      max_iterations: 2
`,
    );
    const workflow = loadWorkflow(path, { cwd: dir });
    expect(collectAgentRefs(workflow.nodes)).toEqual(new Set(["planner", "builder", "checker"]));
    expect([...workflow.agents.keys()].sort()).toEqual(["builder", "checker", "planner"]);
    expect(workflow.agents.get("planner")!.systemPrompt).toBe("persona planner");
  });

  test("a missing agent file fails loadWorkflow with the agent name", () => {
    const dir = temp();
    const path = join(dir, "wf.yaml");
    writeFileSync(
      path,
      `
name: missing-agent
nodes:
  - id: a
    agent: ghost
    prompt: "hi"
`,
    );
    expect(() => loadWorkflow(path, { cwd: dir })).toThrow('agent "ghost": file not found');
  });
});
