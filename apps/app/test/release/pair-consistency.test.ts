import { readdirSync, readFileSync } from "node:fs";
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
const PLUGIN_DIR = "plugin/plugins/offdesk";
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

  /** プラグインは `.gitignore` を配らない（配っても対象の設定は変えられない）。 */
  it("plugin に .gitignore が無い", () => {
    expect(() => readSource(`${PLUGIN_DIR}/.gitignore`)).toThrow();
  });

  /** offdesk 自身の `/plans/` は別の理由で残る（このリポジトリの使い捨ての計画）。 */
  it("offdesk 自身はアンカー付きで書いている", () => {
    expect(readSource(".gitignore")).toMatch(/^\/plans\/$/m);
  });
});

describe("配るテンプレートが揃っている（§9-1）", () => {
  /*
    **1 つでも欠けると静かに壊れる。** `.mcp.json` が無ければツールが
    見つからず、`hooks.json` が無ければ承認待ちで固まり、
    hook スクリプトが無ければ残量が出ず、`publish-plan.sh` が無ければ計画が
    Discord に流れ込む（**どれもエラーにはならない**）。
  */
  it.each([
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "hooks/hooks.json",
    "hooks/offdesk-hook.sh",
    "scripts/publish-plan.sh",
  ])("plugin に %s がある", (file) => {
    expect(() => readSource(`${PLUGIN_DIR}/${file}`)).not.toThrow();
  });

  /** marketplace の宣言（`claude plugin marketplace add` が最初に読む）。
   **リポジトリのルート**にある —— 下の describe が中身を見る。 */
  it("marketplace.json がルートにある", () => {
    expect(() => readSource(".claude-plugin/marketplace.json")).not.toThrow();
  });

  /** **対象リポジトリへ配るものが無いこと**を手順書が言っている（2026-09-06）。 */
  it("OPERATIONS.md が「1 バイトも置かない」と言っている", () => {
    expect(OPERATIONS).toContain("1 バイトも置かない");
  });
});

/*
  **offdesk 自身が marketplace**（2026-09-06・依頼者の判断でキーレスに倒した）。

  以前は public のミラー（`offdesk-plugin`）へ CI が押す形にしていたが、
  **別リポジトリへ push するには鍵が要る** —— `GITHUB_TOKEN` は走っている
  リポジトリにしか権限が無く、OIDC も GitHub 自身のトークンには変換されない。
  offdesk を public にすれば**押す先そのものが消える**ので、鍵も CI の手順も
  ミラーも要らなくなり、**ずれようがなくなる。**

  ここで固めるのは、**setup script が指す名前とマニフェストの宣言が一致すること。**
  食い違うと `claude plugin install offdesk@offdesk` が対象を見つけられず、
  **cloud session にツールが 1 つも載らない**（Discord は無音のまま）。
*/
describe("offdesk 自身が marketplace", () => {
  const MARKETPLACE = JSON.parse(
    readSource(".claude-plugin/marketplace.json"),
  ) as {
    name: string;
    plugins: readonly { name: string; source: string }[];
  };

  /** **マニフェストはリポジトリのルート必須**（公式の要件）。 */
  it("マニフェストがルートにある", () => {
    expect(MARKETPLACE.name).toBe("offdesk");
    expect(MARKETPLACE.plugins).toHaveLength(1);
  });

  it("source が実在するプラグインを指す", () => {
    const source = MARKETPLACE.plugins[0]?.source ?? "";

    expect(source).toBe(`./${PLUGIN_DIR}`);
    expect(() =>
      readSource(`${PLUGIN_DIR}/.claude-plugin/plugin.json`),
    ).not.toThrow();
  });

  /** `./` 相対だけ（`../` はマーケットプレイス根の外を指すので公式が禁じている）。 */
  it("source が ./ 相対で、根の外を指さない", () => {
    for (const entry of MARKETPLACE.plugins) {
      expect(entry.source.startsWith("./")).toBe(true);
      expect(entry.source).not.toContain("..");
    }
  });

  it("手順書の setup script と名前が一致する", () => {
    const pluginName = MARKETPLACE.plugins[0]?.name ?? "";

    expect(OPERATIONS).toContain(
      `claude plugin install ${pluginName}@${MARKETPLACE.name}`,
    );
    expect(OPERATIONS).toContain(
      "claude plugin marketplace add linto-dev-collections/offdesk",
    );
  });

  /*
    **鍵もミラーも残さない。** 「押す」形へ戻すと鍵が 1 つ増えるので、
    戻すなら意図的にやること —— 残骸が残っていると、
    「もう使っていない秘密」が `OPERATIONS.md` §0 の一覧に残り続ける。
  */
  it("CI にミラーへ押す手順が残っていない", () => {
    const ci = readSource(".github/workflows/ci.yml");

    expect(ci).not.toContain("PLUGIN_MIRROR_DEPLOY_KEY");
    expect(ci).not.toContain("offdesk-plugin");
  });
});

/*
  **`plugin/` の中は英語だけ**（2026-09-06・依頼者の指定）。

  offdesk 本体の why コメントは日本語のままでよい。**あそこだけが違う理由は
  配られる先**にある —— プラグインは public のミラーへ押され、
  誰の cloud session にも入りうるので、読む人を日本語話者に限定しない。

  `additionalContext` と `permissionDecisionReason` は**モデルとログに出る文**でも
  あるので、ここには機能上の意味もある。
*/
describe("plugin/ は英語だけ", () => {
  const JAPANESE = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/;

  const filesUnder = (dir: string): readonly string[] => {
    const full = path.join(REPO_ROOT, dir);
    return readdirSync(full, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .map((file) => path.relative(REPO_ROOT, file));
  };

  const files = filesUnder("plugin");

  /** 走査が空振りしていないこと（`plugin/` を消したら赤くなる）。 */
  it("走査するファイルがある", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s に日本語が無い", (file) => {
    const offending = readSource(file)
      .split("\n")
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => JAPANESE.test(line))
      .map(([lineNumber, line]) => `${lineNumber}: ${line.trim()}`);

    expect(offending).toEqual([]);
  });
});
