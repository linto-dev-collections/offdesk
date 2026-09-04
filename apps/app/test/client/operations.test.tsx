import type { GatewayStatus } from "@offdesk/contract";
import { GATEWAY_STATES } from "@offdesk/contract";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  GatewayPanel,
  gatewayStateLabel,
  resetWaitSeconds,
} from "../../src/client/components/gateway-panel.tsx";

/*
  運用画面（要件 `F-I7`・`F-F4`・計画 P7b §5）。

  **固めるのは 2 つ。** `fatal` のときに**直し方**が出ること
  （文言は `packages/contract` の 1 か所）と、`resetAvailableAt` が未来のときに
  張り直しのボタンが**押せない**こと（脅威 15。サーバー側の検査は
  `test/rpc/gateway.test.ts` が別に見る）。
*/

const NOW = Date.UTC(2026, 8, 5, 3, 0, 0);

const status = (overrides: Partial<GatewayStatus> = {}): GatewayStatus => ({
  state: "live",
  healthy: true,
  fatalReason: null,
  lastEventAt: NOW - 5_000,
  connected: true,
  resetAvailableAt: null,
  ...overrides,
});

const panel = (overrides: Partial<GatewayStatus> = {}) => (
  <GatewayPanel
    status={status(overrides)}
    now={NOW}
    onReset={() => undefined}
  />
);

const resetButton = (): HTMLElement =>
  screen.getByRole("button", { name: /張り直す/ });

describe("状態の表示", () => {
  it.each(GATEWAY_STATES)("%s に描画がある", (state) => {
    render(panel({ state }));

    expect(screen.getByText(gatewayStateLabel(state))).toBeDefined();
  });

  it("5 状態すべてで違うラベルになる", () => {
    const labels = GATEWAY_STATES.map(gatewayStateLabel);

    expect(new Set(labels).size).toBe(GATEWAY_STATES.length);
  });

  /*
    **`healthy` と `state === "live"` は一致しない**（計画 P4 §3-7）。
    食い違っているときがいちばん知りたい状態なので、別に出す。
  */
  it("live でも healthy が false なら「届いていません」と出る", () => {
    render(panel({ state: "live", healthy: false }));

    expect(screen.getByText("稼働中")).toBeDefined();
    expect(screen.getByText("素の文が届いていません")).toBeDefined();
  });

  it("ソケットが開いていないことが出る", () => {
    render(panel({ connected: false }));

    expect(screen.getByText("開いていません")).toBeDefined();
  });

  it("イベントが 1 度も来ていなければそう出る", () => {
    render(panel({ lastEventAt: null }));

    expect(screen.getByText("まだありません")).toBeDefined();
  });
});

describe("fatal のときの直し方（計画 P7b §3-3）", () => {
  it("close_4014 なら intent の直し方が出る", () => {
    render(
      panel({ state: "fatal", fatalReason: "close_4014", healthy: false }),
    );

    expect(
      screen.getByText(/MESSAGE CONTENT INTENT が有効になっていません/),
    ).toBeDefined();
  });

  it("close_4004 なら token の入れ直しが出る", () => {
    render(
      panel({ state: "fatal", fatalReason: "close_4004", healthy: false }),
    );

    expect(screen.getByText(/Reset Token/)).toBeDefined();
  });

  /*
    **知らない理由でも黙らない**（生の理由 ＋ 張り直しの案内）。
    2 か所に出る —— 直し方の文と「理由」の欄で、後者は鍵をそのまま見せる。
  */
  it("知らない理由でも生の理由と案内が出る", () => {
    render(
      panel({ state: "fatal", fatalReason: "close_9999", healthy: false }),
    );

    expect(screen.getAllByText(/close_9999/)).toHaveLength(2);
    expect(screen.getByText(/close_9999 で切られました/)).toBeDefined();
  });

  /*
    **直らない失敗は張り直しても戻らない**（要件 `F-I4`）。
    設定を直す必要があることを書いておかないと、押して終わりになる。
  */
  it("設定を直してから押すよう促す", () => {
    render(
      panel({ state: "fatal", fatalReason: "close_4004", healthy: false }),
    );

    expect(screen.getByText(/設定を直してから張り直して/)).toBeDefined();
  });

  it("fatal でなければ直し方は出ない", () => {
    render(panel());

    expect(screen.queryByText(/設定を直してから張り直して/)).toBeNull();
  });
});

describe("張り直しの間隔（脅威 15）", () => {
  it("resetAvailableAt が null なら押せる", () => {
    render(panel());

    expect(resetButton().hasAttribute("disabled")).toBe(false);
  });

  it("resetAvailableAt が未来なら押せない", () => {
    render(panel({ resetAvailableAt: NOW + 45_000 }));

    expect(resetButton().hasAttribute("disabled")).toBe(true);
  });

  it("残り秒数が出る", () => {
    render(panel({ resetAvailableAt: NOW + 45_000 }));

    expect(screen.getByText(/あと 45 秒/)).toBeDefined();
  });

  /** 通信の間は押せない（連打で 2 本目を投げない）。 */
  it("resetPending なら押せない", () => {
    render(
      <GatewayPanel
        status={status()}
        now={NOW}
        resetPending={true}
        onReset={() => undefined}
      />,
    );

    expect(resetButton().hasAttribute("disabled")).toBe(true);
  });

  it("押すと onReset が呼ばれる", () => {
    const onReset = vi.fn();
    render(<GatewayPanel status={status()} now={NOW} onReset={onReset} />);

    resetButton().click();

    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe("resetWaitSeconds", () => {
  it("null は 0（いま叩ける）", () => {
    expect(resetWaitSeconds(status(), NOW)).toBe(0);
  });

  /** **過ぎた時刻も 0。** 負の数を返すと「あと -3 秒」が出る。 */
  it("過ぎた時刻も 0", () => {
    expect(
      resetWaitSeconds(status({ resetAvailableAt: NOW - 1_000 }), NOW),
    ).toBe(0);
  });

  /** **切り上げる。** 0.4 秒残っているのに 0 を出すと、押せないボタンの隣が空になる。 */
  it("端数は切り上げる", () => {
    expect(
      resetWaitSeconds(status({ resetAvailableAt: NOW + 1_400 }), NOW),
    ).toBe(2);
  });
});
