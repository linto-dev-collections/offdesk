import {
  ProjectNamesOutput,
  ProjectSyncInput,
  ProjectSyncResult,
} from "@offdesk/contract";
import {
  createDb,
  encryptFireToken,
  listProjectsWithMask,
  upsertProjectWithCredential,
} from "@offdesk/db";
import { bearerMatches } from "@offdesk/domain";
import type {
  FireTokenCipherPort,
  ProjectStoreWritePort,
} from "@offdesk/usecase";
import { syncProjects } from "@offdesk/usecase";
import { Hono } from "hono";
import { buildOffdeskCommand } from "../discord/commands.ts";
import { putCommands } from "../discord/rest.ts";
import { type AppBindings, isConfigured } from "../env.ts";
import { discordRestConfig } from "../session/launch.ts";

/*
  プロジェクトの投入口（要件 `F-H1`・`F-H3`）。

  **平文の fire トークンはこの Worker の中で暗号文になる。** `FIRE_TOKEN_KEY` を
  手元にも CI にも置かないための経路で、鍵の置き場は Worker secret の 1 か所だけ
  （要件 `F-H2`。2026-09-04 の決定 —— 計画 §3-5 は wrangler 経由と書いていたが、
  あれだと鍵が手元にも要る）。

  **口の守りは Bearer 1 本**（plans/security.md 脅威 2）。`OFFDESK_TOKEN` が
  未設定なら誰も通らない。値はログに出さない。
*/

export const admin = new Hono<AppBindings>();

admin.use("*", async (c, next) => {
  if (!bearerMatches(c.req.header("authorization"), c.env.OFFDESK_TOKEN)) {
    console.warn("[admin] bearer mismatch", { path: c.req.path });
    return c.text("unauthorized", 401);
  }
  await next();
});

admin.get("/projects", async (c) => {
  const rows = await listProjectsWithMask(createDb(c.env.DB));

  return c.json(
    ProjectNamesOutput.parse({
      names: rows.filter((row) => row.disabledAt === null).map((r) => r.name),
    }),
  );
});

admin.post("/projects", async (c) => {
  if (!isConfigured(c.env.FIRE_TOKEN_KEY)) {
    return c.text("FIRE_TOKEN_KEY が設定されていません", 503);
  }

  const parsed = ProjectSyncInput.safeParse(await c.req.json());
  if (!parsed.success) {
    /*
      **検証の失敗に受け取った値を載せない**（脅威 12）。`fireToken` が
      `z.string().min(8)` に落ちたときの Zod のメッセージには値が入らないが、
      `issues` をそのまま返すと `path` 以外に何が乗るかは Zod の版に依存する。
      path と code だけを返す。
    */
    return c.json(
      {
        error: "invalid",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
      400,
    );
  }

  const db = createDb(c.env.DB);
  const key = c.env.FIRE_TOKEN_KEY;

  const cipher: FireTokenCipherPort = {
    encrypt: (plaintext) => encryptFireToken(key, plaintext),
  };
  const store: ProjectStoreWritePort = {
    upsert: (input, encrypted) =>
      upsertProjectWithCredential(db, input, encrypted),
  };

  const applied = await syncProjects({ cipher, store }, parsed.data.projects);

  return c.json(ProjectSyncResult.parse({ applied }));
});

/**
 * `/offdesk` を Discord へ登録する（計画 P2 §3-8）。
 *
 * **Worker がやる。** bot token を持っているのはここだけなので、CLI に
 * `DISCORD_BOT_TOKEN` を配らずに済む。選択肢は D1 の `projects` から作るので、
 * `projects.json` と選択肢がズレる形も無くなる。
 */
admin.post("/commands", async (c) => {
  for (const name of ["DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID"] as const) {
    if (!isConfigured(c.env[name])) {
      return c.text(`${name} が設定されていません`, 503);
    }
  }

  const guildId = new URL(c.req.url).searchParams.get("guild") ?? undefined;

  const rows = await listProjectsWithMask(createDb(c.env.DB));
  const names = rows
    .filter((row) => row.disabledAt === null)
    .map((row) => row.name);

  const result = await putCommands(
    discordRestConfig(c.env),
    [buildOffdeskCommand(names)],
    guildId,
  );

  return result.ok
    ? c.json({ registered: names, scope: guildId ?? "global" })
    : c.json({ error: result.reason }, 502);
});
