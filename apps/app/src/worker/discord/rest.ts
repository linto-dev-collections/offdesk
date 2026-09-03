import type { PostResult } from "@offdesk/usecase";

const API_BASE = "https://discord.com/api/v10";

const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

export const isThreadChannel = (type: number | undefined): boolean =>
  type !== undefined && THREAD_CHANNEL_TYPES.has(type);

export type MessagePayload = {
  content?: string;
  embeds?: readonly unknown[];
  flags?: number;
  allowed_mentions?: { parse: readonly string[] };
};

export type DiscordRestConfig = {
  readonly botToken: string;
  readonly applicationId: string;
  readonly fetch: typeof fetch;
};

export type CallResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * **応答の形は口ごとに違う。** メッセージ系は `{ id }` を返すが
 * `PUT /commands` は配列を返す。ここでは本文をそのまま渡し、
 * id が要る口だけが取り出す（id を必須にすると登録が失敗扱いになる。実測）。
 */
const call = async (
  config: DiscordRestConfig,
  path: string,
  init: { method: string; body?: unknown; auth: "bot" | "none" },
): Promise<CallResult> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (init.auth === "bot") {
    headers.authorization = `Bot ${config.botToken}`;
  }

  let response: Response;
  try {
    response = await config.fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    return { ok: false, reason: "Discord に届きませんでした" };
  }

  if (!response.ok) {
    console.warn("[discord] REST が失敗を返しました", {
      path,
      status: response.status,
    });
    return { ok: false, reason: `Discord が ${response.status} を返しました` };
  }

  if (response.status === 204) return { ok: true, body: null };

  return { ok: true, body: await response.json() };
};

/** `{ id }` を返す口だけが使う。 */
const withId = async (result: Promise<CallResult>): Promise<PostResult> => {
  const resolved = await result;
  if (!resolved.ok) return resolved;

  const id = (resolved.body as { id?: unknown } | null)?.id;
  return typeof id === "string"
    ? { ok: true, id }
    : { ok: false, reason: "Discord の応答に id がありません" };
};

export const postMessage = (
  config: DiscordRestConfig,
  channelId: string,
  payload: MessagePayload,
): Promise<PostResult> =>
  withId(
    call(config, `/channels/${channelId}/messages`, {
      method: "POST",
      body: { allowed_mentions: { parse: [] }, ...payload },
      auth: "bot",
    }),
  );

/**
 * **スレッドはメッセージから立てる。** そのメッセージがスレッドの先頭になるので、
 * 起動メッセージをそのまま親にすれば「何のスレッドか」が一覧で読める。
 */
export const createThreadFromMessage = (
  config: DiscordRestConfig,
  channelId: string,
  messageId: string,
  name: string,
): Promise<PostResult> =>
  withId(
    call(config, `/channels/${channelId}/messages/${messageId}/threads`, {
      method: "POST",
      // 1440 = 1 日。放置したスレッドが並び続けるのを避ける。
      body: { name, auto_archive_duration: 1440 },
      auth: "bot",
    }),
  );

/**
 * 保留（type 5）で返したあとの本体差し替え。**bot token を使わない**
 * （interaction token 自体が資格情報）。token は 15 分で切れる。
 */
export const editOriginalResponse = (
  config: DiscordRestConfig,
  interactionToken: string,
  payload: MessagePayload,
): Promise<PostResult> =>
  withId(
    call(
      config,
      `/webhooks/${config.applicationId}/${interactionToken}/messages/@original`,
      {
        method: "PATCH",
        body: { allowed_mentions: { parse: [] }, ...payload },
        auth: "none",
      },
    ),
  );

/**
 * `/offdesk` の登録（計画 P2 §3-8）。
 *
 * `guildId` を渡すとそのサーバーだけに即時反映される（グローバルは伝播に時間がかかる）。
 * **PUT なので一覧を丸ごと置き換える** —— 出す一覧に入っていないコマンドは消える。
 */
export const putCommands = (
  config: DiscordRestConfig,
  commands: readonly unknown[],
  guildId?: string,
): Promise<CallResult> =>
  call(
    config,
    guildId === undefined
      ? `/applications/${config.applicationId}/commands`
      : `/applications/${config.applicationId}/guilds/${guildId}/commands`,
    { method: "PUT", body: commands, auth: "bot" },
  );
