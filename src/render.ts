import pc from "picocolors";
import { OPTIONS_BLOCK } from "./options";

type Colors = ReturnType<typeof pc.createColors>;

const PROMISE_TOKEN = /<promise>([^<]*)<\/promise>/g;

/**
 * Removes every well-formed `<options>…</options>` pair and every
 * `<promise>NAME</promise>` token, reporting the promise names removed (in the
 * order found) so a caller can warn on an unexpected one. An unclosed `<options>`
 * matches nothing and stays as ordinary text.
 */
export function strip(text: string): { text: string; signals: string[] } {
  const signals: string[] = [];
  const withoutPromises = text.replace(PROMISE_TOKEN, (_match, name: string) => {
    signals.push(name);
    return "";
  });
  const withoutOptions = withoutPromises.replace(OPTIONS_BLOCK, "");
  return { text: withoutOptions, signals };
}

// NUL cannot occur in agent text reaching here, so it is a safe inert placeholder
// that the bold/italic scan below cannot mistake for markdown syntax — unlike a
// plain space-delimited number, which a real sentence could contain verbatim.
const CODE_PLACEHOLDER = /\0(\d+)\0/g;

function renderInline(text: string, colors: Colors): string {
  const codeSpans: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return `\0${codeSpans.length - 1}\0`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, (_match, bold: string) => colors.bold(bold));
  out = out.replace(/\*([^*]+)\*/g, (_match, italic: string) => colors.italic(italic));
  out = out.replace(CODE_PLACEHOLDER, (_match, index: string) => colors.cyan(codeSpans[Number(index)]!));
  return out;
}

const HEADING = /^#{1,6}\s+(.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^-\s+(.*)$/;
const NUMBERED = /^(\d+)\.\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^```/;

function renderLine(line: string, colors: Colors): string {
  const heading = HEADING.exec(line);
  if (heading) return colors.bold(colors.cyan(renderInline(heading[1]!, colors)));

  if (RULE.test(line)) return colors.dim(line);

  const bullet = BULLET.exec(line);
  if (bullet) return `${colors.dim("•")} ${renderInline(bullet[1]!, colors)}`;

  const numbered = NUMBERED.exec(line);
  if (numbered) return `${colors.dim(`${numbered[1]}.`)} ${renderInline(numbered[2]!, colors)}`;

  const quote = QUOTE.exec(line);
  if (quote) return colors.dim(`│ ${renderInline(quote[1]!, colors)}`);

  return renderInline(line, colors);
}

/**
 * The markdown subset, styled with picocolors: ATX headings, bold/italic, inline
 * and fenced code, bullet/numbered lists, blockquotes, `---` rules. Everything else
 * — tables, nested lists, reference links, raw HTML — passes through byte-for-byte.
 * A fenced block's body is never markdown-interpreted. Total: never throws.
 */
export function render(text: string): string {
  const colors = pc.createColors(!process.env.NO_COLOR);
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    out.push(inFence ? line : renderLine(line, colors));
  }
  return out.join("\n");
}

/** The single entry point callers use: strip every marker, then render what remains. */
export function renderBlock(text: string): { block: string; signals: string[] } {
  const stripped = strip(text);
  return { block: render(stripped.text), signals: stripped.signals };
}
