import { describe, expect, test } from "bun:test";
import { AGENT_OPTIONS_INSTRUCTION, parseAgentOptions } from "../src/options";

describe("AGENT_OPTIONS_INSTRUCTION", () => {
  test("tells the agent to declare a last-line <options> block with unique, unreserved ids", () => {
    expect(AGENT_OPTIONS_INSTRUCTION).toContain("<options>");
    expect(AGENT_OPTIONS_INSTRUCTION).toContain("</options>");
    expect(AGENT_OPTIONS_INSTRUCTION).toContain("unique");
    expect(AGENT_OPTIONS_INSTRUCTION).toContain("sao:");
  });

  test("is the exact instruction text, word for word", () => {
    expect(AGENT_OPTIONS_INSTRUCTION).toBe(
      "\n\nIf it would help the human decide, end your response with a last line of the form " +
        '<options>[{"id": "...", "label": "...", "description": "..."}]</options> holding a JSON array of the ' +
        "options you want to offer (description is optional). Ids must be unique and must not start with " +
        '"sao:" (reserved).',
    );
  });
});

describe("parseAgentOptions", () => {
  test("@s-options-parsed: reads a well-formed declaration in order, keeping description", () => {
    const text = [
      "some agent prose",
      "<options>",
      '[{"id": "sqlite", "label": "Use SQLite", "description": "no server to run"}, {"id": "postgres", "label": "Use Postgres"}]',
      "</options>",
    ].join("\n");

    expect(parseAgentOptions(text)).toEqual([
      { id: "sqlite", label: "Use SQLite", description: "no server to run" },
      { id: "postgres", label: "Use Postgres" },
    ]);
  });

  test("@s-options-last-block-wins: only the last of two declarations is read", () => {
    const text = [
      "<options>",
      '[{"id": "first", "label": "First"}]',
      "</options>",
      "more prose",
      "<options>",
      '[{"id": "second", "label": "Second"}]',
      "</options>",
    ].join("\n");

    expect(parseAgentOptions(text)).toEqual([{ id: "second", label: "Second" }]);
  });

  test("@s-options-malformed-ignored: invalid JSON yields undefined, no throw", () => {
    const text = ["<options>", "not json at all", "</options>"].join("\n");

    expect(parseAgentOptions(text)).toBeUndefined();
  });

  test("@s-options-malformed-ignored: a missing closing tag yields undefined", () => {
    const text = ["<options>", '[{"id": "sqlite", "label": "Use SQLite"}]'].join("\n");

    expect(parseAgentOptions(text)).toBeUndefined();
  });

  test.each([
    ["not an array of objects", '{"id": "sqlite", "label": "Use SQLite"}'],
    ["an empty array", "[]"],
    ["a missing id", '[{"label": "Use SQLite"}]'],
    ["an empty id", '[{"id": "", "label": "Use SQLite"}]'],
    ["a missing label", '[{"id": "sqlite"}]'],
    ["an empty label", '[{"id": "sqlite", "label": ""}]'],
    ["a duplicate id", '[{"id": "sqlite", "label": "A"}, {"id": "sqlite", "label": "B"}]'],
    ["an id using the sao: prefix", '[{"id": "sao:end", "label": "End"}]'],
  ])("@s-options-invalid-shape-ignored: %s yields undefined", (_name, json) => {
    const text = ["<options>", json, "</options>"].join("\n");

    expect(parseAgentOptions(text)).toBeUndefined();
  });

  test("@s-options-absent: no declaration in the output yields undefined", () => {
    expect(parseAgentOptions("just some agent prose with no block at all")).toBeUndefined();
  });
});
