import { vi } from "vitest";

/*
  **外へ出る `fetch` を全部捕まえる。** 結合テストが Discord と Anthropic の本物を
  叩かないこと自体がテストの前提（計画 P2 §5）。知らない宛先が来たら**落とす** ——
  黙って通すと「テストは緑なのに本番へ POST していた」が起きうる。
*/

export type OutboundCall = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
};

export type OutboundStub = {
  readonly calls: readonly OutboundCall[];
  readonly callsTo: (fragment: string) => readonly OutboundCall[];
};

export type RouteHandler = (call: OutboundCall) => Response;

/**
 * **知らない宛先が来たら落とす。** ここに足すのは「テストが替え玉を置く相手」だけ。
 *
 * `gateway.discord.gg` は P4 の DO が張りに行く先。**替え玉を置かないと本物の
 * Gateway へ繋ぎに行く**（bot token を載せて）ので、一覧に入れて必ず捕まえる。
 */
const ALLOWED_HOSTS = [
  "discord.com",
  "api.anthropic.com",
  "gateway.discord.gg",
];

/**
 * `routes` はホスト名の一部 → 応答。並び順に前方一致で探す。
 */
export const stubOutbound = (
  routes: readonly (readonly [string, RouteHandler])[],
): OutboundStub => {
  const calls: OutboundCall[] = [];

  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input as RequestInfo, init);
      const call: OutboundCall = {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: request.body === null ? null : await request.text(),
      };
      calls.push(call);

      const host = new URL(call.url).host;
      if (!ALLOWED_HOSTS.includes(host)) {
        throw new Error(`テストが知らない宛先へ出ようとしました: ${host}`);
      }

      const route = routes.find(([fragment]) => call.url.includes(fragment));
      if (route === undefined) {
        throw new Error(`stub していない宛先です: ${call.url}`);
      }

      return route[1](call);
    },
  );

  return {
    get calls() {
      return calls;
    },
    callsTo: (fragment) => calls.filter((call) => call.url.includes(fragment)),
  };
};

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Discord の「メッセージを出す」「スレッドを立てる」を素直に成功させる。 */
export const discordOk = (ids: {
  readonly messageId?: string;
  readonly threadId?: string;
}): RouteHandler => {
  let posted = 0;
  return (call) => {
    /*
      **印（P4）は 204 を返す。** 本物の `PUT/DELETE /reactions/…/@me` は本文を
      持たないので、`{ id }` を返す替え玉にすると `call` の 204 の分岐を
      1 度も通らない（本物より寛容な替え玉になる）。
    */
    if (call.url.includes("/reactions/")) {
      return new Response(null, { status: 204 });
    }
    if (call.url.includes("/threads")) {
      return jsonResponse({ id: ids.threadId ?? "222222222222222222" });
    }
    posted += 1;
    return jsonResponse({
      id: `${ids.messageId ?? "333333333333333333"}${posted === 1 ? "" : `-${posted}`}`,
    });
  };
};
