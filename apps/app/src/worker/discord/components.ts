import {
  answerCustomId,
  DISCORD_BUTTONS_PER_ROW,
  DISCORD_EMBED_DESCRIPTION_MAX,
  DISCORD_EMBED_FIELD_VALUE_MAX,
  DISCORD_MESSAGE_MAX,
  truncate,
} from "@offdesk/domain";
import type { StartedAnnouncement } from "@offdesk/usecase";
import type { MessagePayload } from "./rest.ts";

const COLOR_START = 0x5865f2;

export const EPHEMERAL = 64;

/**
 * 起動メッセージ（要件 `F-A4`）。**対象リポジトリを 1 行出す**——
 * このセッションが触れる範囲そのものだから。
 */
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

/* ---- 問いと回答（P3a・要件 `F-B5`） ---- */

const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
/** `style: 2` = secondary。**どの選択肢も等しく見えるように、色を付けない。** */
const BUTTON_SECONDARY = 2;

/**
 * 1 行 5 個で折り返す。**5 行を超える数はここへ来ない**
 * （`validateAsk` が `MAX_ASK_OPTIONS` で落とす）。
 */
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

/**
 * 問いかけ（要件 `F-B5`）。**`content` に素で出す。枠も見出しも付けない。**
 *
 * これは Claude 本人の発言だから。枠を付けてよいのは状態が変わったとき
 * （起動 / blocked / 終了）だけで、問いは状態の変化ではない。
 * **押せる口があることはボタンが示す**ので、「答えてください」も書かない。
 */
export const askMessage = (ask: {
  readonly askId: string;
  readonly question: string;
  readonly options: readonly string[];
}): MessagePayload => ({
  content: truncate(ask.question, DISCORD_MESSAGE_MAX),
  components: buttonRows(
    ask.options.map((option, index) => ({
      type: COMPONENT_BUTTON,
      style: BUTTON_SECONDARY,
      label: option,
      custom_id: answerCustomId(ask.askId, index),
    })),
  ),
});

/**
 * 答えた後の書き換え（type 7 の UPDATE_MESSAGE）。**ボタンを消して、押した内容を添える。**
 *
 * ボタンを残すと、答え済みの問いをもう一度押せる形が画面に残る
 * （台帳は `answer IS NULL` で弾くので壊れないが、押して何も起きないのは嘘の口）。
 *
 * `-# ` は Discord の小さい文字。**回答は Claude の発言ではない**ので、
 * 問いと同じ大きさで並べない。
 */
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
