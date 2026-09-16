import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ASK_HOLD_MS,
  PLAN_WORK_DIR,
  PUBLISH_PLAN_SKILL_NAME,
  RECOMMENDED_CLIENT_IDLE_TIMEOUT_MS,
  ROUTINE_PROMPT,
} from "@offdesk/domain";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const OPERATIONS = readSource("OPERATIONS.md");
const PLUGIN_DIR = "plugin/plugins/offdesk";
const PLAN_SKILL = `skills/${PUBLISH_PLAN_SKILL_NAME}/SKILL.md`;
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
  it.each([
    ["OFFDESK_URL", "繋がらない"],
    ["OFFDESK_TOKEN", "全部 401"],
    ["CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS", "質問の直後に先へ進む"],
    ["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT", "5 分で握りが落ちる"],
    ["CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS", "run が畳まれず 🏁 も出ない"],
    // ↑ ここまでは「欠けると壊れる」。**下の 1 つだけ性質が違う**（欠けても壊れない）。
    ["CLAUDE_CODE_EFFORT_LEVEL", "既定の high で走るだけ（壊れない）"],
  ])("%s が書かれている", (name) => {
    expect(OPERATIONS).toContain(name);
  });

  /*
    **管理用のトークンは cloud environment へ置かない**（2026-09-16）。

    環境変数は**その環境を使う誰からも見える**（cloud-environments）ので、
    置いた瞬間に「リポジトリから入った 1 行で `/gateway/reset` が叩ける」に戻る。
    §1 に「置かない」と書いてあることと、`/gateway/*` の判定が
    `OFFDESK_ADMIN_TOKEN` を見ていることの両方を固める。
  */
  it("OFFDESK_ADMIN_TOKEN を置かないと書いてある", () => {
    expect(OPERATIONS).toMatch(/`OFFDESK_ADMIN_TOKEN`[\s\S]{0,80}置かない/);
  });

  it("/gateway/* が OFFDESK_ADMIN_TOKEN で判定している", () => {
    const source = readSource("apps/app/src/worker/index.ts");
    const block =
      /const gateway = new Hono[\s\S]*?app\.route\("\/gateway", gateway\)/.exec(
        source,
      )?.[0] ?? "";

    expect(block).toContain("c.env.OFFDESK_ADMIN_TOKEN");
    expect(block).not.toContain("c.env.OFFDESK_TOKEN)");
  });

  it("推奨のタイムアウトが domain の定数と一致する", () => {
    expect(OPERATIONS).toContain(
      `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=${RECOMMENDED_CLIENT_IDLE_TIMEOUT_MS}`,
    );
  });

  it("推奨のタイムアウトが握りの上限より大きい", () => {
    expect(RECOMMENDED_CLIENT_IDLE_TIMEOUT_MS).toBeGreaterThan(ASK_HOLD_MS);
  });

  it("背後へ回す設定を 0 にすると書かれている", () => {
    expect(OPERATIONS).toContain("CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0");
  });

  /*
    **`SessionEnd` の予算はプラグインからは上げられない。**

    `hooks/hooks.json` の `timeout` で上がるのは settings ファイル側だけで、
    **プラグインが書いた `timeout` は数に入らない** —— 予算は 1.5 秒のまま。
    置き場が cloud environment の環境変数 1 つしか無いので、
    **`OPERATIONS.md` が唯一の記録**になる（§3-5）。

    値まで見張るのは `CLAUDE_CODE_EFFORT_LEVEL` と同じ理由（名前だけ書いて
    ミリ秒を決め忘れると通ってしまう）。
  */
  it("SessionEnd の予算をミリ秒まで書いてある", () => {
    expect(OPERATIONS).toMatch(
      /CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=[0-9]+/,
    );
  });

  it("プラグインの timeout では予算が上がらないと書いてある", () => {
    expect(OPERATIONS).toMatch(
      /CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS[\s\S]{0,600}予算は上がらない/,
    );
  });

  /*
    **effort は routine のフォームから指定できない**（あるのはモデルセレクタだけ）ので、
    置き場は cloud environment の環境変数 1 つ ——**コードから見えない。**
    値まで書いてあることを見張らないと、「名前だけ書いてレベルを決め忘れた」で通る。

    **この行だけ「欠けても壊れない」**（モデルの既定 `high` で走るだけ）。
    §9-1 の表の他の行と性質が違うことは、`OPERATIONS.md` 側にも書いてある。
  */
  it("effort のレベルまで書かれている", () => {
    expect(OPERATIONS).toContain("CLAUDE_CODE_EFFORT_LEVEL=xhigh");
  });

  /*
    **環境変数が `/effort` より強いことを書いておく。** 置いたあとに
    人がセッションを開いて下げようとしても効かない —— 知らないと
    「コマンドが壊れている」に見える。
  */
  it("環境変数が /effort を上書きすることが書かれている", () => {
    expect(OPERATIONS).toMatch(/CLAUDE_CODE_EFFORT_LEVEL[\s\S]{0,400}\/effort/);
  });

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
  it.each([
    ...namesIn(WORKER_ENV, "ENDPOINT_GATED_ENV_NAMES"),
    "BETTER_AUTH_SECRET",
    "AUTH_ALLOWED_EMAILS",
  ])("%s が書かれている", (name) => {
    expect(OPERATIONS).toContain(name);
  });

  it("FIRE_TOKEN_KEY が回せないことが書かれている", () => {
    expect(OPERATIONS).toMatch(/FIRE_TOKEN_KEY[\s\S]{0,200}回せない/);
  });

  it.each(["sk-ant-", "trig_", "Bearer sk"])(
    "%s のような値が書かれていない",
    (needle) => {
      expect(OPERATIONS).not.toContain(needle);
    },
  );
});

describe("対象リポジトリに .gitignore を要求しない（2026-09-05 に外した）", () => {
  it("計画の作業領域がリポジトリの外にある", () => {
    expect(PLAN_WORK_DIR.startsWith("/")).toBe(true);
  });

  /** 案内するのは skill 1 か所（`plugin/` は英語だけなので目印も `<name>`）。 */
  it("skill が作業領域を案内する", () => {
    expect(readSource(`${PLUGIN_DIR}/${PLAN_SKILL}`)).toContain(PLAN_WORK_DIR);
  });

  const occurrences = (text: string, needle: string): number =>
    text.split(needle).length - 1;

  it("skill の置き場が全部作業領域の下にある", () => {
    const skill = readSource(`${PLUGIN_DIR}/${PLAN_SKILL}`);

    expect(occurrences(skill, "plans/<name>")).toBe(
      occurrences(skill, `${PLAN_WORK_DIR}/<name>`),
    );
    expect(occurrences(skill, "plans/<name>")).toBeGreaterThan(0);
  });

  /*
    **手順を routine のプロンプトへ書き戻さない**（2026-09-06）。あちらは
    **人が routine の数だけ貼り直す唯一の面**で、書き戻すと同じ話が 2 か所に増え、
    貼り直しを忘れた routine だけが古い規則で走り続ける。
  */
  it("ROUTINE_PROMPT が計画の手順を持たない", () => {
    expect(ROUTINE_PROMPT).not.toContain(PLAN_WORK_DIR);
  });

  it("plugin に .gitignore が無い", () => {
    expect(() => readSource(`${PLUGIN_DIR}/.gitignore`)).toThrow();
  });

  it("offdesk 自身はアンカー付きで書いている", () => {
    expect(readSource(".gitignore")).toMatch(/^\/plans\/$/m);
  });
});

describe("配るテンプレートが揃っている（§9-1）", () => {
  it.each([
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "hooks/hooks.json",
    "hooks/offdesk-hook.sh",
    "scripts/publish-plan.sh",
    PLAN_SKILL,
  ])("plugin に %s がある", (file) => {
    expect(() => readSource(`${PLUGIN_DIR}/${file}`)).not.toThrow();
  });

  it("marketplace.json がルートにある", () => {
    expect(() => readSource(".claude-plugin/marketplace.json")).not.toThrow();
  });

  it("OPERATIONS.md が「1 バイトも置かない」と言っている", () => {
    expect(OPERATIONS).toContain("1 バイトも置かない");
  });
});

describe("offdesk 自身が marketplace", () => {
  const MARKETPLACE = JSON.parse(
    readSource(".claude-plugin/marketplace.json"),
  ) as {
    name: string;
    plugins: readonly { name: string; source: string; version?: string }[];
  };

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

  it("CI にミラーへ押す手順が残っていない", () => {
    const ci = readSource(".github/workflows/ci.yml");

    expect(ci).not.toContain("secrets.PLUGIN_MIRROR_DEPLOY_KEY");
  });

  /*
    **版はプラグインのマニフェストにだけ置く**（2026-09-16 に片方へ寄せた）。

    以前はここが「2 か所の一致」を見ていたが、**両方に書くこと自体が
    公式に禁じられている** —— Claude Code は `plugin.json` の値を無警告で採り、
    marketplace 側の値は読まないので、古いマニフェストが目録の版を黙って覆う。
    https://code.claude.com/docs/en/plugin-marketplaces

    一致を見る先が無くなったわけではない。**どちらか片方にしか無いこと**を
    `release/mcp-template.test.ts` の「plugin の版」が見ている。
  */
  it("marketplace の目録が version を持たない", () => {
    const manifest = JSON.parse(
      readSource(`${PLUGIN_DIR}/.claude-plugin/plugin.json`),
    ) as { version?: string };

    expect(manifest.version).toBeDefined();
    expect(MARKETPLACE.plugins[0]?.version).toBeUndefined();
  });
});

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
