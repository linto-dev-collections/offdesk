import { z } from "zod";

/**
 * ログイン中の利用者（要件 F-F1）。
 *
 * **`imageUrl` は `null` を返す**（`undefined` にしない）。JSON に出ない
 * `undefined` を許すと、出力検証が「画像なし」と「キーの付け忘れ」を区別できない。
 */
export const MeOutput = z.object({
  email: z.string(),
  name: z.string(),
  imageUrl: z.string().nullable(),
});
export type MeOutput = z.infer<typeof MeOutput>;
