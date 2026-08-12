import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaoError } from "../src/errors";
import { loadWorkflow } from "../src/parser";

function tempWorkflow(yaml: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "sao-parser-m2-"));
  const path = join(dir, "workflow.yaml");
  writeFileSync(path, yaml);
  return { dir, path };
}

function failure(yaml: string): SaoError {
  const { dir, path } = tempWorkflow(yaml);
  try {
    loadWorkflow(path, { cwd: dir });
  } catch (err) {
    if (err instanceof SaoError) return err;
    throw err;
  }
  throw new Error("expected loadWorkflow to throw");
}

describe("loop-body validation", () => {
  test("prompt and steps together are rejected", () => {
    const err = failure(`
name: both
nodes:
  - id: a
    loop:
      prompt: "go"
      steps:
        - bash: "true"
      until: DONE
      max_iterations: 1
`);
    expect(err.message).toContain("exactly one of prompt: | steps:");
  });

  test("neither prompt nor steps is rejected", () => {
    expect(
      failure(`
name: neither
nodes:
  - id: a
    loop:
      until: DONE
      max_iterations: 1
`).message,
    ).toContain("exactly one of prompt: | steps:");
  });

  test("until and until_bash together are rejected", () => {
    expect(
      failure(`
name: bothuntil
nodes:
  - id: a
    loop:
      prompt: "go"
      until: DONE
      until_bash: "true"
      max_iterations: 1
`).message,
    ).toContain("exactly one of until: | until_bash:");
  });

  test("neither until nor until_bash is rejected", () => {
    expect(
      failure(`
name: nountil
nodes:
  - id: a
    loop:
      prompt: "go"
      max_iterations: 1
`).message,
    ).toContain("exactly one of until: | until_bash:");
  });

  test("interactive loops require a sentinel until:", () => {
    const err = failure(`
name: interbash
nodes:
  - id: a
    loop:
      prompt: "go"
      until_bash: "true"
      max_iterations: 1
      interactive: true
`);
    expect(err.message).toContain("interactive loops require until:");
    expect(err.hint).toBe("the human approves on a signaled iteration; until_bash: has no signal to approve");
  });

  test("a null step is rejected with its position, not a crash", () => {
    expect(
      failure(`
name: nullstep
nodes:
  - id: a
    loop:
      steps:
        - ~
      until: DONE
      max_iterations: 1
`).message,
    ).toContain("step #1 must be a mapping");
  });

  test("fresh_context: false requires a single-prompt loop", () => {
    const err = failure(`
name: freshsteps
nodes:
  - id: a
    loop:
      steps:
        - prompt: "go"
      until: DONE
      max_iterations: 1
      fresh_context: false
`);
    expect(err.message).toContain("fresh_context: false requires a single-prompt loop");
    expect(err.hint).toBe("steps run as separate sessions, so there is no one conversation to resume");
  });

  test("until: with zero AI steps is rejected", () => {
    const err = failure(`
name: nosignaler
nodes:
  - id: a
    loop:
      steps:
        - bash: "true"
      until: DONE
      max_iterations: 1
`);
    expect(err.message).toContain("needs at least one AI step");
  });

  test("lowercase signal names are rejected", () => {
    const err = failure(`
name: lowersignal
nodes:
  - id: a
    loop:
      prompt: "go"
      until: done
      max_iterations: 1
`);
    expect(err.hint).toContain("UPPER_SNAKE_CASE");
  });

  test("a step with both prompt and bash is rejected", () => {
    expect(
      failure(`
name: bothstep
nodes:
  - id: a
    loop:
      steps:
        - prompt: "go"
          bash: "true"
      until: DONE
      max_iterations: 1
`).message,
    ).toContain("step #1 must have exactly one of prompt: | bash:");
  });

  test("a scalar step is rejected with its position", () => {
    expect(
      failure(`
name: scalarstep
nodes:
  - id: a
    loop:
      steps:
        - "oops"
      until: DONE
      max_iterations: 1
`).message,
    ).toContain("step #1 must be a mapping");
  });

  test("unknown step keys are rejected", () => {
    const err = failure(`
name: extrastep
nodes:
  - id: a
    loop:
      steps:
        - prompt: "go"
          color: red
      until: DONE
      max_iterations: 1
`);
    expect(err.message).toContain("step #1");
    expect(err.hint).toContain("color");
  });

  test("gates accept no retries (timeout is allowed, for when_bash)", () => {
    const err = failure(`
name: gateretry
nodes:
  - id: a
    gate:
      message: "ok?"
    retries: 1
`);
    expect(err.message).toBe('invalid node "a"');
    expect(err.hint).toContain("retries");
  });
});

describe("loop template scoping", () => {
  test("loop.feedback outside a loop body is rejected", () => {
    const err = failure(`
name: leak
nodes:
  - id: a
    bash: "echo {{loop.feedback}}"
`);
    expect(err.message).toContain("only available inside a loop's prompt, steps, or until_bash");
  });

  test("loop refs in a loop node's own when_bash are rejected (it runs before the loop)", () => {
    const err = failure(`
name: whenleak
nodes:
  - id: a
    when_bash: "test {{loop.iteration}} -gt 1"
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 1
`);
    expect(err.message).toContain("only available inside");
  });

  test("loop refs are allowed in step prompts, step when_bash, and until_bash", () => {
    const { dir, path } = tempWorkflow(`
name: loopscope
nodes:
  - id: a
    loop:
      steps:
        - when_bash: "test {{loop.iteration}} -gt 0"
          prompt: "iteration {{loop.iteration}}, feedback {{loop.feedback}}"
      until_bash: "test {{loop.iteration}} -ge 2"
      max_iterations: 3
`);
    expect(loadWorkflow(path, { cwd: dir }).name).toBe("loopscope");
  });

  test("every templated location is checked: AI prompts", () => {
    expect(
      failure(`
name: aicheck
nodes:
  - id: a
    prompt: "do {{mystery}}"
`).message,
    ).toContain("unknown template reference {{mystery}}");
  });

  test("loop refs in a plain AI prompt are rejected", () => {
    expect(
      failure(`
name: ailoopref
nodes:
  - id: a
    prompt: "do {{loop.iteration}}"
`).message,
    ).toContain("only available inside");
  });

  test("loop refs in a gate message are rejected", () => {
    expect(
      failure(`
name: gatelooref
nodes:
  - id: g
    gate:
      message: "iteration {{loop.iteration}} ok?"
`).message,
    ).toContain("only available inside");
  });

  test("every templated location is checked: loop prompts", () => {
    expect(
      failure(`
name: loopprompt
nodes:
  - id: a
    loop:
      prompt: "do {{mystery}}"
      until: DONE
      max_iterations: 1
`).message,
    ).toContain("unknown template reference {{mystery}}");
  });

  test("every templated location is checked: step prompts and step bash", () => {
    expect(
      failure(`
name: stepprompt
nodes:
  - id: a
    loop:
      steps:
        - prompt: "do {{mystery}}"
      until: DONE
      max_iterations: 1
`).message,
    ).toContain("unknown template reference {{mystery}}");
  });

  test("every templated location is checked: step when_bash", () => {
    expect(
      failure(`
name: stepwhen
nodes:
  - id: a
    loop:
      steps:
        - when_bash: "test -n {{mystery}}"
          prompt: "go"
      until: DONE
      max_iterations: 1
`).message,
    ).toContain("unknown template reference {{mystery}}");
  });

  test("every templated location is checked: until_bash", () => {
    expect(
      failure(`
name: untilcheck
nodes:
  - id: a
    loop:
      prompt: "go"
      until_bash: "test -n {{mystery}}"
      max_iterations: 1
`).message,
    ).toContain("unknown template reference {{mystery}}");
  });

  test("gate messages get full template checking", () => {
    const err = failure(`
name: gatetplcheck
nodes:
  - id: g
    gate:
      message: "approve {{nodes.ghost.output}}?"
`);
    expect(err.message).toContain('references unknown node "ghost"');
  });

  test("node when_bash gets full template checking", () => {
    const err = failure(`
name: whentplcheck
nodes:
  - id: a
    when_bash: "test -n {{mystery}}"
    bash: "true"
`);
    expect(err.message).toContain("unknown template reference {{mystery}}");
  });
});

describe("mcp validation", () => {
  test("an inline alias cycle fails validate, matching run's serialization", () => {
    const err = failure(`
name: mcpcycle
mcp:
  jira: &srv
    command: npx
    nested: *srv
nodes:
  - id: a
    prompt: "hi"
`);
    expect(err.message).toContain("JSON-serializable");
    expect(err.hint).toContain("cycles cannot be forwarded to the runner");
  });

  test("a directory path is rejected", () => {
    const { dir, path } = tempWorkflow(`
name: mcpdir
mcp: ./servers
nodes:
  - id: a
    prompt: "hi"
`);
    mkdirSync(join(dir, "servers"));
    expect(() => loadWorkflow(path, { cwd: dir })).toThrow("mcp: config file not found");
  });

  test("a file with malformed JSON is rejected at validate time", () => {
    const { dir, path } = tempWorkflow(`
name: mcpbadjson
mcp: ./servers.json
nodes:
  - id: a
    prompt: "hi"
`);
    writeFileSync(join(dir, "servers.json"), "{ not json");
    expect(() => loadWorkflow(path, { cwd: dir })).toThrow("not valid JSON");
  });

  test("a valid inline map and a valid file both load", () => {
    const inline = tempWorkflow(`
name: mcpinline
mcp:
  jira:
    command: npx
nodes:
  - id: a
    prompt: "hi"
`);
    expect(loadWorkflow(inline.path, { cwd: inline.dir }).mcpServers).toEqual({ jira: { command: "npx" } });

    const filed = tempWorkflow(`
name: mcpfile
mcp: ./servers.json
nodes:
  - id: a
    prompt: "hi"
`);
    writeFileSync(join(filed.dir, "servers.json"), JSON.stringify({ mcpServers: {} }));
    expect(loadWorkflow(filed.path, { cwd: filed.dir }).mcpConfigPath).toBe(join(filed.dir, "servers.json"));
  });
});

describe("empty-string settings", () => {
  test.each([
    ["defaults.model", 'defaults:\n  model: ""'],
    ["defaults.runner", 'defaults:\n  runner: ""'],
    ["defaults.permission_mode", 'defaults:\n  permission_mode: ""'],
  ])('%s: "" fails validate instead of reaching argv', (_label, snippet) => {
    const err = failure(`
name: empties
${snippet}
nodes:
  - id: a
    prompt: "hi"
`);
    expect(err.message).toContain("invalid workflow");
  });

  test("allowed_tools: [] is rejected — silent fallback to runner config is the one wrong meaning", () => {
    const err = failure(`
name: emptytools
nodes:
  - id: a
    prompt: "hi"
    allowed_tools: []
`);
    expect(err.message).toBe('invalid node "a"');
    expect(err.hint).toContain("allowed_tools cannot be empty");
  });

  test('node model: "" is rejected', () => {
    const err = failure(`
name: emptynode
nodes:
  - id: a
    prompt: "hi"
    model: ""
`);
    expect(err.message).toBe('invalid node "a"');
  });
});
