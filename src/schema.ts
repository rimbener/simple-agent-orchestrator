import { z } from "zod";

export const NODE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/i;
export const INPUT_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/i;
export const SIGNAL_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const inputSchema = z
  .object({
    name: z.string().regex(INPUT_NAME_PATTERN, "input names must be identifiers (letters, digits, _)"),
    required: z.boolean().default(false),
    default: z.string().optional(),
  })
  .strict();

const whenBashSchema = z.string().min(1).optional();
// An empty list would silently fall back to the runner's own tool config — the one
// thing an author writing [] is trying to prevent. Omit the key for that instead.
const allowedToolsSchema = z
  .array(z.string().min(1))
  .min(1, "allowed_tools cannot be empty — omit the key to use the runner's own configuration")
  .optional();
// Settings that end up on the runner's argv must never be empty strings: "" is not
// nullish, so it would win precedence chains and produce flags like --model "".
const settingSchema = z.string().min(1).optional();

const nodeBase = {
  id: z.string().regex(NODE_ID_PATTERN, "node ids must start with a letter and use only letters, digits, - or _"),
  depends_on: z.array(z.string()).default([]),
  when_bash: whenBashSchema,
  // Capped well under setTimeout's 2^31−1 ms limit, where longer values fire instantly.
  timeout: z.number().int().positive().max(604800, "timeout must be at most 604800 seconds (7 days)").optional(),
  retries: z.number().int().min(0).default(0),
};

export const aiNodeSchema = z
  .object({
    ...nodeBase,
    prompt: z.string().min(1),
    agent: z.string().min(1).optional(),
    runner: settingSchema,
    model: settingSchema,
    allowed_tools: allowedToolsSchema,
  })
  .strict();

export const bashNodeSchema = z
  .object({
    ...nodeBase,
    bash: z.string().min(1),
  })
  .strict();

export const aiStepSchema = z
  .object({
    prompt: z.string().min(1),
    agent: z.string().min(1).optional(),
    runner: settingSchema,
    model: settingSchema,
    allowed_tools: allowedToolsSchema,
    when_bash: whenBashSchema,
  })
  .strict();

export const bashStepSchema = z
  .object({
    bash: z.string().min(1),
    when_bash: whenBashSchema,
  })
  .strict();

// prompt|steps and until|until_bash pairings are validated in the parser for
// friendly errors; steps entries are classified there too.
export const loopBodySchema = z
  .object({
    prompt: z.string().min(1).optional(),
    steps: z.array(z.unknown()).min(1).optional(),
    until: z
      .string()
      .regex(SIGNAL_PATTERN, "until: must be an UPPER_SNAKE_CASE signal name (e.g. ALL_TASKS_COMPLETE)")
      .optional(),
    until_bash: z.string().min(1).optional(),
    max_iterations: z.number().int().positive().max(1000),
    fresh_context: z.boolean().default(true),
    interactive: z.boolean().default(false),
  })
  .strict();

export const loopNodeSchema = z
  .object({
    ...nodeBase,
    loop: loopBodySchema,
    agent: z.string().min(1).optional(), // applies to every iteration; steps may override
    runner: settingSchema,
    model: settingSchema,
    allowed_tools: allowedToolsSchema,
  })
  .strict();

export const gateNodeSchema = z
  .object({
    id: nodeBase.id,
    depends_on: nodeBase.depends_on,
    when_bash: whenBashSchema,
    timeout: nodeBase.timeout, // bounds the when_bash predicate; the human wait is never time-boxed
    gate: z.object({ message: z.string().min(1) }).strict(),
  })
  .strict();

// Server definitions are the runner's contract (claude's .mcp.json shape) — sao only
// forwards them, so each server is validated as an opaque mapping.
const mcpSchema = z.union([z.string().min(1), z.record(z.string().min(1), z.record(z.string(), z.unknown()))]);

const defaultsSchema = z
  .object({
    runner: settingSchema,
    model: settingSchema,
    permission_mode: settingSchema,
    allowed_tools: allowedToolsSchema,
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
    base: settingSchema, // ref the run worktree/branch is cut from (--base wins; default: current HEAD)
    mcp: mcpSchema.optional(),
    inputs: z.array(inputSchema).default([]),
    defaults: defaultsSchema.default({}),
    nodes: z.array(z.unknown()).min(1),
  })
  .strict();

export type WorkflowInput = z.infer<typeof inputSchema>;
export type WorkflowDefaults = z.infer<typeof defaultsSchema>;
export type AiNode = z.infer<typeof aiNodeSchema> & { kind: "ai" };
export type BashNode = z.infer<typeof bashNodeSchema> & { kind: "bash" };
export type AiStep = z.infer<typeof aiStepSchema> & { kind: "ai" };
export type BashStep = z.infer<typeof bashStepSchema> & { kind: "bash" };
export type LoopStep = AiStep | BashStep;

export interface LoopBody {
  prompt?: string;
  steps?: LoopStep[];
  until?: string;
  until_bash?: string;
  max_iterations: number;
  fresh_context: boolean;
  interactive: boolean;
}

export type LoopNode = Omit<z.infer<typeof loopNodeSchema>, "loop"> & { kind: "loop"; loop: LoopBody };
export type GateNode = z.infer<typeof gateNodeSchema> & { kind: "gate" };
export type WorkflowNode = AiNode | BashNode | LoopNode | GateNode;

/** Agent persona loaded from an .md file — frontmatter settings + body as system prompt. */
export interface AgentSpec {
  ref: string;
  path: string;
  runner?: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  systemPrompt: string;
}

export interface Workflow {
  name: string;
  description?: string;
  /** Ref the run worktree/branch is cut from (--base wins; default: current HEAD). */
  base?: string;
  inputs: WorkflowInput[];
  defaults: WorkflowDefaults;
  nodes: WorkflowNode[];
  /** Inline mcp: servers, serialized to <run-dir>/mcp.json at run time. */
  mcpServers?: Record<string, unknown>;
  /** mcp: given as a file path — resolved absolute against the workflow file's dir. */
  mcpConfigPath?: string;
  /** Every agent referenced anywhere in the workflow, resolved and loaded. */
  agents: Map<string, AgentSpec>;
}
