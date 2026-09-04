/*
  実装計画の「置き場」の規則。**純粋**（I/O を持たない）。

  ここに置くのは、**置く口と読む口の両方が同じ答えを出さなければならない規則**だけ
  （計画 P6 §5）。Markdown → HTML と見出しの slug は `marked` / `github-slugger` を
  要するので `apps/app/src/worker/plans/` に置く —— `domain-is-pure`
  （.dependency-cruiser.cjs）があの 2 つを名指しで禁じている。

  **拡張子の一覧と content-type の対応もここに置いた**（計画 P6 §5 は
  「domain に置くのはパス正規化と scope の決定だけ」と書いているが、外れた）。
  理由は、置く口が「この拡張子を許すか」を見て、読む口が「この拡張子を何で返すか」を
  見る —— **同じ一覧を 2 つのレイヤに分けると食い違う。** 食い違ったときの症状は
  「置けたのに、開くと添付ファイルとして落ちてくる」で、どちらが正しいのか分からない。
  外部ライブラリを要しないので `domain-is-pure` には触れない。
*/

/** `plans_slug_shape_ck` と同じ長さ（テーブル定義書 §4-7）。 */
const SLUG_MAX_LENGTH = 64;

/**
 * `plans_slug_shape_ck` と同じ形。**先頭は `[a-z0-9]`、以降は `_` と `-` も可。**
 *
 * **`/` を含まない。** 置く口が `PUT /plans/:slug/:path{.+}` なので、名前に `/` を
 * 許すと**どこまでが名前でどこからがパスか判別できない**（テーブル定義書 §9 の
 * 未決 4 をこれで閉じた。schema/offdesk.ts の `plans_slug_shape_ck` に理由がある）。
 */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const isPlanSlug = (value: string): boolean =>
  value.length <= SLUG_MAX_LENGTH && SLUG_RE.test(value);

/** R2 のキーは `plans/<plan_id>/<ここ>` になる。長さは 1 セグメントの合計。 */
const PATH_MAX_LENGTH = 256;

/**
 * 通す文字。**`%` を入れない**のが要点。
 *
 * 正当なパスは全部 URL 安全な文字だけなので、百分率符号が出てくる余地がない。
 *
 * **ここで自分で復号しない。** 2026-09-04 に実測: Hono はパスパラメータを
 * **1 回復号して**渡すので、この関数が見るのは既に復号された値
 * （`..%2f..%2f` は `../../` として届き、セグメントの先頭のドットで落ちる）。
 * ここでもう 1 回復号する形にすると、**二重符号化した `..%252f` が
 * `../` になって通る。** 復号せず、残った `%` を集合の外として落とせば、
 * その穴はそもそも開かない（実測の表は `test/plans/upload.test.ts`）。
 *
 * `\` と制御文字も集合の外なので、ここで一緒に落ちる。
 */
const PATH_CHARSET_RE = /^[a-z0-9._/-]+$/i;

/**
 * 計画のパスを正規化する。**通らないものは `null`**（呼ぶ側は 400 にする）。
 *
 * ここが甘いと `../` で別の計画のファイルを読み書きできる（plans/security.md 脅威 8）。
 * R2 のキーが `plans/<plan_id>/<ここ>` なので、**prefix の外へ出られないことが
 * 唯一の防御。**
 *
 * **「`..` を含む文字列を拒否」にしない。** `a..b.md` は正当なファイル名なので通す。
 * 見るのは**セグメントの先頭がドットかどうか** —— `.` と `..` はこれで一緒に落ち、
 * ついでに `.env` や `.git` のような隠しファイルも置けなくなる。
 */
export const normalizePlanPath = (raw: string): string | null => {
  if (raw.length === 0 || raw.length > PATH_MAX_LENGTH) return null;
  if (raw.startsWith("/") || raw.endsWith("/")) return null;
  if (raw.includes("//")) return null;
  if (!PATH_CHARSET_RE.test(raw)) return null;

  for (const segment of raw.split("/")) {
    if (segment.startsWith(".")) return null;
  }

  return raw;
};

/** `plans_scope_kind_ck` と同じ一覧（テーブル定義書 §4-7）。 */
export type PlanScopeKind = "thread" | "run";

export type PlanScope = Readonly<{ kind: PlanScopeKind; id: string }>;

/**
 * その計画が**どの場所のものか**（要件 `F-E4`・`I-6`）。
 *
 * **スレッドがあればスレッド。** run が落ちて起こし直して `run_key` が変わっても、
 * 同じスレッドの同じ名前なら**同じ URL に上書きされる**。ここが `run_key` だと、
 * 直すたびに URL が変わってスレッドに貼ったリンクが古い版を指し続ける。
 *
 * スレッドが無い run（要件 `F-A7` の「立てられなかった」）だけ run へ落とす。
 */
export const planScope = (
  input: Readonly<{ threadId: string | null; runKey: string }>,
): PlanScope =>
  input.threadId === null
    ? { kind: "run", id: input.runKey }
    : { kind: "thread", id: input.threadId };

/*
  置ける拡張子と、返す content-type（plans/security.md 脅威 9・計画 P6 §4-6）。

  **`.svg` を `image/svg+xml` で返さない。** SVG は `<script>` を持てるので、
  自分のオリジンで任意のスクリプトが動く形になる。`text/plain` なら、
  中身が何であれブラウザは実行しない（`nosniff` と対で効く）。
*/
const PLAN_MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  json: "application/json; charset=utf-8",
  mmd: "text/plain; charset=utf-8",
};

/**
 * 最後のセグメントの拡張子。**ドットで始まるセグメントは拡張子を持たない**
 * （`.env` は「拡張子 env」ではない）。
 */
const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : "";
};

/**
 * 返す content-type。**知らない拡張子は `null`。**
 *
 * 置く口は `null` を 400 にし、読む口は `application/octet-stream` ＋
 * `Content-Disposition: attachment` にする（許可一覧を狭めた後に、
 * 前の一覧で置かれたオブジェクトが残っていても開けてしまわないように）。
 */
export const planContentType = (path: string): string | null =>
  PLAN_MEDIA_TYPES[extensionOf(path)] ?? null;

export const isMarkdownPath = (path: string): boolean =>
  extensionOf(path) === "md";

/**
 * 入口。**`README.md` があればそれ、無ければ最初の markdown**（計画 P6 §4-4）。
 *
 * 根の `README.md` だけを見る（`docs/readme.md` は入口にしない）。
 */
export const entryPath = (paths: readonly string[]): string | null => {
  const sorted = [...paths].sort();

  return (
    sorted.find((path) => path.toLowerCase() === "readme.md") ??
    sorted.find(isMarkdownPath) ??
    sorted[0] ??
    null
  );
};

/*
  上限（plans/security.md 脅威 9・計画 P6 §4-3）。実測の最大は 1 ファイル 40KB /
  1 計画 231,647 バイト / 7 ファイルなので、どれも桁 1 つ以上の余裕がある。
*/

export const MAX_PLAN_FILE_BYTES = 1024 * 1024;
export const MAX_PLAN_FILES = 64;
export const MAX_PLAN_TOTAL_BYTES = 8 * 1024 * 1024;
