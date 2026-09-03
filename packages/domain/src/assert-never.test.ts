import { describe, expect, it } from "vitest";
import { assertNever } from "./assert-never.ts";

describe("assertNever", () => {
  it("渡された値をメッセージに載せて落ちる", () => {
    expect(() => assertNever("unexpected" as never)).toThrow(/"unexpected"/);
  });
});
