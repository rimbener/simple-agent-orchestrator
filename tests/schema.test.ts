import { describe, expect, test } from "bun:test";
import { aiNodeSchema, workflowTopSchema } from "../src/schema";

const aiNode = (id: string) => ({ id, prompt: "do something" });

const workflow = (overrides: Record<string, unknown> = {}) => ({
  name: "wf",
  nodes: [{ id: "a", prompt: "p" }],
  ...overrides,
});

describe("node id pattern", () => {
  test("rejects ids with a valid prefix but an illegal tail", () => {
    expect(aiNodeSchema.safeParse(aiNode("a b")).success).toBe(false);
    expect(aiNodeSchema.safeParse(aiNode("a!")).success).toBe(false);
  });

  test("rejects ids that do not start with a letter", () => {
    expect(aiNodeSchema.safeParse(aiNode("9a")).success).toBe(false);
    expect(aiNodeSchema.safeParse(aiNode("_a")).success).toBe(false);
  });

  test("accepts mixed-case ids with digits, dashes, and underscores", () => {
    const result = aiNodeSchema.safeParse(aiNode("A-B_2"));
    expect(result.success).toBe(true);
    expect(result.success && result.data.id).toBe("A-B_2");
  });

  test("reports the exact node id error message", () => {
    const result = aiNodeSchema.safeParse(aiNode("a!"));
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toBe(
      "node ids must start with a letter and use only letters, digits, - or _",
    );
  });
});

describe("input name pattern", () => {
  const withInput = (name: string) => workflow({ inputs: [{ name }] });

  test("rejects names with an illegal head even when the tail is valid", () => {
    expect(workflowTopSchema.safeParse(withInput("!x")).success).toBe(false);
  });

  test("rejects names with a valid head but an illegal tail", () => {
    expect(workflowTopSchema.safeParse(withInput("x!")).success).toBe(false);
  });

  test("rejects names containing dashes", () => {
    expect(workflowTopSchema.safeParse(withInput("x-y")).success).toBe(false);
  });

  test("accepts leading underscore and mixed-case names", () => {
    expect(workflowTopSchema.safeParse(withInput("_x")).success).toBe(true);
    expect(workflowTopSchema.safeParse(withInput("X9_")).success).toBe(true);
  });

  test("reports the exact input name error message", () => {
    const result = workflowTopSchema.safeParse(withInput("x!"));
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toBe("input names must be identifiers (letters, digits, _)");
  });
});

describe("workflow name", () => {
  test("rejects names with a valid prefix but an illegal tail", () => {
    expect(workflowTopSchema.safeParse(workflow({ name: "wf name" })).success).toBe(false);
  });

  test("reports the exact workflow name error message", () => {
    const result = workflowTopSchema.safeParse(workflow({ name: "9bad" }));
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toBe(
      "workflow name must start with a letter and use only letters, digits, - or _ (it becomes part of run ids and paths)",
    );
  });
});
