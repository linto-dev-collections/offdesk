import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  finish,
  planRow,
  publish,
  putFile,
  RUN,
  seedPublisher,
  storedPaths,
} from "./support.ts";

/*
  置く口（要件 `F-E3`・plans/security.md 脅威 2・9・計画 P6 §6）。

  **本文を MCP ツールの引数に載せない**ための素の HTTP の口。だから守りは
  Bearer ＋ `X-Offdesk-Run` の 2 つで、上限はここで全部見る。
*/

beforeEach(async () => {
  await seedPublisher();
});

/** そのテストの計画は 1 つしか無いので、行から `plan_id` を引く。 */
const onlyPlanId = async (): Promise<string> => {
  const row = await env.DB.prepare("SELECT plan_id FROM plans LIMIT 1").first<{
    plan_id: string;
  }>();

  return row?.plan_id ?? "";
};

describe("口の守り（脅威 2）", () => {
  it.each([
    ["Bearer が無い", null],
    ["Bearer が違う", "wrong-token"],
  ])("%s なら 401", async (_label, token) => {
    const response = await putFile({
      slug: "github-link",
      path: "README.md",
      body: "# a",
      token,
    });

    expect(response.status).toBe(401);
  });

  it("finish も 401", async () => {
    const response = await finish({
      slug: "github-link",
      paths: ["README.md"],
      token: null,
    });

    expect(response.status).toBe(401);
  });

  /** **401 でも R2 には何も置かない**（守りが先に来ていること）。 */
  it("401 のとき R2 に何も置かれない", async () => {
    await putFile({
      slug: "github-link",
      path: "README.md",
      body: "# a",
      token: null,
    });

    expect((await env.PLANS.list({ prefix: "plans/" })).objects).toEqual([]);
  });
});

describe("run の門（脅威 9）", () => {
  it("ヘッダが無ければ 400", async () => {
    const response = await putFile({
      slug: "github-link",
      path: "README.md",
      body: "# a",
      runKey: null,
    });

    expect(response.status).toBe(400);
  });

  it("台帳に無い run は 404", async () => {
    const response = await putFile({
      slug: "github-link",
      path: "README.md",
      body: "# a",
      runKey: "OFFDESK-9999999999999999",
    });

    expect(response.status).toBe(404);
  });

  /*
    **終わった run から置き直せない**（計画 P6 の完了条件）。
    誰も見ていないスレッドの計画を差し替えられると、リンクを持っている人が
    知らないうちに別の内容を読むことになる。
  */
  it.each(["done", "failed", "abandoned"])(
    "%s の run からは 400",
    async (status) => {
      await env.DB.prepare(
        "UPDATE runs SET status = ?, finished_at = ? WHERE run_key = ?",
      )
        .bind(status, Date.now(), RUN)
        .run();

      const response = await putFile({
        slug: "github-link",
        path: "README.md",
        body: "# a",
      });

      expect(response.status).toBe(400);
    },
  );
});

describe("名前とパスの形（脅威 8）", () => {
  it.each([
    ["大文字の名前", "GitHub", "README.md"],
    ["ドットを含む名前", "a.b", "README.md"],
    ["先頭のスラッシュ", "github-link", "/abs.md"],
    ["隠しファイル", "github-link", ".env"],
    ["隠しディレクトリ", "github-link", ".claude/settings.json"],
    ["連続スラッシュ", "github-link", "a//b.md"],
  ])("%s は 400", async (_label, slug, path) => {
    expect((await putFile({ slug, path, body: "x" })).status).toBe(400);
  });

  /*
    **遡上は 3 層で落ちる**（2026-09-04 に実測。層ごとに落ち方が違う）。

    | 入力 | どこで落ちるか | 応答 |
    | --- | --- | --- |
    | `../../etc/passwd` | **URL の解析**（`..` を畳む） | 404 |
    | `..%2f..%2fetc.md` | Hono が 1 回復号 → セグメントの先頭がドット | 400 |
    | `..%252f..%252fetc.md` | Hono が 1 回復号 → **`%` が残る** → 許可集合の外 | 400 |

    **1 層目が 404 になるのは、ハンドラに届いていないから。** URL の解析が
    `/plans/github-link/../../etc/passwd` を `/etc/passwd` に畳むので、
    そもそもルートに当たらない —— 400 より安全側で、狙った形。

    **2 層目が「セグメントの先頭がドット」で落ちるのが要点。** Hono は
    パスパラメータを 1 回復号するので、`normalizePlanPath` が見るのは既に
    復号された値。**自分でもう 1 回復号する形にしていたら、そこで
    `..%252f` が `../` になって通っていた**（`plan-path.ts` の
    `PATH_CHARSET_RE` に理由がある）。
  */
  it("../../etc/passwd はルートに当たらず 404", async () => {
    const response = await putFile({
      slug: "github-link",
      path: "../../etc/passwd",
      body: "x",
    });

    expect(response.status).toBe(404);
  });

  it.each([
    ["%2f で符号化", "..%2f..%2fetc.md"],
    ["%2e で符号化", "%2e%2e%2fetc.md"],
    ["二重に符号化", "..%252f..%252fetc.md"],
    ["NUL", "a%00.md"],
  ])("%s は 400", async (_label, path) => {
    expect(
      (await putFile({ slug: "github-link", path, body: "x" })).status,
    ).toBe(400);
  });

  /*
    **`%2f` を含む正当なパスは通る。** Hono が復号して `a/b.md` になるので、
    入れ子のファイルとして置ける（遡上ではないので落とす理由がない）。
  */
  it("a%2fb.md は a/b.md として置ける", async () => {
    expect(
      (await putFile({ slug: "github-link", path: "a%2fb.md", body: "x" }))
        .status,
    ).toBe(200);
    expect(await storedPaths(await onlyPlanId())).toEqual(["a/b.md"]);
  });

  it("257 文字のパスは 400", async () => {
    const response = await putFile({
      slug: "github-link",
      path: `${"a".repeat(254)}.md`,
      body: "x",
    });

    expect(response.status).toBe(400);
  });

  it.each(["a.html", "a.js", "a.exe", "Makefile"])(
    "%s は置けない拡張子で 400",
    async (path) => {
      expect(
        (await putFile({ slug: "github-link", path, body: "x" })).status,
      ).toBe(400);
    },
  );

  it.each(["README.md", "notes.txt", "flow.mmd", "data.json"])(
    "%s は置ける",
    async (path) => {
      expect(
        (await putFile({ slug: "github-link", path, body: "x" })).status,
      ).toBe(200);
    },
  );

  it("入れ子のパスも置ける", async () => {
    expect(
      (
        await putFile({
          slug: "github-link",
          path: "phase-01/detail.md",
          body: "x",
        })
      ).status,
    ).toBe(200);
  });
});

describe("上限（脅威 9）", () => {
  it("1MB を超えると 400", async () => {
    const response = await putFile({
      slug: "github-link",
      path: "big.md",
      body: new Uint8Array(1024 * 1024 + 1),
    });

    expect(response.status).toBe(400);
  });

  it("ちょうど 1MB は通る（境界）", async () => {
    const response = await putFile({
      slug: "github-link",
      path: "big.md",
      body: new Uint8Array(1024 * 1024),
    });

    expect(response.status).toBe(200);
  });

  /*
    **`Content-Length` を信じない**（計画 P6 §4-3）。嘘の長さを書いても、
    実バイト数で落ちる。
  */
  it("Content-Length に嘘を書いても実バイト数で落ちる", async () => {
    const response = await putFile({
      slug: "github-link",
      path: "big.md",
      body: new Uint8Array(1024 * 1024 + 1),
      contentLength: "10",
    });

    expect(response.status).toBe(400);
  });

  it("65 ファイル目で 400", async () => {
    for (let index = 0; index < 64; index += 1) {
      const response = await putFile({
        slug: "github-link",
        path: `f${index}.md`,
        body: "x",
      });
      expect(response.status).toBe(200);
    }

    const over = await putFile({
      slug: "github-link",
      path: "f64.md",
      body: "x",
    });

    expect(over.status).toBe(400);
    expect(await storedPaths(await onlyPlanId())).toHaveLength(64);
  });

  /** **上書きは増えない。** 64 本置いてから 1 本目を差し替えても通る。 */
  it("64 本置いた後の上書きは通る", async () => {
    for (let index = 0; index < 64; index += 1) {
      await putFile({ slug: "github-link", path: `f${index}.md`, body: "x" });
    }

    const again = await putFile({
      slug: "github-link",
      path: "f0.md",
      body: "yy",
    });

    expect(again.status).toBe(200);
  });

  it("合計 8MB を超えると 400", async () => {
    for (let index = 0; index < 8; index += 1) {
      const response = await putFile({
        slug: "github-link",
        path: `f${index}.md`,
        body: new Uint8Array(1024 * 1024),
      });
      expect(response.status).toBe(200);
    }

    const over = await putFile({
      slug: "github-link",
      path: "over.md",
      body: "x",
    });

    expect(over.status).toBe(400);
  });
});

describe("置き終わり", () => {
  it("控え（file_count / total_bytes）が入る", async () => {
    const { planId } = await publish({
      files: { "README.md": "12345", "phase-01.md": "678" },
    });

    expect(await planRow(planId)).toMatchObject({
      slug: "github-link",
      file_count: 2,
      total_bytes: 8,
      last_published_run_key: RUN,
    });
  });

  /*
    **今回送らなかったものはここで消える。** 消さないと、名前を変えた古い
    ファイルが並びに残り続けて「どれが今の計画か」が分からなくなる
    （`entryPath` が古い `README.md` を選ぶこともある）。
  */
  it("送らなかったファイルは消える", async () => {
    const { planId } = await publish({
      files: { "README.md": "a", "old.md": "b" },
    });
    expect(await storedPaths(planId)).toEqual(["README.md", "old.md"]);

    await putFile({ slug: "github-link", path: "new.md", body: "c" });
    const done = await finish({
      slug: "github-link",
      paths: ["README.md", "new.md"],
    });

    expect(done.status).toBe(200);
    expect(await storedPaths(planId)).toEqual(["README.md", "new.md"]);
    expect(await planRow(planId)).toMatchObject({ file_count: 2 });
  });

  it.each([
    ["JSON ではない", "not json"],
    ["paths が無い", undefined],
    ["paths が空", []],
    ["paths が全部通らない形", ["../a.md", "/b.md"]],
  ])("%s なら 400", async (_label, paths) => {
    expect((await finish({ slug: "github-link", paths })).status).toBe(400);
  });

  it("名前の形が違えば 400", async () => {
    expect((await finish({ slug: "GitHub", paths: ["a.md"] })).status).toBe(
      400,
    );
  });
});
