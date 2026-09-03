import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import {
  createSigningKeys,
  type SigningKeys,
  signedRequest,
  tamper,
} from "./support.ts";

/*
  plans/security.md 脅威 1。`POST /discord/interactions` は**公開 URL** なので、
  署名検証が唯一の入口ゲート。
*/

let keys: SigningKeys;

beforeAll(async () => {
  keys = await createSigningKeys();
});

const post = async (
  request: Request,
  overrides: Partial<typeof env> = {},
): Promise<Response> => await worker.fetch(request, { ...env, ...overrides });

const withKey = () => ({ DISCORD_PUBLIC_KEY: keys.publicKeyHex });

describe("正しい署名", () => {
  it("PING に type 1 を返す", async () => {
    const response = await post(
      await signedRequest(keys, { type: 1 }),
      withKey(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });
});

describe("通してはいけないもの", () => {
  it("署名を 1 バイト変えると 401", async () => {
    const body = { type: 1 };
    const timestamp = "1788427539";
    const signature = tamper(await keys.sign(timestamp + JSON.stringify(body)));

    const response = await post(
      await signedRequest(keys, body, { timestamp, signature }),
      withKey(),
    );

    expect(response.status).toBe(401);
  });

  it("署名ヘッダが無いと 401", async () => {
    const response = await post(
      await signedRequest(keys, { type: 1 }, { omitSignature: true }),
      withKey(),
    );

    expect(response.status).toBe(401);
  });

  it("timestamp ヘッダが無いと 401", async () => {
    const response = await post(
      await signedRequest(keys, { type: 1 }, { omitTimestamp: true }),
      withKey(),
    );

    expect(response.status).toBe(401);
  });

  /*
    **timestamp を差し替えると署名が合わなくなる**ことを確かめる。
    署名対象が body だけだったら、この検査は通ってしまう。
  */
  it("timestamp を差し替えると 401（署名対象に含まれている）", async () => {
    const body = { type: 1 };
    const signature = await keys.sign(`1788427539${JSON.stringify(body)}`);

    const response = await post(
      await signedRequest(keys, body, {
        timestamp: "1788427540",
        signature,
      }),
      withKey(),
    );

    expect(response.status).toBe(401);
  });

  /*
    **生のボディで検証していることの検査。** パースして再直列化した文字列で
    検証する実装だと、キーの順序が変わった時点で署名が壊れる（逆に、
    ここで通ってしまう実装は「本文を書き換えても通る」ことになる）。
  */
  it("本文を 1 文字変えると 401", async () => {
    const timestamp = "1788427539";
    const signature = await keys.sign(`${timestamp}{"type":1}`);

    const response = await post(
      new Request("http://localhost:5173/discord/interactions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": signature,
          "x-signature-timestamp": timestamp,
        },
        body: '{"type":2}',
      }),
      withKey(),
    );

    expect(response.status).toBe(401);
  });

  it("別の鍵で署名すると 401", async () => {
    const other = await createSigningKeys();

    const response = await post(
      await signedRequest(other, { type: 1 }),
      withKey(),
    );

    expect(response.status).toBe(401);
  });
});

describe("公開鍵が未設定", () => {
  /*
    要件 `I-2`。**未設定は 503 で拒否する。** 空文字を鍵として `importKey` に渡すと
    例外になるが、それを catch して通す実装にしない。
  */
  it.each(["", "   "])("空（%o）なら 503", async (publicKey) => {
    const response = await post(await signedRequest(keys, { type: 1 }), {
      DISCORD_PUBLIC_KEY: publicKey,
    });

    expect(response.status).toBe(503);
  });

  it("鍵の形が壊れていても 503（401 ではない）", async () => {
    const response = await post(await signedRequest(keys, { type: 1 }), {
      DISCORD_PUBLIC_KEY: "not-hex",
    });

    expect(response.status).toBe(503);
  });
});
