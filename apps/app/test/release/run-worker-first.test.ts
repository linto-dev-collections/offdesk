import { readFileSync } from "node:fs";
import path from "node:path";
import { RPC_PREFIX } from "@offdesk/contract";
import { describe, expect, it } from "vitest";

/*
  **API が index.html を返す事故を機械で防ぐ**（計画 P8 §3-4）。

  静的アセットは `not_found_handling: "single-page-application"` なので、
  **アセットに無いパスは `index.html` を返す。** `run_worker_first` に載っていない
  Worker の口は、そのフォールバックに吸われる ——
  症状は「404 ではなく 200 で HTML が返る」で、**叩いた側には
  「JSON が壊れている」としか見えない**（`Unexpected token '<'`）。

  拡張子を持つパス（`/api/health.json` のような形）は別の規則で拾われるが、
  offdesk の口は全部拡張子を持たないので、**1 つ載せ忘れるだけで死ぬ。**

  一覧は **2 か所**にある（`wrangler.jsonc` はローカル、`alchemy.run.ts` は本番）。
  片方だけに足すと「ローカルでは動くのに本番で HTML が返る」になる。
*/

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const INDEX = readSource("apps/app/src/worker/index.ts");

/** `run_worker_first` の配列の中の文字列リテラル。 */
const patternsIn = (source: string): readonly string[] => {
  const block = /run_worker_first"?:\s*\[([^\]]*)\]/.exec(source);
  if (block?.[1] === undefined) {
    throw new Error("run_worker_first の宣言が見つかりません");
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
};

/**
 * Worker が登録しているパス。**「覆われていなければならない」形で返す。**
 *
 * `app.route(prefix, sub)` は**接頭辞のマウント**なので、実際に叩かれるのは
 * `<prefix>/<子のパス>` —— 素の `<prefix>` は登録されていない（子に `/` が
 * 無いので）。だから `<prefix>/*` として要求する。
 *
 * `app.use("*")` は全体にかかるミドルウェアなので除く。
 */
const registeredPaths = (): readonly string[] => {
  const exact = [
    ...INDEX.matchAll(
      /\bapp\.(?:get|post|put|patch|delete|use)\(\s*(?:"([^"]+)"|`([^`]+)`)/g,
    ),
    ...INDEX.matchAll(/\bapp\.on\(\s*\[[^\]]*\],\s*"([^"]+)"/g),
  ]
    .map((match) => match[1] ?? match[2] ?? "")
    .filter((value) => value !== "" && value !== "*");

  const mounted = [...INDEX.matchAll(/\bapp\.route\(\s*"([^"]+)"/g)].map(
    (match) => `${match[1] ?? ""}/*`,
  );

  /*
    **テンプレートリテラルは中身が解決されていない。** `${RPC_PREFIX}/*` の形で
    拾えるので、契約の値に差し替える（**契約が正本**。ここで文字列を写すと
    3 か所目ができる）。
  */
  return [
    ...new Set(
      [...exact, ...mounted].map((value) =>
        // biome-ignore lint/suspicious/noTemplateCurlyInString: ソースに書かれた文字列そのもの（この文字列を評価するのではなく、置き換える相手として探している）。
        value.replace("${RPC_PREFIX}", RPC_PREFIX),
      ),
    ),
  ];
};

/**
 * `run_worker_first` の登録が、要求されたパス（または接頭辞）を覆っているか。
 *
 * 要求側も `/gateway/*` のような接頭辞になりうるので、**両側を接頭辞に均してから**
 * 比べる（`/p/:planId{...}` のような Hono のパラメータ構文もそのまま通る）。
 */
const covers = (pattern: string, required: string): boolean => {
  if (pattern === required) return true;
  if (!pattern.endsWith("/*")) return false;

  const base = pattern.slice(0, -1);
  const target = required.endsWith("/*") ? required.slice(0, -1) : required;
  return target.startsWith(base);
};

const PATHS = registeredPaths();

const FILES = [
  ["apps/app/wrangler.jsonc", "ローカル"],
  ["packages/infra/alchemy.run.ts", "本番"],
] as const;

describe("Worker が登録しているパスを拾えている", () => {
  /** 拾えていないと**この検査そのものが空振り**する（常に緑になる）。 */
  it("1 つ以上ある", () => {
    expect(PATHS.length).toBeGreaterThan(0);
  });

  it.each([
    "/api/health",
    "/mcp",
    "/discord/interactions",
    "/gateway/*",
    "/hooks/*",
    "/plans/*",
    `${RPC_PREFIX}/*`,
  ])("%s を拾っている", (pathname) => {
    expect(PATHS).toContain(pathname);
  });

  /** `app.use("*")`（全体のミドルウェア）は登録として数えない。 */
  it("* を含まない", () => {
    expect(PATHS).not.toContain("*");
  });
});

describe.each(FILES)("%s（%s）の run_worker_first", (file) => {
  const patterns = patternsIn(readSource(file));

  it.each(PATHS)("%s を覆っている", (pathname) => {
    const matched = patterns.filter((pattern) => covers(pattern, pathname));

    expect(matched).not.toEqual([]);
  });

  /*
    **使っていない登録を残さない。** `run_worker_first` は静的アセットより
    Worker を先に見る指示なので、余った接頭辞はアセットの配信を遅くするだけ。
    消し忘れがここで分かる。
  */
  it("どのパスも覆っていない登録が無い", () => {
    const unused = patterns.filter(
      (pattern) => !PATHS.some((pathname) => covers(pattern, pathname)),
    );

    expect(unused).toEqual([]);
  });
});

describe("2 つの一覧が一致している", () => {
  it("wrangler.jsonc と alchemy.run.ts が同じ", () => {
    expect(patternsIn(readSource("packages/infra/alchemy.run.ts"))).toEqual(
      patternsIn(readSource("apps/app/wrangler.jsonc")),
    );
  });
});
