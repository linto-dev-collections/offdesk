import { DurableObject } from "cloudflare:workers";
import {
  GATEWAY_CLOSE_RESTART,
  GATEWAY_INTENTS,
  GATEWAY_OP,
  GATEWAY_RESET_INTERVAL_MS,
  type GatewayEffect,
  type GatewayInput,
  type GatewayState,
  type InboundMessage,
  isGatewayHealthy,
  parseGatewayFrame,
  step,
} from "@offdesk/domain";
import { applyInbound } from "../discord/inbound.ts";
import { isConfigured, type WorkerEnv } from "../env.ts";
import { outboundFetch } from "../outbound.ts";

/*
  Discord Gateway への常駐接続（要件 `F-I1`〜`F-I5`・計画 P4 §3-3）。

  **なぜ DO なのか。** Discord には素の文（`MESSAGE_CREATE`）を HTTP で受け取る
  手段が無い。webhook で飛んでくるのは Social SDK 由来の一部イベントだけで、
  チャンネルの発言は常時接続の WebSocket でしか来ない。

  **1 つだけ**（`idFromName("main")`。要件 `I-9`）。outbound WebSocket は
  hibernation 非対応で、繋いでいる間ずっと duration 課金になる
  （月 約 324,000 GB-s ＝ 含有枠 400,000 の内側）。**2 つ目を足すと枠を超える。**

  ここが守ること:

  | | why |
  | --- | --- |
  | **`setInterval` を使わない** | outbound WebSocket が DO を生かすのは 1 接続あたり最長 15 分。その後は通常の evict 規則に戻るので、タイマは必ずどこかで消える。**alarm は永続する**ので、evict されても runtime が起こしてくれる |
  | **`fetch` に `wss://` を渡さない** | `Fetch API cannot load: wss://…` で即座に落ちる。直すのは `gatewayConnectUrl`（domain） |
  | **bot token を外へ出さない** | `env` から読んで identify に載せるだけ。D1 にも R2 にも DO storage にも書かない（脅威 15） |
  | 状態は `step` に委ねる | ここは「ソケットを開く / 閉じる / 送る」と「alarm を張る」だけ |
  | **判定を DO に書かない** | `MESSAGE_CREATE` は `applyInbound` に渡す。4 通りの分岐をここに入れると手でテストできなくなる |
*/

/** DO の中で解決する URL。**外へ出ないので host は何でもよい**（形だけ要る）。 */
const DO_ORIGIN = "https://gateway.offdesk.internal";

export const GATEWAY_PATH = {
  status: "/status",
  ensure: "/ensure",
  reset: "/reset",
} as const;

/**
 * `fatal` と reset の時刻だけ DO storage に置く。
 *
 * **evict されるとメモリの状態は消える。** それだけだと `fatal` が `idle` に戻り、
 * 5 分 cron の `/ensure` が張り直しに行く —— **要件 `F-I4` が禁じている
 * 「直らない失敗で張り続ける」**そのもの。だから `fatal` は永続させる。
 *
 * reset の時刻も同じ理由（永続しないと、evict を挟めば 60 秒の間隔をすり抜けられる）。
 *
 * **セッション（`session_id` / `seq`）は永続させない。** あれは 1 接続の一時的な
 * 状態で（要件 §8-1）、evict を挟んだ resume はどうせ 4007 / op 9 で落ちる。
 */
const FATAL_KEY = "fatalReason";
const RESET_KEY = "resetAt";

export class DiscordGatewayDO extends DurableObject<WorkerEnv> {
  #state: GatewayState = { kind: "idle" };
  #socket: WebSocket | null = null;
  #resetAt: number | null = null;
  /**
   * 捨てたソケットの**遺言を聞かない**ための世代番号。
   *
   * **これが無いと reset が繋がらない。** `reset` の効果は「切る → 繋ぐ」の順で
   * 走るが、**`close` イベントは非同期に届く** —— `fetch` を待っている間に
   * 古いソケットの `close` が入ると、`step` は「いま張りに行った接続が切れた」と
   * 読んで `backoff` に落とす。結果、**生きたソケットを持ったまま状態は `backoff`**。
   *
   * 送受信の相手を 1 本に保つのは `#socket` の役目で、**過去のソケットから
   * 遅れて届くイベントを落とす**のがこちらの役目（`#socket` を見るだけでは、
   * 新しいソケットが入っている間に古い方の `close` が来たときに区別できない）。
   */
  #generation = 0;
  /**
   * 素の文の処理を**1 本ずつ**に並べる。
   *
   * 並行に走らせると、同じスレッドへ 2 行が同時に届いたときに
   * `applyInbound` の起こし直しが 2 本同時に走り、`runs_live_thread_uidx` で
   * 片方が落ちる。**届いた順に 1 本ずつ**なら、2 行目は 1 本目が立てた run を見る。
   */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);

    /*
      **`blockConcurrencyWhile` で読む。** これを外すと、最初のリクエストが
      「まだ `fatal` を読んでいない」状態で張りに行く（`F-I4` が空振りする）。
    */
    ctx.blockConcurrencyWhile(async () => {
      const fatal = await ctx.storage.get<string>(FATAL_KEY);
      if (fatal !== undefined) this.#state = { kind: "fatal", reason: fatal };
      this.#resetAt = (await ctx.storage.get<number>(RESET_KEY)) ?? null;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    switch (path) {
      case GATEWAY_PATH.status:
        return this.#statusResponse();

      /*
        **DO は自分では起動できない**（要件 `F-I2`）。5 分 cron がここを叩いて
        「alarm ごと evict された状態」から復帰させる（P8）。
        **既に `live` なら何も起きない**（`tick` が状態を見る）。
      */
      case GATEWAY_PATH.ensure:
        await this.#tick();
        return this.#statusResponse();

      case GATEWAY_PATH.reset:
        return await this.#reset();

      default:
        return new Response("not found", { status: 404 });
    }
  }

  /** **タイマは alarm**（要件 `F-I3`）。ハートビート・期限・バックオフの全部がここから。 */
  override async alarm(): Promise<void> {
    await this.#tick();
  }

  /* ---- 入口 ---- */

  /**
   * **`DISCORD_BOT_TOKEN` が無いなら張りに行かない**（要件 `I-2` の fail-closed）。
   *
   * 空の token で identify を投げると 4004 で切られ、それを繰り返すと
   * identify のレート制限を使い切る（脅威 15）。`fatal` にして人に見せる。
   */
  async #tick(): Promise<void> {
    const at = Date.now();
    await this.#drive(
      isConfigured(this.env.DISCORD_BOT_TOKEN)
        ? { kind: "tick", at }
        : { kind: "misconfigured", at, reason: "no_token" },
    );
  }

  async #reset(): Promise<Response> {
    const now = Date.now();
    const availableAt = this.#resetAvailableAt();

    /*
      **連打を受け付けない**（脅威 15）。クライアント（P7b の画面）も同じ判定を
      するが、**サーバーでも必ず検査する** —— 画面の判定は迂回できる。
    */
    if (availableAt !== null && now < availableAt) {
      return Response.json(
        { ...this.#status(), error: "too_soon" },
        { status: 429 },
      );
    }

    this.#resetAt = now;
    await this.ctx.storage.put(RESET_KEY, now);

    if (!isConfigured(this.env.DISCORD_BOT_TOKEN)) {
      await this.#drive({ kind: "misconfigured", at: now, reason: "no_token" });
      return this.#statusResponse();
    }

    await this.#drive({ kind: "reset", at: now });
    return this.#statusResponse();
  }

  /* ---- 状態遷移 ---- */

  /** **状態が変わる唯一の道。** `step`（純粋関数）が決め、ここは効果を実行するだけ。 */
  async #drive(input: GatewayInput): Promise<void> {
    const wasFatal = this.#state.kind === "fatal";
    const { next, effects } = step(this.#state, input);
    this.#state = next;

    if (next.kind === "fatal") {
      /*
        **理由を永続させる。** evict を挟んでも `fatal` のままにするため。
        `reason` は `close_4014` のような鍵で、**bot token は含まない**（脅威 15）。
      */
      console.warn("[gateway] 張り直しません（人が直すまで戻りません）", {
        reason: next.reason,
      });
      await this.ctx.storage.put(FATAL_KEY, next.reason);
    } else if (wasFatal) {
      await this.ctx.storage.delete(FATAL_KEY);
    }

    for (const effect of effects) await this.#apply(effect);
  }

  async #apply(effect: GatewayEffect): Promise<void> {
    switch (effect.kind) {
      case "connect":
        await this.#connect(effect.url);
        return;

      case "identify":
        /*
          **bot token が外へ出るのはこの 1 行だけ**（脅威 15）。
          `properties` は Discord が要求する形だけを最小で埋める。
        */
        this.#send({
          op: GATEWAY_OP.identify,
          d: {
            token: this.env.DISCORD_BOT_TOKEN,
            intents: GATEWAY_INTENTS,
            properties: {
              os: "linux",
              browser: "offdesk",
              device: "offdesk",
            },
          },
        });
        return;

      case "resume":
        this.#send({
          op: GATEWAY_OP.resume,
          d: {
            token: this.env.DISCORD_BOT_TOKEN,
            session_id: effect.sessionId,
            seq: effect.seq,
          },
        });
        return;

      case "heartbeat":
        this.#send({ op: GATEWAY_OP.heartbeat, d: effect.seq });
        return;

      case "disconnect":
        this.#discard(effect.code, effect.reason);
        return;

      case "alarm":
        /*
          **`null` は「起きない」**（`fatal` と `idle`）。要件 `F-I4` の
          「張り直さない」は、alarm を消すことでしか守れない ——
          残しておくと次の `tick` が張りに行く。
        */
        await (effect.atMs === null
          ? this.ctx.storage.deleteAlarm()
          : this.ctx.storage.setAlarm(effect.atMs));
        return;
    }
  }

  /* ---- ソケット ---- */

  async #connect(url: string): Promise<void> {
    // 前のソケットを残したまま張ると、2 本目の identify が 4005 で切られる。
    const generation = this.#discard(GATEWAY_CLOSE_RESTART, "張り直し");

    let socket: WebSocket | null = null;
    try {
      /*
        **`Upgrade: websocket` を付けた `fetch`。** Workers から外向きの
        WebSocket を張る唯一の形で、**`wss://` ではなく `https://` を渡す**
        （`gatewayConnectUrl` が直してある）。
      */
      const response = await outboundFetch(url, {
        headers: { Upgrade: "websocket" },
      });
      socket = response.webSocket;
      if (socket === null) {
        console.warn("[gateway] WebSocket に切り替わりませんでした", {
          status: response.status,
        });
      }
    } catch (error) {
      console.warn("[gateway] 接続に失敗しました", {
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : "unknown",
      });
    }

    /*
      **待っている間に追い越されたら、開いたソケットを捨てる。**
      `reset` や別の張り直しが走った場合がこれ —— そのまま `#socket` へ入れると、
      いま有効な接続を上書きして 2 本目の identify を投げることになる。
    */
    if (generation !== this.#generation) {
      socket?.close(1000, "追い越されました");
      return;
    }

    if (socket === null) {
      // **1006 = 異常終了。** 一時的な失敗として backoff に落ちる。
      await this.#drive({ kind: "close", at: Date.now(), code: 1006 });
      return;
    }

    socket.accept();
    this.#socket = socket;
    this.#listen(socket, generation);

    await this.#drive({ kind: "open", at: Date.now() });
  }

  #listen(socket: WebSocket, generation: number): void {
    socket.addEventListener("message", (event) => {
      // 捨てたソケットから遅れて届いたフレームは読まない。
      if (generation !== this.#generation) return;
      /*
        **`applyInbound` は D1 と Discord を触るので時間がかかる。** 受信の
        ハンドラで待つと後続のフレーム（ハートビート ACK）が詰まるので、
        `#queue` に並べて順に流す。**投げっぱなしにしない**（catch を付ける）。
      */
      this.#enqueue(() => this.#receive(event.data));
    });

    socket.addEventListener("close", (event) => {
      /*
        **捨てたソケットの `close` は無視する**（`#generation` の why を参照）。
        自分から切ったときも `close` は来るので、ここを素通りさせると
        「切る → 繋ぐ」の途中で `backoff` に落ちる。
      */
      if (generation !== this.#generation) return;

      this.#socket = null;
      this.#enqueue(() =>
        this.#drive({ kind: "close", at: Date.now(), code: event.code }),
      );
    });

    socket.addEventListener("error", () => {
      /*
        **ここで状態を動かさない。** `error` の後には必ず `close` が来るので、
        両方で遷移させると 2 回張り直しに行く（identify を無駄に 1 回使う）。
      */
      console.warn("[gateway] ソケットがエラーを報告しました");
    });
  }

  #enqueue(work: () => Promise<unknown>): void {
    this.#queue = this.#queue.then(work).catch((error: unknown) => {
      // **無言で捨てない**（要件 `N-7`）。本文は出さない（脅威 12）。
      console.warn("[gateway] 受信の処理が落ちました", {
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : "unknown",
      });
    });
  }

  #send(payload: unknown): void {
    const socket = this.#socket;
    if (socket === null) return;

    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      // 既に閉じている。`close` イベントが来るので、ここでは記録だけ。
      console.warn("[gateway] 送信できませんでした", {
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : "unknown",
      });
    }
  }

  /**
   * いまのソケットを捨てて、**世代を 1 つ進める。**
   *
   * 進めた後の世代を返すのが要点 —— 呼んだ側はそれを持って
   * 「自分が張った接続がまだ最新か」を後から判定できる。
   */
  #discard(code: number, reason: string): number {
    const socket = this.#socket;
    this.#socket = null;
    this.#generation += 1;

    if (socket !== null) {
      try {
        socket.close(code, reason);
      } catch {
        // 既に閉じている。**印を残す必要がない**（閉じたいだけなので目的は達している）。
      }
    }

    return this.#generation;
  }

  /* ---- 受信 ---- */

  /**
   * **振り分けは `parseGatewayFrame`（純粋関数）が持つ。**
   *
   * ソケットを張るテストは書けない（`WebSocketPair` は DO の I/O 文脈を
   * 越えられない。2026-09-04 に実測）ので、**ここに書いたものは一切
   * テストできない。** だから読み方を domain へ出し、ここは実行するだけにする。
   */
  async #receive(data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return;

    for (const action of parseGatewayFrame(data, Date.now())) {
      switch (action.kind) {
        case "input":
          await this.#drive(action.input);
          break;

        case "beat":
          /*
            **Discord から「いま送れ」と言われた**（op 1）。`step` を通さずに
            即座に返すのは、これが周期の話ではなく要求への応答だから ——
            `step` に入れると次の周期がずれる。
          */
          this.#send({
            op: GATEWAY_OP.heartbeat,
            d: this.#state.kind === "live" ? this.#state.session.seq : null,
          });
          break;

        case "message":
          await this.#onMessageCreate(action.message);
          break;
      }
    }
  }

  /**
   * **判定はここに書かない**（計画 P4 §3-3）。`applyInbound` に渡す ——
   * 4 通りの分岐を DO に入れると、ソケットを張らずにテストできなくなる。
   *
   * **本文をログに出さない**（脅威 12）。出すのは `message_id` と判定結果だけ。
   */
  async #onMessageCreate(message: InboundMessage): Promise<void> {
    const outcome = await applyInbound(this.env, message);

    if (outcome.decision !== "ignore") {
      console.warn("[gateway] 素の文を扱いました", {
        messageId: message.messageId,
        decision: outcome.decision,
        runKey: outcome.runKey,
      });
    }
  }

  /* ---- 状態の見せ方（要件 `F-I7`） ---- */

  /**
   * **bot token に到達する値を 1 つも出さない**（計画 P4 §3-7）。
   * デバッグ情報を足したくなる場所なので、形は `packages/contract` の
   * `GatewayStatus` が閉じている（あちらが `parse` する）。
   */
  #status(): Record<string, unknown> {
    const state = this.#state;
    return {
      state: state.kind,
      healthy: isGatewayHealthy(state, Date.now()),
      fatalReason: state.kind === "fatal" ? state.reason : null,
      lastEventAt: state.kind === "live" ? state.lastEventAt : null,
      connected: this.#socket !== null,
      resetAvailableAt: this.#resetAvailableAt(),
    };
  }

  #statusResponse(): Response {
    return Response.json(this.#status());
  }

  /** **`null` = いま叩ける。** 過ぎた時刻を返すと画面がずっと無効のままになる。 */
  #resetAvailableAt(): number | null {
    if (this.#resetAt === null) return null;
    const at = this.#resetAt + GATEWAY_RESET_INTERVAL_MS;
    return at > Date.now() ? at : null;
  }
}

/**
 * **常駐 DO は 1 つだけ**（要件 `I-9`）。名前を 1 か所に閉じてあるのは、
 * `idFromName` を呼ぶ場所が増えたときに別の名前が混ざらないようにするため ——
 * **2 つ目の常駐 DO を足すと含有枠を超える**（月 約 324,000 GB-s × 2 > 400,000）。
 */
export const gatewayStub = (env: WorkerEnv): DurableObjectStub =>
  env.GATEWAY.get(env.GATEWAY.idFromName("main"));

export const gatewayFetch = (
  env: WorkerEnv,
  path: (typeof GATEWAY_PATH)[keyof typeof GATEWAY_PATH],
  method = "GET",
): Promise<Response> =>
  gatewayStub(env).fetch(new Request(`${DO_ORIGIN}${path}`, { method }));
