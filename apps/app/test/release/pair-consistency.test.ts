import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ASK_HOLD_MS,
  PLAN_WORK_DIR,
  RECOMMENDED_CLIENT_IDLE_TIMEOUT_MS,
  ROUTINE_PROMPT,
  SERVER_INSTRUCTIONS,
} from "@offdesk/domain";
import { describe, expect, it } from "vitest";

/*
  要件 §9-1・§9-2・§9-4 の「**対で維持するもの**」を機械で守る（計画 P8 §3-4）。

  kanata はこれを CLAUDE.md の表で**人に守らせていた。** 守れなかったときの症状が
  「静かに動かない」（承認待ちで固まる・素の文を拾わない・握りが 5 分で落ちる）
  なので、**人の注意力に置くのがいちばん高くつく場所**だった。

  ## ここに書くもの / 書かないもの

  §9-1 の表のうち、**他のテストが既に見ているものは書かない**（二重に持たない）:

  | 対 | 見ているテスト |
  | --- | --- |
  | `run_key` の形 ↔ hook の grep | `hook-template.test.ts` |
  | hook の名前 ↔ `settings.json` | `hook-template.test.ts` |
  | `/hooks/*` ↔ スクリプトが叩く URL | `hook-template.test.ts` |
  | ツール名 ↔ `.mcp.json` ↔ `settings.json` ↔ `ROUTINE_PROMPT` | `mcp-template.test.ts` |
  | `publish-plan.sh` ↔ `/plans/*` | `plan-template.test.ts` |
  | 環境変数の一覧 ↔ `alchemy.run.ts` ↔ `.env.example` ↔ CI | `env-required.test.ts` |
  | cron の文字列 3 か所 | `cron-consistency.test.ts` |
  | Worker の口 ↔ `run_worker_first` | `run-worker-first.test.ts` |
  | 常駐 DO ↔ intent | `single-gateway.test.ts` |

  **残りがここ。** どれも「コードの外に置く設定」が相手なので、
  **`OPERATIONS.md` が唯一の記録**になる —— `plans/` と `docs/` は使い捨てで
  commit されないので、あちらに書いた知識は捨てた時点で失われる。
*/

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const OPERATIONS = readSource("OPERATIONS.md");
const WORKER_ENV = readSource("apps/app/src/worker/env.ts");

/** `const NAME ... = [ ... ]` の中の文字列リテラル（`env-required.test.ts` と同じ形）。 */
const namesIn = (source: string, constant: string): readonly string[] => {
  const block = new RegExp(
    `const ${constant}[^=]*=\\s*\\[([\\s\\S]*?)\\]`,
  ).exec(source);
  if (block?.[1] === undefined) {
    throw new Error(`${constant} の宣言が見つかりません`);
  }
  return [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map(
    (match) => match[1] ?? "",
  );
};

describe("cloud environment の設定が OPERATIONS.md に残っている（§9-1）", () => {
  /*
    **この 4 つはコードのどこにも無い。** claude.ai 側にしか置けないので、
    書き留めていなければ**次に環境を作り直したときに再現できない** ——
    しかも欠けたときの症状が「静かに動かない」なので、原因に辿り着けない。
  */
  it.each([
    ["OFFDESK_URL", "繋がらない"],
    ["OFFDESK_TOKEN", "全部 401"],
    ["CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS", "質問の直後に先へ進む"],
    ["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT", "5 分で握りが落ちる"],
  ])("%s が書かれている", (name) => {
    expect(OPERATIONS).toContain(name);
  });

  /*
    **推奨値も書く。** 名前だけでは「何を入れるか」が分からない ——
    `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` は**握りの上限より大きい**必要がある。
  */
  it("推奨のタイムアウトが domain の定数と一致する", () => {
    expect(OPERATIONS).toContain(
      `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=${RECOMMENDED_CLIENT_IDLE_TIMEOUT_MS}`,
    );
  });

  it("推奨のタイムアウトが握りの上限より大きい", () => {
    expect(RECOMMENDED_CLIENT_IDLE_TIMEOUT_MS).toBeGreaterThan(ASK_HOLD_MS);
  });

  /** **`0` を入れる**（既定の 2 分で背後へ回る）。値まで書かないと意味が無い。 */
  it("背後へ回す設定を 0 にすると書かれている", () => {
    expect(OPERATIONS).toContain("CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0");
  });

  /** **スキーム無し**が要点（付けると許可されない）。 */
  it("許可ドメインはスキーム無しと書かれている", () => {
    expect(OPERATIONS).toMatch(/Allowed domains[\s\S]{0,120}スキーム無し/);
  });
});

describe("Discord 側の設定が OPERATIONS.md に残っている（§9-2）", () => {
  it.each([
    "Interactions Endpoint URL",
    "MESSAGE CONTENT INTENT",
    "Create Public Threads",
  ])("%s が書かれている", (needle) => {
    expect(OPERATIONS).toContain(needle);
  });
});

describe("Worker の secret が OPERATIONS.md に並んでいる（§9-4）", () => {
  /*
    **秘密を回すときの唯一の頼り。** 名前を 1 つ足して手順書に書き忘れると、
    半年後に「どこを触ればよいか」が分からない —— コードの一覧を正本にして、
    手順書がそれを網羅していることを機械で見る。
  */
  it.each([
    ...namesIn(WORKER_ENV, "ENDPOINT_GATED_ENV_NAMES"),
    "BETTER_AUTH_SECRET",
    "AUTH_ALLOWED_EMAILS",
  ])("%s が書かれている", (name) => {
    expect(OPERATIONS).toContain(name);
  });

  /** **回せない鍵は回せないと書く**（既存の暗号文が開かなくなる）。 */
  it("FIRE_TOKEN_KEY が回せないことが書かれている", () => {
    expect(OPERATIONS).toMatch(/FIRE_TOKEN_KEY[\s\S]{0,200}回せない/);
  });

  /** **値そのものを書かない**（手順書は commit される）。 */
  it.each(["sk-ant-", "trig_", "Bearer sk"])(
    "%s のような値が書かれていない",
    (needle) => {
      expect(OPERATIONS).not.toContain(needle);
    },
  );
});

describe("対象リポジトリに .gitignore を要求しない（2026-09-05 に外した）", () => {
  /*
    **計画の下書きをリポジトリの外に書くようにしたので、要求が 1 つ消えた。**

    以前は `plans/<名前>/` に書かせていたので、対象リポジトリの `.gitignore` に
    `/plans/` を足してもらう必要があった —— 足し忘れると使い捨ての計画が
    commit に混ざり、**アンカーを落とすと `src/plans/` のような同名ディレクトリまで
    消える**（offdesk 自身が踏んだ）。プラグインでは対象リポジトリのファイルを
    配れないので、**どのみち人に頼むしかない項目**でもあった。

    置き場を `PLAN_WORK_DIR` へ移して、**頼むこと自体を無くした。**
  */
  it("計画の作業領域がリポジトリの外にある", () => {
    expect(PLAN_WORK_DIR.startsWith("/")).toBe(true);
  });

  /** **2 つの文言が同じ置き場を案内する。** 片方だけ戻すと要求が復活する。 */
  it.each([
    ["ROUTINE_PROMPT", ROUTINE_PROMPT],
    ["SERVER_INSTRUCTIONS", SERVER_INSTRUCTIONS],
  ])("%s が作業領域を案内する", (_label, text) => {
    expect(text).toContain(PLAN_WORK_DIR);
  });

  /*
    **リポジトリ相対の置き場に戻っていないこと。** ここが `plans/<名前>` に
    戻ると、`.gitignore` の要求も一緒に戻る（そして誰も気づかない）。

    **数えて比べる。** 単純な `not.toContain("plans/<名前>")` は使えない ——
    作業領域の名前自体が `offdesk-plans` で終わるので、正しい案内にも
    その部分文字列が含まれる（ここで 1 度踏んだ）。
  */
  const occurrences = (text: string, needle: string): number =>
    text.split(needle).length - 1;

  it.each([
    ["ROUTINE_PROMPT", ROUTINE_PROMPT],
    ["SERVER_INSTRUCTIONS", SERVER_INSTRUCTIONS],
  ])("%s の置き場が全部作業領域の下にある", (_label, text) => {
    expect(occurrences(text, "plans/<名前>")).toBe(
      occurrences(text, `${PLAN_WORK_DIR}/<名前>`),
    );
    expect(occurrences(text, "plans/<名前>")).toBeGreaterThan(0);
  });

  /** テンプレートは `.gitignore` を配らない（配っても対象の設定は変えられない）。 */
  it("repo-template に .gitignore が無い", () => {
    expect(() => readSource("repo-template/.gitignore")).toThrow();
  });

  /** offdesk 自身の `/plans/` は別の理由で残る（このリポジトリの使い捨ての計画）。 */
  it("offdesk 自身はアンカー付きで書いている", () => {
    expect(readSource(".gitignore")).toMatch(/^\/plans\/$/m);
  });
});

describe("配るテンプレートが揃っている（§9-1）", () => {
  /*
    **1 つでも欠けると静かに壊れる。** `.mcp.json` が無ければツールが
    見つからず、`settings.json` が無ければ承認待ちで固まり、
    hook が無ければ残量が出ず、`publish-plan.sh` が無ければ計画が
    Discord に流れ込む（**どれもエラーにはならない**）。

    **4 つ。** `.gitignore` は 2026-09-05 に外した（上の describe を参照）。
  */
  it.each([
    ".mcp.json",
    ".claude/settings.json",
    ".claude/hooks/offdesk-hook.sh",
    ".claude/scripts/publish-plan.sh",
  ])("repo-template に %s がある", (file) => {
    expect(() => readSource(`repo-template/${file}`)).not.toThrow();
  });

  it("OPERATIONS.md が repo-template を写すよう案内している", () => {
    expect(OPERATIONS).toContain("repo-template/");
  });
});
