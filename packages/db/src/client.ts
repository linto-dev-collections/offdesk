import { drizzle } from "drizzle-orm/d1";

/**
 * D1 の接続。
 *
 * **リクエストごとに作る。** Worker のインスタンスは複数のリクエストに使い回されるが、
 * バインディングはリクエストの `env` から来るので、モジュールのトップレベルに
 * 持たせると別リクエストの `env` を掴んだままになりうる。
 *
 * P1 でスキーマを渡す（`drizzle(d1, { schema })`）。ここを 1 か所にしておくのは、
 * リポジトリ実装が全部この型を受ける形にして、Drizzle の型がユースケース層へ
 * 漏れない（要件 §10-3 ルール 2）ようにするため。
 */
export const createDb = (d1: D1Database) => drizzle(d1);

export type Db = ReturnType<typeof createDb>;
