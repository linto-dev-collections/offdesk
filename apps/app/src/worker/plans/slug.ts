import GithubSlugger from "github-slugger";

/*
  見出しの id（要件 `F-E7`・計画 P6 §4-5）。

  **規則を自前で再実装しない。** 実装計画は
  `[§3.1](#31-キーが-confluence-と違う)` のように **GitHub が振る id を前提にした
  内部リンク**を持っているので、規則が 1 文字ずれるとリンクを踏んでも飛ばない。
  引っ掛かるのはダッシュの扱いで、**半角 `-` は残るが `—`（em dash）や `–` は
  記号として消える**（`a — b` → `a--b`、`A–B` → `ab`）。素朴に「`\p{Pd}` を残す」と
  書くとここがずれる。

  **`packages/domain` に置かない。** `domain-is-pure`（.dependency-cruiser.cjs）が
  `github-slugger` を名指しで禁じており、slug は Markdown の描画にしか要らないので
  描画の隣が正しい置き場（計画 P6 §5）。
*/

export type Slugger = (text: string) => string;

/**
 * 文書 1 つぶんの slugger。
 *
 * **文書ごとに作る。** `github-slugger` は「同じ見出しが 2 つあれば `-1` を足す」
 * ための数え上げを内部に持つので、使い回すと**2 つ目の文書の最初の見出しに
 * `-1` が付く。**
 */
export const createSlugger = (): Slugger => {
  const slugger = new GithubSlugger();

  return (text: string): string => slugger.slug(text);
};
