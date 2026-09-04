import type { ProjectSummary } from "@offdesk/contract";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

describe("ProjectTable", () => {
  it("名前・チャンネル・リポジトリ・宛先・トークン・状態が出る", () => {
    render(<ProjectTable items={[project()]} />);

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
    render(<ProjectTable items={[project()]} />);

    const link = screen.getByText("111111111111111111").closest("a");
    expect(link?.getAttribute("href")).toBe(
      "https://discord.com/channels/999/111111111111111111",
    );
  });

  it("channelUrl が null なら id を素で出す", () => {
    render(<ProjectTable items={[project({ channelUrl: null })]} />);

    expect(screen.getByText("111111111111111111").closest("a")).toBeNull();
  });

  /*
    plans/security.md 脅威 3。**`fireUrl` 全体が画面に出ない。**
    応答の型にも無いが、**描く側でも確かめる**（`fireUrlHost` を
    誤って URL 全体で埋めたときに、ここが落ちる）。
  */
  it("fire の宛先はホストだけで、trig_ が出ない", () => {
    const { container } = render(<ProjectTable items={[project()]} />);

    expect(container.textContent).not.toContain("trig_");
    expect(container.textContent).not.toContain("/v1/claude_code/");
  });

  it("トークンは末尾 4 文字だけで、伏せ字が付く", () => {
    const { container } = render(<ProjectTable items={[project()]} />);

    expect(container.textContent).toContain("•••• aB3x");
  });

  it("未発行なら「未発行」と出る", () => {
    render(<ProjectTable items={[project({ fireTokenLast4: null })]} />);

    expect(screen.getByText("未発行")).toBeDefined();
  });

  /** 要件 `F-H5`。無効なものも一覧に出す（棚卸しに要る）が、印が付く。 */
  it("無効なプロジェクトも出て、印が付く", () => {
    render(<ProjectTable items={[project({ disabled: true })]} />);

    expect(screen.getByText("offdesk-test")).toBeDefined();
    expect(screen.getByText("無効")).toBeDefined();
  });

  it("0 件なら投入の案内が出る", () => {
    render(<ProjectTable items={[]} />);

    expect(screen.getByText("プロジェクトがありません")).toBeDefined();
    expect(screen.getByText(/projects:sync/)).toBeDefined();
  });
});
