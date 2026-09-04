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
 * 残量の 1 行を発言の末尾に足す（要件 `F-D4`・P5 §3-5）。
 *
 * **切り詰めるのは本文の方。** 先に本文を丸めてから足さないと、
 * 長い発言のときに**残量の行だけが切り落とされる**（Discord は 2,000 字で切る）。
 * `askAnsweredMessage` が回答を添えるのと同じ形。
 */
const withContext = (body: string, contextTail: string | null): string => {
  if (contextTail === null) return truncate(body, DISCORD_MESSAGE_MAX);

  const tail = `\n${contextTail}`;
  return truncate(body, DISCORD_MESSAGE_MAX - tail.length) + tail;
};

/**
 * 問いかけ（要件 `F-B5`）。**`content` に素で出す。枠も見出しも付けない。**
 *
 * これは Claude 本人の発言だから。枠を付けてよいのは状態が変わったとき
 * （起動 / blocked / 終了）だけで、問いは状態の変化ではない。
 * **押せる口があることはボタンが示す**ので、「答えてください」も書かない。
 */
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

/* ---- report（P3b・要件 `F-D1`） ---- */

const COLOR_DONE = 0x57f287;
const COLOR_BLOCKED = 0xed4245;

/**
 * **枠を付けてよいのは状態が変わったときだけ**（要件 `F-B5`）。
 *
 * `progress` は Claude 本人の発言なので地の文で出す。`done` / `blocked` は
 * 「この run で何が起きたか」が変わった合図なので枠を付ける ——
 * スレッドを流し読みしたときに、**枠だけを追えば状態の変化が拾える**のが狙い。
 *
 * 判定は `isStateChange`（`packages/domain/src/report.ts`）。**ここで
 * `kind === "progress"` と書き直さない** —— 種を足したときに 2 か所がズレる。
 */
export const reportMessage = (
  kind: ReportKind,
  body: string,
  contextTail: string | null = null,
): MessagePayload => {
  /*
    **残量を付けるのは地の文だけ**（要件 `F-D4`）。`done` / `blocked` は
    枠（embed）で「状態が変わった」を伝える合図なので、そこに残量を混ぜると
    合図が薄まる —— しかも終わった run の残量には使い道がない。
  */
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

/* ---- セッションの終了（P5・要件 `F-D6`） ---- */

/**
 * 終了の枠（計画 P5 §3-4）。**`SessionEnd` だけがこれを出す。**
 *
 * **`Stop` から出さない**（要件 `F-D6`・`I-11`）。あれは 1 ターンの終わりなので、
 * 出すと会話の途中で「終了しました」が何度も出る（kanata が実際にそうなっていた）。
 *
 * **「続けたいならスレッドに書けばよい」を書いてある。** 終端の run のスレッドへ
 * 素で書くと起こし直しになる（要件 `F-C2`・P4）ので、**次にどうするかを
 * 知らせないと、依頼者から見るとここで行き止まりに見える。**
 */
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
