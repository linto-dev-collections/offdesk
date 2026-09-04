import { describe, expect, it } from "vitest";
import { discordThreadUrl } from "./url.ts";

const GUILD = "999999999999999999";
const THREAD = "444444444444444444";

describe("discordThreadUrl", () => {
  it("guild と thread が揃えば URL になる", () => {
    expect(discordThreadUrl({ guildId: GUILD, threadId: THREAD })).toBe(
      `https://discord.com/channels/${GUILD}/${THREAD}`,
    );
  });

  /*
    **どちらか欠けたら `null`**（完了条件「NULL なら出さない」）。
    `guildId` は `DISCORD_GUILD_ID` が未設定のとき、
    `threadId` はスレッドを立てられなかったときに欠ける（要件 `F-A7`）。
  */
  it.each([
    ["guild が null", { guildId: null, threadId: THREAD }],
    ["guild が undefined", { guildId: undefined, threadId: THREAD }],
    ["guild が空文字", { guildId: "", threadId: THREAD }],
    ["guild が空白だけ", { guildId: "   ", threadId: THREAD }],
    ["thread が null", { guildId: GUILD, threadId: null }],
    ["thread が空文字", { guildId: GUILD, threadId: "" }],
    ["両方欠けている", { guildId: null, threadId: null }],
  ])("%s なら null", (_name, input) => {
    expect(discordThreadUrl(input)).toBeNull();
  });

  /** `.env` から来る値は前後に空白が付きうる。 */
  it("guild の前後の空白は落とす", () => {
    expect(discordThreadUrl({ guildId: ` ${GUILD}\n`, threadId: THREAD })).toBe(
      `https://discord.com/channels/${GUILD}/${THREAD}`,
    );
  });

  /*
    **`@me` の形は使えない。** あれは DM の URL で、サーバー内のスレッドには
    当たらない —— Discord のメッセージの中では `<#id>` 記法で逃げているが、
    画面から出るのは素の `<a href>` なので guild id が要る。
  */
  it("@me の形は組まない", () => {
    expect(
      discordThreadUrl({ guildId: GUILD, threadId: THREAD }),
    ).not.toContain("@me");
  });
});
