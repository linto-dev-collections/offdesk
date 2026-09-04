import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { signPlanLink } from "../../src/worker/plans/link.ts";
import { publish, seedPublisher, view } from "./support.ts";

/*
  入口の選び方（計画 P6 §4-4・§6）。

  **リダイレクトしない**のが要点。`/p/<id>/` から見て `./phase-01.md` が
  `/p/<id>/phase-01.md` に解決されるので、入口の本文をそのまま返す ——
  `/p/<id>/README.md` へ 302 すると、そこから見た相対リンクは同じ場所を指すが、
  **入れ子のファイル（`phase-01/detail.md`）では階層が 1 つずれる。**
*/

beforeEach(async () => {
  await seedPublisher();
});

describe("入口", () => {
  it("README.md があればそれ", async () => {
    const { planId, token } = await publish({
      files: { "phase-01.md": "# 一", "README.md": "# 目次" },
    });

    const response = await view({ planId, token });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>目次</title>");
  });

  it("無ければ最初の markdown（並べ替えた順）", async () => {
    const { planId, token } = await publish({
      files: { "z-last.md": "# 最後", "a-first.md": "# 最初" },
    });

    expect(await (await view({ planId, token })).text()).toContain(
      "<title>最初</title>",
    );
  });

  /** **リダイレクトしない。** 200 で本文が返る。 */
  it("入口は 200 で返る（302 ではない）", async () => {
    const { planId, token } = await publish({
      files: { "README.md": "# 目次" },
    });

    const response = await view({ planId, token });

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  /*
    **入れ子のファイルからも相対リンクが効く**のは、nav を**絶対パス**で
    張っているから。相対で張ると階層のぶんずれる。
  */
  it("入れ子のファイルの nav が絶対パス", async () => {
    const { planId, token } = await publish({
      files: { "README.md": "# 目次", "phase-01/detail.md": "# 詳細" },
    });

    const body = await (
      await view({ planId, path: "phase-01/detail.md", token })
    ).text();

    expect(body).toContain(`<a href="/p/${planId}/phase-01/detail.md"`);
    expect(body).toContain(`<a href="/p/${planId}/README.md"`);
  });
});

describe("無いもの", () => {
  /*
    **署名は通るが行が無い**ときだけ 404 になる（署名が通らなければ 401 で、
    そこでは `plan_id` の存在を漏らさない。`auth.test.ts` の側で固めてある）。
  */
  it("台帳に無い計画は 404", async () => {
    const absent = "a".repeat(32);
    const token = await signPlanLink(
      env.PLAN_LINK_SIGNING_KEY,
      absent,
      Date.now() + 60_000,
    );

    expect((await view({ planId: absent, token })).status).toBe(404);
  });

  /*
    **R2 が空なら 404。** 行だけ残っている状態（`finish` の途中で落ちた、
    取り消しが R2 で止まった）でも、空のページを見せない。
  */
  it("R2 が空なら 404", async () => {
    const { planId, token } = await publish({
      files: { "README.md": "# a" },
    });
    await env.PLANS.delete(`plans/${planId}/README.md`);

    expect((await view({ planId, token })).status).toBe(404);
  });

  it("無いファイルは 404", async () => {
    const { planId, token } = await publish({
      files: { "README.md": "# a" },
    });

    expect((await view({ planId, path: "nope.md", token })).status).toBe(404);
  });

  /*
    **形が通らないパスは 400**（黙って入口へ倒さない）。倒すと
    「置いたのに無い」が「なぜか目次が出る」に化けて、原因に辿り着けない。
  */
  it("形が通らないパスは 400", async () => {
    const { planId, token } = await publish({
      files: { "README.md": "# a" },
    });

    expect((await view({ planId, path: ".env", token })).status).toBe(400);
  });

  /** **別の計画のファイルには届かない**（R2 のキーが `plan_id` で前置される）。 */
  it("別の計画のファイル名を指しても 404", async () => {
    const mine = await publish({ files: { "README.md": "# 自分" } });
    const other = await publish({
      slug: "phase-06",
      files: { "secret.md": "# 他人" },
    });

    const response = await view({
      planId: mine.planId,
      path: "secret.md",
      token: mine.token,
    });

    expect(response.status).toBe(404);
    expect(
      await (
        await view({
          planId: other.planId,
          path: "secret.md",
          token: other.token,
        })
      ).text(),
    ).toContain("他人");
  });
});
