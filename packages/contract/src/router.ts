import { oc } from "@orpc/contract";
import { MeOutput } from "./me.ts";

/**
 * oRPC の契約。**サーバー実装から独立している**（要件 I-8）。
 *
 * **`.output()` を必ず付ける。** 出力検証が生きていれば、正規化漏れが
 * 「画面がおかしい」ではなく「その手続きが出力検証で落ちる」形で表面化する。
 */
export const contract = {
  me: oc.output(MeOutput),
};
