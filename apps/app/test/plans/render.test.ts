import { beforeEach, describe, expect, it } from "vitest";
import { publish, seedPublisher, view } from "./support.ts";

/*
  Markdown → HTML（要件 `F-E6`・`F-E7`・plans/security.md 脅威 7・計画 P6 §6）。

  **本文がそこだけ消えるのが最悪の壊れ方。** 計画には `<URL>` `<string>`
  `<script>` のような山括弧を含む地の文が実測で 40 箇所以上あり、素通しにすると
  ブラウザがタグとして飲み込む —— 読み手には「なぜか説明が抜けている文書」に
  しか見えない。
*/

const SOURCE = `# P6 — 実装計画の配布

本文に <script>alert(1)</script> と <URL> と <string> がある。

## 4-2. パスの正規化（脅威 8）

| 何 | 値 |
| --- | --- |
| 1 ファイル | 1 MB |
| 合計 | 8 MB |

[§4.2](#4-2-パスの正規化脅威-8) と [P1](./phase-01-auth.md) と
[外](https://example.com) と [悪](javascript:alert(1))

<img src=x onerror=alert(1)>

\`\`\`ts
const a = "<b>";
\`\`\`
`;

let planId = "";
let token = "";

beforeEach(async () => {
  await seedPublisher();
  const published = await publish({ files: { "README.md": SOURCE } });
  planId = published.planId;
  token = published.token;
});

const html = async (): Promise<string> => {
  const response = await view({ planId, token });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  return await response.text();
};

describe("生 HTML をエスケープする（脅威 7）", () => {
  it("<script> が &lt;script&gt; になる", async () => {
    const body = await html();

    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>");
  });

  /** **これが本題。** 山括弧の地の文が消えない。 */
  it.each(["&lt;URL&gt;", "&lt;string&gt;"])(
    "%s が本文に残る",
    async (needle) => {
      expect(await html()).toContain(needle);
    },
  );

  it("onerror つきの img が実行できる形で出ない", async () => {
    const body = await html();

    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(body).not.toContain("<img src=x");
  });

  it("コードブロックの中もエスケープされる", async () => {
    expect(await html()).toContain("&quot;&lt;b&gt;&quot;");
  });

  /*
    **`javascript:` のリンクはリンクにしない**（`link` を差し替えると `marked`
    本体の URL 検査を素通りするため）。文字だけが残る。
  */
  it("javascript: のリンクは a にならない", async () => {
    const body = await html();

    expect(body).toContain("悪");
    expect(body).not.toContain("javascript:");
  });
});

describe("表として読める", () => {
  it("table になる", async () => {
    const body = await html();

    expect(body).toContain("<table>");
    expect(body).toContain("<th>何</th>");
    expect(body).toContain("<td>1 MB</td>");
  });

  /** 表は横に溢れるので、**入れ物ごと**横スクロールにする。 */
  it("入れ物が横スクロールになる", async () => {
    expect(await html()).toContain('<div class="scroll"><table>');
  });
});

describe("リンクが辿れる", () => {
  /** **見出しの id と内部リンクが噛み合う**（噛み合わないと踏んでも飛ばない）。 */
  it("見出しに id が付き、同じ値で内部リンクが張られる", async () => {
    const body = await html();

    expect(body).toContain('<h2 id="4-2-パスの正規化脅威-8">');
    expect(body).toContain('<a href="#4-2-パスの正規化脅威-8">');
  });

  /*
    **相対リンクを書き換えない**（要件 `F-E7`）。`/p/<id>/README.md` から見て
    `./phase-01-auth.md` が `/p/<id>/phase-01-auth.md` に解決される。
  */
  it("相対リンクがそのまま出る", async () => {
    expect(await html()).toContain('<a href="./phase-01-auth.md">');
  });

  /** 同じ計画の中を指すので、読みながら行き来できるよう同じタブで開く。 */
  it("相対リンクは新しいタブを開かない", async () => {
    expect(await html()).toContain('<a href="./phase-01-auth.md">P1</a>');
  });

  it("外のリンクには rel が付く", async () => {
    expect(await html()).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">',
    );
  });
});

describe("ページの枠", () => {
  it("最初の見出しが title になる", async () => {
    expect(await html()).toContain("<title>P6 — 実装計画の配布</title>");
  });

  it("計画の名前と並びが nav に出る", async () => {
    const body = await html();

    expect(body).toContain("github-link");
    expect(body).toContain(`<a href="/p/${planId}/README.md"`);
    expect(body).toContain('aria-current="page"');
  });

  /** **スクリプトを 1 行も置かない**（CSP の `default-src 'none'` と噛み合わせる）。 */
  it("script タグが 1 つも無い", async () => {
    expect(await html()).not.toMatch(/<script/i);
  });

  it("スマホ向けの viewport が入る", async () => {
    expect(await html()).toContain('name="viewport"');
  });
});

describe("markdown 以外", () => {
  it("見出しが無ければファイル名が title", async () => {
    const published = await publish({
      slug: "no-heading",
      files: { "README.md": "見出しの無い本文。" },
    });
    const body = await (
      await view({ planId: published.planId, token: published.token })
    ).text();

    expect(body).toContain("<title>README.md</title>");
  });

  /** `.txt` は素のまま返す（HTML にしない）。 */
  it("txt は text/plain で素のまま", async () => {
    const published = await publish({
      slug: "notes",
      files: { "notes.txt": "# これは見出しではない" },
    });
    const response = await view({
      planId: published.planId,
      path: "notes.txt",
      token: published.token,
    });

    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe("# これは見出しではない");
  });
});
