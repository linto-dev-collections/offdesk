import { describe, expect, it } from "vitest";
import { newAskId, newRunKey } from "./ids.ts";

/** DDL の `runs_key_shape_ck` と同じ形（テーブル定義書 §4-3）。 */
const RUN_KEY_SHAPE = /^OFFDESK-[0-9a-f]{16}$/;

/*
  **本物の `crypto` を使わない。** `packages/domain` の tsconfig は `types: []` で
  WebCrypto の型を持たない（それが `domain-is-pure` の 2 段目の防御）。
  ここで確かめたいのは「バイト列 → 印」の写し方で、乱数の質は呼ぶ側の責任
  （worker 側の `session/launch.test.ts` が実物を通す）。
*/
const counterBytes = () => {
  let next = 0;
  return (byteLength: number): Uint8Array => {
    const bytes = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i += 1) {
      bytes[i] = (next >> (8 * i)) & 0xff;
    }
    next += 1;
    return bytes;
  };
};

const pseudoRandomBytes = (byteLength: number): Uint8Array => {
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
};

describe("newRunKey", () => {
  it("runs_key_shape_ck を満たす（24 文字・小文字 16 進）", () => {
    const key = newRunKey(pseudoRandomBytes);

    expect(key).toMatch(RUN_KEY_SHAPE);
    expect(key).toHaveLength(24);
  });

  it("8 バイトを要求する（16 進で 16 桁 ＝ 64bit）", () => {
    let asked = 0;
    newRunKey((byteLength) => {
      asked = byteLength;
      return new Uint8Array(byteLength);
    });

    expect(asked).toBe(8);
  });

  it("違うバイト列から違う印ができる（1000 回で重複なし）", () => {
    const source = counterBytes();
    const keys = new Set(Array.from({ length: 1000 }, () => newRunKey(source)));

    expect(keys.size).toBe(1000);
  });

  /*
    0 は 1 桁に落ちる（`(0).toString(16)` は `"0"`）。padStart が無いと 24 文字にならず、
    **DDL の length 検査で本番だけが落ちる。**
  */
  it("0 バイトでも桁が落ちない", () => {
    const key = newRunKey((byteLength) => new Uint8Array(byteLength));

    expect(key).toBe("OFFDESK-0000000000000000");
    expect(key).toMatch(RUN_KEY_SHAPE);
  });

  it("0xff でも桁が増えない", () => {
    const key = newRunKey((byteLength) => new Uint8Array(byteLength).fill(255));

    expect(key).toBe("OFFDESK-ffffffffffffffff");
    expect(key).toHaveLength(24);
  });
});

/** DDL の `asks_id_shape_ck` と同じ形（テーブル定義書 §4-4）。 */
const ASK_ID_SHAPE = /^ask_[0-9a-f]{16}$/;

describe("newAskId", () => {
  it("asks_id_shape_ck を満たす（20 文字・小文字 16 進）", () => {
    const askId = newAskId(pseudoRandomBytes);

    expect(askId).toMatch(ASK_ID_SHAPE);
    expect(askId).toHaveLength(20);
  });

  it("8 バイトを要求する", () => {
    let asked = 0;
    newAskId((byteLength) => {
      asked = byteLength;
      return new Uint8Array(byteLength);
    });

    expect(asked).toBe(8);
  });

  it("違うバイト列から違う印ができる（1000 回で重複なし）", () => {
    const source = counterBytes();
    const ids = new Set(Array.from({ length: 1000 }, () => newAskId(source)));

    expect(ids.size).toBe(1000);
  });

  it("0 バイトでも桁が落ちない", () => {
    // 落ちると `length(ask_id) = 20` の CHECK で本番だけが落ちる。
    expect(newAskId((byteLength) => new Uint8Array(byteLength))).toBe(
      "ask_0000000000000000",
    );
  });

  it("run_key と混ざらない接頭辞を持つ", () => {
    // `custom_id` の `ans:<ask_id>:<index>` から引くので、取り違えると台帳が引けない。
    expect(newAskId(pseudoRandomBytes)).not.toMatch(/^OFFDESK-/);
  });
});
