import { parseArgs } from "node:util";
import { assertNoPositionals, cliArgv, runCli } from "./args.ts";
import { offdeskFetch } from "./config.ts";

/*
  `/offdesk` を Discord へ登録する（計画 P2 §3-8）。

    pnpm commands:register                    グローバル
    pnpm commands:register -- --guild <id>    そのサーバーだけ即時反映

  **登録そのものは Worker が行う。** bot token を持っているのはあちらなので、
  ここに `DISCORD_BOT_TOKEN` を配らない。選択肢は D1 の `projects` から作られる。
*/

await runCli(async () => {
  const { values, positionals } = parseArgs({
    args: cliArgv(),
    options: { guild: { type: "string" } },
    allowPositionals: true,
  });
  assertNoPositionals(positionals);

  const query =
    values.guild === undefined
      ? ""
      : `?guild=${encodeURIComponent(values.guild)}`;

  const result = (await offdeskFetch(`/api/admin/commands${query}`, {
    method: "POST",
  })) as { registered?: readonly string[]; scope?: string };

  console.log(`登録しました（${result.scope ?? "?"}）。`);
  console.log(
    `project の選択肢: ${(result.registered ?? []).join(" / ") || "（なし）"}`,
  );
});
