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
      `INSERT INTO runs (run_key, project_id, prompt, status, requester_discord_user_id, channel_id, thread_id, cc_session_id, cc_session_url, finished_at, failure_reason, ctx_at, ctx_used_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  ])("%s は入らない", async (_label, values) => {
    await insertProject({});
    await expect(insertRun(values)).rejects.toThrow();
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
