# offdesk

Claude Code をリモート（Discord）から操作するためのアプリケーション。
Cloudflare Workers 1 本に静的アセットと Worker を載せ、D1 と R2 と Durable Object を 1 デプロイで扱う。

## 地図

| | |
| --- | --- |
| このファイル | 何をするアプリか・立ち上げ方・構成 |
| [OPERATIONS.md](./OPERATIONS.md) | **運用手順。** 秘密の置き場・プロジェクトを増やす・Gateway が落ちた・困ったときに読む順 |
| [plugin/](./plugin/) | **配布物。** このリポジトリは Claude Code の marketplace でもある（`.claude-plugin/marketplace.json`）。対象リポジトリには 1 バイトも置かない |
| 各パッケージの why コメント | 設計の理由（**正本はコード**） |

**`docs/` と `plans/` は commit されない**（`.gitignore`）。要件定義書・テーブル定義書・
実装計画は**使い捨て**で、現行のコードが正本という決まりにしてある ——
コードの外にある知識（claude.ai と Discord の設定）だけを `OPERATIONS.md` に残す。

## 手を動かす前に

```bash
cp .env.example .env.local
cp apps/app/.env.example apps/app/.env.local
pnpm install
```

**`.env.local` は 2 つある。** 混ぜない。

| ファイル | 誰が読むか | 何を置くか |
| --- | --- | --- |
| `.env.local`（ルート） | `packages/infra/alchemy.run.ts` だけ | `ALCHEMY_PASSWORD` / `ALCHEMY_STAGE` / `CLOUDFLARE_*` |
| `apps/app/.env.local` | Vite・wrangler・`alchemy.run.ts` | **Worker が受け取るもの**（P1 以降） |

分けているのは、`@cloudflare/vite-plugin` が `apps/app/.env.local` の中身を `dist/<worker>/.dev.vars` へ**平文で書き出す**ため。
Worker が要らない秘密をビルド成果物に出さない。

## よく使うコマンド

| | |
| --- | --- |
| `pnpm dev` | ローカル開発（<http://localhost:5173>）。miniflare の D1 / R2 / DO を使う |
| `pnpm projects:sync` | `projects.json` を本番へ投入（[OPERATIONS.md](./OPERATIONS.md) §1） |
| `pnpm routine:prompt` | routine に貼るプロンプトを出す |
| `pnpm commands:register` | Discord のスラッシュコマンドを登録 |
| `pnpm build` | 全パッケージのビルド |
| `pnpm deploy` | Cloudflare へデプロイ（**prod は CI から。手元から prod を出そうとすると止まる**） |
| `pnpm destroy` | そのステージのリソースを削除（**prod の D1 と R2 は消えない**） |

## デプロイ

**`main` への push で GitHub Actions が出す**（`.github/workflows/ci.yml`）。

```txt
install → knip → format:ci → check-types → depcruise → test → build → deploy
```

`deploy` は `push` かつ `main` のときだけ。PR では静的解析と build まで。

CI に要る secret は 4 つ — `ALCHEMY_PASSWORD` / `ALCHEMY_STATE_TOKEN` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`。

手元から `prod` は出せない（`alchemy.run.ts` が止める）。
状態ストアが `ALCHEMY_DEPLOY` で切り替わるので、手元から打つと空の `.alchemy/` を正本として読み、すでに在る D1 と R2 を作り直しに行く。逃げ道はエラーメッセージに書いてある。

## 静的解析

```bash
pnpm knip && pnpm format && pnpm check-types && pnpm depcruise && pnpm test
```

`format` は書き換える（`biome check --write .`）。**CI は `format:ci`（`biome ci .`）** で差分を検出して落とす。

| | |
| --- | --- |
| `knip` | 使われていない依存・export・ファイル |
| `format` | 整形と lint（Biome） |
| `check-types` | 各パッケージの `tsc -b`（Project References） |
| `depcruise` | 依存の向き・循環・孤児（`.dependency-cruiser.cjs`） |
| `test` | 全プロジェクト（Vitest） |

## 構成

```txt
apps/app/           1 デプロイ単位
  src/client/       Vite + React + TanStack Router（SPA）
  src/worker/       Hono: oRPC / MCP / Discord / hooks / DO / cron
packages/
  contract/         oRPC の契約と Zod の DTO（依存の終着点）
  domain/           値オブジェクト・状態・遷移関数（依存ゼロ）
  usecase/          ユースケース 1 本 = 1 ファイル + port の宣言
  db/               Drizzle のスキーマ・マイグレーション・リポジトリ
  ui/               shadcn（`@workspace/ui`）
  infra/            alchemy.run.ts
  config/           tsconfig の共有設定
```

依存の向きは機械で強制しているので、破ると `pnpm depcruise` が落ちる。

## 5 分ごとに動くもの

`main` の cron（`*/5 * * * *`）が 2 つの仕事をする。

| | |
| --- | --- |
| Gateway を起こす | DO は自分では起動できない。alarm ごと evict された状態から戻す。**`fatal` なら何もしない**（人が直すまで戻らない） |
| `queued` を畳む | 起動が完了しないまま 10 分が過ぎた run を `failed` にする。**起こし直さない**（次の 1 行が新しい run を立てる） |

cron の文字列は 3 か所（`scheduled/crons.ts` / `wrangler.jsonc` / `alchemy.run.ts`）
にあり、食い違うと**何も起きない** —— `test/release/cron-consistency.test.ts` が
突き合わせる。

## wrangler.jsonc と alchemy.run.ts の二重定義

`apps/app/wrangler.jsonc` は**ローカル開発専用**。デプロイ時のリソースとバインディングは `packages/infra/alchemy.run.ts` が正本で、`pnpm deploy` は wrangler.jsonc を読まない。

**バインディングを増やしたら 3 か所を揃える。**

1. `apps/app/wrangler.jsonc`（ローカル）
2. `packages/infra/alchemy.run.ts`（本番）
3. `apps/app/src/worker/env.ts` の `WorkerEnv`（型）
