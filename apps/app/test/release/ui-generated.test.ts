import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  `shadcn add` の生成物の関門（要件 §10-4 の 3 段の置き場・README §2-6）。

  **2026-09-05 に踏んだ。** `shadcn@4.20.1` で `table` `badge` `select` を足したら、
  `utils` の別名を解決できずに **`import { cn } from "cn"` を書き、
  npm の無関係なパッケージ `cn@0.2.4` を dependencies に足した**（実測。
  `packages/ui` から叩いても `apps/app` から叩いても同じ）。

    - 型検査は通る（`cn` が本当に入るので）
    - biome も knip も depcruise も、`packages/ui/src/components/ui` を
      検査から外してあるので何も言わない
    - **`cn` の中身がクライアントのバンドルに載る**（供給網。脅威 13）

  生成物には手を入れない約束だが、**生成器が壊れた行を出したときは直す**。
  ここはその直し忘れと、次に `shadcn add` を叩いたときの再発を止める。
*/

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");
const GENERATED_DIR = path.join(REPO_ROOT, "packages/ui/src/components/ui");

const files = readdirSync(GENERATED_DIR).filter((name) =>
  name.endsWith(".tsx"),
);

const sourceOf = (name: string): string =>
  readFileSync(path.join(GENERATED_DIR, name), "utf8");

describe("shadcn の生成物", () => {
  it("1 本以上ある（置き場が動いていない）", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)(
    "%s が `cn` を裸のパッケージ名から import していない",
    (name) => {
      expect(sourceOf(name)).not.toMatch(/from ["']cn["']/);
    },
  );

  it.each(files)("%s が cn を使うならワークスペースから取る", (name) => {
    const source = sourceOf(name);
    if (!/\bcn\(/.test(source)) return;

    expect(source).toContain('import { cn } from "@workspace/ui/lib/utils"');
  });

  /*
    **`cn` という名前の npm パッケージを入れない。** 生成器が足した宣言を
    消し忘れると、`pnpm install` が毎回持ってくる。
  */
  it("packages/ui が cn を依存に持たない", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "packages/ui/package.json"), "utf8"),
    );
    const dependencies = (manifest as { dependencies?: object }).dependencies;

    expect(Object.keys(dependencies ?? {})).not.toContain("cn");
  });

  it("ルートのロックファイルに cn が入っていない", () => {
    const lock = readFileSync(path.join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");

    expect(lock).not.toMatch(/^\s{2}cn@/m);
  });
});
