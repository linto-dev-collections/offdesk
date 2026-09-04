import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/*
  offdesk 所有の表（テーブル定義書 §4）。**あちらが正本**で、生成された SQL が
  食い違ったら直すのはこちら側。

  P2 の 3 表と P3a の `asks` を置く。`events` / `inbox` / `plans` は
  それぞれのフェーズで足す（先に作ると使われない表が残る）。

  **`ON DELETE CASCADE` を 1 つも書かない**（テーブル定義書 §3-4）。D1 の
  `PRAGMA defer_foreign_keys` は検査を遅らせるだけで CASCADE の発火を止めないので、
  表を作り直すマイグレーションが子行を黙って消す。
*/

const createdAt = integer("created_at", { mode: "timestamp_ms" })
  .notNull()
  .default(sql`(unixepoch('subsec') * 1000)`);

const updatedAt = integer("updated_at", { mode: "timestamp_ms" })
  .notNull()
  .default(sql`(unixepoch('subsec') * 1000)`)
  .$onUpdate(() => new Date());

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    discordChannelId: text("discord_channel_id").notNull(),
    repoUrl: text("repo_url").notNull(),
    fireUrl: text("fire_url").notNull(),
    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
    createdAt,
    updatedAt,
  },
  (t) => [
    /*
      **`GLOB '[a-z0-9][a-z0-9_-]*'` では縛れない。** 末尾の `*` が任意の文字列に
      当たるので、あの形が見ているのは**先頭 2 文字だけ**（実測: `'off desk'` が通る。
      2026-09-04）。SQLite の GLOB に `+` や `{n}` は無いので、
      **「集合の外の文字が 1 つも無い」を否定クラスで書く。**

        'off desk'   GLOB '[a-z0-9][a-z0-9_-]*'  => 1  ← 通ってしまう
        'off desk'   GLOB '*[^a-z0-9_-]*'        => 1  ← 悪い文字を捕まえる
        'off-desk_1' GLOB '*[^a-z0-9_-]*'        => 0
        'Offdesk'    GLOB '[a-z0-9]*'            => 0  ← 先頭は別に見る
    */
    check(
      "projects_name_shape_ck",
      sql`${t.name} GLOB '[a-z0-9]*'
       AND ${t.name} NOT GLOB '*[^a-z0-9_-]*'
       AND length(${t.name}) <= 32`,
    ),
    /*
      `NOT GLOB` は空文字を通す（`'' GLOB '*[^0-9]*'` => 0）ので、
      **長さの検査と対で使う。**
    */
    check(
      "projects_channel_shape_ck",
      sql`${t.discordChannelId} NOT GLOB '*[^0-9]*'
       AND length(${t.discordChannelId}) BETWEEN 15 AND 24`,
    ),
    check("projects_repo_url_ck", sql`${t.repoUrl} LIKE 'https://%'`),
    /*
      **fire_url はホストまで固定する**（plans/security.md 脅威 3 の 1 層目）。
      この URL は fire トークンを Authorization ヘッダに載せて POST する宛先なので、
      値が別ホストに変わるとそのまま資格情報の持ち出しになる。
    */
    check(
      "projects_fire_url_ck",
      sql`${t.fireUrl} LIKE 'https://api.anthropic.com/%'`,
    ),
    uniqueIndex("projects_name_uidx").on(t.name),
    uniqueIndex("projects_channel_uidx").on(t.discordChannelId),
  ],
);

export const projectFireCredentials = sqliteTable(
  "project_fire_credentials",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    ciphertext: blob("ciphertext", { mode: "buffer" }).notNull(),
    iv: blob("iv", { mode: "buffer" }).notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    last4: text("last4").notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    // AES-GCM の nonce は 12 バイト。長さが違えば暗号化の実装が壊れている。
    check("pfc_iv_len_ck", sql`length(${t.iv}) = 12`),
    check("pfc_ciphertext_ck", sql`length(${t.ciphertext}) > 0`),
    check("pfc_key_version_ck", sql`${t.keyVersion} >= 1`),
    check("pfc_last4_ck", sql`length(${t.last4}) = 4`),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    runKey: text("run_key").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    prompt: text("prompt").notNull(),
    status: text("status").notNull().default("queued"),
    requesterDiscordUserId: text("requester_discord_user_id").notNull(),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id"),
    ccSessionId: text("cc_session_id"),
    ccSessionUrl: text("cc_session_url"),
    heldAt: integer("held_at", { mode: "timestamp_ms" }),
    activityAt: integer("activity_at", { mode: "timestamp_ms" }),
    ctxUsedTokens: integer("ctx_used_tokens"),
    ctxOutputTokens: integer("ctx_output_tokens"),
    ctxAt: integer("ctx_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    failureReason: text("failure_reason"),
    createdAt,
    updatedAt,
  },
  (t) => [
    /*
      **`GLOB 'OFFDESK-[0-9a-f]*'` は 9 文字目しか見ていない**（末尾の `*` が
      残りを全部飲む。実測: `'OFFDESK-0123456789ABCDEF'` が通る）。
      接頭辞・長さ・**残り 16 文字が小文字 16 進であること**を 3 つに分けて書く。
    */
    check(
      "runs_key_shape_ck",
      sql`${t.runKey} GLOB 'OFFDESK-*'
       AND substr(${t.runKey}, 9) NOT GLOB '*[^0-9a-f]*'
       AND length(${t.runKey}) = 24`,
    ),
    check(
      "runs_status_ck",
      sql`${t.status} IN ('queued', 'running', 'waiting', 'done', 'failed', 'abandoned')`,
    ),
    check("runs_prompt_ck", sql`length(${t.prompt}) > 0`),
    /*
      **スレッド id に空文字を入れさせない。** 要件 F-A7 は「作れなかった run の
      thread_id は空」と定めているが、空文字を入れると findByThread('') が
      当たりうる形になる。NULL だけを「無い」とする。
    */
    check(
      "runs_thread_id_ck",
      sql`${t.threadId} IS NULL OR length(${t.threadId}) > 0`,
    ),
    check(
      "runs_cc_pair_ck",
      sql`(${t.ccSessionId} IS NULL) = (${t.ccSessionUrl} IS NULL)`,
    ),
    check(
      "runs_ctx_pair_ck",
      sql`(${t.ctxAt} IS NULL) = (${t.ctxUsedTokens} IS NULL)`,
    ),
    check(
      "runs_ctx_sign_ck",
      sql`(${t.ctxUsedTokens} IS NULL OR ${t.ctxUsedTokens} >= 0)
       AND (${t.ctxOutputTokens} IS NULL OR ${t.ctxOutputTokens} >= 0)`,
    ),
    check(
      "runs_finished_ck",
      sql`(${t.status} IN ('done', 'failed', 'abandoned')) = (${t.finishedAt} IS NOT NULL)`,
    ),
    check(
      "runs_failure_reason_ck",
      sql`${t.failureReason} IS NULL OR ${t.status} IN ('failed', 'abandoned')`,
    ),
    /*
      **1 スレッドに生きている run は 1 本だけ**（要件 I-13）。
      要件 F-C6 の「起こしすぎ（2 本立つ）は取り返せない」側を D1 に止めさせる。
      起こし直しの経路は「前を abandoned にする UPDATE」と「新しい INSERT」を
      1 つの batch に入れなければ通らなくなる（P4）。
    */
    uniqueIndex("runs_live_thread_uidx")
      .on(t.threadId)
      .where(
        sql`${t.threadId} IS NOT NULL AND ${t.status} IN ('queued', 'running', 'waiting')`,
      ),
    index("runs_status_created_idx").on(t.status, t.createdAt),
    index("runs_thread_created_idx")
      .on(t.threadId, t.createdAt)
      .where(sql`${t.threadId} IS NOT NULL`),
    index("runs_project_created_idx").on(t.projectId, t.createdAt),
  ],
);

export const asks = sqliteTable(
  "asks",
  {
    askId: text("ask_id").primaryKey(),
    runKey: text("run_key")
      .notNull()
      .references(() => runs.runKey, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    question: text("question").notNull(),
    /*
      **選択肢は「JSON の配列であること」だけを縛る**（テーブル定義書 §4-4）。
      中身の検証（各要素が非空で Discord のボタンの上限内か）は
      `packages/domain/src/ask.ts` の `validateAsk` が持つ。ここで要素まで見ると
      同じ規則が 2 か所に散る。
    */
    options: text("options").notNull().default("[]"),
    allowFreeText: integer("allow_free_text").notNull().default(1),
    messageId: text("message_id"),
    answer: text("answer"),
    answeredByDiscordUserId: text("answered_by_discord_user_id"),
    answeredAt: integer("answered_at", { mode: "timestamp_ms" }),
    answerMessageId: text("answer_message_id"),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
    createdAt,
  },
  (t) => [
    /*
      **テーブル定義書 §4-4 の `GLOB 'ask_[0-9a-f]*'` は 5 文字目しか見ていない**
      （末尾の `*` が残りを全部飲む。§4-1・§4-3 で直したのと同じ欠陥で、
      §4-4 だけ直し漏れていた。2026-09-04 に D1 で実測）:

        'ask_0ABCDEFGHIJKLMNO' GLOB 'ask_[0-9a-f]*'              => 1  ← 通ってしまう
        substr('ask_0ABCDEFGHIJKLMNO', 5) NOT GLOB '*[^0-9a-f]*' => 0  ← 捕まえられる

      GLOB では `_` はリテラル（LIKE と違って 1 文字のワイルドカードにならない）ので、
      接頭辞は `'ask_*'` でそのまま書ける（実測: `'askX…' GLOB 'ask_*'` => 0）。
    */
    check(
      "asks_id_shape_ck",
      sql`${t.askId} GLOB 'ask_*'
       AND substr(${t.askId}, 5) NOT GLOB '*[^0-9a-f]*'
       AND length(${t.askId}) = 20`,
    ),
    check("asks_question_ck", sql`length(${t.question}) > 0`),
    check(
      "asks_options_ck",
      sql`json_valid(${t.options}) AND json_type(${t.options}) = 'array'`,
    ),
    check("asks_allow_free_text_ck", sql`${t.allowFreeText} IN (0, 1)`),
    // 回答と回答時刻は対で埋まる。片方だけ立つと、未回答の問いに答えがある形になる。
    check(
      "asks_answer_pair_ck",
      sql`(${t.answer} IS NULL) = (${t.answeredAt} IS NULL)`,
    ),
    check(
      "asks_answered_by_ck",
      sql`${t.answeredByDiscordUserId} IS NULL OR ${t.answer} IS NOT NULL`,
    ),
    check(
      "asks_answer_message_ck",
      sql`${t.answerMessageId} IS NULL OR ${t.answer} IS NOT NULL`,
    ),
    /*
      **「返せた」は「答えがある」を含む**（要件 `I-3`・`F-B3`）。
      `delivered_at` が `answered_at` より先に立つと、答えが宙に浮いたまま
      「渡した」ことになる。kanata で実際に 1 つ失われたのがこの形。
    */
    check(
      "asks_delivered_ck",
      sql`${t.deliveredAt} IS NULL OR ${t.answeredAt} IS NOT NULL`,
    ),
    index("asks_run_created_idx").on(t.runKey, t.createdAt),
    /*
      **未配達の問いを、いちばん新しいものから拾う**（要件 `F-B3`。使うのは P3b）。
      部分索引なので配達済みの行は索引に入らず、履歴が増えても太らない。
    */
    index("asks_undelivered_idx")
      .on(t.runKey, t.createdAt)
      .where(sql`${t.deliveredAt} IS NULL`),
    /*
      **同じ Discord メッセージから 2 つの問いを作らない。**
      SQLite の UNIQUE 索引は NULL を重複と見ないので、「まだ出していない」行は
      何行でも置ける。
    */
    uniqueIndex("asks_message_uidx").on(t.messageId),
  ],
);

export const events = sqliteTable(
  "events",
  {
    /*
      **AUTOINCREMENT を明示する**（テーブル定義書 §4-5）。素の
      `INTEGER PRIMARY KEY` は rowid の再利用を許すので、消した行の id が
      後の行に付きうる —— この表は run 詳細の時系列そのものなので、
      id の単調増加が「順序」を供給している（`events_run_id_idx` がそれを使う）。
    */
    id: integer("id").primaryKey({ autoIncrement: true }),
    runKey: text("run_key")
      .notNull()
      .references(() => runs.runKey, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    discordMessageId: text("discord_message_id"),
    createdAt,
  },
  (t) => [
    check(
      "events_kind_ck",
      sql`${t.kind} IN ('progress', 'done', 'blocked', 'stop_hook', 'error')`,
    ),
    index("events_run_id_idx").on(t.runKey, t.id),
  ],
);
