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

/**
 * **起動する前に、繋ぎ先が合っているかをセッション自身に確かめさせる。**
 *
 * offdesk は `projects` 行の `repo_url` と `fire_url` を**別々に**持っているが、その routine が実際にどのリポジトリを clone するかは Anthropic 側の設定で、読み出す公開 API が無い（`/v1/claude_code/` に在るのは `fire` の 1 本だけ）。
 * つまり「Discord ではプロジェクト A を選んだのに、`fire_url` はプロジェクト B の routine で、Claude は B を書き換えた」が設定ミス 1 つで成立する。
 *
 * 台帳側では検査できないので、期待するリポジトリを payload に必ず載せ、セッションの最初に突き合わせさせる。
 * 食い違いは「変更を 1 つもせずに `blocked` で戻る」——**黙って正しそうな方を選ばせない**のが要点で、間違ったリポジトリへの push は取り消せない。
 *
 * routine は複数のリポジトリを clone できるので、「origin が違う ＝ 即異常」にはしない（作業ツリーが複数あり、cwd がたまたま別のものであり得る）。
 */
const repoSection = (repoUrl: string): readonly string[] => [
  "## 作業リポジトリ",
  "",
  `**この run が対象にしているのは \`${repoUrl}\` です。**`,
  "",
  "- **何かを変更する前に `git remote get-url origin` で確かめてください。**（末尾の `.git` やスキームの違いは同じものとみなして構いません）",
  "- 違っていたら、この routine が複数のリポジトリを clone している可能性があります。その作業ツリーへ `cd` してから始めてください。",
  `- **どこにも見つからなければ、ファイルを 1 つも変更せずに \`report\` を \`blocked\` で呼んで終えてください**（本文に「期待: ${repoUrl} / 実際に見えたもの」を書く）。offdesk の登録と routine の設定が食い違っています。**勝手に別のリポジトリで作業しないでください。**`,
  "",
];

export const buildFireText = (
  runKey: string,
  prompt: string,
  target: RunTarget,
  repoUrl: string,
): string =>
  [
    runKey,
    "",
    ...repoSection(repoUrl),
    ...targetSection(target, runKey),
    "## 指示",
    prompt,
  ].join("\n");

export const MAX_FIRE_TEXT_LENGTH = 65_536;

export const RESEND_QUESTION = "(再送)";

export const PUBLISH_PLAN_SCRIPT = "scripts/publish-plan.sh";

export const PUBLISH_PLAN_SKILL_NAME = "publishing-plans";

export const PUBLISH_PLAN_SKILL = `offdesk:${PUBLISH_PLAN_SKILL_NAME}`;

export const PLAN_WORK_DIR = "/tmp/offdesk-plans";

export const OFFDESK_TOOLS = ["ask_human", "ask_wait", "report"] as const;

/**
 * `PreToolUse` の承認フックが拾う名前（`hooks/hooks.json` と対）。
 *
 * **接頭辞が繋ぎ方で 2 通りある。** リポジトリの `.mcp.json` からだと
 * `mcp__offdesk__`、plugin からだと `mcp__plugin_offdesk_offdesk__` になる ——
 * 片方だけを書くと、経路が変わった日に誰も承認しなくなって `ask_human` が
 * 戻らず、Discord は無音のまま（エラーも出ない）。
 *
 * **末尾を `.*` にしない**（2026-09-16）。Claude Code は `new RegExp(matcher)`
 * を**アンカー無しで** `.test(toolName)` に掛けるので、`.*` は
 * 「このサーバーが将来足すツール全部」に無条件の allow を出す約束になる。
 * routine には承認する人が居ない（要件 `F-A1`）ので、**いま在る 3 本だけ**を
 * 名指しして `^…$` で閉じる —— ツールを増やしたらここも足す、が正しい手順。
 */
export const OFFDESK_TOOL_MATCHER = `^mcp__(plugin_offdesk_)?offdesk__(${OFFDESK_TOOLS.join("|")})$`;

export const isResendQuestion = (question: unknown): boolean =>
  typeof question === "string" && question.trim() === RESEND_QUESTION;

/**
 * Claude Code が MCP server instructions を切る長さ（**文字数**。バイト数ではない）。
 *
 * 実装は `instructions.length <= 2048` の素の比較で、超えると `…[truncated]` を付けて捨てる（2.1.273 のバンドルで実測）。
 * tool description も同じ 2048 で個別に切られる。
 * https://code.claude.com/docs/en/mcp
 */
export const MCP_TEXT_LIMIT = 2048;

/**
 * こちらが守る上限。切られる長さそのものを目標にしない。
 *
 * 上限ちょうどまで使うと、1 文足したその日に説明の途中で切れた文章が Claude に渡る —— 切られたことは誰にも通知されないので、症状は「なぜかツールの使い方を守らない」になる。余白を持って、そこを機械に見張らせる。
 */
export const MCP_INSTRUCTIONS_BUDGET = 1_800;

/*
  **大事な順に並べる。** 万一 2048 を超えて切られても、頭から捨てられることは
  無い（後ろが落ちる）ので、**落ちて困る順に上へ置く。**
  細かい手順は各ツールの description と skill が持つ（あちらも 2048 で切られるが、
  1 本ずつなので余裕がある）。
*/
export const SERVER_INSTRUCTIONS = `offdesk は Discord にいる依頼者との唯一の口です。

- \`run_key\` は指示の 1 行目にある \`OFFDESK-\` で始まる値をそのまま渡します。
- 判断が要ること（仕様の解釈・方針の選択・破壊的な操作の可否）は勝手に決めず、\`ask_human\` を呼んで待ってください。答えが返るまでこの呼び出しは戻りません。**待っている間トークンは消費しません。待つことを惜しまないでください。**
- **選択肢を挙げられるなら \`options\` を渡してください（1〜20 個）。** ボタンになるので依頼者は 1 回押すだけで答えられます。挙げられない問いは \`options\` 無しでよく、依頼者はスレッドに直接書いて答えます。
- 同じ内容を \`report\` と \`ask_human\` に分けて 2 回言わないでください（2 通届きます）。**「やったこと」と「次はどうするか」は 1 回の \`ask_human\` にまとめてください。**

## 3 つのツール

| ツール | いつ |
| --- | --- |
| \`ask_human\` | 判断が要る／次の指示が要る。**やったことも同じ呼び出しにまとめる** |
| \`ask_wait\` | \`ask_human\` が \`status: "pending"\` を返したとき、同じ \`ask_id\` で待ち直す |
| \`report\` | 進捗（\`progress\`）／進めなくなった（\`blocked\`）／一区切り（\`done\`） |

**\`report\` は待ちません**（すぐ戻ります）。答えが要るなら \`ask_human\` です。
**\`report(done)\` を呼んでも会話は終わりません** —— 終わるのは依頼者が「おわり」と言ったときだけです。

## 待ちが中断される形は 3 つあり、最初の 2 つは失敗ではありません

- \`status: "pending"\` … 握りの上限に達しただけ。**同じ \`ask_id\` で \`ask_wait\` を呼び直してください。** 依頼者はまだ答えていません。
- **接続エラーで落ちた**（\`ask_id\` が手元に無い）… 同じ \`run_key\` で \`ask_human\` を呼び直してください。**\`question\` は \`${RESEND_QUESTION}\` の 1 語でよい**（詳しくは \`ask_human\` の説明）。**同じ質問が 2 回出ることはありません。**
- \`status: "closed"\` … その run はもう誰も見ていません。**これ以上 offdesk のツールを呼ばず、作業を終えてください。** 返しても誰にも届きません。

## 依頼者はスレッドに素で書いて話しかけてきます

作業中にスレッドへ書かれた文は預かってあり、**次に \`ask_human\` を呼んだ時点で渡します**（\`status: "answered"\` ＋ \`note\` 付き）。**そのとき質問は出していません** —— 聞き返す前にその内容を読んでください。
問いを出して待っている間に書かれた文は、そのまま**その問いへの回答**になります。

## 長い文書は URL にして渡します

長い markdown は Discord に入りません（1 通 2,000 字）。**\`${PUBLISH_PLAN_SKILL}\` の skill に従ってください。**
**本文をツールの引数に載せないでください。** 渡すのは skill が返す **URL の 1 行だけ**です。

\`run_key\` が見つからないと言われたら、台帳にその run がありません。**MCP の接続そのものは通っています。** 指示の 1 行目の値をそのまま渡しているか確認してください。
`;

export const ROUTINE_PROMPT = `あなたは offdesk（Discord）から起動された Claude Code のクラウドセッションです。

## この実行でやること

\`<routine-fire-payload>\` ブロックの中に、依頼者本人が書いた指示が入っています。
**そこに書かれた指示を、この実行の課題として実行してください。**

payload の 1 行目は \`OFFDESK-\` で始まる実行キー（run_key）です。台帳と転写ログを突き合わせる印なので、**書き換えないでください。**
offdesk のツールにはこの値をそのまま渡します。

**payload の「作業リポジトリ」を最初に確かめてください。** この routine が clone しているリポジトリと、offdesk 側の登録が食い違っていることがあります（どちらを clone するかは offdesk からは読めません）。
**食い違っていたら、ファイルを 1 つも変更せずに \`report\` を \`blocked\` で呼んで終えてください。** 間違ったリポジトリへの push は取り消せません。

## offdesk が依頼者との唯一の口です

ツール一覧に \`${OFFDESK_TOOLS.join("` / `")}\` の 3 つがあるはずです。
**\`mcp__\` で始まる長い名前が付きます**（\`mcp__offdesk__ask_human\` のこともあれば \`mcp__plugin_offdesk_offdesk__ask_human\` のこともあります）。接頭辞は繋ぎ方で変わるので、**一覧に出ている名前をそのまま使ってください。**

**3 つの使い方はサーバーが \`initialize\` で説明します。そちらに従ってください**（この文書と食い違ったら、サーバーの言うことが正しい）。

一覧にどれも無ければ offdesk に繋がっておらず、**Discord へは何も届きません。** 無理に進めず、繋がっていないことを PR か通知で伝えて終えてください。

## 勝手に決めない・勝手に終わらない

判断が要ること（仕様の解釈・方針の選択・破壊的な操作の可否）は勝手に決めず、\`ask_human\` を呼んで待ってください。**待っている間トークンは消費しません。待つことを惜しまないでください。**

**作業が一段落しても、この実行を終わらせないでください。** \`ask_human\` で「次はどうしますか」と聞いて待ちます。**終わるのは依頼者が「おわり」と言ったときだけです。**
ただし、**依頼者が長時間答えないとサーバー側が \`status: "closed"\` を返します。** そうなったら待ち直さず、そこで終えてください。

## 成果物

**payload に作業対象（Issue や PR）の指定があれば、そこに書かれた規則に従ってください。**
指定が無ければ、コードを変更したときだけ \`claude/\` で始まるブランチに push して PR を作り、その URL を \`ask_human\` の \`question\` に含めて伝えてください。
`;
