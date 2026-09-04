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
    ctxModel: text("ctx_model"),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    failureReason: text("failure_reason"),
    createdAt,
    updatedAt,
  },
  (t) => [
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
      "runs_ctx_model_ck",
      sql`${t.ctxModel} IS NULL OR length(${t.ctxModel}) > 0`,
    ),
    check(
      "runs_finished_ck",
      sql`(${t.status} IN ('done', 'failed', 'abandoned')) = (${t.finishedAt} IS NOT NULL)`,
    ),
    check(
      "runs_failure_reason_ck",
      sql`${t.failureReason} IS NULL OR ${t.status} IN ('failed', 'abandoned')`,
    ),
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
    check(
      "asks_delivered_ck",
      sql`${t.deliveredAt} IS NULL OR ${t.answeredAt} IS NOT NULL`,
    ),
    index("asks_run_created_idx").on(t.runKey, t.createdAt),
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

export const inbox = sqliteTable(
  "inbox",
  {
    /** `events` と同じ理由で AUTOINCREMENT（テーブル定義書 §4-6）。id の順が届いた順。 */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** **届いた時点で生きていた run。** 実際に渡った run は `taken_by_run_key`。 */
    runKey: text("run_key")
      .notNull()
      .references(() => runs.runKey, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    authorDiscordUserId: text("author_discord_user_id").notNull(),
    messageId: text("message_id"),
    body: text("body").notNull(),
    takenAt: integer("taken_at", { mode: "timestamp_ms" }),
    takenByRunKey: text("taken_by_run_key").references(() => runs.runKey, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    createdAt,
  },
  (t) => [
    check("inbox_body_ck", sql`length(${t.body}) > 0`),
    check(
      "inbox_taken_pair_ck",
      sql`(${t.takenAt} IS NULL) = (${t.takenByRunKey} IS NULL)`,
    ),
    /*
      **未処理の文をまとめて読む**（要件 `F-C2` の「溜める」）。
      部分索引なので、渡し終わった行は索引から落ちる。溜まっているのは常に数件。
    */
    index("inbox_pending_idx")
      .on(t.runKey, t.id)
      .where(sql`${t.takenAt} IS NULL`),
    uniqueIndex("inbox_message_uidx").on(t.messageId),
    index("inbox_taken_by_idx")
      .on(t.takenByRunKey)
      .where(sql`${t.takenByRunKey} IS NOT NULL`),
  ],
);

export const plans = sqliteTable(
  "plans",
  {
    planId: text("plan_id").primaryKey(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    slug: text("slug").notNull(),
    /** **FK**。最後に置き直した run（テーブル定義書 §4-7）。 */
    lastPublishedRunKey: text("last_published_run_key")
      .notNull()
      .references(() => runs.runKey, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    fileCount: integer("file_count").notNull().default(0),
    totalBytes: integer("total_bytes").notNull().default(0),
    createdAt,
    updatedAt,
  },
  (t) => [
    check(
      "plans_id_shape_ck",
      sql`${t.planId} NOT GLOB '*[^0-9a-f]*' AND length(${t.planId}) = 32`,
    ),
    check("plans_scope_kind_ck", sql`${t.scopeKind} IN ('thread', 'run')`),
    check("plans_scope_id_ck", sql`length(${t.scopeId}) > 0`),
    check(
      "plans_slug_shape_ck",
      sql`${t.slug} GLOB '[a-z0-9]*'
       AND ${t.slug} NOT GLOB '*[^a-z0-9_-]*'
       AND length(${t.slug}) <= 64`,
    ),
    check("plans_counts_ck", sql`${t.fileCount} >= 0 AND ${t.totalBytes} >= 0`),
    uniqueIndex("plans_scope_slug_uidx").on(t.scopeKind, t.scopeId, t.slug),
    index("plans_updated_idx").on(t.updatedAt),
  ],
);
