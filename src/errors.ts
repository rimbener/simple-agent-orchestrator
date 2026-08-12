export class SaoError extends Error {
  hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "SaoError";
    this.hint = hint;
  }
}

/** Trim free-form failure text to a hint-sized excerpt; undefined when blank. */
export function truncateDetail(text: string, max = 500): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)} …`;
}

/** A human rejected a gate — the run halts as "rejected", not "failed". */
export class GateRejectedError extends SaoError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = "GateRejectedError";
  }
}
