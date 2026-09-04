import { describe, expect, it } from "vitest";
import {
  ASK_HOLD_MS,
  ASK_POLL_MS,
  ASK_PROGRESS_MS,
  ASK_SILENT_HOLD_MS,
  ASK_TOUCH_MS,
  CLIENT_IDLE_ABORT_MS,
  HELD_ALIVE_MS,
  holdLimitMs,
  isHeldAlive,
  OBSERVED_EDGE_CUTOFF_MS,
  RECOMMENDED_CLIENT_IDLE_TIMEOUT_MS,
  resolveHoldConfig,
} from "./hold.ts";

/*
  計画 P3a §5 の `guard`。**定数を値で守る。**

  ここが緑である限り、時計を伸ばす向きの変更は必ず誰かの目に触れる。
  握りが落ちる 4 つの壁は「症状が同じ（ask_human が呼ばれない / 落ちる）」なので、
  定数を触った人が気付ける唯一の場所がここになる。
*/

describe("握りの前提（外の世界の寸法との関係）", () => {
  it("progress 通知の間隔がエッジの限界より十分内側にある", () => {
    /*
      応答が始まらないまま握るとエッジが 502 を返す。SSE でも「沈黙」が続けば
      同じなので、通知はその半分より内側に置く。**伸ばす向きの変更をここで止める。**
    */
    expect(ASK_PROGRESS_MS * 2).toBeLessThan(OBSERVED_EDGE_CUTOFF_MS);
  });

  it("ハートビートの間隔もエッジの限界より十分内側にある", () => {
    expect(ASK_TOUCH_MS * 2).toBeLessThan(OBSERVED_EDGE_CUTOFF_MS);
  });

  it("沈黙したまま握る上限が、クライアント側の打ち切りより内側にある", () => {
    /*
      `progressToken` が無いと SSE のコメント行しか流れず、クライアントから見れば無音。
      Claude Code は無音 5 分でツール呼び出しを abort する。先に自分から `pending` を
      返して降りれば拾い直せるので、答えも往復も失われない（要件 `F-B6`）。
    */
    expect(ASK_SILENT_HOLD_MS).toBeLessThan(CLIENT_IDLE_ABORT_MS);
  });

  it("握りの上限が、cloud environment に置く idle timeout の推奨値より内側にある", () => {
    /*
      `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`（計画 P3a §1）より握りが長いと、
      上限に達して `pending` を返す前にクライアントが切る。**症状は同じに見える**
      （「5 分で落ちる」ではなく「1 時間で落ちる」になるだけ）。
    */
    expect(ASK_HOLD_MS).toBeLessThan(RECOMMENDED_CLIENT_IDLE_TIMEOUT_MS);
  });

  it("生きている窓が、ハートビート 2 回ぶんより広い", () => {
    /*
      1 回の更新に失敗しただけで「死んだ」と判定すると、生きている握りの上に
      2 本目が乗る（脅威 16 が止めたいもの）。
    */
    expect(ASK_TOUCH_MS * 2).toBeLessThanOrEqual(HELD_ALIVE_MS);
  });

  it("回答を見に行く間隔がハートビートより短い", () => {
    // 逆だと、答えが入っているのに次のハートビートまで返せない。
    expect(ASK_POLL_MS).toBeLessThan(ASK_TOUCH_MS);
  });
});

describe("resolveHoldConfig", () => {
  it("何も渡さなければ既定値", () => {
    expect(resolveHoldConfig()).toEqual({
      holdMs: ASK_HOLD_MS,
      pollMs: ASK_POLL_MS,
      progressMs: ASK_PROGRESS_MS,
      silentHoldMs: ASK_SILENT_HOLD_MS,
      touchMs: ASK_TOUCH_MS,
    });
  });

  it("テストのために縮められる（要件 N-9）", () => {
    const config = resolveHoldConfig({
      ASK_HOLD_MS: "80",
      ASK_POLL_MS: "5",
      ASK_PROGRESS_MS: "10",
      ASK_SILENT_HOLD_MS: "40",
      ASK_TOUCH_MS: "10",
    });

    expect(config).toEqual({
      holdMs: 80,
      pollMs: 5,
      progressMs: 10,
      silentHoldMs: 40,
      touchMs: 10,
    });
  });

  /*
    **0 と NaN を既定に倒すことを明示する。** `Number(raw) || fallback` と書けば
    同じ結果になるが、「0 を渡すと握らない」と読める形を残さない。
  */
  it.each(["", "  ", "0", "-1", "abc", "Infinity", "NaN"])(
    "不正な値（%s）は既定に倒す",
    (raw) => {
      expect(resolveHoldConfig({ ASK_HOLD_MS: raw }).holdMs).toBe(ASK_HOLD_MS);
    },
  );
});

describe("holdLimitMs", () => {
  const config = resolveHoldConfig();

  it("progressToken があれば上限まで握る", () => {
    expect(holdLimitMs(config, true)).toBe(ASK_HOLD_MS);
  });

  it("progressToken が無ければ沈黙の上限に落ちる", () => {
    expect(holdLimitMs(config, false)).toBe(ASK_SILENT_HOLD_MS);
  });

  it("上限そのものが沈黙の上限より短いときは、短い方を採る", () => {
    const short = resolveHoldConfig({ ASK_HOLD_MS: "50" });
    expect(holdLimitMs(short, false)).toBe(50);
  });
});

describe("isHeldAlive", () => {
  it("一度も握られていない run は生きていない", () => {
    // ここを true に倒すと、最初の ask_human が自分自身に譲って永久に握れない。
    expect(isHeldAlive(null, 1_000, 60_000)).toBe(false);
  });

  it("窓の内側なら生きている", () => {
    expect(isHeldAlive(1_000, 1_000 + 59_999, 60_000)).toBe(true);
  });

  it("窓のちょうど境界では生きていない", () => {
    expect(isHeldAlive(1_000, 1_000 + 60_000, 60_000)).toBe(false);
  });

  it("既定の窓を使う", () => {
    expect(isHeldAlive(1_000, 1_000 + HELD_ALIVE_MS - 1)).toBe(true);
    expect(isHeldAlive(1_000, 1_000 + HELD_ALIVE_MS)).toBe(false);
  });
});
