import { env } from "cloudflare:workers";
import worker from "../../src/worker/index.ts";
import { testIp } from "../auth/support.ts";
import { CHANNEL_ALPHA } from "../db/support.ts";

const ORIGIN = "http://localhost:5173";

/**
 * oRPC の口を叩く。
 *
 * **本文は `{ json: … }` で包む**（oRPC の RPC プロトコル）。素の
 * `{ page: 1 }` を送ると「expected object, received undefined」になる
 * （P6 の取り消しのテストで踏んだ）。
 */
export const callRpc = async (
  path: string,
  input: unknown,
  headers: Headers = new Headers(),
): Promise<Response> => {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set("origin", ORIGIN);
  // 本番では Cloudflare が必ず付ける。付けないとレートリミットが共有バケットに落ちる。
  requestHeaders.set("cf-connecting-ip", testIp(`rpc/${path}`));

  return await worker.fetch(
    new Request(`${ORIGIN}/rpc/${path}`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ json: input }),
    }),
    env,
  );
};

/**
 * 叩いて、契約が導く形の本文だけを返す。
 *
 * **`signIn()` をここで呼ばない。** あれは `users` に行を入れるので、
 * 1 つのテストで 2 回呼ぶと `users.email` の UNIQUE に落ちる（実測）——
 * **各テストファイルが `beforeEach` で 1 回だけログインして headers を持ち回す。**
 */
export const rpcJson = async <T>(
  path: string,
  input: unknown,
  headers: Headers,
): Promise<{ readonly status: number; readonly body: T }> => {
  const response = await callRpc(path, input, headers);
  const raw = (await response.json()) as { json?: unknown };

  return { status: response.status, body: (raw.json ?? raw) as T };
};

/** `runs_key_shape_ck` に合う形（`OFFDESK-` ＋ 16 桁の小文字 16 進）。 */
export const runKeyOf = (index: number): string =>
  `OFFDESK-${index.toString(16).padStart(16, "0")}`;

export type SeedRunInput = {
  readonly runKey: string;
  readonly projectId: string;
  readonly prompt?: string;
  readonly status?: string;
  readonly threadId?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly finishedAt?: number | null;
  readonly failureReason?: string | null;
  readonly ccSession?: { readonly id: string; readonly url: string } | null;
  readonly heldAt?: number | null;
  readonly activityAt?: number | null;
  readonly ctx?: {
    readonly usedTokens: number;
    readonly at: number;
    readonly model: string | null;
  } | null;
};

/**
 * 管理画面のテスト用の種。`test/db/support.ts` の `seedRun` より細かく置ける
 * （`prompt` / `created_at` / 残量 / cc セッション）。
 *
 * **`runs_finished_ck` と `runs_ctx_pair_ck` をここで満たす。** 種を作る側で
 * 外すと、テストが「制約違反」で落ちて本題が見えなくなる。
 */
export const seedRun = async (input: SeedRunInput): Promise<string> => {
  const status = input.status ?? "running";
  const terminal = ["done", "failed", "abandoned"].includes(status);
  const createdAt = input.createdAt ?? Date.now();
  const finishedAt = terminal ? (input.finishedAt ?? createdAt + 60_000) : null;

  await env.DB.prepare(
    `INSERT INTO runs (run_key, project_id, prompt, status, requester_discord_user_id,
                       channel_id, thread_id, cc_session_id, cc_session_url,
                       held_at, activity_at, ctx_used_tokens, ctx_output_tokens,
                       ctx_at, ctx_model, finished_at, failure_reason,
                       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.runKey,
      input.projectId,
      input.prompt ?? "ping",
      status,
      "111111111111111111",
      CHANNEL_ALPHA,
      input.threadId ?? null,
      input.ccSession?.id ?? null,
      input.ccSession?.url ?? null,
      input.heldAt ?? null,
      input.activityAt ?? null,
      input.ctx?.usedTokens ?? null,
      input.ctx === null || input.ctx === undefined ? null : 0,
      input.ctx?.at ?? null,
      input.ctx?.model ?? null,
      finishedAt,
      terminal ? (input.failureReason ?? null) : null,
      createdAt,
      input.updatedAt ?? createdAt,
    )
    .run();

  return input.runKey;
};

/** `asks_id_shape_ck` に合う形（`ask_` ＋ 16 桁の小文字 16 進）。 */
export const askIdOf = (index: number): string =>
  `ask_${index.toString(16).padStart(16, "0")}`;

export const seedAsk = async (input: {
  readonly askId: string;
  readonly runKey: string;
  readonly question: string;
  readonly options?: readonly string[];
  readonly messageId?: string | null;
  readonly answer?: string | null;
  readonly answeredAt?: number | null;
  readonly deliveredAt?: number | null;
  readonly createdAt?: number;
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO asks (ask_id, run_key, question, options, message_id, answer,
                       answered_at, delivered_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.askId,
      input.runKey,
      input.question,
      JSON.stringify(input.options ?? []),
      input.messageId ?? null,
      input.answer ?? null,
      input.answer === undefined || input.answer === null
        ? null
        : (input.answeredAt ?? Date.now()),
      input.deliveredAt ?? null,
      input.createdAt ?? Date.now(),
    )
    .run();
};

export const seedEvent = async (input: {
  readonly runKey: string;
  readonly kind: string;
  readonly body: string;
  readonly discordMessageId?: string | null;
  readonly createdAt?: number;
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO events (run_key, kind, body, discord_message_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      input.runKey,
      input.kind,
      input.body,
      input.discordMessageId ?? null,
      input.createdAt ?? Date.now(),
    )
    .run();
};

export const seedInbox = async (input: {
  readonly runKey: string;
  readonly body: string;
  readonly messageId?: string | null;
  readonly takenAt?: number | null;
  readonly takenByRunKey?: string | null;
  readonly createdAt?: number;
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO inbox (run_key, author_discord_user_id, message_id, body,
                        taken_at, taken_by_run_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.runKey,
      "111111111111111111",
      input.messageId ?? null,
      input.body,
      input.takenAt ?? null,
      input.takenByRunKey ?? null,
      input.createdAt ?? Date.now(),
    )
    .run();
};
