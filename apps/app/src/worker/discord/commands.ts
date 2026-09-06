import { truncate } from "@offdesk/domain";

const OPTION_STRING = 3;
const OPTION_INTEGER = 4;
const COMMAND_CHAT_INPUT = 1;

const MAX_CHOICES = 25;
const MAX_DESCRIPTION = 100;

export const buildOffdeskCommand = (projectNames: readonly string[]) => ({
  name: "offdesk",
  type: COMMAND_CHAT_INPUT,
  description: truncate(
    "Claude Code のクラウドセッションを 1 本起こす",
    MAX_DESCRIPTION,
  ),
  options: [
    {
      name: "task",
      type: OPTION_STRING,
      description: truncate("やってほしいこと", MAX_DESCRIPTION),
      required: true,
    },
    {
      name: "project",
      type: OPTION_STRING,
      description: truncate(
        "対象プロジェクト（省略するとチャンネルの紐付けで決まる）",
        MAX_DESCRIPTION,
      ),
      required: false,
      choices: projectNames.slice(0, MAX_CHOICES).map((name) => ({
        name,
        value: name,
      })),
    },
    {
      name: "issue",
      type: OPTION_INTEGER,
      description: truncate(
        "対応する GitHub Issue の番号（ブランチが claude/issue-<番号> になる）",
        MAX_DESCRIPTION,
      ),
      required: false,
      min_value: 1,
    },
    {
      name: "pr",
      type: OPTION_INTEGER,
      description: truncate(
        "レビューする GitHub PR の番号（ブランチを作らず PR にコメントする）",
        MAX_DESCRIPTION,
      ),
      required: false,
      min_value: 1,
    },
  ],
});
