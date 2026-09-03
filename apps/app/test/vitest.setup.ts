import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

/*
  ストレージが分離されるのは**テストファイル単位**（`@cloudflare/vitest-pool-workers`
  0.22 の既定）。`it` ごとには分離されないので、行が積み上がる。
  **P1 でテーブルが入ったら、各テストの前に空にする処理をここへ足す**
  （子テーブルから順に消す。FK は全部 RESTRICT なので順序を間違えると削除が拒否される）。

  マイグレーションは**ファイルごとに 1 回**で足りる（ストレージの分離がファイル単位なので、
  同じファイル内では当てたスキーマが残る）。

  **P0 の migrations は空**なので `applyD1Migrations` は何もしない。
  それでも呼んでおくのは、空の配列で落ちないことをここで確かめておくため（P0 の引き渡し）。
*/
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
