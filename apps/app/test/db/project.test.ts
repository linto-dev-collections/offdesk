import { env } from "cloudflare:workers";
import {
  encryptFireToken,
  findProjectByChannel,
  findProjectById,
  findRunByThread,
  listProjects,
  listProjectsWithMask,
  upsertProjectWithCredential,
} from "@offdesk/db";
import { describe, expect, it } from "vitest";
import {
  CHANNEL_ALPHA,
  CHANNEL_BETA,
  db,
  FIRE_URL,
  seedProject,
  seedTwoProjects,
} from "./support.ts";

describe("listProjects", () => {
  it("名前の順で返す", async () => {
    await seedTwoProjects();

    expect((await listProjects(db())).map((p) => p.name)).toEqual([
      "dummy",
      "offdesk-test",
    ]);
  });

  /*
    テーブル定義書 §4-2 の 1 つ目の理由。**一覧のクエリに暗号文が乗らない。**
    要件 `I-1` を「気をつける」ではなく「触れない」で守る。
  */
  it("応答に暗号文が無い", async () => {
    await seedTwoProjects();

    const [project] = await listProjects(db());

    expect(project).toBeDefined();
    expect(Object.keys(project ?? {})).toEqual([
      "id",
      "name",
      "discordChannelId",
      "repoUrl",
      "fireUrl",
      "disabledAt",
    ]);
    expect(JSON.stringify(project)).not.toContain("ciphertext");
    expect(JSON.stringify(project)).not.toContain("iv");
  });

  /** 要件 `F-H5`。行を消さずに使えなくする。 */
  it("無効にしたプロジェクトは出てこない", async () => {
    const { alpha } = await seedTwoProjects();
    await env.DB.prepare("UPDATE projects SET disabled_at = ? WHERE id = ?")
      .bind(Date.now(), alpha)
      .run();

    expect((await listProjects(db())).map((p) => p.name)).toEqual(["dummy"]);
  });
});

describe("findProjectByChannel", () => {
  it("紐付いたチャンネルで引ける", async () => {
    await seedTwoProjects();

    expect((await findProjectByChannel(db(), CHANNEL_BETA))?.name).toBe(
      "dummy",
    );
  });

  it("紐付いていないチャンネルでは null", async () => {
    await seedTwoProjects();

    expect(await findProjectByChannel(db(), "999999999999999999")).toBeNull();
  });

  it("無効なプロジェクトのチャンネルでは null", async () => {
    const { alpha } = await seedTwoProjects();
    await env.DB.prepare("UPDATE projects SET disabled_at = ? WHERE id = ?")
      .bind(Date.now(), alpha)
      .run();

    expect(await findProjectByChannel(db(), CHANNEL_ALPHA)).toBeNull();
  });
});

describe("upsertProjectWithCredential", () => {
  it("新規なら inserted が true、2 回目は false", async () => {
    const encrypted = await encryptFireToken(env.FIRE_TOKEN_KEY, "sk-aaaa");

    const first = await upsertProjectWithCredential(
      db(),
      {
        name: "offdesk-test",
        discordChannelId: CHANNEL_ALPHA,
        repoUrl: "https://github.com/x/y",
        fireUrl: FIRE_URL,
      },
      encrypted,
    );
    const second = await upsertProjectWithCredential(
      db(),
      {
        name: "offdesk-test",
        discordChannelId: CHANNEL_ALPHA,
        repoUrl: "https://github.com/x/z",
        fireUrl: FIRE_URL,
      },
      encrypted,
    );

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    // **id は動かさない**（`runs.project_id` が指しているため）。
    expect(second.projectId).toBe(first.projectId);
  });

  it("2 回目は値が更新される", async () => {
    const projectId = await seedProject({
      name: "offdesk-test",
      discordChannelId: CHANNEL_ALPHA,
    });
    await seedProject({
      name: "offdesk-test",
      discordChannelId: CHANNEL_ALPHA,
      repoUrl: "https://github.com/x/updated",
    });

    const project = await findProjectById(db(), projectId);

    expect(project?.repoUrl).toBe("https://github.com/x/updated");
  });

  /*
    **片方だけ入る形を作らない。** プロジェクトと資格情報は 1 回の batch なので、
    「有効なのにトークンが無い」行はできない。
  */
  it("プロジェクトと資格情報が対で入る", async () => {
    await seedProject({
      name: "offdesk-test",
      discordChannelId: CHANNEL_ALPHA,
    });

    const counts = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM projects) AS p, (SELECT count(*) FROM project_fire_credentials) AS c",
    ).first<{ p: number; c: number }>();

    expect(counts).toEqual({ p: 1, c: 1 });
  });

  it("DDL に落ちる値を渡すと入らない（層が二重になっている）", async () => {
    const encrypted = await encryptFireToken(env.FIRE_TOKEN_KEY, "sk-aaaa");

    await expect(
      upsertProjectWithCredential(
        db(),
        {
          name: "offdesk-test",
          discordChannelId: CHANNEL_ALPHA,
          repoUrl: "https://github.com/x/y",
          fireUrl: "https://evil.example.com/v1/fire",
        },
        encrypted,
      ),
    ).rejects.toThrow();
  });
});

describe("listProjectsWithMask", () => {
  it("末尾 4 文字だけを添える", async () => {
    await seedProject({
      name: "offdesk-test",
      discordChannelId: CHANNEL_ALPHA,
      fireToken: "sk-ant-oat01-xxxxxxxx-aB3x",
    });

    const [project] = await listProjectsWithMask(db());

    expect(project?.fireTokenLast4).toBe("aB3x");
    expect(JSON.stringify(project)).not.toContain("sk-ant");
  });

  it("無効なプロジェクトも含む（棚卸しに要る）", async () => {
    const { alpha } = await seedTwoProjects();
    await env.DB.prepare("UPDATE projects SET disabled_at = ? WHERE id = ?")
      .bind(Date.now(), alpha)
      .run();

    const rows = await listProjectsWithMask(db());

    expect(rows).toHaveLength(2);
    expect(
      rows.find((r) => r.name === "offdesk-test")?.disabledAt,
    ).not.toBeNull();
  });
});

describe("findRunByThread", () => {
  /*
    P4 が「素の文が届いたら、そのスレッドのいちばん新しい run へ渡す」のに使う
    （`runs_thread_created_idx`）。**P2 の時点で読み出しの向きを固めておく。**
  */
  const insertRun = (
    runKey: string,
    threadId: string | null,
    createdAt: number,
  ) =>
    env.DB.prepare(
      `INSERT INTO runs (run_key, project_id, prompt, requester_discord_user_id, channel_id, thread_id, created_at, updated_at)
       SELECT ?, id, 'x', '111111111111111111', ?, ?, ?, ? FROM projects WHERE name = 'offdesk-test'`,
    )
      .bind(runKey, CHANNEL_ALPHA, threadId, createdAt, createdAt)
      .run();

  it("いちばん新しい run を返す", async () => {
    await seedProject({
      name: "offdesk-test",
      discordChannelId: CHANNEL_ALPHA,
    });
    await insertRun("OFFDESK-0000000000000001", "333333333333333333", 1_000);
    await env.DB.prepare(
      "UPDATE runs SET status = 'done', finished_at = 2000 WHERE run_key = 'OFFDESK-0000000000000001'",
    ).run();
    await insertRun("OFFDESK-0000000000000002", "333333333333333333", 2_000);

    expect((await findRunByThread(db(), "333333333333333333"))?.runKey).toBe(
      "OFFDESK-0000000000000002",
    );
  });

  it("知らないスレッドでは null", async () => {
    await seedProject({
      name: "offdesk-test",
      discordChannelId: CHANNEL_ALPHA,
    });

    expect(await findRunByThread(db(), "999999999999999999")).toBeNull();
  });

  /*
    `runs_thread_id_ck` が空文字を止めているので、`findRunByThread('')` は
    **どの行にも当たらない**（要件 `F-A7` の run が拾われない）。
  */
  it("空文字ではスレッド無しの run に当たらない", async () => {
    await seedProject({
      name: "offdesk-test",
      discordChannelId: CHANNEL_ALPHA,
    });
    await insertRun("OFFDESK-0000000000000003", null, 1_000);

    expect(await findRunByThread(db(), "")).toBeNull();
  });
});
