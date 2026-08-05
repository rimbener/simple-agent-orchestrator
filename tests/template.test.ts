import { describe, expect, test } from "bun:test";
import { collectRefs, interpolate, nodeOutputRef } from "../src/template";

const ctx = {
  task: "add dark mode",
  inputs: { issue: "123" },
  nodeOutputs: { plan: "the plan" },
};

describe("interpolate", () => {
  test("replaces task, inputs, and node outputs", () => {
    expect(interpolate("do {{task}} for #{{issue}}: {{nodes.plan.output}}", ctx)).toBe(
      "do add dark mode for #123: the plan",
    );
  });

  test("tolerates whitespace inside braces", () => {
    expect(interpolate("{{ task }}", ctx)).toBe("add dark mode");
  });

  test("leaves brace-free text alone", () => {
    expect(interpolate("nothing here", ctx)).toBe("nothing here");
  });

  test("loop refs resolve when a loop context is present", () => {
    const loopCtx = { ...ctx, loop: { feedback: "tighten it", iteration: 4 } };
    expect(interpolate("{{loop.feedback}} @ {{loop.iteration}}", loopCtx)).toBe("tighten it @ 4");
  });

  test("loop refs outside a loop context throw the loop-scoping error", () => {
    expect(() => interpolate("{{loop.feedback}}", ctx)).toThrow(
      "{{loop.feedback}} is only available inside loop nodes",
    );
    expect(() => interpolate("{{loop.iteration}}", ctx)).toThrow("only available inside loop nodes");
  });

  test("throws on unknown reference", () => {
    expect(() => interpolate("{{nope}}", ctx)).toThrow('unknown template reference {{nope}}');
  });

  test("throws when a node output is not available yet", () => {
    expect(() => interpolate("{{nodes.missing.output}}", ctx)).toThrow('has not produced output');
  });

  test("never reads node outputs off the prototype chain", () => {
    expect(() => interpolate("{{nodes.constructor.output}}", ctx)).toThrow("has not produced output");
    expect(() => interpolate("{{nodes.hasOwnProperty.output}}", ctx)).toThrow("has not produced output");
  });
});

describe("collectRefs", () => {
  test("finds all references in order", () => {
    expect(collectRefs("{{task}} {{issue}} {{nodes.plan.output}}")).toEqual(["task", "issue", "nodes.plan.output"]);
  });

  test("empty for plain text", () => {
    expect(collectRefs("plain")).toEqual([]);
  });
});

describe("nodeOutputRef", () => {
  test("extracts the node id", () => {
    expect(nodeOutputRef("nodes.plan.output")).toBe("plan");
    expect(nodeOutputRef("nodes.a.output")).toBe("a");
  });

  test("undefined for non-node refs", () => {
    expect(nodeOutputRef("task")).toBeUndefined();
    expect(nodeOutputRef("nodes.plan.result")).toBeUndefined();
  });

  test("undefined when the ref has a prefix before nodes.", () => {
    expect(nodeOutputRef("xnodes.a.output")).toBeUndefined();
  });

  test("undefined when the ref continues past .output", () => {
    expect(nodeOutputRef("nodes.a.outputx")).toBeUndefined();
    expect(nodeOutputRef("nodes.a.output.b")).toBeUndefined();
  });
});
