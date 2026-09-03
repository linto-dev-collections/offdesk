import { truncate } from "@offdesk/domain";

/*
  `/offdesk` の定義（計画 P2 §3-8）。

  **`project` の choices は D1 の `projects` から作る。** `projects.json` から作ると
  「投入したのに選択肢に出ない」がズレとして残る（正本は D1 ＝ 要件 `F-H1`）。
*/

const OPTION_STRING = 3;
const COMMAND_CHAT_INPUT = 1;

/** Discord の上限。超えると 400 になる。 */
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
  ],
});
