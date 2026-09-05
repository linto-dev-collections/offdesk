import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRONS } from "../../src/worker/scheduled/crons.ts";
import { resetGatewayDO } from "../support/gateway.ts";
import {
  jsonResponse,
  type OutboundStub,
  stubOutbound,
} from "../support/outbound.ts";
import { runCron } from "./support.ts";

/*
  知らない cron が来たとき（計画 P8 §2-1・§5）。

  **どの分岐にも入らないのが最も分かりにくい壊れ方。** 例外も出ず、
  ログも出ず、ただ何も起きない —— cron の文字列が 3 か所で食い違ったときに
  ここへ来るので、**必ず声を上げる**（要件 `N-7`）。

  `release/cron-consistency.test.ts` が食い違いを先に止めるが、
  **本番で 1 か所だけ手で書き換えられた場合**はここだけが気づける。
*/

let stub: OutboundStub;

beforeEach(async () => {
  await resetGatewayDO();
  stub = stubOutbound([
    ["gateway.discord.gg", () => jsonResponse({ message: "no upgrade" }, 500)],
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("知らない cron", () => {
  it("console.error が出る", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runCron({ cron: "0 0 * * *" });

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("知らない schedule"),
      { cron: "0 0 * * *" },
    );
    spy.mockRestore();
  });

  /** **何もしない。** 知らない schedule で仕事を走らせる方が危ない。 */
  it("Gateway へ繋ぎに行かない", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runCron({ cron: "@daily" });

    expect(stub.calls).toEqual([]);
    spy.mockRestore();
  });

  /*
    **空文字も知らない cron。** `event.cron` は必ず入るが、
    「入っていない」を既定の分岐で拾ってしまうと、知らない値と区別が付かない。
  */
  it("空文字でも声を上げる", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runCron({ cron: "" });

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe("知っている cron", () => {
  it.each(CRONS)("%s では error を出さない", async (cron) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runCron({ cron });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  /** **登録している cron は 1 本だけ**（増やしたら 3 か所に足す）。 */
  it("CRONS は 1 本", () => {
    expect(CRONS).toHaveLength(1);
  });
});
