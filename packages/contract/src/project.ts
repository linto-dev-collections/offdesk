import { z } from "zod";

/**
 * `projects.fire_url` に許す形（plans/security.md 脅威 3 の 2 層目）。
 *
 * 同じ規則を D1 の `projects_fire_url_ck`・`packages/domain/src/fire.ts`・ここが見る。
 * **3 つとも `https://api.anthropic.com/` の前方一致。**
 */
export const FIRE_URL_PREFIX = "https://api.anthropic.com/";

/**
 * プロジェクトの投入（要件 `F-H3`）。**CLI と Worker の投入口が同じスキーマを使う。**
 *
 * 形を DDL の CHECK に合わせてある（テーブル定義書 §4-1）。DDL に落ちる値が
 * ここを通ってしまうと、原因が「D1 の CHECK 違反」という読みにくい形で出る。
 */
export const ProjectSyncEntry = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/,
      "name は英小文字・数字・_ - だけで、先頭は英数字にしてください",
    ),
  discordChannelId: z
    .string()
    .regex(/^[0-9]{15,24}$/, "discordChannelId は 15〜24 桁の数字です"),
  repoUrl: z.string().startsWith("https://"),
  fireUrl: z.string().startsWith(FIRE_URL_PREFIX),
  fireToken: z.string().min(8),
  contextWindowTokens: z.number().int().positive(),
});
export type ProjectSyncEntry = z.infer<typeof ProjectSyncEntry>;

/**
 * **同じ名前・同じチャンネルを 2 つ入れさせない**（要件 `F-H4`）。
 * D1 の UNIQUE でも止まるが、そちらは batch の途中で落ちるので何件入ったか分からない。
 */
export const ProjectSyncInput = z.object({
  projects: z
    .array(ProjectSyncEntry)
    .min(1)
    .superRefine((entries, ctx) => {
      for (const [field, label] of [
        ["name", "name"],
        ["discordChannelId", "discordChannelId"],
      ] as const) {
        const seen = new Set<string>();
        for (const [index, entry] of entries.entries()) {
          const value = entry[field];
          if (seen.has(value)) {
            ctx.addIssue({
              code: "custom",
              path: [index, field],
              message: `同じ ${label} が 2 つあります`,
            });
          }
          seen.add(value);
        }
      }
    }),
});
export type ProjectSyncInput = z.infer<typeof ProjectSyncInput>;

export const ProjectSyncResult = z.object({
  applied: z.array(
    z.object({
      name: z.string(),
      inserted: z.boolean(),
      fireTokenLast4: z.string(),
    }),
  ),
});
export type ProjectSyncResult = z.infer<typeof ProjectSyncResult>;

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
  repoUrl: z.string(),
  fireUrlHost: z.string(),
  fireTokenLast4: z.string().nullable(),
  contextWindowTokens: z.number().int(),
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
