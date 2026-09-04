import { Marked, Renderer, type Tokens } from "marked";
import { createSlugger, type Slugger } from "./slug.ts";

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const isExternal = (href: string): boolean => /^https?:\/\//i.test(href);

const isSafeHref = (href: string): boolean => {
  if (/^(https?|mailto):/i.test(href)) return true;

  // スキームらしきものが無ければ相対リンク（`./phase-01.md` `#anchor` `a/b`）。
  return !/^[a-z][a-z0-9+.-]*:/i.test(href);
};

class PlanRenderer extends Renderer {
  /** 最初の見出し。ページの `<title>` に使う。 */
  firstHeading: string | null = null;

  constructor(private readonly slug: Slugger) {
    super();
  }

  override heading(token: Tokens.Heading): string {
    const html = this.parser.parseInline(token.tokens);
    /*
      **slug は「描画後の文字」から作る。** GitHub がそうしているので、
      `**強調**` や `` `code` `` を含む見出しでもリンクの形が揃う。
    */
    const plain = this.parser.parseInline(
      token.tokens,
      this.parser.textRenderer,
    );
    if (this.firstHeading === null) this.firstHeading = plain.trim();
    const id = this.slug(plain);

    return `<h${token.depth} id="${escapeHtml(id)}">${html}</h${token.depth}>\n`;
  }

  /** ブロックの生 HTML もインラインのタグも、両方ここへ来る（`marked` の仕様）。 */
  override html(token: Tokens.HTML | Tokens.Tag): string {
    return escapeHtml(token.text);
  }

  /**
   * 表は横に溢れる（計画の表は列が多い）。**入れ物ごと横スクロールにする** ——
   * `table` 自体を `display: block` にすると幅の計算が崩れるので、外側で受ける。
   */
  override table(token: Tokens.Table): string {
    return `<div class="scroll">${super.table(token)}</div>\n`;
  }

  override link(token: Tokens.Link): string {
    const text = this.parser.parseInline(token.tokens);
    if (!isSafeHref(token.href)) return text;

    const href = escapeHtml(token.href);
    const rawTitle = token.title ?? "";
    const title = rawTitle === "" ? "" : ` title="${escapeHtml(rawTitle)}"`;
    /*
      外のリンクは新しいタブへ。**相対リンクは同じ計画の中を指す**ので
      そのまま遷移させる（読みながら行き来する）。
    */
    const external = isExternal(token.href)
      ? ' target="_blank" rel="noopener noreferrer"'
      : "";

    return `<a href="${href}"${title}${external}>${text}</a>`;
  }
}

export type RenderedMarkdown = Readonly<{
  html: string;
  /** 最初の見出し。無ければ null。 */
  title: string | null;
}>;

export const renderMarkdown = (source: string): RenderedMarkdown => {
  const renderer = new PlanRenderer(createSlugger());
  /*
    **インスタンスを毎回作る。** slug の重複カウンタと「最初の見出し」が
    文書をまたいで残らないようにするため。`Renderer` のインスタンスを渡せるのは
    `setOptions` の側（`use` はプレーンなオブジェクトを期待していて、
    プロトタイプに生えたメソッドを拾わない）。
  */
  const marked = new Marked().setOptions({
    gfm: true,
    breaks: false,
    renderer,
  });

  return {
    html: marked.parse(source, { async: false }),
    title: renderer.firstHeading,
  };
};
