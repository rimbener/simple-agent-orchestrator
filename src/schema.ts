import { z } from "zod";

export const NODE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/i;
export const INPUT_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/i;

const inputSchema = z
  .object({
    name: z.string().regex(INPUT_NAME_PATTERN, "input names must be identifiers (letters, digits, _)"),
    required: z.boolean().default(false),
    default: z.string().optional(),
  })
  .strict();

const nodeBase = {
  id: z.string().regex(NODE_ID_PATTERN, "node ids must start with a letter and use only letters, digits, - or _"),
  depends_on: z.array(z.string()).default([]),
  // Capped well under setTimeout's 2^31−1 ms limit, where longer values fire instantly.
  timeout: z.number().int().positive().max(604800, "timeout must be at most 604800 seconds (7 days)").optional(),
  retries: z.number().int().min(0).default(0),
};

export const aiNodeSchema = z
  .object({
    ...nodeBase,
    prompt: z.string().min(1),
    runner: z.string().optional(),
    model: z.string().optional(),
  })
  .strict();

export const bashNodeSchema = z
  .object({
    ...nodeBase,
    bash: z.string().min(1),
  })
  .strict();

const defaultsSchema = z
  .object({
    runner: z.string().optional(),
    model: z.string().optional(),
    permission_mode: z.string().optional(),
  })
  .strict();

// Per-node validation happens in the parser (classifyNode) so that unsupported
// node types and shape mistakes produce friendly errors instead of a zod union dump.
export const workflowTopSchema = z
  .object({
    name: z
      .string()
      .regex(NODE_ID_PATTERN, "workflow name must start with a letter and use only letters, digits, - or _ (it becomes part of run ids and paths)"),
    description: z.string().optional(),
    inputs: z.array(inputSchema).default([]),
    defaults: defaultsSchema.default({}),
    nodes: z.array(z.unknown()).min(1),
  })
  .strict();

export type WorkflowInput = z.infer<typeof inputSchema>;
export type WorkflowDefaults = z.infer<typeof defaultsSchema>;
export type AiNode = z.infer<typeof aiNodeSchema> & { kind: "ai" };
export type BashNode = z.infer<typeof bashNodeSchema> & { kind: "bash" };
export type WorkflowNode = AiNode | BashNode;

export interface Workflow {
  name: string;
  description?: string;
  inputs: WorkflowInput[];
  defaults: WorkflowDefaults;
  nodes: WorkflowNode[];
}
