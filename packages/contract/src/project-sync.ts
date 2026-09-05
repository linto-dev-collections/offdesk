import { z } from "zod";

/*
  プロジェクトの**投入**の形（要件 `F-H3`）。`projects.ts` から切り出してある。

  **クライアントに配らないため**（計画 P8 §2-2）。使うのは `packages/cli` と
  Worker の投入口（`admin/projects.ts`）の 2 つだけで、画面は 1 つも使わない ——
  それでも `projects.ts` に同居している間は**クライアントのバンドルに載っていた**
  （2026-09-05 に実測）。Rollup は `z.object(...)` を「副作用があるかもしれない
  呼び出し」として残すので、**同じモジュールに居る限り落とせない** ——
  モジュールごと分けると、参照していないバンドルからは丸ごと消える。

  秘密が漏れるわけではない（`api.anthropic.com` は公開のホスト名）が、
  **「クライアントにサーバー側の形が混ざっていない」を機械で言えるようにする**のが
  この分割の目的（`release/bundle-has-no-secrets.test.ts` が走査する）。
*/

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
