import { RUN_STATUSES } from "@offdesk/contract";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  RunStatusBadge,
  runStatusLabel,
} from "../../src/client/components/run-status-badge.tsx";

/*
  6 状態すべてに描画がある（計画 P7a §5）。

  **分岐漏れは型が落とす**（`Record<RunStatus, StatusStyle>` が全キーを要求する）。
  ここで見ているのは「**表に載っているものが実際に描かれるか**」——
  型は「キーがある」ことしか言わないので、描画が空でも通ってしまう。
*/

describe("RunStatusBadge", () => {
  it.each(RUN_STATUSES)("%s に描画がある", (status) => {
    render(<RunStatusBadge status={status} />);

    expect(screen.getByText(runStatusLabel(status))).toBeDefined();
  });

  it("6 状態すべてで違うラベルになる（同じ文字で 2 つ出ない）", () => {
    const labels = RUN_STATUSES.map(runStatusLabel);

    expect(new Set(labels).size).toBe(RUN_STATUSES.length);
  });

  /*
    **`waiting` だけが塗り**（`variant="default"`）。人が動くまで進まない
    唯一の状態で、そこに気づけないことが offdesk がいちばん避けたい詰まり方
    （要件 `F-B`）。色のトークンが 3 系統しか無いので、塗りを 1 つに絞ってある。
  */
  it("回答待ちだけが塗りのバッジになる", () => {
    const { container } = render(
      <div>
        {RUN_STATUSES.map((status) => (
          <RunStatusBadge key={status} status={status} />
        ))}
      </div>,
    );

    const filled = [
      ...container.querySelectorAll('[data-variant="default"]'),
    ].map((element) => element.textContent);

    expect(filled).toEqual([runStatusLabel("waiting")]);
  });

  it("アイコンが付く（状態ごとに 1 つ）", () => {
    const { container } = render(<RunStatusBadge status="failed" />);

    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });
});
