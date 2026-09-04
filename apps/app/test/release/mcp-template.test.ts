import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  **`repo-template/.mcp.json` は「コードの外にある前提」の 1 つ**（要件 §9-1・計画 P3a §3-7）。

  対象リポジトリに commit されるファイルなので、ここを直しても勝手には追従しない。
  それでも**サーバー名だけはコードと対で維持されている** ——
  `.mcp.json` の `offdesk` がツール名の `mcp__offdesk__*` を決め、
  それが routine の `allowed_tools` と `ROUTINE_PROMPT` の本文に現れる。

  **名前を変えると、症状は「承認待ちで固まる」になる**（ツールが見つからないのではなく、
  許可されていないツールとして扱われる）。切り分けの難しい壊れ方なので、
  4 か所が揃っていることを機械に見張らせる。
*/

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const TEMPLATE = JSON.parse(readSource("repo-template/.mcp.json")) as {
  mcpServers: Record<
    string,
    {
      type: string;
      url: string;
      headers: Record<string, string>;
      timeout: number;
    }
  >;
};

const SERVER_NAME = "offdesk";

/**
 * `.mcp.json` の `${NAME}` は **Claude Code が実行時に環境変数へ差し替えるリテラル**で、
 * こちらの文字列展開ではない。
 *
 * 素で書くと biome が `noTemplateCurlyInString` で「テンプレート文字列にしろ」と言うが、
 * **それは逆**（テンプレート文字列にすると、ここで空文字に展開されて検査が空振りする）。
 * 組み立てて比べれば、意図がコードに残る。
 */
const envPlaceholder = (name: string): string => `\${${name}}`;

describe("repo-template/.mcp.json", () => {
  it("サーバー名が offdesk（ツール名が mcp__offdesk__* になる）", () => {
    expect(Object.keys(TEMPLATE.mcpServers)).toEqual([SERVER_NAME]);
  });

  it("Worker の /mcp を指す", () => {
    const server = TEMPLATE.mcpServers[SERVER_NAME];

    expect(server?.type).toBe("http");
    // **URL は環境変数から組む。** 焼き込むと検証用と本番でファイルが分かれる。
    expect(server?.url).toBe(`${envPlaceholder("OFFDESK_URL")}/mcp`);
  });

  it("Bearer を OFFDESK_TOKEN から渡す", () => {
    expect(TEMPLATE.mcpServers[SERVER_NAME]?.headers.Authorization).toBe(
      `Bearer ${envPlaceholder("OFFDESK_TOKEN")}`,
    );
  });

  /*
    **ツールの wall-clock**（未設定なら約 28 時間）。握りは最長 15 分なので、
    1 時間に絞っておけば「握りが落ちたのではなく上限で切れた」を区別できる。
    **`ASK_HOLD_MS`（15 分）より大きいことが前提。**
  */
  it("timeout が 1 時間で、握りの上限より大きい", async () => {
    const { ASK_HOLD_MS } = await import("@offdesk/domain");

    expect(TEMPLATE.mcpServers[SERVER_NAME]?.timeout).toBe(3_600_000);
    expect(TEMPLATE.mcpServers[SERVER_NAME]?.timeout).toBeGreaterThan(
      ASK_HOLD_MS,
    );
  });
});

describe("サーバー名が 3 か所で揃っている", () => {
  it("MCP サーバーの serverInfo が同じ名前を名乗る", () => {
    const source = readSource("apps/app/src/worker/mcp/server.ts");

    expect(source).toContain(`name: "${SERVER_NAME}"`);
  });

  /*
    routine のプロンプトが呼ぶツール名。**`.mcp.json` のサーバー名から決まる**ので、
    片方だけ変えると「承認待ちで固まる」になる。
  */
  it("ROUTINE_PROMPT が mcp__offdesk__ask_human を名指しする", async () => {
    const { ROUTINE_PROMPT } = await import("@offdesk/domain");

    expect(ROUTINE_PROMPT).toContain(`mcp__${SERVER_NAME}__ask_human`);
  });
});

describe("/mcp が run_worker_first に入っている", () => {
  /*
    **これが無いと、拡張子を持たない POST が SPA フォールバックに吸われる。**
    `alchemy.run.ts`（本番）と `wrangler.jsonc`（ローカル）の**両方**に要る。
  */
  it.each([
    ["packages/infra/alchemy.run.ts", "本番"],
    ["apps/app/wrangler.jsonc", "ローカル"],
  ])("%s（%s）に /mcp がある", (file) => {
    expect(readSource(file)).toContain('"/mcp"');
  });
});
