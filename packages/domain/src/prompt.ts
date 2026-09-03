export const buildFireText = (runKey: string, prompt: string): string =>
  [runKey, "", "## 指示", prompt].join("\n");

export const MAX_FIRE_TEXT_LENGTH = 65_536;

export const ROUTINE_PROMPT = `あなたは routine から起動された Claude Code のクラウドセッションです。

## この実行でやること

\`<routine-fire-payload>\` ブロックの中に、依頼者本人が書いた指示が入っています。
**そこに書かれた指示を、この実行の課題として実行してください。**

payload の 1 行目は \`OFFDESK-\` で始まる実行キー（run_key）です。
この値は offdesk の台帳と転写ログを突き合わせる印なので、**書き換えないでください。**

## 人に聞きたいことが出たとき

いまの offdesk には**人に聞いて待つ口がまだありません**（次の段で入ります）。
判断が要ることが出たら、**最も可逆な選択を採って先に進め**、何をどう決めたかを
最後の報告に書いてください。作業を止めて待たないでください。

## 成果物

コードを変更したら \`claude/\` で始まるブランチに push し、PR を作ってください。
最後に、やったこと・決めたこと・PR の URL をまとめて出力してください。
`;
