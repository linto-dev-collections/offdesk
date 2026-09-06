import { and, asc, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { projects, runs } from "../schema/offdesk.ts";

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
  /** 使用量バーの分子（要件 `F-D4`）。**1 度も通報が来ていなければ NULL。** */
  readonly ctxUsedTokens: number | null;
  /** 参考値。**分子には含めない**（`contextUsedTokens` が足さない）。 */
  readonly ctxOutputTokens: number | null;
  readonly ctxAt: number | null;
  /** 分母を引く鍵（`contextWindowFor`）。**NULL は「分からない」。** */
  readonly ctxModel: string | null;
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
  ctxUsedTokens: runs.ctxUsedTokens,
  ctxOutputTokens: runs.ctxOutputTokens,
  ctxAt: runs.ctxAt,
  ctxModel: runs.ctxModel,
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
  ctxUsedTokens: number | null;
  ctxOutputTokens: number | null;
  ctxAt: Date | null;
  ctxModel: string | null;
  finishedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
};

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
  ctxUsedTokens: row.ctxUsedTokens,
  ctxOutputTokens: row.ctxOutputTokens,
  ctxAt: row.ctxAt?.getTime() ?? null,
  ctxModel: row.ctxModel,
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

export type StaleQueuedRun = {
  readonly runKey: string;
  readonly createdAt: number;
};

export const listStaleQueuedRuns = async (
  db: Db,
  before: number,
  limit: number,
): Promise<readonly StaleQueuedRun[]> => {
  const rows = await db
    .select({ runKey: runs.runKey, createdAt: runs.createdAt })
    .from(runs)
    .where(and(eq(runs.status, "queued"), lt(runs.createdAt, new Date(before))))
    .orderBy(asc(runs.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    runKey: row.runKey,
    createdAt: row.createdAt.getTime(),
  }));
};

export const failQueuedRun = async (
  db: Db,
  runKey: string,
  reason: string,
  nowMs: number,
): Promise<boolean> => {
  const rows = await db
    .update(runs)
    .set({
      status: "failed",
      failureReason: reason,
      finishedAt: new Date(nowMs),
    })
    .where(and(eq(runs.runKey, runKey), eq(runs.status, "queued")))
    .returning({ runKey: runs.runKey });

  return rows.length > 0;
};

const LAST_SIGN_AT = sql`max(${runs.createdAt}, coalesce(${runs.activityAt}, 0), coalesce(${runs.heldAt}, 0))`;

const SILENT_SWEEP_STATUSES = ["running", "waiting"] as const;

export type SilentRun = {
  readonly runKey: string;
};

export const listSilentLiveRuns = async (
  db: Db,
  before: number,
  limit: number,
): Promise<readonly SilentRun[]> => {
  const rows = await db
    .select({ runKey: runs.runKey })
    .from(runs)
    .where(
      and(
        inArray(runs.status, SILENT_SWEEP_STATUSES),
        sql`${LAST_SIGN_AT} < ${before}`,
      ),
    )
    .orderBy(asc(runs.createdAt))
    .limit(limit);

  return rows.map((row) => ({ runKey: row.runKey }));
};

/**
 * 信号が途絶えた run を終わらせる。
 *
 * **`abandoned` ではなく `done`。** offdesk には成功も失敗も証拠が無い
 * （`SessionEnd` は届かず `report(done)` を呼ぶ動線も無い）ので、終わり方は
 * これ 1 通りしかない —— そこに「破棄」を書くと、PR まで出して終わった run
 * 全部に嘘の札が付く。`abandoned` は `abandonAndStart`（起こし直しで前の run を
 * 捨てた）のために取っておく。`runs_failure_reason_ck` があるので理由は書けず、
 * 掃除で畳んだことは `events` の 1 行だけが持つ。
 *
 * **窓の条件を UPDATE にも入れる。** 引いてから畳むまでに信号が届いた run は
 * ここで 0 行になる —— 生きているセッションを終端にすると、その `ask_human` が
 * `closed` を受け取って作業をやめる。
 */
export const finishSilentRun = async (
  db: Db,
  input: {
    readonly runKey: string;
    readonly before: number;
  },
  nowMs: number,
): Promise<boolean> => {
  const rows = await db
    .update(runs)
    .set({
      status: "done",
      finishedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(runs.runKey, input.runKey),
        inArray(runs.status, SILENT_SWEEP_STATUSES),
        sql`${LAST_SIGN_AT} < ${input.before}`,
      ),
    )
    .returning({ runKey: runs.runKey });

  return rows.length > 0;
};

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

export const markRunWaiting = async (db: Db, runKey: string): Promise<void> => {
  await db
    .update(runs)
    .set({ status: "waiting" })
    .where(and(eq(runs.runKey, runKey), inArray(runs.status, LIVE_STATUSES)));
};

export const markRunResumed = async (db: Db, runKey: string): Promise<void> => {
  await db
    .update(runs)
    .set({ status: "running" })
    .where(and(eq(runs.runKey, runKey), inArray(runs.status, LIVE_STATUSES)));
};

export const isTerminalStatus = (status: RunStatus): boolean =>
  !(LIVE_STATUSES as readonly string[]).includes(status);

export const abandonAndStart = async (
  db: Db,
  input: {
    readonly previousRunKey: string;
    readonly run: InsertRunInput & { readonly threadId: string };
    readonly reason: string;
  },
  nowMs: number,
): Promise<void> => {
  await db.batch([
    db
      .update(runs)
      .set({
        status: "abandoned",
        failureReason: input.reason,
        finishedAt: new Date(nowMs),
      })
      .where(
        and(
          eq(runs.runKey, input.previousRunKey),
          inArray(runs.status, LIVE_STATUSES),
        ),
      ),
    db.insert(runs).values({
      ...input.run,
      status: "queued",
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    }),
  ]);
};

export const updateContextUsage = async (
  db: Db,
  input: {
    readonly runKey: string;
    readonly usedTokens: number;
    readonly outputTokens: number;
    readonly model: string | null;
  },
  nowMs: number,
): Promise<boolean> => {
  const rows = await db
    .update(runs)
    .set({
      ctxUsedTokens: input.usedTokens,
      ctxOutputTokens: input.outputTokens,
      ctxAt: new Date(nowMs),
      ctxModel: input.model,
      activityAt: new Date(nowMs),
    })
    .where(eq(runs.runKey, input.runKey))
    .returning({ runKey: runs.runKey });

  return rows.length > 0;
};

export const markRunDone = async (
  db: Db,
  runKey: string,
  nowMs: number,
): Promise<boolean> => {
  const rows = await db
    .update(runs)
    .set({ status: "done", finishedAt: new Date(nowMs) })
    .where(and(eq(runs.runKey, runKey), inArray(runs.status, LIVE_STATUSES)))
    .returning({ runKey: runs.runKey });

  return rows.length > 0;
};

export type RunSortColumn = "createdAt" | "updatedAt";

const RUN_SORT_COLUMNS = {
  createdAt: runs.createdAt,
  updatedAt: runs.updatedAt,
} as const satisfies Record<RunSortColumn, unknown>;

export type RunListFilter = {
  readonly projectId?: string | undefined;
  readonly status?: RunStatus | undefined;
  /** これ以降に作られた run だけ（epoch ミリ秒）。 */
  readonly since: number;
};

export type RunListPage = RunListFilter & {
  readonly limit: number;
  readonly offset: number;
  readonly sort: RunSortColumn;
  readonly order: "asc" | "desc";
};

export type RunListRow = {
  readonly runKey: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly status: RunStatus;
  readonly prompt: string;
  readonly threadId: string | null;
  readonly ctxUsedTokens: number | null;
  readonly ctxModel: string | null;
  readonly createdAt: number;
  readonly finishedAt: number | null;
};

export const RUN_LIST_COLUMNS = {
  runKey: runs.runKey,
  projectId: runs.projectId,
  projectName: projects.name,
  status: runs.status,
  prompt: runs.prompt,
  threadId: runs.threadId,
  ctxUsedTokens: runs.ctxUsedTokens,
  ctxModel: runs.ctxModel,
  createdAt: runs.createdAt,
  finishedAt: runs.finishedAt,
} as const;

type RunListRawRow = {
  runKey: string;
  projectId: string;
  projectName: string;
  status: string;
  prompt: string;
  threadId: string | null;
  ctxUsedTokens: number | null;
  ctxModel: string | null;
  createdAt: Date;
  finishedAt: Date | null;
};

export const toRunListRow = (row: RunListRawRow): RunListRow => ({
  runKey: row.runKey,
  projectId: row.projectId,
  projectName: row.projectName,
  status: row.status as RunStatus,
  prompt: row.prompt,
  threadId: row.threadId,
  ctxUsedTokens: row.ctxUsedTokens,
  ctxModel: row.ctxModel,
  createdAt: row.createdAt.getTime(),
  finishedAt: row.finishedAt?.getTime() ?? null,
});

const runListWhere = (filter: RunListFilter) =>
  and(
    gte(runs.createdAt, new Date(filter.since)),
    filter.projectId === undefined
      ? undefined
      : eq(runs.projectId, filter.projectId),
    filter.status === undefined ? undefined : eq(runs.status, filter.status),
  );

export const listRuns = async (
  db: Db,
  page: RunListPage,
): Promise<readonly RunListRow[]> => {
  const column = RUN_SORT_COLUMNS[page.sort];

  const rows = await db
    .select(RUN_LIST_COLUMNS)
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(runListWhere(page))
    .orderBy(page.order === "asc" ? asc(column) : desc(column))
    .limit(page.limit)
    .offset(page.offset);

  return rows.map(toRunListRow);
};

export const countRuns = async (
  db: Db,
  filter: RunListFilter,
): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(runs)
    .where(runListWhere(filter));

  return row?.total ?? 0;
};

export type RunDetailRow = RunRecord & {
  readonly projectName: string;
  readonly repoUrl: string;
};

export const findRunDetail = async (
  db: Db,
  runKey: string,
): Promise<RunDetailRow | null> => {
  const [row] = await db
    .select({
      ...RUN_COLUMNS,
      projectName: projects.name,
      repoUrl: projects.repoUrl,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(runs.runKey, runKey))
    .limit(1);

  if (row === undefined) return null;

  const { projectName, repoUrl, ...run } = row;
  return { ...toRunRecord(run), projectName, repoUrl };
};
