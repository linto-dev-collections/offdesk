import { describe, expect, it } from "vitest";
import { isOwner } from "./owner.ts";

const OWNER = "123456789012345678";

describe("isOwner", () => {
  it("持ち主の id なら通る", () => {
    expect(isOwner(OWNER, OWNER)).toBe(true);
  });

  it("別の id なら通らない", () => {
    expect(isOwner(OWNER, "987654321098765432")).toBe(false);
  });

  it("ownerId が未設定なら誰も通らない", () => {
    for (const owner of ["", "   ", undefined]) {
      expect(isOwner(owner, OWNER)).toBe(false);
      expect(isOwner(owner, "")).toBe(false);
      expect(isOwner(owner, undefined)).toBe(false);
    }
  });

  it("actorId が取れなければ通らない", () => {
    for (const actor of ["", "   ", null, undefined]) {
      expect(isOwner(OWNER, actor)).toBe(false);
    }
  });

  it("前後の空白は落としてから比べる", () => {
    expect(isOwner(` ${OWNER} `, OWNER)).toBe(true);
    expect(isOwner(OWNER, ` ${OWNER}\n`)).toBe(true);
  });
});
