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
  it.each([
    ["OFFDESK_URL", "繋がらない"],
    ["OFFDESK_TOKEN", "全部 401"],
    ["CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS", "質問の直後に先へ進む"],
    ["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT", "5 分で握りが落ちる"],
  ])("%s が書かれている", (name) => {
    expect(OPERATIONS).toContain(name);
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

  it.each([
    ["ROUTINE_PROMPT", ROUTINE_PROMPT],
    ["SERVER_INSTRUCTIONS", SERVER_INSTRUCTIONS],
  ])("%s が作業領域を案内する", (_label, text) => {
    expect(text).toContain(PLAN_WORK_DIR);
  });

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
    plugins: readonly { name: string; source: string }[];
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
