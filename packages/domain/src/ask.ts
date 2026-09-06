import {
  DISCORD_ACTION_ROWS_MAX,
  DISCORD_BUTTON_LABEL_MAX,
  DISCORD_BUTTONS_PER_ROW,
  DISCORD_MESSAGE_MAX,
} from "./discord/limits.ts";
import { PUBLISH_PLAN_SKILL } from "./prompt.ts";

export const MAX_ASK_OPTIONS = Math.min(
  20,
  DISCORD_BUTTONS_PER_ROW * DISCORD_ACTION_ROWS_MAX,
);

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
      problem: `question が長すぎます（${question.length} 字 / 上限 ${MAX_ASK_QUESTION_LENGTH} 字）。要点だけを渡し、長い文書は ${PUBLISH_PLAN_SKILL} の skill で URL にしてください。`,
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
    if (options.includes(option)) {
      return { problem: `options に同じ値（${option}）が 2 つあります。` };
    }
    options.push(option);
  }

  return { question, options };
};

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

  const rawIndex = parts[2];
  if (rawIndex === undefined || !/^\d+$/.test(rawIndex)) return null;

  const index = Number(rawIndex);
  if (index >= MAX_ASK_OPTIONS) return null;

  return { askId, index };
};
