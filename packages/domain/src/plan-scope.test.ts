import { describe, expect, it } from "vitest";
import { newPlanId } from "./ids.ts";
import { planScope } from "./plan-path.ts";

/*
  計画の同一性（要件 `F-E4`・`I-6`・計画 P6 §6）。

  **run が落ちて起こし直しても、同じスレッドの同じ名前なら同じ URL に上書きされる。**
  ここが `run_key` だと、直すたびに URL が変わってスレッドに貼ったリンクが
  古い版を指し続ける（kanata で実際にそうなっていた）。
*/

const THREAD = "444444444444444444";

describe("scope の決め方", () => {
  it("スレッドがあれば thread", () => {
    expect(
      planScope({ threadId: THREAD, runKey: "OFFDESK-1111111111111111" }),
    ).toEqual({ kind: "thread", id: THREAD });
  });

  /** スレッドを立てられなかった run（要件 `F-A7`）だけ run へ落とす。 */
  it("スレッドが無ければ run", () => {
    expect(
      planScope({ threadId: null, runKey: "OFFDESK-1111111111111111" }),
    ).toEqual({ kind: "run", id: "OFFDESK-1111111111111111" });
  });

  /*
    **これが `I-6` の本体。** run_key が変わっても scope が変わらないので、
    `plans_scope_slug_uidx` が同じ行に当たり、同じ `plan_id` が返る。
  */
  it("run_key が変わっても scope は変わらない", () => {
    const before = planScope({
      threadId: THREAD,
      runKey: "OFFDESK-1111111111111111",
    });
    const after = planScope({
      threadId: THREAD,
      runKey: "OFFDESK-2222222222222222",
    });

    expect(after).toEqual(before);
  });

  it("スレッドが違えば別の scope", () => {
    expect(
      planScope({ threadId: "555555555555555555", runKey: "OFFDESK-1" }),
    ).not.toEqual(planScope({ threadId: THREAD, runKey: "OFFDESK-1" }));
  });
});

describe("plan_id の形（plans_id_shape_ck）", () => {
  const bytes = (byteLength: number): Uint8Array =>
    Uint8Array.from({ length: byteLength }, (_, index) => index * 17);

  it("32 桁の小文字 16 進", () => {
    expect(newPlanId(bytes)).toMatch(/^[0-9a-f]{32}$/);
  });

  /** 128bit。**`Math.random` を使わない**（計画 P6 §8）。 */
  it("16 バイトを求める", () => {
    let asked = 0;
    newPlanId((byteLength) => {
      asked = byteLength;
      return bytes(byteLength);
    });

    expect(asked).toBe(16);
  });

  it("0 も 255 も桁を落とさない", () => {
    expect(newPlanId(() => new Uint8Array(16))).toBe("0".repeat(32));
    expect(newPlanId(() => new Uint8Array(16).fill(255))).toBe("f".repeat(32));
  });
});
