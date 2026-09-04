import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { publish, seedPublisher, view } from "./support.ts";

/*
  応答ヘッダ（要件 `F-E8`・plans/security.md 脅威 7・計画 P6 §6）。

  **URL が鍵**（署名付きリンク）なので、URL が意図せず出ていく口を全部塞ぐ ——
  外部リンクを踏んだときの Referer・検索エンジン・中間のキャッシュ。
*/

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let planId = "";
let token = "";

beforeEach(async () => {
  await seedPublisher();
  const published = await publish({
    files: {
      "README.md": "# a",
      "diagram.svg": "<svg><script>alert(1)</script></svg>",
      "shot.png": PNG,
      "data.json": '{"a":1}',
      "flow.mmd": "graph TD;",
    },
  });
  planId = published.planId;
  token = published.token;
});

describe("6 つのヘッダが付く", () => {
  it.each([
    ["content-security-policy", "default-src 'none'"],
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["referrer-policy", "no-referrer"],
    ["x-robots-tag", "noindex, nofollow"],
    ["cache-control", "private, no-store"],
  ])("%s に %s", async (name, expected) => {
    const response = await view({ planId, token });

    expect(response.headers.get(name)).toContain(expected);
  });

  /** markdown 以外にも同じヘッダが付く（画像だけ素になっていないこと）。 */
  it.each(["shot.png", "diagram.svg", "data.json"])(
    "%s にも同じヘッダが付く",
    async (path) => {
      const response = await view({ planId, path, token });

      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    },
  );

  /** 見つからない頁にも付く（存在の有無で漏れ方が変わらないこと）。 */
  it("404 の頁にも付く", async () => {
    const response = await view({ planId, path: "nope.md", token });

    expect(response.status).toBe(404);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("CSP の中身", () => {
  /*
    **`style-src 'unsafe-inline'` を許す**のは、表とコードブロックの体裁を
    1 枚の `<style>` で入れるため（外部 CSS を配らない）。
    **スクリプトは 1 つも許さない。**
  */
  it("script-src を足していない（default-src 'none' で止まる）", async () => {
    const csp =
      (await view({ planId, token })).headers.get("content-security-policy") ??
      "";

    expect(csp).not.toContain("script-src");
    expect(csp).toContain("style-src 'unsafe-inline'");
  });

  /*
    **`img-src` に `'self'` が要る**（計画 P6 §4-6 から外した点）。`.png` を
    置けるのに `'self'` が無いと、計画に貼った図が 1 枚も出ない。
  */
  it("img-src が self と data: を許す", async () => {
    const csp =
      (await view({ planId, token })).headers.get("content-security-policy") ??
      "";

    expect(csp).toContain("img-src 'self' data:");
  });

  /** `frame-ancestors` は `default-src` に含まれないので、明示する。 */
  it("frame-ancestors と base-uri と form-action を明示する", async () => {
    const csp =
      (await view({ planId, token })).headers.get("content-security-policy") ??
      "";

    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });
});

describe("content-type", () => {
  it.each([
    ["README.md", "text/html; charset=utf-8"],
    ["shot.png", "image/png"],
    ["data.json", "application/json; charset=utf-8"],
    ["flow.mmd", "text/plain; charset=utf-8"],
  ])("%s → %s", async (path, expected) => {
    const response = await view({ planId, path, token });

    expect(response.headers.get("content-type")).toBe(expected);
  });

  /*
    **`.svg` を `image/svg+xml` で返さない**（脅威 7）。SVG は `<script>` を
    持てるので、自分のオリジンで任意のスクリプトが動く形になる。
    `text/plain` ＋ `nosniff` なら、中身が何であれ実行されない。
  */
  it("svg は text/plain で返る", async () => {
    const response = await view({ planId, path: "diagram.svg", token });

    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toContain("<script>");
  });

  /*
    **知らない拡張子は添付にする。** 置ける拡張子を狭めた後に、前の一覧で
    置かれたオブジェクトが残っていても開かせない（R2 に直接入れて確かめる）。
  */
  it("知らない拡張子は octet-stream ＋ attachment", async () => {
    await env.PLANS.put(`plans/${planId}/legacy.html`, "<h1>old</h1>");

    const response = await view({ planId, path: "legacy.html", token });

    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe("attachment");
  });
});
