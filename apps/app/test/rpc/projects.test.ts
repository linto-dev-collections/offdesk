import { env } from "cloudflare:workers";
import { ProjectListOutput } from "@offdesk/contract";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { signIn, testIp } from "../auth/support.ts";
import { CHANNEL_ALPHA, seedTwoProjects } from "../db/support.ts";

const ORIGIN = "http://localhost:5173";

const callList = async (
  headers: Headers = new Headers(),
): Promise<Response> => {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set("origin", ORIGIN);
  requestHeaders.set("cf-connecting-ip", testIp("rpc/projects"));

  return await worker.fetch(
    new Request(`${ORIGIN}/rpc/projects/list`, {
      method: "POST",
      headers: requestHeaders,
      body: "{}",
    }),
    env,
  );
};

describe("POST /rpc/projects.list", () => {
  it("未ログインなら 401", async () => {
    await seedTwoProjects();

    expect((await callList()).status).toBe(401);
  });

  it("ログイン中なら一覧を返す", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    const response = await callList(headers);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { json: unknown };
    const parsed = ProjectListOutput.parse(body.json);
    expect(parsed.items.map((item) => item.name)).toEqual([
      "dummy",
      "offdesk-test",
    ]);
  });

  /*
    plans/security.md 脅威 3。**`fireUrl` 全体も暗号文も応答に無い。**
    URL には `trig_…` が埋まっていて、それ 1 つ（＋トークン）で起動できる。
    `ProjectSummary` の型に無いので後から誤って足せないが、**実物でも確かめる。**
  */
  it("応答に fireUrl 全体も暗号文も無い", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    const text = await (await callList(headers)).text();

    expect(text).not.toContain("trig_");
    expect(text).not.toContain("/v1/claude_code/");
    expect(text).not.toContain("ciphertext");
    expect(text).not.toContain("sk-ant");
  });

  it("fire の宛先はホストだけ出る", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    const body = (await (await callList(headers)).json()) as { json: unknown };
    const parsed = ProjectListOutput.parse(body.json);

    expect(parsed.items[0]?.fireUrlHost).toBe("api.anthropic.com");
  });

  it("トークンは末尾 4 文字だけ", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    const body = (await (await callList(headers)).json()) as { json: unknown };
    const parsed = ProjectListOutput.parse(body.json);

    expect(parsed.items[0]?.fireTokenLast4).toBe("aB3x");
  });

  /** 要件 `F-H5`。無効なものも一覧に出る（棚卸しに要る）が、印が付く。 */
  it("無効なプロジェクトには disabled が立つ", async () => {
    const { alpha } = await seedTwoProjects();
    await env.DB.prepare("UPDATE projects SET disabled_at = ? WHERE id = ?")
      .bind(Date.now(), alpha)
      .run();
    const { headers } = await signIn();

    const body = (await (await callList(headers)).json()) as { json: unknown };
    const parsed = ProjectListOutput.parse(body.json);

    expect(
      parsed.items.find((item) => item.name === "offdesk-test")?.disabled,
    ).toBe(true);
    expect(parsed.items.find((item) => item.name === "dummy")?.disabled).toBe(
      false,
    );
  });

  it("チャンネル id は出る（棚卸しに要る。秘密ではない）", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    const body = (await (await callList(headers)).json()) as { json: unknown };
    const parsed = ProjectListOutput.parse(body.json);

    expect(
      parsed.items.find((item) => item.name === "offdesk-test")
        ?.discordChannelId,
    ).toBe(CHANNEL_ALPHA);
  });
});
