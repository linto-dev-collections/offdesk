import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema/index.ts";

/**
 * D1 の接続。
 *
 * **リクエストごとに作る。** Worker のインスタンスは複数のリクエストに使い回されるが、
 * バインディングはリクエストの `env` から来るので、モジュールのトップレベルに
 * 持たせると別リクエストの `env` を掴んだままになりうる。
 *
 * ここを 1 か所にしておくのは、リポジトリ実装が全部この型を受ける形にして、
 * Drizzle の型がユースケース層へ漏れない（要件 §10-3 ルール 2）ようにするため。
 *
 * **`index.ts` に置かない。** リポジトリが `Db` 型を必要とするので、バレルに置くと
 * `index → repository → index` の循環になる（型だけの import でも循環は循環）。
 */
export const createDb = (d1: D1Database) =>
  drizzle(d1, { schema, casing: "snake_case" });

export type Db = ReturnType<typeof createDb>;
