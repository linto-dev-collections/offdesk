import {
  DISCORD_ACTION_ROWS_MAX,
  DISCORD_BUTTON_LABEL_MAX,
  DISCORD_BUTTONS_PER_ROW,
  DISCORD_MESSAGE_MAX,
} from "./discord/limits.ts";

/*
  「Claude が人に聞く」ことの純粋層（計画 P3a）。**Discord の寸法をここで吸収し、
  worker 側は組み立てるだけにする。**

  **上限を越えた入力を黙って切り捨てない。** 選択肢が 30 個来たら「多すぎる」と
  Claude に返す。勝手に 20 個へ削ると、Claude が想定した選択肢と人が押せる選択肢が
  ズレたまま会話が進む（要件 `N-7` の「黙って欠ける失敗を残さない」と同じ判断）。

  **「✍️ 書く」ボタンを持たない**（要件 `F-B4`）。選択肢に無いことはスレッドへ
  直接書けばよく、モーダルは「同じことを 2 通りで言える口」になる。

  **選択肢は任意**（P4 で `MIN_ASK_OPTIONS = 1` を外した。2026-09-04）。
  P3a では必須にしていた —— 答える口がボタンだけの版では、選択肢 0 個の問いは
  **誰も答えられなかった**（握って上限まで待つだけ）。**P4 でスレッドに素で
  書いた文が回答になった**ので、その理由が消えた。「はい / いいえ」に落とせない
  問い（「どういう方針にする？」）を出せるのがこの変更の意味。
*/

/**
 * 構造上は 5 個 × 5 行 = 25 まで置けるが、**読めないものを出す意味がない**ので 20 で止める。
 */
export const MAX_ASK_OPTIONS = Math.min(
  20,
  DISCORD_BUTTONS_PER_ROW * DISCORD_ACTION_ROWS_MAX,
);

/** 問いは `content` に素で出る（要件 `F-B5`）。残量の 1 行（P5）の余地を残して切る。 */
export const MAX_ASK_QUESTION_LENGTH = DISCORD_MESSAGE_MAX - 200;

export type AskProblem = { readonly problem: string };

export type ValidAsk = {
  readonly question: string;
  readonly options: readonly string[];
};

export type AskValidation = ValidAsk | AskProblem;

export const isAskProblem = (value: AskValidation): value is AskProblem =>
  "problem" in value;

export const validateAsk = (input: {
  readonly question: unknown;
  readonly options: unknown;
}): AskValidation => {
  const question =
    typeof input.question === "string" ? input.question.trim() : "";
  if (question === "") return { problem: "question が空です。" };
  if (question.length > MAX_ASK_QUESTION_LENGTH) {
    return {
      problem: `question が長すぎます（${question.length} 字 / 上限 ${MAX_ASK_QUESTION_LENGTH} 字）。要点だけを渡してください。`,
    };
  }

  const raw = input.options ?? [];
  if (!Array.isArray(raw)) {
    return { problem: "options は文字列の配列にしてください。" };
  }
  if (raw.length > MAX_ASK_OPTIONS) {
    return {
      problem: `options が多すぎます（${raw.length} 個 / 上限 ${MAX_ASK_OPTIONS} 個）。選択肢を絞ってください。`,
    };
  }

  const options: string[] = [];
  for (const [index, value] of raw.entries()) {
    if (typeof value !== "string") {
      return { problem: `options[${index}] が文字列ではありません。` };
    }
    const option = value.trim();
    if (option === "") return { problem: `options[${index}] が空です。` };
    if (option.length > DISCORD_BUTTON_LABEL_MAX) {
      return {
        problem: `options[${index}] が長すぎます（${option.length} 字 / 上限 ${DISCORD_BUTTON_LABEL_MAX} 字）。`,
      };
    }
    /*
      **同じラベルを 2 つ置かせない。** 押されたときに区別できるのは index なので
      動くが、人には同じボタンが 2 つ並んで見える（どちらを押しても違いが無い）。
    */
    if (options.includes(option)) {
      return { problem: `options に同じ値（${option}）が 2 つあります。` };
    }
    options.push(option);
  }

  return { question, options };
};

/* ---- Discord の custom_id（計画 P3a §3-6） ---- */

/**
 * **`ask_id` を `custom_id` に入れる。** 押されたときに台帳を引ける唯一の手掛かりで、
 * メッセージ id から逆に引く経路（`asks_message_uidx`）に頼らずに済む。
 */
export const answerCustomId = (askId: string, index: number): string =>
  `ans:${askId}:${index}`;

export type AnswerAction = {
  readonly askId: string;
  readonly index: number;
};

export const parseAnswerCustomId = (
  customId: string | undefined,
): AnswerAction | null => {
  if (customId === undefined) return null;
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== "ans") return null;

  const askId = parts[1];
  if (askId === undefined || askId === "") return null;

  /*
    **`Number("")` は 0**。空文字を 0 番の選択肢として通すと、押していない
    ボタンの答えが入る。桁が 10 進の数字だけであることを先に見る。
  */
  const rawIndex = parts[2];
  if (rawIndex === undefined || !/^\d+$/.test(rawIndex)) return null;

  const index = Number(rawIndex);
  if (index >= MAX_ASK_OPTIONS) return null;

  return { askId, index };
};
