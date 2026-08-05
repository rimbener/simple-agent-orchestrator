export class SaoError extends Error {
  hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "SaoError";
    this.hint = hint;
  }
}
