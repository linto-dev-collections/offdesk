/**
 * チャンネル（＝スレッド）を開く URL。
 *
 * **guild id が要る。** `https://discord.com/channels/@me/<id>` は DM の形なので
 * サーバー内のチャンネルには当たらない —— Discord のメッセージの中では `<#id>`
 * 記法で逃げているが（`discord/interactions.ts`）、**画面から出るのは素の
 * `<a href>`** で、あの記法は Discord のクライアントの中でしか展開されない。
 *
 * **どちらか欠けたら `null`。** 「リンクを出さない」が正しい振る舞いで、
 * 壊れた URL を出すよりも押せない方が安い。`DISCORD_GUILD_ID` は未設定でも
 * 他の面は動くので、入口を止めない（`ENDPOINT_GATED_ENV_NAMES` に並べてある）。
 */
export const discordChannelUrl = (input: {
  readonly guildId: string | null | undefined;
  readonly channelId: string | null;
}): string | null => {
  const guildId = input.guildId?.trim() ?? "";
  if (guildId === "" || input.channelId === null || input.channelId === "") {
    return null;
  }

  return `https://discord.com/channels/${guildId}/${input.channelId}`;
};

/**
 * スレッドを開く URL（計画 P7a の完了条件「Discord のスレッドへのリンクが出る」）。
 *
 * **チャンネルと同じ形。** Discord の模型ではスレッドもチャンネルなので URL は
 * 1 本で足りる —— 呼ぶ側で `threadId` を `channelId` に読み替えずに済むように、
 * 名前だけ分けて中身は委譲する。
 */
export const discordThreadUrl = (input: {
  readonly guildId: string | null | undefined;
  readonly threadId: string | null;
}): string | null =>
  discordChannelUrl({ guildId: input.guildId, channelId: input.threadId });
