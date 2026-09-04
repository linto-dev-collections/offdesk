import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import { inbox, runs } from "../schema/offdesk.ts";

/*
  預かった素の文（テーブル定義書 §4-6・要件 `F-C2`）。

  **印を立てる順序が要件そのもの**（要件 `I-3`）:

    peek（読むだけ。印は立てない）
      → 渡す（新しい run のプロンプトに畳んで起動／ask_human の戻り値に載せる）
        → 渡し切れた → taken_at / taken_by_run_key を立てる → ✅ に付け替える
        → 渡せない   → 何も立てない（文は宙に浮かず、次の 1 行で拾い直せる）

  **先に印を立てると、起動に失敗した文がどこにも残らない。**

  **本文をログに出さない**（脅威 12）。この層は `console` を一度も呼ばない。
*/

export type InboxRecord = {
  readonly id: number;
  readonly runKey: string;
  readonly authorDiscordUserId: string;
  readonly messageId: string | null;
  readonly body: string;
  readonly createdAt: number;
};

/**
 * 素の文を預かる。
 *
 * **同じ Discord メッセージを 2 回積まない**（`inbox_message_uidx`）。Gateway は
 * 再接続時にイベントを再送しうる（resume の仕様）ので、**冪等性は D1 が担保する** ——
 * アプリ側の「見たことがあるか」の記憶に頼ると、isolate が入れ替わった瞬間に破れる。
 *
 * 戻り値は「積んだか（＝ 初めて見たメッセージか）」。`false` なら
 * **Discord の印も触らない**（既に付いている）。
 */
export const queueMessage = async (
  db: Db,
  input: {
    readonly runKey: string;
    readonly authorDiscordUserId: string;
    readonly messageId: string | null;
    readonly body: string;
  },
  nowMs: number,
): Promise<boolean> => {
  const rows = await db
    .insert(inbox)
    .values({ ...input, createdAt: new Date(nowMs) })
    /*
      **`onConflictDoNothing` で弾く。** 例外にすると、呼ぶ側が「二重で来た」と
      「本当に壊れた」を文字列で見分けることになる。
      `message_id` が NULL の行は UNIQUE の対象外なので、コマンド経由の
      預かり（元メッセージが無い）は何行でも入る。
    */
    .onConflictDoNothing({ target: inbox.messageId })
    .returning({ id: inbox.id });

  return rows.length === 1;
};

/**
 * まだ渡していない文を古い順に読む（`inbox_pending_idx`）。**印は立てない。**
 *
 * `limit` を持つのは、起こし直しのプロンプトが Discord の履歴を丸ごと
 * 飲み込まないため —— 溜まっているのは常に数件だが、上限が無いと
 * 「1 週間放置したスレッド」で `MAX_FIRE_TEXT_LENGTH` を超える。
 */
export const peekQueued = async (
  db: Db,
  runKey: string,
  limit = 20,
): Promise<readonly InboxRecord[]> => {
  const rows = await db
    .select({
      id: inbox.id,
      runKey: inbox.runKey,
      authorDiscordUserId: inbox.authorDiscordUserId,
      messageId: inbox.messageId,
      body: inbox.body,
      createdAt: inbox.createdAt,
    })
    .from(inbox)
    .where(and(eq(inbox.runKey, runKey), isNull(inbox.takenAt)))
    .orderBy(asc(inbox.id))
    .limit(limit);

  return rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime() }));
};

/**
 * **そのスレッドに溜まっている分を全部**読む（起こし直しが使う）。
 *
 * **`run_key` で引くだけでは足りない**（2026-09-04・P4 で実測）。
 * 起こし直しが起動に失敗すると、`inbox` の行は**前の run のまま**残り、
 * 新しく立った（`failed` の）run が「そのスレッドのいちばん新しい run」になる ——
 * 次の 1 行はその run で `peek` するので、**前に書いた分が誰にも渡らなくなる。**
 *
 * ```txt
 * run_key    inbox.run_key   peekQueued(最新の run) が拾うもの
 * previous   previous        ×  ← 宙に浮く
 * A(failed)  A               ○
 * ```
 *
 * **`inbox.run_key` を書き換えて解決しない。** あれは「届いた時点で生きていた run」で
 * （テーブル定義書 §4-6）、`taken_by_run_key` と対で「どこへ届いてどこへ渡ったか」を
 * 残している。**書き換えると台帳が嘘になる**ので、読む側をスレッドで引く。
 *
 * `inbox_pending_idx` は部分索引なので、走査する行は常に数件（渡し終わった行は
 * 索引から落ちる）。join の相手は `runs` の主キー。
 */
export const peekQueuedInThread = async (
  db: Db,
  threadId: string,
  limit = 20,
): Promise<readonly InboxRecord[]> => {
  const rows = await db
    .select({
      id: inbox.id,
      runKey: inbox.runKey,
      authorDiscordUserId: inbox.authorDiscordUserId,
      messageId: inbox.messageId,
      body: inbox.body,
      createdAt: inbox.createdAt,
    })
    .from(inbox)
    .innerJoin(runs, eq(runs.runKey, inbox.runKey))
    .where(and(eq(runs.threadId, threadId), isNull(inbox.takenAt)))
    .orderBy(asc(inbox.id))
    .limit(limit);

  return rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime() }));
};

/**
 * 渡し終わった文に印を立てる（要件 `I-3`）。
 *
 * **`peek` した行だけを名指しする。** 「その run の未処理を全部」にすると、
 * peek と mark の間に届いた文まで飲み込む —— **渡していない文が
 * 「渡した」ことになる**のがいちばん取り返しにくい壊れ方。
 *
 * `taken_by_run_key` には**実際に渡った run** を入れる（届いた先とは違うことがある。
 * 起こし直しでは新しい run になる）。
 *
 * 戻り値は印を立てられた行の id。**`taken_at` が既に立っている行は数えない**
 * （`WHERE taken_at IS NULL` の 1 文が競走を裁く）。
 */
export const markQueuedTaken = async (
  db: Db,
  ids: readonly number[],
  takenByRunKey: string,
  nowMs: number,
): Promise<readonly number[]> => {
  if (ids.length === 0) return [];

  const rows = await db
    .update(inbox)
    .set({ takenAt: new Date(nowMs), takenByRunKey })
    .where(and(inArray(inbox.id, [...ids]), isNull(inbox.takenAt)))
    .returning({ id: inbox.id });

  return rows.map((row) => row.id);
};

/* ここから下は P7a（管理画面）が使う。 */

/**
 * 渡し終わった分も含めて全部読む（run 詳細の時系列）。
 *
 * **`peekQueued` と分けてある。** あちらは部分索引（`inbox_pending_idx`）に
 * 乗る「未処理だけ」の引きで、印が立った行は索引から落ちる ——
 * 詳細画面が見たいのは**渡った跡**なので、条件を外した別の引きが要る。
 */
export type InboxHistoryRecord = InboxRecord & {
  readonly takenAt: number | null;
  readonly takenByRunKey: string | null;
};

export const listInbox = async (
  db: Db,
  runKey: string,
): Promise<readonly InboxHistoryRecord[]> => {
  const rows = await db
    .select({
      id: inbox.id,
      runKey: inbox.runKey,
      authorDiscordUserId: inbox.authorDiscordUserId,
      messageId: inbox.messageId,
      body: inbox.body,
      takenAt: inbox.takenAt,
      takenByRunKey: inbox.takenByRunKey,
      createdAt: inbox.createdAt,
    })
    .from(inbox)
    .where(eq(inbox.runKey, runKey))
    .orderBy(asc(inbox.id));

  return rows.map((row) => ({
    ...row,
    takenAt: row.takenAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
  }));
};
