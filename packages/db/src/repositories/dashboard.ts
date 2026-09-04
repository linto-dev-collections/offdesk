import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import { asks, projects, runs } from "../schema/offdesk.ts";
import { parseOptions } from "./ask.ts";
import {
  RUN_LIST_COLUMNS,
  type RunListRow,
  type RunStatus,
  toRunListRow,
} from "./run.ts";

/*
  ダッシュボードの 3 枚（計画 P7a §3-3）。SQL を持つのはこの層だけ（要件 `I-12`）。

  **run 一覧と同じ列で引く**（`RUN_LIST_COLUMNS`）。カードと一覧で列が違うと、
  同じ run が 2 通りに見える（片方だけ残量が出ない、など）。
*/

/**
 * 走っている run。**状態の一覧は呼ぶ側から渡す** ——
 * `LIVE_RUN_STATUSES` / `FAILED_RUN_STATUSES` の正本は `packages/contract` で、
 * ここが独自に持つと 2 か所になる。
 */
export const listRunsByStatus = async (
  db: Db,
  statuses: readonly RunStatus[],
  limit: number,
): Promise<readonly RunListRow[]> => {
  if (statuses.length === 0) return [];

  const rows = await db
    .select(RUN_LIST_COLUMNS)
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    // `runs_status_created_idx` は (status, created_at)。並びが索引と揃う。
    .where(inArray(runs.status, [...statuses]))
    .orderBy(desc(runs.createdAt))
    .limit(limit);

  return rows.map(toRunListRow);
};

export type PendingAskRow = {
  readonly askId: string;
  readonly runKey: string;
  readonly projectName: string;
  readonly question: string;
  /** **読み出し済みの配列**（`asks.options` の生の JSON ではない）。 */
  readonly options: readonly string[];
  readonly messageId: string | null;
  readonly threadId: string | null;
  readonly createdAt: number;
};

/**
 * 未回答の問い。
 *
 * **`delivered_at IS NULL` を書き落とさない。** `asks_delivered_ck` があるので
 * 「答えが無い ⇒ 渡してもいない」は常に成り立ち、条件としては `answer IS NULL` で
 * 足りる —— しかし `asks_undelivered_idx` は `WHERE delivered_at IS NULL` の
 * 部分索引なので、**書かないと索引が選ばれない**（テーブル定義書 付録 A-3）。
 *
 * **`ORDER BY created_at DESC` は索引の順序と揃わない**（あの索引は
 * `(run_key, created_at)` で先頭が `run_key`）。ここは run を跨いで新しい順に
 * 見たいので並べ替えが入るが、**部分索引に残るのは未回答の行だけ**で常に数件。
 */
export const listPendingAsks = async (
  db: Db,
  limit: number,
): Promise<readonly PendingAskRow[]> => {
  const rows = await db
    .select({
      askId: asks.askId,
      runKey: asks.runKey,
      projectName: projects.name,
      question: asks.question,
      options: asks.options,
      messageId: asks.messageId,
      threadId: runs.threadId,
      createdAt: asks.createdAt,
    })
    .from(asks)
    .innerJoin(runs, eq(runs.runKey, asks.runKey))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(and(isNull(asks.deliveredAt), isNull(asks.answer)))
    .orderBy(desc(asks.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    options: parseOptions(row.options),
    createdAt: row.createdAt.getTime(),
  }));
};
