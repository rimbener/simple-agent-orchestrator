import { describe, expect, test } from "bun:test";
import pc from "picocolors";
import { render, renderBlock, strip } from "../src/render";

const colors = pc.createColors(true);

describe("render — inline emphasis", () => {
  test("@s-render-emphasis: bold, italic and inline code become styling, not literal characters", () => {
    const out = render("**bold** and *italic* and `code`");
    expect(out).not.toContain("*");
    expect(out).not.toContain("`");
    expect(out).toBe(`${colors.bold("bold")} and ${colors.italic("italic")} and ${colors.cyan("code")}`);
  });

  test("unbalanced emphasis with no closer is left literal", () => {
    const out = render("**bold with no closer");
    expect(out).toBe("**bold with no closer");
  });
});

describe("render — headings and lists", () => {
  test("@s-render-headings-lists: a heading, a '-' list and a '1.' list become formatting", () => {
    const input = ["# Heading", "- item one", "1. first"].join("\n");
    const out = render(input);
    expect(out).not.toContain("#");
    expect(out).not.toContain("- item one");
    expect(out).not.toContain("1. first");
    expect(out).toBe(
      [colors.bold(colors.cyan("Heading")), `${colors.dim("•")} item one`, `${colors.dim("1.")} first`].join("\n"),
    );
  });

  test("a deeper ATX heading level keeps its own '#' count out of the text", () => {
    const out = render("### Sub");
    expect(out).toBe(colors.bold(colors.cyan("Sub")));
  });

  test("blockquotes are styled, part of the supported subset", () => {
    const out = render("> quoted line");
    expect(out).toBe(colors.dim("│ quoted line"));
  });

  test("a '---' rule is styled, part of the supported subset", () => {
    const out = render("---");
    expect(out).toBe(colors.dim("---"));
  });
});

describe("render — fenced code", () => {
  test("@s-render-fenced-code: fence markers disappear, body stays verbatim including asterisks", () => {
    const input = ["before", "```", "**not bold**", "```", "after"].join("\n");
    const out = render(input);
    expect(out).not.toContain("```");
    expect(out).toContain("**not bold**");
    expect(out).toBe(["before", "**not bold**", "after"].join("\n"));
  });

  test("markdown syntax inside a fence is never interpreted, even a heading-shaped line", () => {
    const input = ["```", "# not a heading", "```"].join("\n");
    expect(render(input)).toBe("# not a heading");
  });
});

describe("render — passthrough", () => {
  test("@s-render-passthrough: a pipe table and a nested list appear exactly as written", () => {
    const input = ["| Col1 | Col2 |", "| --- | --- |", "| val1 | val2 |", "  - nested one", "  - nested two"].join(
      "\n",
    );
    expect(render(input)).toBe(input);
  });
});

describe("render — NO_COLOR", () => {
  test("@s-render-no-color: with color disabled the block has no escapes, markdown syntax is still removed", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const out = render("# Title\n**bold**");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI ESC byte is the point.
      expect(out).not.toMatch(/\x1b\[/);
      expect(out).not.toContain("#");
      expect(out).not.toContain("**");
      expect(out).toBe("Title\nbold");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });
});

describe("strip", () => {
  test("@s-strip-options-block: every well-formed options declaration is removed", () => {
    const text = [
      "prose1",
      "<options>",
      '[{"id":"a","label":"A"}]',
      "</options>",
      "more prose",
      "<options>",
      '[{"id":"b","label":"B"}]',
      "</options>",
    ].join("\n");
    const { text: stripped } = strip(text);
    expect(stripped).not.toContain("<options>");
    expect(stripped).not.toContain("</options>");
    expect(stripped).not.toContain('"id":"a"');
    expect(stripped).not.toContain('"id":"b"');
    expect(stripped).toContain("prose1");
    expect(stripped).toContain("more prose");
  });

  test("@s-strip-options-unclosed: an options declaration with no closing tag stays visible", () => {
    const text = 'prose <options>[{"id":"a","label":"A"}]';
    expect(strip(text).text).toBe(text);
  });

  test("@s-strip-promise-any: any promise token is removed regardless of its name", () => {
    const text = "done <promise>WHATEVER_NAME</promise> end";
    const { text: stripped } = strip(text);
    expect(stripped).not.toContain("<promise>");
    expect(stripped).not.toContain("WHATEVER_NAME");
    expect(stripped).toBe("done  end");
  });

  test("@s-strip-reports-signal-names: producing the block reports which signal names were removed", () => {
    const text = "<promise>FIRST</promise> and <promise>SECOND</promise>";
    const { signals } = strip(text);
    expect(signals).toEqual(["FIRST", "SECOND"]);
  });

  test("text with no markers is returned unchanged, with no reported signals", () => {
    const { text, signals } = strip("plain text, nothing special");
    expect(text).toBe("plain text, nothing special");
    expect(signals).toEqual([]);
  });
});

describe("renderBlock", () => {
  test("composes strip then render, reporting signals alongside the rendered block", () => {
    const text = "**hi** <promise>DONE</promise>";
    const { block, signals } = renderBlock(text);
    expect(signals).toEqual(["DONE"]);
    expect(block).not.toContain("<promise>");
    expect(block).toBe(`${colors.bold("hi")} `);
  });

  test("an empty message renders an empty block and no signals", () => {
    expect(renderBlock("")).toEqual({ block: "", signals: [] });
  });
});
