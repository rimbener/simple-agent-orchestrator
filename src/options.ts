import { z } from "zod";

export type AgentOption = { id: string; label: string; description?: string };

const AgentOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

const AgentOptionsSchema = z.array(AgentOptionSchema).min(1);

const OPTIONS_BLOCK = /<options>([\s\S]*?)<\/options>/g;

/** Instruction the engine appends beside sentinelInstruction() for interactive loops. */
export const AGENT_OPTIONS_INSTRUCTION =
  "\n\nIf it would help the human decide, end your response with a last line of the form " +
  '<options>[{"id": "...", "label": "...", "description": "..."}]</options> holding a JSON array of the ' +
  "options you want to offer (description is optional). Ids must be unique and must not start with " +
  '"sao:" (reserved).';

export function parseAgentOptions(text: string): AgentOption[] | undefined {
  const matches = [...text.matchAll(OPTIONS_BLOCK)];
  const lastMatch = matches.at(-1);
  if (lastMatch === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastMatch[1] ?? "");
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
