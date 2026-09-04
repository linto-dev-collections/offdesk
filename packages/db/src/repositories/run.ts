import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.ts";
import { runs } from "../schema/offdesk.ts";

/** DDL の `runs_status_ck` と同じ一覧（テーブル定義書 §4-3）。 */
const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "abandoned",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunRecord = {
  readonly runKey: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly status: RunStatus;
  readonly requesterDiscordUserId: string;
  readonly channelId: string;
  readonly threadId: string | null;
  readonly ccSessionId: string | null;
  readonly ccSessionUrl: string | null;
  /** 握りのハートビート（要件 `F-C5`）。**行の更新時刻ではない。** */
  readonly heldAt: number | null;
  /** Claude 由来の信号（要件 `F-C6` の長い窓）。**握りの印ではない。** */
  readonly activityAt: number | null;
  readonly finishedAt: number | null;
  readonly failureReason: string | null;
  readonly createdAt: number;
};

export type InsertRunInput = {
  readonly runKey: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly requesterDiscordUserId: string;
  readonly channelId: string;
};

const RUN_COLUMNS = {
  runKey: runs.runKey,
  projectId: runs.projectId,
  prompt: runs.prompt,
  status: runs.status,
  requesterDiscordUserId: runs.requesterDiscordUserId,
  channelId: runs.channelId,
  threadId: runs.threadId,
  ccSessionId: runs.ccSessionId,
  ccSessionUrl: runs.ccSessionUrl,
  heldAt: runs.heldAt,
  activityAt: runs.activityAt,
  finishedAt: runs.finishedAt,
  failureReason: runs.failureReason,
  createdAt: runs.createdAt,
} as const;

type RunRow = {
  runKey: string;
  projectId: string;
  prompt: string;
  status: string;
  requesterDiscordUserId: string;
  channelId: string;
  threadId: string | null;
  ccSessionId: string | null;
  ccSessionUrl: string | null;
  heldAt: Date | null;
  activityAt: Date | null;
  finishedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
};

/**
 * **`status` は DDL の CHECK が守っているので、読み出しでは信じる。**
 * ここで parse し直すと「D1 に無い値が入っていた」ときに一覧が丸ごと落ちる。
 */
const toRunRecord = (row: RunRow): RunRecord => ({
  runKey: row.runKey,
  projectId: row.projectId,
  prompt: row.prompt,
  status: row.status as RunStatus,
  requesterDiscordUserId: row.requesterDiscordUserId,
  channelId: row.channelId,
  threadId: row.threadId,
  ccSessionId: row.ccSessionId,
  ccSessionUrl: row.ccSessionUrl,
  heldAt: row.heldAt?.getTime() ?? null,
  activityAt: row.activityAt?.getTime() ?? null,
  finishedAt: row.finishedAt?.getTime() ?? null,
  failureReason: row.failureReason,
  createdAt: row.createdAt.getTime(),
});

export const insertRun = async (
  db: Db,
  input: InsertRunInput,
  nowMs: number,
): Promise<void> => {
  await db.insert(runs).values({
    ...input,
    status: "queued",
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  });
};

/** `runs_thread_created_idx`。そのスレッドのいちばん新しい run。 */
export const findRunByThread = async (
  db: Db,
  threadId: string,
): Promise<RunRecord | null> => {
  const [row] = await db
    .select(RUN_COLUMNS)
    .from(runs)
    .where(eq(runs.threadId, threadId))
    .orderBy(desc(runs.createdAt))
    .limit(1);

  return row === undefined ? null : toRunRecord(row);
};

export const attachRunThread = async (
  db: Db,
  runKey: string,
  threadId: string,
): Promise<void> => {
  await db.update(runs).set({ threadId }).where(eq(runs.runKey, runKey));
};

/** `cc_session_id` と `cc_session_url` は**対で**入れる（`runs_cc_pair_ck`）。 */
export const markRunRunning = async (
  db: Db,
  runKey: string,
  session: {
    readonly ccSessionId: string;
    readonly ccSessionUrl: string;
  } | null,
): Promise<void> => {
  await db
    .update(runs)
    .set({
      status: "running",
      ccSessionId: session?.ccSessionId ?? null,
      ccSessionUrl: session?.ccSessionUrl ?? null,
    })
    .where(eq(runs.runKey, runKey));
};

/**
 * `status='failed'` と `finished_at` を**同時に**入れる（`runs_finished_ck`）。
 * 別々の UPDATE にすると 1 本目で CHECK に落ちる。
 *
 * **理由に URL とトークンを載せない**（脅威 12）。呼ぶ側が短い文だけを渡す。
 */
export const markRunFailed = async (
  db: Db,
  runKey: string,
  reason: string,
  nowMs: number,
): Promise<void> => {
  await db
    .update(runs)
    .set({
      status: "failed",
      failureReason: reason,
      finishedAt: new Date(nowMs),
    })
    .where(eq(runs.runKey, runKey));
};

/*
  ここから下は P3a（握り）が使う。

  **`held_at` と `updated_at` を混ぜない**（テーブル定義書 §4-3）。あちらは行の更新時刻、
  こちらは「握りが生きている」印。kanata はここを 1 本で兼用していて、CLAUDE.md に
  「混ぜると死んだ質問へ回答を書き込む」という警告が書いてあった。**警告で守るのをやめて
  列で分けた**のがこの 2 つ。
*/

/** 終端でない状態（要件 §5-1 の状態機械）。この 3 つの間だけを行き来する。 */
const LIVE_STATUSES = ["queued", "running", "waiting"] as const;

export const findRun = async (
  db: Db,
  runKey: string,
): Promise<RunRecord | null> => {
  const [row] = await db
    .select(RUN_COLUMNS)
    .from(runs)
    .where(eq(runs.runKey, runKey))
    .limit(1);

  return row === undefined ? null : toRunRecord(row);
};

/**
 * 握りのハートビート（要件 `F-C5`）。**握りだけがこれを呼ぶ。**
 *
 * `$onUpdate` が付いた `updated_at` も一緒に動くが、それは「行を触った」の記録として
 * 正しい。**逆に `report`（P3b）はここを呼ばない** —— あちらは `activity_at`（要件 `F-D5`）。
 */
export const touchRunHeld = async (
  db: Db,
  runKey: string,
  nowMs: number,
): Promise<void> => {
  await db
    .update(runs)
    .set({ heldAt: new Date(nowMs) })
    .where(eq(runs.runKey, runKey));
};

/**
 * **Claude 由来の信号を最後に受けた時刻**（要件 `F-C6`・`F-D5`）。
 *
 * **`held_at` と混ぜない。** あちらは「握りが生きている」印（短い窓）で、
 * こちらは「Claude が息をしている」印（長い窓・数時間）。`report` が更新するのは
 * **こちらだけ** —— 混ぜると、死んだ問いへ回答を書き込むことになる
 * （kanata が 1 本で兼用していて、CLAUDE.md に警告が書いてあった箇所）。
 */
export const touchRunActivity = async (
  db: Db,
  runKey: string,
  nowMs: number,
): Promise<void> => {
  await db
    .update(runs)
    .set({ activityAt: new Date(nowMs) })
    .where(eq(runs.runKey, runKey));
};

/**
 * 「人の答えを待っている」に移す（状態機械の `running ─▶ waiting`）。
 *
 * **終端の run には書かない。** `runs_finished_ck` は「終端 ⇔ `finished_at` が非 NULL」を
 * 要求するので、終わった行の status だけを戻すと CHECK に落ちる。
 * `WHERE` で弾けば、呼び違いが 500 ではなく「何も起きない」になる。
 */
export const markRunWaiting = async (db: Db, runKey: string): Promise<void> => {
  await db
    .update(runs)
    .set({ status: "waiting" })
    .where(and(eq(runs.runKey, runKey), inArray(runs.status, LIVE_STATUSES)));
};

/**
 * 答えが入って作業に戻る（`waiting ─▶ running`）。
 *
 * **`markRunRunning` を使い回さない。** あちらは `cc_session_id` / `cc_session_url` を
 * 引数から入れ直すので、`null` を渡すと**起動時に入れたセッションの URL を消す**。
 */
export const markRunResumed = async (db: Db, runKey: string): Promise<void> => {
  await db
    .update(runs)
    .set({ status: "running" })
    .where(and(eq(runs.runKey, runKey), inArray(runs.status, LIVE_STATUSES)));
};

/** 終端かどうか（要件 §5-1）。握りは終端の run に問いを立てない（脅威 16）。 */
export const isTerminalStatus = (status: RunStatus): boolean =>
  !(LIVE_STATUSES as readonly string[]).includes(status);
