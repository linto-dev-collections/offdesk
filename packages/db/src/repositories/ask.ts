import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import { asks } from "../schema/offdesk.ts";

/*
  問い 1 つの台帳（テーブル定義書 §4-4）。SQL を持つのはこのファイルだけ（要件 `I-12`）。

  **本文と回答をログに出さない**（脅威 12）。この層は `console` を一度も呼ばない ——
  出すか出さないかを呼ぶ側に選ばせると、いつか出る。
*/

export type AskRecord = {
  readonly askId: string;
  readonly runKey: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly messageId: string | null;
  readonly answer: string | null;
  readonly answeredByDiscordUserId: string | null;
  readonly answeredAt: number | null;
  readonly answerMessageId: string | null;
  readonly deliveredAt: number | null;
  readonly createdAt: number;
};

export type InsertAskInput = {
  readonly askId: string;
  readonly runKey: string;
  readonly question: string;
  readonly options: readonly string[];
};

const ASK_COLUMNS = {
  askId: asks.askId,
  runKey: asks.runKey,
  question: asks.question,
  options: asks.options,
  messageId: asks.messageId,
  answer: asks.answer,
  answeredByDiscordUserId: asks.answeredByDiscordUserId,
  answeredAt: asks.answeredAt,
  answerMessageId: asks.answerMessageId,
  deliveredAt: asks.deliveredAt,
  createdAt: asks.createdAt,
} as const;

type AskRow = {
  askId: string;
  runKey: string;
  question: string;
  options: string;
  messageId: string | null;
  answer: string | null;
  answeredByDiscordUserId: string | null;
  answeredAt: Date | null;
  answerMessageId: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
};

/**
 * **DDL が守っているのは「JSON の配列であること」までで、要素の型は見ていない**
 * （テーブル定義書 §4-4 の判断）。要素を書くときに縛るのは `validateAsk` なので、
 * 読み出しでは**文字列でないものを落とす**。
 *
 * ここで例外を投げると、1 行の壊れた `options` が run 詳細を丸ごと落とす。
 * ボタンが 1 つ減る方が安い（`bytes.ts` の `toBytes` と同じ、境界で正規化する判断）。
 */
const parseOptions = (raw: string): readonly string[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
};

const toAskRecord = (row: AskRow): AskRecord => ({
  askId: row.askId,
  runKey: row.runKey,
  question: row.question,
  options: parseOptions(row.options),
  messageId: row.messageId,
  answer: row.answer,
  answeredByDiscordUserId: row.answeredByDiscordUserId,
  answeredAt: row.answeredAt?.getTime() ?? null,
  answerMessageId: row.answerMessageId,
  deliveredAt: row.deliveredAt?.getTime() ?? null,
  createdAt: row.createdAt.getTime(),
});

export const insertAsk = async (
  db: Db,
  input: InsertAskInput,
  nowMs: number,
): Promise<void> => {
  await db.insert(asks).values({
    askId: input.askId,
    runKey: input.runKey,
    question: input.question,
    options: JSON.stringify(input.options),
    createdAt: new Date(nowMs),
  });
};

export const findAsk = async (
  db: Db,
  askId: string,
): Promise<AskRecord | null> => {
  const [row] = await db
    .select(ASK_COLUMNS)
    .from(asks)
    .where(eq(asks.askId, askId))
    .limit(1);

  return row === undefined ? null : toAskRecord(row);
};

/** 問いを出したメッセージを結びつける。`asks_message_uidx` が二重の結びつきを止める。 */
export const attachAskMessage = async (
  db: Db,
  askId: string,
  messageId: string,
): Promise<void> => {
  await db.update(asks).set({ messageId }).where(eq(asks.askId, askId));
};

/**
 * ボタンで答える（要件 `F-B4`）。**先に答えが入っていたら書かない。**
 *
 * `WHERE answer IS NULL` を付けた 1 文なので、ほぼ同時に 2 回押されても
 * 勝つのは 1 つだけ（D1 は対話的トランザクションを持たないので、原子性は 1 文が単位）。
 * 戻り値の `false` は「負けた」——呼ぶ側はそれを人に見せる。
 *
 * **`answer` と `answered_at` を同時に入れる**（`asks_answer_pair_ck`）。
 * 別々の UPDATE にすると 1 本目で CHECK に落ちる。
 */
export const answerAskByButton = async (
  db: Db,
  askId: string,
  answer: string,
  discordUserId: string,
  nowMs: number,
): Promise<boolean> => {
  const rows = await db
    .update(asks)
    .set({
      answer,
      answeredByDiscordUserId: discordUserId,
      answeredAt: new Date(nowMs),
      /*
        **ボタン由来なら `answer_message_id` は NULL のまま**
        （テーブル定義書 §4-4）。あれは「回答が素の文から来たとき」の列で、
        入れると P4 が「素の文の 👀 を ✅ に変える」相手を取り違える。
      */
    })
    .where(and(eq(asks.askId, askId), isNull(asks.answer)))
    .returning({ askId: asks.askId });

  return rows.length === 1;
};

/**
 * **Claude へ書き出せた時点**で立てる（要件 `I-3`）。
 *
 * 立て忘れると同じ答えを何度も返し、早すぎると答えが宙に浮く。
 *
 * **答えが無い行には立てない。** `asks_delivered_ck` が禁じているので、
 * ここで防がないと呼び違いが 500 になる。既に立っている行も触らない ——
 * 「最初に渡せた時刻」を上書きしないため。
 */
export const markAskDelivered = async (
  db: Db,
  askId: string,
  nowMs: number,
): Promise<boolean> => {
  const rows = await db
    .update(asks)
    .set({ deliveredAt: new Date(nowMs) })
    .where(
      and(
        eq(asks.askId, askId),
        isNotNull(asks.answer),
        isNull(asks.deliveredAt),
      ),
    )
    .returning({ askId: asks.askId });

  return rows.length === 1;
};
