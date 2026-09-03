import { env } from "cloudflare:workers";
import { createDb } from "@offdesk/db";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

/*
  P0 の配線をひと続きで確かめる — D1 バインディング → drizzle → workers プール。
  スキーマもテーブルも無いので、**バインディングが生きていることだけ**を見る。
*/
describe("createDb", () => {
  it("D1 バインディングから drizzle のクエリが通る", async () => {
    const db = createDb(env.DB);

    const rows = await db.all<{ one: number }>(sql`select 1 as one`);

    expect(rows).toEqual([{ one: 1 }]);
  });
});
