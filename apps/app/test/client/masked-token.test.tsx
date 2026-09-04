import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MaskedToken } from "../../src/client/components/masked-token.tsx";

/*
  fire トークンの表示（要件 `I-1`・plans/security.md 脅威 3・計画 P7b §5）。

  **末尾 4 文字より多くが出ないこと**が要点。応答の型（`ProjectSummary`）に
  暗号文も `fireUrl` 全体も無いのでここへは届かないが、**この部品が
  受け取った 4 文字より多くを描かない**ことは別に固める。
*/

describe("MaskedToken", () => {
  it("last4 があれば •••• と 4 文字が出る", () => {
    const { container } = render(<MaskedToken last4="aB3x" />);

    expect(screen.getByText("aB3x")).toBeDefined();
    expect(container.textContent).toContain("••••");
  });

  /** **`null` は「未発行」。** `••••` で出すと、鍵が無いのか伏せているのか読めない。 */
  it("last4 が null なら「未発行」", () => {
    const { container } = render(<MaskedToken last4={null} />);

    expect(screen.getByText("未発行")).toBeDefined();
    expect(container.textContent).not.toContain("••••");
  });

  /** 伏せ字は 4 文字ちょうど（`pfc_last4_ck` と対）。 */
  it("伏せ字と 4 文字より多くを描かない", () => {
    const { container } = render(<MaskedToken last4="aB3x" />);

    expect(container.textContent).toBe("•••• aB3x");
  });
});
