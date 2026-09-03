import {
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
