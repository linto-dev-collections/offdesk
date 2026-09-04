import type { DiscordRestConfig } from "./rest.ts";
import { addReaction, removeOwnReaction } from "./rest.ts";

/*
  印（要件 `F-C4`・計画 P4 §3-6）。**2 つだけ。**

    👀  受け取った
    ✅  Claude へ渡した

  **`asks.delivered_at` / `inbox.taken_at` を立てるのと同じ場所で ✅ に変える**
  （要件 `I-3`）。片方だけ進めると印が嘘になる —— 台帳では渡っているのに
  画面では 👀 のまま、あるいはその逆。

  **付けられなかったときは `console.warn` に残す。** 無言で握ると
  「実装が無いのか権限が無いのか」を切り分ける手掛かりが消える（要件 `N-7`）。
  **本文は出さない**（脅威 12）—— 出すのはチャンネル id とメッセージ id だけ。
*/

export const MARK_SEEN = "👀";
export const MARK_HANDED = "✅";

/** 受け取った印。**判定より先に付ける**（判定が長引いても「無視された」に見えない）。 */
export const markSeen = async (
  config: DiscordRestConfig,
  channelId: string,
  messageId: string,
): Promise<void> => {
  const result = await addReaction(config, channelId, messageId, MARK_SEEN);
  if (!result.ok) {
    /*
      bot に `Add Reactions` と `Read Message History` の**両方**が要る ——
      片方だと 403 になって印が 1 つも付かない（計画 P4 §7）。
    */
    console.warn("[discord] 👀 を付けられませんでした", {
      channelId,
      messageId,
      reason: result.reason,
    });
  }
};

/**
 * 渡した印へ**付け替える**。
 *
 * **✅ を付けてから 👀 を外す。** 逆にすると、付け替えの途中で失敗したときに
 * 印が 1 つも無い姿になり「受け取られていない」に見える（計画 P4 §3-6）。
 * **✅ を付けられなかったときは 👀 を外さない**のも同じ理由。
 */
export const markHandedOff = async (
  config: DiscordRestConfig,
  channelId: string,
  messageId: string,
): Promise<void> => {
  const added = await addReaction(config, channelId, messageId, MARK_HANDED);
  if (!added.ok) {
    console.warn("[discord] ✅ を付けられませんでした（👀 は残します）", {
      channelId,
      messageId,
      reason: added.reason,
    });
    return;
  }

  const removed = await removeOwnReaction(
    config,
    channelId,
    messageId,
    MARK_SEEN,
  );
  if (!removed.ok) {
    // 印が 2 つ並ぶだけで、意味は伝わる（✅ が付いている）。**本題は止めない。**
    console.warn("[discord] 👀 を外せませんでした（✅ は付いています）", {
      channelId,
      messageId,
      reason: removed.reason,
    });
  }
};
