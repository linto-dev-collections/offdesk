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
  /** 残量バーの分子（要件 `F-D4`）。**1 度も通報が来ていなければ NULL。** */
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

/* ここから下は P4（素の文）が使う。 */

/**
 * 前の run を畳んで、同じスレッドに新しい run を立てる（要件 `I-13`・計画 P4 §3-5）。
 *
 * **`batch` が原子性の単位。** D1 は対話的トランザクションを持たないので、
 * 「前を `abandoned` にする UPDATE」と「新しい INSERT」を 1 つの batch に
 * 入れなければ `runs_live_thread_uidx` の UNIQUE 違反で通らない。
 *
 * **順序を入れ替えられない。** INSERT を先に置くと、その瞬間は同じ
 * `thread_id` に生きている run が 2 本ある形になって部分ユニーク索引に落ちる。
 * **落ちる方が 2 本立つより安い**（要件 `F-C6`「起こしすぎは取り返せない」。
 * テーブル定義書 付録 A-2 で実測済み）。
 *
 * **新しい run は最初から `thread_id` を持つ。** 起こし直しは依頼者が書いた
 * スレッドの続きなので、スレッドを立て直さない（立て直すと会話が 2 本に割れる）。
 */
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
      /*
        **終端の run は触らない。** `runs_finished_ck` は「終端 ⇔ `finished_at` が
        非 NULL」を求めるので、既に `done` の行を `abandoned` に書き換えても
        壊れはしないが、**終了時刻が起こし直しの時刻に上書きされる**（run 一覧の
        所要時間が嘘になる）。生きている行だけを畳む。
      */
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

/* ここから下は P5（hooks とコンテキスト残量）が使う。 */

/**
 * コンテキストの通報を入れる（要件 `F-D4`・`F-D5`）。
 *
 * **`held_at` を触らない**（要件 `F-D5`）。これは Claude Code の hook が
 * 定期的に叩く口で、**握りが生きている証拠ではない** —— 混ぜると、
 * 誰も待っていない問いへ回答を書き込むことになる（P5 §7 の最後の行）。
 *
 * **`activity_at` は更新する。** hook が鳴っている ＝ セッションが息をしている
 * ので、素の文の判定（要件 `F-C6` の長い窓）から見て「作業中」で正しい。
 *
 * `ctx_at` と `ctx_used_tokens` は**対で入れる**（`runs_ctx_pair_ck`）。
 * `ctx_model` は対に入っていないので、分からなければ NULL のまま置ける。
 *
 * **終端の run でも書く。** `SessionEnd` の後に `Stop` が来ることはあるし、
 * 最後の残量が残っていれば P7a の run 詳細が読める。状態は触らないので、
 * 終端の意味は変わらない。
 *
 * **台帳に行があったかを返す。** 呼ぶ側がこれを見て `events` の 1 行を諦める ——
 * `events.run_key` は `runs` への外部キーなので、**存在しない run に挿すと
 * 500 になる**（hook の通報で 500 を出すと、Cloudflare のログで本物の異常と
 * 見分けがつかなくなる）。
 */
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

/**
 * セッションが終わった（`SessionEnd`。状態機械の `─▶ done`）。
 *
 * **`Stop` から呼ばない**（要件 `F-D6`・`I-11`）。あちらは 1 ターンの終わりで、
 * kanata はここを間違えて会話の途中に「🏁 セッションが終了しました」を出していた
 * （同じセッションが 8 回鳴らした記録がある）。
 *
 * **生きている run だけを畳み、畳めたかどうかを返す。** 返り値が「枠を出すか」の
 * 判断そのもの —— 同じ `SessionEnd` が 2 回来ても、2 回目は `false` になるので
 * 終了の枠が二重に出ない（`runs_finished_ck` も終端の二重書き込みを許さない）。
 */
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
