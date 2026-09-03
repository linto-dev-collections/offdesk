import { env } from "cloudflare:workers";
import {
  createDb,
  decryptFireToken,
  encryptFireToken,
  takeFireToken,
} from "@offdesk/db";
import { describe, expect, it } from "vitest";
import { seedProject } from "./support.ts";

/*
  plans/security.md 脅威 3。**平文はどこにも保存しない。**
  暗号文と鍵（Worker secret）が別の場所にあることが要件 `I-1` の担保。
*/

const TOKEN = "sk-ant-oat01-abcdefghijklmnop-aB3x";

describe("encryptFireToken / decryptFireToken", () => {
  it("暗号化 → 復号で元に戻る", async () => {
    const encrypted = await encryptFireToken(env.FIRE_TOKEN_KEY, TOKEN);

    expect(await decryptFireToken(env.FIRE_TOKEN_KEY, encrypted)).toBe(TOKEN);
  });

  it("IV は 12 バイト（`pfc_iv_len_ck` と同じ）", async () => {
    const encrypted = await encryptFireToken(env.FIRE_TOKEN_KEY, TOKEN);

    expect(encrypted.iv.byteLength).toBe(12);
  });

  /*
    **同じ鍵で IV を再利用すると GCM は平文が復元できる形で壊れる。**
    ここが同じ値を返すようになったら、2 つの暗号文の XOR が平文の XOR になる。
  */
  it("同じ平文を 2 回暗号化すると暗号文と IV が違う", async () => {
    const a = await encryptFireToken(env.FIRE_TOKEN_KEY, TOKEN);
    const b = await encryptFireToken(env.FIRE_TOKEN_KEY, TOKEN);

    expect([...a.iv]).not.toEqual([...b.iv]);
    expect([...a.ciphertext]).not.toEqual([...b.ciphertext]);
  });

  it("暗号文に平文が現れない", async () => {
    const encrypted = await encryptFireToken(env.FIRE_TOKEN_KEY, TOKEN);
    const asText = new TextDecoder().decode(encrypted.ciphertext);

    expect(asText).not.toContain("sk-ant");
    expect(asText).not.toContain("aB3x");
  });

  it("last4 は末尾 4 文字（`pfc_last4_ck` と同じ長さ）", async () => {
    const encrypted = await encryptFireToken(env.FIRE_TOKEN_KEY, TOKEN);

    expect(encrypted.last4).toBe("aB3x");
    expect(encrypted.last4).toHaveLength(4);
  });

  it("別の鍵では復号できない", async () => {
    const encrypted = await encryptFireToken(env.FIRE_TOKEN_KEY, TOKEN);
    const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

    await expect(decryptFireToken(otherKey, encrypted)).rejects.toThrow();
  });

  it("暗号文を 1 バイト変えると復号できない（認証タグが効いている）", async () => {
    const encrypted = await encryptFireToken(env.FIRE_TOKEN_KEY, TOKEN);
    const tampered = new Uint8Array(encrypted.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;

    await expect(
      decryptFireToken(env.FIRE_TOKEN_KEY, {
        ...encrypted,
        ciphertext: tampered,
      }),
    ).rejects.toThrow();
  });

  it("鍵が 32 バイトでなければ落ちる", async () => {
    const short = btoa(String.fromCharCode(...new Uint8Array(16)));

    await expect(encryptFireToken(short, TOKEN)).rejects.toThrow(/32 バイト/);
  });

  /*
    **知らない版は復号しない。** 鍵を回したあとに古い暗号文を新しい鍵で開こうとして
    「認証タグが合わない」で落ちるより、版が違うと言った方が原因が分かる。
  */
  it("知らない key_version は復号しない", async () => {
    const encrypted = await encryptFireToken(env.FIRE_TOKEN_KEY, TOKEN);

    await expect(
      decryptFireToken(env.FIRE_TOKEN_KEY, { ...encrypted, keyVersion: 2 }),
    ).rejects.toThrow(/鍵の版/);
  });
});

describe("takeFireToken", () => {
  it("D1 を往復しても復号できる（BLOB の形が揺れても）", async () => {
    const projectId = await seedProject({
      name: "offdesk-test",
      discordChannelId: "111111111111111111",
      fireToken: TOKEN,
    });

    expect(
      await takeFireToken(createDb(env.DB), env.FIRE_TOKEN_KEY, projectId),
    ).toBe(TOKEN);
  });

  it("資格情報が無ければ null", async () => {
    expect(
      await takeFireToken(
        createDb(env.DB),
        env.FIRE_TOKEN_KEY,
        "no-such-project",
      ),
    ).toBeNull();
  });
});
