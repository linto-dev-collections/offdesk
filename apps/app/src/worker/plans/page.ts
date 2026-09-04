import { formatJst } from "@offdesk/contract";
import { escapeHtml } from "./render.ts";

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf8;
  --fg: #1d1c1a;
  --muted: #6b6862;
  --line: #e0ddd6;
  --accent: #8a5a2b;
  --code-bg: #f1efea;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16151a;
    --fg: #e6e3dd;
    --muted: #9b968d;
    --line: #322f38;
    --accent: #d9a066;
    --code-bg: #201f26;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
  font-size: 16px;
  line-height: 1.9;
  overflow-wrap: anywhere;
}
.wrap { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.1rem 6rem; }
nav {
  border-bottom: 1px solid var(--line);
  padding-bottom: .8rem;
  margin-bottom: 1.6rem;
  font-size: .82rem;
  line-height: 2.1;
  color: var(--muted);
}
nav .name { display: block; font-weight: 600; color: var(--fg); font-size: .9rem; }
nav a { color: var(--muted); text-decoration: none; margin-right: .9rem; white-space: nowrap; }
nav a[aria-current] { color: var(--fg); font-weight: 600; }
h1, h2, h3, h4, h5, h6 { line-height: 1.5; margin: 2.4rem 0 .9rem; }
h1 { font-size: 1.55rem; margin-top: 0; }
h2 { font-size: 1.28rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.1rem; }
h4, h5, h6 { font-size: 1rem; }
p, ul, ol, blockquote { margin: 0 0 1.1rem; }
li { margin: .25rem 0; }
a { color: var(--accent); }
hr { border: 0; border-top: 1px solid var(--line); margin: 2.4rem 0; }
blockquote {
  border-left: 3px solid var(--line);
  margin-left: 0;
  padding: .1rem 0 .1rem 1rem;
  color: var(--muted);
}
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: .86em;
  background: var(--code-bg);
  padding: .12em .35em;
  border-radius: 3px;
}
pre {
  background: var(--code-bg);
  padding: .9rem 1rem;
  border-radius: 6px;
  overflow-x: auto;
  line-height: 1.65;
}
pre code { background: none; padding: 0; font-size: .82rem; }
.scroll { overflow-x: auto; margin: 0 0 1.2rem; }
table { border-collapse: collapse; font-size: .85rem; line-height: 1.7; }
th, td { border: 1px solid var(--line); padding: .4rem .6rem; text-align: left; vertical-align: top; }
th { background: var(--code-bg); white-space: nowrap; }
img { max-width: 100%; }
footer { margin-top: 4rem; padding-top: .8rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .78rem; }
`.trim();

const shell = (input: {
  readonly title: string;
  readonly body: string;
}): string => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(input.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${input.body}
</div>
</body>
</html>
`;

export type PlanNavItem = Readonly<{
  path: string;
  href: string;
  current: boolean;
}>;

export const planPage = (input: {
  /** ページの題。文書の最初の見出し。無ければファイル名。 */
  readonly title: string;
  /** 計画の名前（slug）。 */
  readonly planName: string;
  readonly files: readonly PlanNavItem[];
  readonly bodyHtml: string;
  /** 最後に置き直した時刻（epoch ミリ秒）。 */
  readonly updatedAtMs: number;
}): string => {
  const nav = input.files
    .map(
      (file) =>
        `<a href="${escapeHtml(file.href)}"${file.current ? ' aria-current="page"' : ""}>${escapeHtml(file.path)}</a>`,
    )
    .join("");

  return shell({
    title: input.title,
    body: `<nav><span class="name">${escapeHtml(input.planName)}</span>${nav}</nav>
<main>
${input.bodyHtml}
</main>
<footer>offdesk / 最終更新 ${escapeHtml(formatJst(input.updatedAtMs))} JST</footer>`,
  });
};

/**
 * 見つからないときの頁。
 *
 * **何が無いのかは書かない。** 「その計画は無い」と「そのファイルは無い」を
 * 書き分けると、`plan_id` の存在の有無が返答から読み取れてしまう。
 */
export const planNotFoundPage = (): string =>
  shell({
    title: "見つかりません",
    body: "<h1>見つかりません</h1>\n<p>この URL には何もありません。</p>",
  });

/**
 * リンクの期限が切れた／署名が合わないときの頁。
 *
 * **「無い」と書き分ける。** ここは `plan_id` の存在を漏らしていない ——
 * 署名の検査は台帳を引く前に行うので、**存在しない計画でも同じ頁が出る。**
 * 書き分ける理由は、読み手が取るべき行動が違うこと（「もう一度リンクを
 * 出してもらう」と「URL が間違っている」）。
 */
export const planLinkExpiredPage = (): string =>
  shell({
    title: "リンクの期限が切れています",
    body: `<h1>リンクの期限が切れています</h1>
<p>スレッドで計画を出し直してもらってください。新しいリンクが届きます。</p>`,
  });
