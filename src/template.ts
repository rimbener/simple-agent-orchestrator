import { SaoError } from "./errors";

const REF_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/g;
const NODE_OUTPUT_REF = /^nodes\.([a-zA-Z0-9_-]+)\.output$/;

export interface LoopTemplateVars {
  /** Human feedback from the previous interactive iteration; "" when there is none. */
  feedback: string;
  /** 1-based iteration counter. */
  iteration: number;
}

export interface RunMetaVars {
  /** Ref the run worktree/branch was cut from; "" for in-place runs outside git. */
  base: string;
  /** The run's branch name; "" for in-place runs. */
  branch: string;
  run_id: string;
}

export interface TemplateContext {
  task: string;
  inputs: Record<string, string>;
  nodeOutputs: Record<string, string>;
  /** Present only while interpolating inside a loop body. */
  loop?: LoopTemplateVars;
  /** Run metadata ({{base}}, {{branch}}, {{run_id}}); always set by the engine. */
  meta?: RunMetaVars;
}

const LOOP_REFS = new Set(["loop.feedback", "loop.iteration"]);
const META_REFS = new Set(["base", "branch", "run_id"]);

/** Whether the ref is one of the loop-only template variables. */
export function isLoopRef(ref: string): boolean {
  return LOOP_REFS.has(ref);
}

/** Whether the ref is one of the run-metadata template variables. */
export function isMetaRef(ref: string): ref is keyof RunMetaVars {
  return META_REFS.has(ref);
}

/** All `{{ref}}` names appearing in a string, in order of appearance. */
export function collectRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(REF_PATTERN)) {
    refs.push(match[1]!);
  }
  return refs;
}

/** The node id if the ref is a `nodes.<id>.output` reference, else undefined. */
export function nodeOutputRef(ref: string): string | undefined {
  return NODE_OUTPUT_REF.exec(ref)?.[1];
}

export function interpolate(text: string, ctx: TemplateContext): string {
  return text.replace(REF_PATTERN, (_whole, ref: string) => {
    if (ref === "task") return ctx.task;

    if (isLoopRef(ref)) {
      if (!ctx.loop) throw new SaoError(`{{${ref}}} is only available inside loop nodes`);
      return ref === "loop.feedback" ? ctx.loop.feedback : String(ctx.loop.iteration);
    }

    if (isMetaRef(ref)) {
      if (!ctx.meta) throw new SaoError(`{{${ref}}} run metadata is not available in this context`);
      return ctx.meta[ref];
    }

    const nodeId = nodeOutputRef(ref);
    if (nodeId !== undefined) {
      // hasOwn: {{nodes.constructor.output}} must never read the prototype chain.
      const output = Object.hasOwn(ctx.nodeOutputs, nodeId) ? ctx.nodeOutputs[nodeId] : undefined;
      if (output === undefined) {
        throw new SaoError(`{{${ref}}}: node "${nodeId}" has not produced output yet`);
      }
      return output;
    }

    const input = ctx.inputs[ref];
    if (input !== undefined) return input;

    throw new SaoError(`unknown template reference {{${ref}}}`);
  });
}
