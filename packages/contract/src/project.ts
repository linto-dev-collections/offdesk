import { z } from "zod";

/**
 * 画面と CLI に返す形（計画 P2 §3-10）。
 *
 * **`ciphertext` も `fireUrl` 全体も型に無い。** 型として不可能にしておけば、
 * 後から誤って足せない（脅威 3）。出すのはホストと末尾 4 文字だけ。
 */
export const ProjectSummary = z.object({
  id: z.string(),
  name: z.string(),
  discordChannelId: z.string(),
  /**
   * チャンネルを開くリンク（計画 P7b §3-2）。**`DISCORD_GUILD_ID` が
   * 未設定なら `null`** —— `discordThreadUrl` と同じ扱いで、リンクが
   * 出ないだけでどの入口も止まらない。
   */
  channelUrl: z.string().nullable(),
  repoUrl: z.string(),
  fireUrlHost: z.string(),
  fireTokenLast4: z.string().nullable(),
  disabled: z.boolean(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const ProjectListOutput = z.object({
  items: z.array(ProjectSummary),
});
export type ProjectListOutput = z.infer<typeof ProjectListOutput>;

/** `/offdesk` の `project` 選択肢を組むのに使う（名前だけ）。 */
export const ProjectNamesOutput = z.object({
  names: z.array(z.string()),
});
export type ProjectNamesOutput = z.infer<typeof ProjectNamesOutput>;
