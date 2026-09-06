import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  assertEnv,
  PRODUCTION_REQUIRED_ENV_NAMES,
  type WorkerEnv,
} from "../../src/worker/env.ts";

/** ローカル扱い（`LOCAL_DEV="true"`）で、必要なものが全部ある env。 */
const localEnv = (): Partial<WorkerEnv> => ({
  DB: env.DB,
  PLANS: env.PLANS,
  GATEWAY: env.GATEWAY,
  BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
  AUTH_ALLOWED_EMAILS: env.AUTH_ALLOWED_EMAILS,
  LOCAL_DEV: "true",
});

/** 本番扱い（`LOCAL_DEV` なし）で、必要なものが全部ある env。 */
const prodEnv = (): Partial<WorkerEnv> => {
  const { LOCAL_DEV: _omitted, ...rest } = localEnv();
  return {
    ...rest,
    BETTER_AUTH_URL: "https://offdesk.example.workers.dev",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
  };
};

describe("assertEnv", () => {
  it("ローカルで必要なものが揃っていれば通る", () => {
    expect(() => assertEnv(localEnv())).not.toThrow();
  });

  it("本番で必要なものが揃っていれば通る", () => {
    expect(() => assertEnv(prodEnv())).not.toThrow();
  });

  /*
    **1 個ずつ落とす形になっていないことを検査する。**

    1 つ見つけて throw する実装だと、直して deploy し直すたびに次の 1 つで落ちる。
    ここが緑である限り、設定漏れは 1 回で全部分かる。
  */
  it("欠けているものを全部並べる", () => {
    const thrown = () => assertEnv({ LOCAL_DEV: "true" });

    expect(thrown).toThrow(/DB, PLANS, GATEWAY/);
    expect(thrown).toThrow(/BETTER_AUTH_SECRET/);
    expect(thrown).toThrow(/AUTH_ALLOWED_EMAILS/);
    expect(thrown).toThrow(/5 個/);
  });

  it("1 つだけ欠けていればその 1 つだけを言う", () => {
    const { PLANS: _omitted, ...rest } = localEnv();

    expect(() => assertEnv(rest)).toThrow(/1 個/);
    expect(() => assertEnv(rest)).toThrow(/PLANS/);
  });

  /*
    **全ステージで必須の 2 つ。** ローカルでも本物の Google OAuth を踏む約束なので
    （迂回路を作らない）、`LOCAL_DEV` が立っていても落とす。
  */
  it("BETTER_AUTH_SECRET はローカルでも必須", () => {
    const { BETTER_AUTH_SECRET: _omitted, ...rest } = localEnv();

    expect(() => assertEnv(rest)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("AUTH_ALLOWED_EMAILS はローカルでも必須（空なら誰も通せない）", () => {
    expect(() => assertEnv({ ...localEnv(), AUTH_ALLOWED_EMAILS: "" })).toThrow(
      /AUTH_ALLOWED_EMAILS/,
    );
    expect(() =>
      assertEnv({ ...localEnv(), AUTH_ALLOWED_EMAILS: "   " }),
    ).toThrow(/AUTH_ALLOWED_EMAILS/);
  });

  /*
    **`LOCAL_DEV` が無ければ本番として扱う**（fail-closed）。

    向きが逆（本番側に目印を置く形）だと、目印を渡し忘れた本番が検査を素通りする。
    ここが緑である限り、`BETTER_AUTH_URL` を未設定にした本番は起動しない（要件 `F-G6`）。
  */
  it("LOCAL_DEV が無いと BETTER_AUTH_URL を要求する", () => {
    const { BETTER_AUTH_URL: _omitted, ...rest } = prodEnv();

    expect(() => assertEnv(rest)).toThrow(/BETTER_AUTH_URL/);
  });

  it("LOCAL_DEV が 'true' 以外なら本番として扱う", () => {
    expect(() => assertEnv({ ...localEnv(), LOCAL_DEV: "1" })).toThrow(
      /BETTER_AUTH_URL/,
    );
  });
});

describe("PRODUCTION_REQUIRED_ENV_NAMES", () => {
  /*
    `packages/infra/alchemy.run.ts` に同じ一覧の写しがある。
    **2 つが一致していることを検査するのは `release/env-required.test.ts`。**
    ここでは「P1 の 3 つが入っていること」だけを固定する。
  */
  it("P1 の 3 つが入っている", () => {
    expect([...PRODUCTION_REQUIRED_ENV_NAMES]).toEqual([
      "BETTER_AUTH_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]);
  });

  /*
    **全ステージ必須の 2 つはここに入れない。** ここは「本番だけ必須」の一覧で、
    `assertEnv` が個別に見ているものを二重に数えると、欠落の個数がずれる。
  */
  it("全ステージ必須の 2 つは含まない", () => {
    expect(PRODUCTION_REQUIRED_ENV_NAMES).not.toContain("BETTER_AUTH_SECRET");
    expect(PRODUCTION_REQUIRED_ENV_NAMES).not.toContain("AUTH_ALLOWED_EMAILS");
  });
});
