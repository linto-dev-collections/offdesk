import type { TimelineEntry } from "@offdesk/contract";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Timeline } from "../../src/client/components/timeline.tsx";

const NOW = Date.UTC(2026, 8, 5, 3, 0, 0);
const at = (minutesAgo: number): number => NOW - minutesAgo * 60_000;

const ask = (
  overrides: Partial<Extract<TimelineEntry, { kind: "ask" }>> = {},
): TimelineEntry => ({
  kind: "ask",
  at: at(30),
  question: "どちらに倒しますか",
  options: ["A 案", "B 案"],
  answer: null,
  answeredAt: null,
  deliveredAt: null,
  ...overrides,
});

const event = (
  overrides: Partial<Extract<TimelineEntry, { kind: "event" }>> = {},
): TimelineEntry => ({
  kind: "event",
  at: at(20),
  eventKind: "progress",
  body: "テストを書いています",
  discordMessageId: "123456789012345678",
  ...overrides,
});

const inbox = (
  overrides: Partial<Extract<TimelineEntry, { kind: "inbox" }>> = {},
): TimelineEntry => ({
  kind: "inbox",
  at: at(10),
  body: "あとで見ます",
  takenAt: null,
  takenByRunKey: null,
  ...overrides,
});

describe("Timeline", () => {
  /*
    **3 種すべてが描かれる**（計画 P7a §5）。種別を足すと
    `renderEntry` の `assertNever` の引数が `never` でなくなってコンパイルエラー
    になるので、「描き忘れ」は型が落とす。ここは中身が出るかを見る。
  */
  it("ask / event / inbox の 3 種が描かれる", () => {
    render(<Timeline entries={[ask(), event(), inbox()]} now={NOW} />);

    expect(screen.getByText("質問")).toBeDefined();
    expect(screen.getByText("進捗")).toBeDefined();
    expect(screen.getByText("素の文")).toBeDefined();

    expect(screen.getByText("どちらに倒しますか")).toBeDefined();
    expect(screen.getByText("テストを書いています")).toBeDefined();
    expect(screen.getByText("あとで見ます")).toBeDefined();
  });

  it("受け取った順のまま並べる（並べ替えはサーバー側）", () => {
    const { container } = render(
      <Timeline entries={[inbox(), event(), ask()]} now={NOW} />,
    );

    const labels = [...container.querySelectorAll("li")].map(
      (item) => item.querySelector("span")?.textContent,
    );
    expect(labels).toEqual(["素の文", "進捗", "質問"]);
  });

  it("選択肢がバッジで並ぶ", () => {
    render(<Timeline entries={[ask()]} now={NOW} />);

    expect(screen.getByText("A 案")).toBeDefined();
    expect(screen.getByText("B 案")).toBeDefined();
  });

  it("選択肢が空なら 1 つも出さない", () => {
    const { container } = render(
      <Timeline entries={[ask({ options: [] })]} now={NOW} />,
    );

    expect(container.querySelectorAll('[data-slot="badge"]')).toHaveLength(0);
  });

  it("未回答の問いには「まだ答えが入っていません」", () => {
    render(<Timeline entries={[ask()]} now={NOW} />);

    expect(screen.getByText("まだ答えが入っていません")).toBeDefined();
  });

  it("答えが入っていれば回答を出す", () => {
    render(
      <Timeline
        entries={[
          ask({ answer: "B 案", answeredAt: at(25), deliveredAt: at(25) }),
        ]}
        now={NOW}
      />,
    );

    expect(screen.getByText("回答: B 案")).toBeDefined();
    expect(screen.queryByText(/Claude へ渡っていません/)).toBeNull();
  });

  /*
    **答えは入っているのに `delivered_at` が立っていない**（要件 `I-3`）。
    待っている人からは「答えたのに動かない」に見えるので、詳細画面がそこを言う。
  */
  it("渡っていない答えには警告が出る", () => {
    render(
      <Timeline
        entries={[
          ask({ answer: "B 案", answeredAt: at(25), deliveredAt: null }),
        ]}
        now={NOW}
      />,
    );

    expect(
      screen.getByText("答えは入っていますが Claude へ渡っていません"),
    ).toBeDefined();
  });

  /** `discord_message_id` が NULL ＝ 台帳には残っているが Discord には出ていない（`N-7`）。 */
  it("Discord に出ていない event には警告が出る", () => {
    render(
      <Timeline entries={[event({ discordMessageId: null })]} now={NOW} />,
    );

    expect(screen.getByText("Discord には出ていません")).toBeDefined();
  });

  it("Discord に出た event には警告が出ない", () => {
    render(<Timeline entries={[event()]} now={NOW} />);

    expect(screen.queryByText("Discord には出ていません")).toBeNull();
  });

  it("5 種の event すべてにラベルがある", () => {
    render(
      <Timeline
        entries={[
          event({ eventKind: "progress" }),
          event({ eventKind: "done" }),
          event({ eventKind: "blocked" }),
          event({ eventKind: "stop_hook" }),
          event({ eventKind: "error" }),
        ]}
        now={NOW}
      />,
    );

    for (const label of ["進捗", "完了", "詰まり", "ターン終わり", "エラー"]) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  /** `taken_by_run_key` は「どの実行に届いたのか」（テーブル定義書 §4-6）。 */
  it("渡し終わった素の文には渡した先が出る", () => {
    render(
      <Timeline
        entries={[
          inbox({ takenAt: at(5), takenByRunKey: "OFFDESK-1111111111111111" }),
        ]}
        now={NOW}
      />,
    );

    expect(
      screen.getByText("渡した先: OFFDESK-1111111111111111"),
    ).toBeDefined();
  });

  it("まだ渡していない素の文にはそう出る", () => {
    render(<Timeline entries={[inbox()]} now={NOW} />);

    expect(screen.getByText("まだ渡していません")).toBeDefined();
  });

  /** 相対表示と絶対表示を併記する（計画 P7a §3-5）。 */
  it("相対と絶対の両方の時刻が出る", () => {
    render(<Timeline entries={[event({ at: at(20) })]} now={NOW} />);

    expect(screen.getByText("20 分前")).toBeDefined();
    expect(screen.getByText("2026-09-05 11:40")).toBeDefined();
  });

  /** 空でも壊れない（3 状態のうちの「空」。計画 P7a §3-5）。 */
  it("空なら空の表示になる", () => {
    render(<Timeline entries={[]} now={NOW} />);

    expect(screen.getByText("まだ記録がありません")).toBeDefined();
  });

  /*
    **同じ内容の行が 2 つ並んでも落ちない。** 3 表を混ぜた行に横断の id は
    無いので、key は種別 ＋ 時刻 ＋ 位置で組んである。
  */
  it("同じ内容の行が並んでも両方描かれる", () => {
    const { container } = render(
      <Timeline entries={[event(), event()]} now={NOW} />,
    );

    expect(container.querySelectorAll("li")).toHaveLength(2);
  });
});
