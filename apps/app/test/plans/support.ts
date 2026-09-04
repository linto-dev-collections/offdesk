import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import worker from "../../src/worker/index.ts";
import { CHANNEL_ALPHA, seedProject, seedRun } from "../db/support.ts";
import { ORIGIN } from "../discord/support.ts";

/*
  計画の置き口と読み口を叩く道具（計画 P6 §6）。

  **`worker.fetch` を通す。** ハンドラを直接呼ぶと、Hono のルート（`:path{.+}` の
  正規表現・`/p/<32hex>` の形・301）が検査から外れる —— あれが P6 の壊れやすい
  ところなので、必ず入口から入る。
*/

export const TOKEN = "test-offdesk-token-0123456789abcdef";
export const RUN = "OFFDESK-1111111111111111";

export const call = async (request: Request): Promise<Response> => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
};

/** 置ける run を 1 本用意する（プロジェクトは 1 つでよい）。 */
export const seedPublisher = async (
  options: Readonly<{ threadId?: string | null; status?: string }> = {},
): Promise<string> => {
  const projectId = await seedProject({
    name: "alpha",
    discordChannelId: CHANNEL_ALPHA,
  });

  return await seedRun({
    projectId,
    runKey: RUN,
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    ...(options.status === undefined ? {} : { status: options.status }),
  });
};

const bearer = (token: string | null): Record<string, string> =>
  token === null ? {} : { authorization: `Bearer ${token}` };

export const putFile = async (input: {
  readonly slug: string;
  readonly path: string;
  readonly body: string | Uint8Array;
  readonly runKey?: string | null;
  readonly token?: string | null;
  readonly contentLength?: string;
}): Promise<Response> => {
  const runKey = input.runKey === undefined ? RUN : input.runKey;

  return await call(
    new Request(`${ORIGIN}/plans/${input.slug}/${input.path}`, {
      method: "PUT",
      headers: {
        ...bearer(input.token === undefined ? TOKEN : input.token),
        ...(runKey === null ? {} : { "x-offdesk-run": runKey }),
        ...(input.contentLength === undefined
          ? {}
          : { "content-length": input.contentLength }),
      },
      body: input.body,
    }),
  );
};

export const finish = async (input: {
  readonly slug: string;
  readonly paths: readonly string[] | unknown;
  readonly runKey?: string | null;
  readonly token?: string | null;
}): Promise<Response> => {
  const runKey = input.runKey === undefined ? RUN : input.runKey;

  return await call(
    new Request(`${ORIGIN}/plans/${input.slug}/finish`, {
      method: "POST",
      headers: {
        ...bearer(input.token === undefined ? TOKEN : input.token),
        ...(runKey === null ? {} : { "x-offdesk-run": runKey }),
        "content-type": "application/json",
      },
      body:
        typeof input.paths === "string"
          ? input.paths
          : JSON.stringify({ paths: input.paths }),
    }),
  );
};

export type Published = Readonly<{
  url: string;
  planId: string;
  token: string;
}>;

/** 置いて仕上げる。**返るのは依頼者に見せる URL** と、そこから解いた部品。 */
export const publish = async (input: {
  readonly slug?: string;
  readonly files: Readonly<Record<string, string | Uint8Array>>;
  readonly runKey?: string;
}): Promise<Published> => {
  const slug = input.slug ?? "github-link";

  for (const [path, body] of Object.entries(input.files)) {
    const put = await putFile({
      slug,
      path,
      body,
      ...(input.runKey === undefined ? {} : { runKey: input.runKey }),
    });
    expect(put.status).toBe(200);
  }

  const done = await finish({
    slug,
    paths: Object.keys(input.files),
    ...(input.runKey === undefined ? {} : { runKey: input.runKey }),
  });
  expect(done.status).toBe(200);

  const { url } = (await done.json()) as { url: string };
  const parsed = new URL(url);

  return {
    url,
    planId: parsed.pathname.split("/")[2] ?? "",
    token: parsed.searchParams.get("t") ?? "",
  };
};

export const view = async (input: {
  readonly planId: string;
  readonly path?: string;
  readonly token?: string;
  readonly cookie?: string;
  readonly headers?: Headers;
  readonly origin?: string;
}): Promise<Response> => {
  const origin = input.origin ?? ORIGIN;
  const query = input.token === undefined ? "" : `?t=${input.token}`;
  const headers = new Headers(input.headers);
  if (input.cookie !== undefined) headers.set("cookie", input.cookie);

  return await call(
    new Request(`${origin}/p/${input.planId}/${input.path ?? ""}${query}`, {
      headers,
    }),
  );
};

/** 台帳の控え（`file_count` / `total_bytes`）。 */
export const planRow = async (
  planId: string,
): Promise<{
  scope_kind: string;
  scope_id: string;
  slug: string;
  last_published_run_key: string;
  file_count: number;
  total_bytes: number;
} | null> => {
  const row = await env.DB.prepare(
    `SELECT scope_kind, scope_id, slug, last_published_run_key, file_count, total_bytes
     FROM plans WHERE plan_id = ?`,
  )
    .bind(planId)
    .first<{
      scope_kind: string;
      scope_id: string;
      slug: string;
      last_published_run_key: string;
      file_count: number;
      total_bytes: number;
    }>();

  return row ?? null;
};

/** R2 に残っているキー（`plans/<plan_id>/` を落としたもの）。 */
export const storedPaths = async (
  planId: string,
): Promise<readonly string[]> => {
  const prefix = `plans/${planId}/`;
  const page = await env.PLANS.list({ prefix });

  return page.objects.map((object) => object.key.slice(prefix.length)).sort();
};
