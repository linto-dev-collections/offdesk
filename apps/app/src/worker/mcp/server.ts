import {
  attachAskMessage,
  createDb,
  findRun,
  insertAsk,
  isTerminalStatus,
  markRunWaiting,
  touchRunHeld,
} from "@offdesk/db";
import {
  isAskProblem,
  isHeldAlive,
  isResendQuestion,
  MAX_ASK_OPTIONS,
  newAskId,
  RESEND_QUESTION,
  resolveHoldConfig,
  SERVER_INSTRUCTIONS,
  validateAsk,
} from "@offdesk/domain";
import { askMessage } from "../discord/components.ts";
import { postMessage } from "../discord/rest.ts";
import type { WorkerEnv } from "../env.ts";
import { discordRestConfig } from "../session/launch.ts";
import { holdForAnswer } from "./hold.ts";
import {
  type JsonRpcId,
  type JsonRpcRequest,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  progressTokenOf,
  rpcError,
  rpcResult,
  toolResult,
  toolStatusResult,
} from "./jsonrpc.ts";

/*
  Worker 自身が MCP サーバーになる（計画 P3a）。cloud session はここへ繋いで
  **人に聞きに来る。**

  なぜこの形か: Claude Code on the web には「走っているセッションへ外から発言を
  差し込む」公式 API が無い。だから「こちらから話しかける」のを諦め、
  **セッション側から聞かせる。** ツール呼び出しは Claude の turn を止めるので、
  人が答えるまで待たせられる（要件 `F-B1`）。

  **認証は `apps/app/src/worker/index.ts` の入口で済ませてある。** 握る前に済ませるのが
  要点（脅威 16。先にストリームを開いてから検査すると、その時点で資源を使っている）。
*/

/**
 * 名乗る版。**先頭が最新。** クライアントが要求した版を持っていればそれを返し、
 * 持っていなければこちらの最新を返す（仕様 basic/lifecycle「Version Negotiation」）。
 *
 * **`2026-07-28` 以降の「毎リクエストに版を載せる」形は実装しない。** あちらは
 * `initialize` を持たない別の握手で、`server/discover` が必須になる。いま繋いでくる
 * クライアント（Claude Code）は `initialize` を送ってくる（kanata で実測済み）ので、
 * 動いている側だけを持つ。両対応が要るようになったら、`initialize` を残したまま
 * `server/discover` を足す（仕様の「Dual-era」）。
 */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

const SERVER_INFO = { name: "offdesk", version: "0.3.0" } as const;

const RUN_KEY_DESCRIPTION =
  "指示の 1 行目にある OFFDESK- で始まる値。そのまま渡すこと";

/**
 * **3 つとも `tools/list` に出す**（計画 P3a §3-4）。中身が入るのは `ask_human` だけで、
 * 残りは「まだ使えません」を返す。
 *
 * 一覧に出しておくのは、**routine の `allowed_tools` を後から増やさなくて済む**ため
 * （あれはコードの外にあるので、増やし忘れると承認待ちで固まる。要件 §9-1）。
 *
 * **説明文に `session_key` と書かない。** 語彙は `run_key`（テーブル定義書 §2）。
 */
const TOOLS = [
  {
    name: "ask_human",
    title: "依頼者に確認する",
    description:
      "判断が要ることを依頼者に確認し、答えが返るまで待つ。選択肢はボタンとして Discord に出る。" +
      "答えが返るまでこの呼び出しは戻らない（待っている間トークンは消費しない）。" +
      `options は必須（1〜${MAX_ASK_OPTIONS} 個）—— 答える口はボタンだけなので、選択肢が無い問いは誰も答えられない。` +
      "「やったこと」と「次はどうするか」は 1 回にまとめること。",
    inputSchema: {
      type: "object",
      properties: {
        run_key: { type: "string", description: RUN_KEY_DESCRIPTION },
        question: {
          type: "string",
          description: "確認したいこと。前提も含めて自己完結させる",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: `選ばせたい選択肢（1〜${MAX_ASK_OPTIONS} 個）。ボタンのラベルになる`,
        },
      },
      required: ["run_key", "question", "options"],
    },
  },
  {
    name: "ask_wait",
    title: "回答を待ち直す",
    description:
      "ask_human が status:pending を返したとき、同じ ask_id で回答を待ち直す。**まだ使えない。**",
    inputSchema: {
      type: "object",
      properties: { ask_id: { type: "string" } },
      required: ["ask_id"],
    },
  },
  {
    name: "report",
    title: "進捗を伝える",
    description:
      "依頼者のスレッドへ進捗を出す。kind は progress / done / blocked。**まだ使えない。**",
    inputSchema: {
      type: "object",
      properties: {
        run_key: { type: "string", description: RUN_KEY_DESCRIPTION },
        kind: { type: "string", enum: ["progress", "done", "blocked"] },
        body: { type: "string" },
      },
      required: ["run_key", "kind", "body"],
    },
  },
] as const;

const NOT_YET =
  "このツールはまだ使えません（次の段で入ります）。いま使えるのは ask_human だけで、" +
  "進捗の報告も ask_human の question に含めてください。";

export type Waitable = {
  waitUntil: (promise: Promise<unknown>) => void;
};

export const handleMcp = async (
  request: Request,
  env: WorkerEnv,
  ctx: Waitable,
): Promise<Response> => {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, PARSE_ERROR, "JSON として読めません");
  }

  const id = body.id ?? null;
  const method = body.method ?? "";

  /*
    通知（`id` を持たない要求）は**受け取ったことだけ返す**（仕様: 202 Accepted・本文なし）。
    `notifications/initialized` がこれで、応答を返すと握手が壊れる。
  */
  if (
    (body.id === undefined || body.id === null) &&
    method.startsWith("notifications/")
  ) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case "initialize": {
      const requested = body.params?.protocolVersion;
      const version =
        typeof requested === "string" &&
        (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;

      return rpcResult(id, {
        protocolVersion: version,
        // `listChanged` を名乗らない（一覧は動かないので、通知する口を持たない）。
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        /*
          クライアントがシステムプロンプトへ差し込む。**サーバー自身が契約を毎回
          名乗る**ための口で、routine 側への貼り忘れで契約が壊れなくなる（要件 §9-1）。
        */
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call":
      return await callTool(id, body.params ?? {}, env, ctx);
    default:
      return rpcError(id, METHOD_NOT_FOUND, `未対応のメソッド: ${method}`);
  }
};

const callTool = async (
  id: JsonRpcId,
  params: Record<string, unknown>,
  env: WorkerEnv,
  ctx: Waitable,
): Promise<Response> => {
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  switch (name) {
    case "ask_human":
      return await askHuman(id, args, env, progressTokenOf(params), ctx);
    case "ask_wait":
    case "report":
      return toolResult(id, NOT_YET, true);
    default:
      /*
        **知らないツールは `isError` ではなくプロトコルの誤りにする**（仕様の例と同じ）。
        呼び方が間違っているので、Claude には同じ呼び方を諦めてほしい。
      */
      return rpcError(id, METHOD_NOT_FOUND, `未対応のツール: ${name}`);
  }
};

/** 問いを出す先。**スレッドが無ければ親チャンネル**（要件 `F-A7` で run に紐付かない run）。 */
const askTarget = (run: {
  readonly threadId: string | null;
  readonly channelId: string;
}): string => run.threadId ?? run.channelId;

const askHuman = async (
  id: JsonRpcId,
  args: Record<string, unknown>,
  env: WorkerEnv,
  progressToken: string | number | null,
  ctx: Waitable,
): Promise<Response> => {
  const db = createDb(env.DB);
  const runKey = typeof args.run_key === "string" ? args.run_key : "";

  /*
    **存在しない `run_key` では握らない**（脅威 16・要件 §9-1）。

    この経路は切り分けの道具でもある —— 存在しない run で 1 回呼ばせれば、
    Discord に触れずに許可ドメイン・環境変数・MCP 認証・ツール発見・承認までを
    一度に確かめられる。**だからエラー文で「接続は通っている」ことを名乗る。**
  */
  const run = await findRun(db, runKey);
  if (run === null) {
    return toolResult(
      id,
      `run_key「${runKey}」は台帳にありません。` +
        "**offdesk への接続そのものは通っています**（このエラーはサーバーが返しています）。" +
        "指示の 1 行目にある OFFDESK- で始まる値をそのまま渡してください。",
      true,
    );
  }

  // 終わった run に問いを立てない（誰も答えられないところへ質問を置かない）。
  if (isTerminalStatus(run.status)) {
    return toolStatusResult(
      id,
      {
        status: "closed",
        next: `この run は既に終わっています（status: ${run.status}）。これ以上 offdesk のツールを呼ばず、作業を終えてください。返しても誰にも届きません。`,
      },
      true,
    );
  }

  /*
    **同じ run で握りを重ねない**（脅威 16）。1 本目が生きているなら譲って即座に返す。
    生きている判定は `runs.held_at`（握りだけが更新するハートビート）。
  */
  if (isHeldAlive(run.heldAt, Date.now())) {
    console.warn("[mcp] 握りが重なったので 2 本目を返しました", { runKey });
    /*
      **`pending` で返す**（計画 P3a §2）。失敗ではないので `isError` は立てない ——
      1 本目が生きていて、そちらが答えを受け取る。
    */
    return toolStatusResult(id, {
      status: "pending",
      next:
        "この run では既に別の ask_human が回答を待っています。2 本目は握りません —— " +
        "そちらが答えを受け取るので、この呼び出しの結果は無視して構いません。",
    });
  }

  /*
    **`(再送)` はまだ拾い直せない**（拾い直しは P3b）。素通りさせると
    「(再送)」だけが書かれた問いが Discord に出るので、握らずに理由を返す。
  */
  if (isResendQuestion(args.question)) {
    return toolResult(
      id,
      `この版ではまだ直前の問いを拾い直せません（${RESEND_QUESTION} は次の段で効きます）。` +
        "同じ問いを question と options で立て直してください。" +
        "**Discord には同じ問いが 2 通並びます。答えとして届くのは新しい方だけです。**",
      true,
    );
  }

  const validated = validateAsk({
    question: args.question,
    options: args.options,
  });
  if (isAskProblem(validated)) return toolResult(id, validated.problem, true);

  const askId = newAskId((byteLength) =>
    crypto.getRandomValues(new Uint8Array(byteLength)),
  );

  /*
    **握る前に `held_at` を立てる。** 立てるのを pump に任せると、その間に来た
    2 本目が「握りは死んでいる」と判定して重なる（上の脅威 16 の検査が空振りする）。
  */
  await touchRunHeld(db, runKey, Date.now());
  await insertAsk(db, { askId, runKey, ...validated }, Date.now());

  const rest = discordRestConfig(env);
  const target = askTarget(run);
  const config = resolveHoldConfig(env);

  /*
    **ストリームを開くのが Discord への投稿より先**（計画 P3a §3-5）。
    外向きの HTTP を先に叩くと、その待ち時間がまるごと
    「最初の 1 バイトが返らない」時間になり、エッジの 75 秒に当たる。
  */
  return holdForAnswer({
    id,
    db,
    askId,
    runKey,
    config,
    progressToken,
    waitUntil: (promise) => ctx.waitUntil(promise),
    onOpen: async () => {
      const posted = await postMessage(
        rest,
        target,
        askMessage({ askId, ...validated }),
      );
      if (!posted.ok) return { ok: false, reason: posted.reason };

      await attachAskMessage(db, askId, posted.id);
      await markRunWaiting(db, runKey);
      return { ok: true };
    },
  });
};
