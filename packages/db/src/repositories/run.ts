import { desc, eq } from "drizzle-orm";
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
