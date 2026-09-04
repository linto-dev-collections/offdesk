import { env } from "cloudflare:workers";
import { createDb, takeFireToken } from "@offdesk/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index.ts";
import {
  CHANNEL_ALPHA,
  CHANNEL_BETA,
  FIRE_URL,
  seedTwoProjects,
} from "../db/support.ts";
import { jsonResponse, stubOutbound } from "../support/outbound.ts";

/*
  投入口（要件 `F-H1`・`F-H3`・plans/security.md 脅威 2・3）。

  **平文の fire トークンは網を通るが、D1 には暗号文しか入らない。**
  鍵は Worker secret の 1 か所だけ（`FIRE_TOKEN_KEY`）。
*/

const ORIGIN = "http://localhost:5173";
const TOKEN = "test-offdesk-token-0123456789abcdef";

const entry = (overrides: Record<string, unknown> = {}) => ({
  name: "offdesk-test",
  discordChannelId: CHANNEL_ALPHA,
  repoUrl: "https://github.com/linto-dev-collections/offdesk-test",
  fireUrl: FIRE_URL,
  fireToken: "sk-ant-oat01-abcdefgh-aB3x",
  ...overrides,
});

/*
  **`null` が「ヘッダを付けない」。** 既定値つきの引数に `undefined` を渡すと
  既定値が入るので、`undefined` では「ヘッダ無し」を表せない
  （これで一度、送っているのに 401 を期待するテストを書いた）。
*/
const post = async (
  body: unknown,
  auth: string | null = `Bearer ${TOKEN}`,
  overrides: Partial<typeof env> = {},
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (auth !== null) headers.set("authorization", auth);

  return await worker.fetch(
    new Request(`${ORIGIN}/api/admin/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { ...env, ...overrides },
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Bearer のゲート（脅威 2）", () => {
  it("正しいトークンで通る", async () => {
    expect((await post({ projects: [entry()] })).status).toBe(200);
  });

  it.each([
    ["1 文字違い", `Bearer ${TOKEN}x`],
    ["Bearer 無し", TOKEN],
    ["小文字の bearer", `bearer ${TOKEN}`],
    ["空の値", "Bearer "],
  ])("%s は 401", async (_label, auth) => {
    expect((await post({ projects: [entry()] }, auth)).status).toBe(401);
  });

  it("ヘッダが無ければ 401", async () => {
    expect((await post({ projects: [entry()] }, null)).status).toBe(401);
  });

  /** 要件 `I-2`。**未設定なら誰も通らない。** */
  it.each(["", "   "])(
    "OFFDESK_TOKEN が %o なら誰も通らない",
    async (token) => {
      expect(
        (
          await post({ projects: [entry()] }, `Bearer ${TOKEN}`, {
            OFFDESK_TOKEN: token,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await post({ projects: [entry()] }, "Bearer ", {
            OFFDESK_TOKEN: token,
          })
        ).status,
      ).toBe(401);
    },
  );
});

describe("投入", () => {
  it("行が入り、暗号文が復号できる", async () => {
    const response = await post({ projects: [entry()] });

    expect(await response.json()).toEqual({
      applied: [
        { name: "offdesk-test", inserted: true, fireTokenLast4: "aB3x" },
      ],
    });

    const row = await env.DB.prepare(
      "SELECT id FROM projects WHERE name = 'offdesk-test'",
    ).first<{ id: string }>();
    expect(
      await takeFireToken(createDb(env.DB), env.FIRE_TOKEN_KEY, row?.id ?? ""),
    ).toBe("sk-ant-oat01-abcdefgh-aB3x");
  });

  it("2 回目は更新になる", async () => {
    await post({ projects: [entry()] });
    const response = await post({
      projects: [entry({ repoUrl: "https://github.com/x/updated" })],
    });

    expect(await response.json()).toEqual({
      applied: [
        { name: "offdesk-test", inserted: false, fireTokenLast4: "aB3x" },
      ],
    });
  });

  /** **応答に平文も暗号文も出さない**（脅威 3・12）。 */
  it("応答に平文のトークンが出ない", async () => {
    const body = await (await post({ projects: [entry()] })).text();

    expect(body).not.toContain("sk-ant");
    expect(body).not.toContain("abcdefgh");
    expect(body).not.toContain("ciphertext");
  });

  it("複数件をまとめて入れられる", async () => {
    const response = await post({
      projects: [
        entry(),
        entry({ name: "dummy", discordChannelId: CHANNEL_BETA }),
      ],
    });

    expect(response.status).toBe(200);
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM projects",
    ).first<{
      n: number;
    }>();
    expect(count?.n).toBe(2);
  });
});

describe("入力の検査（脅威 3 の 2 層目）", () => {
  /*
    **`https://api.anthropic.com/` 以外は拒否する。** D1 の CHECK でも止まるが、
    そちらは batch の途中で落ちるので何件入ったか分からない。
  */
  it.each([
    ["別ホスト", "https://evil.example.com/v1/fire"],
    ["1 文字違い", "https://api.anthropic.co/v1/fire"],
    ["http", "http://api.anthropic.com/v1/fire"],
    ["サブドメイン", "https://evil.api.anthropic.com/v1/fire"],
  ])("fireUrl が %s なら 400", async (_label, fireUrl) => {
    const response = await post({ projects: [entry({ fireUrl })] });

    expect(response.status).toBe(400);
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM projects",
    ).first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it.each([
    ["name が大文字", { name: "Offdesk" }],
    ["name が空白入り", { name: "off desk" }],
    ["channel が数字でない", { discordChannelId: "11111111111111x" }],
    ["channel が短い", { discordChannelId: "1111" }],
    ["repoUrl が http", { repoUrl: "http://github.com/x/y" }],
  ])("%s なら 400", async (_label, overrides) => {
    expect((await post({ projects: [entry(overrides)] })).status).toBe(400);
  });

  /** 要件 `F-H4`。同じチャンネルに 2 つ紐付けられない。 */
  it("同じ channel が 2 つあれば 400（1 件も入らない）", async () => {
    const response = await post({
      projects: [entry(), entry({ name: "dummy" })],
    });

    expect(response.status).toBe(400);
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM projects",
    ).first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it("空の配列は 400", async () => {
    expect((await post({ projects: [] })).status).toBe(400);
  });

  /** 検証の失敗に**受け取った値を載せない**（脅威 12）。 */
  it("400 の本文に受け取った値が出ない", async () => {
    const body = await (
      await post({
        projects: [entry({ fireUrl: "https://evil.example.com/v1/fire" })],
      })
    ).text();

    expect(body).not.toContain("evil.example.com");
    expect(body).not.toContain("sk-ant");
  });
});

describe("FIRE_TOKEN_KEY が未設定", () => {
  it.each(["", "   "])("%o なら 503（暗号化せずに入れない）", async (key) => {
    const response = await post({ projects: [entry()] }, `Bearer ${TOKEN}`, {
      FIRE_TOKEN_KEY: key,
    });

    expect(response.status).toBe(503);
  });
});

describe("GET /api/admin/projects", () => {
  it("有効なプロジェクトの名前だけを返す", async () => {
    const { alpha } = await seedTwoProjects();
    await env.DB.prepare("UPDATE projects SET disabled_at = ? WHERE id = ?")
      .bind(Date.now(), alpha)
      .run();

    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/admin/projects`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      env,
    );

    expect(await response.json()).toEqual({ names: ["dummy"] });
  });

  it("Bearer が無ければ 401", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/admin/projects`),
      env,
    );

    expect(response.status).toBe(401);
  });
});

describe("POST /api/admin/commands", () => {
  const register = async (overrides: Partial<typeof env> = {}) =>
    await worker.fetch(
      new Request(`${ORIGIN}/api/admin/commands`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      { ...env, ...overrides },
    );

  it("D1 の projects から選択肢を作って Discord へ PUT する", async () => {
    const stub = stubOutbound([["discord.com", () => jsonResponse([])]]);
    await seedTwoProjects();

    const response = await register();

    expect(await response.json()).toEqual({
      registered: ["dummy", "offdesk-test"],
      scope: "global",
    });

    const [put] = stub.callsTo("/commands");
    const sent = JSON.parse(put?.body ?? "[]") as readonly {
      name: string;
      options: readonly {
        name: string;
        choices?: readonly { value: string }[];
      }[];
    }[];
    expect(sent[0]?.name).toBe("offdesk");
    expect(
      sent[0]?.options
        .find((o) => o.name === "project")
        ?.choices?.map((c) => c.value),
    ).toEqual(["dummy", "offdesk-test"]);
  });

  it("bot token が未設定なら 503", async () => {
    expect((await register({ DISCORD_BOT_TOKEN: "" })).status).toBe(503);
  });
});
