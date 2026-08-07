import { SaoError } from "./errors";

const REF_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/g;
const NODE_OUTPUT_REF = /^nodes\.([a-zA-Z0-9_-]+)\.output$/;

export interface TemplateContext {
  task: string;
  inputs: Record<string, string>;
  nodeOutputs: Record<string, string>;
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

    const nodeId = nodeOutputRef(ref);
    if (nodeId !== undefined) {
      const output = ctx.nodeOutputs[nodeId];
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
