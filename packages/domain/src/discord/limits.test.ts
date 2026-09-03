import { describe, expect, it } from "vitest";
import { DISCORD_THREAD_NAME_MAX, threadName, truncate } from "./limits.ts";

describe("truncate", () => {
  it("上限内はそのまま", () => {
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("超えたら印を付けて切る", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 4)).toHaveLength(4);
  });

  it("上限が 0 以下なら空", () => {
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("abc", -1)).toBe("");
  });

  it("印より狭い上限では印を付けない（超えない方を優先する）", () => {
    expect(truncate("abcdef", 1)).toBe("a");
    expect(truncate("abcdef", 1)).toHaveLength(1);
  });
});

describe("threadName", () => {
  it("接頭辞と指示を並べる", () => {
    expect(threadName("OFFDESK", "READMEを直す")).toBe("OFFDESK READMEを直す");
  });

  /*
    **改行はスレッド名に入らない。** 入れると Discord 側で弾かれて
    「スレッドが作れない」だけが見え、原因が分からない。
  */
  it("改行と連続する空白を 1 つに畳む", () => {
    expect(threadName("OFFDESK", "a\n\nb\t c")).toBe("OFFDESK a b c");
  });

  it("100 文字を超えない", () => {
    const name = threadName("OFFDESK", "あ".repeat(300));

    expect(name.length).toBeLessThanOrEqual(DISCORD_THREAD_NAME_MAX);
    expect(name.endsWith("…")).toBe(true);
  });
});
