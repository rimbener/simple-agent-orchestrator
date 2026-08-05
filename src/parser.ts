import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { ZodError } from "zod";
import { loadAgents } from "./agents";
import { SaoError } from "./errors";
import {
  type AiNode,
  type AiStep,
  type BashNode,
  type BashStep,
  type GateNode,
  type LoopNode,
  type LoopStep,
  type Workflow,
  type WorkflowNode,
  aiNodeSchema,
  aiStepSchema,
  bashNodeSchema,
  bashStepSchema,
  gateNodeSchema,
  loopNodeSchema,
  workflowTopSchema,
} from "./schema";
import { collectRefs, isLoopRef, nodeOutputRef } from "./template";

const NODE_TYPE_KEYS = ["prompt", "bash", "loop", "gate"] as const;
const FUTURE_TOP_KEYS: Record<string, string> = {
  base: "worktree-per-run lands in M3",
};
/** Run-metadata names ({{base}} etc., SAO_* env) arrive with worktrees in M3. */
const METADATA_NAMES = new Set(["base", "branch", "run_id"]);

export interface LoadWorkflowOptions {
  /** Repo root used to resolve plain `agent:` names (default: process.cwd()). */
  cwd?: string;
}

export function loadWorkflow(path: string, opts: LoadWorkflowOptions = {}): Workflow {
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

  let top;
  try {
    top = workflowTopSchema.parse(doc);
  } catch (err) {
    // Stryker disable next-line ConditionalExpression: zod .parse only throws ZodError, so forcing this guard true is unobservable
    if (err instanceof ZodError) throw new SaoError(`invalid workflow: ${path}`, formatZod(err));
    throw err;
  }

  const nodes = top.nodes.map((node, index) => classifyNode(node, index));

  let mcpConfigPath: string | undefined;
  let mcpServers: Record<string, unknown> | undefined;
  if (typeof top.mcp === "string") {
    mcpConfigPath = resolve(dirname(path), top.mcp);
    let mcpRaw: string;
    try {
      // Stryker disable next-line StringLiteral: mutating "utf8" to "" yields a Buffer, which JSON.parse coerces via toString() (utf8) to the identical text
      mcpRaw = readFileSync(mcpConfigPath, "utf8"); // also rejects directories (EISDIR)
    } catch {
      throw new SaoError(`mcp: config file not found: ${mcpConfigPath}`, "the path is resolved relative to the workflow file");
    }
    try {
      JSON.parse(mcpRaw);
    } catch (err) {
      throw new SaoError(`mcp: config file is not valid JSON: ${mcpConfigPath}`, String(err));
    }
  } else if (
    // Stryker disable next-line ConditionalExpression: equivalent — with mcp undefined, the branch body stringifies undefined (a no-op) and re-assigns undefined
    top.mcp !== undefined
  ) {
    try {
      JSON.stringify(top.mcp); // validate-and-run must agree: the engine serializes this at run time
    } catch {
      throw new SaoError("mcp: inline servers must be JSON-serializable", "YAML aliases that form cycles cannot be forwarded to the runner");
    }
    mcpServers = top.mcp;
  }

  const workflow: Workflow = {
    name: top.name,
    description: top.description,
    inputs: top.inputs,
    defaults: top.defaults,
    nodes,
    mcpConfigPath,
    mcpServers,
    agents: loadAgents(nodes, path, opts.cwd ?? process.cwd()),
  };
  runStaticChecks(workflow);
  return workflow;
}

function classifyNode(raw: unknown, index: number): WorkflowNode {
  const label = () =>
    // Stryker disable next-line ConditionalExpression: forcing the typeof-object clause true is equivalent — no YAML scalar has a string .id property, so the id clause still fails
    raw !== null && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
      ? `node "${(raw as { id: string }).id}"`
      : `node #${index + 1}`;

  if (raw === null || typeof raw === "object" === false || Array.isArray(raw)) {
    throw new SaoError(`${label()} must be a mapping`);
  }
  const record = raw as Record<string, unknown>;

  const typeKeys = NODE_TYPE_KEYS.filter((key) => key in record);
  if (typeKeys.length !== 1) {
    throw new SaoError(
      `${label()} must have exactly one of prompt: | bash: | loop: | gate: (found ${typeKeys.length === 0 ? "none" : typeKeys.join(", ")})`,
    );
  }

  try {
    switch (typeKeys[0]) {
      case "prompt":
        return { ...aiNodeSchema.parse(record), kind: "ai" } satisfies AiNode;
      case "bash":
        return { ...bashNodeSchema.parse(record), kind: "bash" } satisfies BashNode;
      case "gate":
        return { ...gateNodeSchema.parse(record), kind: "gate" } satisfies GateNode;
      default:
        return classifyLoopNode(record, label);
    }
  } catch (err) {
    // Stryker disable next-line ConditionalExpression: zod .parse only throws ZodError, so forcing this guard true is unobservable
    if (err instanceof ZodError) throw new SaoError(`invalid ${label()}`, formatZod(err));
    throw err;
  }
}

function classifyLoopNode(record: Record<string, unknown>, label: () => string): LoopNode {
  const parsed = loopNodeSchema.parse(record);
  const body = parsed.loop;

  if ((body.prompt === undefined) === (body.steps === undefined)) {
    throw new SaoError(`${label()}: loop must have exactly one of prompt: | steps:`);
  }
  if ((body.until === undefined) === (body.until_bash === undefined)) {
    throw new SaoError(`${label()}: loop must have exactly one of until: | until_bash:`);
  }
  if (body.interactive && body.until === undefined) {
    throw new SaoError(
      `${label()}: interactive loops require until: (a sentinel signal)`,
      "the human approves on a signaled iteration; until_bash: has no signal to approve",
    );
  }
  if (!body.fresh_context && body.steps !== undefined) {
    throw new SaoError(
      `${label()}: fresh_context: false requires a single-prompt loop`,
      "steps run as separate sessions, so there is no one conversation to resume",
    );
  }

  const steps = body.steps?.map((step, stepIndex) => classifyStep(step, stepIndex, label));
  if (body.until !== undefined && steps !== undefined && !steps.some((step) => step.kind === "ai")) {
    throw new SaoError(`${label()}: until: needs at least one AI step to emit the signal`);
  }

  return { ...parsed, kind: "loop", loop: { ...body, steps } };
}

function classifyStep(raw: unknown, stepIndex: number, label: () => string): LoopStep {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SaoError(`${label()}: step #${stepIndex + 1} must be a mapping`);
  }
  const record = raw as Record<string, unknown>;
  const hasPrompt = "prompt" in record;
  const hasBash = "bash" in record;
  if (hasPrompt === hasBash) {
    throw new SaoError(`${label()}: step #${stepIndex + 1} must have exactly one of prompt: | bash:`);
  }
  try {
    if (hasPrompt) return { ...aiStepSchema.parse(record), kind: "ai" } satisfies AiStep;
    return { ...bashStepSchema.parse(record), kind: "bash" } satisfies BashStep;
  } catch (err) {
    // Stryker disable next-line ConditionalExpression: zod .parse only throws ZodError, so forcing this guard true is unobservable
    if (err instanceof ZodError) throw new SaoError(`invalid ${label()} step #${stepIndex + 1}`, formatZod(err));
    throw err;
  }
}

/** Every templated text in a node, with whether loop-only refs are legal there. */
function templatedTexts(node: WorkflowNode): Array<{ text: string; inLoopBody: boolean }> {
  const texts: Array<{ text: string; inLoopBody: boolean }> = [];
  if (node.when_bash) texts.push({ text: node.when_bash, inLoopBody: false });
  switch (node.kind) {
    case "ai":
      texts.push({ text: node.prompt, inLoopBody: false });
      break;
    case "bash":
      texts.push({ text: node.bash, inLoopBody: false });
      break;
    case "gate":
      texts.push({ text: node.gate.message, inLoopBody: false });
      break;
    case "loop": {
      if (node.loop.prompt) texts.push({ text: node.loop.prompt, inLoopBody: true });
      for (const step of node.loop.steps ?? []) {
        texts.push({ text: step.kind === "ai" ? step.prompt : step.bash, inLoopBody: true });
        if (step.when_bash) texts.push({ text: step.when_bash, inLoopBody: true });
      }
      if (node.loop.until_bash) texts.push({ text: node.loop.until_bash, inLoopBody: true });
      break;
    }
  }
  return texts;
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
    for (const { text, inLoopBody } of templatedTexts(node)) {
      checkTemplateRefs(node, text, inLoopBody, byId, transitiveDeps, inputsByName);
    }
  }
}

function checkTemplateRefs(
  node: WorkflowNode,
  text: string,
  inLoopBody: boolean,
  byId: Map<string, WorkflowNode>,
  transitiveDeps: Map<string, Set<string>>,
  inputsByName: Map<string, Workflow["inputs"][number]>,
): void {
  for (const ref of collectRefs(text)) {
    if (ref === "task") continue;
    if (isLoopRef(ref)) {
      if (!inLoopBody) {
        throw new SaoError(`node "${node.id}": {{${ref}}} is only available inside a loop's prompt, steps, or until_bash`);
      }
      continue;
    }
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
