import { createAuth } from "@offdesk/auth";
import {
  createDb,
  deletePlan,
  findPlan,
  findRun,
  finishPlan,
  isTerminalStatus,
  upsertPlan,
} from "@offdesk/db";
import {
  entryPath,
  isMarkdownPath,
  isPlanSlug,
  MAX_PLAN_FILE_BYTES,
  MAX_PLAN_FILES,
  MAX_PLAN_TOTAL_BYTES,
  newPlanId,
  normalizePlanPath,
  planContentType,
  planScope,
} from "@offdesk/domain";
import type { WorkerEnv } from "../env.ts";
import {
  PLAN_LINK_TTL_MS,
  planLinkUrl,
  signPlanLink,
  verifyPlanLink,
} from "./link.ts";
import {
  type PlanNavItem,
  planLinkExpiredPage,
  planNotFoundPage,
  planPage,
} from "./page.ts";
import { renderMarkdown } from "./render.ts";

/*
  実装計画を置いて、読ませる（要件 `F-E1`〜`F-E9`・計画 P6）。

  ## 本文を Claude の出力に通さない

  ここが設計の要（要件 `F-E3`）。計画は 1 件 200KB を超える（実測 231,647 バイト /
  7 ファイル）。**MCP ツールの引数に載せると Claude がその全部を再出力することに
  なる**ので、置く口はツールではなく素の HTTP にしてある。`publish-plan.sh` が
  `curl` でバイト列をそのまま送り、**Claude が読むのは最後に返る URL の 1 行だけ。**

  ## 読ませる口の鍵は署名付きリンク

  `V-1` の結果でそちらに倒した（`link.ts`）。だから **URL が外へ漏れる経路を
  塞ぐ**のがここの仕事 —— `Referrer-Policy: no-referrer` で外部リンクを踏んでも
  Referer に載せず、`X-Robots-Tag` で検索に載せず、
  `Cache-Control: private, no-store` で中間に残さない（要件 `F-E8`）。
*/

/** R2 のキーの接頭辞。**`plan_id` は 32hex の CHECK 済み**なので外へ出られない。 */
const keyPrefix = (planId: string): string => `plans/${planId}/`;

/** run を載せるヘッダ。本文は生のバイト列なので body には入れられない。 */
export const RUN_HEADER = "x-offdesk-run";

/**
 * 署名を持ち回す Cookie。
 *
 * **これが無いと相対リンクが全部死ぬ。** `/p/<id>/?t=…` から `./phase-01.md` を
 * 踏むとブラウザは `/p/<id>/phase-01.md` へ行き、**クエリは引き継がれない。**
 * 要件 `F-E7` が「相対リンクを書き換えない」と定めているので、リンクに署名を
 * 足して回る手は採れない —— 代わりに、最初の 1 回で通った署名を
 * **その計画のパスだけに閉じた Cookie** に預ける。
 *
 * `Path` が `/p/<plan_id>/` なので、別の計画の要求には送られない。署名自体も
 * `plan_id` に紐付いているので、送られたとしても通らない。
 */
const LINK_COOKIE = "offdesk.plan";

const textResponse = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/**
 * 読ませるページに必ず付ける（要件 `F-E8`・plans/security.md 脅威 7）。
 *
 * **CSP がエスケープの保険。** エスケープが破れても `default-src 'none'` で
 * スクリプトは動かない。`style-src 'unsafe-inline'` を許すのは、表とコード
 * ブロックの体裁を 1 枚の `<style>` で入れるため（外部 CSS を配らない）。
 *
 * **`img-src` に `'self'` を入れた**（計画 P6 §4-6 は `data:` だけと書いている）。
 * `.png` / `.jpg` / `.svg` を置けるようにしてあるのに `'self'` が無いと、
 * **計画に貼った図が 1 枚も出ない** —— 置ける拡張子と CSP が食い違っていた。
 * スクリプトの実行能力は増えない（`.svg` は `text/plain` で返すので、
 * `<img>` から参照しても中のスクリプトは動かない）。
 *
 * **`X-Frame-Options` も書く。** `frame-ancestors` は `default-src` に含まれない。
 */
const viewHeaders = (contentType: string): Record<string, string> => ({
  "content-type": contentType,
  "content-security-policy":
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "private, no-store",
});

const htmlResponse = (
  html: string,
  status: number,
  extra: Readonly<Record<string, string>> = {},
): Response =>
  new Response(html, {
    status,
    headers: { ...viewHeaders("text/html; charset=utf-8"), ...extra },
  });

const notFound = (): Response => htmlResponse(planNotFoundPage(), 404);

/** その計画に置いてあるもの（R2 のキーから接頭辞を落としたもの）。 */
const listPlanFiles = async (
  bucket: R2Bucket,
  planId: string,
): Promise<readonly { readonly path: string; readonly size: number }[]> => {
  const prefix = keyPrefix(planId);
  const files: { path: string; size: number }[] = [];
  let cursor: string | undefined;

  do {
    const page = await bucket.list(
      cursor === undefined ? { prefix } : { prefix, cursor },
    );
    for (const object of page.objects) {
      files.push({ path: object.key.slice(prefix.length), size: object.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);

  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
};

type RunGate =
  | {
      readonly ok: true;
      readonly runKey: string;
      readonly threadId: string | null;
    }
  | { readonly ok: false; readonly response: Response };

/**
 * 置く資格（plans/security.md 脅威 9）。**run が実在し、終わっていないこと。**
 *
 * 終わった run から置き直せないのは、`plans.last_published_run_key` が
 * 「最後に置き直した run」を指す控えだからではなく、**終わった run の名前で
 * 上書きできると、誰も見ていないスレッドの計画を差し替えられる**ため。
 */
const gateRun = async (request: Request, env: WorkerEnv): Promise<RunGate> => {
  const runKey = request.headers.get(RUN_HEADER)?.trim() ?? "";
  if (runKey === "") {
    return {
      ok: false,
      response: textResponse(`${RUN_HEADER} ヘッダがありません`, 400),
    };
  }

  const run = await findRun(createDb(env.DB), runKey);
  if (run === null) {
    return {
      ok: false,
      response: textResponse("その run は台帳にありません", 404),
    };
  }
  if (isTerminalStatus(run.status)) {
    return {
      ok: false,
      response: textResponse(`その run は終わっています（${run.status}）`, 400),
    };
  }

  return { ok: true, runKey: run.runKey, threadId: run.threadId };
};

/**
 * 上限まで読んで、超えたら諦める（plans/security.md 脅威 9）。
 *
 * **`Content-Length` を信じない。** 呼ぶ側が嘘を書けるので、
 * 実バイト数を数えながら読み、超えた時点でストリームを切る
 * （`arrayBuffer()` で全部受けてから測ると、その分は既に受け取っている）。
 */
const readCapped = async (
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | null> => {
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
};

/** `PUT /plans/:slug/:path` — ファイルを 1 つ置く。 */
export const handlePlanUpload = async (
  request: Request,
  env: WorkerEnv,
  params: Readonly<{ slug: string; path: string }>,
): Promise<Response> => {
  if (!isPlanSlug(params.slug)) {
    return textResponse("計画の名前が使えない形です", 400);
  }

  const path = normalizePlanPath(params.path);
  if (path === null) return textResponse("パスが使えない形です", 400);
  if (planContentType(path) === null) {
    return textResponse("置けない拡張子です", 400);
  }

  const gate = await gateRun(request, env);
  if (!gate.ok) return gate.response;

  /*
    **宣言された長さで先に落とす。** 嘘なら下の実測で落ちるが、正直な
    クライアントには「1MB を読み切ってから断る」を避けられる。
  */
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_PLAN_FILE_BYTES) {
    return textResponse("ファイルが大きすぎます（1MB まで）", 400);
  }

  const bytes = await readCapped(request.body, MAX_PLAN_FILE_BYTES);
  if (bytes === null) {
    return textResponse("ファイルが大きすぎます（1MB まで）", 400);
  }

  const db = createDb(env.DB);
  const scope = planScope({ threadId: gate.threadId, runKey: gate.runKey });
  const plan = await upsertPlan(
    db,
    {
      planId: newPlanId((byteLength) =>
        crypto.getRandomValues(new Uint8Array(byteLength)),
      ),
      scopeKind: scope.kind,
      scopeId: scope.id,
      slug: params.slug,
      runKey: gate.runKey,
    },
    Date.now(),
  );

  /*
    **置くたびにも数える**（計画 P6 §4-3）。`finish` だけで見ると、
    仕上げを呼ばないクライアントが上限を無視して置き続けられる。
    上書きの場合は自分の古い版を数えない（同じキーなので増えない）。
  */
  const existing = await listPlanFiles(env.PLANS, plan.planId);
  const others = existing.filter((file) => file.path !== path);
  if (others.length + 1 > MAX_PLAN_FILES) {
    return textResponse(`ファイルが多すぎます（${MAX_PLAN_FILES} まで）`, 400);
  }
  const totalBytes =
    others.reduce((sum, file) => sum + file.size, 0) + bytes.byteLength;
  if (totalBytes > MAX_PLAN_TOTAL_BYTES) {
    return textResponse("計画の合計が大きすぎます（8MB まで）", 400);
  }

  await env.PLANS.put(`${keyPrefix(plan.planId)}${path}`, bytes);

  return textResponse("ok", 200);
};

/**
 * `POST /plans/:slug/finish` — 置き終わり。
 *
 * **今回置かなかったものをここで消す。** 消さないと、名前を変えた古いファイルが
 * 並びに残り続けて「どれが今の計画か」が分からなくなる（`entryPath` が古い
 * `README.md` を選ぶこともある）。**消すのを最後にしているのは、先に消すと
 * 置き直している間だけ URL が空になるため。**
 *
 * 返すのが依頼者に見せる URL（署名付き。`link.ts`）。
 */
export const handlePlanFinish = async (
  request: Request,
  env: WorkerEnv,
  params: Readonly<{ slug: string }>,
): Promise<Response> => {
  if (!isPlanSlug(params.slug)) {
    return textResponse("計画の名前が使えない形です", 400);
  }

  const signingKey = env.PLAN_LINK_SIGNING_KEY?.trim() ?? "";
  /*
    **鍵が無ければ置き終われない。** 置けたのに読めない URL を返すと、
    Claude がそれを Discord に貼って依頼者が踏み、401 を見ることになる。
    ここで止めれば `publish-plan.sh` が非ゼロで落ち、Claude に失敗が届く。
  */
  if (signingKey === "") {
    console.warn("[plans] PLAN_LINK_SIGNING_KEY が未設定です");
    return textResponse("計画リンクの署名鍵が未設定です", 503);
  }

  const gate = await gateRun(request, env);
  if (!gate.ok) return gate.response;

  let payload: { paths?: unknown };
  try {
    payload = (await request.json()) as { paths?: unknown };
  } catch {
    return textResponse("JSON として読めません", 400);
  }

  const kept = new Set<string>();
  if (Array.isArray(payload.paths)) {
    for (const value of payload.paths) {
      if (typeof value !== "string") continue;
      const path = normalizePlanPath(value);
      if (path !== null) kept.add(path);
    }
  }
  if (kept.size === 0) return textResponse("送ったファイルがありません", 400);

  const db = createDb(env.DB);
  const scope = planScope({ threadId: gate.threadId, runKey: gate.runKey });
  const plan = await upsertPlan(
    db,
    {
      planId: newPlanId((byteLength) =>
        crypto.getRandomValues(new Uint8Array(byteLength)),
      ),
      scopeKind: scope.kind,
      scopeId: scope.id,
      slug: params.slug,
      runKey: gate.runKey,
    },
    Date.now(),
  );

  const before = await listPlanFiles(env.PLANS, plan.planId);
  const stale = before.filter((file) => !kept.has(file.path));
  if (stale.length > 0) {
    await env.PLANS.delete(
      stale.map((file) => `${keyPrefix(plan.planId)}${file.path}`),
    );
  }

  const files = before.filter((file) => kept.has(file.path));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > MAX_PLAN_FILES) {
    return textResponse(`ファイルが多すぎます（${MAX_PLAN_FILES} まで）`, 400);
  }
  if (totalBytes > MAX_PLAN_TOTAL_BYTES) {
    return textResponse("計画の合計が大きすぎます（8MB まで）", 400);
  }

  const now = Date.now();
  await finishPlan(
    db,
    { planId: plan.planId, fileCount: files.length, totalBytes },
    now,
  );

  const token = await signPlanLink(
    signingKey,
    plan.planId,
    now + PLAN_LINK_TTL_MS,
  );

  return Response.json({
    url: planLinkUrl({
      origin: new URL(request.url).origin,
      planId: plan.planId,
      token,
    }),
  });
};

const cookieValue = (
  header: string | null,
  name: string,
): string | undefined => {
  if (header === null) return undefined;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }

  return undefined;
};

/** その計画のパスだけに閉じた Cookie（`LINK_COOKIE` の理由を参照）。 */
const linkCookie = (input: {
  readonly planId: string;
  readonly token: string;
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}): string =>
  [
    `${LINK_COOKIE}=${encodeURIComponent(input.token)}`,
    `Path=/p/${input.planId}/`,
    `Max-Age=${input.maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(input.secure ? ["Secure"] : []),
  ].join("; ");

/**
 * `GET /p/:planId/:path` — 読ませる。
 *
 * `path` が空なら入口（`README.md`）を**そのまま**返す。リダイレクトしないのは、
 * `/p/<id>/` から見て `./phase-01.md` が `/p/<id>/phase-01.md` に解決されるため
 * （計画の中の相対リンクを 1 文字も書き換えずに済む、というのがこの作りの要点）。
 */
export const handlePlanView = async (
  request: Request,
  env: WorkerEnv,
  params: Readonly<{ planId: string; path: string }>,
): Promise<Response> => {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("t") ?? undefined;
  const token =
    queryToken ?? cookieValue(request.headers.get("cookie"), LINK_COOKIE);

  /*
    **台帳を引く前に署名を見る**（脅威 17）。ここで落ちれば、存在しない計画でも
    同じ応答になる。
  */
  const verdict = await verifyPlanLink(
    env.PLAN_LINK_SIGNING_KEY,
    params.planId,
    token,
    Date.now(),
  );

  if (verdict !== "ok") {
    /*
      **ログイン済みのブラウザは署名なしで通す**（脅威 17 の最後の行）。
      P7b の運用画面から一覧を辿るときに署名を持っていないため。
      許可外のメールはユーザー行が作られない（要件 `F-G3`）ので、
      セッションがある ＝ 許可されたメール。
    */
    const session = await createAuth(env).api.getSession({
      headers: request.headers,
    });
    if (session === null) {
      if (verdict === "unconfigured") {
        console.warn("[plans] PLAN_LINK_SIGNING_KEY が未設定です");
      }
      return verdict === "expired"
        ? htmlResponse(planLinkExpiredPage(), 401)
        : htmlResponse(planNotFoundPage(), 401);
    }
  }

  const plan = await findPlan(createDb(env.DB), params.planId);
  if (plan === null) return notFound();

  const files = await listPlanFiles(env.PLANS, params.planId);
  if (files.length === 0) return notFound();

  const path =
    params.path === ""
      ? entryPath(files.map((file) => file.path))
      : normalizePlanPath(params.path);
  if (path === null) {
    return params.path === ""
      ? notFound()
      : textResponse("パスが使えない形です", 400);
  }

  const object = await env.PLANS.get(`${keyPrefix(params.planId)}${path}`);
  if (object === null) return notFound();

  /*
    署名がクエリで来たときだけ Cookie に預ける。**Cookie で通った要求では
    出し直さない**（同じ値を毎回書くだけなので）。
  */
  const extra: Record<string, string> =
    queryToken === undefined || verdict !== "ok"
      ? {}
      : {
          "set-cookie": linkCookie({
            planId: params.planId,
            token: queryToken,
            secure: url.protocol === "https:",
            maxAgeSeconds: Math.floor(PLAN_LINK_TTL_MS / 1000),
          }),
        };

  if (!isMarkdownPath(path)) {
    const contentType = planContentType(path);

    /*
      **知らない拡張子は添付にする**（計画 P6 §4-6）。許可一覧を狭めた後に、
      前の一覧で置かれたオブジェクトが残っていても開かせない。
    */
    return new Response(object.body, {
      headers: {
        ...viewHeaders(contentType ?? "application/octet-stream"),
        ...(contentType === null
          ? { "content-disposition": "attachment" }
          : {}),
        ...extra,
      },
    });
  }

  const rendered = renderMarkdown(await object.text());
  const nav: PlanNavItem[] = files.map((file) => ({
    path: file.path,
    // **絶対パスで張る。** 入れ子のファイルから相対で張ると階層のぶんずれる。
    href: `/p/${params.planId}/${file.path}`,
    current: file.path === path,
  }));

  return htmlResponse(
    planPage({
      title: rendered.title ?? path,
      planName: plan.slug,
      files: nav,
      bodyHtml: rendered.html,
      updatedAtMs: plan.updatedAt,
    }),
    200,
    extra,
  );
};

/**
 * 計画を取り消す（要件 `F-E9`）。**offdesk で消せるのはこれだけ。**
 *
 * **R2 → 行の順**（計画 P6 §4-7）。逆にすると、行が無くて誰も辿れない
 * オブジェクトが R2 に残る（行が残る方は 404 になるだけで、掃除もできる）。
 */
export const removePlan = async (
  env: WorkerEnv,
  planId: string,
): Promise<boolean> => {
  const files = await listPlanFiles(env.PLANS, planId);
  if (files.length > 0) {
    await env.PLANS.delete(
      files.map((file) => `${keyPrefix(planId)}${file.path}`),
    );
  }

  return await deletePlan(createDb(env.DB), planId);
};
