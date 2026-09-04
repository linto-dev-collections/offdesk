/** 見せる桁数。**`pfc_last4_ck` が `length = 4` を要求している**（DDL と対）。 */
const MASK = "••••";

/**
 * fire トークンの表示（要件 `I-1`・plans/security.md 脅威 3）。
 *
 * **末尾 4 文字だけ。** 応答の型（`ProjectSummary`）に暗号文も `fireUrl` 全体も
 * 無いので、そもそもここへ全体が届かない —— この部品の仕事は
 * **「未発行」と「発行済みだが伏せている」を見分けられるようにすること。**
 *
 * `null` を「••••」で出すと、鍵が無いのか伏せているのかが読めなくなる
 * （棚卸しでいちばん見たいのがそこ）。
 */
export const MaskedToken = ({ last4 }: { readonly last4: string | null }) =>
  last4 === null ? (
    <span className="text-muted-foreground text-xs">未発行</span>
  ) : (
    <span className="text-xs tabular-nums">
      <span aria-hidden="true">{MASK} </span>
      {last4}
    </span>
  );
