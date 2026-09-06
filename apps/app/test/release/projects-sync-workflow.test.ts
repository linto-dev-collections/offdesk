import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const WORKFLOW = readSource(".github/workflows/projects-sync.yml");

const optionKeys = (): readonly string[] => {
  const block = /options:\n((?:\s*-\s*"[^"]*"\n)+)/.exec(WORKFLOW);
  if (block?.[1] === undefined) {
    throw new Error("options の宣言が見つかりません");
  }
  return [...block[1].matchAll(/"([a-z-]+):/g)].map((match) => match[1] ?? "");
};

const KEYS = optionKeys();

describe("選択肢", () => {
  it("4 つある", () => {
    expect(KEYS).toEqual(["check", "add", "update", "commands"]);
  });

  it("既定が check", () => {
    const value = /default:\s*"([a-z-]+):/.exec(WORKFLOW)?.[1];

    expect(value).toBe("check");
  });
});

describe("分岐が選択肢と対で維持されている", () => {
  it("投入するのは add と update だけ", () => {
    const arm =
      /case "\$\{ACTION%%:\*\}" in\n\s*([a-z |]+)\)\s*pnpm projects:sync ;;/.exec(
        WORKFLOW,
      )?.[1];

    expect(arm?.split("|").map((name) => name.trim())).toEqual([
      "add",
      "update",
    ]);
  });

  it("既定の腕が dry-run", () => {
    expect(WORKFLOW).toMatch(/\*\)\s*pnpm projects:sync -- --dry-run ;;/);
  });

  it("登録し直すのは add と commands", () => {
    const step = WORKFLOW.slice(
      WORKFLOW.indexOf("/offdesk の選択肢を更新する"),
    );
    const condition = /if:\s*\$\{\{([^}]*)\}\}/.exec(step)?.[1] ?? "";

    expect(condition).toContain("'add'");
    expect(condition).toContain("'commands'");
    expect(condition).not.toContain("'update'");
  });

  it("commands のときに飛ばす手順が 2 つある", () => {
    const skipped = [
      ...WORKFLOW.matchAll(/!startsWith\(inputs\.action, 'commands'\)/g),
    ];

    expect(skipped).toHaveLength(2);
  });
});

describe("できないことを出していない", () => {
  it.each(["delete", "remove", "disable"])("%s の選択肢が無い", (forbidden) => {
    expect(KEYS).not.toContain(forbidden);
  });
});

describe("guild id を人に貼らせない", () => {
  it("入力ではなく変数から採る", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ワークフローに書かれた文字列そのもの（評価するのではなく、あることを確かめている）。
    expect(WORKFLOW).toContain("GUILD_ID: ${{ vars.DISCORD_GUILD_ID }}");
    expect(WORKFLOW).not.toMatch(/^\s+guild_id:/m);
  });

  it("空なら warning を出してグローバル登録に落ちる", () => {
    expect(WORKFLOW).toContain("::warning::");
  });
});
