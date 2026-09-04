import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedProject } from "./support.ts";

/*
  **DDL の制約が「書いたら効いている」ことを確かめる**（テーブル定義書 §3-5・要件 `V-9`）。

  CHECK は書いた瞬間は効いているように見える。壊れるのは
  「drizzle が生成した SQL が D1 で通らなかった」「WHERE 付き索引が無視された」
  ときで、**それは流すまで分からない。** ここが緑である限り、アプリのバグで
  壊れた形の行は保存されない。
*/

const insertProject = (values: Record<string, unknown>) =>
  env.DB.prepare(
    `INSERT INTO projects (id, name, discord_channel_id, repo_url, fire_url)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      values.id ?? "p1",
      values.name ?? "offdesk-test",
      values.discord_channel_id ?? "111111111111111111",
      values.repo_url ?? "https://github.com/x/y",
      values.fire_url ??
        "https://api.anthropic.com/v1/claude_code/routines/trig_a/fire",
    )
    .run();

describe("projects の CHECK", () => {
  it.each([
    ["name が大文字", { name: "Offdesk" }],
    ["name が記号入り", { name: "off desk" }],
    ["name が 33 文字", { name: "a".repeat(33) }],
    ["channel が数字でない", { discord_channel_id: "11111111111111x" }],
    ["channel が短すぎる", { discord_channel_id: "11111111111111" }],
    ["repo_url が http", { repo_url: "http://github.com/x/y" }],
  ])("%s は入らない", async (_label, values) => {
    await expect(insertProject(values)).rejects.toThrow();
  });

  /*
    plans/security.md 脅威 3 の 1 層目。**別ホストの fire_url を台帳に入れさせない。**
    ここが緩いと、直接 SQL で書き換えるだけで資格情報の宛先を変えられる。
  */
  it.each([
    ["別ホスト", "https://evil.example.com/v1/fire"],
    ["1 文字違い", "https://api.anthropic.co/v1/fire"],
    ["サブドメイン", "https://evil.api.anthropic.com/v1/fire"],
    ["http", "http://api.anthropic.com/v1/fire"],
    ["前に付ける", "https://x.example/https://api.anthropic.com/v1/fire"],
  ])("fire_url が %s なら入らない", async (_label, fire_url) => {
    await expect(insertProject({ fire_url })).rejects.toThrow();
  });

  it("正しい値は入る", async () => {
    await expect(insertProject({})).resolves.toBeDefined();
  });

  it("同じ name は 2 つ入らない", async () => {
    await insertProject({
      id: "p1",
      name: "same",
      discord_channel_id: "111111111111111111",
    });

    await expect(
      insertProject({
        id: "p2",
        name: "same",
        discord_channel_id: "222222222222222222",
      }),
    ).rejects.toThrow();
  });

  /** 要件 `F-H4`。同じチャンネルに 2 つ紐付くと行き先が決まらない。 */
  it("同じ discord_channel_id は 2 つ入らない", async () => {
    await insertProject({
      id: "p1",
      name: "one",
      discord_channel_id: "111111111111111111",
    });

    await expect(
      insertProject({
        id: "p2",
        name: "two",
        discord_channel_id: "111111111111111111",
      }),
    ).rejects.toThrow();
  });
});

describe("project_fire_credentials の CHECK", () => {
  const insertCredential = (values: Record<string, unknown>) =>
    env.DB.prepare(
      `INSERT INTO project_fire_credentials (project_id, ciphertext, iv, key_version, last4)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        values.project_id ?? "p1",
        values.ciphertext ?? new Uint8Array([1, 2, 3]),
        values.iv ?? new Uint8Array(12),
        values.key_version ?? 1,
        values.last4 ?? "aB3x",
      )
      .run();

  it.each([
    ["iv が 11 バイト", { iv: new Uint8Array(11) }],
    ["iv が 13 バイト", { iv: new Uint8Array(13) }],
    ["ciphertext が空", { ciphertext: new Uint8Array(0) }],
    ["key_version が 0", { key_version: 0 }],
    ["last4 が 3 文字", { last4: "abc" }],
    ["last4 が 5 文字", { last4: "abcde" }],
  ])("%s は入らない", async (_label, values) => {
    await insertProject({});
    await expect(insertCredential(values)).rejects.toThrow();
  });

  /** テーブル定義書 §3-4。**親が無い子行を入れさせない**（RESTRICT）。 */
  it("居ないプロジェクトの資格情報は入らない", async () => {
    await expect(insertCredential({ project_id: "ghost" })).rejects.toThrow();
  });

  /** `CASCADE` を 1 つも書いていないので、親を消そうとすると止まる。 */
  it("資格情報が残っているプロジェクトは消せない", async () => {
    await seedProject({
      name: "offdesk-test",
      discordChannelId: "111111111111111111",
    });

    await expect(
      env.DB.prepare("DELETE FROM projects").run(),
    ).rejects.toThrow();
  });
});

describe("runs の CHECK", () => {
  const RUN_KEY = "OFFDESK-0123456789abcdef";

  const insertRun = (values: Record<string, unknown>) =>
    env.DB.prepare(
      `INSERT INTO runs (run_key, project_id, prompt, status, requester_discord_user_id, channel_id, thread_id, cc_session_id, cc_session_url, finished_at, failure_reason, ctx_at, ctx_used_tokens, ctx_output_tokens, ctx_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        values.run_key ?? RUN_KEY,
        values.project_id ?? "p1",
        values.prompt ?? "READMEを直す",
        values.status ?? "queued",
        values.requester_discord_user_id ?? "111111111111111111",
        values.channel_id ?? "111111111111111111",
        values.thread_id ?? null,
        values.cc_session_id ?? null,
        values.cc_session_url ?? null,
        values.finished_at ?? null,
        values.failure_reason ?? null,
        values.ctx_at ?? null,
        values.ctx_used_tokens ?? null,
        values.ctx_output_tokens ?? null,
        // **`??` で既定に倒さない列**（明示の NULL を渡せなくなる。P4 の §2-3）。
        "ctx_model" in values ? values.ctx_model : null,
      )
      .run();

  it.each([
    ["run_key の接頭辞が違う", { run_key: "KANATA-0123456789abcdef" }],
    ["run_key が短い", { run_key: "OFFDESK-0123456789abcde" }],
    ["run_key に大文字 16 進", { run_key: "OFFDESK-0123456789ABCDEF" }],
    ["知らない status", { status: "zombie" }],
    ["prompt が空", { prompt: "" }],
    ["thread_id が空文字", { thread_id: "" }],
    ["cc の片方だけ", { cc_session_id: "session_01" }],
    ["cc の片方だけ（URL）", { cc_session_url: "https://claude.ai/x" }],
    ["done なのに finished_at が無い", { status: "done" }],
    ["queued なのに finished_at がある", { finished_at: 1 }],
    ["running に failure_reason", { failure_reason: "だめ" }],
    ["ctx の片方だけ", { ctx_used_tokens: 100 }],
    ["ctx が負", { ctx_at: 1, ctx_used_tokens: -1 }],
    ["ctx_output_tokens が負", { ctx_output_tokens: -1 }],
    ["ctx_model が空文字", { ctx_model: "" }],
  ])("%s は入らない", async (_label, values) => {
    await insertProject({});
    await expect(insertRun(values)).rejects.toThrow();
  });

  /*
    **通る値と対で見る**（P2 §9-2 の教訓。通る値だけだと制約が何も見ていなくても緑）。
    `ctx_model` は**対の CHECK に入っていない**ので、分子だけが入った行も入る ——
    `.message.usage` があって `.message.model` が無い転写ログの行のため（P5）。
  */
  it.each([
    ["ctx が対で入る", { ctx_at: 1, ctx_used_tokens: 0 }],
    [
      "ctx_model つき",
      { ctx_at: 1, ctx_used_tokens: 100, ctx_model: "claude-opus-5" },
    ],
    ["ctx_model だけ NULL", { ctx_at: 1, ctx_used_tokens: 100 }],
    ["ctx_model だけあって分子が無い", { ctx_model: "claude-opus-5" }],
  ])("%s は入る", async (_label, values) => {
    await insertProject({});
    await expect(insertRun(values)).resolves.toBeDefined();
  });

  it("居ないプロジェクトの run は入らない", async () => {
    await expect(insertRun({ project_id: "ghost" })).rejects.toThrow();
  });

  /*
    要件 `I-13`。**1 スレッドに生きている run は 1 本だけ。**
    要件 `F-C6` が「起こしすぎ（2 本立つ）は取り返せない」と書いている側を D1 が止める。
  */
  it("同じスレッドに生きている run を 2 本作れない", async () => {
    await insertProject({});
    await insertRun({ run_key: RUN_KEY, thread_id: "333333333333333333" });

    await expect(
      insertRun({
        run_key: "OFFDESK-fedcba9876543210",
        thread_id: "333333333333333333",
      }),
    ).rejects.toThrow();
  });

  /** 畳んだ run のスレッドには次の run を作れる（部分索引の WHERE が効いている）。 */
  it("前の run が done なら同じスレッドに 2 本目を作れる", async () => {
    await insertProject({});
    await insertRun({
      run_key: RUN_KEY,
      thread_id: "333333333333333333",
      status: "done",
      finished_at: 1_788_427_539_205,
    });

    await expect(
      insertRun({
        run_key: "OFFDESK-fedcba9876543210",
        thread_id: "333333333333333333",
      }),
    ).resolves.toBeDefined();
  });

  it("thread_id が NULL なら何本でも作れる（要件 F-A7 の run が並ぶ）", async () => {
    await insertProject({});
    await insertRun({ run_key: RUN_KEY });

    await expect(
      insertRun({ run_key: "OFFDESK-fedcba9876543210" }),
    ).resolves.toBeDefined();
  });
});

describe("asks の CHECK", () => {
  const RUN_KEY = "OFFDESK-0123456789abcdef";
  const ASK_ID = "ask_0123456789abcdef";

  const insertAskRow = (values: Record<string, unknown>) =>
    env.DB.prepare(
      `INSERT INTO asks (ask_id, run_key, question, options, allow_free_text, message_id,
                         answer, answered_by_discord_user_id, answered_at,
                         answer_message_id, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        values.ask_id ?? ASK_ID,
        values.run_key ?? RUN_KEY,
        values.question ?? "この方針で進めてよいですか",
        values.options ?? '["はい","やめる"]',
        values.allow_free_text ?? 1,
        values.message_id ?? null,
        values.answer ?? null,
        values.answered_by_discord_user_id ?? null,
        values.answered_at ?? null,
        values.answer_message_id ?? null,
        values.delivered_at ?? null,
      )
      .run();

  const seed = async (): Promise<void> => {
    await insertProject({});
    await env.DB.prepare(
      `INSERT INTO runs (run_key, project_id, prompt, requester_discord_user_id, channel_id)
       VALUES (?, 'p1', 'ping', '111111111111111111', '111111111111111111')`,
    )
      .bind(RUN_KEY)
      .run();
  };

  /*
    **テーブル定義書 §4-4 の `asks_id_shape_ck` には §4-1・§4-3 と同じ欠陥があった**
    （`GLOB 'ask_[0-9a-f]*'` の末尾の `*` が残りを全部飲むので、見ているのは 5 文字目だけ）。
    2026-09-04 に D1 で実測して直した。**下の 2 行目がその probe。**

      'ask_0ABCDEFGHIJKLMNO' GLOB 'ask_[0-9a-f]*'  => 1  ← 直す前は通っていた
  */
  it.each([
    ["ask_id の接頭辞が違う", { ask_id: "run_0123456789abcdef" }],
    ["ask_id に大文字 16 進", { ask_id: "ask_0ABCDEFGHIJKLMNO" }],
    ["ask_id が短い", { ask_id: "ask_0123456789abcde" }],
    ["ask_id が長い", { ask_id: "ask_0123456789abcdef0" }],
    ["ask_id が 16 進でない", { ask_id: "ask_0123456789abcdeg" }],
    ["question が空", { question: "" }],
    ["options が JSON でない", { options: "はい,やめる" }],
    ["options が配列でない（オブジェクト）", { options: '{"a":1}' }],
    ["options が配列でない（文字列）", { options: '"はい"' }],
    ["options が配列でない（数）", { options: "1" }],
    ["allow_free_text が 0/1 でない", { allow_free_text: 2 }],
    ["allow_free_text が負", { allow_free_text: -1 }],
    ["answer だけ（時刻が無い）", { answer: "はい" }],
    ["answered_at だけ（答えが無い）", { answered_at: 1 }],
    ["回答者だけ（答えが無い）", { answered_by_discord_user_id: "1" }],
    ["回答元メッセージだけ（答えが無い）", { answer_message_id: "1" }],
    ["delivered_at だけ（答えが無い）", { delivered_at: 1 }],
  ])("%s は入らない", async (_label, values) => {
    await seed();
    await expect(insertAskRow(values)).rejects.toThrow();
  });

  it("正しい値は入る", async () => {
    await seed();
    await expect(insertAskRow({})).resolves.toBeDefined();
  });

  it("空配列の options は入る（DDL は要素まで見ない）", async () => {
    // 要素の検査は `validateAsk` が持つ（テーブル定義書 §4-4 の判断）。
    await seed();
    await expect(insertAskRow({ options: "[]" })).resolves.toBeDefined();
  });

  it("答えと時刻が揃っていれば入る", async () => {
    await seed();
    await expect(
      insertAskRow({
        answer: "はい",
        answered_at: 1_788_427_539_205,
        answered_by_discord_user_id: "111111111111111111",
      }),
    ).resolves.toBeDefined();
  });

  /*
    要件 `I-3`・`F-B3`。**「返せた」は「答えがある」を含む。**
    逆順に立つと、答えが宙に浮いたまま「渡した」ことになる
    （kanata で実際に 1 つ失われたのがこの形）。
  */
  it("答えがあれば delivered_at も入る", async () => {
    await seed();
    await expect(
      insertAskRow({
        answer: "はい",
        answered_at: 1_788_427_539_205,
        delivered_at: 1_788_427_539_300,
      }),
    ).resolves.toBeDefined();
  });

  it("居ない run の ask は入らない", async () => {
    await seed();
    await expect(
      insertAskRow({ run_key: "OFFDESK-ffffffffffffffff" }),
    ).rejects.toThrow();
  });

  /*
    **同じ Discord メッセージから 2 つの問いを作らない**（`asks_message_uidx`）。
    SQLite の UNIQUE 索引は NULL を重複と見ないので、
    「まだ出していない」行は何行でも置ける。
  */
  it("同じ message_id の ask は 2 つ入らない", async () => {
    await seed();
    await insertAskRow({ message_id: "555555555555555555" });

    await expect(
      insertAskRow({
        ask_id: "ask_fedcba9876543210",
        message_id: "555555555555555555",
      }),
    ).rejects.toThrow();
  });

  it("message_id が NULL なら何行でも入る", async () => {
    await seed();
    await insertAskRow({});

    await expect(
      insertAskRow({ ask_id: "ask_fedcba9876543210" }),
    ).resolves.toBeDefined();
  });

  /** FK は RESTRICT。**run を消して ask だけ残る形を作らない**（テーブル定義書 §3-4）。 */
  it("ask が残っている run は消せない", async () => {
    await seed();
    await insertAskRow({});

    await expect(
      env.DB.prepare("DELETE FROM runs WHERE run_key = ?").bind(RUN_KEY).run(),
    ).rejects.toThrow();
  });
});

describe("events の CHECK", () => {
  const RUN_KEY = "OFFDESK-0123456789abcdef";

  const insertEventRow = (values: Record<string, unknown>) =>
    env.DB.prepare(
      `INSERT INTO events (run_key, kind, body, discord_message_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(
        values.run_key ?? RUN_KEY,
        values.kind ?? "progress",
        values.body ?? "進めています",
        values.discord_message_id ?? null,
      )
      .run();

  const seed = async (): Promise<void> => {
    await insertProject({});
    await env.DB.prepare(
      `INSERT INTO runs (run_key, project_id, prompt, requester_discord_user_id, channel_id)
       VALUES (?, 'p1', 'ping', '111111111111111111', '111111111111111111')`,
    )
      .bind(RUN_KEY)
      .run();
  };

  it.each([
    ["知らない kind", { kind: "zombie" }],
    ["大文字の kind", { kind: "PROGRESS" }],
    ["空の kind", { kind: "" }],
  ])("%s は入らない", async (_label, values) => {
    await seed();
    await expect(insertEventRow(values)).rejects.toThrow();
  });

  /** DDL の一覧は 5 種。**Claude が出せるのはそのうち 3 種**（`validateReport`）。 */
  it.each(["progress", "done", "blocked", "stop_hook", "error"])(
    "kind が %s なら入る",
    async (kind) => {
      await seed();
      await expect(insertEventRow({ kind })).resolves.toBeDefined();
    },
  );

  it("居ない run の event は入らない", async () => {
    await seed();
    await expect(
      insertEventRow({ run_key: "OFFDESK-ffffffffffffffff" }),
    ).rejects.toThrow();
  });

  /*
    **`body` に長さの上限を置いていない**（テーブル定義書 §4-5）。
    Discord の上限は `validateReport` が持ち、`stop_hook`（P5）と `error`（P8）は
    offdesk 自身が書くので、DDL で縛ると内部の記録が落ちる。
  */
  it("空の body は入る（長さは DDL で縛らない）", async () => {
    await seed();
    await expect(insertEventRow({ body: "" })).resolves.toBeDefined();
  });

  /*
    **id は消した行の番号を再利用しない**（`AUTOINCREMENT`）。
    この表は run 詳細の時系列そのもので、**id の単調増加が「起きた順」を供給する**
    （`events_run_id_idx`）。再利用されると、消した後の行が昔の位置に並ぶ。
  */
  it("行を消しても id が戻らない", async () => {
    await seed();
    await insertEventRow({ body: "1 本目" });
    const first = await env.DB.prepare(
      "SELECT MAX(id) AS id FROM events",
    ).first<{
      id: number;
    }>();

    await env.DB.prepare("DELETE FROM events").run();
    await insertEventRow({ body: "2 本目" });
    const second = await env.DB.prepare(
      "SELECT MAX(id) AS id FROM events",
    ).first<{
      id: number;
    }>();

    expect(second?.id ?? 0).toBeGreaterThan(first?.id ?? 0);
  });

  /** FK は RESTRICT。**run を消して event だけ残る形を作らない。** */
  it("event が残っている run は消せない", async () => {
    await seed();
    await insertEventRow({});

    await expect(
      env.DB.prepare("DELETE FROM runs WHERE run_key = ?").bind(RUN_KEY).run(),
    ).rejects.toThrow();
  });
});

describe("inbox の CHECK と索引", () => {
  const RUN_KEY = "OFFDESK-0123456789abcdef";
  const OTHER_RUN_KEY = "OFFDESK-fedcba9876543210";

  const insertInboxRow = (values: Record<string, unknown>) =>
    env.DB.prepare(
      `INSERT INTO inbox (run_key, author_discord_user_id, message_id, body,
                          taken_at, taken_by_run_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        values.run_key ?? RUN_KEY,
        values.author_discord_user_id ?? "111111111111111111",
        /*
          **`??` では「明示の NULL」を渡せない**（計画 README §2-3 の「無い」を
          `undefined` で表さない、の裏返し）。`null ?? 既定` は既定になるので、
          `message_id: null` を渡したのに 2 行目が既定の id で衝突した（実測）。
          キーの有無で分ける。
        */
        "message_id" in values ? values.message_id : "777777777777777777",
        values.body ?? "つづきをお願い",
        values.taken_at ?? null,
        values.taken_by_run_key ?? null,
      )
      .run();

  const seed = async (): Promise<void> => {
    await insertProject({});
    for (const runKey of [RUN_KEY, OTHER_RUN_KEY]) {
      await env.DB.prepare(
        `INSERT INTO runs (run_key, project_id, prompt, requester_discord_user_id, channel_id, thread_id, status, finished_at)
         VALUES (?, 'p1', 'ping', '111111111111111111', '111111111111111111', ?, 'done', 1)`,
      )
        .bind(runKey, `44444444444444444${runKey.slice(-1)}`)
        .run();
    }
  };

  it("素直な形は入る", async () => {
    await seed();
    await expect(insertInboxRow({})).resolves.toBeDefined();
  });

  it("空の body は入らない", async () => {
    await seed();
    await expect(insertInboxRow({ body: "" })).rejects.toThrow();
  });

  /*
    **「渡した時刻」と「渡した先」は対で埋まる**（`inbox_taken_pair_ck`）。
    片方だけ立つと要件 `I-3` の印（👀 → ✅）が嘘になる ——
    渡した先が分からないまま「渡した」と言うことになる。
  */
  it.each([
    ["時刻だけ", { taken_at: 1_788_600_000_000 }],
    ["渡した先だけ", { taken_by_run_key: OTHER_RUN_KEY }],
  ])("印が %s なら入らない", async (_label, values) => {
    await seed();
    await expect(insertInboxRow(values)).rejects.toThrow();
  });

  it("時刻と渡した先が揃っていれば入る", async () => {
    await seed();
    await expect(
      insertInboxRow({
        taken_at: 1_788_600_000_000,
        taken_by_run_key: OTHER_RUN_KEY,
      }),
    ).resolves.toBeDefined();
  });

  /*
    **同じ Discord メッセージを 2 回積まない**（`inbox_message_uidx`）。
    Gateway は再接続時にイベントを再送しうる（resume の仕様）ので、
    **冪等性は D1 が担保する** —— アプリ側の記憶に頼ると isolate の入れ替わりで破れる。
  */
  it("同じ message_id は 2 行入らない", async () => {
    await seed();
    await insertInboxRow({});

    await expect(insertInboxRow({})).rejects.toThrow();
  });

  /*
    **SQLite の UNIQUE 索引は NULL を重複と見ない。**
    コマンド経由で元メッセージが無い行（テーブル定義書 §4-6）は何行でも置ける。
  */
  it("message_id が NULL の行は何行でも入る", async () => {
    await seed();

    await expect(insertInboxRow({ message_id: null })).resolves.toBeDefined();
    await expect(insertInboxRow({ message_id: null })).resolves.toBeDefined();
  });

  it("別の run なら同じ本文でも入る", async () => {
    await seed();
    await insertInboxRow({});

    await expect(
      insertInboxRow({
        run_key: OTHER_RUN_KEY,
        message_id: "777777777777777778",
      }),
    ).resolves.toBeDefined();
  });

  it("居ない run には積めない", async () => {
    await seed();
    await expect(
      insertInboxRow({ run_key: "OFFDESK-aaaaaaaaaaaaaaaa" }),
    ).rejects.toThrow();
  });

  it("居ない run へは渡せない（taken_by_run_key も FK）", async () => {
    await seed();
    await expect(
      insertInboxRow({
        taken_at: 1_788_600_000_000,
        taken_by_run_key: "OFFDESK-aaaaaaaaaaaaaaaa",
      }),
    ).rejects.toThrow();
  });

  /** FK は RESTRICT。**run を消して inbox だけ残る形を作らない。** */
  it("行が残っている run は消せない", async () => {
    await seed();
    await insertInboxRow({});

    await expect(
      env.DB.prepare("DELETE FROM runs WHERE run_key = ?").bind(RUN_KEY).run(),
    ).rejects.toThrow();
  });

  /*
    **未処理の文をまとめて読むのに部分索引が選ばれること**
    （`inbox_pending_idx`。テーブル定義書 付録 A-3 と同じ確かめ方）。
    ここが全表走査に落ちると、渡し終わった行が増えるほど遅くなる。
  */
  it("未処理の引きが inbox_pending_idx を使う", async () => {
    await seed();

    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM inbox WHERE run_key = ? AND taken_at IS NULL ORDER BY id`,
    )
      .bind(RUN_KEY)
      .all();

    expect(JSON.stringify(results)).toContain("inbox_pending_idx");
  });
});
