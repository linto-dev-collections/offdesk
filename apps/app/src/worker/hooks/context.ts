import { HookContextInput } from "@offdesk/contract";
import { createDb, insertEvent, updateContextUsage } from "@offdesk/db";
import { contextUsedTokens, hasKnownContextWindow } from "@offdesk/domain";
import type { WorkerEnv } from "../env.ts";

/*
  コンテキスト使用量の通報（要件 `F-D4`・`F-D5`・計画 P5 §3-3）。

  **`PreToolUse` と `Stop` の両方がここへ来る。** 表示に使われるのは
  `PreToolUse` の方（次の発言の直前に鳴るので、いちばん新しい値になる）で、
  `Stop` は保険と「1 ターン終わった」の記録。

  **`Stop` で状態を変えない**（要件 `F-D6`・`I-11`）。kanata はここを間違えて
  `Stop` で `done` を立てていたため、会話の途中で「🏁 セッションが終了しました」が
  出ていた（同じセッションが 8 回鳴らした記録がある）。
*/

/**
 * 台帳に無い `run_key` でも 204 で黙って終わる。
 *
 * **hook を失敗させない**（計画 P5 §3-2）。hook スクリプトは `curl` の結果を
 * 捨てて `exit 0` するので実害は無いが、**404 を返すと Cloudflare のログが
 * 赤くなり、切り分けのときに本物の異常と見分けがつかなくなる。**
 */
const NO_CONTENT = 204;

export const handleHookContext = async (
  request: Request,
  env: WorkerEnv,
): Promise<Response> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: NO_CONTENT });
  }

  const parsed = HookContextInput.safeParse(body);
  if (!parsed.success) {
    // **中身を出さない**（脅威 12）。形が違うことだけが切り分けに要る。
    console.warn("[hooks] context の形が違います");
    return new Response(null, { status: NO_CONTENT });
  }

  const { run_key: runKey, event, usage } = parsed.data;
  const model = parsed.data.model ?? null;

  /*
    **知らないモデルは黙って既定値に倒さない**（要件 `F-D4`）。ここで 1 回だけ
    鳴らすのは、描くたびに鳴らすと 1 ターンで何度も出るから ——
    モデル名が入ってくるのは通報のときだけなので、入口が正しい場所。
  */
  if (!hasKnownContextWindow(model)) {
    console.warn("[hooks] 知らないモデルなので既定の窓に倒します", { model });
  }

  const usedTokens = contextUsedTokens({
    inputTokens: usage.input_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
  });

  const db = createDb(env.DB);
  const nowMs = Date.now();

  const found = await updateContextUsage(
    db,
    { runKey, usedTokens, outputTokens: usage.output_tokens, model },
    nowMs,
  );

  /*
    **`Stop` の記録は `events` に残すだけ**（P7a の時系列に出る）。
    本文に転写ログの中身を入れない（脅威 12）—— 数値だけなら、
    あとから「どのターンでどれだけ使ったか」が読める。

    **台帳に行が無いときは挿さない。** `events.run_key` は外部キーなので、
    挿すと 500 になる（`updateContextUsage` の返り値がその判断）。
  */
  if (event === "Stop" && found) {
    await insertEvent(
      db,
      {
        runKey,
        kind: "stop_hook",
        body: `1 ターン終了（${usedTokens} tokens）`,
      },
      nowMs,
    );
  }

  return new Response(null, { status: NO_CONTENT });
};
