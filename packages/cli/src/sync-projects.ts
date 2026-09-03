import { parseArgs } from "node:util";
import { assertNoPositionals, cliArgv, runCli } from "./args.ts";
import { checkFireToken } from "./check-token.ts";
import { describeProjects, loadProjects, offdeskFetch } from "./config.ts";

/*
  `projects.json` を本番の D1 へ投入する（要件 `F-H1`・`F-H3`）。

    pnpm projects:sync -- --dry-run     何を送るか先に見る（送らない）
    pnpm projects:sync                  本番へ送る
    pnpm projects:sync -- --skip-check  トークンの実叩きを飛ばす

  **暗号化は Worker の中で起きる。** ここは平文を TLS で渡すだけで、`FIRE_TOKEN_KEY`
  は手元にも CI にも無い（要件 `F-H2`。2026-09-04 の決定）。
*/

await runCli(async () => {
  const { values, positionals } = parseArgs({
    args: cliArgv(),
    options: {
      "dry-run": { type: "boolean", default: false },
      "skip-check": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  assertNoPositionals(positionals);

  const dryRun = values["dry-run"];
  const skipCheck = values["skip-check"];

  const projects = loadProjects();

  console.log(`${projects.length} 件を${dryRun ? "送るところ" : "送ります"}:`);
  console.log(describeProjects(projects));

  if (skipCheck) {
    console.log("\n--skip-check なのでトークンは確かめません。");
  } else {
    console.log("\nトークンを確かめます（セッションは作りません）:");
    let bad = 0;
    for (const project of projects) {
      const verdict = await checkFireToken(project);
      console.log(
        `  ${verdict.ok ? "OK  " : "NG  "}${project.name}  ${verdict.detail}`.trimEnd(),
      );
      if (!verdict.ok) bad += 1;
    }
    if (bad > 0) {
      throw new Error(
        `${bad} 件のトークンが通りません。送りません。\n` +
          "routine の API トリガで発行し直して projects.json を直してください。",
      );
    }
  }

  if (dryRun) {
    console.log("\n--dry-run なので送りません。");
    return;
  }

  const result = (await offdeskFetch("/api/admin/projects", {
    method: "POST",
    body: { projects },
  })) as {
    applied?: readonly {
      name: string;
      inserted: boolean;
      fireTokenLast4: string;
    }[];
  };

  console.log("\n入りました:");
  for (const applied of result.applied ?? []) {
    console.log(
      `  ${applied.inserted ? "新規" : "更新"}  ${applied.name}  （…${applied.fireTokenLast4}）`,
    );
  }
});
