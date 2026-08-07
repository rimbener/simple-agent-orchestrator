import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaoError } from "../src/errors";
import { loadWorkflow, orderNodes } from "../src/parser";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

function tempWorkflow(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sao-test-"));
  const path = join(dir, "workflow.yaml");
  writeFileSync(path, yaml);
  return path;
}

/** Loads a workflow expected to fail, returning the SaoError and the temp path for exact-message asserts. */
function loadFailure(yaml: string): { path: string; err: SaoError } {
  const path = tempWorkflow(yaml);
  try {
    loadWorkflow(path);
  } catch (err) {
    expect(err).toBeInstanceOf(SaoError);
    return { path, err: err as SaoError };
  }
  throw new Error("expected loadWorkflow to throw");
}

describe("loadWorkflow", () => {
  test("parses a valid workflow", () => {
    const workflow = loadWorkflow(join(FIXTURES, "valid.yaml"));
    expect(workflow.name).toBe("valid");
    expect(workflow.nodes.map((n) => n.kind)).toEqual(["ai", "bash", "ai"]);
    expect(workflow.inputs).toHaveLength(2);
  });

  test("rejects workflow names with path characters", () => {
    const path = tempWorkflow(`
name: ../../../../tmp/sao-pwn
nodes:
  - id: a
    bash: "true"
`);
    expect(() => loadWorkflow(path)).toThrow("invalid workflow");
  });

  test("rejects a missing file", () => {
    expect(() => loadWorkflow("/nope/missing.yaml")).toThrow("cannot read workflow file");
  });

  test("rejects duplicate node ids", () => {
    const path = tempWorkflow(`
name: dup
nodes:
  - id: a
    bash: "true"
  - id: a
    bash: "true"
`);
    expect(() => loadWorkflow(path)).toThrow('duplicate node id "a"');
  });

  test("rejects node ids that collide ignoring case (they name log files)", () => {
    const path = tempWorkflow(`
name: case-collide
nodes:
  - id: Build
    bash: "true"
  - id: build
    bash: "true"
`);
    expect(() => loadWorkflow(path)).toThrow('node id "build" collides with "Build"');
  });

  test("rejects unknown dependencies", () => {
    const path = tempWorkflow(`
name: baddep
nodes:
  - id: a
    depends_on: [ghost]
    bash: "true"
`);
    expect(() => loadWorkflow(path)).toThrow('depends on unknown node "ghost"');
  });

  test("rejects dependency cycles", () => {
    const path = tempWorkflow(`
name: cycle
nodes:
  - id: a
    depends_on: [b]
    bash: "true"
  - id: b
    depends_on: [a]
    bash: "true"
`);
    expect(() => loadWorkflow(path)).toThrow("dependency cycle");
  });

  test("rejects node output references without a dependency path", () => {
    const path = tempWorkflow(`
name: badref
nodes:
  - id: a
    bash: "true"
  - id: b
    bash: "echo {{nodes.a.output}}"
`);
    expect(() => loadWorkflow(path)).toThrow("references a node it does not depend on");
  });

  test("rejects undeclared input references", () => {
    const path = tempWorkflow(`
name: badinput
nodes:
  - id: a
    bash: "echo {{mystery}}"
`);
    expect(() => loadWorkflow(path)).toThrow("unknown template reference {{mystery}}");
  });

  test("loop nodes get a friendly not-yet error", () => {
    const path = tempWorkflow(`
name: loopy
nodes:
  - id: a
    loop:
      prompt: "go"
      until: DONE
      max_iterations: 3
`);
    expect(() => loadWorkflow(path)).toThrow("loop nodes land in M2");
  });

  test("gate nodes get a friendly not-yet error", () => {
    const path = tempWorkflow(`
name: gated
nodes:
  - id: a
    gate:
      message: "ok?"
`);
    expect(() => loadWorkflow(path)).toThrow("gate nodes land in M2");
  });

  test("rejects nodes with both prompt and bash", () => {
    const path = tempWorkflow(`
name: both
nodes:
  - id: a
    prompt: "hi"
    bash: "true"
`);
    expect(() => loadWorkflow(path)).toThrow("exactly one of");
  });

  test("rejects unknown node keys", () => {
    const path = tempWorkflow(`
name: extra
nodes:
  - id: a
    bash: "true"
    color: red
`);
    expect(() => loadWorkflow(path)).toThrow("invalid node");
  });

  test("rejects references to optional inputs without a default", () => {
    const path = tempWorkflow(`
name: unset-optional
inputs:
  - name: audience
nodes:
  - id: a
    bash: "echo {{audience}}"
`);
    expect(() => loadWorkflow(path)).toThrow('references optional input "audience"');
  });

  test("accepts references to optional inputs that have a default", () => {
    const path = tempWorkflow(`
name: defaulted-optional
inputs:
  - name: audience
    default: world
nodes:
  - id: a
    bash: "echo {{audience}}"
`);
    expect(loadWorkflow(path).name).toBe("defaulted-optional");
  });

  test("rejects a reserved task input", () => {
    const path = tempWorkflow(`
name: reserved
inputs:
  - name: task
nodes:
  - id: a
    bash: "true"
`);
    expect(() => loadWorkflow(path)).toThrow('input "task" is reserved');
  });

  test("rejects run-metadata names as inputs", () => {
    for (const name of ["base", "branch", "run_id"]) {
      const path = tempWorkflow(`
name: reserved-meta
inputs:
  - name: ${name}
nodes:
  - id: a
    bash: "true"
`);
      expect(() => loadWorkflow(path)).toThrow(`input "${name}" is reserved for run metadata`);
    }
  });

  test("run-metadata template refs point at M3", () => {
    const path = tempWorkflow(`
name: meta-ref
nodes:
  - id: a
    bash: "echo {{run_id}}"
`);
    expect(() => loadWorkflow(path)).toThrow("{{run_id}} is run metadata — templating for it lands in M3");
  });

  test("base: gets a friendly not-yet error", () => {
    const path = tempWorkflow(`
name: based
base: main
nodes:
  - id: a
    bash: "true"
`);
    expect(() => loadWorkflow(path)).toThrow("worktree-per-run lands in M3");
  });

  test("rejects timeouts beyond the setTimeout-safe cap", () => {
    const path = tempWorkflow(`
name: too-long
nodes:
  - id: a
    bash: "true"
    timeout: 2147484
`);
    try {
      loadWorkflow(path);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).hint).toContain("at most 604800");
    }
  });
});

describe("exact error contracts", () => {
  test("missing file error names the path", () => {
    try {
      loadWorkflow("/nope/missing.yaml");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toBe("cannot read workflow file: /nope/missing.yaml");
    }
  });

  test("invalid YAML reports the path and carries the parser detail as hint", () => {
    const { path, err } = loadFailure("name: [unclosed\n");
    expect(err.message).toBe(`invalid YAML in ${path}`);
    expect(typeof err.hint).toBe("string");
    expect(err.hint!.length).toBeGreaterThan(0);
  });

  test("an empty document is rejected as a non-mapping", () => {
    const { path, err } = loadFailure("");
    expect(err.message).toBe(`${path} must be a YAML mapping with name: and nodes:`);
  });

  test("a scalar document is rejected as a non-mapping", () => {
    const { path, err } = loadFailure("42\n");
    expect(err.message).toBe(`${path} must be a YAML mapping with name: and nodes:`);
  });

  test("a sequence document is rejected as a non-mapping", () => {
    const { path, err } = loadFailure("- a\n- b\n");
    expect(err.message).toBe(`${path} must be a YAML mapping with name: and nodes:`);
  });

  test("mcp: names the M2 milestone exactly", () => {
    const { err } = loadFailure(`
name: mcp-flow
mcp:
  jira: {}
nodes:
  - id: a
    bash: "true"
`);
    expect(err.message).toBe("mcp: is not supported yet — MCP passthrough lands in M2");
  });

  test("base: names the M3 milestone exactly", () => {
    const { err } = loadFailure(`
name: based-exact
base: main
nodes:
  - id: a
    bash: "true"
`);
    expect(err.message).toBe("base: is not supported yet — worktree-per-run lands in M3");
  });

  test("a null defaults: falls through to schema validation instead of crashing", () => {
    const { path, err } = loadFailure(`
name: nulldefaults
defaults:
nodes:
  - id: a
    bash: "true"
`);
    expect(err.message).toBe(`invalid workflow: ${path}`);
    expect(err.hint).toBe("defaults: Expected object, received null");
  });

  test("defaults.allowed_tools names the M2 milestone exactly", () => {
    const { err } = loadFailure(`
name: futuredefaults
defaults:
  allowed_tools: []
nodes:
  - id: a
    bash: "true"
`);
    expect(err.message).toBe("defaults.allowed_tools: is not supported yet — MCP/allowed-tools passthrough lands in M2");
  });

  test("an unknown top-level key reports a (root) zod issue", () => {
    const { path, err } = loadFailure(`
name: extratop
foo: 1
nodes:
  - id: a
    bash: "true"
`);
    expect(err.message).toBe(`invalid workflow: ${path}`);
    expect(err.hint).toBe("(root): Unrecognized key(s) in object: 'foo'");
  });

  test("a nested zod issue joins its path with dots", () => {
    const { path, err } = loadFailure(`
name: badinputtype
inputs:
  - name: 7
nodes:
  - id: a
    bash: "true"
`);
    expect(err.message).toBe(`invalid workflow: ${path}`);
    expect(err.hint).toBe("inputs.0.name: Expected string, received number");
  });

  test("a scalar node is labeled by position", () => {
    const { err } = loadFailure(`
name: scalarnode
nodes:
  - oops
`);
    expect(err.message).toBe("node #1 must be a mapping");
  });

  test("a scalar node in second position is labeled node #2", () => {
    const { err } = loadFailure(`
name: scalar2
nodes:
  - id: a
    bash: "true"
  - oops
`);
    expect(err.message).toBe("node #2 must be a mapping");
  });

  test("a null node is labeled by position", () => {
    const { err } = loadFailure(`
name: nullnode
nodes:
  - ~
`);
    expect(err.message).toBe("node #1 must be a mapping");
  });

  test("a sequence node is labeled by position", () => {
    const { err } = loadFailure(`
name: arrnode
nodes:
  - [x, y]
`);
    expect(err.message).toBe("node #1 must be a mapping");
  });

  test("a node with a non-string id falls back to the positional label", () => {
    const { err } = loadFailure(`
name: numid
nodes:
  - id: 7
    bash: "true"
`);
    expect(err.message).toBe("invalid node #1");
    expect(err.hint).toBe("id: Expected string, received number");
  });

  test("agent: on a node names the M2 milestone exactly", () => {
    const { err } = loadFailure(`
name: agentnode
nodes:
  - id: a
    bash: "true"
    agent: reviewer.md
`);
    expect(err.message).toBe('node "a": agent: is not supported yet — agent files land in M2');
  });

  test("when_bash: on a node names the M2 milestone exactly", () => {
    const { err } = loadFailure(`
name: whennode
nodes:
  - id: a
    bash: "true"
    when_bash: "true"
`);
    expect(err.message).toBe('node "a": when_bash: is not supported yet — when_bash lands in M2');
  });

  test("allowed_tools: on a node names the M2 milestone exactly", () => {
    const { err } = loadFailure(`
name: toolsnode
nodes:
  - id: a
    bash: "true"
    allowed_tools: []
`);
    expect(err.message).toBe('node "a": allowed_tools: is not supported yet — MCP/allowed-tools passthrough lands in M2');
  });

  test("loop nodes name the M2 milestone with the node label", () => {
    const { err } = loadFailure(`
name: loopy-exact
nodes:
  - id: a
    loop:
      prompt: go
`);
    expect(err.message).toBe('node "a": loop nodes land in M2');
  });

  test("a node with no type key reports (found none)", () => {
    const { err } = loadFailure(`
name: nonekeys
nodes:
  - id: a
`);
    expect(err.message).toBe('node "a" must have exactly one of prompt: | bash: | loop: | gate: (found none)');
  });

  test("a node with two type keys lists them comma-separated", () => {
    const { err } = loadFailure(`
name: bothexact
nodes:
  - id: a
    prompt: hi
    bash: "true"
`);
    expect(err.message).toBe('node "a" must have exactly one of prompt: | bash: | loop: | gate: (found prompt, bash)');
  });

  test("an invalid ai node reports each zod issue on its own line", () => {
    const { err } = loadFailure(`
name: badai
nodes:
  - id: a
    prompt: 7
    color: red
`);
    expect(err.message).toBe('invalid node "a"');
    expect(err.hint).toBe("prompt: Expected string, received number\n(root): Unrecognized key(s) in object: 'color'");
  });

  test("the reserved task input message is exact", () => {
    const { err } = loadFailure(`
name: reserved-exact
inputs:
  - name: task
nodes:
  - id: a
    bash: "true"
`);
    expect(err.message).toBe(`input "task" is reserved for the CLI's positional task text`);
  });

  test("the run-metadata input message is exact", () => {
    for (const name of ["base", "branch", "run_id"]) {
      const { err } = loadFailure(`
name: meta-exact
inputs:
  - name: ${name}
nodes:
  - id: a
    bash: "true"
`);
      expect(err.message).toBe(`input "${name}" is reserved for run metadata (templating for it lands in M3)`);
    }
  });

  test("duplicate inputs are rejected by name", () => {
    const { err } = loadFailure(`
name: dupinput
inputs:
  - name: x
  - name: x
nodes:
  - id: a
    bash: "true"
`);
    expect(err.message).toBe('duplicate input "x"');
  });

  test("the duplicate node id message is exact", () => {
    const { err } = loadFailure(`
name: dup-exact
nodes:
  - id: a
    bash: "true"
  - id: a
    bash: "true"
`);
    expect(err.message).toBe('duplicate node id "a"');
  });

  test("the case-collision message is exact", () => {
    const { err } = loadFailure(`
name: collide-exact
nodes:
  - id: b
    bash: "true"
  - id: B
    bash: "true"
`);
    expect(err.message).toBe('node id "B" collides with "b" — ids must be unique ignoring case');
  });

  test("self-dependencies are rejected", () => {
    const { err } = loadFailure(`
name: selfdep
nodes:
  - id: a
    depends_on: [a]
    bash: "true"
`);
    expect(err.message).toBe('node "a" depends on itself');
  });

  test("the unknown dependency message is exact", () => {
    const { err } = loadFailure(`
name: baddep-exact
nodes:
  - id: a
    depends_on: [ghost]
    bash: "true"
`);
    expect(err.message).toBe('node "a" depends on unknown node "ghost"');
  });

  test("the cycle message lists only the stuck nodes in YAML order", () => {
    const { err } = loadFailure(`
name: cycle-exact
nodes:
  - id: c
    bash: "true"
  - id: a
    depends_on: [b]
    bash: "true"
  - id: b
    depends_on: [a]
    bash: "true"
`);
    expect(err.message).toBe("dependency cycle involving: a, b");
  });

  test("metadata template refs name the M3 milestone with the node label", () => {
    const { err } = loadFailure(`
name: metaref
nodes:
  - id: a
    bash: "echo {{base}}"
`);
    expect(err.message).toBe('node "a": {{base}} is run metadata — templating for it lands in M3');
  });

  test("node output refs to unknown nodes are exact", () => {
    const { err } = loadFailure(`
name: ghostref
nodes:
  - id: a
    bash: "echo {{nodes.ghost.output}}"
`);
    expect(err.message).toBe('node "a": {{nodes.ghost.output}} references unknown node "ghost"');
  });

  test("node output refs without a dependency path carry a depends_on hint", () => {
    const { err } = loadFailure(`
name: nodep
nodes:
  - id: a
    bash: "true"
  - id: b
    bash: "echo {{nodes.a.output}}"
`);
    expect(err.message).toBe('node "b": {{nodes.a.output}} references a node it does not depend on');
    expect(err.hint).toBe('add "a" to depends_on (directly or transitively) so its output exists when "b" runs');
  });

  test("dotted unknown refs hint at the nodes.<id>.output form", () => {
    const { err } = loadFailure(`
name: dotted
nodes:
  - id: a
    bash: "echo {{a.b}}"
`);
    expect(err.message).toBe('node "a": unknown template reference {{a.b}}');
    expect(err.hint).toBe("node outputs are referenced as {{nodes.<id>.output}}");
  });

  test("plain unknown refs hint at inputs: or {{task}}", () => {
    const { err } = loadFailure(`
name: plainref
nodes:
  - id: a
    bash: "echo {{mystery}}"
`);
    expect(err.message).toBe('node "a": unknown template reference {{mystery}}');
    expect(err.hint).toBe("declare it under inputs: or pass it as the task text via {{task}}");
  });

  test("refs to optional inputs without a default carry a required/default hint", () => {
    const { err } = loadFailure(`
name: optref
inputs:
  - name: audience
nodes:
  - id: a
    bash: "echo {{audience}}"
`);
    expect(err.message).toBe('node "a": {{audience}} references optional input "audience", which may be unset at run time');
    expect(err.hint).toBe("mark it required: true or give it a default: so the reference always has a value");
  });

  test("refs through a transitive dependency are accepted", () => {
    const path = tempWorkflow(`
name: transitive
nodes:
  - id: a
    bash: "true"
  - id: b
    depends_on: [a]
    bash: "true"
  - id: c
    depends_on: [b]
    bash: "echo {{nodes.a.output}}"
`);
    const workflow = loadWorkflow(path);
    expect(workflow.name).toBe("transitive");
  });

  test("deep chains with duplicated deps resolve fast and accept transitive refs", () => {
    // Each node depends on its predecessor twice: without the memoization cache
    // in buildTransitiveDeps this resolves in O(2^depth) instead of O(depth).
    const depth = 28;
    const lines = ["name: deep", "nodes:", "  - id: n0", '    bash: "true"'];
    for (let i = 1; i < depth; i++) {
      lines.push(
        `  - id: n${i}`,
        `    depends_on: [n${i - 1}, n${i - 1}]`,
        `    bash: "${i === depth - 1 ? "echo {{nodes.n0.output}}" : "true"}"`,
      );
    }
    const workflow = loadWorkflow(tempWorkflow(`${lines.join("\n")}\n`));
    expect(workflow.nodes).toHaveLength(depth);
    expect(orderNodes(workflow)[0]!.id).toBe("n0");
  });
});

describe("examples", () => {
  const EXAMPLES = new URL("../examples/", import.meta.url).pathname;

  test("hello.yaml stays valid", () => {
    const workflow = loadWorkflow(join(EXAMPLES, "hello.yaml"));
    expect(workflow.nodes.length).toBeGreaterThan(0);
  });

  test("examples using future features fail with a named milestone", () => {
    for (const file of ["jira-bug-fix.yaml", "jira-orchestrator.yaml", "ticket-orchestrator.yaml"]) {
      expect(() => loadWorkflow(join(EXAMPLES, file))).toThrow(/lands in M\d/);
    }
  });
});

describe("orderNodes", () => {
  test("orders by dependencies, stable on ties", () => {
    const path = tempWorkflow(`
name: order
nodes:
  - id: last
    depends_on: [mid]
    bash: "true"
  - id: first
    bash: "true"
  - id: mid
    depends_on: [first]
    bash: "true"
  - id: also-first
    bash: "true"
`);
    const workflow = loadWorkflow(path);
    expect(orderNodes(workflow).map((n) => n.id)).toEqual(["first", "also-first", "mid", "last"]);
  });
});
