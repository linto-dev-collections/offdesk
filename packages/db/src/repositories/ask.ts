import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
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

/**
 * **返せていない問いのうち、いちばん新しいもの**（要件 `F-B3`・計画 P3b §3-2）。
 *
 * 握りが落ちても失わせないための唯一の手掛かり。`ask_human` は「問いを立てる」の
 * 前にこれを引き、あれば**出し直さずに拾い直す。**
 *
 * **古い方を拾わない。** 会話が先へ進んだ後に昔の答えが蘇る。
 *
 * **`WHERE delivered_at IS NULL` を `asks_undelivered_idx` の条件と揃えてある**
 * （テーブル定義書 付録 A-3）。書き落とすと部分索引が選ばれず全表走査に落ちる ——
 * 実測で `SEARCH asks USING INDEX asks_undelivered_idx (run_key=?)` を確認済み。
 */
export const findLatestUndeliveredAsk = async (
  db: Db,
  runKey: string,
): Promise<AskRecord | null> => {
  const [row] = await db
    .select(ASK_COLUMNS)
    .from(asks)
    .where(and(eq(asks.runKey, runKey), isNull(asks.deliveredAt)))
    .orderBy(desc(asks.createdAt))
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

/**
 * スレッドに素で書いた文で答える（要件 `F-C2` の 1 行目・計画 P4 §3-5）。
 *
 * **`answerAskByButton` と分けてある**のは `answer_message_id` の 1 列のため ——
 * あれは「その回答がどの Discord メッセージから来たか」で、
 * **`delivered_at` を立てるときに 👀 を ✅ へ付け替える相手**（要件 `I-3`・`F-C4`）。
 * ボタン由来の回答には元メッセージが無いので、あちらは NULL のまま。
 *
 * 競走の裁き方は同じ（`WHERE answer IS NULL` の 1 文）。ボタンと素の文が
 * ほぼ同時に来ても、勝つのは 1 つだけ。
 */
export const answerAskByMessage = async (
  db: Db,
  askId: string,
  input: {
    readonly answer: string;
    readonly discordUserId: string;
    readonly answerMessageId: string;
  },
  nowMs: number,
): Promise<boolean> => {
  const rows = await db
    .update(asks)
    .set({
      answer: input.answer,
      answeredByDiscordUserId: input.discordUserId,
      answeredAt: new Date(nowMs),
      answerMessageId: input.answerMessageId,
    })
    .where(and(eq(asks.askId, askId), isNull(asks.answer)))
    .returning({ askId: asks.askId });

  return rows.length === 1;
};

/**
 * その Discord メッセージを回答として使った問い（P4 の再送対策）。
 *
 * **Gateway は再接続時にイベントを再送しうる**（resume の仕様）。溜める側は
 * `inbox_message_uidx` が二重を止めるが、**回答として使った文は `inbox` に
 * 入らない**ので、そちらの冪等性はこの引きが担う ——
 * これが無いと、再送された回答が 2 通目として `inbox` に積まれる。
 *
 * **UNIQUE 索引を張っていない列を引く**（`answer_message_id`）。1 件しか無い
 * ことを索引で保証していないので `limit(1)` で読む —— 検査したいのは
 * 「この文はもう扱ったか」だけで、何件あるかは問題にならない。
 */
export const findAskByAnswerMessage = async (
  db: Db,
  answerMessageId: string,
): Promise<AskRecord | null> => {
  const [row] = await db
    .select(ASK_COLUMNS)
    .from(asks)
    .where(eq(asks.answerMessageId, answerMessageId))
    .limit(1);

  return row === undefined ? null : toAskRecord(row);
};
