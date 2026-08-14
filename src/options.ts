import { z } from "zod";

export type AgentOption = { id: string; label: string; description?: string };

const AgentOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

const AgentOptionsSchema = z.array(AgentOptionSchema).min(1);

/** Reused by src/render.ts so the pause block can never diverge from what the picker consumes. */
export const OPTIONS_BLOCK = /<options>([\s\S]*?)<\/options>/g;

/** Instruction the engine appends beside sentinelInstruction() for interactive loops. */
export const AGENT_OPTIONS_INSTRUCTION =
  "\n\nIf it would help the human decide, end your response with a last line of the form " +
  '<options>[{"id": "...", "label": "...", "description": "..."}]</options> holding a JSON array of the ' +
  "options you want to offer (description is optional). Ids must be unique and must not start with " +
  '"sao:" (reserved).';

export function parseAgentOptions(text: string): AgentOption[] | undefined {
  const matches = [...text.matchAll(OPTIONS_BLOCK)];
  const lastMatch = matches.at(-1);
  // Stryker disable next-line ConditionalExpression: equivalent — lastMatch[1] on undefined throws,
  // caught below, same "return undefined" result either way.
  if (lastMatch === undefined) return undefined;

  let parsed: unknown;
  try {
    // Stryker disable next-line StringLiteral: equivalent — the single capturing group in OPTIONS_BLOCK
    // always participates in a match, so lastMatch[1] is never nullish; the fallback never runs.
    parsed = JSON.parse(lastMatch[1] ?? "");
    // KNOWN SURVIVOR: the catch block's BlockStatement mutant (`} catch {}`) is equivalent — the
    // throw happens mid-assignment so parsed stays undefined either way, and safeParse(undefined)
    // below fails the same schema check, returning undefined regardless.
    //
    // It cannot be silenced with `disable next-line`. The mutant sits on the `} catch {` line, the
    // same brace-continuation shape as `} else if` / `} finally`, which that directive cannot reach.
    // Verified against three real Stryker runs — comment inside the block, comment as the try's last
    // line, and `catch` on its own line — all left it Survived (the last is also undone by
    // `bun run format`). Silencing it needs a `disable`/`restore` RANGE pair, whose own end-of-file
    // trap makes that a deliberate change, not a drive-by one.
  } catch {
    return undefined;
  }

  const result = AgentOptionsSchema.safeParse(parsed);
  if (!result.success) return undefined;

  const ids = new Set<string>();
  for (const option of result.data) {
    if (option.id.startsWith("sao:") || ids.has(option.id)) return undefined;
    ids.add(option.id);
  }

  return result.data;
}
