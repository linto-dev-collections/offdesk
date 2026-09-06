import { describe, expect, it } from "vitest";
import {
  CONTEXT_BAR_WIDTH,
  contextLine,
  contextUsedTokens,
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  hasKnownContextWindow,
} from "./context.ts";

/*
  使用量の 1 行（計画 P5 §5・要件 `F-D4`）。

  **分子の式と、分母の引き方が別々に壊れる。** 分子は「`output` を足してしまう」
  「`cache_read` を落とす」の 2 通り、分母は「モデルを見ていない」の 1 通りで、
  **どれも症状が「% がおかしい」に見える。** 式と表を別に固める。
*/

describe("分子（公式のステータスラインと同じ式）", () => {
  it("input ＋ cache_creation ＋ cache_read", () => {
    expect(
      contextUsedTokens({
        inputTokens: 2,
        cacheCreationInputTokens: 21_935,
        cacheReadInputTokens: 100_000,
      }),
    ).toBe(121_937);
  });

  /*
    **`output_tokens` はこの型に無い**（足せない形にしてある）。
    出力は次のターンの入力として `input_tokens` に現れるので、足すと二重に数える。
  */
  it("output を渡す口が無い（型で閉じている）", () => {
    const usage = {
      inputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };

    expect(contextUsedTokens(usage)).toBe(10);
    expect(Object.keys(usage)).not.toContain("outputTokens");
  });

  /*
    **`cache_read` を落とすと「まだ 5%」に見える**（P5 §7 の落とし穴）。
    キャッシュが分子の大半を占める形をそのまま置く。
  */
  it("cache_read が分子の大半でも数える", () => {
    expect(
      contextUsedTokens({
        inputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 124_400,
      }),
    ).toBe(124_405);
  });

  it("全部 0 なら 0", () => {
    expect(
      contextUsedTokens({
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toBe(0);
  });
});

describe("分母（モデルから引く）", () => {
  /*
   **native 1M。** 変種を付けなくても 1M で走るモデル。
   */
  it.each([
    ["claude-opus-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["claude-fable-5-1", 1_000_000],
    ["claude-fable-5", 1_000_000],
    ["claude-mythos-5-1", 1_000_000],
    ["claude-mythos-5", 1_000_000],
  ])("%s は native の %i", (model, windowTokens) => {
    expect(contextWindowFor(model)).toBe(windowTokens);
    expect(hasKnownContextWindow(model)).toBe(true);
  });

  /*
    **`claude-opus-5` は 1M**（2026-09-06 に本番で実測して戻した）。

    公式の「Claude Code の既定」の表は 200K としているが、**cloud session の
    `/context` は 1M を返す** —— offdesk が見るのは cloud session だけなので、
    そちらに合わせる。

    **確信の無いモデルは表に足さない。** 引けなければ `%` を出さない側に
    倒れるので、当てずっぽうの分母より「分かりません」の方が良い。
  */
  it("claude-opus-5 は 1M（cloud session の実測）", () => {
    expect(contextWindowFor("claude-opus-5")).toBe(1_000_000);
    expect(hasKnownContextWindow("claude-opus-5")).toBe(true);
  });

  it.each(["claude-opus-4-8", "claude-opus-4-6", "claude-sonnet-4-6"])(
    "%s は表に無いので「引けない」と言う",
    (model) => {
      expect(hasKnownContextWindow(model)).toBe(false);
    },
  );

  /** **1M を持たないモデル。** */
  it.each([
    ["claude-haiku-4-5", 200_000],
    ["claude-haiku-4-5-20251001", 200_000],
  ])("%s は %i", (model, windowTokens) => {
    expect(contextWindowFor(model)).toBe(windowTokens);
    expect(hasKnownContextWindow(model)).toBe(true);
  });

  /*
    **Claude Code は長い窓を角括弧の変種で表す**（`claude-opus-5[1m]`）。
    素の表引きだと当たらないので、名前を引いた上で変種を重ねる
    （**名前が表に無ければ変種は効かない** —— 下の表がそれを固めている）。
  */
  it.each([
    ["claude-opus-5[1m]", 1_000_000],
    ["claude-sonnet-5[1M]", 1_000_000],
    ["claude-haiku-4-5[1m]", 1_000_000],
  ])("%s は変種を見て %i", (model, windowTokens) => {
    expect(contextWindowFor(model)).toBe(windowTokens);
    expect(hasKnownContextWindow(model)).toBe(true);
  });

  /*
    **知らないモデルは既定に倒す**が、`hasKnownContextWindow` は false を返す ——
    入口（`/hooks/context`）がこれを見て `console.warn` に残す（要件 `F-D4` の
    「黙って既定値に倒さない」）。
  */
  it.each([
    ["まだ表に無いモデル", "claude-mythos-9"],
    ["空文字", ""],
    ["変種だけ", "[1m]"],
    ["閉じていない角括弧", "claude-opus-5[1m"],
    ["まだ表に無いモデルの 1M 変種", "claude-mythos-9[1m]"],
  ])("%s は既定に倒れて、知らないと分かる", (_label, model) => {
    expect(contextWindowFor(model)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(hasKnownContextWindow(model)).toBe(false);
  });

  it("モデルが無い（null）なら既定に倒れて、知らないと分かる", () => {
    expect(contextWindowFor(null)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(hasKnownContextWindow(null)).toBe(false);
  });

  /** **少ない側に倒す。** 多い側だと「まだ 12%」に見えて気づけない。 */
  it("既定は 200,000（少ない側）", () => {
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(200_000);
  });
});

const barOf = (line: string): string => {
  const parts = line.split(" ");
  return parts[1] ?? "";
};

describe("1 行の形", () => {
  it("バー ＋ % ＋ 生の値", () => {
    expect(
      contextLine({
        usedTokens: 124_000,
        windowTokens: 200_000,
        windowKnown: true,
      }),
    ).toBe("-# ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░ 62% ・124k/200k");
  });

  it("バーは 20 文字", () => {
    const line = contextLine({
      usedTokens: 33_000,
      windowTokens: 200_000,
      windowKnown: true,
    });

    expect(line).not.toBeNull();
    expect([...barOf(line ?? "")]).toHaveLength(CONTEXT_BAR_WIDTH);
  });

  it.each([
    ["0", 0, "0%", 0],
    ["半分", 100_000, "50%", 10],
    ["分母ちょうど", 200_000, "100%", CONTEXT_BAR_WIDTH],
  ])("%s なら %s", (_label, usedTokens, percent, filled) => {
    const line = contextLine({
      usedTokens,
      windowTokens: 200_000,
      windowKnown: true,
    });

    expect(line).toContain(` ${percent} `);
    expect([...barOf(line ?? "")].filter((c) => c === "▓")).toHaveLength(
      filled,
    );
  });

  /*
    **「満杯 ＝ 使い切った」を守る。** `round` で作ると 99% で満杯に見えるので、
    切り捨てにしてある。
  */
  it("99% では満杯にならない", () => {
    const line = contextLine({
      usedTokens: 199_000,
      windowTokens: 200_000,
      windowKnown: true,
    });

    expect(line).toContain(" 100% ");
    expect([...barOf(line ?? "")].filter((c) => c === "▓")).toHaveLength(
      CONTEXT_BAR_WIDTH - 1,
    );
  });

  /*
    **分母を超えたらバーは 100% で止め、% はそのまま出す**（要件 `F-D4`）。
    分母がモデルと合っていないのは**直すべき事実**なので隠さない。
    生のトークン数を併記してあるので真値は見失わない。
  */
  it("分母を超えても % はそのまま（203%）", () => {
    const line = contextLine({
      usedTokens: 406_000,
      windowTokens: 200_000,
      windowKnown: true,
    });

    expect(line).toBe("-# ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 203% ・406k/200k");
    expect([...barOf(line ?? "")].filter((c) => c === "▓")).toHaveLength(
      CONTEXT_BAR_WIDTH,
    );
  });

  /*
    **1 度も通報が来ていなければ 1 行も出さない。** `0%` を出すと
    「まだ何も使っていない」という嘘になる（起動直後は必ずこの状態）。
  */
  it("usedTokens が null なら 1 行も出さない", () => {
    expect(
      contextLine({
        usedTokens: null,
        windowTokens: 200_000,
        windowKnown: true,
      }),
    ).toBeNull();
  });

  /** 分母が壊れていたら割れないので出さない（`0%` や `Infinity%` を出さない）。 */
  it.each([
    ["0", 0],
    ["負", -1],
  ])("分母が %s なら 1 行も出さない", (_label, windowTokens) => {
    expect(
      contextLine({ usedTokens: 100, windowTokens, windowKnown: true }),
    ).toBeNull();
  });

  it("1M の窓でも読める形になる", () => {
    expect(
      contextLine({
        usedTokens: 124_000,
        windowTokens: 1_000_000,
        windowKnown: true,
      }),
    ).toBe("-# ▓▓░░░░░░░░░░░░░░░░░░ 12% ・124k/1000k");
  });

  /*
    **窓を引けていなければ `%` もバーも出さない**（2026-09-06 に本番で踏んだ）。
    仮の分母で割った `123%` は、読み手にそれが嘘だと分からない。
  */
  describe("窓を引けていないとき", () => {
    it("分子だけを出し、% とバーは出さない", () => {
      const line = contextLine({
        usedTokens: 246_700,
        windowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
        windowKnown: false,
      });

      expect(line).toBe("-# 247k 使用（窓が引けていません）");
      expect(line).not.toContain("%");
      expect(line).not.toContain("▓");
    });

    it("通報が 1 度も来ていなければ、やはり 1 行も出さない", () => {
      expect(
        contextLine({
          usedTokens: null,
          windowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
          windowKnown: false,
        }),
      ).toBeNull();
    });
  });

  /** `-# ` は Discord の小さい文字。**発言の末尾に付ける前提の形。** */
  it("小さい文字の印から始まる", () => {
    expect(
      contextLine({ usedTokens: 1, windowTokens: 200_000, windowKnown: true }),
    ).toMatch(/^-# /);
  });
});
