import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index.ts";
import { signIn, testIp } from "../auth/support.ts";
import {
  CHANNEL_ALPHA,
  CHANNEL_BETA,
  FIRE_URL,
  seedProject,
  seedTwoProjects,
} from "../db/support.ts";
import {
  jsonResponse,
  type OutboundStub,
  stubOutbound,
} from "../support/outbound.ts";

/*
  画面からの投入（要件 `F-H1`〜`F-H5`）。

  **`projects.json` と CLI を畳んだ 2026-09-16 の置き換え先。** 以前は
  `POST /api/admin/projects`（Bearer）が入口で、トークンの実叩きは CLI の
  `check` が持っていた —— **どちらの性質もここが引き継ぐ**ので、
  `admin-projects.test.ts` が見ていたものはこのファイルが見る。
*/

const ORIGIN = "http://localhost:5173";

const NEW_CHANNEL = "333333333333333333";
const OTHER_CHANNEL = "444444444444444444";
const TOKEN = "sk-ant-oat01-brand-new-token-9Zq7";

const call = async (
  procedure: string,
  input: unknown,
  headers: Headers,
  envOverrides: Partial<typeof env> = {},
): Promise<Response> => {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set("origin", ORIGIN);
  requestHeaders.set("cf-connecting-ip", testIp("rpc/projects-write"));

  return await worker.fetch(
    new Request(`${ORIGIN}/rpc/projects/${procedure}`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ json: input }),
    }),
    { ...env, ...envOverrides },
  );
};

const bodyOf = async (response: Response): Promise<Record<string, unknown>> => {
  const raw = (await response.json()) as { json?: unknown };
  return (raw.json ?? {}) as Record<string, unknown>;
};

/*
  **上限超えの `text` に `400` を返すのが「トークンは通った」。** 本物の fire は
  上限を認証の**後で**弾くので、`401` との差でセッションを作らずに切り分けられる。
  替え玉もその形にしておかないと、**本物より寛容な替え玉**になる。
*/
const anthropic = (status: number) => (): Response =>
  status === 400
    ? jsonResponse({ type: "error" }, 400)
    : jsonResponse({ type: "error" }, status);

const discordCommands = (): Response => jsonResponse([{ id: "cmd" }]);

let outbound: OutboundStub;

const stub = (tokenStatus = 400): OutboundStub => {
  outbound = stubOutbound([
    ["api.anthropic.com", anthropic(tokenStatus)],
    ["discord.com", discordCommands],
  ]);
  return outbound;
};

beforeEach(() => {
  stub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const created = (overrides: Record<string, unknown> = {}) => ({
  name: "brand-new",
  discordChannelId: NEW_CHANNEL,
  repoUrl: "https://github.com/linto-dev-collections/offdesk-test",
  fireUrl: FIRE_URL,
  fireToken: TOKEN,
  ...overrides,
});

const fireUrlOf = async (id: string): Promise<string | null> => {
  const row = await env.DB.prepare("SELECT fire_url FROM projects WHERE id = ?")
    .bind(id)
    .first<{ fire_url: string }>();
  return row?.fire_url ?? null;
};

const projectRow = async (
  name: string,
): Promise<{
  id: string;
  discord_channel_id: string;
  disabled_at: number | null;
} | null> => {
  const row = await env.DB.prepare(
    "SELECT id, discord_channel_id, disabled_at FROM projects WHERE name = ?",
  )
    .bind(name)
    .first();
  return row as never;
};

describe("ログインしていないと書けない", () => {
  it.each(["create", "update", "setDisabled", "syncCommands"])(
    "%s は 401",
    async (procedure) => {
      expect((await call(procedure, {}, new Headers())).status).toBe(401);
    },
  );
});

describe("projects.create", () => {
  it("台帳に入り、トークンは暗号化される", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call("create", created(), headers);
    expect(response.status).toBe(200);

    const row = await projectRow("brand-new");
    expect(row?.discord_channel_id).toBe(NEW_CHANNEL);

    /*
      **平文が D1 に無い**（要件 `F-H2`）。暗号化は Worker の中でしか起きず、
      鍵は手元にも CI にも無い。
    */
    const credential = await env.DB.prepare(
      "SELECT ciphertext, last4 FROM project_fire_credentials WHERE project_id = ?",
    )
      .bind(row?.id)
      .first();
    expect(credential?.last4).toBe("9Zq7");
    expect(JSON.stringify(credential)).not.toContain(TOKEN);
  });

  /** **応答にも平文は無い**（脅威 12）。返すのは末尾 4 文字とホストだけ。 */
  it("応答にトークンも fireUrl 全体も出ない", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    const text = await (await call("create", created(), headers)).text();

    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("trig_");
    expect(text).toContain("9Zq7");
  });

  /*
    **保存の前に実際に叩く**（CLI の `check` が持っていた性質）。
    形だけ合っている置き換え文字列が Zod をすり抜けて本番へ入った事故がある。
  */
  it("保存の前に Anthropic を叩く（セッションは作らない）", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    await call("create", created(), headers);

    const [fire] = outbound.callsTo("api.anthropic.com");
    expect(fire?.method).toBe("POST");
    expect(fire?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // 上限超えの本文 ＝ 認証だけを見て弾かせる形。
    expect(JSON.parse(fire?.body ?? "{}").text.length).toBeGreaterThan(65_536);
  });

  it("トークンが 401 なら 422 で、台帳に入らない", async () => {
    stub(401);
    await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call("create", created(), headers);

    expect(response.status).toBe(422);
    expect((await bodyOf(response)).data).toMatchObject({ kind: "rejected" });
    expect(await projectRow("brand-new")).toBeNull();
  });

  it("routine が 404 なら 422（URL を貼り直す合図）", async () => {
    stub(404);
    await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call("create", created(), headers);

    expect(response.status).toBe(422);
    expect((await bodyOf(response)).data).toMatchObject({
      kind: "routine_not_found",
    });
  });

  /*
    要件 `F-H4`。**D1 の UNIQUE でも止まるが、そちらは読めない形で落ちる。**
    どちらの欄がぶつかったかを返すので、画面がその欄に印を付けられる。
  */
  it("名前がぶつかれば 409（どの欄かを返す）", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call(
      "create",
      created({ name: "offdesk-test" }),
      headers,
    );

    expect(response.status).toBe(409);
    expect((await bodyOf(response)).data).toMatchObject({ field: "name" });
  });

  it("チャンネルがぶつかれば 409", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call(
      "create",
      created({ discordChannelId: CHANNEL_ALPHA }),
      headers,
    );

    expect(response.status).toBe(409);
    expect((await bodyOf(response)).data).toMatchObject({
      field: "discordChannelId",
    });
  });

  /** **ぶつかると分かっている登録で Anthropic を叩かない**（順序の why）。 */
  it("衝突したときはトークンを叩かない", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    await call("create", created({ name: "offdesk-test" }), headers);

    expect(outbound.callsTo("api.anthropic.com")).toHaveLength(0);
  });

  /*
    **入ったら `/offdesk` も登録し直す。** 台帳に入れただけでは Discord に
    新しい名前が出ない —— OPERATIONS §2 がいちばん強く警告していた取りこぼし。
  */
  it("入った直後に /offdesk を登録し直す", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call("create", created(), headers);

    expect((await bodyOf(response)).commandsRegistered).toBe(true);

    const [registered] = outbound.callsTo("/commands");
    expect(registered?.method).toBe("PUT");
    expect(registered?.body).toContain("brand-new");
  });

  it("fireUrl が別ホストなら通らない（脅威 3）", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call(
      "create",
      created({ fireUrl: "https://evil.example.com/v1/fire" }),
      headers,
    );

    expect(response.status).toBe(400);
    expect(await projectRow("brand-new")).toBeNull();
    expect(outbound.callsTo("evil.example.com")).toHaveLength(0);
  });
});

describe("projects.update", () => {
  it("トークンを省くと据え置きで、資格情報に触らない", async () => {
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();

    const before = await env.DB.prepare(
      "SELECT ciphertext, last4 FROM project_fire_credentials WHERE project_id = ?",
    )
      .bind(alpha)
      .first();

    const response = await call(
      "update",
      {
        id: alpha,
        discordChannelId: OTHER_CHANNEL,
        repoUrl: "https://github.com/linto-dev-collections/moved",
        fireUrl: FIRE_URL,
      },
      headers,
    );
    expect(response.status).toBe(200);

    const after = await env.DB.prepare(
      "SELECT ciphertext, last4 FROM project_fire_credentials WHERE project_id = ?",
    )
      .bind(alpha)
      .first();

    expect(after?.last4).toBe(before?.last4);
    expect((await projectRow("offdesk-test"))?.discord_channel_id).toBe(
      OTHER_CHANNEL,
    );
  });

  /*
    **据え置きなら Anthropic を叩かない。** 叩くのは「差し替えるトークン」だけで、
    台帳に入っている暗号文は復号して確かめ直さない（復号する口は fire の 1 か所）。
  */
  it("据え置きのときはトークンを叩かない", async () => {
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();

    await call(
      "update",
      {
        id: alpha,
        discordChannelId: CHANNEL_ALPHA,
        repoUrl: "https://github.com/x/y",
        fireUrl: FIRE_URL,
      },
      headers,
    );

    expect(outbound.callsTo("api.anthropic.com")).toHaveLength(0);
  });

  it("トークンを入れると差し替わる", async () => {
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();

    await call(
      "update",
      {
        id: alpha,
        discordChannelId: CHANNEL_ALPHA,
        repoUrl: "https://github.com/x/y",
        fireUrl: FIRE_URL,
        fireToken: TOKEN,
      },
      headers,
    );

    const credential = await env.DB.prepare(
      "SELECT last4 FROM project_fire_credentials WHERE project_id = ?",
    )
      .bind(alpha)
      .first();

    expect(credential?.last4).toBe("9Zq7");
  });

  it("差し替えるトークンが通らなければ 422 で、行も変わらない", async () => {
    stub(401);
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call(
      "update",
      {
        id: alpha,
        discordChannelId: OTHER_CHANNEL,
        repoUrl: "https://github.com/x/y",
        fireUrl: FIRE_URL,
        fireToken: TOKEN,
      },
      headers,
    );

    expect(response.status).toBe(422);
    expect((await projectRow("offdesk-test"))?.discord_channel_id).toBe(
      CHANNEL_ALPHA,
    );
  });

  /** **自分がいま握っているチャンネルは通る**（変えない編集を落とさない）。 */
  it("同じチャンネルのまま直せる", async () => {
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call(
      "update",
      {
        id: alpha,
        discordChannelId: CHANNEL_ALPHA,
        repoUrl: "https://github.com/x/y",
        fireUrl: FIRE_URL,
      },
      headers,
    );

    expect(response.status).toBe(200);
  });

  it("他のプロジェクトのチャンネルへは移せない（409）", async () => {
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call(
      "update",
      {
        id: alpha,
        discordChannelId: CHANNEL_BETA,
        repoUrl: "https://github.com/x/y",
        fireUrl: FIRE_URL,
      },
      headers,
    );

    expect(response.status).toBe(409);
  });

  /*
    **別の routine を指す URL に変えるならトークンは必須**（2026-09-16）。

    トークンは routine ごとに発行される（`fire` のドキュメント: "The bearer token
    is scoped to a single routine"）ので、**指す先が変わればいま持っているものは
    必ず通らない。** 以前はここを通していて、気付くのは次に `/offdesk` を叩いた人が
    401 を見たとき —— そのときには誰も編集画面を見ていない。
  */
  it("別の routine へ貼り替えてトークンを省くと 422（token_required）", async () => {
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call(
      "update",
      {
        id: alpha,
        discordChannelId: CHANNEL_ALPHA,
        repoUrl: "https://github.com/x/y",
        fireUrl:
          "https://api.anthropic.com/v1/claude_code/routines/trig_other/fire",
      },
      headers,
    );

    expect(response.status).toBe(422);
    expect((await bodyOf(response)).data).toMatchObject({
      kind: "token_required",
    });
    /** **行は変わらない。** */
    expect(await fireUrlOf(alpha)).toBe(FIRE_URL);
  });

  it("別の routine でもトークンを入れれば通る", async () => {
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();
    const nextUrl =
      "https://api.anthropic.com/v1/claude_code/routines/trig_other/fire";

    const response = await call(
      "update",
      {
        id: alpha,
        discordChannelId: CHANNEL_ALPHA,
        repoUrl: "https://github.com/x/y",
        fireUrl: nextUrl,
        fireToken: TOKEN,
      },
      headers,
    );

    expect(response.status).toBe(200);
    expect(await fireUrlOf(alpha)).toBe(nextUrl);
  });

  /** **同じ routine の URL を整形し直すだけの編集は通る**（`sameRoutine`）。 */
  it("同じ routine のままクエリが付いただけなら通る", async () => {
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call(
      "update",
      {
        id: alpha,
        discordChannelId: CHANNEL_ALPHA,
        repoUrl: "https://github.com/x/y",
        fireUrl: `${FIRE_URL}?v=2`,
      },
      headers,
    );

    expect(response.status).toBe(200);
  });

  /*
    **`fire_url` とトークンは同じ batch で入る**（2026-09-16）。

    以前は「先に `projects` を UPDATE → そのあと資格情報を差し替え」で、
    **後半が落ちると新しい URL と古いトークンが残った**（次の `/offdesk` が 401）。
    暗号化で落ちる形を作って、**どちらも動いていない**ことを見る。
  */
  it("暗号化に失敗したら fire_url も変わらない", async () => {
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();
    const nextUrl =
      "https://api.anthropic.com/v1/claude_code/routines/trig_other/fire";

    const response = await call(
      "update",
      {
        id: alpha,
        discordChannelId: CHANNEL_ALPHA,
        repoUrl: "https://github.com/x/y",
        fireUrl: nextUrl,
        fireToken: TOKEN,
      },
      headers,
      // 鍵が壊れていれば `encrypt` が投げる（`FIRE_TOKEN_KEY` は base64 の 32 バイト）。
      { FIRE_TOKEN_KEY: "AAAA" },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await fireUrlOf(alpha)).toBe(FIRE_URL);
  });

  it("知らない id なら 404", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call(
      "update",
      {
        id: "not-a-real-id",
        discordChannelId: NEW_CHANNEL,
        repoUrl: "https://github.com/x/y",
        fireUrl: FIRE_URL,
      },
      headers,
    );

    expect(response.status).toBe(404);
  });

  /*
    OPERATIONS §2 の「名前は変えない」。**型に欄が無い**ので送っても捨てられる ——
    通ってしまうと別のプロジェクトが増えて古い行が残る。
  */
  it("name を送っても名前は変わらない", async () => {
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();

    await call(
      "update",
      {
        id: alpha,
        name: "renamed",
        discordChannelId: CHANNEL_ALPHA,
        repoUrl: "https://github.com/x/y",
        fireUrl: FIRE_URL,
      },
      headers,
    );

    expect(await projectRow("offdesk-test")).not.toBeNull();
    expect(await projectRow("renamed")).toBeNull();
  });
});

describe("projects.setDisabled", () => {
  /*
    **`disabled_at` を書く経路は 2026-09-16 まで無かった。** 読む側は揃っていたのに、
    止めるには `wrangler d1 execute` を手で打つしかなかった（OPERATIONS §2）。
  */
  it("止めると disabled_at が立つ", async () => {
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();

    const response = await call(
      "setDisabled",
      { id: alpha, disabled: true },
      headers,
    );

    expect(response.status).toBe(200);
    expect((await projectRow("offdesk-test"))?.disabled_at).not.toBeNull();
  });

  it("戻すと disabled_at が消える", async () => {
    const { alpha } = await seedTwoProjects();
    await env.DB.prepare("UPDATE projects SET disabled_at = ? WHERE id = ?")
      .bind(Date.now(), alpha)
      .run();
    const { headers } = await signIn();

    await call("setDisabled", { id: alpha, disabled: false }, headers);

    expect((await projectRow("offdesk-test"))?.disabled_at).toBeNull();
  });

  /*
    **止めた直後の登録し直しが本体。** 無効にしても `/offdesk` の選択肢からは
    自動で消えない（選択肢は登録の時点で焼き込まれる）。
  */
  it("止めた名前は /offdesk の選択肢から消える", async () => {
    const { alpha } = await seedTwoProjects();
    const { headers } = await signIn();

    await call("setDisabled", { id: alpha, disabled: true }, headers);

    const [registered] = outbound.callsTo("/commands");
    expect(registered?.body).not.toContain("offdesk-test");
    expect(registered?.body).toContain("dummy");
  });

  it("知らない id なら 404", async () => {
    await seedTwoProjects();
    const { headers } = await signIn();

    expect(
      (await call("setDisabled", { id: "nope", disabled: true }, headers))
        .status,
    ).toBe(404);
  });
});

describe("projects.syncCommands", () => {
  it("有効なプロジェクトだけを登録する", async () => {
    const { alpha } = await seedTwoProjects();
    await seedProject({ name: "third", discordChannelId: NEW_CHANNEL });
    await env.DB.prepare("UPDATE projects SET disabled_at = ? WHERE id = ?")
      .bind(Date.now(), alpha)
      .run();
    const { headers } = await signIn();

    const response = await call("syncCommands", {}, headers);
    expect(response.status).toBe(200);

    expect((await bodyOf(response)).registered).toEqual(["dummy", "third"]);
  });

  /** Discord が失敗したら 502。**台帳は触っていない**ので、押し直せばよい。 */
  it("Discord が失敗すれば 502", async () => {
    outbound = stubOutbound([
      ["api.anthropic.com", anthropic(400)],
      ["discord.com", () => jsonResponse({ message: "nope" }, 500)],
    ]);
    await seedTwoProjects();
    const { headers } = await signIn();

    expect((await call("syncCommands", {}, headers)).status).toBe(502);
  });
});

describe("projects.routinePrompt", () => {
  /*
    **サーバーから配る**（`pnpm routine:prompt` を畳んだ先）。クライアントに
    焼き込むと、デプロイしていない版の文面を配ることになる。
  */
  it("routine に貼る本文を返す", async () => {
    const { headers } = await signIn();

    const body = await bodyOf(await call("routinePrompt", {}, headers));

    expect(String(body.prompt)).toContain("<routine-fire-payload>");
    expect(String(body.prompt)).toContain("OFFDESK-");
  });
});
