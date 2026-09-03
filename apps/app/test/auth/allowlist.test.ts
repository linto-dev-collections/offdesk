import { env } from "cloudflare:workers";
import { createAuth } from "@offdesk/auth";
import { describe, expect, it } from "vitest";
import { countUsers } from "./support.ts";

/*
  allowlist の配線（要件 `F-G3`・`I-2`・plans/security.md 脅威 6）。

  **判定そのもののテストは `packages/domain/src/allowlist.test.ts`**（純粋関数なので
  境界を全部固めてある）。ここで見るのは**その判定が Better Auth の正しい場所に
  入っているか** —— Google の OAuth を踏めないので、設定を通して呼ぶ。
*/

/** `betterAuth` に渡した options を取り出す。 */
const optionsOf = async (overrides: Parameters<typeof createAuth>[0]) =>
  (await createAuth(overrides).$context).options;

describe("拒否は「ユーザー作成の前」で起きる", () => {
  /*
    **`validateUserInfo` であることが要点。** `databaseHooks.user.create.before` に
    書くと、拒否したメールの行が残る経路ができる（あちらは書き込みの直前）。
    ここが `undefined` になっていたら、誰でもログインできる状態。
  */
  it("gate は validateUserInfo に入っている", async () => {
    const options = await optionsOf(env);

    expect(typeof options.user?.validateUserInfo).toBe("function");
  });

  it("databaseHooks は使っていない（拒否した行が残る経路を作らない）", async () => {
    // 渡した options の literal 型には `databaseHooks` が無いので、`tsc` も
    // 「設定していない」ことを保証している。実行時にも見るために型を広げて読む。
    const options: Record<string, unknown> = await optionsOf(env);

    expect(options.databaseHooks).toBeUndefined();
  });
});

describe("validateUserInfo の判定", () => {
  const validate = async (
    overrides: Partial<Parameters<typeof createAuth>[0]>,
    email: string | undefined,
  ) => {
    const options = await optionsOf({ ...env, ...overrides });
    const gate = options.user?.validateUserInfo;
    if (gate === undefined) throw new Error("validateUserInfo が無い");
    /*
      Better Auth が渡す形（`{ user, source }`）で呼ぶ。`source` は
      `{ method, oauth: { providerId } }` が本物の姿で、Google の
      コールバックは `action: "create-user"` を足して渡してくる。
    */
    return await gate({
      user: { email },
      source: {
        method: "oauth",
        action: "create-user",
        oauth: { providerId: "google" },
      },
    } as never);
  };

  it("許可メールは通す（undefined を返す）", async () => {
    expect(await validate({}, "offdesk.me@gmail.com")).toBeUndefined();
  });

  it("大文字・前後空白の許可メールも通す", async () => {
    expect(await validate({}, "  OffDesk.Me@Gmail.com ")).toBeUndefined();
  });

  it("許可外は error を返す", async () => {
    expect(await validate({}, "someone@example.com")).toMatchObject({
      error: "not_allowed",
    });
  });

  /*
    **allowlist が空なら誰も通さない**（要件 `I-2`）。
    「未設定なら全部許可」に倒す実装を書きがちなので、ここで固定する。
  */
  it("AUTH_ALLOWED_EMAILS が空なら、許可メールでも通さない", async () => {
    expect(
      await validate({ AUTH_ALLOWED_EMAILS: "" }, "offdesk.me@gmail.com"),
    ).toMatchObject({ error: "not_allowed" });
  });

  it("AUTH_ALLOWED_EMAILS が空白だけでも通さない", async () => {
    expect(
      await validate({ AUTH_ALLOWED_EMAILS: " , , " }, "offdesk.me@gmail.com"),
    ).toMatchObject({ error: "not_allowed" });
  });
});

describe("拒否したときに users の行が増えない", () => {
  it("許可外のメールを弾いた後も users は 0 行", async () => {
    const options = await optionsOf(env);
    const gate = options.user?.validateUserInfo;
    if (gate === undefined) throw new Error("validateUserInfo が無い");

    const result = await gate({
      user: { email: "someone@example.com" },
      source: {
        method: "oauth",
        action: "create-user",
        oauth: { providerId: "google" },
      },
    } as never);

    expect(result).toMatchObject({ error: "not_allowed" });
    expect(await countUsers()).toBe(0);
  });
});
