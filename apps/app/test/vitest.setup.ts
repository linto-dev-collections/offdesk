import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach } from "vitest";

/*
  ストレージが分離されるのは**テストファイル単位**（`@cloudflare/vitest-pool-workers`
  0.22 の既定）。`it` ごとには分離されないので、行が積み上がる。
  それを前提にしてテストを書くとファイル内の順序に依存するので、**各テストの前に空にする。**
*/

/**
 * 子表から順に消す。認証 4 表は `ON DELETE CASCADE` を持つ（テーブル定義書 §2）が、
 * **順序に頼らず明示する** — offdesk 所有の 7 表（P2）は全部 `RESTRICT` なので、
 * そちらを足すときにこの並びが FK の向きの一覧になる。
 */
const TABLES_CHILD_FIRST = [
  // offdesk 所有（全部 RESTRICT なので、この並びが FK の向きの一覧になる）。
  "runs",
  "project_fire_credentials",
  "projects",
  // BetterAuth 所有（CASCADE を持つが、順序に頼らず明示する）。
  "sessions",
  "accounts",
  "verifications",
  "users",
] as const;

const clearD1 = async (): Promise<void> => {
  const [first, ...rest] = TABLES_CHILD_FIRST.map((table) =>
    env.DB.prepare(`DELETE FROM ${table}`),
  );
  if (first === undefined) return;
  await env.DB.batch([first, ...rest]);
};

// マイグレーションは**ファイルごとに 1 回**で足りる（ストレージの分離がファイル単位なので、
// 同じファイル内では当てたスキーマが残る）。各テストの前に当て直すと無駄が積み上がる。
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await clearD1();
});
