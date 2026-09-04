import {
  answerCustomId,
  DISCORD_BUTTONS_PER_ROW,
  DISCORD_EMBED_DESCRIPTION_MAX,
  DISCORD_EMBED_FIELD_VALUE_MAX,
  DISCORD_MESSAGE_MAX,
  isStateChange,
  type ReportKind,
  truncate,
} from "@offdesk/domain";
import type { StartedAnnouncement } from "@offdesk/usecase";
import type { MessagePayload } from "./rest.ts";

const COLOR_START = 0x5865f2;

export const EPHEMERAL = 64;

export const startedMessage = (
  announcement: StartedAnnouncement,
): MessagePayload => ({
  embeds: [
    {
      color: COLOR_START,
      title: `起動しました: ${announcement.projectName}`,
      description: truncate(announcement.prompt, DISCORD_EMBED_DESCRIPTION_MAX),
      fields: [
        {
          name: "リポジトリ",
          value: truncate(announcement.repoUrl, DISCORD_EMBED_FIELD_VALUE_MAX),
        },
        { name: "run", value: announcement.runKey },
      ],
    },
  ],
});

export const noticeMessage = (text: string): MessagePayload => ({
  content: truncate(text, DISCORD_MESSAGE_MAX),
});

export const ephemeralNotice = (text: string): MessagePayload => ({
  content: truncate(text, DISCORD_MESSAGE_MAX),
  flags: EPHEMERAL,
});

const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const BUTTON_SECONDARY = 2;

const buttonRows = (buttons: readonly unknown[]): readonly unknown[] => {
  const rows: unknown[] = [];
  for (let i = 0; i < buttons.length; i += DISCORD_BUTTONS_PER_ROW) {
    rows.push({
      type: COMPONENT_ACTION_ROW,
      components: buttons.slice(i, i + DISCORD_BUTTONS_PER_ROW),
    });
  }
  return rows;
};

const withContext = (body: string, contextTail: string | null): string => {
  if (contextTail === null) return truncate(body, DISCORD_MESSAGE_MAX);

  const tail = `\n${contextTail}`;
  return truncate(body, DISCORD_MESSAGE_MAX - tail.length) + tail;
};

export const askMessage = (
  ask: {
    readonly askId: string;
    readonly question: string;
    readonly options: readonly string[];
  },
  contextTail: string | null = null,
): MessagePayload => ({
  content: withContext(ask.question, contextTail),
  components: buttonRows(
    ask.options.map((option, index) => ({
      type: COMPONENT_BUTTON,
      style: BUTTON_SECONDARY,
      label: option,
      custom_id: answerCustomId(ask.askId, index),
    })),
  ),
});

export const askAnsweredMessage = (
  question: string,
  answer: string,
): MessagePayload => {
  const tail = `\n-# → ${answer.replace(/\s+/g, " ")}`;
  return {
    content: truncate(question, DISCORD_MESSAGE_MAX - tail.length) + tail,
    // **空配列を明示する。** 省略すると Discord は「変更なし」と解釈してボタンが残る。
    components: [],
  };
};

const COLOR_DONE = 0x57f287;
const COLOR_BLOCKED = 0xed4245;

export const reportMessage = (
  kind: ReportKind,
  body: string,
  contextTail: string | null = null,
): MessagePayload => {
  if (!isStateChange(kind)) {
    return { content: withContext(body, contextTail) };
  }

  const done = kind === "done";
  return {
    embeds: [
      {
        color: done ? COLOR_DONE : COLOR_BLOCKED,
        title: done ? "🏁 完了" : "⛔ 進めません",
        description: truncate(body, DISCORD_EMBED_DESCRIPTION_MAX),
      },
    ],
  };
};

export const sessionEndMessage = (): MessagePayload => ({
  embeds: [
    {
      color: COLOR_DONE,
      title: "🏁 セッションが終了しました",
      description:
        "続けるときはこのスレッドに書いてください。新しく起こし直します。",
    },
  ],
});
