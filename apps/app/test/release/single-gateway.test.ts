import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  **常駐 DO は 1 つだけ**（要件 `I-9`・`N-1`・計画 P4 §3-1）。

  outbound WebSocket は hibernation 非対応で、繋いでいる間ずっと duration 課金
  になる —— 1 つで月 約 324,000 GB-s（Workers Paid の含有枠 400,000 の内側）。
  **2 つ目の常駐 DO を足すと枠を超える。**

  要件定義書 §7 は `I-9` を「レビューの観点」に置いている（「IaC の宣言が 1 つで
  あることを目で確かめる」）。**目で確かめるのをやめて、機械に見張らせる** ——
  課金が跳ねる形は本番でしか観測できず、気付くのは請求書なので。
*/

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const countOf = (source: string, needle: string): number =>
  source.split(needle).length - 1;

const DO_CLASS = "DiscordGatewayDO";

describe("Durable Object の宣言が 1 つだけ", () => {
  /*
    **`DurableObjectNamespace(` の呼び出しが 1 回。** ここが 2 回になった瞬間に
    含有枠を超える（宣言だけでは課金されないが、繋げば課金される）。
  */
  it("alchemy.run.ts の DurableObjectNamespace が 1 回だけ", () => {
    const source = readSource("packages/infra/alchemy.run.ts");

    expect(countOf(source, "DurableObjectNamespace(")).toBe(1);
    expect(source).toContain(`className: "${DO_CLASS}"`);
  });

  it("wrangler.jsonc のバインディングが 1 つだけ", () => {
    const source = readSource("apps/app/wrangler.jsonc");

    expect(countOf(source, '"class_name"')).toBe(1);
    expect(source).toContain(`"class_name": "${DO_CLASS}"`);
  });

  /** **Worker が export するクラスも 1 つ。** 増えると `migrations` も要る。 */
  it("Worker が export する DO クラスが 1 つだけ", () => {
    const source = readSource("apps/app/src/worker/index.ts");

    expect(countOf(source, `export { ${DO_CLASS} }`)).toBe(1);
    expect(countOf(source, "extends DurableObject")).toBe(0);
  });

  it("DurableObject を継承しているクラスが 1 つだけ", () => {
    const source = readSource("apps/app/src/worker/gateway/gateway.do.ts");

    expect(countOf(source, "extends DurableObject")).toBe(1);
    expect(source).toContain(`class ${DO_CLASS} extends DurableObject`);
  });
});

describe("インスタンスの名前が 1 か所で決まる", () => {
  /*
    **`idFromName` を呼ぶ場所は 1 つ。** 増えると別の名前が混ざり、
    「同じ DO を指しているつもりで 2 つ立っている」になる ——
    症状は「素の文が届かないことがある」＋「課金が跳ねる」で、
    どちらも切り分けが難しい。

    **錨は `env.GATEWAY.idFromName(` にする**（P3a §9-3）。`idFromName(` だけを
    数えると、同じ名前を書いたコメントに一致して 2 になった（実測）。
  */
  it("idFromName の呼び出しが gateway.do.ts の 1 回だけ", () => {
    const source = readSource("apps/app/src/worker/gateway/gateway.do.ts");

    expect(countOf(source, "env.GATEWAY.idFromName(")).toBe(1);
    expect(source).toContain('env.GATEWAY.idFromName("main")');
  });

  it.each([
    "apps/app/src/worker/index.ts",
    "apps/app/src/worker/discord/inbound.ts",
    "apps/app/src/worker/mcp/server.ts",
  ])("%s は idFromName を呼ばない", (file) => {
    expect(readSource(file)).not.toContain("idFromName");
  });
});

describe("/gateway/* が run_worker_first に入っている", () => {
  /*
    **これが無いと、拡張子を持たない GET が SPA フォールバックに吸われる。**
    `alchemy.run.ts`（本番）と `wrangler.jsonc`（ローカル）の**両方**に要る。
  */
  it.each([
    ["packages/infra/alchemy.run.ts", "本番"],
    ["apps/app/wrangler.jsonc", "ローカル"],
  ])("%s（%s）に /gateway/* がある", (file) => {
    expect(readSource(file)).toContain('"/gateway/*"');
  });
});

describe("intent は Developer Portal のトグルと対（要件 §9-2）", () => {
  /*
    **`MESSAGE_CONTENT` は privileged。** Portal で on にしていないと
    close 4014 で切られ、**本文が空で届くのではなく接続そのものが張れない。**
    値がコードから消えたら、Portal の設定が要らなくなったわけではない ——
    「素の文を一切拾えない」に静かに変わる。
  */
  it("GATEWAY_INTENTS に MESSAGE_CONTENT が入っている", async () => {
    const { GATEWAY_INTENTS } = await import("@offdesk/domain");

    expect(GATEWAY_INTENTS & (1 << 15)).toBe(1 << 15);
  });

  /** スレッドの同期に要る（外すと静かに 1 通も届かない。計画 P4 §3-2）。 */
  it("GATEWAY_INTENTS に GUILDS と GUILD_MESSAGES が入っている", async () => {
    const { GATEWAY_INTENTS } = await import("@offdesk/domain");

    expect(GATEWAY_INTENTS & 1).toBe(1);
    expect(GATEWAY_INTENTS & (1 << 9)).toBe(1 << 9);
  });
});
