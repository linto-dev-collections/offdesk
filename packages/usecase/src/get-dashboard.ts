import { discordThreadUrl } from "@offdesk/domain";
import {
  type RunRow,
  type RunStatusView,
  type RunSummaryView,
  toRunSummary,
} from "./list-runs.ts";

/*
  ダッシュボード（計画 P7a §3-3）。**3 枚だけ。増やさない** ——
  見ない情報を並べても気づけるようにはならない。

  Gateway の状態は P7b（ここで出すと P4 に依存する）。
*/

export const DASHBOARD_LIVE_LIMIT = 10;
export const DASHBOARD_ASK_LIMIT = 10;
export const DASHBOARD_FAILURE_LIMIT = 5;

/** 終端でない状態（要件 §5-1 の状態機械）。 */
export const DASHBOARD_LIVE_STATUSES: readonly RunStatusView[] = [
  "queued",
  "running",
  "waiting",
];

/** 終端のうち失敗。**`done` を混ぜない**（成功は気づく必要が無い）。 */
export const DASHBOARD_FAILED_STATUSES: readonly RunStatusView[] = [
  "failed",
  "abandoned",
];

export type PendingAskRowView = {
  readonly askId: string;
  readonly runKey: string;
  readonly projectName: string;
  readonly question: string;
  /** `asks.options` の生の JSON 文字列ではなく、読み出し済みの配列。 */
  readonly options: readonly string[];
  readonly messageId: string | null;
  readonly threadId: string | null;
  readonly createdAt: number;
};

export type PendingAskView = {
  readonly askId: string;
  readonly runKey: string;
  readonly projectName: string;
  readonly question: string;
  readonly optionCount: number;
  readonly postedToDiscord: boolean;
  readonly threadUrl: string | null;
  readonly createdAt: number;
};

export type DashboardStorePort = {
  readonly liveRuns: () => Promise<readonly RunRow[]>;
  readonly pendingAsks: () => Promise<readonly PendingAskRowView[]>;
  readonly recentFailures: () => Promise<readonly RunRow[]>;
};

export type DashboardView = {
  readonly liveRuns: readonly RunSummaryView[];
  readonly pendingAsks: readonly PendingAskView[];
  readonly recentFailures: readonly RunSummaryView[];
};

/**
 * **選択肢は数だけ出す。** 本文はカードに収まらないので、中身が要るなら
 * run 詳細へ辿る（一覧に全文を出さないのと同じ判断。脅威 12）。
 */
const toPendingAsk = (
  row: PendingAskRowView,
  guildId: string | null,
): PendingAskView => ({
  askId: row.askId,
  runKey: row.runKey,
  projectName: row.projectName,
  question: row.question,
  optionCount: row.options.length,
  postedToDiscord: row.messageId !== null,
  threadUrl: discordThreadUrl({ guildId, threadId: row.threadId }),
  createdAt: row.createdAt,
});

/**
 * 3 枚を並行に引く。**1 枚が空でも他の 2 枚は出す** ——
 * 台帳がまだ空のフェーズでも画面としては正しいので、空の表示を持つ。
 */
export const getDashboard = async (deps: {
  readonly store: DashboardStorePort;
  readonly guildId: string | null;
}): Promise<DashboardView> => {
  const [liveRuns, pendingAsks, recentFailures] = await Promise.all([
    deps.store.liveRuns(),
    deps.store.pendingAsks(),
    deps.store.recentFailures(),
  ]);

  return {
    liveRuns: liveRuns.map((row) => toRunSummary(row, deps.guildId)),
    pendingAsks: pendingAsks.map((row) => toPendingAsk(row, deps.guildId)),
    recentFailures: recentFailures.map((row) =>
      toRunSummary(row, deps.guildId),
    ),
  };
};
