import {
  type AskRecord,
  type Db,
  findAsk,
  markAskDelivered,
  markRunResumed,
  touchRunHeld,
} from "@offdesk/db";
import { type HoldConfig, holdLimitMs } from "@offdesk/domain";
import { type JsonRpcId, progressNotification, toolStatus } from "./jsonrpc.ts";

/*
  答えが入るまで SSE のストリームを握り続ける（要件 `F-B1`）。

  **ストリームを先に返してから書き続けるのが肝。** 最初の 1 バイトが出た時点で
  エッジの「応答が始まらない」タイマーは満たされる。握っている間、Claude 側では
  1 つのツール呼び出しが未完了のまま止まっているだけなので、**API リクエストは飛ばない**
  —— 待ち時間のトークン消費が 0 になる、というのがこのフェーズの目的そのもの。

  時計は 4 本ある（値と guard は `packages/domain/src/hold.ts`）:

    pollMs      回答を見に行く間隔
    touchMs     `runs.held_at` を更新し、SSE のコメント行を流す間隔
    progressMs  progress 通知の間隔（**progressToken があるときだけ**）
    deadline    この握りの上限（token が無ければ沈黙の上限に落ちる）

  **コメント行（`: ping`）は JSON-RPC メッセージではない**ので、クライアント側の
  idle の時計は止まらない。止められるのは progress 通知だけ。
*/

/** 問いを Discord へ出す。**ストリームを開いた後に呼ぶ**（外向きの HTTP だから）。 */
export type HoldOpener = () => Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: string }
>;

export type HoldInput = {
  readonly id: JsonRpcId;
  readonly db: Db;
  readonly askId: string;
  readonly runKey: string;
  readonly config: HoldConfig;
  readonly progressToken: string | number | null;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** 省略すると「問いは既に出ている」とみなして握るだけ（P3b の拾い直しが使う）。 */
  readonly onOpen?: HoldOpener;
  /**
   * `delivered_at` を立てた**直後**に呼ばれる（要件 `I-3`・P4）。
   *
   * **ここが 👀 → ✅ の付け替え場所。** 要件 `F-C4` は「`delivered_at` を
   * 立てるのと同じ場所で ✅ に変える」と定めているので、別の場所から呼べる
   * 形にしない —— 片方だけ進むと印が嘘になる。
   *
   * Discord を知っているのは呼ぶ側（`mcp/server.ts`）で、このファイルは知らない。
   */
  readonly onDelivered?: (ask: AskRecord) => Promise<void>;
};

/**
 * 上限に達したときの案内。**`ask_wait` を名指しする**（P3b で口ができた）。
 *
 * P3a では「握り直す口はまだない」と書いていた —— そのままだと
 * `SERVER_INSTRUCTIONS` が `ask_wait` を勧めているのと食い違う（2026-09-04・P4 で直した）。
 */
const PENDING_NEXT =
  "接続を握れる上限に達しました。まだ依頼者は答えていません。" +
  "同じ ask_id で ask_wait を呼び直してください（Discord に質問は出したままです）。";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const holdForAnswer = (input: HoldInput): Response => {
  const { id, db, askId, runKey, config, progressToken } = input;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const write = (chunk: string): Promise<void> =>
    writer.write(encoder.encode(chunk));
  const send = (message: unknown): Promise<void> =>
    write(`data: ${JSON.stringify(message)}\n\n`);

  const pump = async (): Promise<void> => {
    try {
      // 最初の 1 バイト。**これが出るまでがエッジの勝負どころ**（75 秒）。
      await write(": offdesk\n\n");

      if (input.onOpen !== undefined) {
        const opened = await input.onOpen();
        if (!opened.ok) {
          /*
            **出せていないなら「待て」と言っても永久に答えは来ない。**
            すぐ理由を返して Claude に判断させる（要件 `N-7`）。
          */
          await send(
            toolStatus(
              id,
              {
                status: "not_delivered",
                ask_id: askId,
                next: `依頼者へ問いを出せませんでした（${opened.reason}）。人には届いていないので、待たずに自分の判断で進めてください。`,
              },
              true,
            ),
          );
          return;
        }
      }

      const deadline = Date.now() + holdLimitMs(config, progressToken !== null);
      let lastTouch = Date.now();
      let lastProgress = Date.now();
      let progress = 0;

      for (;;) {
        const ask = await findAsk(db, askId);

        if (ask !== null && ask.answer !== null) {
          const answer = ask.answer;
          await send(
            toolStatus(id, { status: "answered", ask_id: askId, answer }),
          );
          /*
            **書き出せたことが「渡せた」の唯一の手掛かり**（要件 `I-3`）。
            ここを立てないと次の `ask_human` が同じ答えを何度も返し、
            書き出す前に立てると答えが宙に浮く。**順序を入れ替えない。**
          */
          await markAskDelivered(db, askId, Date.now());
          if (input.onDelivered !== undefined) await input.onDelivered(ask);
          // 待ちが解けたので作業中に戻す（状態機械の `waiting ─▶ running`）。
          await markRunResumed(db, runKey);
          return;
        }

        const now = Date.now();

        if (now >= deadline) {
          await send(
            toolStatus(id, {
              status: "pending",
              ask_id: askId,
              next: PENDING_NEXT,
            }),
          );
          return;
        }

        if (now - lastTouch >= config.touchMs) {
          /*
            **握りが生きている印**（要件 `F-C5`）。これが止まると、
            この run に 2 本目の握りが乗れるようになる（脅威 16 の窓）。
            コメント行は沈黙を作らないため（エッジ向け）。
          */
          await touchRunHeld(db, runKey, now);
          await write(": ping\n\n");
          lastTouch = now;
        }

        if (progressToken !== null && now - lastProgress >= config.progressMs) {
          progress += 1;
          await send(
            progressNotification(
              progressToken,
              progress,
              "依頼者の回答を待っています",
            ),
          );
          lastProgress = now;
        }

        await sleep(config.pollMs);
      }
    } catch (error) {
      /*
        **相手が切った / 書けなくなった。** 握りを諦めるだけで、回答は D1 に残るので
        失われない（要件 `F-B3` の拾い直しが P3b で使う）。

        無言で捨てない（要件 `N-7`）。**本文と回答は出さず `ask_id` だけ**（脅威 12）。
      */
      console.warn("[mcp] 握りが落ちました", {
        askId,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : "unknown",
      });
    } finally {
      await writer.close().catch(() => {
        // 既に閉じている。ここで投げると pump 自体が unhandled rejection になる。
      });
    }
  };

  // ストリームが閉じるまで Worker を生かす。**await しない**（先に Response を返す）。
  input.waitUntil(pump());

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      /*
        **中継にバッファさせない**（MCP 仕様 `2026-07-28` の SHOULD）。
        溜められると progress 通知がまとめて届き、クライアント側の idle の時計を
        止められない —— 握りの前提（要件 `F-B6`）がそこで崩れる。
      */
      "x-accel-buffering": "no",
    },
  });
};
