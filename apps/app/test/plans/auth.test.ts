import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { PLAN_LINK_TTL_MS, signPlanLink } from "../../src/worker/plans/link.ts";
import { signIn } from "../auth/support.ts";
import { ORIGIN } from "../discord/support.ts";
import { call, publish, seedPublisher, view } from "./support.ts";

/*
  読ませる口の守り（要件 `F-E5` の退避先・plans/security.md 脅威 17・計画 P6 §7 の B 案）。

  **`V-1` の結果でここを署名付きリンクに倒した**（2026-09-04 の決定。要件 §15 の
  未決 1）。Discord のアプリ内ブラウザは Safari の Cookie を共有せず、Google は
  webview からの OAuth を拒否することがあるので、**ログインを挟むと
  「スマホで 1 タップで読める」が成立しない。**

  kanata の「推測不能な URL を無期限で公開」には戻していない —— 期限（7 日）と
  失効（行を消せば URL ごと死ぬ）を持つぶん、厳密に強い。
*/

let planId = "";
let token = "";

beforeEach(async () => {
  await seedPublisher();
  const published = await publish({ files: { "README.md": "# 計画" } });
  planId = published.planId;
  token = published.token;
});

describe("署名で通す", () => {
  it("署名があれば 200", async () => {
    expect((await view({ planId, token })).status).toBe(200);
  });

  it.each([
    ["署名が無い", undefined],
    ["署名が空", ""],
    ["形が違う（区切りが無い）", "abcdef"],
    ["期限が数字でない", "abc.xxxx"],
  ])("%s なら 401", async (_label, value) => {
    const response = await view({
      planId,
      ...(value === undefined ? {} : { token: value }),
    });

    expect(response.status).toBe(401);
  });

  it("署名を 1 文字変えると 401", async () => {
    const [exp, signature] = token.split(".");
    const broken = `${exp}.${signature?.slice(0, -1)}${signature?.endsWith("A") ? "B" : "A"}`;

    expect((await view({ planId, token: broken })).status).toBe(401);
  });

  /*
    **`plan_id` を署名に含めている**ので、ある計画のトークンを別の計画に
    付け替えられない。
  */
  it("別の計画のトークンでは通らない", async () => {
    const other = await publish({
      slug: "phase-06",
      files: { "README.md": "# 別" },
    });

    expect((await view({ planId, token: other.token })).status).toBe(401);
    expect((await view({ planId: other.planId, token })).status).toBe(401);
  });

  /** **期限を書き換えても署名が合わない。** 期限だけの延命はできない。 */
  it("期限だけを書き換えると 401", async () => {
    const [, signature] = token.split(".");
    const extended = `${Date.now() + 999 * 24 * 60 * 60 * 1000}.${signature}`;

    expect((await view({ planId, token: extended })).status).toBe(401);
  });
});

describe("期限", () => {
  it("既定は 7 日", () => {
    expect(PLAN_LINK_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("切れていれば 401 で、出し直しを案内する", async () => {
    const expired = await signPlanLink(
      env.PLAN_LINK_SIGNING_KEY,
      planId,
      Date.now() - 1,
    );
    const response = await view({ planId, token: expired });

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("期限が切れています");
  });

  /*
    **「切れている」と「無い」を書き分ける。** どちらも 401 だが、読み手が
    取るべき行動が違う（出し直してもらう / URL が違う）。**`plan_id` の存在は
    漏れていない** —— 署名の検査は台帳を引く前なので、存在しない計画でも
    同じ応答になる。
  */
  it("署名が違うときは「無い」と言う", async () => {
    const response = await view({ planId, token: "1.zzzz" });

    expect(await response.text()).toContain("見つかりません");
  });

  it("存在しない計画でも同じ応答（存在を漏らさない）", async () => {
    const absent = "f".repeat(32);
    const forged = await signPlanLink(
      env.PLAN_LINK_SIGNING_KEY,
      absent,
      Date.now() + 1000,
    );

    const missing = await view({ planId: absent, token: "1.zzzz" });
    const real = await view({ planId, token: "1.zzzz" });

    expect(missing.status).toBe(real.status);
    expect(await missing.text()).toBe(await real.text());

    /*
      **正しい署名を持っていれば、そこで初めて「無い」が分かる**（404）——
      署名を持っている ＝ こちらが出したリンクなので、隠す相手がいない。
    */
    expect((await view({ planId: absent, token: forged })).status).toBe(404);
  });
});

/** 鍵だけを外した env で入口から入る。 */
const withoutKey = async (request: Request): Promise<Response> => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    request,
    { ...env, PLAN_LINK_SIGNING_KEY: "" },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
};

describe("鍵が無いとき（fail-closed）", () => {
  /*
    **「鍵が無いから検査を飛ばす」にしない**（要件 `I-2` と同じ構え）。
    設定漏れがそのまま公開になる形を作らない。
  */
  it("鍵が空なら署名があっても 401", async () => {
    const response = await withoutKey(
      new Request(`${ORIGIN}/p/${planId}/?t=${token}`),
    );

    expect(response.status).toBe(401);
  });

  /*
    **置けたのに読めない URL を返さない。** Claude がそれを Discord に貼ると、
    依頼者が踏んで 401 を見る。ここで止めれば `publish-plan.sh` が非ゼロで
    落ちて、Claude に失敗が届く。
  */
  it("鍵が空なら置き終われない（503）", async () => {
    const response = await withoutKey(
      new Request(`${ORIGIN}/plans/github-link/finish`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OFFDESK_TOKEN}`,
          "x-offdesk-run": "OFFDESK-1111111111111111",
          "content-type": "application/json",
        },
        body: JSON.stringify({ paths: ["README.md"] }),
      }),
    );

    expect(response.status).toBe(503);
  });
});

describe("ログイン済みは署名が要らない（脅威 17 の最後の行）", () => {
  /*
    P7b の運用画面から一覧を辿るときに署名を持っていないため。
    許可外のメールはユーザー行が作られない（要件 `F-G3`）ので、
    セッションがある ＝ 許可されたメール。
  */
  it("セッションがあれば署名なしで 200", async () => {
    const { headers } = await signIn();

    expect((await view({ planId, headers })).status).toBe(200);
  });

  it("セッションがあれば期限切れでも 200", async () => {
    const { headers } = await signIn();
    const expired = await signPlanLink(
      env.PLAN_LINK_SIGNING_KEY,
      planId,
      Date.now() - 1,
    );

    expect((await view({ planId, token: expired, headers })).status).toBe(200);
  });
});

describe("Cookie で相対リンクを辿れる", () => {
  /*
    **これが無いと相対リンクが全部死ぬ。** `/p/<id>/?t=…` から
    `./phase-01.md` を踏むとブラウザは `/p/<id>/phase-01.md` へ行き、
    **クエリは引き継がれない。** 要件 `F-E7` が「相対リンクを書き換えない」と
    定めているので、代わりに最初の 1 回で通った署名を Cookie に預ける。
  */
  it("入口で Cookie を渡す", async () => {
    const response = await view({ planId, token });
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(cookie).toContain("offdesk.plan=");
    expect(cookie).toContain(`Path=/p/${planId}/`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("その Cookie だけで次のファイルが読める", async () => {
    await publish({ files: { "README.md": "# a", "phase-01.md": "# b" } });

    const response = await view({
      planId,
      path: "phase-01.md",
      cookie: `offdesk.plan=${encodeURIComponent(token)}`,
    });

    expect(response.status).toBe(200);
  });

  /** **別の計画には効かない**（`Path` で分かれ、署名も `plan_id` に紐付く）。 */
  it("別の計画の Cookie では通らない", async () => {
    const other = await publish({
      slug: "phase-06",
      files: { "README.md": "# 別" },
    });

    const response = await view({
      planId,
      cookie: `offdesk.plan=${encodeURIComponent(other.token)}`,
    });

    expect(response.status).toBe(401);
  });

  /** Cookie で通った要求では出し直さない（同じ値を毎回書くだけなので）。 */
  it("Cookie で通ったときは Set-Cookie を出さない", async () => {
    const response = await view({
      planId,
      cookie: `offdesk.plan=${encodeURIComponent(token)}`,
    });

    expect(response.headers.get("set-cookie")).toBeNull();
  });

  /** http では `Secure` を付けない（localhost で Cookie が捨てられる）。 */
  it("http では Secure を付けない", async () => {
    const response = await view({ planId, token });

    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("https では Secure を付ける", async () => {
    const response = await view({
      planId,
      token,
      origin: "https://offdesk.example.workers.dev",
    });

    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
});

describe("ルートの形", () => {
  /** **31 桁はルートに当たらない**（`{[0-9a-f]{32}}` の検査）。 */
  it.each([
    ["31 桁", "0".repeat(31)],
    ["33 桁", "0".repeat(33)],
    ["大文字", "A".repeat(32)],
  ])("%s は 404", async (_label, value) => {
    expect((await view({ planId: value, token })).status).toBe(404);
  });

  /*
    **末尾のスラッシュ無しは 301。** 無いと `./phase-01.md` が
    `/p/phase-01.md` に解決されて相対リンクが全部死ぬ。
    **クエリを引き継ぐ**（署名が `?t=` に乗っているので）。
  */
  it("スラッシュ無しは 301 で、クエリを引き継ぐ", async () => {
    const response = await call(
      new Request(`${ORIGIN}/p/${planId}?t=${token}`, { redirect: "manual" }),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`/p/${planId}/?t=${token}`);
  });

  it("クエリが無ければ付けない", async () => {
    const response = await call(
      new Request(`${ORIGIN}/p/${planId}`, { redirect: "manual" }),
    );

    expect(response.headers.get("location")).toBe(`/p/${planId}/`);
  });
});

describe("行を消せばリンクごと死ぬ（失効）", () => {
  it("台帳の行が無ければ署名が通っても 404", async () => {
    await env.DB.prepare("DELETE FROM plans WHERE plan_id = ?")
      .bind(planId)
      .run();

    expect((await view({ planId, token })).status).toBe(404);
  });
});
