import { describe, expect, test } from "bun:test";
import { SaoError } from "../src/errors";

describe("SaoError", () => {
  test("carries the exact name, message, and hint", () => {
    const err = new SaoError("m", "h");
    expect(err.name).toBe("SaoError");
    expect(err.message).toBe("m");
    expect(err.hint).toBe("h");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SaoError);
  });

  test("hint is undefined when omitted", () => {
    const err = new SaoError("just a message");
    expect(err.hint).toBeUndefined();
    expect(err.name).toBe("SaoError");
  });
});
