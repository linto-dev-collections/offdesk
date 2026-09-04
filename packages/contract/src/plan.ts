import { z } from "zod";

export const PlanRemoveInput = z.object({
  planId: z
    .string()
    .regex(/^[0-9a-f]{32}$/, "planId は 32 桁の小文字 16 進です"),
});

/**
 * **`false` は「消すものが無かった」。** エラーにしない（計画 P7b §5 は 404 を
 * 挙げているが、P6 でこちらに決めてある）—— 画面は一覧から消したい行を選ぶので、
 * `false` が返るのは「一覧が古い」場合で、失敗ではなく**引き直しの合図。**
 * 404 にすると、その区別が呼び出し側から消える。
 */
export const PlanRemoveOutput = z.object({
  removed: z.boolean(),
});

/** `plans_scope_kind_ck` と同じ 2 値（テーブル定義書 §4-7）。 */
export const PlanScopeKind = z.enum(["thread", "run"]);
export type PlanScopeKind = z.infer<typeof PlanScopeKind>;

/**
 * 計画一覧の 1 行（要件 `F-F` の「計画一覧」・計画 P7b §3-1）。
 *
 * **`scopeLabel` と `scopeUrl` を分けた。** 計画の素案は `scopeLabel` 1 本に
 * 「スレッドなら URL、run なら run_key」を入れる形だったが、そうすると
 * **画面が中身を見て URL かどうかを判定することになる** ——
 * しかも `DISCORD_GUILD_ID` が未設定のときは URL が組めないので、
 * その 1 本は「URL のときも id のときもある」型になる。
 *
 * **`fileCount` / `totalBytes` は控え**（正本は R2）。**画面に「控えである」ことは
 * 書かない** —— 数が合わないのは `finish` が途中で失敗した合図なので、
 * そのまま出す方が役に立つ（計画 P7b §3-1）。
 */
export const PlanSummary = z.object({
  planId: z.string(),
  scopeKind: PlanScopeKind,
  scopeLabel: z.string(),
  scopeUrl: z.string().nullable(),
  slug: z.string(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  updatedAt: z.number().int(),
  /** `/p/<planId>/`。**ログイン済みなら署名なしで開ける**（脅威 17 の最後の行）。 */
  viewUrl: z.string(),
  /** 最後に置き直した run。**計画からそれを作った run へ辿る唯一の道。** */
  lastPublishedRunKey: z.string(),
});
export type PlanSummary = z.infer<typeof PlanSummary>;

export const PlanListOutput = z.object({
  items: z.array(PlanSummary),
});
export type PlanListOutput = z.infer<typeof PlanListOutput>;
