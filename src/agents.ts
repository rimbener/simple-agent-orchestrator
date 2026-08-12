import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError, z } from "zod";
import { SaoError } from "./errors";
import type { AgentSpec, Workflow } from "./schema";

/** Plain agent names become a path segment under .agents/agents/ — keep them path-safe. */
export const AGENT_NAME_PATTERN = /^[a-z0-9_][a-z0-9_.-]*$/i;

// The body travels to the runner via one argv slot (--append-system-prompt), so a
// runaway file must fail at validate time, not as an opaque E2BIG at spawn.
const MAX_BODY_CHARS = 100_000;

// Agent files may carry keys sao doesn't know (tools:, color:, …) — ignore, don't reject.
const frontmatterSchema = z
  .object({
    runner: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    permission_mode: z.string().min(1).optional(),
    allowed_tools: z
      .array(z.string().min(1))
      .min(1, "allowed_tools cannot be empty — omit the key to use the runner's own configuration")
      .optional(),
  })
  .passthrough();

/**
 * `agent: <name>` → `<repoRoot>/.agents/agents/<name>.md`; a ref containing `/` or
 * ending in `.md` is a path relative to the workflow file instead.
 */
export function resolveAgentPath(ref: string, workflowDir: string, repoRoot: string): string {
  if (ref.includes("/") || ref.endsWith(".md")) return resolve(workflowDir, ref);
  if (!AGENT_NAME_PATTERN.test(ref)) {
    throw new SaoError(
      `invalid agent reference "${ref}"`,
      "use a plain name (resolved under .agents/agents/) or a path containing / or ending in .md",
    );
  }
  return join(repoRoot, ".agents", "agents", `${ref}.md`);
}

/** Split leading `---` frontmatter from the markdown body. No frontmatter → all body. */
export function splitFrontmatter(text: string): { frontmatter?: string; body: string } {
  const lines = text.split("\n");
  // Stryker disable next-line OptionalChaining: equivalent — split() always yields at least one element, so lines[0] is never undefined
  if (lines[0]?.trim() !== "---") return { body: text };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      // Strip CR so a CRLF file's final frontmatter value doesn't keep a trailing
      // "\r" (which would end up on claude's argv, e.g. --model "sonnet\r").
      const frontmatter = lines
        .slice(1, i)
        .map((line) => line.replace(/\r$/, ""))
        .join("\n");
      return { frontmatter, body: lines.slice(i + 1).join("\n") };
    }
  }
  return { body: text }; // unterminated marker: treat the whole file as body
}

export function loadAgent(ref: string, path: string): AgentSpec {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new SaoError(`agent "${ref}": file not found: ${path}`, "create it, or fix the agent: reference");
  }

  const { frontmatter, body } = splitFrontmatter(raw);
  let meta: z.infer<typeof frontmatterSchema> = {};
  if (frontmatter !== undefined) {
    let doc: unknown;
    try {
      doc = parseYaml(frontmatter);
    } catch (err) {
      throw new SaoError(`agent "${ref}": invalid frontmatter YAML in ${path}`, String(err));
    }
    // Stryker disable next-line ConditionalExpression: equivalent — parseYaml returns null (never undefined) for empty documents, so the undefined clause is unreachable
    if (doc !== null && doc !== undefined) {
      if (typeof doc !== "object" || Array.isArray(doc)) {
        throw new SaoError(`agent "${ref}": frontmatter in ${path} must be a YAML mapping`);
      }
      try {
        meta = frontmatterSchema.parse(doc);
      } catch (err) {
        // Stryker disable next-line ConditionalExpression: zod .parse only throws ZodError, so forcing this guard true is unobservable
        if (!(err instanceof ZodError)) throw err;
        throw new SaoError(
          `agent "${ref}": invalid frontmatter in ${path}`,
          err.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"),
        );
      }
    }
  }

  const systemPrompt = body.trim();
  if (!systemPrompt) {
    throw new SaoError(`agent "${ref}": ${path} has an empty body`, "the body becomes the agent's system prompt");
  }
  if (systemPrompt.length > MAX_BODY_CHARS) {
    throw new SaoError(
      `agent "${ref}": body is ${systemPrompt.length} characters (max ${MAX_BODY_CHARS})`,
      "the body is passed to the runner as a single argument (--append-system-prompt), which is size-limited by the OS",
    );
  }
  return {
    ref,
    path,
    runner: meta.runner,
    model: meta.model,
    permissionMode: meta.permission_mode,
    allowedTools: meta.allowed_tools,
    systemPrompt,
  };
}

/** Every `agent:` reference in the workflow (nodes and loop steps), deduplicated. */
export function collectAgentRefs(nodes: Workflow["nodes"]): Set<string> {
  const refs = new Set<string>();
  for (const node of nodes) {
    // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — bash/gate nodes have no agent key (falsy), and a loop node's agent is added below anyway (Set dedup)
    if (node.kind === "ai" && node.agent) refs.add(node.agent);
    if (node.kind === "loop") {
      if (node.agent) refs.add(node.agent);
      // Stryker disable next-line ArrayDeclaration: equivalent — the fallback only fires for prompt loops, and any replacement array's entries fail the step.kind === "ai" check
      for (const step of node.loop.steps ?? []) {
        // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — bash steps have no agent key, so the kind check alone never changes the outcome
        if (step.kind === "ai" && step.agent) refs.add(step.agent);
      }
    }
  }
  return refs;
}

/** Resolve and load every referenced agent; throws (per SPEC) on missing/invalid files. */
export function loadAgents(nodes: Workflow["nodes"], workflowPath: string, repoRoot: string): Map<string, AgentSpec> {
  const agents = new Map<string, AgentSpec>();
  const workflowDir = dirname(workflowPath);
  for (const ref of collectAgentRefs(nodes)) {
    agents.set(ref, loadAgent(ref, resolveAgentPath(ref, workflowDir, repoRoot)));
  }
  return agents;
}
