/**
 * スレッドの URL（計画 P7a の完了条件「Discord のスレッドへのリンクが出る」）。
 *
 * **guild id が要る。** `https://discord.com/channels/@me/<id>` は DM の形なので
 * サーバー内のスレッドには当たらない —— Discord のメッセージの中では `<#id>` 記法で
 * 逃げているが（`discord/interactions.ts`）、**画面から出るのは素の `<a href>`** で、
 * あの記法は Discord のクライアントの中でしか展開されない。
 *
 * **どちらか欠けたら `null`。** 「リンクを出さない」が正しい振る舞いで
 * （完了条件がそう書いている）、壊れた URL を出すよりも押せない方が安い。
 * `DISCORD_GUILD_ID` は未設定でも他の面は動くので、入口を止めない
 * （`ENDPOINT_GATED_ENV_NAMES` に並べてある）。
 */
export const discordThreadUrl = (input: {
  readonly guildId: string | null | undefined;
  readonly threadId: string | null;
}): string | null => {
  const guildId = input.guildId?.trim() ?? "";
  if (guildId === "" || input.threadId === null || input.threadId === "") {
    return null;
  }

  return `https://discord.com/channels/${guildId}/${input.threadId}`;
};
