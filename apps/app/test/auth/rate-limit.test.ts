import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { testIp } from "./support.ts";

// ipAddressHeaders を外すと Better Auth はパス単位の単一バケットに落ち、
// 1 か所が上限に当たると全員が締め出される（security.md 脅威 5）。
// 設定値を読むだけでは分からないので、別の IP がまだ通ることを見る。
const ORIGIN = "http://localhost:5173";
const SIGN_IN_LIMIT = 10;

const signInSocial = async (ip: string): Promise<Response> =>
  await worker.fetch(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "cf-connecting-ip": ip,
      },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    }),
    env,
  );

describe("レートリミットは IP ごとに数える", () => {
  it("上限までは通り、超えると 429 になる", async () => {
    const ip = testIp("rate-limit/over");

    const statuses: number[] = [];
    for (let attempt = 0; attempt < SIGN_IN_LIMIT; attempt += 1) {
      statuses.push((await signInSocial(ip)).status);
    }

    expect(statuses).toEqual(Array(SIGN_IN_LIMIT).fill(200));
    expect((await signInSocial(ip)).status).toBe(429);
  });

  // これが ipAddressHeaders の存在理由。設定を外すとここが 429 になる。
  it("別の IP は締め出されない", async () => {
    const blocked = testIp("rate-limit/blocked");
    for (let attempt = 0; attempt <= SIGN_IN_LIMIT; attempt += 1) {
      await signInSocial(blocked);
    }
    expect((await signInSocial(blocked)).status).toBe(429);

    expect((await signInSocial(testIp("rate-limit/other"))).status).toBe(200);
  });
});
