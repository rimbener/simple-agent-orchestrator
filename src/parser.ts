import { readFileSync } from "node:fs";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { ZodError } from "zod";
import { SaoError } from "./errors";
import {
  type AiNode,
  type BashNode,
  type Workflow,
  type WorkflowNode,
  aiNodeSchema,
  bashNodeSchema,
  workflowTopSchema,
} from "./schema";
import { collectRefs, nodeOutputRef } from "./template";

const NODE_TYPE_KEYS = ["prompt", "bash", "loop", "gate"] as const;
const UNIMPLEMENTED: Record<string, string> = {
  loop: "loop nodes land in M2",
  gate: "gate nodes land in M2",
};
const FUTURE_TOP_KEYS: Record<string, string> = {
  mcp: "MCP passthrough lands in M2",
  base: "worktree-per-run lands in M3",
};
/** Run-metadata names ({{base}} etc., SAO_* env) arrive with worktrees in M3. */
const METADATA_NAMES = new Set(["base", "branch", "run_id"]);
const FUTURE_DEFAULTS_KEYS: Record<string, string> = {
  allowed_tools: "MCP/allowed-tools passthrough lands in M2",
};
const FUTURE_NODE_KEYS: Record<string, string> = {
  agent: "agent files land in M2",
  when_bash: "when_bash lands in M2",
  allowed_tools: "MCP/allowed-tools passthrough lands in M2",
};

export function loadWorkflow(path: string): Workflow {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new SaoError(`cannot read workflow file: ${path}`);
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof YAMLParseError ? err.message : String(err);
    throw new SaoError(`invalid YAML in ${path}`, detail);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new SaoError(`${path} must be a YAML mapping with name: and nodes:`);
  }

  const record = doc as Record<string, unknown>;
  for (const [key, message] of Object.entries(FUTURE_TOP_KEYS)) {
    if (key in record) throw new SaoError(`${key}: is not supported yet — ${message}`);
  }
  if (record.defaults !== null && typeof record.defaults === "object") {
    for (const [key, message] of Object.entries(FUTURE_DEFAULTS_KEYS)) {
      if (key in (record.defaults as Record<string, unknown>)) {
        throw new SaoError(`defaults.${key}: is not supported yet — ${message}`);
      }
    }
  }

  let top;
  try {
    top = workflowTopSchema.parse(doc);
  } catch (err) {
    // Stryker disable next-line ConditionalExpression: zod .parse only throws ZodError, so forcing this guard true is unobservable
    if (err instanceof ZodError) throw new SaoError(`invalid workflow: ${path}`, formatZod(err));
    throw err;
  }

  const nodes = top.nodes.map((node, index) => classifyNode(node, index));
  const workflow: Workflow = { ...top, nodes };
  runStaticChecks(workflow);
  return workflow;
}

function classifyNode(raw: unknown, index: number): WorkflowNode {
  const label = () =>
    raw !== null && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
      ? `node "${(raw as { id: string }).id}"`
      : `node #${index + 1}`;

  if (raw === null || typeof raw === "object" === false || Array.isArray(raw)) {
    throw new SaoError(`${label()} must be a mapping`);
  }
  const record = raw as Record<string, unknown>;

  for (const [key, message] of Object.entries(FUTURE_NODE_KEYS)) {
    if (key in record) throw new SaoError(`${label()}: ${key}: is not supported yet — ${message}`);
  }

  const typeKeys = NODE_TYPE_KEYS.filter((key) => key in record);
  for (const key of typeKeys) {
    const pending = UNIMPLEMENTED[key];
    if (pending) throw new SaoError(`${label()}: ${pending}`);
  }
  if (typeKeys.length !== 1) {
    throw new SaoError(
      `${label()} must have exactly one of prompt: | bash: | loop: | gate: (found ${typeKeys.length === 0 ? "none" : typeKeys.join(", ")})`,
    );
  }

  try {
    if (typeKeys[0] === "prompt") {
      return { ...aiNodeSchema.parse(record), kind: "ai" } satisfies AiNode;
    }
    return { ...bashNodeSchema.parse(record), kind: "bash" } satisfies BashNode;
  } catch (err) {
    // Stryker disable next-line ConditionalExpression: zod .parse only throws ZodError, so forcing this guard true is unobservable
    if (err instanceof ZodError) throw new SaoError(`invalid ${label()}`, formatZod(err));
    throw err;
  }
}

function runStaticChecks(workflow: Workflow): void {
  const inputsByName = new Map<string, Workflow["inputs"][number]>();
  for (const input of workflow.inputs) {
    if (input.name === "task") throw new SaoError(`input "task" is reserved for the CLI's positional task text`);
    if (METADATA_NAMES.has(input.name)) {
      throw new SaoError(`input "${input.name}" is reserved for run metadata (templating for it lands in M3)`);
    }
    if (inputsByName.has(input.name)) throw new SaoError(`duplicate input "${input.name}"`);
    inputsByName.set(input.name, input);
  }

  const byId = new Map<string, WorkflowNode>();
  const idsByLower = new Map<string, string>();
  for (const node of workflow.nodes) {
    const existing = idsByLower.get(node.id.toLowerCase());
    if (existing === node.id) throw new SaoError(`duplicate node id "${node.id}"`);
    if (existing !== undefined) {
      // Log files are named <id>.log — case-colliding ids would share one on APFS/NTFS.
      throw new SaoError(`node id "${node.id}" collides with "${existing}" — ids must be unique ignoring case`);
    }
    idsByLower.set(node.id.toLowerCase(), node.id);
    byId.set(node.id, node);
  }

  for (const node of workflow.nodes) {
    for (const dep of node.depends_on) {
      if (dep === node.id) throw new SaoError(`node "${node.id}" depends on itself`);
      if (!byId.has(dep)) throw new SaoError(`node "${node.id}" depends on unknown node "${dep}"`);
    }
  }

  orderNodes(workflow); // throws on cycles

  const transitiveDeps = buildTransitiveDeps(workflow);
  for (const node of workflow.nodes) {
    const text = node.kind === "ai" ? node.prompt : node.bash;
    for (const ref of collectRefs(text)) {
      if (ref === "task") continue;
      if (METADATA_NAMES.has(ref)) {
        throw new SaoError(`node "${node.id}": {{${ref}}} is run metadata — templating for it lands in M3`);
      }
      const nodeId = nodeOutputRef(ref);
      if (nodeId !== undefined) {
        if (!byId.has(nodeId)) {
          throw new SaoError(`node "${node.id}": {{${ref}}} references unknown node "${nodeId}"`);
        }
        if (!transitiveDeps.get(node.id)!.has(nodeId)) {
          throw new SaoError(
            `node "${node.id}": {{${ref}}} references a node it does not depend on`,
            `add "${nodeId}" to depends_on (directly or transitively) so its output exists when "${node.id}" runs`,
          );
        }
        continue;
      }
      if (ref.includes(".")) {
        throw new SaoError(
          `node "${node.id}": unknown template reference {{${ref}}}`,
          "node outputs are referenced as {{nodes.<id>.output}}",
        );
      }
      const input = inputsByName.get(ref);
      if (!input) {
        throw new SaoError(
          `node "${node.id}": unknown template reference {{${ref}}}`,
          `declare it under inputs: or pass it as the task text via {{task}}`,
        );
      }
      if (!input.required && input.default === undefined) {
        throw new SaoError(
          `node "${node.id}": {{${ref}}} references optional input "${ref}", which may be unset at run time`,
          `mark it required: true or give it a default: so the reference always has a value`,
        );
      }
    }
  }
}

/** Dependency-order sort (stable: ties keep YAML file order). Throws on cycles. */
export function orderNodes(workflow: Workflow): WorkflowNode[] {
  // Stryker disable next-line ArrayDeclaration: indexOf only feeds the defensive sort below, whose comparator is unobservable (filter already yields YAML order)
  const indexOf = new Map(workflow.nodes.map((node, index) => [node.id, index]));
  const remainingDeps = new Map(workflow.nodes.map((node) => [node.id, new Set(node.depends_on)]));
  const ordered: WorkflowNode[] = [];
  const done = new Set<string>();

  while (ordered.length < workflow.nodes.length) {
    // Stryker disable next-line MethodExpression: filter() preserves YAML order, so removing the tie-break sort is unobservable
    // Stryker disable ArrowFunction,ArithmeticOperator: the ready list is already in YAML/index order, so any comparator mutation is an identity under a stable sort
    const ready = workflow.nodes
      .filter((node) => !done.has(node.id) && [...remainingDeps.get(node.id)!].every((dep) => done.has(dep)))
      .sort((a, b) => indexOf.get(a.id)! - indexOf.get(b.id)!);
    // Stryker restore ArrowFunction,ArithmeticOperator
    if (ready.length === 0) {
      const stuck = workflow.nodes.filter((node) => !done.has(node.id)).map((node) => node.id);
      throw new SaoError(`dependency cycle involving: ${stuck.join(", ")}`);
    }
    for (const node of ready) {
      ordered.push(node);
      done.add(node.id);
    }
  }
  return ordered;
}

function buildTransitiveDeps(workflow: Workflow): Map<string, Set<string>> {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const cache = new Map<string, Set<string>>();

  const resolve = (id: string): Set<string> => {
    const cached = cache.get(id);
    if (cached) return cached;
    const deps = new Set<string>();
    cache.set(id, deps); // cycle-safe; real cycles are rejected by orderNodes
    for (const dep of byId.get(id)!.depends_on) {
      deps.add(dep);
      for (const transitive of resolve(dep)) deps.add(transitive);
    }
    return deps;
  };

  for (const node of workflow.nodes) resolve(node.id);
  return cache;
}

function formatZod(err: ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("\n");
}
