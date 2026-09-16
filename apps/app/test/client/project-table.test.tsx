import type { ProjectSummary } from "@offdesk/contract";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectTable } from "../../src/client/components/project-table.tsx";

const project = (overrides: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: "p1",
  name: "offdesk-test",
  discordChannelId: "111111111111111111",
  channelUrl: "https://discord.com/channels/999/111111111111111111",
  repoUrl: "https://github.com/linto-dev-collections/offdesk-test",
  fireUrlHost: "api.anthropic.com",
  fireTokenLast4: "aB3x",
  disabled: false,
  ...overrides,
});

/** 押されたことを呼ぶ側へ渡すだけの部品なので、口は毎回差す。 */
const noop = (): void => {};
const actions = { onEdit: noop, onToggleDisabled: noop, busy: false };

describe("ProjectTable", () => {
  it("名前・チャンネル・リポジトリ・宛先・トークン・状態が出る", () => {
    render(<ProjectTable items={[project()]} {...actions} />);

    expect(screen.getByText("offdesk-test")).toBeDefined();
    expect(screen.getByText("111111111111111111")).toBeDefined();
    expect(
      screen.getByText("linto-dev-collections/offdesk-test"),
    ).toBeDefined();
    expect(screen.getByText("api.anthropic.com")).toBeDefined();
    expect(screen.getByText("aB3x")).toBeDefined();
    expect(screen.getByText("有効")).toBeDefined();
  });

  it("チャンネルが Discord へのリンクになっている", () => {
    render(<ProjectTable items={[project()]} {...actions} />);

    const link = screen.getByText("111111111111111111").closest("a");
    expect(link?.getAttribute("href")).toBe(
      "https://discord.com/channels/999/111111111111111111",
    );
  });

  it("channelUrl が null なら id を素で出す", () => {
    render(
      <ProjectTable items={[project({ channelUrl: null })]} {...actions} />,
    );

    expect(screen.getByText("111111111111111111").closest("a")).toBeNull();
  });

  /*
    plans/security.md 脅威 3。**`fireUrl` 全体が画面に出ない。**
    応答の型にも無いが、**描く側でも確かめる**（`fireUrlHost` を
    誤って URL 全体で埋めたときに、ここが落ちる）。
  */
  it("fire の宛先はホストだけで、trig_ が出ない", () => {
    const { container } = render(
      <ProjectTable items={[project()]} {...actions} />,
    );

    expect(container.textContent).not.toContain("trig_");
    expect(container.textContent).not.toContain("/v1/claude_code/");
  });

  it("トークンは末尾 4 文字だけで、伏せ字が付く", () => {
    const { container } = render(
      <ProjectTable items={[project()]} {...actions} />,
    );

    expect(container.textContent).toContain("•••• aB3x");
  });

  it("未発行なら「未発行」と出る", () => {
    render(
      <ProjectTable items={[project({ fireTokenLast4: null })]} {...actions} />,
    );

    expect(screen.getByText("未発行")).toBeDefined();
  });

  /** 要件 `F-H5`。無効なものも一覧に出す（棚卸しに要る）が、印が付く。 */
  it("無効なプロジェクトも出て、印が付く", () => {
    render(<ProjectTable items={[project({ disabled: true })]} {...actions} />);

    expect(screen.getByText("offdesk-test")).toBeDefined();
    expect(screen.getByText("無効")).toBeDefined();
  });

  it("0 件なら投入の案内が出る", () => {
    render(<ProjectTable items={[]} {...actions} />);

    expect(screen.getByText("プロジェクトがありません")).toBeDefined();
    expect(screen.getByText(/増やす/)).toBeDefined();
  });
});

/*
  **行ごとの口**（2026-09-16 に足した）。`projects.json` を畳んで画面から
  増やす・直す・止めるができるようになった分、押されたことが**上へ届く**ことを見る。
*/
describe("行の操作", () => {
  it("直すを押すと、その行のプロジェクトが渡る", () => {
    const onEdit = vi.fn();
    const row = project();
    render(
      <ProjectTable
        items={[row]}
        onEdit={onEdit}
        onToggleDisabled={noop}
        busy={false}
      />,
    );

    screen.getByRole("button", { name: "直す" }).click();

    expect(onEdit).toHaveBeenCalledWith(row);
  });

  /** **有効なら「止める」、無効なら「戻す」。** 押す前に向きが読める。 */
  it.each([
    [false, "止める"],
    [true, "戻す"],
  ])("disabled が %s なら %s が出る", (disabled, label) => {
    render(<ProjectTable items={[project({ disabled })]} {...actions} />);

    expect(screen.getByRole("button", { name: label })).toBeDefined();
  });

  it("止めるを押すと、その行のプロジェクトが渡る", () => {
    const onToggleDisabled = vi.fn();
    const row = project();
    render(
      <ProjectTable
        items={[row]}
        onEdit={noop}
        onToggleDisabled={onToggleDisabled}
        busy={false}
      />,
    );

    screen.getByRole("button", { name: "止める" }).click();

    expect(onToggleDisabled).toHaveBeenCalledWith(row);
  });

  /** **書き込み中は押せない。** 二重に投げると `/offdesk` の登録が 2 回走る。 */
  it("busy のときは押せない", () => {
    render(<ProjectTable items={[project()]} {...actions} busy={true} />);

    for (const name of ["直す", "止める"]) {
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled"),
      ).toBe(true);
    }
  });

  /*
    **「消す」は無い**（`runs.project_id` が `RESTRICT`）。無いことを見張るのは、
    後から足されると run の履歴ごと消せる口になるため。
  */
  it("消す口が無い", () => {
    render(<ProjectTable items={[project()]} {...actions} />);

    expect(screen.queryByRole("button", { name: /消す|削除/ })).toBeNull();
  });
});
