import type { PostResult } from "@offdesk/usecase";

const API_BASE = "https://discord.com/api/v10";

const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

export const isThreadChannel = (type: number | undefined): boolean =>
  type !== undefined && THREAD_CHANNEL_TYPES.has(type);

export type MessagePayload = {
  content?: string;
  embeds?: readonly unknown[];
  components?: readonly unknown[];
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
  } catch (error) {
    console.warn("[discord] fetch が例外を投げました", {
      path,
      error:
        error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
    });
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

export const fetchChannelName = async (
  config: DiscordRestConfig,
  channelId: string,
): Promise<string | null> => {
  const result = await call(config, `/channels/${channelId}`, {
    method: "GET",
    auth: "bot",
  });
  if (!result.ok) return null;

  const name = (result.body as { name?: unknown } | null)?.name;
  return typeof name === "string" && name !== "" ? name : null;
};

/**
 * そのサーバーで **bot が見えているテキストチャンネル**（計画: 18 桁の
 * スノーフレークを手で貼らせない）。
 *
 * **返ってくるのは bot に `View Channels` があるものだけ**（Discord がそう絞る）——
 * つまり**一覧に出ること自体が「bot が見えている」の確認**になる。
 * OPERATIONS §2 の「bot が見えること」という目視の手順がこれで消える。
 *
 * **スレッドは除く**（`isThreadChannel`）。プロジェクトが紐付くのは親チャンネルで、
 * スレッドは run 1 本に対応する（用語 §2）。
 *
 * **引けなければ `null`。** `DISCORD_GUILD_ID` も `DISCORD_BOT_TOKEN` も
 * 欠けても他が動く値なので、ここで投げると**チャンネルが引けないだけで
 * フォームごと開かなくなる。**
 */
export const listGuildTextChannels = async (
  config: DiscordRestConfig,
  guildId: string,
): Promise<
  readonly { readonly id: string; readonly name: string }[] | null
> => {
  const result = await call(config, `/guilds/${guildId}/channels`, {
    method: "GET",
    auth: "bot",
  });
  if (!result.ok) return null;
  if (!Array.isArray(result.body)) return null;

  const TEXT_CHANNEL = 0;
  const ANNOUNCEMENT_CHANNEL = 5;
  const postable = new Set([TEXT_CHANNEL, ANNOUNCEMENT_CHANNEL]);

  return result.body
    .filter((raw): raw is { id: string; name: string; type: number } => {
      if (typeof raw !== "object" || raw === null) return false;
      const row = raw as { id?: unknown; name?: unknown; type?: unknown };
      return (
        typeof row.id === "string" &&
        typeof row.name === "string" &&
        typeof row.type === "number" &&
        postable.has(row.type) &&
        !isThreadChannel(row.type)
      );
    })
    .map((row) => ({ id: row.id, name: row.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

export const editMessage = (
  config: DiscordRestConfig,
  channelId: string,
  messageId: string,
  payload: MessagePayload,
): Promise<PostResult> =>
  withId(
    call(config, `/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: { allowed_mentions: { parse: [] }, ...payload },
      auth: "bot",
    }),
  );

export const addReaction = (
  config: DiscordRestConfig,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<CallResult> =>
  call(
    config,
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    { method: "PUT", auth: "bot" },
  );

export const removeOwnReaction = (
  config: DiscordRestConfig,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<CallResult> =>
  call(
    config,
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    { method: "DELETE", auth: "bot" },
  );
