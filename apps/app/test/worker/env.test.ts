import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  assertEnv,
  PRODUCTION_REQUIRED_ENV_NAMES,
  type WorkerEnv,
} from "../../src/worker/env.ts";

/** ローカル扱い（`LOCAL_DEV="true"`）で、バインディングが全部ある env。 */
const localEnv = (): Partial<WorkerEnv> => ({
  DB: env.DB,
  PLANS: env.PLANS,
  GATEWAY: env.GATEWAY,
  LOCAL_DEV: "true",
});

describe("assertEnv", () => {
  it("バインディングが揃っていれば通る", () => {
    expect(() => assertEnv(localEnv())).not.toThrow();
  });

  /*
    **1 個ずつ落とす形になっていないことを検査する。**

    1 つ見つけて throw する実装だと、直して deploy し直すたびに次の 1 つで落ちる。
    ここが緑である限り、設定漏れは 1 回で全部分かる。
  */
  it("欠けているバインディングを全部並べる", () => {
    expect(() => assertEnv({ LOCAL_DEV: "true" })).toThrow(
      /DB, PLANS, GATEWAY/,
    );
  });

  it("欠けている数を数えて言う", () => {
    expect(() => assertEnv({ LOCAL_DEV: "true" })).toThrow(/3 個/);
  });

  it("1 つだけ欠けていればその 1 つだけを言う", () => {
    const { PLANS: _omitted, ...rest } = localEnv();

    expect(() => assertEnv(rest)).toThrow(/1 個/);
    expect(() => assertEnv(rest)).toThrow(/PLANS/);
  });

  /*
    **`LOCAL_DEV` が無ければ本番として扱う**（fail-closed）。

    P0 の `PRODUCTION_REQUIRED_ENV_NAMES` は空なのでバインディングだけの検査に
    なるが、**判定の向きが逆でないこと**をここで固定しておく。
    向きが逆（本番側に目印を置く形）だと、目印を渡し忘れた本番が検査を素通りする。
  */
  it("LOCAL_DEV が無い env でも、バインディングが揃っていれば通る", () => {
    const { LOCAL_DEV: _omitted, ...rest } = localEnv();

    expect(() => assertEnv(rest)).not.toThrow();
  });

  it("LOCAL_DEV が 'true' 以外なら本番として扱う", () => {
    expect(() => assertEnv({ ...localEnv(), LOCAL_DEV: "1" })).not.toThrow();
  });

  /*
    `PRODUCTION_REQUIRED_ENV_NAMES` は `packages/infra/alchemy.run.ts` にも
    同じ一覧の写しがある。**2 つが一致していることを検査するのは P8**
    （`test/release/env-required.test.ts`）。ここでは P0 の前提
    ——「まだ 0 個」——だけを固定して、名前が増えたときに P8 の作業を
    忘れていることに気付けるようにする。
  */
  it("P0 の必須環境変数は 0 個（増やしたら alchemy.run.ts と P8 のテストも直す）", () => {
    expect(PRODUCTION_REQUIRED_ENV_NAMES).toEqual([]);
  });
});
