import { discordThreadUrl } from "@offdesk/domain";

export type PlanScopeKindView = "thread" | "run";

/**
 * 一覧に出す上限。
 *
 * **ページングを持たない**（計画 P7b §3-1 は一覧だけを求めている）。計画は
 * 「スレッド × 名前」で 1 行なので、run と違って数が線形に増えない ——
 * ここに当たるようになったらその時点で足す方が、使われないページャを
 * 先に置くより安い。
 */
export const PLAN_LIST_LIMIT = 200;

export type PlanRow = {
  readonly planId: string;
  readonly scopeKind: PlanScopeKindView;
  readonly scopeId: string;
  readonly slug: string;
  readonly lastPublishedRunKey: string;
  /** **控え**（テーブル定義書 §4-7）。正本は R2 のオブジェクト一覧。 */
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly updatedAt: number;
};

export type PlanSummaryView = {
  readonly planId: string;
  readonly scopeKind: PlanScopeKindView;
  readonly scopeLabel: string;
  readonly scopeUrl: string | null;
  readonly slug: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly updatedAt: number;
  readonly viewUrl: string;
  readonly lastPublishedRunKey: string;
};

export type PlanStorePort = {
  readonly list: (limit: number) => Promise<readonly PlanRow[]>;
};

/**
 * 読ませる URL（要件 `F-E7`）。
 *
 * **末尾のスラッシュを落とさない。** `/p/<id>` は 301 で `/p/<id>/` へ回るが、
 * 計画の中の相対リンク（`./phase-01.md`）はスラッシュが無いと 1 階層上へ
 * 解決されるので、**最初からある形で渡す**（計画 P6 §4-4）。
 */
const planViewUrl = (planId: string): string => `/p/${planId}/`;

export const toPlanSummary = (
  row: PlanRow,
  guildId: string | null,
): PlanSummaryView => ({
  planId: row.planId,
  scopeKind: row.scopeKind,
  /*
    **`scope_id` をそのまま出す。** スレッドなら snowflake、run なら `run_key`
    —— どちらも秘密ではなく、**リンクが組めないときに残るのがこの id しかない**
    （`DISCORD_GUILD_ID` が未設定だと `scopeUrl` は `null` になる）。
  */
  scopeLabel: row.scopeId,
  scopeUrl:
    row.scopeKind === "thread"
      ? discordThreadUrl({ guildId, threadId: row.scopeId })
      : null,
  slug: row.slug,
  fileCount: row.fileCount,
  totalBytes: row.totalBytes,
  updatedAt: row.updatedAt,
  viewUrl: planViewUrl(row.planId),
  lastPublishedRunKey: row.lastPublishedRunKey,
});

export type ListPlansDeps = {
  readonly store: PlanStorePort;
  readonly guildId: string | null;
};

export const listPlanSummaries = async (
  deps: ListPlansDeps,
): Promise<readonly PlanSummaryView[]> => {
  const rows = await deps.store.list(PLAN_LIST_LIMIT);

  return rows.map((row) => toPlanSummary(row, deps.guildId));
};
