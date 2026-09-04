import {
  type AskRecord,
  attachAskMessage,
  attachEventMessage,
  createDb,
  type Db,
  findAsk,
  findLatestUndeliveredAsk,
  findRun,
  insertAsk,
  insertEvent,
  isTerminalStatus,
  markAskDelivered,
  markRunResumed,
  markRunWaiting,
  type RunRecord,
  touchRunActivity,
  touchRunHeld,
} from "@offdesk/db";
import {
  isAskProblem,
  isHeldAlive,
  isReportProblem,
  MAX_ASK_OPTIONS,
  newAskId,
  REPORT_KINDS,
  RESEND_QUESTION,
  resolveHoldConfig,
  SERVER_INSTRUCTIONS,
  validateAsk,
  validateReport,
} from "@offdesk/domain";
import { askMessage, reportMessage } from "../discord/components.ts";
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
      `新しい問いを立てるときは options が必須（1〜${MAX_ASK_OPTIONS} 個）—— 答える口はボタンだけなので、選択肢が無い問いは誰も答えられない。` +
      "「やったこと」と「次はどうするか」は 1 回にまとめること。" +
      `接続エラーで落ちて ask_id が手元に無いときは、同じ run_key でこれを呼び直せばよい —— question は "${RESEND_QUESTION}" の 1 語でよく、options は要らない。直前の問いを握り直すか、切れている間に届いた答えを返す。質問が 2 回出ることはない。`,
    inputSchema: {
      type: "object",
      properties: {
        run_key: { type: "string", description: RUN_KEY_DESCRIPTION },
        question: {
          type: "string",
          description: `確認したいこと。前提も含めて自己完結させる（拾い直すだけなら "${RESEND_QUESTION}"）`,
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: `選ばせたい選択肢（1〜${MAX_ASK_OPTIONS} 個）。ボタンのラベルになる。拾い直すときは要らない`,
        },
      },
      /*
        **`options` を `required` に入れない**（P3b で外した）。

        P3a では入れていたが、**それだと `${RESEND_QUESTION}` の呼び直しが表現できない**
        —— あちらは `question` の 1 語だけで呼ぶ契約なので、スキーマが
        `options` を要求するとクライアントが送れない形になる。

        **「選択肢が無い問いを作らない」という P3a の判断は変えていない。**
        場所が変わっただけで、`validateAsk`（`MIN_ASK_OPTIONS`）が
        **新しい問いを立てる経路だけ**で要求する。拾い直しはそこを通らない。
      */
      required: ["run_key", "question"],
    },
  },
  {
    name: "ask_wait",
    title: "回答を待ち直す",
    description:
      "ask_human が status:pending を返したとき、同じ ask_id で回答を待ち直す。" +
      "Discord に質問を出し直すことはない（出したままの問いを握り直す）。" +
      "既に答えを渡した ask_id で呼んでも、同じ答えをもう一度返す。",
    inputSchema: {
      type: "object",
      properties: {
        ask_id: {
          type: "string",
          description: "ask_human が返した ask_ で始まる値",
        },
      },
      required: ["ask_id"],
    },
  },
  {
    name: "report",
    title: "進捗を伝える",
    description:
      "依頼者のスレッドへ進捗を出す。**答えを待たない**（すぐ戻る）。" +
      "progress は作業中の報告、blocked は自分では進めなくなったとき、done は一区切り。" +
      "**done を呼んでも会話は終わらない**（終わるのは依頼者が「おわり」と言ったときだけ）。" +
      "答えや次の指示が要るなら report ではなく ask_human を使い、やったことも同じ呼び出しにまとめること。",
    inputSchema: {
      type: "object",
      properties: {
        run_key: { type: "string", description: RUN_KEY_DESCRIPTION },
        kind: { type: "string", enum: [...REPORT_KINDS] },
        body: { type: "string", description: "スレッドに出す本文" },
      },
      required: ["run_key", "kind", "body"],
    },
  },
] as const;

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
      return await askWait(id, args, env, progressTokenOf(params), ctx);
    case "report":
      return await report(id, args, env);
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

/**
 * 終端の run と「見つからない run」を先に落とす（脅威 16）。
 *
 * **どのツールも同じ 2 つを最初に見る。** ここを 1 か所にまとめておかないと、
 * `ask_wait` だけ終端の検査を忘れて「誰も答えられない問いを永久に握り直す」に戻る。
 */
type RunGate =
  | { readonly ok: true; readonly run: RunRecord }
  | { readonly ok: false; readonly response: Response };

const gateRun = async (
  db: Db,
  id: JsonRpcId,
  runKey: string,
): Promise<RunGate> => {
  /*
    **存在しない `run_key` では握らない**（脅威 16・要件 §9-1）。

    この経路は切り分けの道具でもある —— 存在しない run で 1 回呼ばせれば、
    Discord に触れずに許可ドメイン・環境変数・MCP 認証・ツール発見・承認までを
    一度に確かめられる。**だからエラー文で「接続は通っている」ことを名乗る。**
  */
  const run = await findRun(db, runKey);
  if (run === null) {
    return {
      ok: false,
      response: toolResult(
        id,
        `run_key「${runKey}」は台帳にありません。` +
          "**offdesk への接続そのものは通っています**（このエラーはサーバーが返しています）。" +
          "指示の 1 行目にある OFFDESK- で始まる値をそのまま渡してください。",
        true,
      ),
    };
  }

  if (isTerminalStatus(run.status)) {
    return {
      ok: false,
      response: toolStatusResult(
        id,
        {
          status: "closed",
          next: `この run は既に終わっています（status: ${run.status}）。これ以上 offdesk のツールを呼ばず、作業を終えてください。返しても誰にも届きません。`,
        },
        true,
      ),
    };
  }

  return { ok: true, run };
};

/**
 * 答えが入っている問いを Claude へ渡す（要件 `I-3`）。
 *
 * **握らない。** 答えは既にあるので、ストリームを開く理由がない。
 * `delivered_at` はここで立てる —— **立てた瞬間が「渡せた」時点**で、
 * これを立て忘れると次の `ask_human` が同じ答えを何度も返す。
 */
const deliverAnswer = async (
  db: Db,
  id: JsonRpcId,
  ask: AskRecord,
  note?: string,
): Promise<Response> => {
  await markAskDelivered(db, ask.askId, Date.now());
  await markRunResumed(db, ask.runKey);

  return toolStatusResult(id, {
    status: "answered",
    ask_id: ask.askId,
    answer: ask.answer,
    ...(note === undefined ? {} : { note }),
  });
};

/**
 * **問いを立てるのではなく、返せていない問いがあれば拾い直す**（要件 `F-B3`・計画 P3b §3-2）。
 *
 * 壁を全部外しても transport は落ちる。落ちたとき Claude に届くのは
 * **`ask_id` を含まない**エラーなので、Claude にできるのは**これを呼び直すことだけ。**
 * 素通りさせると 2 つの事故になる: Discord に同じ質問が 2 通出る／切れている間に
 * 人が答えていた場合、**その答えが宙に浮いて永久に届かない**（kanata で実際に 1 つ失った）。
 *
 * ## 5 つの段の順序が全部効いている
 *
 * ```txt
 * 1. run を見る            無い / 終端 → 握らない
 * 2. 答えが入っている問い    → その答えを返す（握らない）
 * 3. 握りが生きている        → pending ＋ ask_id（2 本目を握らない。脅威 16）
 * 4. 未回答の問いがある      → 同じ問いを握り直す（Discord に 2 通目を出さない）
 * 5. 返せていない問いが無い  → ふつうに新しい問いを立てる
 * ```
 *
 * **2 を 3 より先に置くのが要点。** 逆にすると、握りが落ちた直後（`held_at` はまだ
 * 新しい）の呼び直しが `pending` に落ち、**その間に届いていた答えが宙に浮く。**
 * これが要件 `I-3` がいちばん守りたい壊れ方そのもの。
 *
 * **3 を 4 より先に置くのも要点。** 逆にすると、本当に 2 本同時に呼ばれたときに
 * 2 本目が同じ問いを握って、ストリームが 2 本開く（脅威 16）。3 で降りた Claude は
 * 返した `ask_id` で `ask_wait` を呼べるので、行き止まりにはならない。
 */
const askHuman = async (
  id: JsonRpcId,
  args: Record<string, unknown>,
  env: WorkerEnv,
  progressToken: string | number | null,
  ctx: Waitable,
): Promise<Response> => {
  const db = createDb(env.DB);
  const runKey = typeof args.run_key === "string" ? args.run_key : "";

  const gate = await gateRun(db, id, runKey);
  if (!gate.ok) return gate.response;
  const run = gate.run;

  const stranded = await findLatestUndeliveredAsk(db, runKey);

  if (stranded !== null && stranded.answer !== null) {
    // 切れている間に人が答えていた。**質問は出し直さない。**
    return await deliverAnswer(
      db,
      id,
      stranded,
      "接続が切れている間に届いた、直前の問いへの回答です。いま渡そうとした質問は出していません。",
    );
  }

  if (isHeldAlive(run.heldAt, Date.now())) {
    console.warn("[mcp] 握りが重なったので 2 本目を返しました", { runKey });
    /*
      **`pending` で返す**（計画 P3a §2）。失敗ではないので `isError` は立てない。

      **`ask_id` を添えるのが P3b で足したところ。** これが無いと、握りが落ちた
      直後（`held_at` がまだ新しい）の呼び直しが行き止まりになる ——
      添えてあれば `ask_wait` でそのまま拾い直せる。
    */
    return toolStatusResult(id, {
      status: "pending",
      ...(stranded === null ? {} : { ask_id: stranded.askId }),
      next:
        stranded === null
          ? "この run では既に別の ask_human が回答を待っています。2 本目は握りません —— そちらが答えを受け取ります。"
          : "この run では既に別の ask_human が同じ問いを待っています。2 本目は握りません —— この ask_id で ask_wait を呼べば、そのまま待ち直せます。",
    });
  }

  if (stranded !== null) {
    /*
      まだ答えが無い。**同じ問いが Discord に出たままなので、2 通目を出さずに握り直す。**
      `onOpen` を渡さないのがそれ（`hold.ts` が「問いは既に出ている」とみなす）。
    */
    await touchRunHeld(db, runKey, Date.now());
    return holdForAnswer({
      id,
      db,
      askId: stranded.askId,
      runKey,
      config: resolveHoldConfig(env),
      progressToken,
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
  }

  /*
    返せていない問いが無い。ふつうに新しい問いを立てる。

    **`options` を要求するのはここだけ**（`validateAsk` の `MIN_ASK_OPTIONS`）。
    拾い直しはこの経路を通らないので、`${RESEND_QUESTION}` の 1 語で呼び直せる。
  */
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
    config: resolveHoldConfig(env),
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

/**
 * `ask_id` が手元にあるときの近道（計画 P3b §3-3）。
 * やることは握り直しと同じで、違うのは**どの ask を握るかの決め方だけ。**
 *
 * **配達済みでもう一度呼ばれたら、同じ答えをもう一度返す**（冪等）。
 * Claude が同じ `ask_id` で 2 回呼ぶことは正常にありうる（応答を受け取る前に落ちた場合）。
 * ここでエラーを返すと会話が止まる。**`delivered_at` は触らない** ——
 * あれは「最初に渡せた時刻」で、上書きすると調査の手掛かりが消える。
 *
 * **`held_at` の検査を持たない**（`ask_human` にはある）。こちらは「この問いを
 * 待ち直す」という明示の指示で、`ask_human` の 3 段目が降りた Claude が
 * 使う出口そのものだから —— ここで同じ検査をすると、その出口が塞がる。
 */
const askWait = async (
  id: JsonRpcId,
  args: Record<string, unknown>,
  env: WorkerEnv,
  progressToken: string | number | null,
  ctx: Waitable,
): Promise<Response> => {
  const db = createDb(env.DB);
  const askId = typeof args.ask_id === "string" ? args.ask_id : "";

  const ask = await findAsk(db, askId);
  if (ask === null) {
    return toolResult(
      id,
      `ask_id「${askId}」は見つかりません。ask_human が返した ask_ で始まる値をそのまま渡してください。`,
      true,
    );
  }

  const gate = await gateRun(db, id, ask.runKey);
  if (!gate.ok) return gate.response;

  if (ask.answer !== null) {
    if (ask.deliveredAt !== null) {
      // 既に渡してある。**冪等に同じ答えを返す**（`delivered_at` は触らない）。
      return toolStatusResult(id, {
        status: "answered",
        ask_id: ask.askId,
        answer: ask.answer,
        note: "この回答は既に渡したものです（同じ答えをもう一度返しています）。",
      });
    }
    return await deliverAnswer(db, id, ask);
  }

  await touchRunHeld(db, ask.runKey, Date.now());
  return holdForAnswer({
    id,
    db,
    askId: ask.askId,
    runKey: ask.runKey,
    config: resolveHoldConfig(env),
    progressToken,
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
};

/**
 * 進捗をスレッドへ出す（要件 `F-D1`・計画 P3b §3-4）。**握らない。**
 *
 * **台帳へ残すのが Discord へ出すより先。** 出せなくても「何が起きたか」は
 * 残す（要件 `N-7`）—— 逆順にすると、出せなかった report が台帳から消える。
 *
 * **`report(done)` は run を `done` にしない**（要件 `I-11`・`F-D3`）。
 * あれは「この作業が終わった」の報告で、会話の終了ではない。終了は `SessionEnd`（P5）。
 *
 * **触るのは `activity_at` だけ**（要件 `F-D5`）。`held_at` は握りの印なので、
 * ここで動かすと「死んだ問いへ回答を書き込む」に戻る。
 */
const report = async (
  id: JsonRpcId,
  args: Record<string, unknown>,
  env: WorkerEnv,
): Promise<Response> => {
  const db = createDb(env.DB);
  const runKey = typeof args.run_key === "string" ? args.run_key : "";

  const gate = await gateRun(db, id, runKey);
  if (!gate.ok) return gate.response;

  const validated = validateReport({ kind: args.kind, body: args.body });
  if (isReportProblem(validated)) {
    return toolResult(id, validated.problem, true);
  }

  const eventId = await insertEvent(
    db,
    { runKey, kind: validated.kind, body: validated.body },
    Date.now(),
  );
  await touchRunActivity(db, runKey, Date.now());

  const posted = await postMessage(
    discordRestConfig(env),
    askTarget(gate.run),
    reportMessage(validated.kind, validated.body),
  );

  if (!posted.ok) {
    /*
      **本題は止めない。** 台帳には残っているので、run 詳細（P7a）で
      「D1 にはあるが Discord には出ていない」ことが見える（`discord_message_id` が NULL）。
      **本文はログに出さない**（脅威 12）。
    */
    console.warn("[mcp] report を Discord へ出せませんでした", {
      runKey,
      kind: validated.kind,
      eventId,
    });
    return toolResult(
      id,
      `記録はしましたが Discord へ出せませんでした（${posted.reason}）。依頼者には届いていません。`,
    );
  }

  await attachEventMessage(db, eventId, posted.id);
  return toolResult(id, "依頼者へ伝えました。");
};
