import { env } from "cloudflare:workers";
import { RPC_PREFIX } from "@offdesk/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { signIn } from "../auth/support.ts";
import { ORIGIN } from "../discord/support.ts";
import { call, publish, seedPublisher, storedPaths, view } from "./support.ts";

/*
  計画の取り消し（要件 `F-E9`・計画 P6 §4-7・§6）。

  **offdesk で消せるのはこれだけ。** run・ask・event・inbox・プロジェクトに
  削除の経路は持たない（要件 `N-4`）。`plans` は子を持たないので、消しても
  壊れるものがない（テーブル定義書 §3-4）。
*/

const remove = async (input: {
  readonly planId: string;
  readonly headers?: Headers;
}): Promise<Response> => {
  const headers = new Headers(input.headers);
  headers.set("content-type", "application/json");

  return await call(
    new Request(`${ORIGIN}${RPC_PREFIX}/plans/remove`, {
      method: "POST",
      headers,
      // oRPC の RPC 形式。入力は `json` に包む（応答も `{ json: … }` で返る）。
      body: JSON.stringify({ json: { planId: input.planId } }),
    }),
  );
};

let planId = "";
let token = "";

beforeEach(async () => {
  await seedPublisher();
  const published = await publish({
    files: { "README.md": "# 目次", "phase-01/detail.md": "# 詳細" },
  });
  planId = published.planId;
  token = published.token;
});

describe("消すのはログインした人だけ", () => {
  /*
    **署名付きリンクでは消せない。** 閲覧はリンクで開くが、期限内のリンクが
    取り消しの権限になると、貼り先を間違えた 1 回で消される。
  */
  it("未ログインなら 401", async () => {
    const response = await remove({ planId });

    expect(response.status).toBe(401);
    expect(await storedPaths(planId)).toHaveLength(2);
  });
});

describe("消える", () => {
  it("R2 のオブジェクトと台帳の行が消える", async () => {
    const { headers } = await signIn();

    const response = await remove({ planId, headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ json: { removed: true } });
    expect(await storedPaths(planId)).toEqual([]);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM plans").first<{
        n: number;
      }>(),
    ).toMatchObject({ n: 0 });
  });

  /** **URL が 404 になる**（署名が通っても行が無い）。 */
  it("URL が 404 になる", async () => {
    const { headers } = await signIn();
    expect((await view({ planId, token })).status).toBe(200);

    await remove({ planId, headers });

    expect((await view({ planId, token })).status).toBe(404);
  });

  /** **2 回目は `removed: false`。** 画面が「消えました」を 2 回出さないため。 */
  it("2 回目は removed: false", async () => {
    const { headers } = await signIn();

    await remove({ planId, headers });
    const second = await remove({ planId, headers });

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ json: { removed: false } });
  });

  it("知らない plan_id でも removed: false", async () => {
    const { headers } = await signIn();

    const response = await remove({ planId: "f".repeat(32), headers });

    expect(await response.json()).toMatchObject({ json: { removed: false } });
  });

  /** **他の計画は残る**（R2 のキーが `plan_id` で前置されている）。 */
  it("他の計画は残る", async () => {
    const other = await publish({
      slug: "phase-06",
      files: { "README.md": "# 別" },
    });
    const { headers } = await signIn();

    await remove({ planId, headers });

    expect(await storedPaths(other.planId)).toEqual(["README.md"]);
    expect(
      (await view({ planId: other.planId, token: other.token })).status,
    ).toBe(200);
  });

  /*
    **消しても run は残る。** `plans.last_published_run_key` は RESTRICT の
    外部キーだが、向きは plans → runs なので、子である plans を消すのは通る
    （テーブル定義書 付録 A-2 で実測済み）。
  */
  it("run は消えない", async () => {
    const { headers } = await signIn();

    await remove({ planId, headers });

    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM runs").first<{
        n: number;
      }>(),
    ).toMatchObject({ n: 1 });
  });
});

describe("形の検査", () => {
  it.each([
    ["32hex でない", "not-a-plan-id"],
    ["大文字", "A".repeat(32)],
    ["31 桁", "0".repeat(31)],
  ])("%s なら通らない", async (_label, value) => {
    const { headers } = await signIn();

    const response = await remove({ planId: value, headers });

    expect(response.status).not.toBe(200);
  });
});
