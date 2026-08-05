import { describe, expect, test } from "bun:test";
import { GateRejectedError, SaoError } from "../src/errors";
import { parseGateReply, parseLoopReply } from "../src/gate";

describe("GateRejectedError", () => {
  test("is a SaoError with its own name, so rejections are distinguishable", () => {
    const err = new GateRejectedError("nope", "a hint");
    expect(err).toBeInstanceOf(SaoError);
    expect(err.name).toBe("GateRejectedError");
    expect(err.hint).toBe("a hint");
  });
});

describe("parseGateReply", () => {
  test.each([["a"], ["A"], ["approve"], ["APPROVE"], ["approved"], ["y"], ["yes"], [" a "]])(
    "%p is an approval",
    (reply) => {
      expect(parseGateReply(reply)).toEqual({ kind: "approve" });
    },
  );

  test.each([["r"], ["R"], ["reject"], ["REJECTED"], ["n"], ["no"], [" r "]])("%p is a rejection", (reply) => {
    expect(parseGateReply(reply === "REJECTED" ? "rejected" : reply)).toEqual({ kind: "reject" });
  });

  test("empty and whitespace-only replies are empty (re-ask)", () => {
    expect(parseGateReply("")).toEqual({ kind: "empty" });
    expect(parseGateReply("   \t")).toEqual({ kind: "empty" });
  });

  test("anything else is feedback, trimmed", () => {
    expect(parseGateReply("  tighten the error copy  ")).toEqual({ kind: "feedback", text: "tighten the error copy" });
  });

  test("feedback that merely contains an approval word stays feedback", () => {
    expect(parseGateReply("yes but rename the flag")).toEqual({ kind: "feedback", text: "yes but rename the flag" });
  });
});

describe("parseLoopReply", () => {
  test.each([["a"], ["approve"], ["APPROVED"]])("explicit %p approves", (reply) => {
    expect(parseLoopReply(reply)).toEqual({ kind: "approve" });
  });

  test.each([["r"], ["reject"], ["rejected"]])("explicit %p rejects", (reply) => {
    expect(parseLoopReply(reply)).toEqual({ kind: "reject" });
  });

  test("natural-language yes/no is FEEDBACK in a loop — an interview answer, not a verdict", () => {
    // The interview agent asked "should the endpoint be public?" — "no" must feed
    // the next iteration, never halt the whole run as rejected.
    expect(parseLoopReply("no")).toEqual({ kind: "feedback", text: "no" });
    expect(parseLoopReply("yes")).toEqual({ kind: "feedback", text: "yes" });
    expect(parseLoopReply("n")).toEqual({ kind: "feedback", text: "n" });
    expect(parseLoopReply("y")).toEqual({ kind: "feedback", text: "y" });
  });

  test("empty replies still re-ask", () => {
    expect(parseLoopReply("  ")).toEqual({ kind: "empty" });
  });
});
