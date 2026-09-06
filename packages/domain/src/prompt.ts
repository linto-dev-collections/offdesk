import type { RunTarget } from "./target.ts";
import { BRANCH_PREFIX, branchFor, branchSuffix } from "./target.ts";

const targetSection = (
  target: RunTarget,
  runKey: string,
): readonly string[] => {
  if (target.kind === "issue") {
    const branch = branchFor(target);
    return [
      "## 作業対象",
      "",
      `**GitHub Issue #${target.number}** です。`,
      "",
      `- **まず \`gh issue view ${target.number} --comments\` で中身を読んでから始めてください。**`,
      `- **ブランチは \`${branch}\`。** 既にあれば checkout して続きを push します（作り直さない）。`,
      `- PR は 1 本に保ちます。このブランチの PR が既にあればそこへ push し、無ければ作って **本文に \`Closes #${target.number}\`** を入れてください。`,
      "",
    ];
  }

  if (target.kind === "pull") {
    return [
      "## 作業対象",
      "",
      `**GitHub Pull Request #${target.number}** です。`,
      "",
      `- **まず \`gh pr view ${target.number} --comments\` と \`gh pr diff ${target.number}\` で中身を読んでください。**`,
      "- **ブランチを作らないでください。** 指摘は `gh pr review` / `gh pr comment` で PR に直接書きます。",
      "- **Discord に指摘の本文を書かないでください** —— 返すのは PR の URL 1 行だけです。",
      `- 直す必要が出たら **#${target.number} の head ブランチに checkout して push** します。拒否されたら勝手に別ブランチへ逃げず、\`ask_human\` で相談してください。`,
      "",
    ];
  }

  return [
    "## 作業対象",
    "",
    "対応する Issue や PR の指定はありません。",
    "",
    "- **コードを変更しないなら、ブランチも PR も作らないでください。**",
    `- 変更するときのブランチは \`${BRANCH_PREFIX}<内容が分かる短い名前>-${branchSuffix(runKey)}\` です（末尾は変えないでください。GitHub の側からこの run を引くための印です）。`,
    "",
  ];
};

export const buildFireText = (
  runKey: string,
  prompt: string,
  target: RunTarget,
): string =>
  [runKey, "", ...targetSection(target, runKey), "## 指示", prompt].join("\n");

export const MAX_FIRE_TEXT_LENGTH = 65_536;

export const RESEND_QUESTION = "(再送)";

export const PUBLISH_PLAN_SCRIPT = "scripts/publish-plan.sh";

export const PUBLISH_PLAN_SKILL_NAME = "publishing-plans";

export const PUBLISH_PLAN_SKILL = `offdesk:${PUBLISH_PLAN_SKILL_NAME}`;

export const PLAN_WORK_DIR = "/tmp/offdesk-plans";

export const OFFDESK_TOOLS = ["ask_human", "ask_wait", "report"] as const;

export const OFFDESK_TOOL_MATCHER = "mcp__(plugin_offdesk_)?offdesk__.*";

export const isResendQuestion = (question: unknown): boolean =>
  typeof question === "string" && question.trim() === RESEND_QUESTION;

export const SERVER_INSTRUCTIONS = `offdesk は Discord にいる依頼者との唯一の口です。

- \`run_key\` は指示の 1 行目にある \`OFFDESK-\` で始まる値をそのまま渡します。
- 判断が要ること（仕様の解釈・方針の選択・破壊的な操作の可否）は勝手に決めず、\`ask_human\` を呼んで待ってください。答えが返るまでこの呼び出しは戻りません。**待っている間トークンは消費しません。待つことを惜しまないでください。**
- **選択肢を挙げられるなら \`options\` を渡してください（1〜20 個）。** ボタンになるので依頼者は 1 回押すだけで答えられます。挙げられない問い（「どういう方針にする？」）は \`options\` 無しでよく、依頼者はスレッドに直接書いて答えます。
- 同じ内容を \`report\` と \`ask_human\` に分けて 2 回言わないでください（2 通届きます）。**「やったこと」と「次はどうするか」は 1 回の \`ask_human\` にまとめてください。**

## 3 つのツール

| ツール | いつ |
| --- | --- |
| \`ask_human\` | 判断が要る／次の指示が要る。**やったことも同じ呼び出しにまとめる** |
| \`ask_wait\` | \`ask_human\` が \`status: "pending"\` を返したとき、同じ \`ask_id\` で待ち直す |
| \`report\` | 作業中の進捗（\`progress\`）／進めなくなった（\`blocked\`）／一区切り（\`done\`） |

**\`report\` は待ちません**（すぐ戻ります）。答えが要るなら \`ask_human\` です。
**\`report(done)\` を呼んでも会話は終わりません** —— 終わるのは依頼者が「おわり」と言ったときだけです。

## 待ちが中断される形は 3 つあり、最初の 2 つは失敗ではありません

- \`status: "pending"\` … 握りの上限に達しただけ。**同じ \`ask_id\` で \`ask_wait\` を呼び直してください。** 依頼者はまだ答えていません。
- **接続エラーで落ちた**（\`transport dropped\` など。\`ask_id\` が手元に無い）… 同じ \`run_key\` で \`ask_human\` を呼び直してください。**\`question\` は \`${RESEND_QUESTION}\` の 1 語でよく、\`options\` は要りません** —— サーバーが直前の問いを覚えていて、出したままの問いを握り直すか、切れている間に届いた答えを返します。**Discord に同じ質問が 2 回出ることはありません。**
- \`status: "closed"\` … その run はもう誰も見ていません。**これ以上 offdesk のツールを呼ばず、作業を終えてください。** 返しても誰にも届きません。

## 依頼者はスレッドに素で書いて話しかけてきます

作業中に依頼者がスレッドへ書いた文は預かってあり、**次に \`ask_human\` を呼んだ時点で渡します**（\`status: "answered"\` ＋ \`note\` 付き）。**そのとき質問は出していません** —— 依頼者は先に喋っているので、聞き返す前にその内容を読んでください。
まだ確認が要るなら、それを踏まえてもう一度 \`ask_human\` を呼んでください。

問いを出して待っている間に書かれた文は、そのまま**その問いへの回答**になります（ボタンを押すのと同じです）。

## 長い文書は URL にして渡します

実装計画のような長い markdown は Discord に入りません（1 通 2,000 字）。
**\`${PUBLISH_PLAN_SKILL}\` の skill に手順があります。それに従ってください。**

- **本文をツールの引数に載せないでください。** 計画は 200KB を超えるので、そのまま再出力することになります。渡すのは skill が返す **URL の 1 行だけ**です。

\`run_key\` が見つからないと言われたら、台帳にその run がありません。**ただし MCP の接続そのものは通っています**（このエラーはサーバーが返しています）。
指示の 1 行目の値をそのまま渡しているか確認してください。
`;

export const ROUTINE_PROMPT = `あなたは offdesk（Discord）から起動された Claude Code のクラウドセッションです。

## この実行でやること

\`<routine-fire-payload>\` ブロックの中に、依頼者本人が書いた指示が入っています。
**そこに書かれた指示を、この実行の課題として実行してください。**

payload の 1 行目は \`OFFDESK-\` で始まる実行キー（run_key）です。台帳と転写ログを突き合わせる印なので、**書き換えないでください。**
offdesk のツールにはこの値をそのまま渡します。

## offdesk が依頼者との唯一の口です

ツール一覧に \`${OFFDESK_TOOLS.join("` / `")}\` の 3 つがあるはずです。
**\`mcp__\` で始まる長い名前が付きます**（\`mcp__offdesk__ask_human\` のこともあれば \`mcp__plugin_offdesk_offdesk__ask_human\` のこともあります）。接頭辞は繋ぎ方で変わるので、**一覧に出ている名前をそのまま使ってください。**

**3 つの使い方はサーバーが \`initialize\` で説明します。そちらに従ってください**（この文書と食い違ったら、サーバーの言うことが正しい）。

一覧にどれも無ければ offdesk に繋がっておらず、**Discord へは何も届きません。** 無理に進めず、繋がっていないことを PR か通知で伝えて終えてください。

## 勝手に決めない・勝手に終わらない

判断が要ること（仕様の解釈・方針の選択・破壊的な操作の可否）は勝手に決めず、\`ask_human\` を呼んで待ってください。**待っている間トークンは消費しません。待つことを惜しまないでください。**

**作業が一段落しても、この実行を終わらせないでください。** \`ask_human\` で「次はどうしますか」と聞いて待ちます。**終わるのは依頼者が「おわり」と言ったときだけです。**

## 成果物

**payload に作業対象（Issue や PR）の指定があれば、そこに書かれた規則に従ってください。**
指定が無ければ、コードを変更したときだけ \`claude/\` で始まるブランチに push して PR を作り、その URL を \`ask_human\` の \`question\` に含めて伝えてください。
`;
